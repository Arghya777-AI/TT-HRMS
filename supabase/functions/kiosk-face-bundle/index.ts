/**
 * kiosk-face-bundle — the enrolled faces, handed to a gate so it can recognise people with
 * no internet.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 * ═══════════════════════════════════════════════════════════════════════════════
 * A gate on a venue's wifi loses the internet. Until now an offline scan was queued blind:
 * the tablet held a 128-float descriptor it could not interpret and told the person
 * "recorded" without knowing who they were. Nobody could verify anything, and the screen's
 * own log stayed empty for the whole outage.
 *
 * With this bundle the terminal can say "Vinod Maurya, checked in" while completely offline.
 *
 * ── THE BUNDLE IS FOR DISPLAY. THE SERVER STILL DECIDES. ─────────────────────
 * This is the single most important line in the file. A queued punch continues to carry its
 * DESCRIPTOR, and `kiosk-punch` re-runs the 1:N against live templates when the queue drains.
 * The device's own match is never written to `attendance_punches` and never becomes the
 * identity on the record.
 *
 * That is not caution for its own sake. A device's copy of the templates is stale by
 * construction — somebody re-enrols, somebody withdraws consent, somebody leaves — and a
 * tablet that could assert identity from a week-old bundle would write attendance for a person
 * who is no longer allowed to be matched at all. So the device gets to SHOW a name and never to
 * ASSERT one. If the server later disagrees, the record is right and only a screen was wrong
 * for a moment.
 *
 * ── WHY IT IS SAFE ENOUGH TO SEND AT ALL ─────────────────────────────────────
 * These are 128-dimension unit vectors, not photographs: there is no published method to
 * reconstruct a recognisable face from a ResNet-34 embedding, and no image is included. Even
 * so, they are biometric data under the DPDP Act, so:
 *
 *   · Only CONSENTED, un-purged templates of the CURRENT enrolment version are sent — exactly
 *     the `eligible` set `kiosk-punch` matches against, copied deliberately rather than
 *     rewritten, because a bundle assembled by different rules would make the gate disagree
 *     with the server about who somebody is.
 *   · The response carries `expiresAt`. The device is required to stop matching offline once
 *     it passes, which is the only lever that limits how long a revoked device or a withdrawn
 *     consent can keep being honoured on hardware nobody can reach.
 *   · Auth is model D — device HMAC, nonce, skew window. A bundle is never served to anything
 *     that has not proved possession of a paired device secret.
 *   · Every fetch is logged with the device and the count, so handing out the roster is
 *     auditable after the fact.
 *
 * ── VERSIONING ───────────────────────────────────────────────────────────────
 * `version` is derived from the eligible set itself — its size and its newest `enrolled_at` — so
 * it changes when and only when the set changes. A device sends `have_version` and gets
 * `{ unchanged: true }` back when it is already current, which turns the routine case into a
 * few hundred bytes instead of a few hundred kilobytes.
 */
import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem } from "../_shared/errors.ts";
import { decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { firstRow, requestIdFrom, sql as sqlHandle } from "../_shared/db.ts";
import { verifyDevice } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";

const FN_NAME = "kiosk-face-bundle";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;
const MAX_BODY_BYTES = 4_096;

/** Must equal `kiosk-punch`'s. A bundle of a different width could not be matched at all. */
const DESCRIPTOR_DIM = 128;

/**
 * How long a device may keep matching offline before it must talk to the server again.
 *
 * Seven days. The trade is explicit: longer means a withdrawn consent or a revoked device is
 * honoured for longer on hardware nobody can physically reach; shorter means a genuine
 * week-long outage stops naming people. Seven days covers every outage anybody has actually
 * reported here while keeping the stale window bounded and short enough to explain.
 */
const BUNDLE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Decimal places kept per descriptor component.
 *
 * Five. The distances that decide a match differ in the third decimal, so five is far more
 * than the comparison needs while cutting the payload roughly in half against full float
 * precision. Rounding is applied in SQL so the wire format and the stored value cannot drift.
 */
const DESCRIPTOR_PRECISION = 5;

const BundleBody = z
  .object({
    device_id: z.string().uuid(),
    /** The version the device already holds. Omit to force a full send. */
    have_version: z.string().max(128).optional(),
  })
  .strict();

interface TemplateRow {
  employee_id: string;
  employee_code: string;
  display_name: string;
  employment_status: string;
  model_version: string;
  descriptor: number[] | string;
}

/** One person, with every sample of their current enrolment. */
interface BundleEmployee {
  employeeId: string;
  employeeCode: string;
  displayName: string;
  employmentStatus: string;
  modelVersion: string;
  descriptors: number[][];
}

/**
 * Postgres may hand a real[] back as a string. Normalise either shape.
 *
 * Silent on purpose about anything of the wrong width: a malformed row must not poison the
 * whole bundle, and the count in the response makes an omission visible.
 */
function toNumbers(value: number[] | string): number[] | null {
  const parsed = Array.isArray(value)
    ? value.map(Number)
    : String(value)
      .replace(/^[{[]|[}\]]$/g, "")
      .split(",")
      .map((n) => Number(n.trim()));
  if (parsed.length !== DESCRIPTOR_DIM) return null;
  return parsed.every((n) => Number.isFinite(n)) ? parsed : null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;
  let status = 500;

  try {
    assertOriginAllowed(req);

    // ── Auth (model D) ────────────────────────────────────────────────────────
    // Raw bytes first: the HMAC covers exactly what was sent.
    const rawBody = await readRawBody(req, { maxBytes: MAX_BODY_BYTES });
    const decoded = decodeJson(rawBody);
    const client = sqlHandle();
    const deviceAuth = await verifyDevice(req, rawBody, client);
    const device = deviceAuth.device;
    const body = parse(BundleBody, decoded);

    const deviceLog = log.child({ device_id: device.id, device_code: device.deviceCode });

    /*
      Its own rate-limit bucket, and a tight one. This is the most expensive read in the
      product and the only one that returns the whole biometric roster; it is called on boot
      and on reconnection, not per scan, so a device asking repeatedly is either broken or
      being probed. Reusing the heartbeat bucket keeps it away from the scan allowance.
    */
    await enforce(RATE_LIMITS.kioskHeartbeat, limitKey(FN_NAME, device.id), "KIOSK_RATE_LIMITED");

    /*
      ── THE VERSION ─────────────────────────────────────────────────────────────
      Derived from the eligible set, so it moves when the set moves and not otherwise: a
      re-enrolment changes the newest `created_at`, a withdrawn consent or a purge changes the
      count, and a template edit changes the newest `updated_at` if that column exists on the
      row. Cheap to compute — three aggregates over an indexed set — and it is what turns the
      routine call into a few hundred bytes.
    */
    const versionRows = await client<{ version: string; count: number }[]>`
      WITH eligible AS (
        SELECT t.id, t.enrolled_at
          FROM secure.face_templates t
          JOIN public.employees e
            ON e.id = t.employee_id
           AND e.deleted_at IS NULL
          JOIN secure.biometric_consents c
            ON c.id = t.consent_id
           AND c.granted
           AND c.withdrawn_at IS NULL
         WHERE t.purged_at IS NULL
           AND t.descriptor_dim = ${DESCRIPTOR_DIM}
           AND EXISTS (
             SELECT 1 FROM secure.face_templates a
              WHERE a.employee_id = t.employee_id
                AND a.version = t.version
                AND a.is_active
                AND a.purged_at IS NULL
           )
      )
      SELECT count(*)::int AS count,
             md5(count(*)::text || ':' || COALESCE(max(enrolled_at)::text, 'none')) AS version
        FROM eligible
    `;
    const versionRow = firstRow(versionRows);
    const version = versionRow?.version ?? "empty";
    const count = versionRow?.count ?? 0;

    /*
      The expiry comes from the DATABASE clock, not this runtime's.

      It is the control that bounds how long a device may keep matching offline, so it must be
      measured against the same clock that stamps punches. An edge isolate whose clock had
      drifted would hand out a window that was longer or shorter than intended, and nobody
      would be able to tell which from the outside.
    */
    const expiryRows = await client<{ expires_at: string }[]>`
      SELECT (now() + make_interval(secs => ${BUNDLE_TTL_SECONDS}::double precision)) AS expires_at
    `;
    const expiresAt = firstRow(expiryRows)?.expires_at ?? "";

    // Already current: say so and send nothing. `expiresAt` still travels, so a device that
    // stays online keeps extending its own permission to work offline later.
    if (body.have_version !== undefined && body.have_version === version) {
      status = 200;
      deviceLog.info("bundle unchanged", { version, count });
      return ok({ unchanged: true, version, count, expiresAt, requestId }, { status, headers: cors, requestId });
    }

    /*
      EVERY SAMPLE OF THE CURRENT ENROLMENT — the same `eligible` set `kiosk-punch` matches
      against, and copied from it deliberately. Enrolment stores five samples per person and
      marks one as the medoid; matching against only the medoid measurably misidentifies
      people, so the gate must hold what the server holds. Rewriting these joins in a
      different shape here is how a device and a server come to disagree about who somebody is.
    */
    const rows = await client<TemplateRow[]>`
      SELECT t.employee_id,
             e.employee_code,
             e.display_name,
             e.employment_status::text AS employment_status,
             t.model_version,
             (
               -- The int cast is not decoration: a bare parameter arrives as text and
               -- round(numeric, text) does not exist, which fails the whole query.
               SELECT array_agg(round(v::numeric, ${DESCRIPTOR_PRECISION}::int)::real ORDER BY i)
                 FROM unnest(t.descriptor) WITH ORDINALITY AS d(v, i)
             ) AS descriptor
        FROM secure.face_templates t
        JOIN public.employees e
          ON e.id = t.employee_id
         AND e.deleted_at IS NULL
        JOIN secure.biometric_consents c
          ON c.id = t.consent_id
         AND c.granted
         AND c.withdrawn_at IS NULL
       WHERE t.purged_at IS NULL
         AND t.descriptor_dim = ${DESCRIPTOR_DIM}
         AND EXISTS (
           SELECT 1 FROM secure.face_templates a
            WHERE a.employee_id = t.employee_id
              AND a.version = t.version
              AND a.is_active
              AND a.purged_at IS NULL
         )
       ORDER BY e.employee_code, t.id
    `;

    // Grouped per employee, because the matcher takes the best sample per PERSON: ranking
    // samples directly would fill the top places with one face and collapse the margin that
    // decides whether a match is confident enough to accept.
    const byEmployee = new Map<string, BundleEmployee>();
    let skipped = 0;
    for (const row of rows as unknown as TemplateRow[]) {
      const descriptor = toNumbers(row.descriptor);
      if (descriptor === null) {
        skipped += 1;
        continue;
      }
      const existing = byEmployee.get(row.employee_id);
      if (existing === undefined) {
        byEmployee.set(row.employee_id, {
          employeeId: row.employee_id,
          employeeCode: row.employee_code,
          displayName: row.display_name,
          employmentStatus: row.employment_status,
          modelVersion: row.model_version,
          descriptors: [descriptor],
        });
      } else {
        existing.descriptors.push(descriptor);
      }
    }

    const employees = [...byEmployee.values()];
    status = 200;
    deviceLog.info("bundle served", {
      version,
      employees: employees.length,
      templates: rows.length,
      skipped_malformed: skipped,
    });

    return ok(
      {
        unchanged: false,
        version,
        expiresAt,
        descriptorDim: DESCRIPTOR_DIM,
        count: employees.length,
        templates: rows.length,
        employees,
        requestId,
      },
      { status, headers: cors, requestId },
    );
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;
    return problem.toResponse(cors);
  } finally {
    log.finish(status, {});
  }
});
