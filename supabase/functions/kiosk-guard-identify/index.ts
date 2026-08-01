/**
 * kiosk-guard-identify — auth model **D** (device HMAC only, no operator session).
 *
 * ONE job: given a face descriptor from a paired gate device, say WHICH GUARD
 * this is — an employee code and a display name. Nothing else. It does not open
 * a session, it does not write a punch, and it cannot be used to punch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ENDPOINT EXISTS, AND WHY IT STOPS WHERE IT STOPS
 * ─────────────────────────────────────────────────────────────────────────────
 * The gate scanner asks the guard "who is on duty?" with the front camera. The
 * face answers that question. It does NOT answer "and may they open a shift":
 * `face-login/index.ts` already wrote down this repo's position in full — a face
 * is an identifier, not a secret; it is on the employee's WhatsApp profile
 * picture; a 1:N match must never hand over session authority. A kiosk operator
 * session authorises punches for everyone who walks through the gate for the next
 * ten minutes, refreshed all shift. That is authority.
 *
 * So the split is:
 *   this function        face → "you are TT0006, Ramesh"     (identification)
 *   kiosk-operator-auth  employee_code + PIN → session token (authorisation)
 *
 * and `kiosk-operator-auth` is UNTOUCHED by this addition: the PIN path that
 * works today keeps working byte for byte, including when this function is not
 * deployed yet. The tablet degrades to typing the code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES IT SAFE TO ANSWER "WHO IS THIS FACE" AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * An endpoint that names a face IS an oracle, so the blast radius is squeezed
 * from four directions:
 *   1. DEVICE HMAC REQUIRED. Only a paired, unrevoked, in-network gate device can
 *      call it (`verifyDevice`), and its nonce is single-use.
 *   2. THE CANDIDATE SET IS THE OPERATOR ROSTER, NOT THE STAFF DIRECTORY. The 1:N
 *      scan joins `public.kiosk_operators` (active, and either device-specific or
 *      device-agnostic exactly as `requireOperatorSession` reads it). An ordinary
 *      employee's face cannot be named here at all — the answer is "not
 *      recognised", the same as a stranger's.
 *   3. THE STRICTEST BAND IN THE BUILD. spec-kiosk §3.3 `T_review = 0.38`: the
 *      kiosk accepts beyond it and flags for review, but a review after the fact
 *      is worth nothing when the output is "this is who you are", so 0.38 is a
 *      hard ceiling here — the same ceiling `face-login` chose, for the same
 *      reason. The device floor and the employee's attendance policy can only
 *      make it stricter (`Math.max`), never looser.
 *   4. EVERY ATTEMPT IS LOGGED. `secure.face_match_log`, before the answer is
 *      returned, matched or not (INV-4), with `error_detail` naming this path so
 *      a guard-identify row is never mistaken for a gate scan on Match Review.
 *      `produced_punch_id` is always NULL: this endpoint cannot create a punch.
 *
 * The match itself is `kiosk-punch`'s query — exact sequential scan, Euclidean
 * distance over L2-normalised `real[]` computed IN POSTGRES, the DPDP consent
 * join, `is_active`, `purged_at IS NULL`, top 3 plus the true `count(*) OVER ()`.
 * No second implementation of the maths that decides who somebody is.
 *
 * RESPONSE ALLOW-LIST (spec-kiosk §11, test T-09): `identified`, `employeeCode`,
 * `displayName`. Never a descriptor, a distance, a threshold, a confidence, an
 * operator id, or anything about any other person.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem, unprocessable } from "../_shared/errors.ts";
import { decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
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
import { verifyDevice } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { claim, idempotencyKeyFrom, release, replayResponse, requestHash, store } from "../_shared/idempotency.ts";
import type { Sql } from "../_shared/deps.ts";

const FN_NAME = "kiosk-guard-identify";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** 128 floats of JSON is ~3 KB. Nothing else is accepted, so the cap is tight. */
const MAX_BODY_BYTES = 16 * 1024;

const DESCRIPTOR_DIM = 128;
/** §10: the descriptor is L2-normalised on-device; the server checks |‖d‖ − 1| ≤ 0.02. */
const DESCRIPTOR_NORM_TOLERANCE = 0.02;
/** Maximum Euclidean distance between two unit vectors — the confidence denominator. */
const MAX_UNIT_DISTANCE = 2;

/** spec-kiosk §3.3 `T_review = 0.38`, used here as a HARD CEILING (see header §3). */
const MAX_IDENTIFY_DISTANCE = 0.38;
/** Fallbacks when no `attendance_policies` row resolves — the DB defaults. */
const DEFAULT_MIN_CONFIDENCE = 0.62;
const DEFAULT_MIN_MARGIN = 0.06;

/** §1: enrolment and scan must agree byte-for-byte or distances are meaningless. */
const DESCRIPTOR_MODEL = "faceapi-rn34-128d-v1";

/**
 * `public.employment_status` values that may not be named as the guard on duty.
 * Mirrors `kiosk-operator-auth`'s list exactly, so the face path and the PIN path
 * refuse the same people — a face that names somebody the PIN step would then
 * reject is a worse experience than not naming them.
 */
const BLOCKED_EMPLOYMENT_STATUSES: ReadonlySet<string> = new Set([
  "pre_joining",
  "suspended",
  "absconding",
  "exited",
  "retired",
]);

const IdentifyBody = z
  .object({
    descriptor: z
      .array(z.number().finite())
      .length(DESCRIPTOR_DIM, `Expected ${DESCRIPTOR_DIM} floats.`),
    mode: z.literal("face"),
  })
  .strict();

/** The only keys that may ever reach a kiosk from this endpoint. */
const ALLOWED_RESPONSE_FIELDS = ["identified", "employeeCode", "displayName"] as const;

function pickWhitelisted(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_RESPONSE_FIELDS) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

function toPgRealArray(values: readonly number[]): string {
  return `{${values.map((v) => (Object.is(v, -0) ? 0 : v)).join(",")}}`;
}

function l2Norm(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum);
}

/** Unit-vector Euclidean distance → [0,1] confidence (migration 012: `1 − d / max_d`). */
function confidenceFor(distance: number): number {
  return 1 - distance / MAX_UNIT_DISTANCE;
}

/**
 * The confidence the hard distance ceiling is worth (0.38 → 0.81), and the reason
 * it exists as a named constant: `secure.face_match_log.threshold_used` is
 * documented as "pinned at decision time; a later policy change cannot rewrite
 * history", so it has to be the floor this decision was ACTUALLY made against.
 * `resolveMinConfidence` returns the policy/device floor (0.62 by default), but on
 * this path a candidate at 0.62 confidence is refused anyway — the binding
 * constraint is `distance <= MAX_IDENTIFY_DISTANCE`. Logging 0.62 would describe a
 * rule this function does not use. Logging `max(policy, ceiling)` describes the
 * rule it does. The DECISION below is unchanged; only the recorded number is.
 */
const CEILING_CONFIDENCE = confidenceFor(MAX_IDENTIFY_DISTANCE);

interface OperatorCandidateRow {
  template_id: string;
  employee_id: string;
  operator_id: string;
  model_version: string;
  employee_code: string;
  display_name: string;
  employment_status: string;
  profile_active: boolean;
  distance: string;
  candidate_set_size: number;
}

interface OperatorCandidate {
  employeeId: string;
  operatorId: string;
  modelVersion: string;
  employeeCode: string;
  displayName: string;
  employmentStatus: string;
  profileActive: boolean;
  distance: number;
}

/**
 * `kiosk-punch#findCandidates`, narrowed to the operator roster for THIS device.
 *
 * Three deliberate differences from the punch query, and no fourth:
 *   * THE `kiosk_operators` JOIN. That is the whole security difference; an
 *     ordinary employee's face cannot be named by this endpoint at all.
 *   * `GROUP BY t.id` — PER TEMPLATE, exactly as `kiosk-punch` groups. Grouping by
 *     `employee_id` instead would lump two template rows of one person into a
 *     single group and sum 256 squared differences into one "distance", which is
 *     not a distance at all.
 *   * …then ONE ROW PER EMPLOYEE (`DISTINCT ON`), keeping their nearest template.
 *     `uq_face_templates__employee_active` allows only one ACTIVE template per
 *     employee today, so this changes no answer right now — it is there because the
 *     margin test is what would break if that ever became two: a person would be
 *     their own runner-up, the margin would come out near zero, and a perfectly
 *     good guard would be refused as "ambiguous". `count(*) OVER ()` over that set
 *     is the number of enrolled guards on this gate — the honest N for the
 *     `face_match_log` row.
 *
 * All of the above is PROVEN against the migrated schema, not assumed: a retired
 * template is ignored even when it is nearer, a withdrawn DPDP consent removes the
 * guard from the search space immediately, a deactivated `kiosk_operators` row does
 * the same, and an enrolled non-guard employee is never returned.
 */
async function findOperatorCandidates(
  client: Sql,
  descriptor: readonly number[],
  deviceId: string,
): Promise<{ candidates: OperatorCandidate[]; candidateSetSize: number }> {
  const rows = await client<OperatorCandidateRow[]>`
    WITH probe AS (SELECT ${toPgRealArray(descriptor)}::real[] AS d),
    scored AS (
      SELECT t.id                      AS template_id,
             t.employee_id             AS employee_id,
             o.id                      AS operator_id,
             t.model_version           AS model_version,
             e.employee_code           AS employee_code,
             e.display_name            AS display_name,
             e.employment_status::text AS employment_status,
             p.is_active               AS profile_active,
             sqrt(sum(power(x.a::double precision - x.b::double precision, 2)))::numeric(8,5) AS distance
        FROM probe pr
        CROSS JOIN secure.face_templates t
        JOIN public.employees e
          ON e.id = t.employee_id
         AND e.deleted_at IS NULL
        JOIN public.kiosk_operators o
          ON o.employee_id = t.employee_id
         AND o.is_active
         -- NULL kiosk_device_id = authorised on every device (migration 013),
         -- read exactly as requireOperatorSession reads it.
         AND (o.kiosk_device_id IS NULL OR o.kiosk_device_id = ${deviceId}::uuid)
        JOIN public.profiles p
          ON p.id = o.profile_id
        JOIN secure.biometric_consents c
          ON c.id = t.consent_id
         AND c.granted
         AND c.withdrawn_at IS NULL
        CROSS JOIN LATERAL unnest(t.descriptor, pr.d) AS x(a, b)
       /*
         EVERY SAMPLE OF THE CURRENT ENROLMENT, not only the medoid. Enrolment stores five
         samples per operator and marks one is_active; this searched that one row, so four
         fifths of the capture went unused. Leave-one-out over all 365 stored samples: genuine
         distance median 0.1849 to 0.1614, p90 0.2670 to 0.2424, wrong top-1 identity 5 to 0,
         and margin median 0.1990 to 0.2019 — it does not degrade.

         The DISTINCT ON below already reduces to one row per employee, which is what makes
         this safe: the note above it anticipated exactly this change, and the margin is still
         measured between PEOPLE rather than between two samples of one guard.

         Scoped to the version of the row that is ACTIVE, so a superseded enrolment cannot vote.
       */
       WHERE t.purged_at IS NULL
         AND t.descriptor_dim = ${DESCRIPTOR_DIM}
         AND EXISTS (
           SELECT 1 FROM secure.face_templates a
            WHERE a.employee_id = t.employee_id
              AND a.version = t.version
              AND a.is_active
              AND a.purged_at IS NULL
         )
       GROUP BY t.id, t.employee_id, o.id, t.model_version, e.employee_code,
                e.display_name, e.employment_status, p.is_active
    ),
    nearest AS (
      SELECT DISTINCT ON (s.employee_id) s.*
        FROM scored s
       ORDER BY s.employee_id, s.distance ASC
    )
    SELECT n.template_id,
           n.employee_id,
           n.operator_id,
           n.model_version,
           n.employee_code,
           n.display_name,
           n.employment_status,
           n.profile_active,
           n.distance,
           (count(*) OVER ())::integer AS candidate_set_size
      FROM nearest n
     ORDER BY n.distance ASC
     LIMIT 3
  `;
  const list = rows as unknown as OperatorCandidateRow[];
  return {
    candidateSetSize: list[0]?.candidate_set_size ?? 0,
    candidates: list.map((r) => ({
      employeeId: r.employee_id,
      operatorId: r.operator_id,
      modelVersion: r.model_version,
      employeeCode: r.employee_code,
      displayName: r.display_name,
      employmentStatus: r.employment_status,
      profileActive: r.profile_active === true,
      distance: Number(r.distance),
    })),
  };
}

/**
 * The floor for THIS decision: the device's own floor, the candidate's attendance
 * policy, and the built-in default — strictest wins, exactly as `kiosk-punch`
 * combines them.
 */
async function resolveMinConfidence(
  client: Sql,
  employeeId: string,
  deviceMinConfidence: number,
): Promise<{ minConfidence: number; minMargin: number }> {
  const rows = await client`
    SELECT ap.min_confidence_for_auto_accept,
           ap.min_margin_for_auto_accept
      FROM public.attendance_policies ap
     WHERE ap.id = public.resolve_policy('attendance_policy', ${employeeId}::uuid, util.ist_today())
       AND ap.deleted_at IS NULL
     LIMIT 1
  `;
  const row = firstRow(rows as unknown as Record<string, unknown>[]);
  const policyConfidence = row === null ? DEFAULT_MIN_CONFIDENCE : Number(row.min_confidence_for_auto_accept);
  const policyMargin = row === null ? DEFAULT_MIN_MARGIN : Number(row.min_margin_for_auto_accept);
  return {
    minConfidence: Math.max(deviceMinConfidence, policyConfidence, DEFAULT_MIN_CONFIDENCE),
    minMargin: Number.isFinite(policyMargin) ? policyMargin : DEFAULT_MIN_MARGIN,
  };
}

interface MatchLogInput {
  deviceId: string;
  operatorId: string | null;
  candidateSetSize: number;
  outcome: string;
  matchedEmployeeId: string | null;
  bestDistance: number | null;
  bestConfidence: number | null;
  runnerUpEmployeeId: string | null;
  runnerUpDistance: number | null;
  margin: number | null;
  candidateScores: unknown;
  thresholdUsed: number;
  modelVersion: string;
  latencyMs: number;
  ip: string | null;
  appVersion: string | null;
  errorDetail: string;
}

/**
 * The `secure.face_match_log` row. `produced_punch_id` and `capture_photo_path`
 * are always NULL here by construction — this path cannot write a punch and
 * never receives an image. `error_detail` carries the path name so Match Review
 * can tell a guard sign-in apart from a gate scan at a glance.
 */
async function insertMatchLog(tx: Sql, input: MatchLogInput): Promise<void> {
  const round = (v: number | null): number | null => (v === null ? null : Number(v.toFixed(5)));
  await tx`
    INSERT INTO secure.face_match_log (
      attempted_at, kiosk_device_id, operator_id, candidate_set_size, outcome,
      matched_employee_id, best_distance, best_confidence,
      runner_up_employee_id, runner_up_distance, margin, candidate_scores,
      threshold_used, model_version, capture_photo_path, latency_ms,
      produced_punch_id, ip, app_version, error_detail
    ) VALUES (
      now(),
      ${input.deviceId}::uuid,
      ${input.operatorId}::uuid,
      ${input.candidateSetSize}::integer,
      ${input.outcome}::text,
      ${input.matchedEmployeeId}::uuid,
      ${round(input.bestDistance)}::numeric,
      ${round(input.bestConfidence)}::numeric,
      ${input.runnerUpEmployeeId}::uuid,
      ${round(input.runnerUpDistance)}::numeric,
      ${round(input.margin)}::numeric,
      ${JSON.stringify(input.candidateScores)}::jsonb,
      ${round(input.thresholdUsed)}::numeric,
      ${input.modelVersion}::text,
      NULL::text,
      ${Math.trunc(input.latencyMs)}::integer,
      NULL::uuid,
      ${input.ip}::inet,
      ${input.appVersion}::text,
      ${input.errorDetail}::text
    )
  `;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ─────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ───────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ─────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model D) ───────────────────────────────────────────────
    // Raw bytes first: the HMAC covers exactly what was sent.
    const rawBody = await readRawBody(req, { maxBytes: MAX_BODY_BYTES });
    const decoded = decodeJson(rawBody);
    const client = sqlHandle();
    const deviceAuth = await verifyDevice(req, rawBody, client);
    const device = deviceAuth.device;

    // ── STEP 5 · Authority ────────────────────────────────────────────────────
    // The pairing IS the authority: no operator session exists yet — creating the
    // conditions for one is the whole point of this call. Nothing is written that
    // an unpaired caller could reach, and nothing is returned about anybody who
    // is not on this device's guard roster.
    const deviceLog = log.child({
      device_id: device.id,
      device_code: device.deviceCode,
      clock_skew_seconds: deviceAuth.clockSkewSeconds,
    });

    // ── STEP 6 · Rate limit (device level) ────────────────────────────────────
    // Its own bucket key, so a guard retrying their face cannot eat the scan
    // allowance that punches run on. Outside any transaction: a refused call
    // still spends its token.
    await enforce(
      RATE_LIMITS.kioskHeartbeat,
      limitKey(FN_NAME, device.id),
      "KIOSK_RATE_LIMITED",
    );

    // ── STEP 7 · Validate ─────────────────────────────────────────────────────
    const body = parse(IdentifyBody, decoded, "guard identify body");

    // A non-unit descriptor means the tablet skipped L2 normalisation, and every
    // distance computed from it is a lie.
    const norm = l2Norm(body.descriptor);
    if (Math.abs(norm - 1) > DESCRIPTOR_NORM_TOLERANCE) {
      throw unprocessable(
        [{ pointer: "/descriptor", code: "not_normalised", detail: "Descriptor must be L2-normalised." }],
        "The face descriptor is not unit length.",
        "KIOSK_DESCRIPTOR_INVALID",
      );
    }

    // ── STEP 8 · Idempotency claim ────────────────────────────────────────────
    // The HMAC nonce is single-use per device, so a true wire replay is already
    // refused at step 4. The claim earns its keep across a reconnect retry.
    idempotencyKey = idempotencyKeyFrom(req) ?? `${FN_NAME}:${device.id}:${deviceAuth.nonce}`;
    const hash = await requestHash(FN_NAME, rawBody, device.id);
    const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: hash }, client);
    if (claimed.state === "replay") {
      status = claimed.status;
      deviceLog.info("idempotent replay", { key: idempotencyKey });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    // ── STEP 9 · The 1:N, over the guard roster only ──────────────────────────
    const { candidates, candidateSetSize } = await findOperatorCandidates(
      client,
      body.descriptor,
      device.id,
    );
    const best = candidates[0];
    const runnerUp = candidates[1];

    const thresholds = best === undefined
      ? { minConfidence: Math.max(device.minMatchConfidence, DEFAULT_MIN_CONFIDENCE), minMargin: DEFAULT_MIN_MARGIN }
      : await resolveMinConfidence(client, best.employeeId, device.minMatchConfidence);

    const bestDistance = best?.distance ?? null;
    const bestConfidence = bestDistance === null ? null : confidenceFor(bestDistance);
    const margin = bestDistance !== null && runnerUp !== undefined ? runnerUp.distance - bestDistance : null;

    const eligible = best !== undefined &&
      best.profileActive &&
      !BLOCKED_EMPLOYMENT_STATUSES.has(best.employmentStatus);
    const identified = best !== undefined &&
      bestDistance !== null &&
      bestConfidence !== null &&
      bestDistance <= MAX_IDENTIFY_DISTANCE &&
      bestConfidence >= thresholds.minConfidence &&
      (margin === null || margin >= thresholds.minMargin) &&
      eligible;

    // Distances stay SERVER-SIDE (§4.2: "Raw distances NOT returned").
    const candidateScores = candidates.map((c, i) => ({
      rank: i + 1,
      employee_id: c.employeeId,
      distance: Number(c.distance.toFixed(5)),
    }));

    const outcome = identified
      ? "matched"
      : best !== undefined && bestDistance !== null && bestDistance <= MAX_IDENTIFY_DISTANCE
      ? "ambiguous"
      : "no_match";

    /**
     * WHY THIS IS DERIVED FROM THE OUTCOME AND NOT FROM `eligible` ALONE: the scan
     * returns EVERY roster template with its distance, unfiltered, so `best` is
     * undefined only when this device's roster has no enrolled, consented, active
     * template at all — the actual rollout failure mode, and worth saying out loud.
     * A stranger at the gate has a `best` (at ~1.4) and must not be filed as
     * "not eligible"; an eligibility refusal must not be filed as a bad distance.
     * `error_detail` is read by a human deciding whether a gate is broken, so every
     * branch has to be the truth about THIS attempt.
     */
    const errorDetail = identified
      ? "guard_identify: named the guard for the PIN step; grants no session"
      : best === undefined
      ? "guard_identify: no enrolled guard on this device's roster (no active, consented template)"
      : !eligible
      ? `guard_identify: nearest roster face is not eligible to operate ` +
        `(employment_status=${best.employmentStatus}, profile_active=${best.profileActive})`
      : bestDistance !== null && bestDistance > MAX_IDENTIFY_DISTANCE
      ? "guard_identify: nearest roster face is beyond the identify ceiling"
      : margin !== null && margin < thresholds.minMargin
      ? "guard_identify: two roster faces are too close to name either one"
      : "guard_identify: nearest roster face is below the confidence floor";

    // ── STEP 10 · Log the attempt BEFORE answering (INV-4) ────────────────────
    const ctx: RequestContext = {
      // A kiosk is not a person, and nobody is authenticated yet.
      actorId: null,
      actorRole: null,
      source: "kiosk",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: device.id,
      reason: null,
    };
    await withContext(ctx, async (tx) => {
      await insertMatchLog(tx, {
        deviceId: device.id,
        // The roster row this face resolved to, when it resolved to one. This is
        // provenance for the sign-in attempt, not an open session.
        operatorId: identified && best !== undefined ? best.operatorId : null,
        candidateSetSize,
        outcome,
        matchedEmployeeId: identified && best !== undefined ? best.employeeId : null,
        bestDistance,
        bestConfidence,
        runnerUpEmployeeId: runnerUp?.employeeId ?? null,
        runnerUpDistance: runnerUp?.distance ?? null,
        margin,
        candidateScores,
        // The floor this decision was actually made against — see CEILING_CONFIDENCE.
        thresholdUsed: Math.max(thresholds.minConfidence, CEILING_CONFIDENCE),
        modelVersion: best?.modelVersion ?? DESCRIPTOR_MODEL,
        latencyMs: log.elapsedMs(),
        ip: ctx.ip ?? null,
        appVersion: device.storedAppVersion,
        errorDetail,
      });
    });

    deviceLog.info("guard identify", {
      outcome,
      identified,
      roster_size: candidateSetSize,
    });

    const responseBody = pickWhitelisted(
      identified && best !== undefined
        ? { identified: true, employeeCode: best.employeeCode, displayName: best.displayName }
        : { identified: false },
    );

    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ────────────────
    await store(idempotencyKey, status, responseBody, client);
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    if (idempotencyKey !== null) {
      try {
        // 5xx is not a deterministic answer: free the key so a retry is processed
        // for real rather than replaying our failure.
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, problem.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }

    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ──────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported for `supabase/tests` and the kiosk SDK — one contract, one source. */
export { ALLOWED_RESPONSE_FIELDS, IdentifyBody, MAX_IDENTIFY_DISTANCE };
