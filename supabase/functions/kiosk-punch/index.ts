/**
 * kiosk-punch — catalogue #1, auth model **D+O** (device HMAC + open operator session).
 *
 * THE hot path. A guard-operated tablet sends a 128-float face descriptor; the
 * SERVER decides who it is, writes the punch, and answers with a name, a code, a
 * photo and a time. Nothing else. The tablet never sees a descriptor, a distance,
 * a threshold or any other employee's data (spec-kiosk INV-3/INV-8, §11
 * allow-list, spec-architecture §6 kiosk hard rule, test T-09).
 *
 * Two shapes on the same endpoint:
 *   single  { clientEventId, capturedAt?, descriptor[128], photoBase64?, queuedAt?, mode:'face' }
 *   batch   { queue: [ …the same item, up to 25 ] }     ← offline IndexedDB replay
 *
 * Batch items keep their ORIGINAL `capturedAt` as `punched_at` (skew-corrected),
 * are stamped `is_offline_replay = true` with `queued_at` and
 * `device_clock_skew_seconds`, and each carries its own `clientEventId` so
 * per-item idempotency is exact — see §8.1 and migration 050 §4.
 *
 * INV-4 / INV-9: no biometric event is silently dropped. Every outcome —
 * matched, ambiguous, no-match, debounced, inactive identity — writes a
 * `secure.face_match_log` row before the function answers.
 *
 * WHY THE MATCH IS SQL, NOT TYPESCRIPT: pulling ~2,000 × 128 floats into the
 * isolate on every scan is ~1 MB per punch and blows the 700 ms budget. The
 * distance is computed in Postgres, exactly (sequential scan — spec-kiosk §3.1
 * is explicit that margin correctness must never be probabilistic).
 *
 * AUDIT: `public.attendance_punches` is deliberately NOT audit-trigger-attached
 * (migration 038 header: "its insert IS the audit record; voids are audited by
 * the void-punch path"). So this function writes NO `audit_log` row and must not
 * start: the punch row plus its `face_match_log` row IS the evidence trail.
 * `void-punch/index.ts` owns the other half.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { forbidden, methodNotAllowed, ok, tooMany, toProblem, unprocessable } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger, type Logger } from "../_shared/log.ts";
import { istTime, nowIso, nowMs, parseFlexibleInstant, toIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  serviceClient,
  sql as sqlHandle,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { type DeviceAuth, type OperatorSession, requireOperatorSession, verifyDevice } from "../_shared/auth.ts";
import { evaluateGeofence } from "../_shared/geofence.ts";
import { limitKey, RATE_LIMITS, tryTake } from "../_shared/ratelimit.ts";
import { claim, idempotencyKeyFrom, release, replayResponse, requestHash, store } from "../_shared/idempotency.ts";
import type { Sql } from "../_shared/deps.ts";

const FN_NAME = "kiosk-punch";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** A 640×640 q0.75 JPEG is ~90 KB → ~120 KB base64. Five of those plus descriptors fit here. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** spec-kiosk §8.1 syncs in batches of 5; 25 is generous headroom, not an invitation. */
const MAX_BATCH_ITEMS = 25;
/** Hard cap per photo, mirroring the tablet's 200 KB blob cap (§8) with base64 overhead. */
const MAX_PHOTO_BASE64_CHARS = 400_000;

const DESCRIPTOR_DIM = 128;
/** §10: the descriptor is L2-normalised on-device; the server checks |‖d‖ − 1| ≤ 0.02. */
const DESCRIPTOR_NORM_TOLERANCE = 0.02;
/** Maximum Euclidean distance between two unit vectors — the confidence denominator. */
const MAX_UNIT_DISTANCE = 2;

/** Fallbacks when no `attendance_policies` row resolves. Same numbers as the DB defaults. */
const DEFAULT_MIN_CONFIDENCE = 0.62;
const DEFAULT_MIN_MARGIN = 0.06;

/**
 * How good a 1:1 verification must be before a device's hint is allowed to break a tie.
 *
 * 0.70, against the 1:N floor of 0.62. Deliberately STRICTER, because the hint is used precisely
 * where the evidence is weakest — two enrolled faces within the margin of each other — and the
 * device's copy of the templates may be days old. A hint may only rescue a scan the server had
 * already shortlisted and had merely failed to separate; it can never manufacture a match the
 * server would otherwise refuse outright.
 *
 * Every punch accepted this way is flagged `needs_review`, so a human sees it. The trade is
 * explicit: attendance that would have been lost is recorded, and it is recorded as something
 * worth checking rather than as a clean match.
 */
const LOCAL_HINT_MIN_CONFIDENCE = 0.70;
const DEFAULT_DEBOUNCE_SECONDS = 120;

/**
 * THE GATE'S OWN FLOOR UNDER THE DEBOUNCE: once a punch is recorded, nothing else is
 * recorded for five minutes.
 *
 * ── WHY THE GATE NEEDS ITS OWN NUMBER ────────────────────────────────────────
 * Migration 072 took the shared debounce down to 60 seconds, in the client's words: "There
 * should always be a button. After 1 minute only, they can log out." That is a statement about
 * a BUTTON — a deliberate press by someone who has decided to punch again. It is the right
 * number for `attendance-self-punch`, which is why that path is untouched here.
 *
 * A gate is not a button. Nobody decides to scan; a camera reads whoever is standing in front
 * of it, several times a minute, whether or not they meant to punch. At 60 seconds a person
 * chatting by the door collects a punch a minute. The client's rule for the gate is the plain
 * one: "when it is already registered, only the first log stands — no other log for the
 * five-minute gap."
 *
 * ── WHY 300, AND WHY A FLOOR RATHER THAN A REPLACEMENT ───────────────────────
 * 300 is the number the gate already reasons in: MINIMUM DWELL is five minutes, so the two
 * rules now agree instead of covering different spans. A floor (`max`, never `min`) means a
 * policy that wants a LONGER window still gets it; only a shorter one is lifted. Migration 072
 * verifies the stored policy is 60 and would fail if this rewrote it — so it does not.
 *
 * ── WHAT ACTUALLY CHANGES ────────────────────────────────────────────────────
 * Only third-and-later scans between 60s and 300s. The first→second transition was already
 * covered by MINIMUM DWELL at the same 300 seconds, so no in→out pair that used to record
 * stops recording because of this.
 */
const GATE_MIN_DEBOUNCE_SECONDS = 300;

/**
 * MINIMUM DWELL: how long after a check-in before a check-OUT will be accepted.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
 * People stand in front of the gate after it has recognised them. They read the card, they
 * wait for somebody, they chat. The camera keeps scanning, the debounce window passes, and the
 * terminal dutifully records their SECOND punch — which the attendance engine reads as a
 * check-out, thirty seconds after they arrived. The day then computes as a two-minute shift.
 *
 * The debounce cannot fix this and is not meant to: at 120 seconds it is an anti-double-scan
 * guard, and stretching it to cover loitering would also swallow every legitimate scan in
 * those minutes. This is a different rule with a different reason, so it is a different
 * number.
 *
 * ── WHY FIVE MINUTES ─────────────────────────────────────────────────────────
 * Chosen by the client. It is long enough that no plausible amount of standing about produces
 * an out, and short enough that a genuine brief visit — dropping something off and leaving —
 * still records both ends of itself.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 * It only guards the FIRST → SECOND transition, the one the engine reads as in → out. A third
 * or later scan is left to the debounce alone: by then the day already has both boundaries and
 * an extra punch changes neither.
 */
const DEFAULT_MIN_DWELL_SECONDS = 300;

/**
 * `attendance.liveness_pass_threshold`. The SAME setting and the same default that
 * `face-login` refuses below — one measurement must not have two bars in one product.
 */
const DEFAULT_LIVENESS_PASS = 0.7;

/**
 * spec-kiosk §3.3 `T_far = 0.62` (Euclidean). Below the accept threshold but
 * within this, the guard is offered the top 3 to confirm; beyond it there are no
 * candidates worth showing. There is no column for it yet — see the DB-gap note.
 */
const GUARD_CONFIRM_MAX_DISTANCE = 0.62;
/** §3.3 `T_review = 0.38`: an accepted match beyond this is band `low` → review queue. */
const REVIEW_DISTANCE = 0.38;

/** §11: a candidate/matched reference photo is a 120-second signed URL. */
const REFERENCE_PHOTO_TTL_SECONDS = 120;
/** §8.1 KS-4: device time is trusted for a queued punch only while |skew| ≤ 60 s. */
const OFFLINE_SKEW_TRUST_SECONDS = 60;

const PUNCH_PHOTO_BUCKET = "kiosk-punch-photos";
const EMPLOYEE_PHOTO_BUCKET = "employee-photos";

/** §1: enrolment and scan must agree byte-for-byte or distances are meaningless. */
const DESCRIPTOR_MODEL = "faceapi-rn34-128d-v1";

/**
 * Statuses at which a person may be recorded at the gate.
 *
 * The governing principle: SOMEONE WHO TURNS UP IS A FACT HR NEEDS. `absconding` and
 * `on_long_leave` were always allowed on that reasoning — flagged for review, not refused.
 *
 * ── WHY `pre_joining` IS NOW ON THIS LIST ────────────────────────────────────
 * It used to be excluded as "this person has no business punching", and in the abstract that
 * reads well. In practice it was the opposite of a safeguard. `pre_joining` is the wizard's
 * default and the table's, so it is where every employee added through the app STARTS — and
 * with nothing in the product able to move them off it, four people reached production unable
 * to punch anywhere. Their faces matched at the gate at 0.85–0.92 confidence against a 0.62
 * threshold, and every punch was refused. To the person standing at the camera, and to whoever
 * they complained to, that is a broken terminal.
 *
 * The venue's call, and the right one for this venue: a person at the door is at the door. If
 * the paperwork says they have not started, that is a discrepancy for HR to reconcile — and it
 * reconciles far better from a recorded scan than from an absence of one. Refusing the punch
 * did not prevent the shift; it only lost the evidence that it happened.
 *
 * Still excluded, and these are deliberate: `suspended` (told not to come in), `exited`,
 * `retired`. Those are refusals with someone's decision behind them.
 */
const PUNCHABLE_STATUSES: ReadonlySet<string> = new Set([
  "pre_joining",
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "rehired",
  "on_long_leave",
  "absconding",
]);
const REVIEW_STATUSES: ReadonlySet<string> = new Set(["on_long_leave", "absconding", "on_notice"]);

// ═══════════════════════════════════════════════════════════════════════════════
// Request contract
// ═══════════════════════════════════════════════════════════════════════════════

const PunchItem = z
  .object({
    /** uuidv4 minted at capture on the tablet; the dedup key end to end (§8). */
    clientEventId: common.idempotencyKey,
    /** Device wall clock at capture. Metadata for an online punch (INV-1); `punched_at` for a replay. */
    capturedAt: common.instant.optional(),
    descriptor: z
      .array(z.number().finite())
      .length(DESCRIPTOR_DIM, `Expected ${DESCRIPTOR_DIM} floats.`),
    /** JPEG, base64 (bare or data-URL). Optional; a storage failure never loses the punch. */
    photoBase64: z.string().max(MAX_PHOTO_BASE64_CHARS).optional(),
    /** When the item entered the offline queue. */
    queuedAt: common.instant.optional(),
    /**
     * Where the tablet was, from `navigator.geolocation`. OPTIONAL, and its absence
     * is never a refusal: a wall-mounted kiosk may have no fix at all, and a
     * refused permission is an expected outcome rather than a violation.
     *
     * PER ITEM, not per request, because an offline queue can be flushed from
     * somewhere other than where it was filled — a phone carried indoors and
     * synced later would otherwise stamp every queued punch with the location of
     * the sync. Each scan carries the fix that was taken WITH it.
     *
     * This existed on `attendance-self-punch` from the start and was simply
     * missing here, so every gate punch landed with a blank location while web
     * punches carried coordinates.
     */
    geo: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracyMetres: z.number().nonnegative().max(100_000).optional(),
      })
      .strict()
      .optional(),
    /**
     * Capture quality and the liveness measurement, from the device that took the frames.
     *
     * SHAPE COPIED FROM `face-login`'s `ProbeMetrics` on purpose, field for field: the same
     * client module produces it (`features/auth/lib/liveness.ts`) and two different shapes
     * for one measurement is how they drift apart.
     *
     * OPTIONAL AT THE SCHEMA AND MANDATORY BY POLICY. An attended gate may omit it — the
     * guard standing there is the liveness check, and an already-deployed tablet that has
     * not been updated yet must keep working. An UNATTENDED gate may not: see
     * `requireLiveness` below, which refuses the punch when it is missing.
     */
    metrics: z
      .object({
        /** `detection.score` from TinyFaceDetector on the capture frame. */
        detectionScore: z.number().finite().min(0).max(1),
        /** `liveness.passive_score` — 0 when the device could not measure. */
        livenessScore: z.number().finite().min(0).max(1),
        /** e.g. `frame-motion-heuristic-v1`, recorded so the audit row names what produced it. */
        livenessModel: z.string().trim().min(1).max(64).optional(),
        framesAnalysed: z.number().int().min(1).max(240).optional(),
      })
      .strict()
      .optional(),
    /**
     * WHO THE DEVICE THOUGHT IT WAS, matched offline against its own copy of the templates.
     *
     * A HINT, never an assertion. It is used in exactly one place — {@link LOCAL_HINT_MIN_CONFIDENCE}
     * — when this server's own 1:N could not separate two people, and even then only to run a
     * 1:1 verification of the descriptor against THAT employee. If the 1:1 does not clear a bar
     * stricter than the 1:N floor, the scan is refused exactly as before.
     *
     * It can never make a match the server would not otherwise be willing to make; it can only
     * break a tie the server had already narrowed to a shortlist. A device's copy is stale by
     * construction, which is why it gets to narrow and never to decide.
     */
    localEmployeeId: common.uuid.optional(),
    mode: z.literal("face"),
  })
  .strict();

const BatchBody = z
  .object({ queue: z.array(PunchItem).min(1).max(MAX_BATCH_ITEMS) })
  .strict();

/** Batch first: a body carrying `queue` must never be tried against the single schema. */
const PunchBody = z.union([BatchBody, PunchItem]);

type PunchItemInput = z.infer<typeof PunchItem>;

// ═══════════════════════════════════════════════════════════════════════════════
// Response contract — an ALLOW-LIST, enforced at runtime
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The only keys that may ever reach a kiosk (spec-kiosk §11, test T-09).
 * `pickWhitelisted` is applied to every result on the way out, so adding a field
 * to an internal type cannot leak it — a new key has to be added HERE, which is
 * a reviewed security decision.
 *
 * Never present, by construction: descriptor, distance, threshold, confidence,
 * salary, phone, email, address, Aadhaar/PAN/bank, DOB, designation, department,
 * manager, leave, any other employee, any history beyond this punch.
 */
export const ALLOWED_RESPONSE_FIELDS = [
  "matched",
  "displayName",
  "employeeCode",
  "photoUrl",
  "punchKind",
  "istTime",
  "guardConfirmOptions",
  /**
   * True when the scan was recognised but wrote NO punch — a debounce collision, or a second
   * scan too soon after the check-in to be a check-out.
   *
   * It was missing from this list, and its absence was not cosmetic: the client decides what
   * the terminal SAYS from this flag, so every suppressed scan announced itself as a
   * successful punch. Somebody standing in front of the gate heard "your attendance is
   * registered" for a scan that recorded nothing, which is the most confusing thing a gate can
   * do — it is confidently wrong, and it invites them to keep scanning.
   */
  "duplicateSuppressed",
  /** Machine code only, batch items only: lets the queue mark an item failed vs done (§8.1). */
  "error",
] as const;

export type PunchKind = "in" | "out" | "scan";

interface GuardConfirmOption {
  employeeCode: string;
  displayName: string;
  photoUrl: string | null;
}

interface PunchResult {
  matched: boolean;
  displayName?: string;
  employeeCode?: string;
  photoUrl?: string | null;
  punchKind?: PunchKind;
  istTime?: string;
  guardConfirmOptions?: GuardConfirmOption[];
  error?: string;
}

/** Strip anything not on the allow-list. The last line of defence for T-09. */
export function pickWhitelisted(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_RESPONSE_FIELDS) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Small helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Postgres array literal. Sent as text and cast, so no client type inference is involved. */
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

function decodeBase64Jpeg(value: string): Uint8Array {
  const comma = value.indexOf(",");
  const cleaned = (comma >= 0 && value.slice(0, comma).includes("base64") ? value.slice(comma + 1) : value)
    .replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch {
    throw unprocessable(
      [{ pointer: "/photoBase64", code: "invalid_base64", detail: "Photo is not valid base64." }],
      "The capture photo could not be decoded.",
      "KIOSK_PHOTO_HASH_MISMATCH",
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Storage put, done BEFORE the transaction (spec-kiosk §4.4: "Steps 15–20 in one
 * transaction except Storage put; orphan objects swept nightly"). A failure here
 * is logged and swallowed: losing a photo is a degraded punch, losing the punch
 * is a person who cannot prove they came to work (INV-9).
 */
async function putPhoto(path: string, bytes: Uint8Array, log: Logger): Promise<string | null> {
  const { error } = await serviceClient()
    .storage.from(PUNCH_PHOTO_BUCKET)
    .upload(path, bytes, { contentType: "image/jpeg", upsert: true });
  if (error !== null) {
    log.warn("punch photo upload failed; punch proceeds without it", { path, err: error.message });
    return null;
  }
  return path;
}

/** 120-second signed URL for a reference photo. Null when the employee has none. */
async function signReferencePhoto(photoPath: string | null): Promise<string | null> {
  if (photoPath === null || photoPath === "") return null;
  const { data, error } = await serviceClient()
    .storage.from(EMPLOYEE_PHOTO_BUCKET)
    .createSignedUrl(photoPath, REFERENCE_PHOTO_TTL_SECONDS);
  if (error !== null || data === null) return null;
  return data.signedUrl;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1:N match
// ═══════════════════════════════════════════════════════════════════════════════

interface CandidateRow {
  template_id: string;
  employee_id: string;
  model_version: string;
  employee_code: string;
  display_name: string;
  photo_path: string | null;
  employment_status: string;
  distance: string;
  candidate_set_size: number;
}

interface Candidate {
  templateId: string;
  employeeId: string;
  modelVersion: string;
  employeeCode: string;
  displayName: string;
  photoPath: string | null;
  employmentStatus: string;
  distance: number;
}

/**
 * Exact sequential 1:N scan over every ACTIVE, consented, un-purged template.
 * Returns the three nearest plus the true size of the candidate set.
 *
 * The consent join is the DPDP Act gate: a withdrawn consent removes the person
 * from the search space immediately, without waiting for the ≤7-day purge job.
 *
 * `count(*) OVER ()` is evaluated after GROUP BY and before LIMIT, so it is the
 * real N — the number the `face_match_log` row has to record.
 */
async function findCandidates(
  client: Sql,
  descriptor: readonly number[],
): Promise<{ candidates: Candidate[]; candidateSetSize: number }> {
  const rows = await client<CandidateRow[]>`
    WITH probe AS (SELECT ${toPgRealArray(descriptor)}::real[] AS d),
    /*
      EVERY SAMPLE OF THE CURRENT ENROLMENT, not only the medoid.

      Enrolment stores five samples per employee and marks one — the medoid — as the single
      is_active row, so this gate has been matching against a fifth of what was captured.
      Leave-one-out over all 365 stored samples:

                                    medoid only     all samples
        wrong top-1 identity              5              0
        genuine distance, median      0.1849         0.1614
        genuine distance, p90         0.2670         0.2424
        margin, median                0.1990         0.2019

      Scoped to the ACTIVE ROW's version, so a superseded enrolment cannot vote: re-enrolling
      replaces the set the moment its new medoid becomes active.
    */
    eligible AS (
      SELECT t.id, t.employee_id, t.model_version, t.descriptor,
             e.employee_code, e.display_name, e.photo_path, e.employment_status
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
    ),
    per_sample AS (
      SELECT t.id AS template_id, t.employee_id, t.model_version,
             t.employee_code, t.display_name, t.photo_path,
             t.employment_status::text AS employment_status,
             sqrt(sum(power(x.a::double precision - x.b::double precision, 2))) AS distance
        FROM probe p
        CROSS JOIN eligible t
        CROSS JOIN LATERAL unnest(t.descriptor, p.d) AS x(a, b)
       GROUP BY t.id, t.employee_id, t.model_version, t.employee_code, t.display_name,
                t.photo_path, t.employment_status
    ),
    /*
      ONE ROW PER EMPLOYEE, and this is what keeps the margin meaningful. Ranking samples
      directly would fill the top three with the same face, make the runner-up that person
      again, and collapse the margin to nearly nothing — every honest punch refused as
      ambiguous. The margin exists to separate PEOPLE, so it must be measured between them.
      (kiosk-guard-identify has always done this, for exactly this reason.)
    */
    best_per_employee AS (
      SELECT DISTINCT ON (employee_id)
             template_id, employee_id, model_version, employee_code, display_name,
             photo_path, employment_status, distance
        FROM per_sample
       ORDER BY employee_id, distance ASC
    )
    SELECT template_id                 AS template_id,
           employee_id                 AS employee_id,
           model_version               AS model_version,
           employee_code               AS employee_code,
           display_name                AS display_name,
           photo_path                  AS photo_path,
           employment_status           AS employment_status,
           distance::numeric(8,5)      AS distance,
           (count(*) OVER ())::integer AS candidate_set_size
      FROM best_per_employee
     ORDER BY distance ASC
     LIMIT 3
  `;
  const list = rows as unknown as CandidateRow[];
  return {
    candidateSetSize: list[0]?.candidate_set_size ?? 0,
    candidates: list.map((r) => ({
      templateId: r.template_id,
      employeeId: r.employee_id,
      modelVersion: r.model_version,
      employeeCode: r.employee_code,
      displayName: r.display_name,
      photoPath: r.photo_path,
      employmentStatus: r.employment_status,
      distance: Number(r.distance),
    })),
  };
}

interface Thresholds {
  minConfidence: number;
  minMargin: number;
  debounceSeconds: number;
}

/**
 * Thresholds for THIS decision: the device floor (`kiosk_devices.min_match_confidence`)
 * and the matched employee's attendance policy. The strictest of the two wins —
 * a device hardened for a badly-lit gate must not be loosened by a policy row.
 */
async function resolveThresholds(
  client: Sql,
  employeeId: string,
  deviceMinConfidence: number,
): Promise<Thresholds> {
  const rows = await client`
    SELECT ap.punch_debounce_seconds,
           ap.min_confidence_for_auto_accept,
           ap.min_margin_for_auto_accept
      FROM public.attendance_policies ap
     WHERE ap.id = public.resolve_policy('attendance_policy', ${employeeId}::uuid, util.ist_today())
       AND ap.deleted_at IS NULL
     LIMIT 1
  `;
  const row = firstRow(rows as unknown as Record<string, unknown>[]);
  const policyMinConfidence = row === null ? DEFAULT_MIN_CONFIDENCE : Number(row.min_confidence_for_auto_accept);
  const policyMinMargin = row === null ? DEFAULT_MIN_MARGIN : Number(row.min_margin_for_auto_accept);
  const debounce = row === null ? DEFAULT_DEBOUNCE_SECONDS : Number(row.punch_debounce_seconds);
  const resolvedDebounce = Number.isFinite(debounce) ? debounce : DEFAULT_DEBOUNCE_SECONDS;
  return {
    minConfidence: Math.max(deviceMinConfidence, policyMinConfidence),
    minMargin: policyMinMargin,
    // Floor, not replacement — a policy asking for longer keeps it. See GATE_MIN_DEBOUNCE_SECONDS.
    debounceSeconds: Math.max(resolvedDebounce, GATE_MIN_DEBOUNCE_SECONDS),
  };
}

/**
 * `attendance.min_dwell_seconds`, or the documented default.
 *
 * Read through `app.setting` for the same reason the liveness bar is: a venue with a genuinely
 * different rhythm — a kitchen door people pass through constantly, say — can change it
 * without a deploy, and the value applies everywhere at once rather than being copied into a
 * client that then drifts.
 *
 * A non-numeric or negative value falls back to the default rather than disabling the rule.
 * "Somebody typed nonsense into a settings row" must not silently reopen the exact hole this
 * closes.
 */
async function resolveMinDwellSeconds(client: Sql): Promise<number> {
  try {
    const rows = await client<{ value: string | null }[]>`
      SELECT app.setting('attendance.min_dwell_seconds') AS value
    `;
    const raw = firstRow(rows)?.value;
    if (raw === null || raw === undefined) return DEFAULT_MIN_DWELL_SECONDS;
    const parsed = Number(String(raw).replace(/"/g, "").trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_DWELL_SECONDS;
  } catch {
    // No such setting key, or no accessor. The default is the rule.
    return DEFAULT_MIN_DWELL_SECONDS;
  }
}

/**
 * `attendance.liveness_pass_threshold`, or the documented default.
 *
 * Read through `app.setting` — the same accessor `face-login` uses for the same key — so a
 * site that tightens the bar tightens it for both the gate and the web sign-in, and cannot
 * end up with a face that is live enough to open the app but not the gate.
 */
async function resolveLivenessPass(client: Sql): Promise<number> {
  try {
    const rows = await client`
      SELECT app.setting('attendance.liveness_pass_threshold') AS liveness_pass
    `;
    const row = firstRow(rows as unknown as Record<string, unknown>[]);
    const parsed = Number(row?.liveness_pass ?? Number.NaN);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DEFAULT_LIVENESS_PASS;
  } catch {
    // A missing or unreadable setting must not open the gate. The default is the same
    // number the setting ships with, so falling back is a no-op rather than a loosening.
    return DEFAULT_LIVENESS_PASS;
  }
}

/**
 * The business date the `trg_attendance_punches__business_date` trigger will
 * choose, asked of the SAME database functions the trigger uses. Needed only to
 * name the photo folder, which has to exist before the insert.
 *
 * The insert's `RETURNING effective_date` is compared against this and a
 * mismatch is logged — so drift is visible rather than silent. A
 * `public.punch_effective_date(uuid, timestamptz)` helper would remove the
 * duplication entirely; see the DB-gap note.
 */
async function predictEffectiveDate(
  client: Sql,
  employeeId: string,
  punchedAtOverride: string | null,
): Promise<string> {
  const rows = await client`
    WITH t AS (SELECT COALESCE(${punchedAtOverride}::timestamptz, now()) AS ts)
    SELECT COALESCE(
             (SELECT (util.ist_date(t.ts) - 1)
                FROM public.shifts s
               WHERE s.id = public.resolve_shift_for_date(${employeeId}::uuid, util.ist_date(t.ts) - 1)
                 AND COALESCE(s.crosses_midnight, false)
                 AND util.ist_time(t.ts) < COALESCE(s.day_cutover_time, TIME '05:00')),
             util.ist_date(t.ts)
           )::text AS effective_date
      FROM t
  `;
  const row = firstRow(rows as unknown as { effective_date: string }[]);
  return row?.effective_date ?? "";
}

// ═══════════════════════════════════════════════════════════════════════════════
// One punch, end to end
// ═══════════════════════════════════════════════════════════════════════════════

interface ProcessInput {
  item: PunchItemInput;
  deviceAuth: DeviceAuth;
  operator: OperatorSession | null;
  ctxBase: Omit<RequestContext, "reason">;
  isReplay: boolean;
  log: Logger;
  client: Sql;
  /**
   * `attendance.liveness_pass_threshold`, resolved ONCE per request and passed in.
   *
   * A batch may carry 25 items; reading the setting inside the loop would be 25 identical
   * round trips, and — worse — a setting changed mid-flush would judge the first half of a
   * queue by one bar and the second half by another.
   */
  livenessPass: number;
  /**
   * `attendance.min_dwell_seconds`, resolved once per request for the same reasons.
   *
   * A replayed queue matters here in particular: those punches carry their ORIGINAL capture
   * instants, so the dwell is measured between the times people were actually at the gate, not
   * between the moments the tablet happened to reconnect.
   */
  minDwellSeconds: number;
}

/**
 * Lifecycle steps 9–10 for a single scan, and the whole of spec-kiosk §4.4
 * steps 7–20 for it.
 */
async function processPunch(input: ProcessInput): Promise<PunchResult> {
  const { item, deviceAuth, operator, ctxBase, isReplay, log, client, livenessPass, minDwellSeconds } =
    input;
  const device = deviceAuth.device;

  // §4.4 step 7 — descriptor sanity. A non-unit descriptor means the tablet
  // skipped L2 normalisation, and every distance computed from it is a lie.
  const norm = l2Norm(item.descriptor);
  if (Math.abs(norm - 1) > DESCRIPTOR_NORM_TOLERANCE) {
    throw unprocessable(
      [{ pointer: "/descriptor", code: "not_normalised", detail: "Descriptor must be L2-normalised." }],
      "The face descriptor is not unit length.",
      "KIOSK_DESCRIPTOR_INVALID",
    );
  }

  // §4.4 step 9 — decode once, before any DB work, so an unusable photo fails
  // the same way on every path instead of after a match has been logged.
  const photoBytes = item.photoBase64 === undefined ? null : decodeBase64Jpeg(item.photoBase64);

  // INV-1 / KS-4. Online: the server clock is truth and `punched_at` stays
  // `now()`. Replay: keep the ORIGINAL capture instant, corrected by the
  // measured skew, and never let it land in the future (`ck_ap__not_future`).
  let punchedAtOverride: string | null = null;
  if (isReplay && item.capturedAt !== undefined) {
    const captured = parseFlexibleInstant(item.capturedAt);
    if (captured !== null) {
      const skew = deviceAuth.clockSkewSeconds;
      const correctedMs = captured.getTime() -
        (Math.abs(skew) <= OFFLINE_SKEW_TRUST_SECONDS ? 0 : skew * 1000);
      const serverMs = nowMs();
      punchedAtOverride = toIso(correctedMs > serverMs ? serverMs : correctedMs);
    }
  }

  /*
    ── LIVENESS, BEFORE THE 1:N ──────────────────────────────────────────────────
    Placed here on purpose: a scan that cannot prove a live face should not be compared
    against the roster at all. Matching first and refusing afterwards would write a real
    employee's identity onto a failed attempt, which is both a worse audit record and a
    free 1:N oracle for anybody holding up photographs.

    REQUIRED ON EVERY PUNCH, WITH NO EXEMPTION.

    This used to be waived when `require_operator` was true, on the reasoning that a guard
    standing at the gate is a better liveness check than any heuristic. That reasoning was
    sound and is now void: the guard screen has been removed from the terminal, so no punch
    arriving here has a human watching it, whatever the device row happens to say. Leaving
    the exemption keyed to that row would have meant every device still flagged attended —
    which is all of them until somebody runs an UPDATE — silently accepting a printed
    photograph. The exemption did not become wrong when the flag changed; it became wrong
    when the guard screen went, so it is gone with it.

    The cost is that a tablet on a build older than the metrics field stops punching. That
    is the correct direction: an old client failing loudly beats an old client waved through
    the only check standing between a photograph and an attendance record.

    The threshold is `attendance.liveness_pass_threshold`, the same setting `face-login`
    reads. `measureLiveness` reports 0 when the device could not measure, so "could not
    tell" and "told us it was a photo" fail identically — which is correct.
  */
  // Unconditional — see above. Kept as a named constant rather than inlined so the
  // grep for `livenessRequired` still lands on the explanation.
  const livenessRequired = true;
  if (livenessRequired) {
    const metrics = item.metrics;
    const detail = metrics === undefined
      ? "metrics.livenessScore is required on an unattended gate"
      : metrics.livenessScore < livenessPass
        ? `liveness_score=${metrics.livenessScore} < ${livenessPass}`
        : null;

    if (detail !== null) {
      await insertMatchLog(client, {
        id: crypto.randomUUID(),
        attemptedAtOverride: punchedAtOverride,
        deviceId: device.id,
        operatorId: operator?.operatorId ?? null,
        candidateSetSize: 0,
        outcome: "liveness_failed",
        matchedEmployeeId: null,
        bestDistance: null,
        bestConfidence: null,
        runnerUpEmployeeId: null,
        runnerUpDistance: null,
        margin: null,
        candidateScores: [],
        thresholdUsed: livenessPass,
        modelVersion: metrics?.livenessModel ?? DESCRIPTOR_MODEL,
        detectorScore: metrics?.detectionScore ?? null,
        livenessScore: metrics?.livenessScore ?? null,
        capturePhotoPath: null,
        latencyMs: 0,
        producedPunchId: null,
        ip: ctxBase.ip ?? null,
        appVersion: device.storedAppVersion,
        errorDetail: detail,
      });
      // Deliberately the same shape as an ordinary no-match: the gate is told the scan did
      // not produce a punch, and nothing about why. Telling the person in front of the
      // camera which check they failed is telling them how to pass it.
      return { matched: false, guardConfirmOptions: [] };
    }
  }

  // §4.4 step 10 — 1:N.
  const { candidates, candidateSetSize } = await findCandidates(client, item.descriptor);
  const best = candidates[0];
  const runnerUp = candidates[1];

  const thresholds = best === undefined
    ? { minConfidence: Math.max(device.minMatchConfidence, DEFAULT_MIN_CONFIDENCE), minMargin: DEFAULT_MIN_MARGIN, debounceSeconds: Math.max(DEFAULT_DEBOUNCE_SECONDS, GATE_MIN_DEBOUNCE_SECONDS) }
    : await resolveThresholds(client, best.employeeId, device.minMatchConfidence);

  const bestDistance = best?.distance ?? null;
  const bestConfidence = bestDistance === null ? null : confidenceFor(bestDistance);
  const margin = bestDistance !== null && runnerUp !== undefined ? runnerUp.distance - bestDistance : null;
  const marginOk = margin === null || margin >= thresholds.minMargin;
  const accepted = best !== undefined &&
    bestConfidence !== null &&
    bestConfidence >= thresholds.minConfidence &&
    marginOk;

  // Top-3 distances stay SERVER-SIDE (§4.2: "Raw distances NOT returned").
  const candidateScores = candidates.map((c, i) => ({
    rank: i + 1,
    employee_id: c.employeeId,
    template_id: c.templateId,
    distance: Number(c.distance.toFixed(5)),
  }));

  const matchLogId = crypto.randomUUID();
  const ctx: RequestContext = { ...ctxBase, reason: null };

  /*
    ── BEFORE REFUSING: WOULD A 1:1 AGAINST THE DEVICE'S CANDIDATE SETTLE IT? ────
    Asked for directly: when the server cannot decide, do not lose the attendance of somebody
    the terminal had already recognised.

    Only ever reached when the 1:N was NOT accepted, and only ever against the one employee the
    device named. A 1:1 is a fundamentally easier question than a 1:N — there is no field of
    competitors to be confused by — which is why it can settle a case the search could not, and
    why it is held to a stricter bar (0.70 against 0.62) rather than a looser one.

    The candidate must already be in the shortlist this search produced. That is the line that
    keeps the server in charge: the hint may break a tie the server had narrowed, and can never
    introduce somebody the server did not already consider close. A stale bundle therefore
    cannot name a person who has been re-enrolled, had consent withdrawn, or left.
  */
  let hintAccepted: Candidate | null = null;
  if (!accepted && item.localEmployeeId !== undefined) {
    const hinted = candidates.find((c) => c.employeeId === item.localEmployeeId);
    if (hinted !== undefined && confidenceFor(hinted.distance) >= LOCAL_HINT_MIN_CONFIDENCE) {
      hintAccepted = hinted;
      log.info("device hint verified 1:1", {
        employee_id: hinted.employeeId,
        confidence: Number(confidenceFor(hinted.distance).toFixed(5)),
        margin: margin === null ? null : Number(margin.toFixed(5)),
        bar: LOCAL_HINT_MIN_CONFIDENCE,
      });
    } else {
      log.info("device hint not verified", {
        hinted: item.localEmployeeId,
        in_shortlist: hinted !== undefined,
        confidence: hinted === undefined ? null : Number(confidenceFor(hinted.distance).toFixed(5)),
      });
    }
  }

  // ── Not accepted: log the attempt, offer the guard the top 3, write no punch ──
  if (!accepted && hintAccepted === null) {
    const offerCandidates = best !== undefined && bestDistance !== null &&
      bestDistance <= GUARD_CONFIRM_MAX_DISTANCE;
    const outcome = offerCandidates ? "ambiguous" : "no_match";

    // §4.4 step 10: an unmatched capture is still stored, under `unmatched/`, so
    // an admin can resolve it later (§8.1 `unresolved_offline_punch`).
    const photoPath = photoBytes === null
      ? null
      : await putPhoto(`unmatched/${matchLogId}.jpg`, photoBytes, log);

    await withContext(ctx, async (tx) => {
      await insertMatchLog(tx, {
        id: matchLogId,
        attemptedAtOverride: punchedAtOverride,
        deviceId: device.id,
        operatorId: operator?.operatorId ?? null,
        candidateSetSize,
        outcome,
        matchedEmployeeId: null,
        bestDistance,
        bestConfidence,
        runnerUpEmployeeId: runnerUp?.employeeId ?? null,
        runnerUpDistance: runnerUp?.distance ?? null,
        margin,
        candidateScores,
        thresholdUsed: thresholds.minConfidence,
        modelVersion: best?.modelVersion ?? DESCRIPTOR_MODEL,
        detectorScore: item.metrics?.detectionScore ?? null,
        livenessScore: item.metrics?.livenessScore ?? null,
        capturePhotoPath: photoPath,
        latencyMs: log.elapsedMs(),
        producedPunchId: null,
        ip: ctx.ip ?? null,
        appVersion: device.storedAppVersion,
        errorDetail: null,
      });
    });

    log.info("scan not auto-accepted", {
      outcome,
      candidate_set_size: candidateSetSize,
      offered: offerCandidates ? candidates.length : 0,
    });

    const guardConfirmOptions: GuardConfirmOption[] = offerCandidates
      ? await Promise.all(
        candidates.map(async (c) => ({
          employeeCode: c.employeeCode,
          displayName: c.displayName,
          photoUrl: await signReferencePhoto(c.photoPath),
        })),
      )
      : [];

    return { matched: false, guardConfirmOptions };
  }

  /*
    The identity the punch is written against.

    `hintAccepted` when a 1:1 verification settled a tie the 1:N could not — it is the same
    candidate object from the same shortlist, so nothing downstream needs to know the difference
    except `needsReview`, which does.
  */
  const matched = hintAccepted ?? (best as Candidate);

  // §4.4 step 11 — the identity exists, but is it allowed through the gate?
  // The attempt is already recorded before the refusal (INV-4).
  if (!PUNCHABLE_STATUSES.has(matched.employmentStatus)) {
    await withContext(ctx, async (tx) => {
      await insertMatchLog(tx, {
        id: matchLogId,
        attemptedAtOverride: punchedAtOverride,
        deviceId: device.id,
        operatorId: operator?.operatorId ?? null,
        candidateSetSize,
        outcome: "matched",
        matchedEmployeeId: matched.employeeId,
        bestDistance,
        bestConfidence,
        runnerUpEmployeeId: runnerUp?.employeeId ?? null,
        runnerUpDistance: runnerUp?.distance ?? null,
        margin,
        candidateScores,
        thresholdUsed: thresholds.minConfidence,
        modelVersion: matched.modelVersion,
        detectorScore: item.metrics?.detectionScore ?? null,
        livenessScore: item.metrics?.livenessScore ?? null,
        capturePhotoPath: null,
        latencyMs: log.elapsedMs(),
        producedPunchId: null,
        ip: ctx.ip ?? null,
        appVersion: device.storedAppVersion,
        errorDetail: `employment_status=${matched.employmentStatus}`,
      });
    });
    throw forbidden("This person is not authorised to punch at this kiosk.", "KIOSK_EMPLOYEE_INACTIVE");
  }

  // §4.4 step 15 — Storage put first, so the path is known before the insert.
  const punchId = crypto.randomUUID();
  const predictedDate = await predictEffectiveDate(client, matched.employeeId, punchedAtOverride);
  const photoPath = photoBytes === null
    ? null
    : await putPhoto(`${predictedDate}/${punchId}.jpg`, photoBytes, log);

  // WHERE the scan happened, judged against the device's fence (its own
  // `allowed_geofence` if set, else its location) by the SAME function the web
  // punch uses — `_shared/geofence.ts`, so "inside the venue" cannot mean two
  // different things depending on which door somebody came through.
  //
  // A punch outside the fence is RECORDED and FLAGGED, never refused: attendance
  // is a fact, and deleting the evidence would remove exactly the case the fence
  // exists to surface. No coordinates, or no fence configured, yields NULL — "not
  // evaluated", which is not the same as "outside".
  const geofence = evaluateGeofence(item.geo, device.geofence);

  // §5.3: a guard scanning themselves is 100 % review, always.
  const selfOperated = operator !== null && operator.employeeId === matched.employeeId;
  const needsReview = isReplay ||
    /*
      A hint-verified punch is ALWAYS reviewable. It is recorded — which is the point, the
      attendance is not lost — but it is recorded as something worth a look rather than as a
      clean match, because the 1:N had genuinely failed to separate two people.
    */
    hintAccepted !== null ||
    (bestDistance !== null && bestDistance > REVIEW_DISTANCE) ||
    selfOperated ||
    // Outside the fence, or a fix too coarse to tell — a human decides, the gate
    // does not. `accuracyTooCoarse` matters more at a gate than on a phone: an
    // indoor tablet on wifi can report a ±2 km fix that no 300 m fence can judge.
    geofence.geofenceOk === false ||
    geofence.accuracyTooCoarse ||
    REVIEW_STATUSES.has(matched.employmentStatus);

  // ── Steps 12, 16, 19, 20: ONE transaction ──────────────────────────────────
  try {
    const written = await withContext(ctx, async (tx) => {
      // §4.4 step 12 — debounce. A duplicate is still WRITTEN (INV-4), voided at
      // insert with `duplicate_of_punch_id` set, so the gate event exists and the
      // day computation ignores it. `is_voided = true` at INSERT is legal: the
      // append-only trigger fires on UPDATE/DELETE only.
      const recent = await tx`
        SELECT p.id, p.punched_at, p.effective_date::text AS effective_date
          FROM public.attendance_punches p
         WHERE p.employee_id = ${matched.employeeId}::uuid
           AND p.is_voided = false
           AND p.punched_at <= COALESCE(${punchedAtOverride}::timestamptz, now())
           AND p.punched_at >  COALESCE(${punchedAtOverride}::timestamptz, now())
                               - make_interval(secs => ${thresholds.debounceSeconds}::double precision)
         ORDER BY p.punched_at DESC
         LIMIT 1
      `;
      const duplicateOf = firstRow(
        recent as unknown as {
          id: string;
          punched_at: Date | string;
          effective_date: string;
        }[],
      );

      /*
        A DEBOUNCED DUPLICATE WRITES NO PUNCH ROW AT ALL. THIS IS THE "TWO INS" BUG.

        It used to write one, voided, pointing at the punch it duplicated — which is what
        `attendance-self-punch` still does. But `ck_ap__void_fields` demands `voided_by` on
        any voided row, and the only profile on the scene at a gate was the guard's:

            const voidAttribution = operator?.profileId ?? null;
            const isDuplicate = duplicateOf !== null && voidAttribution !== null;

        With no guard signed in, `voidAttribution` was null, so `isDuplicate` went FALSE on a
        scan that WAS a duplicate, and the row was written LIVE with a warning in the log.
        `compute_attendance_day` filters on `is_voided = false` alone — `duplicate_of_punch_id`
        is only surfaced as a flag, never used to exclude — so that live row COUNTED. One
        person scanning twice inside the debounce window got two real punches, which is the
        double entry that was observed at the gate. Removing the guard screen would have made
        it happen on every single re-scan rather than only on an unattended device.

        Attributing the void to the employee instead — the convention the web path uses, since
        there the actor IS the employee — does not close it either: `employees.profile_id` is
        nullable, so any employee without a linked login (gate staff, most likely) would fall
        straight back into the same hole.

        So the duplicate is not written. INV-4 is not weakened by that: it is a rule about
        `secure.face_match_log`, which is written for EVERY attempt whatever the outcome, and
        this scan lands there as `duplicate_suppressed` carrying its distance, its device, its
        photograph and its liveness score. What is dropped is a second ATTENDANCE FACT that
        was never a fact — not evidence. The screen is answered from the original punch, so
        the person at the gate sees the time they actually checked in.

        It does cost the engine's `v_dup` flag, which read `duplicate_of_punch_id IS NOT NULL`
        over rows that no longer exist. That flag only ever described a row this endpoint
        wrote for itself; the suppression is still fully visible in the match log.
      */
      /*
        ── MINIMUM DWELL: THE SECOND SCAN IS NOT AN OUT UNTIL THEY HAVE BEEN HERE A WHILE ──

        Somebody checks in and then stands there — reading the card, waiting for a colleague,
        talking. The camera keeps scanning. Once the 120-second debounce lapses the terminal
        records their next scan, the engine reads the day's second punch as the check-OUT, and
        a person who has just arrived is recorded as having left after two minutes.

        So: if this scan WOULD be the day's second live punch, and the first one was less than
        the dwell ago, it is suppressed exactly as a debounced duplicate is — no row written,
        the person told they are already checked in. Their "in" stands, which is what they
        actually did.

        Deliberately scoped to the first → second transition. A third scan cannot create this
        problem: the day already has both of its boundaries and another punch moves neither.
      */
      let dwellSuppressed = false;
      let dwellReference: { id: string; punched_at: Date | string; effective_date: string } | null =
        null;

      if (duplicateOf === null && minDwellSeconds > 0) {
        /*
          The elapsed comparison is done in SQL, against the DATABASE clock.

          Not a style choice. `punched_at` is stamped by Postgres, so measuring the gap with
          this isolate's clock compares two different clocks — and an edge runtime whose time
          had drifted by a minute would silently widen or narrow the dwell window with nothing
          to show why. The same `now()` that will stamp this punch decides whether it is too
          soon, and a replayed queue item measures from its own captured instant instead.
        */
        const sameDay = await tx`
          SELECT p.id,
                 p.punched_at,
                 p.effective_date::text AS effective_date,
                 (COALESCE(${punchedAtOverride}::timestamptz, now()) - p.punched_at)
                   < make_interval(secs => ${minDwellSeconds}::double precision) AS too_soon
            FROM public.attendance_punches p
           WHERE p.employee_id = ${matched.employeeId}::uuid
             AND p.effective_date = ${predictedDate}::date
             AND p.is_voided = false
           ORDER BY p.punched_at ASC
        `;
        const existing = sameDay as unknown as {
          id: string;
          punched_at: Date | string;
          effective_date: string;
          too_soon: boolean;
        }[];

        // Exactly one so far means this scan is the one the engine will read as the check-out.
        const first = existing.length === 1 ? existing[0] : undefined;
        if (first !== undefined && first.too_soon === true) {
          dwellSuppressed = true;
          dwellReference = first;
          log.info("scan suppressed: minimum dwell not met", {
            employee_id: matched.employeeId,
            min_dwell_seconds: minDwellSeconds,
          });
        }
      }

      const isDuplicate = duplicateOf !== null || dwellSuppressed;

      const matchLog = await insertMatchLog(tx, {
        id: matchLogId,
        attemptedAtOverride: punchedAtOverride,
        deviceId: device.id,
        operatorId: operator?.operatorId ?? null,
        candidateSetSize,
        outcome: isDuplicate ? "duplicate_suppressed" : "matched",
        matchedEmployeeId: matched.employeeId,
        bestDistance,
        bestConfidence,
        runnerUpEmployeeId: runnerUp?.employeeId ?? null,
        runnerUpDistance: runnerUp?.distance ?? null,
        margin,
        candidateScores,
        thresholdUsed: thresholds.minConfidence,
        modelVersion: matched.modelVersion,
        detectorScore: item.metrics?.detectionScore ?? null,
        livenessScore: item.metrics?.livenessScore ?? null,
        capturePhotoPath: photoPath,
        latencyMs: log.elapsedMs(),
        // Null on a suppressed duplicate: no punch was produced, and pointing at the
        // original would claim this scan created a row it merely collided with.
        producedPunchId: isDuplicate ? null : punchId,
        ip: ctx.ip ?? null,
        appVersion: device.storedAppVersion,
        errorDetail: null,
      });

      // §4.4 step 16. `direction` stays 'undetermined' — the kiosk never decides
      // in/out; `compute_attendance_day` derives it (migration 016 header).
      // `business_date` is left NULL so the night-shift trigger owns it.
      // `idempotency_key` is the client's event id: migration 050 §4 turns a
      // replay into SQLSTATE 23505 via `attendance_punch_keys`.
      /*
        The original stands in for the suppressed scan, so everything downstream — the
        ordinal that picks the word on screen, the time shown, the photo-folder check —
        reads the punch that actually exists rather than one that was not written.
      */
      const insertedRows = isDuplicate
        ? []
        : await tx`
        INSERT INTO public.attendance_punches (
          id, employee_id, punched_at, direction, source,
          kiosk_device_id, operator_id, face_match_log_id,
          match_confidence, match_distance, photo_path,
          lat, lng, location_accuracy_m, geofence_ok,
          ip, user_agent, device_id,
          is_offline_replay, queued_at, device_clock_skew_seconds,
          needs_review, is_voided, voided_by, voided_at, void_reason,
          duplicate_of_punch_id, recorded_by, request_id, idempotency_key
        ) VALUES (
          ${punchId}::uuid,
          ${matched.employeeId}::uuid,
          COALESCE(${punchedAtOverride}::timestamptz, now()),
          'undetermined'::public.punch_direction,
          'kiosk_face'::public.punch_source,
          ${device.id}::uuid,
          ${operator?.operatorId ?? null}::uuid,
          ${matchLog}::uuid,
          ${bestConfidence === null ? null : Number(bestConfidence.toFixed(5))}::numeric,
          ${bestDistance === null ? null : Number(bestDistance.toFixed(5))}::numeric,
          ${photoPath}::text,
          ${item.geo?.latitude ?? null}::numeric,
          ${item.geo?.longitude ?? null}::numeric,
          ${item.geo?.accuracyMetres ?? null}::numeric,
          ${geofence.geofenceOk}::boolean,
          ${ctx.ip ?? null}::inet,
          ${ctx.ua ?? null}::text,
          ${device.deviceCode}::text,
          ${isReplay}::boolean,
          ${item.queuedAt ?? null}::timestamptz,
          ${deviceAuth.clockSkewSeconds}::integer,
          ${needsReview}::boolean,
          -- Never voided at insert any more. The only row this endpoint used to void was
          -- the debounced duplicate, and that row is no longer written at all.
          false::boolean,
          NULL::uuid,
          NULL::timestamptz,
          NULL::text,
          NULL::uuid,
          ${operator?.profileId ?? null}::uuid,
          ${ctx.requestId}::uuid,
          ${item.clientEventId}::text
        )
        RETURNING id, punched_at, effective_date::text AS effective_date
      `;
      // The punch that stands in for the suppressed scan: the one it collided with, or — for a
      // dwell suppression — the check-in it is too soon after. Both make the screen and the
      // spoken line describe the punch that actually exists.
      const standIn = duplicateOf ?? dwellReference;
      const punch = isDuplicate && standIn !== null
        ? {
          id: standIn.id,
          punched_at: standIn.punched_at,
          effective_date: standIn.effective_date,
        }
        : firstRow(
          insertedRows as unknown as {
            id: string;
            punched_at: Date | string;
            effective_date: string;
          }[],
        );
      if (punch === null) {
        throw new Error("punch insert returned no row");
      }

      // Ordinal → display kind. For a debounced punch the reference instant is
      // the ORIGINAL punch, so the guard sees the same word twice ("Checked in")
      // instead of a phantom check-out.
      const reference = isDuplicate && standIn !== null ? standIn.punched_at : punch.punched_at;
      const priorRows = await tx`
        SELECT count(*)::integer AS prior
          FROM public.attendance_punches q
         WHERE q.employee_id = ${matched.employeeId}::uuid
           AND q.effective_date = ${punch.effective_date}::date
           AND q.is_voided = false
           AND q.punched_at < ${toIso(reference)}::timestamptz
           AND q.id <> ${punchId}::uuid
      `;
      const prior = firstRow(priorRows as unknown as { prior: number }[])?.prior ?? 0;

      // Telemetry. Migration 050 §6 narrowed `trg_kiosk_devices__audit` to the
      // config columns, so this writes NO audit row and needs no reason.
      await tx`
        UPDATE public.kiosk_devices
           SET last_punch_at      = now(),
               clock_skew_seconds = ${deviceAuth.clockSkewSeconds}::integer
         WHERE id = ${device.id}::uuid
           AND deleted_at IS NULL
      `;

      return { punch, prior, isDuplicate };
    });

    // Skipped for a suppressed duplicate: the date compared would be the ORIGINAL punch's,
    // which says nothing about where this scan's photograph was filed.
    if (!written.isDuplicate && written.punch.effective_date !== predictedDate) {
      // Cosmetic only — the object and `photo_path` agree, so the storage policy
      // still resolves; the folder just is not the business date. Visible on
      // purpose: it means the prediction above has drifted from the trigger.
      log.warn("photo folder does not match the trigger's effective_date", {
        predicted: predictedDate,
        actual: written.punch.effective_date,
      });
    }

    const punchKind: PunchKind = written.prior === 0 ? "in" : written.prior === 1 ? "out" : "scan";
    log.info("punch recorded", {
      punch_id: written.punch.id,
      duplicate: written.isDuplicate,
      needs_review: needsReview || written.isDuplicate,
      offline_replay: isReplay,
      candidate_set_size: candidateSetSize,
    });

    return {
      matched: true,
      // Whether anything was actually written. The screen and the spoken line both hang off
      // this, so a suppressed scan is announced as already recorded rather than as new.
      duplicateSuppressed: written.isDuplicate,
      displayName: matched.displayName,
      employeeCode: matched.employeeCode,
      photoUrl: await signReferencePhoto(matched.photoPath),
      punchKind,
      istTime: istTime(written.punch.punched_at),
    };
  } catch (err) {
    // Migration 050 §4: `attendance_punch_keys` PK (employee_id, idempotency_key)
    // is the permanent, cross-partition replay guard — it outlives the 24-hour
    // idempotency store, so an overnight queue replay lands here. It is a
    // SUCCESS for the client, not a 500: answer with the original punch.
    if (isUniqueViolation(err)) {
      log.info("punch already recorded for this client event id", {
        client_event_id: item.clientEventId,
      });
      return await replayedPunchResult(client, matched, {
        clientEventId: item.clientEventId,
        punchedAtOverride,
        deviceId: device.id,
      });
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

interface ReplayLookup {
  clientEventId: string;
  punchedAtOverride: string | null;
  deviceId: string;
}

/**
 * Rebuild the ORIGINAL answer for a punch that already exists.
 *
 * Two indexes can raise 23505 here, and both mean "this scan is already
 * recorded": `attendance_punch_keys` (the client event id — migration 050 §4)
 * and `uq_attendance_punches__emp_instant_device` (same employee, same instant,
 * same device — the guard for a client that forgot to send a key). The key
 * lookup is tried first because it is exact; the instant lookup is the fallback
 * so the second case still answers with the real punch instead of a guess.
 */
async function replayedPunchResult(
  client: Sql,
  matched: Candidate,
  lookup: ReplayLookup,
): Promise<PunchResult> {
  const byKey = await client`
    SELECT p.punched_at,
           (SELECT count(*)::integer
              FROM public.attendance_punches q
             WHERE q.employee_id = p.employee_id
               AND q.effective_date = p.effective_date
               AND q.is_voided = false
               AND q.punched_at < p.punched_at) AS prior
      FROM public.attendance_punch_keys k
      JOIN public.attendance_punches p
        ON p.id = k.punch_id AND p.punched_at = k.punched_at
     WHERE k.employee_id = ${matched.employeeId}::uuid
       AND k.idempotency_key = ${lookup.clientEventId}
     LIMIT 1
  `;
  let row = firstRow(byKey as unknown as { punched_at: Date | string; prior: number }[]);

  if (row === null) {
    const byInstant = await client`
      SELECT p.punched_at,
             (SELECT count(*)::integer
                FROM public.attendance_punches q
               WHERE q.employee_id = p.employee_id
                 AND q.effective_date = p.effective_date
                 AND q.is_voided = false
                 AND q.punched_at < p.punched_at) AS prior
        FROM public.attendance_punches p
       WHERE p.employee_id = ${matched.employeeId}::uuid
         AND p.kiosk_device_id = ${lookup.deviceId}::uuid
         AND p.is_voided = false
         AND p.punched_at = COALESCE(${lookup.punchedAtOverride}::timestamptz, p.punched_at)
       ORDER BY p.punched_at DESC
       LIMIT 1
    `;
    row = firstRow(byInstant as unknown as { punched_at: Date | string; prior: number }[]);
  }

  const prior = row?.prior ?? 0;
  return {
    matched: true,
    displayName: matched.displayName,
    employeeCode: matched.employeeCode,
    photoUrl: await signReferencePhoto(matched.photoPath),
    punchKind: prior === 0 ? "in" : prior === 1 ? "out" : "scan",
    istTime: istTime(row?.punched_at ?? nowIso()),
  };
}

interface MatchLogInput {
  id: string;
  attemptedAtOverride: string | null;
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
  /** From `metrics`, when the device sent it. Columns already exist on the table. */
  detectorScore: number | null;
  livenessScore: number | null;
  capturePhotoPath: string | null;
  latencyMs: number;
  producedPunchId: string | null;
  ip: string | null;
  appVersion: string | null;
  errorDetail: string | null;
}

/**
 * `secure.face_match_log` — the row that makes a disputed punch defensible.
 * `threshold_used` is pinned here so a later threshold change cannot rewrite
 * history, and `candidate_scores` never leaves the server.
 */
async function insertMatchLog(tx: Sql, input: MatchLogInput): Promise<string> {
  const round = (v: number | null): number | null => (v === null ? null : Number(v.toFixed(5)));
  const rows = await tx`
    INSERT INTO secure.face_match_log (
      id, attempted_at, kiosk_device_id, operator_id, candidate_set_size, outcome,
      matched_employee_id, best_distance, best_confidence,
      runner_up_employee_id, runner_up_distance, margin, candidate_scores,
      threshold_used, model_version, detector_score, liveness_score,
      capture_photo_path, latency_ms,
      produced_punch_id, ip, app_version, error_detail
    ) VALUES (
      ${input.id}::uuid,
      COALESCE(${input.attemptedAtOverride}::timestamptz, now()),
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
      ${round(input.detectorScore)}::numeric,
      ${round(input.livenessScore)}::numeric,
      ${input.capturePhotoPath}::text,
      ${Math.trunc(input.latencyMs)}::integer,
      ${input.producedPunchId}::uuid,
      ${input.ip}::inet,
      ${input.appVersion}::text,
      ${input.errorDetail}::text
    )
    RETURNING id
  `;
  return (rows as unknown as { id: string }[])[0]?.id as string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler — the 12-step lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

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

    // ── STEP 4 · Auth (model D+O) ─────────────────────────────────────────────
    // Raw bytes first: the HMAC covers exactly what was sent, so decoding and
    // re-serialising would break the signature.
    const rawBody = await readRawBody(req, { maxBytes: MAX_BODY_BYTES });
    const decoded = decodeJson(rawBody);
    const client = sqlHandle();
    const deviceAuth = await verifyDevice(req, rawBody, client);
    const device = deviceAuth.device;

    /*
      ── STEP 5 · Authority ──────────────────────────────────────────────────────
      THE GATE IS UNATTENDED. THE DEVICE IS THE AUTHORITY.

      `verifyDevice` above has already refused an unpaired, suspended, revoked or
      off-network device, checked the request HMAC against the device secret inside a
      120-second window, and burned the single-use nonce. That is the authority for a
      punch, and it is the whole of it.

      This used to branch on `kiosk_devices.require_operator`, demanding an open guard
      session when the row said true. The guard screen is gone from the terminal — there is
      no longer any way for a human to open a session at the gate — so branching on the row
      could only ever produce a device that refuses every punch it is handed. A flag whose
      true state is unreachable is not a control; it is a trap. Removed rather than left to
      be flipped, because a gate that cannot record attendance is the worst failure this
      endpoint has.

      The session is still ACCEPTED when one is presented. `face-enrol` and the admin tools
      mint operator sessions for their own flows and send them here, and when they do the
      punch is attributed to that operator exactly as before. Absent is now normal rather
      than exceptional, so `operator` is simply null and `recorded_by` with it.

      WHAT REPLACED THE GUARD IS BELOW, NOT NOWHERE: liveness is mandatory on every punch,
      unconditionally, and is enforced before the 1:N runs.
    */
    const operator = await requireOperatorSession(req, deviceAuth, client).catch(() => null);

    const deviceLog = log.child({
      device_id: device.id,
      device_code: device.deviceCode,
      operator_id: operator?.operatorId ?? null,
      clock_skew_seconds: deviceAuth.clockSkewSeconds,
    });

    // ── STEP 6 · Rate limit ───────────────────────────────────────────────────
    // One token for the request now (`kiosk.rate_scans_per_minute = 40`), the
    // rest of a batch charged after validation tells us how many scans it holds.
    // Outside any transaction on purpose: a refused call still spends its token.
    /*
      A REPLAY IS CHARGED TO ITS OWN BUCKET.

      Every item of a batch takes a token, and against the live 40/minute allowance that made
      draining an outage take minutes — 200 held punches could not clear in under five, and a
      large batch sent against an empty bucket was refused whole so the queue made no progress.

      The live limit exists to stop a device hammering the 1:N search. A replay is a different
      shape: bounded by a queue the device already holds, idempotent per `clientEventId`, and
      captured at human pace — the burst comes from the network returning, not from anybody
      scanning faster. So it gets a separate bucket at five times the rate, which is still a cap.

      The bucket is chosen BEFORE the body is parsed, so it is decided by the shape of the
      request rather than by anything the request asserts about itself.
    */
    const bucketKey = limitKey(FN_NAME, device.id);
    const looksLikeBatch = typeof decoded === "object" && decoded !== null &&
      Array.isArray((decoded as { queue?: unknown }).queue);
    const limit = looksLikeBatch ? RATE_LIMITS.kioskReplay : RATE_LIMITS.kioskPunch;
    const replayKey = looksLikeBatch ? limitKey(`${FN_NAME}-replay`, device.id) : bucketKey;
    if (!(await tryTake(limit, replayKey, client))) {
      throw tooMany(1_500, "Too many scans from this kiosk. Wait and retry.", "KIOSK_RATE_LIMITED");
    }

    // ── STEP 7 · Validate ─────────────────────────────────────────────────────
    const parsed = parse(PunchBody, decoded, "punch body");
    const isBatch = "queue" in parsed;
    const items: PunchItemInput[] = isBatch ? parsed.queue : [parsed];

    for (let i = 1; i < items.length; i++) {
      if (!(await tryTake(limit, replayKey, client))) {
        throw tooMany(
          1_500,
          "This offline batch is larger than the kiosk's remaining scan allowance. Retry in smaller batches.",
          "KIOSK_RATE_LIMITED",
        );
      }
    }

    // Duplicate client event ids inside one batch are a tablet bug, and the
    // second one would 23505 against the first in the same request.
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.clientEventId)) {
        throw unprocessable(
          [{ pointer: "/queue", code: "duplicate", detail: "clientEventId repeats inside the batch." }],
          "Each queued scan needs its own clientEventId.",
          "KIOSK_BATCH_DUPLICATE_EVENT_ID",
        );
      }
      seen.add(item.clientEventId);
    }

    // ── STEP 8 · Idempotency claim ────────────────────────────────────────────
    // Request level: a retried POST replays the stored answer. Item level: the
    // permanent guard is `attendance_punch_keys` (migration 050 §4), which is why
    // an overnight queue replay is still safe after this 24-hour claim expires.
    idempotencyKey = idempotencyKeyFrom(req) ??
      (isBatch ? `${FN_NAME}:${device.id}:${deviceAuth.nonce}` : (items[0] as PunchItemInput).clientEventId);
    const hash = await requestHash(FN_NAME, rawBody, device.id);
    const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: hash }, client);
    if (claimed.state === "replay") {
      status = claimed.status;
      deviceLog.info("idempotent replay", { key: idempotencyKey });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    // ── STEPS 9–10 · set_context + one transaction per scan, audit inside it ──
    const ctxBase: Omit<RequestContext, "reason"> = {
      actorId: null, // a kiosk is not a person; the operator is provenance, not the actor
      actorRole: null,
      source: "kiosk",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: device.id,
    };

    /*
      Resolved ONCE per request, before either branch — see `ProcessInput.livenessPass`.
      A batch judged by two different bars because the setting moved mid-flush would be a
      genuinely baffling audit trail.
    */
    const livenessPass = await resolveLivenessPass(client);
    const minDwellSeconds = await resolveMinDwellSeconds(client);

    let responseBody: unknown;
    if (!isBatch) {
      const result = await processPunch({
        item: items[0] as PunchItemInput,
        deviceAuth,
        operator,
        ctxBase,
        isReplay: false,
        log: deviceLog,
        client,
        livenessPass,
        minDwellSeconds,
      });
      responseBody = pickWhitelisted(result as unknown as Record<string, unknown>);
    } else {
      // Per item, in its own transaction: one bad scan in a queue of five must
      // not roll back the four that were fine, and the client needs a per-item
      // verdict to clear its IndexedDB queue (§8.1).
      const results: Record<string, unknown>[] = [];
      for (const item of items) {
        try {
          const result = await processPunch({
            item,
            deviceAuth,
            operator,
            ctxBase,
            isReplay: true,
            log: deviceLog,
            client,
            livenessPass,
        minDwellSeconds,
          });
          results.push(pickWhitelisted(result as unknown as Record<string, unknown>));
        } catch (itemErr) {
          const problem = toProblem(itemErr, requestId);
          if (problem.isServerFault) {
            // Never mark a queued item "done" on our own failure — let the
            // tablet keep it and retry (§4.5: any 5xx enqueues locally).
            throw itemErr;
          }
          deviceLog.warn("queued scan refused", {
            client_event_id: item.clientEventId,
            code: problem.code,
          });
          results.push(pickWhitelisted({
            matched: false,
            guardConfirmOptions: [],
            error: problem.code ?? "KIOSK_INTERNAL",
          }));
        }
      }
      responseBody = { results };
    }

    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ────────────────
    await store(idempotencyKey, status, responseBody, client);
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    if (idempotencyKey !== null) {
      try {
        // 5xx is not a deterministic answer: free the key so the tablet's retry
        // is processed for real rather than replaying our failure.
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
export { BatchBody, PunchBody, PunchItem };
