/**
 * attendance-self-punch — the employee's own "Login / Logout for the day" button.
 * Auth model **U+**: user JWT + the `attendance.punch.web` capability (resolved by
 * `app.has_cap()`, step-up decided by `role_capabilities.requires_step_up`) + the
 * per-employee entitlement on `public.employees`.
 *
 * THIS IS ATTENDANCE, NOT AUTHENTICATION. The client's words: "When the employee
 * is giving attendance / trying to log in for the day, there will be a Login
 * button in their portal. They click Login, show their face, the face is
 * recognized, location is registered, and attendance is taken. Same goes for the
 * outward also." The caller is ALREADY signed in — `face-login/index.ts` owns the
 * other thing (opening a session with a face). Nothing here mints a session.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 *   POST /functions/v1/attendance-self-punch
 *   headers  authorization: Bearer <user JWT>          (required)
 *            x-idempotency-key: <≥16 chars>            (required)
 *            content-type: application/json
 *
 *   body   { descriptor:  number[128],          L2-normalised, ‖d‖ = 1 ± 0.02
 *            metrics: { detectionScore:  number 0..1,          (required)
 *                       livenessScore?:  number 0..1,
 *                       livenessModel?:  string,
 *                       framesAnalysed?: integer 1..240 },
 *            geo?:    { latitude, longitude, accuracyMetres? },
 *            deviceId?: string,
 *            clientEventId: string ≥16 }         permanent per-punch dedup key
 *
 *   200    { direction:       'in' | 'out',
 *            punchedAt:       ISO-8601 instant (server clock, UTC),
 *            istTime:         'HH:MM:SS' IST,
 *            employeeName:    string,
 *            geofenceOk:      true | false | null,   null = not evaluated
 *            matchConfidence: number 0..1 (3 dp),
 *            message:         string,
 *            punchId:         uuid,
 *            needsReview:     boolean,
 *            day:             { status, firstInAt, lastOutAt, workedMinutes,
 *                               punchCount, isLate, lateMinutes } | null }
 *
 *   4xx    RFC 9457 problem+json (`_shared/errors.ts`), machine `code` per case.
 *
 * SEND THE SAME VALUE in `x-idempotency-key` and `clientEventId`. They guard
 * different windows and both are load-bearing: the header drives the 24-hour
 * response replay in `public.idempotency_keys` (lifecycle steps 8/11), the body
 * value lands in `attendance_punches.idempotency_key` whose companion table
 * `public.attendance_punch_keys` is a PERMANENT, cross-partition PK — so a RETRY
 * of one tap cannot make a second punch, this minute or next week.
 * `requireIdempotencyKey` rejects anything under 16 characters; use the uuid you
 * minted when the button was pressed.
 *
 * BE PRECISE ABOUT WHAT THAT DOES NOT COVER. A second TAP is a second
 * `clientEventId`, so neither key touches it — what catches it is the debounce
 * below, which is a SELECT and not a lock. It therefore holds only once the
 * first tap's transaction has committed (true for a human double-tap, whose
 * second capture ceremony takes seconds), and NOT for two genuinely simultaneous
 * requests from two tabs or two devices: under READ COMMITTED neither sees the
 * other's punch and both land live. `uq_attendance_punches__emp_instant_device`
 * does not help — it is partial on `kiosk_device_id IS NOT NULL`, and a web
 * punch has none. CLOSED: `writePunch` now takes a per-employee
 * `pg_advisory_xact_lock` as the first statement of its transaction, so the
 * debounce read and the insert are atomic with respect to each other. The lock is
 * transaction-scoped, needs no table, and is the only advisory lock taken here, so
 * it cannot deadlock.
 *
 * `message` is a plain-English fallback for a client that has nothing better.
 * i18n lives in `src/`, and this function may not touch it — so a screen should
 * compose its own copy from `direction`, `geofenceOk` and `needsReview` and treat
 * `message` as the last resort.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MATCHING IS 1:1, NOT 1:N — AND THAT CHANGES THE THRESHOLD
 * ─────────────────────────────────────────────────────────────────────────────
 * The caller's identity is already proved by the JWT, so the probe is compared
 * against exactly ONE template: that employee's. The distance expression is
 * `kiosk-punch`'s, character for character (exact sequential Euclidean distance
 * in Postgres, `1 − d/2` confidence from migration 012) — one metric for the
 * whole product, or distances from the gate and from the portal would not be
 * comparable in the same audit table.
 *
 * What does NOT carry over is the kiosk's *margin*. At the gate, safety comes
 * from two numbers: the best distance AND the gap to the runner-up
 * (`min_margin_for_auto_accept`), which is what stops a lookalike being waved
 * through. A 1:1 comparison has no runner-up, so there is no margin to lean on
 * and the distance ceiling has to carry the decision alone. The policy's
 * `min_confidence_for_auto_accept` (0.62 → distance ≤ 0.76) is far too loose to
 * do that by itself, so it becomes the FLOOR and spec-kiosk §3.3's
 * `T_review = 0.38` becomes the ceiling:
 *
 *     minConfidence = max(policy.min_confidence_for_auto_accept,
 *                         confidenceFor(attendance.face_review_threshold))
 *
 * That is the identical substitution `face-login/index.ts` documents for the
 * identical reason ("the STRICTEST wins"), and it means an HR policy row tuned to
 * keep a badly-lit queue moving can only ever make a self-punch stricter, never
 * looser. Buddy-punching is the threat model here — a signed-in employee holding
 * up someone else's photo — and a tight ceiling is the only defence that remains
 * once the margin is gone.
 *
 * Considered and rejected: run the kiosk's 1:N and then assert the winner is the
 * JWT holder, which would restore the margin. It would also read every enrolled
 * descriptor in the venue on every button press to answer a question the JWT has
 * already answered. 1:1 is ~N× cheaper and leaks nothing about anybody else.
 *
 * INV-4 / rule 7: every request whose descriptor is COMPARED to a template
 * writes a `secure.face_match_log` row before this function answers — accepted,
 * refused, debounced, replayed, low-quality, liveness-failed, consent-withdrawn,
 * not-enrolled. No biometric event is silently dropped, and `threshold_used` is
 * pinned on the row so a later threshold change cannot rewrite history.
 *
 * ONE case writes nothing, and it is named rather than glossed: a descriptor that
 * is not L2-normalised (STEP 9). Nothing was compared to anything, so there is no
 * biometric decision to defend — only a malformed request, which the problem
 * response and the invocation log already record.
 *
 * The raw descriptor is never logged, never echoed, never stored — `log.ts`
 * redacts the word `descriptor` anyway.
 *
 * DPDP: consent is checked BEFORE any distance is computed. The presence query
 * reads `secure.biometric_consents` and touches no descriptor; only if consent is
 * granted and un-withdrawn does the second query do arithmetic on the template.
 * A withdrawn consent is therefore not "a match that failed" — it is processing
 * that never happened.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DIRECTION IS DERIVED, AND THE COLUMN STAYS 'undetermined'
 * ─────────────────────────────────────────────────────────────────────────────
 * The client never says whether this is an in or an out — a client-supplied
 * direction is forgeable, and forging it would move somebody's worked minutes.
 * It is derived from the punch log for the employee's own business date, from the
 * same count `kiosk-punch` derives its `punchKind` from: the live (non-voided)
 * punches already on that `effective_date` before this instant. An even count
 * means no open 'in', so this is an 'in'; an odd count means an 'in' is open, so
 * this is the 'out'.
 *
 * The count is the same; the mapping is NOT. `kiosk-punch` answers a gate
 * tablet, so it reports 'in' for the first scan, 'out' for the second and 'scan'
 * for every one after that — a guard does not need to know which half of a lunch
 * break he is watching. This screen belongs to the employee, who does, so the
 * PARITY of the count is used instead and a multi-punch day reads in/out/in/out.
 * `src/features/attendance/api/selfPunch.api.ts:fetchSelfPunchState` predicts the
 * button's label from the same parity, so the prediction and this answer agree.
 *
 * The `direction` COLUMN is nevertheless written `'undetermined'`, the same value
 * the kiosk writes, and that is deliberate. `compute_attendance_day` derives
 * breaks from *interior* gaps whose two endpoint punches are BOTH
 * `'undetermined'` (migration 018 §7, break rule §7.4). Stamping 'in'/'out' on
 * these rows would silently switch a multi-punch employee's lunch break from
 * "the gap we measured" to "the shift's default unpaid break" — a payroll change,
 * introduced by a cosmetic column. So the derived direction is returned to the
 * screen (where it is what the employee wants to read) and the engine keeps the
 * shape it computes from. The ordinal is recomputable from the log at any time,
 * which is precisely what the engine does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GEOFENCE — RECORDED, AND NEVER SILENT EITHER WAY
 * ─────────────────────────────────────────────────────────────────────────────
 *   NO COORDINATES                          → REFUSED. See below.
 *   accuracy coarser than 2 km              → REFUSED (an IP-derived fix, not a location)
 *   coordinates + a location with lat/lng   → `geofence_ok` = (distance ≤ radius)
 *   outside the fence                       → RECORDED, geofence_ok = false,
 *                                             needs_review = true
 *   location has no lat/lng configured      → geofence_ok = NULL (not evaluated)
 *   accuracy wider than the fence           → needs_review = true, whatever the
 *                                             comparison said
 *
 * THE FIRST TWO LINES ARE NEW AND THEY REVERSE WHAT THIS FILE USED TO DO. Coordinates were
 * optional and a refusal produced `geofence_ok = NULL`, which the rest of this comment defends
 * at length as "honest". It is honest, and it was still the wrong trade for a SELF-punch: this
 * is the one route where nobody saw the person arrive, so the location is not metadata about the
 * punch, it is the only evidence the punch happened anywhere in particular. The venue asked for
 * it to be mandatory off the back of that.
 *
 * Refusing is not the same as dropping a punch, and INV-9 still holds. A dropped punch is work
 * that cannot be proven; a refused REQUEST is an employee who is told, on screen, to turn
 * location on and tap again. Nothing is lost, and the fix is in their hands.
 *
 * A punch outside the fence is never dropped (INV-9: losing the punch is a person
 * who cannot prove they came to work) and never accepted as if it were inside.
 * NULL is honest: `public.locations.lat/lng` are NULL on the seeded venue on
 * purpose — migration 046: "venue lat/lng are captured on site; geofence_ok is
 * recorded, not enforced, until then" — so a NULL here means "nobody has told this
 * system where the venue is", not "the employee refused".
 *
 * The last rule is a FLAG, not a downgrade to NULL, and the difference is worth
 * stating because it is tempting to read it the other way. A ±800 m urban fix
 * cannot resolve a 300 m fence, so `geofence_ok` computed from it is a comparison
 * whose inputs are wider than its answer — but it is still the comparison the
 * device reported, and it is kept: a fix 5 km out is evidence even at ±800 m, and
 * nulling it would throw that away. `location_accuracy_m` is on the same row, so
 * a reviewer can always see how much the verdict is worth, and
 * `needs_review = true` guarantees a human looks. What is NOT done is presenting
 * such a punch as an unqualified success.
 *
 * `restrict_punch_to_venue_ip` is honoured the same way. That column is
 * `NOT NULL DEFAULT true` on every employee, and until now nothing read it,
 * because the venue's networks are written down nowhere: `allowed_ip_cidrs`
 * exists only on `kiosk_devices`. This function reads a new
 * `attendance.venue_ip_cidrs` setting, seeded EMPTY — so nothing is enforced
 * today, exactly like the geofence — and when HR fills it in, a self-punch from
 * outside those networks is FLAGGED (`needs_review`), never refused. Same
 * principle as the fence, and the IP is on every punch row regardless, so the
 * evidence exists either way. A malformed setting value degrades to "not
 * evaluated" rather than blocking attendance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS AN EDGE FUNCTION AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * `public.attendance_punches` grants INSERT to `service_role` only, is append-only
 * by trigger, and is partitioned by `punched_at`. `authenticated` holds SELECT and
 * nothing else. There is no browser write path by design (migration 016 header),
 * so every punch must come through here. `business_date` is left NULL for
 * `trg_attendance_punches__business_date` to resolve from the shift, and
 * `ist_date`/`ist_time`/`effective_date` are GENERATED — nothing in this file
 * computes them.
 *
 * LIVENESS IS ADVISORY HERE, and that is a deliberate difference from the kiosk.
 * The only signal in this build is a frame-MOTION heuristic; the capture guidance
 * says "hold still" (stillness is what a sharp descriptor needs), so following the
 * instructions LOWERS the motion score. A hard refusal would therefore reject
 * compliant employees as spoofs. The score, its model name and the frame count are
 * written to `secure.face_match_log` either way, and a low or absent score adds a
 * review note — so the evidence a spoofing investigation reads is unchanged; only
 * the outcome for the employee differs. The gate scanner keeps the strict gate,
 * because a guard can ask a person to move and a stranger is the threat there.
 *
 * `compute_attendance_day` is then called SYNCHRONOUSLY inside the same
 * transaction, as `decide_regularization` does, so the employee's own screen can
 * show the updated day in this one round trip. The `trg_attendance_punches__enqueue`
 * trigger's queued pass is a harmless idempotent repeat.
 *
 * ONE exception, and it is why the lock is pre-checked: `compute_attendance_day`
 * RAISES SQLSTATE 55006 on a HARD-locked date. Inside this transaction that raise
 * would roll back the punch as well, and "an admin locked the period" must never
 * become "nobody can record that they came to work". So a hard lock covering the
 * punch's business date is detected first and the synchronous recompute is
 * skipped; the punch is still written, and the day's totals follow when the lock
 * is lifted. A SOFT lock needs nothing — the engine returns the existing row.
 *
 * AUDIT: `attendance_punches` is deliberately NOT audit-trigger-attached
 * (migration 038: "its insert IS the audit record; voids are audited by the
 * void-punch path"), so this function writes no `audit_log` row. The punch row
 * plus its `face_match_log` row IS the evidence trail. The write still goes
 * through `withContext()` because `compute_attendance_day` writes
 * `public.attendance_days`, which IS in `audit.reason_required_tables` and whose
 * audit trigger demands `app.reason` — a bare PostgREST insert cannot set it
 * (`set_config(…, true)` is transaction-scoped), which is the failure
 * `auth-session-record`'s header describes.
 *
 * WHAT THIS FUNCTION DOES NOT DO
 *   * No photo. The kiosk stores a capture because a guard-operated gate needs
 *     one; a self-punch already carries a session, and storing a selfie per punch
 *     is personal data this feature does not need. `photo_path` stays NULL.
 *   * No enrolment. If the employee has no active template the answer is a 409
 *     that says so, and `face-enrol` owns the fix.
 *   * No voiding. `void-punch` owns that half.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { conflict, forbidden, methodNotAllowed, ok, toProblem, unprocessable } from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger, type Logger } from "../_shared/log.ts";
import { istTime, toIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql as sqlHandle,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { type AuthContext, requireCapWithStepUp, verifyUser } from "../_shared/auth.ts";
import {
  evaluateGeofence as evaluateCircle,
  haversineMetres as haversine,
  type PunchGeo,
} from "../_shared/geofence.ts";
import { enforce, limitKey, type RateLimitSpec } from "../_shared/ratelimit.ts";
import {
  claim,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";
import type { Sql } from "../_shared/deps.ts";

const FN_NAME = "attendance-self-punch";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** The capability seeded by migration 050 for the employee role. */
const CAP_PUNCH_WEB = "attendance.punch.web";

/** 128 floats + metrics + geo is ~4 KB. No photo travels through this endpoint. */
const MAX_BODY_BYTES = 32 * 1024;

const DESCRIPTOR_DIM = 128;
/** spec-kiosk §10: the descriptor is L2-normalised on-device; the server checks it. */
const DESCRIPTOR_NORM_TOLERANCE = 0.02;
/** Maximum Euclidean distance between two unit vectors — the confidence denominator. */
const MAX_UNIT_DISTANCE = 2;

/** `attendance_policies` column defaults (migration 014), for when no policy resolves. */
const DEFAULT_MIN_CONFIDENCE = 0.62;
const DEFAULT_DEBOUNCE_SECONDS = 120;
/** spec-kiosk §3.3 `T_review = 0.38` — the accept CEILING here; see the header. */
const DEFAULT_REVIEW_DISTANCE = 0.38;
/** spec-kiosk §1.2 `attendance.liveness_pass_threshold`. */
const DEFAULT_LIVENESS_PASS = 0.7;
/** spec-kiosk §1.1, scan column: detector confidence ≥ 0.60. */
const DEFAULT_MIN_DETECTION_SCORE = 0.6;
/** spec-kiosk §1: enrolment and probe must agree or distances are meaningless. */
const DEFAULT_DESCRIPTOR_MODEL = "faceapi-rn34-128d-v1";

/**
 * Statuses at which a person may record their own attendance. Identical to
 * `kiosk-punch`'s set on purpose: someone who turns up for work is a fact HR
 * needs whichever door they used, and the two paths disagreeing about who may
 * punch would be a bug waiting to be found by an employee, not by us.
 */
const PUNCHABLE_STATUSES: ReadonlySet<string> = new Set([
  // `pre_joining` included — see `kiosk-punch`'s note. It is the wizard's DEFAULT, so excluding
  // it silently blocked every employee added through the app from punching at all.
  "pre_joining",
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "rehired",
  "on_long_leave",
  "absconding",
]);
/** Punchable, but every punch is flagged (`kiosk-punch`'s list, same reasoning). */
const REVIEW_STATUSES: ReadonlySet<string> = new Set(["on_long_leave", "absconding", "on_notice"]);

/**
 * Per-actor, not per-IP: the caller is authenticated, so the actor IS the bucket
 * key. 10 attempts of burst, then one a minute. Loose enough for a genuine retry
 * in bad light, tight enough that a stolen session cannot hill-climb a threshold
 * with thousands of probes. `RATE_LIMITS.mutation` (60/minute) is an order of
 * magnitude too generous for a biometric surface, which is the same judgement
 * `face-login` records about `RATE_LIMITS.webauthn`.
 */
const LIMIT_SELF_PUNCH: RateLimitSpec = {
  bucket: "attendance_self_punch",
  capacity: 10,
  refillPerMinute: 1,
};

/** Mobile user agents, for `source` only — never for an authorisation decision. */
const MOBILE_UA_RE = /android|iphone|ipad|ipod|iemobile|blackberry|opera mini|windows phone|mobile safari/i;

// The earth radius moved with the haversine into `_shared/geofence.ts`. Keeping a
// second copy here is how two functions end up measuring the same fence
// differently.

// ═══════════════════════════════════════════════════════════════════════════════
// Request contract
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The on-device numbers this server gates on. `detectionScore` is required
 * because a capture too poor to trust must be refused rather than recorded as a
 * fact. `livenessScore` is optional in the wire contract — but an OPTIONAL FIELD
 * IS NOT AN OPTIONAL GATE: when the resolved policy or the global
 * `kiosk.require_liveness` setting demands liveness and no score arrives, the
 * punch is still recorded and flagged `needs_review` with
 * `liveness_not_attested` on its match-log row. A score that arrives BELOW the
 * threshold is different in kind — that is positive evidence of a spoof, and it
 * is refused outright, as `face-login` refuses it.
 */
const ProbeMetrics = z
  .object({
    /** `detection.score` from TinyFaceDetector. */
    detectionScore: z.number().finite().min(0).max(1),
    /** spec-kiosk §1.2 `liveness.passive_score`. */
    livenessScore: z.number().finite().min(0).max(1).optional(),
    /** e.g. `heuristic-v1`. Recorded in the match log's `error_detail` context. */
    livenessModel: z.string().trim().min(1).max(64).optional(),
    framesAnalysed: z.number().int().min(1).max(240).optional(),
  })
  .strict();

/**
 * Browser geolocation. Bounds validated, never trusted, and now REQUIRED.
 *
 * `accuracyMetres` keeps its own ceiling separate from the 100 km bound that merely rejects
 * nonsense. A browser with location "enabled" can still hand back an IP-derived fix accurate to
 * tens of kilometres, which satisfies the letter of the requirement and answers nothing — the
 * whole point of demanding a location is to know whether somebody was at the venue. A GPS or
 * wifi fix indoors is typically under 100 m; an IP fix is 5-50 km. `MAX_ACCURACY_M` sits far
 * above the first and far below the second, so a real fix taken in a basement still passes.
 */
const MAX_ACCURACY_M = 2_000;

/**
 * The shortest reason the venue accepts for an off-hours punch.
 *
 * Also enforced by `ck_ap__approval_reason` on the table, so no other write path can create an
 * unexplained one, and by the client so the box says so before anybody submits.
 */
const MIN_OFF_HOURS_REASON = 15;

const Geo = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMetres: z.number().nonnegative().max(100_000).optional(),
  })
  .strict();

const SelfPunchBody = z
  .object({
    /** L2-normalised 128-D probe. Never logged, never stored, never echoed. */
    descriptor: z
      .array(z.number().finite())
      .length(DESCRIPTOR_DIM, `Expected ${DESCRIPTOR_DIM} floats.`),
    metrics: ProbeMetrics,
    /*
      MANDATORY. It was `.optional()`, and the header above documented "no coordinates shared →
      geofence_ok = NULL (not evaluated)" as a supported outcome. The venue's decision is that a
      punch taken away from the gate must say where it was taken: a self-punch is the one route
      where nobody watched the person arrive, so the coordinates ARE the evidence, and an
      optional field meant the evidence was optional. Refusing at the schema is what makes it
      impossible to store a locationless self-punch, rather than merely discouraged.

      The KIOSK is untouched — that is `kiosk-punch`, a different function, where a guard and a
      fixed camera at a known gate already establish the place.
    */
    geo: Geo,
    /**
     * Why this punch is being taken outside the shift window.
     *
     * REQUIRED when it is, and ignored when it is not. 15 characters is the venue's floor and
     * is enforced here, in `ck_ap__approval_reason`, and in the client — three layers, because
     * the point of the reason is that somebody reads it months later and can tell what
     * happened. "wfh" cannot do that.
     */
    reason: z.string().trim().max(500).optional(),
    /**
     * A photograph or screenshot supporting an off-hours punch — a `documents` row of type
     * ATTENDANCE_PROOF that the client has already uploaded.
     *
     * ── OPTIONAL HERE, MANDATORY ON THE FORM, AND THAT IS DELIBERATE ─────────
     * The venue's instruction was "mandatory, they should attach, and while checking out also
     * it's mandatory". The form enforces exactly that: an off-hours punch cannot be submitted
     * without a picture.
     *
     * The SERVER does not refuse one that arrives without it. This venue has already lost
     * attendance to a hard gate — employees hit the reason requirement, decided the app was
     * broken and stopped punching: "they thought okay, it's not working, so let's attend like
     * that only." An upload failing on a weak signal at 9 pm must cost a review, not a day's
     * work. So a proofless off-hours punch is RECORDED AND FLAGGED, and lands in the same
     * approval queue with the absence stated on it.
     *
     * Not validated against `documents` here: the row is written under the employee's own RLS
     * insert policy before this call, and `attendance_punches_proof_document_id_fkey` refuses an id that does not
     * exist. A second existence check in TypeScript would be a second thing to keep in step.
     */
    proofDocumentId: z.string().uuid().optional(),
    /** Stable per-browser id the app generates; provenance, not an identifier. */
    deviceId: z.string().trim().min(8).max(128).optional(),
    /** Minted when the button was pressed; the permanent per-punch dedup key. */
    clientEventId: common.idempotencyKey,
  })
  .strict();

type SelfPunchInput = z.infer<typeof SelfPunchBody>;

// ═══════════════════════════════════════════════════════════════════════════════
// Response contract
// ═══════════════════════════════════════════════════════════════════════════════

export type PunchDirection = "in" | "out";

interface DaySnapshot {
  status: string | null;
  firstInAt: string | null;
  lastOutAt: string | null;
  workedMinutes: number | null;
  punchCount: number | null;
  isLate: boolean | null;
  lateMinutes: number | null;
}

interface SelfPunchResult {
  direction: PunchDirection;
  punchedAt: string;
  istTime: string;
  employeeName: string;
  geofenceOk: boolean | null;
  /**
   * Returned even though `kiosk-punch` never returns a confidence: there, the
   * reader is a tablet that must learn nothing about anybody (INV-8). Here the
   * reader IS the data subject, and how well their own face matched is a fact
   * about them that DPDP transparency favours disclosing. The raw DISTANCE, the
   * threshold and every other employee's data still stay server-side, and the
   * value is rounded to 3 dp so it cannot be used to hill-climb a spoof.
   */
  matchConfidence: number;
  message: string;
  punchId: string;
  needsReview: boolean;
  /**
   * True when this punch was outside the shift window, so it carries a reason and waits for an
   * administrator. The hours show on the day regardless; they stay out of the monthly total
   * until somebody accepts the reason.
   */
  requiresApproval: boolean;
  /** NULL only when a hard lock deferred the recompute. */
  day: DaySnapshot | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Postgres array literal. Sent as text and cast, so no driver type inference. */
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
 * Distance in metres between two WGS-84 points. Haversine: no PostGIS here.
 *
 * The implementation moved to `_shared/geofence.ts` when `kiosk-punch` needed the
 * same maths. It is re-exported rather than deleted so this module's public
 * surface is unchanged — and so there is exactly ONE definition of the distance,
 * instead of a copy in each function that could drift on a constant.
 */
export const haversineMetres = haversine;

function numOr(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolOr(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return fallback;
}

/** `numeric` arrives from postgres.js as a string; `null` stays `null`. */
function numOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Rounding for a nullable SQL parameter. */
function round(value: number | null, dp: number): number | null {
  return value === null ? null : Number(value.toFixed(dp));
}

/** Rounding for a value that is known to exist (response fields). */
function fixed(value: number, dp: number): number {
  return Number(value.toFixed(dp));
}

/**
 * An IPv4/IPv6 address or CIDR block, loosely. The point is not to be a parser —
 * Postgres is — but to make sure a hand-typed setting value cannot reach an
 * `::inet` cast as arbitrary text and abort the statement that reads it.
 */
const CIDR_LIKE_RE = /^[0-9a-fA-F:.]{2,45}(\/\d{1,3})?$/;

/**
 * `attendance.venue_ip_cidrs` → a validated list. Anything unparseable reads as
 * EMPTY, which means "not configured, not enforced" — the same answer as an
 * absent setting. A typo in an admin screen must never stop an employee
 * recording that they came to work.
 */
export function parseVenueCidrs(raw: string | null, log: Logger): string[] {
  if (raw === null || raw.trim() === "") return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    log.warn("attendance.venue_ip_cidrs is not valid JSON; venue-IP check not evaluated");
    return [];
  }
  if (!Array.isArray(decoded)) {
    log.warn("attendance.venue_ip_cidrs is not a JSON array; venue-IP check not evaluated");
    return [];
  }
  const out: string[] = [];
  for (const entry of decoded) {
    if (typeof entry === "string" && CIDR_LIKE_RE.test(entry.trim())) out.push(entry.trim());
    else log.warn("attendance.venue_ip_cidrs holds an entry that is not an address or block");
  }
  return out;
}

/** Postgres text-array literal with every element quoted. */
function toPgQuotedArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/["\\]/g, "")}"`).join(",")}}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Refusals — one per state, each naming the action that fixes it
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The entitlement is OFF. This is an HR CONFIGURATION STATE, not an error and not
 * a security event: the employee did nothing wrong and there is nothing they can
 * retry. 403 with a code the screen can switch on, and copy that names who turns
 * it on.
 */
function entitlementOff(): never {
  throw forbidden(
    "Marking your own attendance from the portal is not switched on for you yet. " +
      "Ask HR to enable web punch on your employee record, or use the gate tablet.",
    "SELF_PUNCH_NOT_ENTITLED",
  );
}

function faceNotEnrolled(): never {
  throw conflict(
    "Your face is not enrolled yet, so there is nothing to check this against. " +
      "Ask HR to enrol you, then use this button.",
    "SELF_PUNCH_FACE_NOT_ENROLLED",
  );
}

function biometricConsentMissing(): never {
  throw conflict(
    "You withdrew consent for face recognition, so your face cannot be checked. " +
      "Give consent again, or mark attendance at the gate tablet instead.",
    "SELF_PUNCH_BIOMETRIC_CONSENT_REQUIRED",
  );
}

function faceNotConfirmed(): never {
  throw unprocessable(
    [{
      pointer: "/descriptor",
      code: "not_confirmed",
      detail: "This face did not match the one enrolled for your record.",
    }],
    "We couldn't confirm it's you. Try again facing the camera in better light, " +
      "or mark attendance at the gate tablet.",
    "SELF_PUNCH_FACE_NOT_CONFIRMED",
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// The subject: entitlement, employment, venue
// ═══════════════════════════════════════════════════════════════════════════════

interface SubjectRow {
  employee_id: string;
  employee_code: string;
  display_name: string;
  employment_status: string;
  exclude_from_attendance: boolean;
  allow_web_punch: boolean;
  allow_mobile_selfie_punch: boolean;
  restrict_punch_to_venue_ip: boolean;
  department_id: string | null;
  location_id: string | null;
  location_lat: string | null;
  location_lng: string | null;
  geofence_radius_m: number | null;
}

interface Subject {
  employeeId: string;
  employeeCode: string;
  displayName: string;
  employmentStatus: string;
  restrictToVenueIp: boolean;
  departmentId: string | null;
  locationId: string | null;
  locationLat: number | null;
  locationLng: number | null;
  geofenceRadiusM: number | null;
}

/**
 * Read the caller's own employee row and refuse every state that must not produce
 * a punch. Ordered cheapest-and-most-actionable first, and all of it BEFORE any
 * biometric processing: someone who is not entitled to self-punch should not have
 * their face compared to anything.
 */
async function loadSubject(client: Sql, auth: AuthContext): Promise<Subject> {
  if (auth.employeeId === null) {
    // A profile with no employee record (a pre-joining account). Nothing to
    // attribute a punch to, and no amount of retrying changes that.
    throw forbidden(
      "Your account is not linked to an employee record yet, so attendance cannot be recorded against it.",
      "SELF_PUNCH_NO_EMPLOYEE_RECORD",
    );
  }

  const rows = await client`
    SELECT e.id                       AS employee_id,
           e.employee_code            AS employee_code,
           e.display_name             AS display_name,
           e.employment_status::text  AS employment_status,
           e.exclude_from_attendance  AS exclude_from_attendance,
           e.allow_web_punch          AS allow_web_punch,
           e.allow_mobile_selfie_punch AS allow_mobile_selfie_punch,
           e.restrict_punch_to_venue_ip AS restrict_punch_to_venue_ip,
           e.department_id            AS department_id,
           -- e.location_id, NOT l.id: the lock pre-check below must ask the SAME
           -- question compute_attendance_day asks (l.location_id = e.location_id).
           -- A soft-deleted venue row makes l.id NULL while the employee is still
           -- attached to it, which would hide a location-scoped HARD lock from the
           -- pre-check and let the engine raise 55006 inside the punch
           -- transaction, rolling the punch back with it.
           e.location_id              AS location_id,
           l.lat                      AS location_lat,
           l.lng                      AS location_lng,
           l.geofence_radius_m        AS geofence_radius_m
      FROM public.employees e
      LEFT JOIN public.locations l
             ON l.id = e.location_id
            AND l.deleted_at IS NULL
     WHERE e.id = ${auth.employeeId}::uuid
       AND e.deleted_at IS NULL
     LIMIT 1
  `;
  const row = firstRow(rows as unknown as SubjectRow[]);
  if (row === null) {
    throw forbidden(
      "Your employee record could not be read, so attendance cannot be recorded against it.",
      "SELF_PUNCH_NO_EMPLOYEE_RECORD",
    );
  }

  // THE ENTITLEMENT. `allow_web_punch OR allow_mobile_selfie_punch` — either one
  // is permission to mark your own attendance. The pair is not enforced
  // per-channel because the only thing that could tell the channels apart is the
  // User-Agent, which the caller controls: an employee holding one of the two
  // flags could flip which one is demanded by editing a header, so a per-channel
  // check would be a control in appearance only. The flags decide WHETHER, the
  // user agent only LABELS the `source` column, which is a recorded fact.
  if (row.allow_web_punch !== true && row.allow_mobile_selfie_punch !== true) {
    entitlementOff();
  }

  if (row.exclude_from_attendance === true) {
    // `compute_attendance_day` returns NULL for these employees — attendance is
    // not tracked for them at all, so a punch would be an event nothing reads.
    throw forbidden(
      "Attendance is not tracked for your record, so there is nothing to mark. Ask HR if you think that is wrong.",
      "SELF_PUNCH_ATTENDANCE_NOT_TRACKED",
    );
  }

  if (!PUNCHABLE_STATUSES.has(row.employment_status)) {
    throw forbidden(
      "Your employment status does not allow attendance to be recorded. Please contact HR.",
      "SELF_PUNCH_EMPLOYEE_INACTIVE",
    );
  }

  return {
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
    displayName: row.display_name,
    employmentStatus: row.employment_status,
    restrictToVenueIp: row.restrict_punch_to_venue_ip === true,
    departmentId: row.department_id,
    locationId: row.location_id,
    locationLat: numOrNull(row.location_lat),
    locationLng: numOrNull(row.location_lng),
    geofenceRadiusM: row.geofence_radius_m === null ? null : Number(row.geofence_radius_m),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Server-owned configuration
// ═══════════════════════════════════════════════════════════════════════════════

interface PunchConfig {
  descriptorModel: string;
  /** Accept ceiling in DISTANCE terms (spec-kiosk §3.3 `T_review`). */
  reviewDistance: number;
  livenessPass: number;
  minDetectionScore: number;
  /** Liveness is mandatory when the policy OR the global setting says so. */
  livenessRequired: boolean;
  /**
   * `attendance_policies.allow_web_punch` for the policy resolved for this
   * employee today. SEPARATE from `employees.allow_web_punch`: the employee
   * column is a per-person exception, this one is the policy the venue set. Both
   * must be true — an HR configuration is not overridden by a per-person flag.
   */
  policyAllowsWebPunch: boolean;
  /** The effective confidence floor for THIS employee — see the header. */
  minConfidence: number;
  debounceSeconds: number;
  venueCidrs: string[];
}

/**
 * Settings + the employee's resolved `attendance_policies` row, in one round trip.
 * `LEFT JOIN LATERAL … ON true` so an employee with no policy assignment still
 * yields a row and falls back to migration 014's column defaults, exactly as the
 * engine does when `resolve_policy` finds nothing.
 */
async function loadConfig(client: Sql, employeeId: string, log: Logger): Promise<PunchConfig> {
  const rows = await client`
    SELECT app.setting('kiosk.descriptor_model')                     AS descriptor_model,
           app.setting('attendance.face_review_threshold')           AS review_threshold,
           app.setting('attendance.liveness_pass_threshold')         AS liveness_pass,
           app.setting('attendance.face_punch_min_detection_score')  AS min_detection_score,
           app.setting('kiosk.require_liveness')                     AS require_liveness,
           app.setting('kiosk.debounce_seconds')                     AS debounce_seconds,
           app.setting('attendance.venue_ip_cidrs')                  AS venue_ip_cidrs,
           pol.min_confidence_for_auto_accept                        AS policy_min_confidence,
           pol.punch_debounce_seconds                                AS policy_debounce_seconds,
           pol.require_liveness                                      AS policy_require_liveness,
           pol.allow_web_punch                                       AS policy_allow_web_punch
      FROM (SELECT 1) d
      LEFT JOIN LATERAL (
        SELECT ap.min_confidence_for_auto_accept,
               ap.punch_debounce_seconds,
               ap.require_liveness,
               ap.allow_web_punch
          FROM public.attendance_policies ap
         WHERE ap.id = public.resolve_policy('attendance_policy', ${employeeId}::uuid, util.ist_today())
           AND ap.deleted_at IS NULL
         LIMIT 1
      ) pol ON true
  `;
  const row = firstRow(rows as unknown as Record<string, unknown>[]);

  const reviewDistance = numOr(
    (row?.review_threshold as string | null) ?? null,
    DEFAULT_REVIEW_DISTANCE,
  );
  const policyMinConfidence = numOr(
    (row?.policy_min_confidence as string | null) ?? null,
    DEFAULT_MIN_CONFIDENCE,
  );
  const settingDebounce = numOr(
    (row?.debounce_seconds as string | null) ?? null,
    DEFAULT_DEBOUNCE_SECONDS,
  );
  const policyDebounce = row?.policy_debounce_seconds ?? null;

  return {
    descriptorModel: (row?.descriptor_model as string | null) ?? DEFAULT_DESCRIPTOR_MODEL,
    reviewDistance,
    livenessPass: numOr((row?.liveness_pass as string | null) ?? null, DEFAULT_LIVENESS_PASS),
    minDetectionScore: numOr(
      (row?.min_detection_score as string | null) ?? null,
      DEFAULT_MIN_DETECTION_SCORE,
    ),
    // Strictest wins, in both directions: a policy row that switched liveness off
    // cannot switch it off globally, and vice versa.
    livenessRequired: row?.policy_require_liveness === true ||
      boolOr((row?.require_liveness as string | null) ?? null, true),
    // No policy row resolved → nothing has forbidden web punching, so this is not
    // the place to invent a refusal; the per-employee entitlement already gates it.
    policyAllowsWebPunch: (row?.policy_allow_web_punch as boolean | null) !== false,
    // THE substitution the header argues for: the policy floor, raised to
    // T_review because a 1:1 comparison has no margin to fall back on.
    minConfidence: Math.max(policyMinConfidence, confidenceFor(reviewDistance)),
    debounceSeconds: policyDebounce === null ? settingDebounce : Number(policyDebounce),
    venueCidrs: parseVenueCidrs((row?.venue_ip_cidrs as string | null) ?? null, log),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// The 1:1 confirmation
// ═══════════════════════════════════════════════════════════════════════════════

interface TemplateRow {
  template_id: string;
  model_version: string;
  descriptor_dim: number;
  consent_ok: boolean | null;
}

/**
 * Does this employee have a template that may lawfully be used? Reads presence,
 * dimension and CONSENT, and touches no descriptor — DPDP first, arithmetic
 * second. `uq_face_templates__employee_active` guarantees at most one active row.
 */
async function loadTemplate(client: Sql, employeeId: string): Promise<TemplateRow | null> {
  const rows = await client`
    SELECT t.id                                   AS template_id,
           t.model_version                        AS model_version,
           t.descriptor_dim                       AS descriptor_dim,
           (c.granted AND c.withdrawn_at IS NULL) AS consent_ok
      FROM secure.face_templates t
      LEFT JOIN secure.biometric_consents c
             ON c.id = t.consent_id
     WHERE t.employee_id = ${employeeId}::uuid
       AND t.is_active
       AND t.purged_at IS NULL
     LIMIT 1
  `;
  return firstRow(rows as unknown as TemplateRow[]);
}

/**
 * THE NEAREST of this employee's enrolled samples. The expression is kiosk-punch's
 * character for character — exact sequential Euclidean distance in Postgres, not in the
 * isolate, so the gate and the portal produce comparable numbers in the same audit table and
 * the arithmetic is never probabilistic (spec-kiosk §3.1).
 *
 * ── WHY ALL THE SAMPLES, AND WHY IT IS FREE OF RISK HERE ─────────────────────
 * Enrolment stores five samples per employee and nominates one — the medoid — as the single
 * is_active row. This measured against that row alone, so four fifths of what was captured has
 * been unused since it was recorded. Leave-one-out over all 365 stored samples: genuine
 * distance median 0.1849 to 0.1614, p90 0.2670 to 0.2424.
 *
 * On this endpoint it cannot cost anything. The punch is 1:1 — the session already establishes
 * WHO this is, and the face only confirms it — so there is no runner-up, no margin and no
 * lookalike to defend against. The only effect of taking the minimum is that a true owner
 * photographed at a slightly different angle stops being turned away.
 *
 * The template the winning distance came from is returned too, because face_match_log records
 * it and "which sample recognised them" is exactly what a later investigation needs.
 */
async function bestSampleDistance(
  client: Sql,
  employeeId: string,
  descriptor: readonly number[],
): Promise<{ distance: number; templateId: string } | null> {
  const rows = await client`
    WITH probe AS (SELECT ${toPgRealArray(descriptor)}::real[] AS d),
    /*
      Scoped to the version of the row that is ACTIVE, so a superseded enrolment cannot answer.
      Re-enrolling replaces the whole set the moment the new medoid becomes active.
    */
    eligible AS (
      SELECT t.id, t.descriptor
        FROM secure.face_templates t
       WHERE t.employee_id = ${employeeId}::uuid
         AND t.purged_at IS NULL
         AND EXISTS (
           SELECT 1 FROM secure.face_templates a
            WHERE a.employee_id = t.employee_id
              AND a.version = t.version
              AND a.is_active
              AND a.purged_at IS NULL
         )
    )
    SELECT t.id AS template_id,
           sqrt(sum(power(x.a::double precision - x.b::double precision, 2)))::numeric(8,5) AS distance
      FROM probe p
      CROSS JOIN eligible t
      CROSS JOIN LATERAL unnest(t.descriptor, p.d) AS x(a, b)
     GROUP BY t.id
     ORDER BY distance ASC
     LIMIT 1
  `;
  const row = firstRow(rows as unknown as { distance: string; template_id: string }[]);
  return row === null ? null : { distance: Number(row.distance), templateId: row.template_id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// secure.face_match_log — written for EVERY attempt (INV-4, rule 7)
// ═══════════════════════════════════════════════════════════════════════════════

/** The subset of `ck_face_match_log__outcome` this endpoint can reach. */
type MatchOutcome =
  | "matched"
  | "no_match"
  | "liveness_failed"
  | "low_quality"
  | "duplicate_suppressed"
  | "error";

interface MatchLogInput {
  id: string;
  /** 1 when a template was compared, 0 when there was nothing to compare against. */
  candidateSetSize: number;
  outcome: MatchOutcome;
  matchedEmployeeId: string | null;
  bestDistance: number | null;
  bestConfidence: number | null;
  thresholdUsed: number;
  modelVersion: string;
  detectorScore: number | null;
  livenessScore: number | null;
  latencyMs: number;
  producedPunchId: string | null;
  ip: string | null;
  errorDetail: string | null;
}

/**
 * The row that makes a disputed self-punch defensible. `threshold_used` is pinned
 * here so a later threshold change cannot rewrite history.
 *
 * `kiosk_device_id`, `operator_id` and `capture_photo_path` are NULL by
 * construction: a browser is not a paired kiosk, no guard is present, and this
 * endpoint accepts no image. `runner_up_*`, `margin` and `candidate_scores` are
 * NULL because a 1:1 comparison HAS no runner-up — recording an empty candidate
 * list as `[]` would imply a search was performed. `app_version` is NULL: the
 * portal is not the versioned kiosk build, and inventing a value for a forensic
 * column is worse than leaving it empty.
 */
async function insertMatchLog(tx: Sql, input: MatchLogInput): Promise<string> {
  const rows = await tx`
    INSERT INTO secure.face_match_log (
      id, attempted_at, kiosk_device_id, operator_id, candidate_set_size, outcome,
      matched_employee_id, best_distance, best_confidence,
      runner_up_employee_id, runner_up_distance, margin, candidate_scores,
      threshold_used, model_version, detector_score, liveness_score,
      capture_photo_path, latency_ms, produced_punch_id, ip, app_version, error_detail
    ) VALUES (
      ${input.id}::uuid,
      now(),
      NULL::uuid,
      NULL::uuid,
      ${input.candidateSetSize}::integer,
      ${input.outcome}::text,
      ${input.matchedEmployeeId}::uuid,
      ${round(input.bestDistance, 5)}::numeric,
      ${round(input.bestConfidence, 5)}::numeric,
      NULL::uuid,
      NULL::numeric,
      NULL::numeric,
      NULL::jsonb,
      ${round(input.thresholdUsed, 5)}::numeric,
      ${input.modelVersion}::text,
      ${round(input.detectorScore, 4)}::numeric,
      ${round(input.livenessScore, 4)}::numeric,
      NULL::text,
      ${Math.trunc(input.latencyMs)}::integer,
      ${input.producedPunchId}::uuid,
      ${input.ip}::inet,
      NULL::text,
      ${input.errorDetail}::text
    )
    RETURNING id
  `;
  return (rows as unknown as { id: string }[])[0]?.id as string;
}

/**
 * Write the evidence row for an attempt that produces NO punch, in its own
 * transaction, then let the caller throw. `withContext` because
 * `secure.face_match_log` is reached over the direct connection only (boundary
 * B6) and the context batch is what every write in this project runs inside.
 */
async function logRefusedAttempt(ctx: RequestContext, input: MatchLogInput): Promise<void> {
  await withContext(ctx, async (tx) => {
    await insertMatchLog(tx, input);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Geofence + venue network
// ═══════════════════════════════════════════════════════════════════════════════

interface GeoVerdict {
  /** NULL means NOT EVALUATED — never "outside". */
  geofenceOk: boolean | null;
  distanceM: number | null;
  /** True when the fix is too coarse to resolve the fence at all. */
  accuracyTooCoarse: boolean;
}

/**
 * Compare a reported point against the employee's venue. Returns NULL for
 * `geofenceOk` when either side of the comparison is missing, because "we do not
 * know" and "the employee was elsewhere" are different facts and only one of them
 * is true here.
 */
export function evaluateGeofence(
  geo: PunchGeo | undefined,
  venue: { lat: number | null; lng: number | null; radiusM: number | null },
): GeoVerdict {
  // The venue's own shape keeps its nullable columns; `evaluateCircle` takes a
  // fence or nothing, and a venue with no coordinates IS nothing — which is how
  // "not evaluated" stays distinct from "outside". `kiosk-punch` calls the same
  // function with a device fence, so both paths agree by construction rather than
  // by two people keeping two copies in step.
  if (venue.lat === null || venue.lng === null) {
    return evaluateCircle(geo, null);
  }
  // `geofence_radius_m` is NOT NULL DEFAULT 300 on public.locations; the fallback
  // covers only an employee whose location row could not be read.
  return evaluateCircle(geo, {
    lat: venue.lat,
    lng: venue.lng,
    radiusM: venue.radiusM === null ? 300 : venue.radiusM,
  });
}

/**
 * Is the caller's IP inside one of the venue's declared networks? NULL when the
 * list is empty (not configured → not enforced, the same decision migration 046
 * records for the kiosk geofence) or when there is no IP to test.
 *
 * Contained, and deliberately so: a bad value in the setting degrades this check
 * to "not evaluated" instead of failing the punch. `inet` rather than `cidr`
 * because `cidr` rejects any address with host bits set — `192.168.1.5/24` is a
 * perfectly clear intention that a `::cidr` cast would turn into an aborted
 * transaction.
 */
async function evaluateVenueIp(
  client: Sql,
  ip: string | null,
  cidrs: readonly string[],
  log: Logger,
): Promise<boolean | null> {
  if (ip === null || cidrs.length === 0) return null;
  try {
    const rows = await client`
      SELECT EXISTS (
        SELECT 1
          FROM unnest(${toPgQuotedArray(cidrs)}::inet[]) c
         WHERE ${ip}::inet <<= c
      ) AS inside
    `;
    return firstRow(rows as unknown as { inside: boolean }[])?.inside ?? null;
  } catch (err) {
    log.warn("venue-IP check could not be evaluated; punch proceeds unflagged", { err });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// The write
// ═══════════════════════════════════════════════════════════════════════════════

interface DebouncedPunch {
  id: string;
  punched_at: Date | string;
}

/** `public.attendance_days` columns this endpoint reports back. */
interface DayRow {
  status: string | null;
  first_in_at: Date | string | null;
  last_out_at: Date | string | null;
  total_worked_minutes: number | null;
  punch_count: number | null;
  is_late: boolean | null;
  late_minutes: number | null;
}

function toDaySnapshot(row: DayRow | null): DaySnapshot | null {
  if (row === null || row.status === null) return null;
  return {
    status: row.status,
    firstInAt: row.first_in_at === null ? null : toIso(row.first_in_at),
    lastOutAt: row.last_out_at === null ? null : toIso(row.last_out_at),
    workedMinutes: numOrNull(row.total_worked_minutes),
    punchCount: numOrNull(row.punch_count),
    isLate: row.is_late === null ? null : row.is_late === true,
    lateMinutes: numOrNull(row.late_minutes),
  };
}

interface WriteInput {
  ctx: RequestContext;
  subject: Subject;
  config: PunchConfig;
  body: SelfPunchInput;
  matchLogId: string;
  punchId: string;
  distance: number;
  confidence: number;
  /** The enrolled template's own `model_version` — the truth, not a default. */
  modelVersion: string;
  source: "web" | "mobile";
  geofence: GeoVerdict;
  needsReview: boolean;
  reviewNotes: string[];
  actorProfileId: string;
  /**
   * True when this punch fell outside the shift window and so waits for an administrator.
   *
   * Decided by the handler, not here: `punch_within_shift` has to be asked BEFORE the
   * idempotency claim and before any biometric work, so a punch that is going to be refused
   * for a missing reason does not burn a key or process somebody's face.
   */
  requiresApproval: boolean;
  /** The off-hours note. Empty string when none was given and none was needed. */
  offHoursReason: string;
  log: Logger;
}

interface WriteOutcome {
  /**
   * The punch the ANSWER is about. For a debounced tap that is the ORIGINAL
   * punch, not the voided duplicate this request wrote — the employee needs to be
   * told "you were already marked in at 09:04", and pointing them at a voided row
   * would be pointing them at a row the day computation ignores.
   */
  punchId: string;
  punchedAt: string;
  direction: PunchDirection;
  effectiveDate: string;
  needsReview: boolean;
  debouncedOf: string | null;
  day: DaySnapshot | null;
  hardLocked: boolean;
}

/**
 * Punch + evidence + recompute, in ONE transaction (lifecycle steps 9–10).
 *
 * `direction` is written `'undetermined'` — see the header for why stamping the
 * derived value would change how `compute_attendance_day` finds breaks.
 * `business_date` is left NULL so `trg_attendance_punches__business_date` can
 * attribute a post-midnight punch to the shift that started yesterday, and
 * `effective_date` comes back from `RETURNING` rather than being predicted.
 */
async function writePunch(input: WriteInput): Promise<WriteOutcome> {
  const {
    ctx,
    subject,
    config,
    body,
    matchLogId,
    punchId,
    distance,
    confidence,
    modelVersion,
    source,
    geofence,
    reviewNotes,
    actorProfileId,
    requiresApproval,
    offHoursReason,
    log,
  } = input;

  return await withContext(ctx, async (tx) => {
    // SERIALISE PER EMPLOYEE, before anything reads the punch log.
    //
    // The debounce and the direction parity are both plain SELECTs. Under READ
    // COMMITTED two genuinely simultaneous requests for the SAME employee (two
    // tabs, or a phone and a laptop) each see no prior punch and both insert — so
    // an employee could land two 'in' punches a millisecond apart and the day's
    // worked minutes would be computed from a log that never happened.
    // `attendance_punch_keys` does not catch it: the client mints a fresh
    // clientEventId per tap, so the two requests carry different keys and the
    // permanent-replay key is not violated.
    //
    // A transaction-scoped advisory lock keyed on the employee makes the read and
    // the insert atomic with respect to each other. It is released with the
    // transaction, needs no table, and cannot deadlock against anything else here
    // because it is the first statement and only ever one key is taken.
    // `hashtextextended` is stable across sessions, unlike `hashtext` on some
    // versions, and the 'self_punch' salt keeps this lock space distinct from any
    // other advisory lock in the schema.
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtextextended('self_punch:' || ${subject.employeeId}::text, 0)
      )
    `;

    // ── Debounce (kiosk-punch §4.4 step 12, same window, same intent) ────────
    // A second tap inside the policy's debounce window is still WRITTEN — INV-4,
    // no biometric event is dropped — but written VOIDED and pointing at the
    // punch it duplicates, so the day computation ignores it. `is_voided = true`
    // at INSERT is legal: the append-only trigger fires on UPDATE/DELETE only.
    //
    // Unlike the kiosk there is always somebody to attribute the void to: the
    // employee themselves, which is what `ck_ap__void_fields` demands. The kiosk
    // has to keep an unattributable duplicate live; this path never does.
    const recent = await tx`
      SELECT p.id, p.punched_at
        FROM public.attendance_punches p
       WHERE p.employee_id = ${subject.employeeId}::uuid
         AND p.is_voided = false
         AND p.punched_at <= now()
         AND p.punched_at > now() - make_interval(secs => ${config.debounceSeconds}::double precision)
       ORDER BY p.punched_at DESC
       LIMIT 1
    `;
    const duplicateOf = firstRow(recent as unknown as DebouncedPunch[]);
    const isDuplicate = duplicateOf !== null;

    const notes = isDuplicate ? [...reviewNotes, "debounced_duplicate"] : reviewNotes;
    const needsReview = input.needsReview || isDuplicate;

    await insertMatchLog(tx, {
      id: matchLogId,
      candidateSetSize: 1,
      outcome: isDuplicate ? "duplicate_suppressed" : "matched",
      matchedEmployeeId: subject.employeeId,
      bestDistance: distance,
      bestConfidence: confidence,
      thresholdUsed: config.minConfidence,
      modelVersion,
      detectorScore: body.metrics.detectionScore,
      livenessScore: body.metrics.livenessScore ?? null,
      latencyMs: log.elapsedMs(),
      producedPunchId: punchId,
      ip: ctx.ip ?? null,
      errorDetail: notes.length === 0 ? null : notes.join(","),
    });

    const voidReason = "debounce: repeat self-punch inside the policy debounce window";

    const insertedRows = await tx`
      INSERT INTO public.attendance_punches (
        id, employee_id, punched_at, direction, source,
        face_match_log_id, match_confidence, match_distance,
        lat, lng, location_accuracy_m, geofence_ok,
        ip, user_agent, device_id,
        needs_review, is_voided, voided_by, voided_at, void_reason,
        duplicate_of_punch_id, recorded_by, request_id, idempotency_key,
        requires_approval, reason, proof_document_id
      ) VALUES (
        ${punchId}::uuid,
        ${subject.employeeId}::uuid,
        now(),
        'undetermined'::public.punch_direction,
        ${source}::public.punch_source,
        ${matchLogId}::uuid,
        ${round(confidence, 5)}::numeric,
        ${round(distance, 5)}::numeric,
        ${body.geo?.latitude ?? null}::numeric,
        ${body.geo?.longitude ?? null}::numeric,
        ${body.geo?.accuracyMetres ?? null}::numeric,
        ${geofence.geofenceOk}::boolean,
        ${ctx.ip ?? null}::inet,
        ${ctx.ua ?? null}::text,
        ${body.deviceId ?? null}::text,
        ${needsReview}::boolean,
        ${isDuplicate}::boolean,
        ${isDuplicate ? actorProfileId : null}::uuid,
        CASE WHEN ${isDuplicate}::boolean THEN now() ELSE NULL END,
        ${isDuplicate ? voidReason : null}::text,
        ${duplicateOf?.id ?? null}::uuid,
        ${actorProfileId}::uuid,
        ${ctx.requestId}::uuid,
        ${body.clientEventId}::text,
        ${requiresApproval}::boolean,
        ${requiresApproval ? offHoursReason : (offHoursReason === "" ? null : offHoursReason)}::text,
        /*
          Only ever attached to a punch that NEEDS it. An in-window punch carrying a
          photograph would put a picture of somebody's home in the vault for no reason
          anybody could point at, which is the sort of collection that is hard to justify
          later and easy to avoid now.
        */
        ${requiresApproval ? (body.proofDocumentId ?? null) : null}::uuid
      )
      RETURNING id, punched_at, effective_date::text AS effective_date
    `;
    const punch = firstRow(
      insertedRows as unknown as {
        id: string;
        punched_at: Date | string;
        effective_date: string;
      }[],
    );
    if (punch === null) throw new Error("self-punch insert returned no row");

    // ── Direction, from the log and nothing else ─────────────────────────────
    // For a debounced tap the reference instant is the ORIGINAL punch, so the
    // employee sees the same word twice ("Checked in") instead of a phantom
    // check-out — the same correction `kiosk-punch` makes for the same reason.
    const reference = toIso(isDuplicate && duplicateOf !== null ? duplicateOf.punched_at : punch.punched_at);
    const priorRows = await tx`
      SELECT count(*)::integer AS prior
        FROM public.attendance_punches q
       WHERE q.employee_id = ${subject.employeeId}::uuid
         AND q.effective_date = ${punch.effective_date}::date
         AND q.is_voided = false
         AND q.punched_at < ${reference}::timestamptz
         AND q.id <> ${punchId}::uuid
    `;
    const prior = firstRow(priorRows as unknown as { prior: number }[])?.prior ?? 0;
    // Even count → no 'in' is open → this is the 'in'. Odd → close it.
    const direction: PunchDirection = prior % 2 === 0 ? "in" : "out";

    // ── Synchronous recompute, unless a hard lock would abort the punch ──────
    const lockRows = await tx`
      SELECT EXISTS (
        SELECT 1
          FROM public.attendance_locks l
         WHERE l.unlocked_at IS NULL
           AND l.lock_kind = 'hard'
           AND ${punch.effective_date}::date BETWEEN l.from_date AND l.to_date
           AND (l.scope = 'company'
             OR (l.scope = 'location'   AND l.location_id   = ${subject.locationId}::uuid)
             OR (l.scope = 'department' AND l.department_id = ${subject.departmentId}::uuid)
             OR (l.scope = 'employee'   AND l.employee_id   = ${subject.employeeId}::uuid))
      ) AS hard_locked
    `;
    const hardLocked = firstRow(lockRows as unknown as { hard_locked: boolean }[])?.hard_locked === true;

    let day: DaySnapshot | null = null;
    if (hardLocked) {
      // The punch is recorded either way. `compute_attendance_day` would RAISE
      // 55006 here and take the punch down with it.
      log.warn("hard-locked business date: synchronous recompute skipped", {
        effective_date: punch.effective_date,
      });
    } else {
      // `compute_attendance_day` sets `app.reason` from this argument when it is
      // ≥10 characters, which is what `attendance_days`'s audit trigger demands.
      const recomputeReason =
        `self-punch ${direction}: recompute ${punch.effective_date} after a portal punch`;
      // SAVEPOINT, so a recompute failure can never take the punch with it.
      //
      // The invariant this function rests on is that a recorded punch stays
      // recorded: "an admin locked the period" must never become "nobody can
      // record that they came to work". The hard-lock pre-check above anticipates
      // the 55006 the engine raises for a locked period, but it is a check-then-act
      // — the lock can be taken between the two statements — and 55006 is not the
      // only exception `compute_attendance_day` can raise. Without a savepoint ANY
      // of them aborts the whole transaction and the punch disappears, silently,
      // with the employee told nothing was recorded.
      //
      // Inside a savepoint the failure rolls back only the recompute. The punch and
      // its evidence row survive, the day is returned as null (the client already
      // treats null as "not computed yet"), and a review note makes the gap
      // visible. The nightly close recomputes the day regardless, so nothing is
      // permanently lost — only this one round trip's convenience.
      // Explicit SQL savepoint rather than a driver helper: nothing else in this
      // repo calls `.savepoint()`, and NOTHING TYPECHECKS THIS FILE —
      // `tsconfig.app.json` scopes `include` to `src` and there is no deno binary
      // here — so a mistaken driver API would surface as a runtime failure at the
      // gate, not a build error. SAVEPOINT/ROLLBACK TO SAVEPOINT are plain SQL over
      // the same tagged-template interface every other statement here uses, and
      // `prepare: false` (see _shared/db.ts) means they go over the simple query
      // protocol without ceremony.
      await tx`SAVEPOINT self_punch_recompute`;
      try {
        const dayRows = await tx`
          SELECT r.status::text          AS status,
                 r.first_in_at           AS first_in_at,
                 r.last_out_at           AS last_out_at,
                 r.total_worked_minutes  AS total_worked_minutes,
                 r.punch_count           AS punch_count,
                 r.is_late               AS is_late,
                 r.late_minutes          AS late_minutes
            FROM public.compute_attendance_day(
                   ${subject.employeeId}::uuid,
                   ${punch.effective_date}::date,
                   ${recomputeReason}::text
                 ) r
        `;
        await tx`RELEASE SAVEPOINT self_punch_recompute`;
        // A soft lock makes the engine return the EXISTING row; an employee excluded
        // from attendance, or a future date with no leave, makes it return a NULL
        // composite. All of those are legitimate nulls, not failures.
        day = toDaySnapshot(firstRow(dayRows as unknown as DayRow[]));
      } catch (recomputeErr) {
        // Roll back ONLY the recompute. The punch and its evidence row survive,
        // which is the invariant that matters: "an admin locked the period" must
        // never become "nobody can record that they came to work".
        await tx`ROLLBACK TO SAVEPOINT self_punch_recompute`;
        log.warn("synchronous recompute failed; punch kept, day left uncomputed", {
          effective_date: punch.effective_date,
          err: recomputeErr,
        });
        // NOT flagged on the punch row, and that is not an oversight: the row was
        // inserted before this ran, `attendance_punches` is append-only (only the
        // four void columns may ever change), and `reviewNotes` was already
        // serialised into it. Pretending to add a note here would be code that
        // looks like it flags something and does not. The honest signals are this
        // warning, the null `day` the client renders as "not computed yet", and the
        // nightly close, which recomputes the day from the punch log regardless.
        day = null;
      }
    }

    return {
      punchId: duplicateOf?.id ?? punch.id,
      punchedAt: reference,
      direction,
      effectiveDate: punch.effective_date,
      needsReview,
      debouncedOf: duplicateOf?.id ?? null,
      day,
      hardLocked,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Replay of a punch that already exists
// ═══════════════════════════════════════════════════════════════════════════════

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

interface ReplayRow extends DayRow {
  punch_id: string;
  punched_at: Date | string;
  effective_date: string;
  geofence_ok: boolean | null;
  match_confidence: string | null;
  needs_review: boolean;
  requires_approval: boolean;
  prior: number;
}

/**
 * `public.attendance_punch_keys` PK `(employee_id, idempotency_key)` is the
 * PERMANENT replay guard: it outlives the 24-hour idempotency store, so a retry
 * from a tab left open overnight lands here. That is a SUCCESS for the client, not
 * a 500 — answer with the punch that already exists, rebuilt from the row itself
 * so nothing is invented.
 */
async function replayedResult(
  client: Sql,
  subject: Subject,
  clientEventId: string,
): Promise<SelfPunchResult | null> {
  const rows = await client`
    SELECT p.id                                   AS punch_id,
           p.punched_at                           AS punched_at,
           p.effective_date::text                 AS effective_date,
           p.geofence_ok                          AS geofence_ok,
           p.match_confidence                     AS match_confidence,
           p.needs_review                         AS needs_review,
           p.requires_approval                    AS requires_approval,
           (SELECT count(*)::integer
              FROM public.attendance_punches q
             WHERE q.employee_id = p.employee_id
               AND q.effective_date = p.effective_date
               AND q.is_voided = false
               AND q.punched_at < p.punched_at
               AND q.id <> p.id)                  AS prior,
           d.status::text                         AS status,
           d.first_in_at                          AS first_in_at,
           d.last_out_at                          AS last_out_at,
           d.total_worked_minutes                 AS total_worked_minutes,
           d.punch_count                          AS punch_count,
           d.is_late                              AS is_late,
           d.late_minutes                         AS late_minutes
      FROM public.attendance_punch_keys k
      JOIN public.attendance_punches p
        ON p.id = k.punch_id AND p.punched_at = k.punched_at
      LEFT JOIN public.attendance_days d
        ON d.employee_id = p.employee_id AND d.ist_date = p.effective_date
     WHERE k.employee_id = ${subject.employeeId}::uuid
       AND k.idempotency_key = ${clientEventId}
     LIMIT 1
  `;
  const row = firstRow(rows as unknown as ReplayRow[]);
  if (row === null) return null;

  const direction: PunchDirection = Number(row.prior) % 2 === 0 ? "in" : "out";
  const punchedAt = toIso(row.punched_at);
  const geofenceOk = row.geofence_ok === null ? null : row.geofence_ok === true;
  return {
    direction,
    punchedAt,
    istTime: istTime(punchedAt),
    employeeName: subject.displayName,
    geofenceOk,
    matchConfidence: fixed(numOrNull(row.match_confidence) ?? 0, 3),
    message: messageFor(direction, punchedAt, {
      geofenceOk,
      needsReview: row.needs_review === true,
      alreadyRecorded: true,
    }),
    punchId: row.punch_id,
    needsReview: row.needs_review === true,
    /*
      Read off the ORIGINAL punch, not recomputed. A replay answers "what happened when this
      was first stored", and asking `punch_within_shift` again could give a different answer —
      the retry may arrive after the shift window has closed, which would report a punch as
      needing approval when the stored row says it never did.
    */
    requiresApproval: row.requires_approval === true,
    day: toDaySnapshot(row),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Copy
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The plain-English fallback. Deliberately short and free of jargon: no
 * capability strings, no column names, no "geofence". A screen that has i18n
 * should build its own sentence from the structured fields — this function may
 * not touch `src/shared/i18n`, so this is prose, not a key.
 */
export function messageFor(
  direction: PunchDirection,
  punchedAt: string,
  flags: { geofenceOk: boolean | null; needsReview: boolean; alreadyRecorded: boolean },
): string {
  const at = istTime(punchedAt).slice(0, 5);
  const verb = direction === "in" ? "in" : "out";
  if (flags.alreadyRecorded) {
    return `Already recorded — you were marked ${verb} at ${at}.`;
  }
  if (flags.geofenceOk === false) {
    return `Marked ${verb} at ${at}. Your location looks outside the venue, so HR will confirm this one.`;
  }
  if (flags.needsReview) {
    return `Marked ${verb} at ${at}. HR will confirm this one.`;
  }
  if (flags.geofenceOk === null) {
    return `Marked ${verb} at ${at}. Location was not confirmed.`;
  }
  return `Marked ${verb} at ${at}, at the venue.`;
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
  let claimed = false;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model U) ───────────────────────────────────────────────
    const auth = await verifyUser(req);
    const client = sqlHandle();

    // ── STEP 5 · Authority (model U+) ─────────────────────────────────────────
    // The DATABASE decides, through `app.has_cap()` + `role_capabilities`, so
    // revoking `attendance.punch.web` takes effect on the next button press
    // without a redeploy. `requires_step_up` is false on that row today; if HR
    // ever flips it, `requireCapWithStepUp` starts demanding aal2 here with no
    // change to this file.
    await requireCapWithStepUp(client, auth, CAP_PUNCH_WEB);

    // ── STEP 6 · Rate limit (outside any transaction, on purpose) ─────────────
    await enforce(LIMIT_SELF_PUNCH, limitKey(FN_NAME, auth.userId), "SELF_PUNCH_RATE_LIMITED", client);

    // ── STEP 7 · Validate ─────────────────────────────────────────────────────
    const { data: body, raw } = await parseBody(req, SelfPunchBody, { maxBytes: MAX_BODY_BYTES });
    idempotencyKey = requireIdempotencyKey(req);

    /*
      The accuracy ceiling, checked here rather than in the schema so the employee gets a
      sentence naming the number instead of a field-validation message. A fix this coarse is
      almost always IP-derived — the browser reports a city, not a place — and storing it beside
      a real GPS fix would make the two indistinguishable to whoever reads the punch later.

      Separate code from the missing-location case: "turn location on" and "your location is too
      vague, step outside or wait for a better fix" are different instructions, and one refusal
      covering both would give half the callers the wrong one.
    */
    if (
      body.geo.accuracyMetres !== undefined &&
      body.geo.accuracyMetres > MAX_ACCURACY_M
    ) {
      const reported = Math.round(body.geo.accuracyMetres);
      throw unprocessable(
        [{
          pointer: "/geo/accuracyMetres",
          code: "too_coarse",
          detail: `${reported} m reported, ${MAX_ACCURACY_M} m is the widest accepted.`,
        }],
        `Your device reported a location accurate to about ${reported} m, which is too vague to record where you punched from. Turn on precise location (GPS) for this site, or move somewhere with a clearer signal, and try again.`,
        "SELF_PUNCH_LOCATION_TOO_COARSE",
      );
    }

    const actorLog = log.child({ actor_id: auth.userId, employee_id: auth.employeeId });

    // Entitlement and employment BEFORE anything biometric: a person who may not
    // self-punch should not have their face processed to be told so.
    const subject = await loadSubject(client, auth);

    /*
      ── OUTSIDE THE SHIFT? THEN SAY WHY ─────────────────────────────────────────
      Asked for by the venue: a web or phone punch taken outside somebody's working hours
      carries a reason and waits for an administrator. Inside them nothing is asked, however
      many times they punch — the 9-to-1-then-7-to-9 day this exists for is unusual because of
      the HOURS, not the number of scans.

      `punch_within_shift` is the same resolver the engine uses for lateness, so the endpoint
      and the engine cannot disagree about whether 19:00 was inside a day. The tolerance is its
      OWN setting and not the policy grace: `grace_out_minutes` is 10 on the Operations policy,
      which would interrogate every 17:41 departure, and widening THAT would quietly forgive
      real lateness because it is what late_minutes is measured against.

      Checked BEFORE the idempotency claim and before any biometric work, so a punch that is
      going to be refused for a missing reason does not burn a key or process a face.

      The GATE is not affected. This is `attendance-self-punch`; `kiosk-punch` is a different
      function and asks nobody anything.
    */
    const tolRows = await client<{ minutes: string | null }[]>`
      SELECT app.setting('attendance.off_hours_reason_tolerance_minutes') AS minutes`;
    const rawTolerance = firstRow(tolRows)?.minutes;
    const toleranceMinutes = (() => {
      const n = Number(String(rawTolerance ?? "").replace(/"/g, "").trim());
      // Absent or unreadable falls back to the seeded 60 rather than to 0: a bad setting value
      // must not start demanding reasons from everybody who leaves a minute late.
      return Number.isFinite(n) && n >= 0 ? n : 60;
    })();

    const withinRows = await client<{ within: boolean | null }[]>`
      SELECT public.punch_within_shift(
               ${subject.employeeId}::uuid, now(), ${toleranceMinutes}::integer) AS within`;
    // NULL cannot happen — the function returns true for a missing shift — but a null here
    // must read as "inside", never as "justify yourself".
    const withinShift = firstRow(withinRows)?.within !== false;

    const offHoursReason = (body.reason ?? "").trim();
    if (!withinShift && offHoursReason.length < MIN_OFF_HOURS_REASON) {
      throw unprocessable(
        [{
          pointer: "/reason",
          code: "too_short",
          detail: `${offHoursReason.length} characters given, ${MIN_OFF_HOURS_REASON} needed.`,
        }],
        `This punch is outside your shift hours, so it needs a short note saying why — at least ${MIN_OFF_HOURS_REASON} characters. It will be recorded now and your hours will show straight away, with an administrator asked to approve them.`,
        "SELF_PUNCH_OFF_HOURS_REASON_REQUIRED",
      );
    }
    // Only an off-hours punch is held for approval. A reason typed on an in-hours punch is
    // kept as a note and changes nothing, because there is nothing to approve.
    const requiresApproval = !withinShift;

    // ── STEP 8 · Idempotency claim ────────────────────────────────────────────
    // After the cheap refusals (so an HR-configuration answer does not burn a
    // key) and before the biometric work (so two tabs cannot both punch).
    const hash = await requestHash(FN_NAME, raw, auth.userId);
    const claimResult = await claim(
      { key: idempotencyKey, fnName: FN_NAME, requestHash: hash, actorId: auth.userId },
      client,
    );
    if (claimResult.state === "replay") {
      status = claimResult.status;
      actorLog.info("idempotent replay", { key: idempotencyKey });
      return replayResponse(claimResult, { ...cors, "x-request-id": requestId });
    }
    claimed = true;

    const ctx: RequestContext = {
      actorId: auth.userId,
      actorRole: auth.role,
      source: "web_employee",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: body.deviceId ?? null,
      // `attendance_days` is in `audit.reason_required_tables`; the recompute
      // inside the transaction writes it, and its audit trigger demands ≥10
      // characters here.
      reason: "employee marked their own attendance from the portal",
    };

    const config = await loadConfig(client, subject.employeeId, actorLog);

    // THE POLICY-LEVEL SWITCH, checked before any descriptor is compared.
    // `employees.allow_web_punch` (already checked in loadSubject) is a per-person
    // exception; `attendance_policies.allow_web_punch` is what the venue set for
    // the group. A per-person flag must not override an HR configuration, so BOTH
    // have to be true. Without this the endpoint was more permissive than the
    // configuration it claims to honour — a real authorisation gap, since a venue
    // that deliberately switched web punching off at policy level would still have
    // seen punches land.
    if (!config.policyAllowsWebPunch) {
      throw forbidden(
        "Punching from the portal is switched off by the attendance policy that applies to you. " +
          "Use the gate scanner, or ask HR to enable it.",
        "SELF_PUNCH_POLICY_FORBIDS_WEB",
      );
    }
    const matchLogId = crypto.randomUUID();
    const reviewNotes: string[] = [];

    // ── STEP 9 · Descriptor sanity ────────────────────────────────────────────
    // A non-unit descriptor means the browser skipped L2 normalisation, and every
    // distance computed from it is a lie. No match log: nothing was compared, and
    // there is no biometric decision to defend — only a malformed request.
    const norm = l2Norm(body.descriptor);
    if (Math.abs(norm - 1) > DESCRIPTOR_NORM_TOLERANCE) {
      throw unprocessable(
        [{ pointer: "/descriptor", code: "not_normalised", detail: "Descriptor must be L2-normalised." }],
        "The face reading from your camera was not usable. Reload the page and try again.",
        "SELF_PUNCH_DESCRIPTOR_INVALID",
      );
    }

    // ── Quality and liveness gates (spec-kiosk §1.1 / §1.2) ───────────────────
    if (body.metrics.detectionScore < config.minDetectionScore) {
      await logRefusedAttempt(ctx, {
        id: matchLogId,
        candidateSetSize: 0,
        outcome: "low_quality",
        matchedEmployeeId: subject.employeeId,
        bestDistance: null,
        bestConfidence: null,
        thresholdUsed: config.minConfidence,
        modelVersion: config.descriptorModel,
        detectorScore: body.metrics.detectionScore,
        livenessScore: body.metrics.livenessScore ?? null,
        latencyMs: log.elapsedMs(),
        producedPunchId: null,
        ip: ctx.ip ?? null,
        errorDetail: "detection_score_below_minimum",
      });
      throw unprocessable(
        [{ pointer: "/metrics/detectionScore", code: "too_small", detail: "The camera did not see a face clearly enough." }],
        "We couldn't see your face clearly. Move into better light, face the camera and try again.",
        "SELF_PUNCH_CAPTURE_TOO_POOR",
      );
    }

    if (body.metrics.livenessScore === undefined) {
      // A MISSING score is not evidence of a spoof — but it is not attestation
      // either. Record the punch and flag it, rather than refusing a person's
      // attendance over a metric their browser did not produce.
      if (config.livenessRequired) reviewNotes.push("liveness_not_attested");
    } else if (body.metrics.livenessScore < config.livenessPass) {
      // ADVISORY, NOT A GATE — on this endpoint only, and deliberately.
      //
      // The only liveness signal this build has is a frame-MOTION heuristic
      // (`features/auth/lib/liveness.ts`, model `frame-motion-heuristic-v1`).
      // There is no certified passive-liveness model anywhere in the repo. Two
      // consequences make a hard refusal the wrong call for an employee's own
      // attendance:
      //
      //   * the capture guidance the shared pipeline shows says "hold still",
      //     because stillness is what a sharp descriptor needs — so the very
      //     behaviour the UI asks for drives the motion score DOWN. A person
      //     following the instructions would be refused as a spoof;
      //   * refusing a real employee's attendance produces a payroll dispute,
      //     while flagging it produces a review queue entry. The evidence is
      //     identical either way: the score, the model name and the frame count
      //     are all written to secure.face_match_log regardless.
      //
      // So the score is RECORDED and the punch is FLAGGED. The kiosk keeps its
      // own stricter behaviour — a gate scanner is operated by a guard who can
      // ask a person to move, and a stranger at the gate is the threat this
      // build's threshold was chosen for. Revisit the moment a real PAD model
      // exists: then this becomes a refusal again and the comment goes.
      reviewNotes.push("liveness_below_threshold");
    }

    // ── STEP 10 · Consent, then the 1:1 confirmation ──────────────────────────
    const template = await loadTemplate(client, subject.employeeId);
    if (template === null || template.descriptor_dim !== DESCRIPTOR_DIM) {
      await logRefusedAttempt(ctx, {
        id: matchLogId,
        candidateSetSize: 0,
        outcome: "error",
        matchedEmployeeId: subject.employeeId,
        bestDistance: null,
        bestConfidence: null,
        thresholdUsed: config.minConfidence,
        modelVersion: config.descriptorModel,
        detectorScore: body.metrics.detectionScore,
        livenessScore: body.metrics.livenessScore ?? null,
        latencyMs: log.elapsedMs(),
        producedPunchId: null,
        ip: ctx.ip ?? null,
        errorDetail: template === null ? "no_active_face_template" : "template_dimension_mismatch",
      });
      faceNotEnrolled();
    }
    if (template.consent_ok !== true) {
      // DPDP: no distance has been computed, and none will be. The refusal is
      // "processing that never happened", not "a match that failed".
      await logRefusedAttempt(ctx, {
        id: matchLogId,
        candidateSetSize: 0,
        outcome: "error",
        matchedEmployeeId: subject.employeeId,
        bestDistance: null,
        bestConfidence: null,
        thresholdUsed: config.minConfidence,
        modelVersion: template.model_version,
        detectorScore: body.metrics.detectionScore,
        livenessScore: body.metrics.livenessScore ?? null,
        latencyMs: log.elapsedMs(),
        producedPunchId: null,
        ip: ctx.ip ?? null,
        errorDetail: "biometric_consent_absent_or_withdrawn",
      });
      biometricConsentMissing();
    }

    /*
      The nearest of the employee's samples, not only the medoid — see bestSampleDistance.
      `template.template_id` is still the row whose CONSENT and dimension were checked above;
      `best.templateId` is the sibling that actually recognised them, and that is what the match
      log should record.
    */
    const best = await bestSampleDistance(client, subject.employeeId, body.descriptor);
    const distance = best === null ? null : best.distance;
    if (distance === null) {
      // The template vanished between the two queries (a purge or a
      // deactivation landing mid-request). Treat it as not enrolled.
      await logRefusedAttempt(ctx, {
        id: matchLogId,
        candidateSetSize: 0,
        outcome: "error",
        matchedEmployeeId: subject.employeeId,
        bestDistance: null,
        bestConfidence: null,
        thresholdUsed: config.minConfidence,
        modelVersion: template.model_version,
        detectorScore: body.metrics.detectionScore,
        livenessScore: body.metrics.livenessScore ?? null,
        latencyMs: log.elapsedMs(),
        producedPunchId: null,
        ip: ctx.ip ?? null,
        errorDetail: "template_disappeared_mid_request",
      });
      faceNotEnrolled();
    }

    const confidence = confidenceFor(distance);
    if (confidence < config.minConfidence) {
      await logRefusedAttempt(ctx, {
        id: matchLogId,
        candidateSetSize: 1,
        outcome: "no_match",
        matchedEmployeeId: subject.employeeId,
        bestDistance: distance,
        bestConfidence: confidence,
        thresholdUsed: config.minConfidence,
        modelVersion: template.model_version,
        detectorScore: body.metrics.detectionScore,
        livenessScore: body.metrics.livenessScore ?? null,
        latencyMs: log.elapsedMs(),
        producedPunchId: null,
        ip: ctx.ip ?? null,
        errorDetail: null,
      });
      actorLog.warn("self-punch face not confirmed", { threshold: config.minConfidence });
      faceNotConfirmed();
    }

    // ── Location, network, review flags ───────────────────────────────────────
    const geofence = evaluateGeofence(body.geo, {
      lat: subject.locationLat,
      lng: subject.locationLng,
      radiusM: subject.geofenceRadiusM,
    });
    if (geofence.geofenceOk === false) reviewNotes.push("outside_geofence");
    if (geofence.accuracyTooCoarse) reviewNotes.push("location_accuracy_coarse");

    const venueIpOk = subject.restrictToVenueIp
      ? await evaluateVenueIp(client, ctx.ip ?? null, config.venueCidrs, actorLog)
      : null;
    if (venueIpOk === false) reviewNotes.push("outside_venue_network");
    /*
      ── AN OFF-HOURS PUNCH THAT ARRIVED WITHOUT ITS PROOF ────────────────────
      The form makes the photograph mandatory, so reaching here without one means the upload
      failed — weak signal at 9 pm, a denied camera, a file the vault refused. The punch is
      still recorded, because the alternative is what this venue already lived through: a hard
      gate that made people conclude the app was broken and stop punching altogether.

      Flagged instead, in words, so the approval queue shows the absence rather than an
      approver assuming a picture exists and never checking. `requires_approval` was already
      going to send it to that queue; this says WHY it deserves a second look.
    */
    if (!withinShift && (body.proofDocumentId ?? "") === "") {
      reviewNotes.push("off_hours_proof_missing");
    }

    if (REVIEW_STATUSES.has(subject.employmentStatus)) {
      reviewNotes.push(`employment_status:${subject.employmentStatus}`);
    }

    const source: "web" | "mobile" = MOBILE_UA_RE.test(ctx.ua ?? "") ? "mobile" : "web";
    const punchId = crypto.randomUUID();

    // ── STEP 10 (cont.) · One transaction: punch + evidence + recompute ───────
    let outcome: WriteOutcome;
    try {
      outcome = await writePunch({
        ctx,
        subject,
        config,
        body,
        matchLogId,
        punchId,
        distance,
        confidence,
        modelVersion: template.model_version,
        source,
        geofence,
        /*
          An off-hours punch is flagged for review as well as held for approval. The two are
          different facts — review is "a human should look at this", approval is "these hours do
          not count yet" — and the exception queue is where somebody looks.
        */
        needsReview: reviewNotes.length > 0 || requiresApproval,
        reviewNotes,
        actorProfileId: auth.userId,
        requiresApproval,
        offHoursReason,
        log: actorLog,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // The permanent guard fired: this clientEventId already produced a punch.
      const replayed = await replayedResult(client, subject, body.clientEventId);
      if (replayed === null) throw err;
      // INV-4 / rule 7. A distance WAS computed for this request, and the
      // transaction that would have recorded it rolled back together with the
      // duplicate insert — so the evidence row has to be written again, on its
      // own, or a biometric comparison would be silently dropped. `matchLogId`
      // is reusable: the row it names never committed.
      try {
        await logRefusedAttempt(ctx, {
          id: matchLogId,
          candidateSetSize: 1,
          outcome: "duplicate_suppressed",
          matchedEmployeeId: subject.employeeId,
          bestDistance: distance,
          bestConfidence: confidence,
          thresholdUsed: config.minConfidence,
          modelVersion: template.model_version,
          detectorScore: body.metrics.detectionScore,
          livenessScore: body.metrics.livenessScore ?? null,
          latencyMs: log.elapsedMs(),
          producedPunchId: replayed.punchId,
          ip: ctx.ip ?? null,
          errorDetail: "replay_of_existing_client_event_id",
        });
      } catch (logErr) {
        // The punch exists and the employee must still be told. A lost evidence
        // row is reported here rather than turning a recorded punch into a 500.
        actorLog.error("could not write the match log for a replayed punch", { err: logErr });
      }
      actorLog.info("punch already recorded for this client event id");
      status = 200;
      await store(idempotencyKey, status, replayed, client);
      return ok(replayed, { status, headers: cors, requestId });
    }

    const result: SelfPunchResult = {
      direction: outcome.direction,
      punchedAt: outcome.punchedAt,
      istTime: istTime(outcome.punchedAt),
      employeeName: subject.displayName,
      geofenceOk: geofence.geofenceOk,
      matchConfidence: fixed(confidence, 3),
      message: messageFor(outcome.direction, outcome.punchedAt, {
        geofenceOk: geofence.geofenceOk,
        needsReview: outcome.needsReview,
        alreadyRecorded: outcome.debouncedOf !== null,
      }),
      punchId: outcome.punchId,
      needsReview: outcome.needsReview,
      /*
        So the card can say what actually happened rather than a flat "recorded". The hours
        show immediately either way; this is what turns the confirmation into "and an
        administrator has been asked to approve them", and what puts the star on the day.
      */
      requiresApproval,
      day: outcome.day,
    };

    actorLog.info("self-punch recorded", {
      punch_id: outcome.punchId,
      direction: outcome.direction,
      source,
      effective_date: outcome.effectiveDate,
      needs_review: outcome.needsReview,
      requires_approval: requiresApproval,
      within_shift: withinShift,
      debounced: outcome.debouncedOf !== null,
      geofence_ok: geofence.geofenceOk,
      geofence_distance_m: geofence.distanceM === null ? null : Math.round(geofence.distanceM),
      venue_ip_ok: venueIpOk,
      review_notes: reviewNotes,
      day_recomputed: !outcome.hardLocked,
    });

    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ────────────────
    await store(idempotencyKey, status, result, client);
    return ok(result, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    if (idempotencyKey !== null && claimed) {
      try {
        // A 5xx is not a deterministic answer: free the key so the retry is
        // processed for real rather than replaying our failure.
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

/** Exported for `supabase/tests` and the portal client — one contract, one source. */
export { ProbeMetrics, SelfPunchBody };
