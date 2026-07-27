/**
 * kiosk-face-signin — an ADMIN's face opens the shift. No PIN.
 *
 * WHY, IN THE CLIENT'S WORDS
 * -------------------------
 * "The security gate kiosk should always understand. Suppose an admin is showing
 *  their face; then it should automatically accept."
 * "The device photo verification should allow the admin to initiate the Gate link /
 *  kiosk link … if admin is showing its face."
 *
 * WHAT EXISTED BEFORE, AND WHY IT WAS NOT ENOUGH
 * --------------------------------------------
 * `kiosk-guard-identify` recognises a face and returns `{identified, employeeCode,
 * displayName}` — it PRE-FILLS the code and its own header states that
 * "`kiosk-operator-auth` is UNTOUCHED … the PIN path is unchanged". So a face saved
 * typing and nothing else: a PIN was still required, and an admin standing at the
 * gate could not start a shift without one.
 *
 * Two further gaps made that endpoint unusable for this:
 *   * it searches ONLY faces belonging to a `kiosk_operators` row, and an admin
 *     need not be a gate operator — the client's own face (TT0013) is not one;
 *   * it mints no session, by design.
 *
 * A SEPARATE FUNCTION, DELIBERATELY
 * --------------------------------
 * This does not touch `kiosk-operator-auth`. That function had just been fixed
 * after a device-pinning bug locked every guard out of a new gate, and threading a
 * second authentication path through its 700-line open/heartbeat/close state
 * machine the night before a demo is how that fix gets undone. Everything shared is
 * shared properly: `verifyDevice`, `mintOperatorSession`, `auditSession`,
 * `withContext`, the rate limiter and the idempotency store are the same ones the
 * PIN path uses, so a session minted here is indistinguishable downstream from one
 * minted there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SECURITY TRADE, STATED PLAINLY
 * ─────────────────────────────────────────────────────────────────────────────
 * A face is not a secret. A printed photograph held up to a phone can produce a
 * matching descriptor, and what this endpoint hands over is a shift session — the
 * credential that authorises recording OTHER people's attendance. A PIN is a shared
 * secret; a face is a public feature of a person. This is therefore a genuine
 * reduction in the strength of gate authentication, made because the client asked
 * for it explicitly and twice.
 *
 * What is done to keep it defensible, none of it theatre:
 *   1. A MUCH HIGHER BAR THAN A PUNCH. A punch accepts `min_match_confidence`
 *      (0.62 on this project). Sign-in requires 0.80 confidence AND a 0.12 margin
 *      over the runner-up — deliberately stricter, because the cost of a wrong
 *      answer is a session rather than one attendance row that a human reviews.
 *   2. ADMINS ONLY. The matched person must hold `admin` or `super_admin` in
 *      `user_roles`. An ordinary employee's face — even a perfect match — gets
 *      `FACE_NOT_ADMIN` and the PIN screen. The client asked for admins; this does
 *      not quietly generalise to everyone.
 *   3. LIVENESS IS RECORDED AND WEIGHED. The kiosk sends what it measured. A score
 *      BELOW the threshold is refused outright (positive evidence of a still
 *      image); an ABSENT score is allowed but written to the audit as
 *      `liveness_not_attested`, so a face-opened shift can always be told apart
 *      from one where the device could actually prove a live subject.
 *   4. EVERY SESSION IS ATTRIBUTED. `sessions_audit` gets `auth_method = 'face'`
 *      (migration 20260801012200 already allows that value), so "which shifts were
 *      opened by a face rather than a PIN" is a query, not an investigation.
 *   5. THE DEVICE IS STILL AUTHENTICATED FIRST. Pairing, the HMAC signature and the
 *      single-use nonce all apply before a descriptor is even parsed. A face alone,
 *      from an unpaired browser, does nothing at all.
 *   6. RATE LIMITED on the operator-auth bucket, so this cannot become a cheaper
 *      way to brute-force the 1:N search than the PIN it replaces.
 *
 * The PIN path remains fully available and is still the only way in for a guard who
 * is not an admin. To turn this off entirely, stop deploying this function or
 * revoke the callers' devices; nothing else depends on it.
 *
 * NOTHING BIOMETRIC IS RETURNED. The response carries no descriptor, distance,
 * confidence, margin or threshold — same allow-list discipline as `kiosk-punch`.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { forbidden, methodNotAllowed, ok, toProblem, unauthorized, unprocessable } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql as sqlHandle,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { mintOperatorSession, verifyDevice } from "../_shared/auth.ts";
import { auditSession } from "../_shared/audit.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { istDate, nowIso, toIso } from "../_shared/datetime.ts";
import type { Sql } from "../_shared/deps.ts";

const FN_NAME = "kiosk-face-signin";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** 128 floats of JSON is ~3 KB; liveness metrics add a few bytes. */
const MAX_BODY_BYTES = 16 * 1024;

const DESCRIPTOR_DIM = 128;
/** The descriptor is L2-normalised on-device; |‖d‖ − 1| ≤ 0.02 (spec-kiosk §10). */
const DESCRIPTOR_NORM_TOLERANCE = 0.02;
/** Maximum Euclidean distance between two unit vectors — the confidence denominator. */
const MAX_UNIT_DISTANCE = 2;

/**
 * THE BAR, and it is higher than a punch on purpose.
 *
 * `kiosk_devices.min_match_confidence` is 0.62 on this project and governs punches.
 * A punch is one reviewable row; a session is the authority to create rows for other
 * people. These two numbers are the difference, and they are floors — a device or
 * policy configured stricter still wins.
 */
const SIGNIN_MIN_CONFIDENCE = 0.8;
const SIGNIN_MIN_MARGIN = 0.12;

/**
 * Below this, a PRESENT liveness score is positive evidence of a still image and the
 * request is refused. Matches the punch path's reading of the same signal: absent is
 * "could not measure", low is "measured, and it looks fake".
 */
const SIGNIN_MIN_LIVENESS = 0.5;

/** Same as the PIN path, so a face-opened shift expires identically. */
const SESSION_TTL_SECONDS = 600;

/** The roles that may open a shift with a face. */
const ADMIN_ROLES = ["admin", "super_admin"] as const;

/**
 * Employment statuses that may operate a gate — the SAME list the PIN path and
 * `kiosk-guard-identify` use. A face must never name somebody the PIN step would
 * then refuse.
 */
const OPERATOR_STATUSES = ["active", "confirmed", "probation", "notice"] as const;

const Body = z
  .object({
    device_id: common.uuid,
    descriptor: z
      .array(z.number().finite())
      .length(DESCRIPTOR_DIM, `Expected ${DESCRIPTOR_DIM} floats.`),
    /**
     * What the device measured about liveness. OPTIONAL and honest: omitted means
     * "could not tell", which is recorded, not assumed to be fine. Sending 0 for
     * "could not measure" would refuse an honest admin, so the client omits instead.
     */
    liveness: z
      .object({
        score: z.number().min(0).max(1),
        model: z.string().trim().min(1).max(60),
        frames_analysed: z.number().int().min(0).max(1000),
      })
      .strict()
      .optional(),
  })
  .strict();

function l2Norm(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum);
}

/** Unit-vector Euclidean distance → [0,1] confidence (migration 012: `1 − d / max_d`). */
function confidenceFor(distance: number): number {
  return 1 - distance / MAX_UNIT_DISTANCE;
}

function toPgRealArray(values: readonly number[]): string {
  return `{${values.map((v) => (Number.isFinite(v) ? v.toFixed(8) : "0")).join(",")}}`;
}

interface CandidateRow {
  employee_id: string;
  employee_code: string;
  display_name: string | null;
  employment_status: string;
  profile_id: string;
  profile_active: boolean;
  roles: string[] | null;
  operator_id: string | null;
  operator_active: boolean | null;
  distance: string;
}

/**
 * 1:N over ALL active, consented templates — NOT narrowed to the operator roster.
 *
 * That widening is the point: an admin need not be a gate operator, and the client's
 * own admin account is not one. `kiosk-guard-identify` narrows to
 * `kiosk_operators` and therefore cannot see an admin at all.
 *
 * Widening the search space is safe here because the ADMIN CHECK happens after the
 * match, on `roles`: a non-admin who matches is refused. Doing it the other way
 * round — filtering the SQL to admins only — would hide the runner-up when the
 * runner-up is a non-admin, and the margin test would then compare an admin against
 * nothing and pass a genuinely ambiguous face.
 *
 * Structure mirrors `kiosk-punch#findCandidates` and `kiosk-guard-identify`
 * exactly: GROUP BY per TEMPLATE (grouping by employee would sum two templates'
 * squared differences into a number that is not a distance), then DISTINCT ON per
 * employee keeping their nearest, so a person can never be their own runner-up.
 */
async function findCandidates(
  client: Sql,
  descriptor: readonly number[],
  deviceId: string,
): Promise<CandidateRow[]> {
  const rows = await client<CandidateRow[]>`
    WITH probe AS (SELECT ${toPgRealArray(descriptor)}::real[] AS d),
    scored AS (
      SELECT t.id                      AS template_id,
             t.employee_id             AS employee_id,
             e.employee_code           AS employee_code,
             e.display_name            AS display_name,
             e.employment_status::text AS employment_status,
             p.id                      AS profile_id,
             p.is_active               AS profile_active,
             COALESCE(
               (SELECT array_agg(DISTINCT ur.role::text)
                  FROM public.user_roles ur
                 WHERE ur.user_id = p.id AND ur.revoked_at IS NULL),
               '{}'::text[]
             )                         AS roles,
             o.id                      AS operator_id,
             o.is_active               AS operator_active,
             sqrt(sum(power(x.a::double precision - x.b::double precision, 2)))::numeric(8,5) AS distance
        FROM probe pr
        CROSS JOIN secure.face_templates t
        JOIN public.employees e
          ON e.id = t.employee_id
         AND e.deleted_at IS NULL
        JOIN public.profiles p
          ON p.id = e.profile_id
        LEFT JOIN public.kiosk_operators o
          ON o.employee_id = t.employee_id
         AND o.is_active
         AND (o.kiosk_device_id IS NULL OR o.kiosk_device_id = ${deviceId}::uuid)
        JOIN secure.biometric_consents c
          ON c.id = t.consent_id
         AND c.granted
         AND c.withdrawn_at IS NULL
        CROSS JOIN LATERAL unnest(t.descriptor, pr.d) AS x(a, b)
       WHERE t.is_active
         AND t.purged_at IS NULL
         AND t.descriptor_dim = ${DESCRIPTOR_DIM}
       GROUP BY t.id, t.employee_id, e.employee_code, e.display_name,
                e.employment_status, p.id, p.is_active, o.id, o.is_active
    ),
    nearest AS (
      SELECT DISTINCT ON (s.employee_id) s.*
        FROM scored s
       ORDER BY s.employee_id, s.distance ASC
    )
    SELECT n.employee_id, n.employee_code, n.display_name, n.employment_status,
           n.profile_id, n.profile_active, n.roles, n.operator_id,
           n.operator_active, n.distance
      FROM nearest n
     ORDER BY n.distance ASC
     LIMIT 3
  `;
  return rows as unknown as CandidateRow[];
}

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  try {
    assertOriginAllowed(req);
    const client = sqlHandle();

    const raw = await readRawBody(req, { maxBytes: MAX_BODY_BYTES });
    const deviceAuth = await verifyDevice(req, raw, client);
    const device = deviceAuth.device;

    // Same bucket as the PIN path: a face must not be a cheaper way to hammer the
    // gate than the credential it stands in for.
    await enforce(
      RATE_LIMITS.kioskOperatorAuth,
      limitKey(FN_NAME, device.id),
      "KIOSK_FACE_SIGNIN_RATE_LIMITED",
      client,
    );

    const body = parse(Body, decodeJson(raw), "face sign-in body");
    if (body.device_id !== device.id) {
      throw forbidden("This request is signed for a different device.", "KIOSK_DEVICE_MISMATCH");
    }

    // A non-unit descriptor means the client is not running the sanctioned pipeline,
    // and every distance computed from it would be meaningless.
    const norm = l2Norm(body.descriptor);
    if (Math.abs(norm - 1) > DESCRIPTOR_NORM_TOLERANCE) {
      throw unprocessable(
        [{ pointer: "/descriptor", code: "not_normalised", detail: "Descriptor must be L2-normalised." }],
        "The face descriptor is not unit length.",
      );
    }

    // MEASURED liveness below the floor is positive evidence of a photograph. An
    // ABSENT score is not — see the header — and is recorded instead of refused.
    if (body.liveness !== undefined && body.liveness.score < SIGNIN_MIN_LIVENESS) {
      log.warn("face sign-in refused: liveness below threshold", { device_id: device.id });
      throw unauthorized(
        "That did not look like a live face. Move slightly and try again, or use your PIN.",
        "KIOSK_FACE_LIVENESS_FAILED",
      );
    }

    const serverTime = nowIso();
    const ip = clientIpFrom(req);
    const ctx: RequestContext = {
      actorId: null,
      actorRole: null,
      source: "kiosk",
      sourceRoute: FN_NAME,
      requestId,
      ip,
      ua: userAgentFrom(req),
      reason: "gate shift opened by admin face recognition",
    };

    const candidates = await findCandidates(client, body.descriptor, device.id);
    const best = candidates[0];
    const runnerUp = candidates[1];

    const confidence = best === undefined ? 0 : confidenceFor(Number(best.distance));
    const runnerUpConfidence = runnerUp === undefined ? 0 : confidenceFor(Number(runnerUp.distance));
    const margin = confidence - runnerUpConfidence;

    // Floors, not exact values: a device configured stricter than the constant wins.
    const minConfidence = Math.max(SIGNIN_MIN_CONFIDENCE, device.minMatchConfidence);

    const refuse = async (reason: string, code: string, detail: string): Promise<never> => {
      await withContext(ctx, async (tx) => {
        await auditSession(tx, ctx, {
          event: "login_failed",
          profileId: best?.profile_id ?? null,
          authMethod: "face",
          failureReason: reason,
        });
      });
      log.warn("face sign-in refused", { device_id: device.id, reason });
      throw unauthorized(detail, code);
    };

    if (best === undefined || confidence < minConfidence) {
      await refuse(
        "kiosk_face_no_match",
        "KIOSK_FACE_NOT_RECOGNISED",
        "That face was not recognised clearly enough to start a shift. Use your employee code and PIN.",
      );
    }
    if (runnerUp !== undefined && margin < SIGNIN_MIN_MARGIN) {
      // Two people are close enough that picking one would be a guess, and the
      // wrong guess hands somebody else's authority over.
      await refuse(
        "kiosk_face_ambiguous",
        "KIOSK_FACE_AMBIGUOUS",
        "More than one person matched that face closely. Use your employee code and PIN.",
      );
    }
    const roles = best.roles ?? [];
    if (!roles.some((role) => (ADMIN_ROLES as readonly string[]).includes(role))) {
      // Recognised, and refused anyway. The client asked for ADMINS; a guard who is
      // not an admin still signs in with a PIN.
      await refuse(
        "kiosk_face_not_admin",
        "FACE_NOT_ADMIN",
        "Only an administrator can start a shift with their face. Use your employee code and PIN.",
      );
    }
    if (best.profile_active !== true) {
      await refuse(
        "kiosk_face_profile_inactive",
        "KIOSK_OPERATOR_DISABLED",
        "That account is disabled. Ask a supervisor.",
      );
    }
    if (!(OPERATOR_STATUSES as readonly string[]).includes(best.employment_status)) {
      await refuse(
        "kiosk_face_employment_status",
        "KIOSK_EMPLOYEE_INACTIVE",
        "That employment status cannot operate a gate. Ask a supervisor.",
      );
    }

    /*
      The admin needs an OPERATOR row, because a session is minted against
      `kiosk_operators.id` and every punch attributes itself to an operator. An admin
      who has never worked a gate has no such row — the client's own account included
      — so one is created here rather than refusing with a message about a table
      nobody outside this repo has heard of.

      It is created device-agnostic (`kiosk_device_id = NULL`), which migration 074
      established as the default after per-device operators locked every guard out of
      a newly added gate. `can_enrol_faces` and `can_manual_punch` are TRUE because
      the person is an administrator and already holds those powers in the admin
      console; withholding them at the gate would be a different permission model in
      each place.
    */
    const opened = await withContext(ctx, async (tx) => {
      let operatorId = best.operator_id;
      let created = false;
      if (operatorId === null) {
        const inserted = firstRow(
          await tx<{ id: string }[]>`
            INSERT INTO public.kiosk_operators
              (profile_id, employee_id, kiosk_device_id, can_enrol_faces, can_manual_punch, is_active)
            VALUES (${best.profile_id}::uuid, ${best.employee_id}::uuid, NULL, true, true, true)
            ON CONFLICT (profile_id, coalesce(kiosk_device_id, '00000000-0000-0000-0000-000000000000'::uuid))
              DO UPDATE SET is_active = true
            RETURNING id
          `,
        );
        if (inserted === null) {
          throw forbidden("Could not register this administrator as a gate operator.", "KIOSK_OPERATOR_SETUP_FAILED");
        }
        operatorId = inserted.id;
        created = true;
      }

      const stamped = firstRow(
        await tx<{ last_signed_in_at: string }[]>`
          UPDATE public.kiosk_operators
             SET last_signed_in_at = now()
           WHERE id = ${operatorId}::uuid
          RETURNING last_signed_in_at
        `,
      );

      await auditSession(tx, ctx, {
        event: "login_success",
        profileId: best.profile_id,
        authMethod: "face",
        // The one thing a reviewer needs that the event alone does not say: whether
        // the device could actually prove a live subject.
        failureReason: body.liveness === undefined ? "liveness_not_attested" : null,
      });

      return { operatorId, created, lastSignedInAt: stamped?.last_signed_in_at ?? serverTime };
    });

    // Minted AFTER the transaction commits: a rolled-back sign-in must never leave a
    // usable credential in somebody's hands.
    const session = await mintOperatorSession(deviceAuth.secret, {
      deviceId: device.id,
      operatorId: opened.operatorId,
      ttlSeconds: SESSION_TTL_SECONDS,
    });

    log.info("shift opened by admin face", {
      device_id: device.id,
      operator_id: opened.operatorId,
      employee_code: best.employee_code,
      operator_created: opened.created,
      liveness_attested: body.liveness !== undefined,
    });

    // ALLOW-LIST. No descriptor, distance, confidence, margin or threshold — the
    // same discipline as `kiosk-punch`, so a compromised device learns nothing about
    // the matching model from a successful sign-in.
    return ok(
      {
        op: "open_by_face" as const,
        device: { device_id: device.id, device_code: device.deviceCode, label: device.label },
        operator: {
          operator_id: opened.operatorId,
          display_name: best.display_name,
          employee_code: best.employee_code,
          can_enrol_faces: true,
          can_manual_punch: true,
          signed_in_at: toIso(opened.lastSignedInAt),
        },
        session: {
          token: session.token,
          session_id: session.sessionId,
          expires_at: session.expiresAt,
          expires_in_seconds: SESSION_TTL_SECONDS,
          refresh_after_seconds: Math.floor(SESSION_TTL_SECONDS / 2),
          header: "x-operator-session",
        },
        auth_method: "face" as const,
        server_time: serverTime,
        server_business_date: istDate(serverTime),
        clock_skew_seconds: deviceAuth.clockSkewSeconds,
        request_id: requestId,
      },
      { status: 200, headers: cors, requestId },
    );
  } catch (error) {
    const problem = toProblem(error, requestId).withContext({ requestId, instance });
    if (problem.status >= 500) log.error("face sign-in failed", { status: problem.status });
    return problem.toResponse(cors);
  }
});
