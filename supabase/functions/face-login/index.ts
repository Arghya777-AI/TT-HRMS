/**
 * face-login — function #29 (like `auth-identify` #28 it is not one of
 * spec-architecture §4's 27, and like it, it follows the same 12-step lifecycle).
 * Auth model **none (pre-auth)**.
 *
 * The third door onto `/login`, beside password and passkey: an employee who has
 * an APPROVED face template signs in by looking at their camera. Two ops on one
 * endpoint, the same shape `webauthn-login` uses:
 *
 *   action=challenge  identifier → a single-use, 3-minute server challenge
 *   action=verify     identifier + challenge + descriptor → a one-time
 *                     `tokenHash` the browser redeems with `verifyOtp()`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A FACE IS, AND THEREFORE WHAT THIS ENDPOINT REFUSES TO DO
 * ─────────────────────────────────────────────────────────────────────────────
 * A face is an IDENTIFIER, not a secret. It is on the employee's WhatsApp
 * profile picture. Every control here follows from that one sentence, and the
 * honest summary is: this endpoint is a convenience for the shop-floor employee
 * portal, deliberately built so that the worst case of a successful spoof is
 * "somebody saw one employee's own leave balance and payslips", never more.
 *
 *   1. IT IS A 1:1 CONFIRMATION, NOT A 1:N SEARCH. The caller must first say who
 *      they are. A 1:N face login — "whoever this is, log them in" — would let
 *      one presented face open whichever account happened to be nearest, which
 *      is how a match at the GATE (a low-stakes, reviewable, guard-witnessed
 *      event) differs from a match that hands over SESSION AUTHORITY.
 *      Implemented as: run the same exact 1:N scan `kiosk-punch` runs, then
 *      require that the nearest template IS the claimed employee's. That is
 *      strictly stronger than a bare 1:1 distance test, because it also refuses
 *      when somebody else is nearer than the person you claim to be.
 *   2. A PRIVILEGED ACCOUNT IS HELD TO A HIGHER BAR, NOT REFUSED. Any profile holding
 *      `manager`, `admin` or `super_admin` used to be refused outright, with the same
 *      generic message as "no template" so the refusal was not an oracle. The owner
 *      asked for it to work for their own account, which is theirs to decide, so the
 *      check was RAISED rather than removed: such an account needs 0.80 confidence and
 *      0.12 margin — against 0.62 and 0.06 for an employee — the same pair
 *      `kiosk-face-signin` already requires of an admin opening a gate session.
 *
 *      The reasoning behind the old refusal still stands and is worth stating: an
 *      employee session is RLS-scoped to their own row, an admin session is not, and a
 *      photograph opening one is a materially worse outcome. What protects against that
 *      here is the MARGIN — doubling it demands the runner-up be clearly further away,
 *      which is the measure a lookalike or a photograph actually fails. Also, per-person
 *      `employees.allow_face_login` still gates it, so any admin can switch it off for a
 *      privileged holder, and the holder can switch it off for themselves.
 *   3. THE STRICTEST DOCUMENTED ACCEPT BAND. spec-kiosk §3.3 gives the kiosk
 *      T_accept = 0.45 and marks an accepted match beyond T_review = 0.38 as
 *      band `low` → human review. A login cannot be reviewed after the fact —
 *      the session already exists — so T_review is used as the CEILING here, and
 *      the employee's own `attendance_policies` row can only make it stricter,
 *      never looser (`Math.max`, exactly as `kiosk-punch` treats a device floor).
 *   4. LIVENESS IS MANDATORY, AND ITS LIMIT IS WRITTEN DOWN. `detectionScore`
 *      and `livenessScore` are REQUIRED (spec-kiosk §1.1/§1.2, thresholds 0.60
 *      and `attendance.liveness_pass_threshold` = 0.70). These are CLIENT-
 *      REPORTED numbers: a modified client can lie, so they are not a security
 *      boundary — they stop the actual attack anybody will actually try (hold a
 *      photo to the laptop camera with the stock build), and they are recorded
 *      for forensics. The boundary is 1 + 2 + the audit trail, not the score.
 *   5. AN ADMIN CAN TURN IT OFF WITHOUT A DEPLOY — the `face_login` feature flag
 *      (migration 20260801012200). `is_enabled = false` or `kill_switch = true` and this
 *      endpoint answers 503 on the very next request.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MATCHING — the SAME code path as the gate, on purpose
 * ─────────────────────────────────────────────────────────────────────────────
 * `findCandidates` is `kiosk-punch`'s query: exact sequential scan, Euclidean
 * distance over L2-normalised `real[]` computed IN POSTGRES, the DPDP consent
 * join, `is_active`, `purged_at IS NULL`, top 3 plus the true `count(*) OVER ()`
 * candidate-set size. `confidenceFor` is migration 012's `1 − d / max_d`.
 * Thresholds come from `public.resolve_policy('attendance_policy', …)` →
 * `min_confidence_for_auto_accept` / `min_margin_for_auto_accept`. No new
 * distance metric, no second implementation of the maths that decides who
 * somebody is — one would eventually disagree with the other.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SESSION MINTING (verbatim from `webauthn-login`, for the same reasons)
 * ─────────────────────────────────────────────────────────────────────────────
 * An edge function cannot sign a GoTrue session without the JWT secret and must
 * not hold it. So on success the service role asks the Auth admin API for a
 * magic-link `hashed_token` (`auth.admin.generateLink({type:'magiclink'})` —
 * which GENERATES, it does not send), returns it ONCE in a `no-store` response,
 * and never persists it. The browser calls
 * `verifyOtp({token_hash, type:'magiclink'})` and gets an ordinary session with
 * ordinary refresh behaviour. `log.ts`'s redactor drops any field whose name
 * matches /token/, so it cannot reach a log line by accident either. Employment
 * states that may not open a session (`suspended`, `exited`, `absconding`,
 * `retired`) and deactivated profiles are refused before any of that.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ACCOUNT-LOCKOUT DECISION (read before adding a `sessions_audit` row)
 * ─────────────────────────────────────────────────────────────────────────────
 * A failed face verification is NOT written to `public.sessions_audit` as
 * `login_failed`. That event drives `sessions_audit_apply_event()`, which
 * increments `profiles.failed_login_count` and DEACTIVATES the account at ten.
 * That counter is designed for password attempts, where a failure means somebody
 * guessed a secret wrongly. Here it means somebody sent 128 floats — which
 * anyone who knows an employee code can do — so writing it would publish a
 * remote "deactivate any employee" button. `webauthn-login` made the same call
 * for the same reason and this function follows it deliberately, not by copy:
 *
 *   FAILURE  → `secure.face_match_log` (the biometric evidence row, always) plus
 *              a `login_failed` row on the audit CHAIN (`public.audit_log`),
 *              which is what the security console reads.
 *   SUCCESS  → `sessions_audit`, ONE `login_success` row with `auth_method =
 *              'face'` (migration 20260801012200 extends that CHECK; mislabelling
 *              it `passkey` was not an option), because that is what maintains
 *              `profiles.last_login_at` and clears the counter. Deliberately NOT
 *              a `face_used` event beside it — the migration header explains why
 *              adding an eleventh `event` value was refused.
 *
 * INV-4 applies here as it does at the gate: NO biometric event is silently
 * dropped. Every outcome — matched, ambiguous, no-match, liveness-failed,
 * low-quality — writes a `secure.face_match_log` row BEFORE this function
 * answers, and before the session is minted, so a failure to mint cannot lose
 * the record of what was presented.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DPDP ACT 2023
 * ─────────────────────────────────────────────────────────────────────────────
 * The descriptor is biometric personal data. It is never logged (log.ts redacts
 * `descriptor` by key name, and nothing here passes it anyway), never stored by
 * this function, never echoed back, and never compared against a template whose
 * consent has been withdrawn — the consent join removes a withdrawn employee
 * from the search space immediately, without waiting for the purge job. No
 * capture photo is accepted or stored: `kiosk-punch` needs one to make a
 * disputed punch defensible, a login does not, and storing face images sent by
 * an unauthenticated caller would be a liability with no purpose.
 * `face_match_log.candidate_scores` (which does name other employees) is
 * service-role-only and nulled at 90 days by the retention job. Distances,
 * confidences, thresholds and any other employee's identity NEVER appear in a
 * response — the allow-list at the bottom of the success path is the same
 * discipline as spec-kiosk §11.
 *
 * DB GAP (not worked around here): `secure.face_match_log` has `liveness_score`
 * and `detector_score` but no `liveness_model`, which spec-kiosk §1.2 lists as
 * forward-compat for the P2 ML model. The reported model name therefore travels
 * on the audit-chain row instead of the match-log row; when a migration adds the
 * column, move it and delete this note.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  badGateway,
  forbidden,
  gone,
  methodNotAllowed,
  notFound,
  ok,
  toProblem,
  unavailable,
  unprocessable,
} from "../_shared/errors.ts";
import { parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { nowMs, toIso } from "../_shared/datetime.ts";
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
import { sha256Hex } from "../_shared/auth.ts";
import { enforce, limitKey, type RateLimitSpec } from "../_shared/ratelimit.ts";
import { auditSession, writeAudit } from "../_shared/audit.ts";
import type { Sql } from "../_shared/deps.ts";

const FN_NAME = "face-login";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** `public.feature_flags.key` seeded by migration 20260801012200. Absent ⇒ disabled ⇒ 503. */
const FEATURE_FLAG_KEY = "face_login";

/** 128 floats plus metrics is ~3 KB. No photo is accepted, so nothing here is large. */
const MAX_BODY_BYTES = 24 * 1024;

/** Ceremony timeout = the `secure.webauthn_challenges` TTL (3 minutes). */
const CEREMONY_TIMEOUT_MS = 180_000;

/**
 * Anti-enumeration budget, applied to the `challenge` leg only — it is the leg
 * that answers a question about whether an account exists. `verify` is dominated
 * by a sequential scan over every template and reveals nothing about which
 * account it was for. Same number, same reasoning, as `auth-identify` and
 * `webauthn-login`.
 */
const CONSTANT_TIME_MS = 400;

const DESCRIPTOR_DIM = 128;
/** spec-kiosk §1: L2-normalised on-device; the server checks |‖d‖ − 1| ≤ 0.02. */
const DESCRIPTOR_NORM_TOLERANCE = 0.02;
/** Maximum Euclidean distance between two unit vectors — the confidence denominator. */
const MAX_UNIT_DISTANCE = 2;

/** `attendance_policies` DB defaults (migration 014), used when no policy resolves. */
const DEFAULT_MIN_CONFIDENCE = 0.62;
const DEFAULT_MIN_MARGIN = 0.06;

/*
  FLOORS FOR A PRIVILEGED ACCOUNT — manager, admin or super_admin.

  These accounts USED TO BE REFUSED this door outright, and the reasoning was sound: a
  privileged session is the one worth stealing, so a face is a poor thing to hang it on.
  The owner has asked twice for it to work for their own account, which is their call to
  make, so the answer is not to delete the check but to raise the bar it enforces.

  The numbers are not new. They are the same pair `kiosk-face-signin` already uses to let
  an admin open a gate session by face, so the two doors agree about what "sure enough for
  an admin" means rather than each inventing a threshold.

  0.80 confidence is well above the 0.62 a plain employee needs; 0.12 margin is double the
  0.06 floor, which is what actually protects against a lookalike — it demands that the
  runner-up be clearly further away, not merely further.
*/
const PRIVILEGED_MIN_CONFIDENCE = 0.80;
const PRIVILEGED_MIN_MARGIN = 0.12;

/**
 * spec-kiosk §3.3 `T_review = 0.38`. At the gate an accepted match beyond this
 * is written and flagged for review; a LOGIN has no "flag it for review" — the
 * session is either granted or not — so T_review is the accept ceiling here.
 * Overridable through `attendance.face_review_threshold`, which is the key
 * spec-kiosk §3.3 names for it.
 */
const DEFAULT_LOGIN_MAX_DISTANCE = 0.38;
/** spec-kiosk §3.3 `T_far = 0.62`: beyond this there was no candidate worth naming. */
const FAR_DISTANCE = 0.62;

/** spec-kiosk §1: enrolment and probe must agree byte-for-byte or distances are meaningless. */
const DEFAULT_DESCRIPTOR_MODEL = "faceapi-rn34-128d-v1";
/** spec-kiosk §1.2 `attendance.liveness_pass_threshold`. */
const DEFAULT_LIVENESS_PASS = 0.7;
/** spec-kiosk §1.1, scan column: detector confidence ≥ 0.60. */
const MIN_DETECTION_SCORE = 0.6;

/** `employment_status` values that may not open a session (mirrors `webauthn-login`). */
const BLOCKED_EMPLOYMENT_STATUSES = ["suspended", "exited", "absconding", "retired"] as const;

/**
 * Rate limits. Declared here rather than in `_shared/ratelimit.ts` for the reason
 * `auth-identify` states about its own two buckets: these numbers are specific to
 * a pre-auth surface on the login screen, and `RATE_LIMITS.webauthn` (10/minute)
 * is an order of magnitude looser than a biometric endpoint should be. A face is
 * low-entropy: the budget for guessing at one has to be small and slow.
 *
 * `refillPerMinute = capacity / 10` gives "N per 10 minutes" exactly.
 */
const LIMIT_PER_IP: RateLimitSpec = {
  bucket: "face_login_ip",
  capacity: 10,
  refillPerMinute: 10 / 10,
};
const LIMIT_PER_IDENTIFIER: RateLimitSpec = {
  bucket: "face_login_identifier",
  capacity: 5,
  refillPerMinute: 5 / 10,
};

// ── Request contract ────────────────────────────────────────────────────────

const Identifier = z.string().trim().min(2).max(254);

const ChallengeRequest = z
  .object({
    action: z.literal("challenge"),
    identifier: Identifier,
  })
  .strict();

/**
 * The on-device numbers this server gates on. Both are REQUIRED: an optional
 * metric is an optional gate, and a client that can skip a gate by omitting a
 * field is not a gate at all (the same rule `face-enrol` states).
 */
const ProbeMetrics = z
  .object({
    /** `detection.score` from TinyFaceDetector. */
    detectionScore: z.number().finite().min(0).max(1),
    /** spec-kiosk §1.2 `liveness.passive_score`. */
    livenessScore: z.number().finite().min(0).max(1),
    /** e.g. `heuristic-v1`. Recorded on the audit chain — see the DB-gap note. */
    livenessModel: z.string().trim().min(1).max(64).optional(),
    framesAnalysed: z.number().int().min(1).max(240).optional(),
  })
  .strict();

const VerifyRequest = z
  .object({
    action: z.literal("verify"),
    identifier: Identifier,
    /** The base64url challenge handed out by the `challenge` leg. Single-use. */
    challenge: z.string().trim().min(16).max(200),
    /** Must equal the server's configured descriptor model. */
    descriptorModel: z.string().trim().min(1).max(64),
    /** L2-normalised 128-D probe. Never logged, never stored, never echoed. */
    descriptor: z
      .array(z.number().finite())
      .length(DESCRIPTOR_DIM, `Expected ${DESCRIPTOR_DIM} floats.`),
    metrics: ProbeMetrics,
  })
  .strict();

const FaceLoginBody = z.discriminatedUnion("action", [ChallengeRequest, VerifyRequest]);

// ── Identifier classification ───────────────────────────────────────────────
// The canonical copy lives in `auth-identify/index.ts` and is repeated in
// `webauthn-login/index.ts`; neither can be imported from here because both call
// `Deno.serve` at load. Keep all three in step: a code the login screen accepted
// at step 1 must resolve identically at step 2, whichever door it takes.

const CODE_RE = /^[A-Z]{1,6}[0-9]{1,10}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/;

export function classifyIdentifier(raw: string): { code: string | null; email: string | null } {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    return { code: null, email: EMAIL_RE.test(email) ? email : null };
  }
  const code = trimmed.replace(/[\s._-]+/g, "").toUpperCase();
  return { code: CODE_RE.test(code) ? code : null, email: null };
}

// ── Vector helpers (pure) ───────────────────────────────────────────────────

/** Postgres array literal, sent as text and cast — no driver type inference. */
export function toPgRealArray(values: readonly number[]): string {
  return `{${values.map((v) => (Object.is(v, -0) ? 0 : v)).join(",")}}`;
}

export function l2Norm(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum);
}

/** Unit-vector Euclidean distance → [0,1] confidence (migration 012: `1 − d / max_d`). */
export function confidenceFor(distance: number): number {
  return 1 - distance / MAX_UNIT_DISTANCE;
}

/** 32 random bytes, base64url — the same shape `@simplewebauthn` emits. */
function randomChallenge(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function numOr(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ── Rows ────────────────────────────────────────────────────────────────────

interface AccountRow {
  profile_id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  must_change_password: boolean;
  employee_id: string | null;
  employee_code: string | null;
  display_name: string | null;
  employment_status: string | null;
  /** Holds `manager`, `admin` or `super_admin` — face sign-in is refused. */
  is_privileged: boolean;
  /** An active, consented, un-purged template of the right dimension exists. */
  has_face_template: boolean;
  /**
   * `employees.allow_face_login` (migration 078) — the per-person switch the
   * employee, their manager or an admin can flip. Separate from CONSENT: consent is
   * permission to hold a template at all and lives in `secure.biometric_consents`;
   * this is permission to use it to open a session.
   */
  allow_face_login: boolean;
}

interface CandidateRow {
  template_id: string;
  employee_id: string;
  model_version: string;
  distance: string;
  candidate_set_size: number;
}

interface Candidate {
  templateId: string;
  employeeId: string;
  modelVersion: string;
  distance: number;
}

interface Thresholds {
  minConfidence: number;
  minMargin: number;
}

interface ServerConfig {
  descriptorModel: string;
  loginMaxDistance: number;
  livenessPass: number;
}

/**
 * ONE generic refusal for "no such identifier", "no approved face template",
 * "consent withdrawn" and "this account is too privileged for face sign-in".
 *
 * A 404 per spec-architecture §4 ("never exists-but-forbidden"): the caller
 * learns only that face sign-in is not available for what they typed, which is no
 * more than `auth-identify` already told them, and cannot use the refusal to
 * discover which accounts hold elevated access.
 */
function faceUnavailable(): never {
  throw notFound(
    "Face sign-in isn't available for that account. Use your password instead.",
    "FACE_LOGIN_NOT_AVAILABLE",
  );
}

/** ONE refusal for every way a match can fail — no oracle for WHICH gate refused. */
function faceNotVerified(): never {
  throw unprocessable(
    [{
      pointer: "/descriptor",
      code: "not_verified",
      detail: "This face did not verify against that account.",
    }],
    "We couldn't confirm it's you. Try again in better light, or use your password.",
    "FACE_VERIFICATION_FAILED",
  );
}

async function padToConstantTime(startedMs: number): Promise<void> {
  const remaining = CONSTANT_TIME_MS - (nowMs() - startedMs);
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

/**
 * The kill switch. `rollout_pct` and the `enabled_for_*` arrays are deliberately
 * NOT consulted: a sign-in path must be deterministic, and a percentage rollout
 * would mean an employee can sign in on one attempt and not the next.
 *
 * A missing row reads as DISABLED, which doubles as an interlock — a project that
 * deployed this function without migration 20260801012200 cannot record the login it
 * be granting, so it must not grant it.
 */
async function faceLoginEnabled(client: Sql): Promise<boolean> {
  const rows = await client<{ enabled: boolean }[]>`
    SELECT (f.is_enabled
            AND NOT f.kill_switch
            AND (f.expires_at IS NULL OR f.expires_at > now())) AS enabled
      FROM public.feature_flags f
     WHERE f.key = ${FEATURE_FLAG_KEY}
       AND f.deleted_at IS NULL
     LIMIT 1
  `;
  return firstRow(rows as unknown as { enabled: boolean }[])?.enabled === true;
}

/** Server-owned knobs, with the documented defaults when a setting is unset. */
async function loadConfig(client: Sql): Promise<ServerConfig> {
  const rows = await client<
    { descriptor_model: string | null; review_threshold: string | null; liveness_pass: string | null }[]
  >`
    SELECT app.setting('kiosk.descriptor_model')              AS descriptor_model,
           app.setting('attendance.face_review_threshold')    AS review_threshold,
           app.setting('attendance.liveness_pass_threshold')  AS liveness_pass
  `;
  const row = firstRow(
    rows as unknown as {
      descriptor_model: string | null;
      review_threshold: string | null;
      liveness_pass: string | null;
    }[],
  );
  return {
    descriptorModel: row?.descriptor_model ?? DEFAULT_DESCRIPTOR_MODEL,
    loginMaxDistance: numOr(row?.review_threshold ?? null, DEFAULT_LOGIN_MAX_DISTANCE),
    livenessPass: numOr(row?.liveness_pass ?? null, DEFAULT_LIVENESS_PASS),
  };
}

/**
 * Resolve `TT0042` or a work/login email to exactly one account, and answer the
 * two questions that decide whether face sign-in is offered at all.
 *
 * Service-role read: `public.employees`, `public.profiles`, `public.user_roles`
 * and `secure.face_templates` are all unreachable pre-auth (RLS + boundary B6).
 * The employee/profile resolution is `webauthn-login`'s, unchanged, so the two
 * doors cannot disagree about who `TT0042` is.
 */
async function resolveAccount(client: Sql, identifier: string): Promise<AccountRow | null> {
  const { code, email } = classifyIdentifier(identifier);
  if (code === null && email === null) return null;

  const rows = await client<AccountRow[]>`
    WITH input AS (
      SELECT ${code}::text AS code, ${email}::text AS email
    ),
    by_employee AS (
      SELECT e.profile_id
        FROM public.employees e
        CROSS JOIN input i
       WHERE e.deleted_at IS NULL
         AND e.profile_id IS NOT NULL
         AND (
               (i.code  IS NOT NULL AND e.employee_code = i.code)
            OR (i.email IS NOT NULL AND lower(e.work_email) = i.email)
         )
       ORDER BY (e.employment_status::text NOT IN ('exited', 'retired')) DESC,
                e.created_at DESC
       LIMIT 1
    )
    SELECT p.id                        AS profile_id,
           p.email,
           p.full_name,
           p.is_active,
           p.must_change_password,
           e.id                        AS employee_id,
           e.employee_code,
           e.display_name,
           e.employment_status::text    AS employment_status,
           EXISTS (
             SELECT 1
               FROM public.user_roles ur
              WHERE ur.user_id = p.id
                AND ur.revoked_at IS NULL
                AND ur.role IN ('manager', 'admin', 'super_admin')
           )                           AS is_privileged,
           EXISTS (
             SELECT 1
               FROM secure.face_templates t
               JOIN secure.biometric_consents c
                 ON c.id = t.consent_id
                AND c.granted
                AND c.withdrawn_at IS NULL
              WHERE t.employee_id = e.id
                AND t.is_active
                AND t.purged_at IS NULL
                AND t.descriptor_dim = ${DESCRIPTOR_DIM}
           )                           AS has_face_template,
           -- COALESCE: a profile with no employee row LEFT JOINs to NULL, and a NULL
           -- must not read as permission. assertFaceEligible refuses a null employee
           -- anyway, but a boolean that can arrive NULL is a trap for the next person
           -- to touch this query. No backticks in here: inside a tagged template a
           -- backtick in a SQL comment ENDS the literal, which is how this same
           -- mistake took down device auth once already.
           COALESCE(e.allow_face_login, false) AS allow_face_login
      FROM public.profiles p
      LEFT JOIN public.employees e
             ON e.profile_id = p.id AND e.deleted_at IS NULL
      CROSS JOIN input i
     WHERE p.id = (SELECT b.profile_id FROM by_employee b)
        OR (i.email IS NOT NULL AND lower(p.email) = i.email)
     ORDER BY (p.id = (SELECT b.profile_id FROM by_employee b)) DESC
     LIMIT 1
  ` as unknown as AccountRow[];

  return firstRow(rows);
}

/** 403 for a profile or employment state that cannot hold a session. */
function assertAccountUsable(account: AccountRow): void {
  const blocked = account.employment_status !== null &&
    (BLOCKED_EMPLOYMENT_STATUSES as readonly string[]).includes(account.employment_status);
  if (account.is_active !== true || blocked) {
    // No incremental disclosure: `auth-identify` returns `portalState:'suspended'`
    // for exactly this account, and the PRD specifies this copy for it.
    throw forbidden("This account is not active. Please contact HR.", "ACCOUNT_DISABLED");
  }
}

/**
 * Face sign-in is offered only to a plain employee account that has a live,
 * consented template. Everything else gets the ONE generic refusal.
 */
function assertFaceEligible(account: AccountRow): string {
  /*
    `allow_face_login` joins the SAME generic refusal as every other gate, and that is
    deliberate. Telling a caller "face sign-in is switched off for this account" would
    confirm the account exists and hand an attacker a probe for which accounts are
    worth attacking. The person who turned the switch off already knows they did; the
    screen that owns the switch says so in words, where the reader is authenticated.

    `is_privileged` is NO LONGER a refusal. It now selects the stricter thresholds in
    `resolveThresholds` instead — see PRIVILEGED_MIN_CONFIDENCE. The switch is still the
    gate: a privileged holder who has not enabled face sign-in is refused like anybody
    else, and an admin can turn it off for them.
  */
  if (!account.has_face_template || !account.allow_face_login || account.employee_id === null) {
    faceUnavailable();
  }
  return account.employee_id;
}

// ── 1:N match — `kiosk-punch`'s query, unchanged ────────────────────────────

/**
 * Exact sequential 1:N scan over every ACTIVE, consented, un-purged template.
 * Returns the three nearest plus the true size of the candidate set.
 *
 * Verbatim from `kiosk-punch/index.ts` (minus the columns a login has no use
 * for): the consent join is the DPDP gate, and `count(*) OVER ()` is evaluated
 * after GROUP BY and before LIMIT, so it is the real N the `face_match_log` row
 * has to record.
 *
 * WHY THE MATCH IS SQL, NOT TYPESCRIPT — pulling ~2,000 × 128 floats into the
 * isolate is ~1 MB per attempt. The distance is computed in Postgres, exactly:
 * spec-kiosk §3.1 is explicit that margin correctness must never be
 * probabilistic, and the margin is what stands between a lookalike and somebody
 * else's session.
 */
async function findCandidates(
  client: Sql,
  descriptor: readonly number[],
): Promise<{ candidates: Candidate[]; candidateSetSize: number }> {
  const rows = await client<CandidateRow[]>`
    WITH probe AS (SELECT ${toPgRealArray(descriptor)}::real[] AS d)
    SELECT t.id                        AS template_id,
           t.employee_id               AS employee_id,
           t.model_version             AS model_version,
           sqrt(sum(power(x.a::double precision - x.b::double precision, 2)))::numeric(8,5) AS distance,
           (count(*) OVER ())::integer AS candidate_set_size
      FROM probe p
      CROSS JOIN secure.face_templates t
      JOIN public.employees e
        ON e.id = t.employee_id
       AND e.deleted_at IS NULL
      JOIN secure.biometric_consents c
        ON c.id = t.consent_id
       AND c.granted
       AND c.withdrawn_at IS NULL
      CROSS JOIN LATERAL unnest(t.descriptor, p.d) AS x(a, b)
     WHERE t.is_active
       AND t.purged_at IS NULL
       AND t.descriptor_dim = ${DESCRIPTOR_DIM}
     GROUP BY t.id, t.employee_id, t.model_version
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
      distance: Number(r.distance),
    })),
  };
}

/**
 * Thresholds for THIS decision: the employee's own `attendance_policies` row and
 * the login ceiling. The STRICTEST wins — a policy row tuned to keep a queue
 * moving at a badly-lit gate must never loosen a login (the same `Math.max`
 * `kiosk-punch` applies to a device floor, with the login ceiling in the place of
 * the device).
 */
async function resolveThresholds(
  client: Sql,
  employeeId: string,
  loginMaxDistance: number,
  isPrivileged: boolean,
): Promise<Thresholds> {
  const rows = await client`
    SELECT ap.min_confidence_for_auto_accept,
           ap.min_margin_for_auto_accept
      FROM public.attendance_policies ap
     WHERE ap.id = public.resolve_policy('attendance_policy', ${employeeId}::uuid, util.ist_today())
       AND ap.deleted_at IS NULL
     LIMIT 1
  `;
  const row = firstRow(rows as unknown as Record<string, unknown>[]);
  const policyMinConfidence = row === null
    ? DEFAULT_MIN_CONFIDENCE
    : Number(row.min_confidence_for_auto_accept);
  const policyMinMargin = row === null
    ? DEFAULT_MIN_MARGIN
    : Number(row.min_margin_for_auto_accept);
  return {
    minConfidence: Math.max(
      Number.isFinite(policyMinConfidence) ? policyMinConfidence : DEFAULT_MIN_CONFIDENCE,
      confidenceFor(loginMaxDistance),
      // A privileged account raises the floor and can never lower it: it joins the
      // same Math.max as everything else, so a loose policy row cannot talk it down.
      isPrivileged ? PRIVILEGED_MIN_CONFIDENCE : 0,
    ),
    // The SAME `Math.max` rule as the confidence above, and for the same reason:
    // `min_margin_for_auto_accept` is `ck_ap__confidence`-bounded to [0,1], so a
    // policy row tuned to keep a badly-lit queue moving may legally set it to 0 —
    // and a login accepted with zero margin is a login granted while a stranger
    // stood at the same distance as the claimed employee. spec-kiosk §3.1's
    // documented 0.06 is therefore the FLOOR here, never the value a policy can
    // talk the login gate down from. Without it the "policy can only make it
    // stricter" promise in this file's header held for one of the two thresholds.
    minMargin: Math.max(
      Number.isFinite(policyMinMargin) ? policyMinMargin : DEFAULT_MIN_MARGIN,
      DEFAULT_MIN_MARGIN,
      isPrivileged ? PRIVILEGED_MIN_MARGIN : 0,
    ),
  };
}

// ── secure.face_match_log ───────────────────────────────────────────────────

interface MatchLogInput {
  id: string;
  candidateSetSize: number;
  /**
   * A subset of `ck_face_match_log__outcome`: the five this endpoint can reach.
   * `no_face` / `multiple_faces` are decided on-device before a descriptor exists,
   * and `duplicate_suppressed` is a debounce concept that belongs to a punch.
   */
  outcome: "matched" | "no_match" | "ambiguous" | "liveness_failed" | "low_quality";
  matchedEmployeeId: string | null;
  bestDistance: number | null;
  bestConfidence: number | null;
  runnerUpEmployeeId: string | null;
  runnerUpDistance: number | null;
  margin: number | null;
  candidateScores: unknown;
  thresholdUsed: number;
  modelVersion: string;
  detectorScore: number | null;
  livenessScore: number | null;
  latencyMs: number;
  ip: string | null;
  appVersion: string | null;
  errorDetail: string | null;
}

/**
 * The row that makes a disputed sign-in defensible. `threshold_used` is pinned
 * here so a later threshold change cannot rewrite history, and
 * `candidate_scores` — which names other employees — never leaves the server.
 *
 * `kiosk_device_id`, `operator_id`, `capture_photo_path` and `produced_punch_id`
 * are NULL by construction: a browser is not a paired kiosk, no guard is present,
 * no image is accepted, and a login is not a punch.
 */
async function insertMatchLog(tx: Sql, input: MatchLogInput): Promise<string> {
  const round = (v: number | null): number | null => (v === null ? null : Number(v.toFixed(5)));
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
      NULL::text,
      ${Math.trunc(input.latencyMs)}::integer,
      NULL::uuid,
      ${input.ip}::inet,
      ${input.appVersion}::text,
      ${input.errorDetail}::text
    )
    RETURNING id
  `;
  return (rows as unknown as { id: string }[])[0]?.id as string;
}

/**
 * A refused attempt on the audit CHAIN only — never in `public.sessions_audit`.
 * See the account-lockout note at the top of this file.
 *
 * Best-effort: a login refusal must not become a 500 because an audit write
 * failed. The refusal itself is already returned, logged, and — for anything that
 * touched a descriptor — recorded in `secure.face_match_log`.
 */
async function recordFailure(
  ctx: RequestContext,
  account: AccountRow,
  failureReason: string,
  matchLogId: string | null,
): Promise<void> {
  try {
    await withContext(
      { ...ctx, reason: `face sign-in refused: ${failureReason}` },
      async (tx) => {
        await writeAudit(tx, ctx, {
          action: "login_failed",
          entityTable: "public.profiles",
          entityId: account.profile_id,
          entityLabel: account.email,
          subjectEmployeeId: account.employee_id,
          fieldName: "auth.login.failed",
          newValue: {
            method: "face",
            failure_reason: failureReason,
            face_match_log_id: matchLogId,
          },
          isRedacted: true,
          reason: `face sign-in refused: ${failureReason}`,
        });
      },
    );
  } catch {
    // Swallowed on purpose. Nothing actionable, and the caller already has an
    // answer; the structured log line for this request records the refusal.
  }
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
  const startedMs = nowMs();

  let status = 500;
  let padConstantTime = false;

  try {
    assertOriginAllowed(req);
    const client = sqlHandle();
    const ip = clientIpFrom(req);
    const appVersion = (req.headers.get("x-app-version") ?? "").trim().slice(0, 40) || null;

    // ── STEP 4 · Auth ─────────────────────────────────────────────────────────
    // NONE — this is how a session is obtained in the first place. The anon key
    // the Supabase gateway checked is public (boundary B2) and is not authority.
    // The face descriptor verified below is the only authentication that happens,
    // and the header of this file is explicit about how much that is worth.

    // ── STEP 5 · Authority ────────────────────────────────────────────────────
    // Not applicable pre-auth. Capabilities are re-derived from the DB on the
    // FIRST authenticated call after the session exists, never here. The one
    // authority question asked at this stage is the inverse, and it no longer refuses:
    // an account with elevated access may use this door, but only at the stricter
    // thresholds in `resolveThresholds` (PRIVILEGED_MIN_CONFIDENCE / _MARGIN).

    // ── STEP 6 · Rate limit, per IP ───────────────────────────────────────────
    // FIRST, before the flag read and before the body is parsed, and outside any
    // transaction: a refused attempt must still spend its token, or the limit is
    // free to bypass by making requests that fail — and an abusive caller must
    // not get a free database query per request either.
    await enforce(LIMIT_PER_IP, limitKey(FN_NAME, "ip", ip), "FACE_LOGIN_RATE_LIMITED", client);

    // The kill switch, checked before the body is read: when face sign-in is off,
    // no descriptor should even come off the wire.
    if (!(await faceLoginEnabled(client))) {
      throw unavailable(
        "Face sign-in is switched off. Use your password or fingerprint.",
        "FACE_LOGIN_DISABLED",
      );
    }

    // ── STEP 7 · Validate ─────────────────────────────────────────────────────
    const { data: body } = await parseBody(req, FaceLoginBody, { maxBytes: MAX_BODY_BYTES });

    // ── STEP 6 (b) · Rate limit, per identifier ───────────────────────────────
    // Out of order because the key is the parsed body. Hashed and normalised, so
    // `app.rate_limit_buckets` never holds a list of real employee emails and
    // `TT0042` / `tt 0042` share one budget instead of getting two.
    const classified = classifyIdentifier(body.identifier);
    const identifierNormalised = classified.code ?? classified.email ??
      body.identifier.trim().toLowerCase();
    const identifierHash = await sha256Hex(identifierNormalised);
    await enforce(
      LIMIT_PER_IDENTIFIER,
      limitKey(FN_NAME, "id", identifierHash.slice(0, 32)),
      "FACE_LOGIN_RATE_LIMITED",
      client,
    );

    const config = await loadConfig(client);
    const account = await resolveAccount(client, body.identifier);

    // ═════════════════════════════════════════════════════════════════════════
    // action = challenge
    // ═════════════════════════════════════════════════════════════════════════
    if (body.action === "challenge") {
      // Timing is padded on this leg: it is the one that answers a question about
      // whether an account exists.
      padConstantTime = true;

      if (account === null) faceUnavailable();
      assertAccountUsable(account);
      assertFaceEligible(account);

      // ── STEPS 9 + 10 · set_context + ONE transaction ────────────────────────
      // `actorId` stays NULL: resolving an identifier is not proof of identity,
      // and stamping this write with the profile id would assert something the
      // caller has not yet demonstrated.
      const ctx: RequestContext = {
        actorId: null,
        actorRole: null,
        source: "web_employee",
        sourceRoute: FN_NAME,
        requestId,
        ip,
        ua: userAgentFrom(req),
        reason: "face sign-in challenge issued at the login screen",
      };

      const challenge = randomChallenge();
      const issued = await withContext(ctx, async (tx) => {
        // One live challenge per identifier: a second tab must invalidate the
        // first, or two ceremonies race for one account.
        await tx`
          UPDATE secure.webauthn_challenges c
             SET consumed_at = now()
           WHERE c.lookup = ${account.email}
             AND c.purpose = 'face_login'
             AND c.consumed_at IS NULL
        `;
        const inserted = await tx<{ id: string; expires_at: Date }[]>`
          INSERT INTO secure.webauthn_challenges (lookup, challenge, purpose, expires_at)
          VALUES (
            ${account.email},
            ${challenge},
            'face_login',
            now() + make_interval(secs => ${CEREMONY_TIMEOUT_MS / 1000}::double precision)
          )
          RETURNING id, expires_at
        `;
        return firstRow(inserted as unknown as { id: string; expires_at: Date }[]);
      });

      if (issued === null) throw new Error("face challenge insert returned no row");

      status = 200;
      log.info("face challenge issued", {
        challenge_id: issued.id,
        // The identifier itself is never logged; its hash is the join key.
        identifier_sha256: identifierHash.slice(0, 16),
      });
      // Response allowlist. The thresholds this server will gate on are NOT
      // returned: they are the numbers a forged payload would be tuned against,
      // and a well-behaved client does not need them — it sends what it measured
      // and the server decides.
      return ok(
        {
          action: "challenge" as const,
          challenge,
          /** The model the client MUST have produced the descriptor with. */
          descriptorModel: config.descriptorModel,
          descriptorDim: DESCRIPTOR_DIM,
          expiresAt: toIso(issued.expires_at),
          requestId,
        },
        { status, headers: cors, requestId },
      );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // action = verify
    // ═════════════════════════════════════════════════════════════════════════

    // ── STEP 8 · Idempotency ────────────────────────────────────────────────
    // Deliberately NO claim, for the two reasons `webauthn-login` gives:
    //   1. the response contains a live single-use session credential, and
    //      `public.idempotency_keys.response` is a jsonb column with a 24-hour
    //      life — storing it there would keep a usable login token at rest for a
    //      day, a strictly worse trade than repeating a two-second ceremony;
    //   2. it is not needed. The challenge row IS the single-use guard, and a
    //      replayed verify gets 410 — the honest answer: that attempt is spent.

    if (account === null) faceUnavailable();
    assertAccountUsable(account);
    const employeeId = assertFaceEligible(account);

    const auditCtx: RequestContext = {
      actorId: null,
      actorRole: null,
      source: "web_employee",
      sourceRoute: FN_NAME,
      requestId,
      ip,
      ua: userAgentFrom(req),
      reason: "face verification at sign-in",
    };

    // ── Consume the challenge FIRST, in its own transaction ──────────────────
    // Spend it before any biometric work: a failed attempt must not leave a live
    // challenge behind, or the failure becomes a retry oracle and one challenge
    // funds an unlimited number of probes.
    const spent = await withContext(auditCtx, async (tx) => {
      const consumed = await tx<{ id: string }[]>`
        UPDATE secure.webauthn_challenges c
           SET consumed_at = now()
         WHERE c.id = (
                 SELECT c2.id
                   FROM secure.webauthn_challenges c2
                  WHERE c2.lookup = ${account.email}
                    AND c2.purpose = 'face_login'
                    AND c2.challenge = ${body.challenge}
                    AND c2.consumed_at IS NULL
                    AND c2.expires_at > now()
                  ORDER BY c2.recorded_at DESC
                  LIMIT 1
               )
           -- In the OUTER predicate so Postgres re-checks it after waiting on a
           -- concurrent updater: this is what makes the challenge single-use.
           AND c.consumed_at IS NULL
        RETURNING c.id
      `;
      return firstRow(consumed as unknown as { id: string }[]);
    });

    if (spent === null) {
      throw gone(
        "This sign-in attempt has expired. Try again.",
        "FACE_CHALLENGE_INVALID",
      );
    }

    // Descriptor model equality (spec-kiosk §1). A descriptor from another model
    // is not a smaller number — it is a meaningless one, and every distance
    // computed from it would be a lie told with five decimal places.
    if (body.descriptorModel !== config.descriptorModel) {
      throw unprocessable(
        [{
          pointer: "/descriptorModel",
          code: "model_mismatch",
          detail: `This server matches ${config.descriptorModel}. Reload the app and try again.`,
        }],
        "Face model does not match the server's.",
        "KIOSK_DESCRIPTOR_MODEL_MISMATCH",
      );
    }

    // Descriptor sanity. A non-unit vector means the client skipped L2
    // normalisation, and every distance computed from it is on a different scale.
    const norm = l2Norm(body.descriptor);
    if (Math.abs(norm - 1) > DESCRIPTOR_NORM_TOLERANCE) {
      throw unprocessable(
        [{
          pointer: "/descriptor",
          code: "not_normalised",
          detail: "Descriptor must be L2-normalised before sending.",
        }],
        "The face descriptor is not unit length.",
        "KIOSK_DESCRIPTOR_INVALID",
      );
    }

    // Thresholds are resolved BEFORE the gates below so that every
    // `face_match_log` row — including a refusal — can pin the threshold that
    // was in force at the moment of the decision (`threshold_used` is NOT NULL).
    const thresholds = await resolveThresholds(
      client,
      employeeId,
      config.loginMaxDistance,
      account.is_privileged,
    );

    /** One place that writes the evidence row, whatever the outcome (INV-4). */
    const logAttempt = async (
      input: Omit<MatchLogInput, "id" | "thresholdUsed" | "latencyMs" | "ip" | "appVersion">,
    ): Promise<string> => {
      const matchLogId = crypto.randomUUID();
      await withContext({ ...auditCtx, reason: null }, async (tx) => {
        await insertMatchLog(tx, {
          ...input,
          id: matchLogId,
          thresholdUsed: thresholds.minConfidence,
          latencyMs: log.elapsedMs(),
          ip,
          appVersion,
        });
      });
      return matchLogId;
    };

    // ── Quality + liveness gates (spec-kiosk §1.1 scan column, §1.2) ─────────
    // Refused BEFORE the 1:N scan: if the frame is not a live face there is no
    // reason to process the biometric any further, and data minimisation is not
    // optional for biometric data. The attempt is still recorded, with N = 0 —
    // the honest count of templates this probe was compared against.
    if (body.metrics.detectionScore < MIN_DETECTION_SCORE) {
      const matchLogId = await logAttempt({
        candidateSetSize: 0,
        outcome: "low_quality",
        matchedEmployeeId: null,
        bestDistance: null,
        bestConfidence: null,
        runnerUpEmployeeId: null,
        runnerUpDistance: null,
        margin: null,
        candidateScores: [],
        modelVersion: config.descriptorModel,
        detectorScore: body.metrics.detectionScore,
        livenessScore: body.metrics.livenessScore,
        errorDetail: `detection_score=${body.metrics.detectionScore} < ${MIN_DETECTION_SCORE}`,
      });
      await recordFailure(auditCtx, account, "low_quality", matchLogId);
      throw unprocessable(
        [{
          pointer: "/metrics/detectionScore",
          code: "low_quality",
          detail: "The camera did not get a clear enough view of a face.",
        }],
        "Move into better light and fill the frame with your face, then try again.",
        "FACE_QUALITY_REJECTED",
      );
    }

    if (body.metrics.livenessScore < config.livenessPass) {
      const matchLogId = await logAttempt({
        candidateSetSize: 0,
        outcome: "liveness_failed",
        matchedEmployeeId: null,
        bestDistance: null,
        bestConfidence: null,
        runnerUpEmployeeId: null,
        runnerUpDistance: null,
        margin: null,
        candidateScores: [],
        modelVersion: config.descriptorModel,
        detectorScore: body.metrics.detectionScore,
        livenessScore: body.metrics.livenessScore,
        errorDetail: `liveness_score=${body.metrics.livenessScore} < ${config.livenessPass}`,
      });
      await recordFailure(auditCtx, account, "liveness_failed", matchLogId);
      // The kiosk escalates a liveness failure to a guard who is physically
      // present (spec-kiosk §1.2, decision 5.2.1: a liveness failure must never
      // permanently block a real person). There is nobody standing beside a
      // browser, so the escalation path here is the password field — which is
      // always available and is what the copy points at.
      throw unprocessable(
        [{
          pointer: "/metrics/livenessScore",
          code: "liveness_failed",
          detail: "The camera could not confirm a live person.",
        }],
        "Please look directly at the camera — no photos or phone screens. Or use your password.",
        "FACE_LIVENESS_FAILED",
      );
    }

    // ── The match ────────────────────────────────────────────────────────────
    const { candidates, candidateSetSize } = await findCandidates(client, body.descriptor);
    const best = candidates[0];
    const runnerUp = candidates[1];

    const bestDistance = best?.distance ?? null;
    const bestConfidence = bestDistance === null ? null : confidenceFor(bestDistance);
    const margin = bestDistance !== null && runnerUp !== undefined
      ? runnerUp.distance - bestDistance
      : null;
    const marginOk = margin === null || margin >= thresholds.minMargin;

    // Top-3 distances stay SERVER-SIDE (spec-kiosk §4.2: raw distances are never
    // returned). Rounded to the column's scale so the log and the row agree.
    const candidateScores = candidates.map((c, i) => ({
      rank: i + 1,
      employee_id: c.employeeId,
      template_id: c.templateId,
      distance: Number(c.distance.toFixed(5)),
    }));

    /**
     * The accept rule, in one expression, and every clause is load-bearing:
     *   · a candidate exists at all;
     *   · it is THE CLAIMED EMPLOYEE — this is what makes the operation a 1:1
     *     confirmation rather than "log in whoever this looks like";
     *   · it clears the strictest of policy confidence and the login ceiling;
     *   · nobody else is within the margin, so a lookalike cannot ride in.
     */
    const identityMatches = best !== undefined && best.employeeId === employeeId;
    const accepted = identityMatches &&
      bestConfidence !== null &&
      bestConfidence >= thresholds.minConfidence &&
      marginOk;

    if (!accepted) {
      const withinFar = bestDistance !== null && bestDistance <= FAR_DISTANCE;
      const reason = best === undefined
        ? "no_template_in_search_space"
        : !identityMatches
        ? "identity_mismatch"
        : !marginOk
        ? "margin_too_small"
        : "below_threshold";

      const matchLogId = await logAttempt({
        candidateSetSize,
        // The same vocabulary the gate uses: a near candidate that the server
        // would not accept unaided is `ambiguous`; nothing near is `no_match`.
        // `matched_employee_id` stays NULL — nobody was identified, and writing
        // the nearest stranger there would read as "this person signed in".
        outcome: withinFar ? "ambiguous" : "no_match",
        matchedEmployeeId: null,
        bestDistance,
        bestConfidence,
        runnerUpEmployeeId: runnerUp?.employeeId ?? null,
        runnerUpDistance: runnerUp?.distance ?? null,
        margin,
        candidateScores,
        modelVersion: best?.modelVersion ?? config.descriptorModel,
        detectorScore: body.metrics.detectionScore,
        livenessScore: body.metrics.livenessScore,
        errorDetail: `${reason}; claim=${account.employee_code ?? account.email}`,
      });
      await recordFailure(auditCtx, account, reason, matchLogId);

      log.warn("face sign-in refused", {
        reason,
        candidate_set_size: candidateSetSize,
        face_match_log_id: matchLogId,
        identifier_sha256: identifierHash.slice(0, 16),
      });
      // ONE refusal for all four reasons: the caller must not be able to tell
      // "not you" from "not confident" from "somebody else was closer", which
      // would otherwise be a hill-climbing signal for a crafted descriptor.
      faceNotVerified();
    }

    // Accepted. Record the biometric decision BEFORE minting a session, so a
    // mint failure cannot lose the evidence of what was presented and accepted.
    const matchLogId = await logAttempt({
      candidateSetSize,
      outcome: "matched",
      matchedEmployeeId: employeeId,
      bestDistance,
      bestConfidence,
      runnerUpEmployeeId: runnerUp?.employeeId ?? null,
      runnerUpDistance: runnerUp?.distance ?? null,
      margin,
      candidateScores,
      modelVersion: best?.modelVersion ?? config.descriptorModel,
      detectorScore: body.metrics.detectionScore,
      livenessScore: body.metrics.livenessScore,
      errorDetail: null,
    });

    // ── Mint the session (Supabase Auth admin API) ───────────────────────────
    // OUTSIDE any transaction: an HTTP call has no business holding a Postgres
    // transaction open.
    const link = await serviceClient().auth.admin.generateLink({
      type: "magiclink",
      email: account.email,
    });
    const tokenHash = link.data?.properties?.hashed_token ?? null;
    if (link.error !== null || tokenHash === null || tokenHash === "") {
      log.error("could not mint a session token", { err: link.error });
      await recordFailure(auditCtx, account, "session_mint_failed", matchLogId);
      throw badGateway(
        "Your face was recognised but the session could not be created. Try again.",
        "AUTH_SESSION_MINT_FAILED",
      );
    }

    // ── STEPS 9 + 10 · set_context + ONE transaction, audit inside it ────────
    // Now the actor IS known, so the session events are attributed to them.
    // `login_success` also drives `sessions_audit_apply_event()`:
    // `profiles.last_login_at` moves and `failed_login_count` resets, which is
    // why the SUCCESS path writes `sessions_audit` and the failure path does not.
    const successCtx: RequestContext = {
      ...auditCtx,
      actorId: account.profile_id,
      reason: "face sign-in verified against the enrolled template",
    };
    await withContext(successCtx, async (tx) => {
      // ONE row, not the `passkey_used` + `login_success` pair `webauthn-login`
      // writes. There is no `face_used` event and adding one was refused on
      // purpose: it would carry nothing `auth_method = 'face'` does not already
      // say, and four src/ consumers hardcode the ten-value `event` vocabulary —
      // one of them with a strict `z.enum`, which would then throw in the
      // employee's own Security page. The full argument is in
      // 20260801012200_face_login_auth_channel.sql.
      await auditSession(tx, successCtx, {
        event: "login_success",
        profileId: account.profile_id,
        attemptedEmail: account.email,
        authMethod: "face",
      });
      // The DPDP-facing row: "this employee's biometric was processed, at this
      // time, to authenticate them". `face_match_log` is service-role-only, so
      // without this the employee's own audit trail and the security console
      // would show a login with no trace of the biometric behind it. Redacted
      // and metric-free by design: no descriptor, no distance, no threshold —
      // those live in the match-log row this one points at.
      await writeAudit(tx, successCtx, {
        action: "read_sensitive",
        entityTable: "secure.face_templates",
        entityId: best?.templateId ?? null,
        entityLabel: "auth.face.verified",
        subjectEmployeeId: employeeId,
        fieldName: "auth.face.verified",
        newValue: {
          face_match_log_id: matchLogId,
          model_version: best?.modelVersion ?? config.descriptorModel,
          liveness_model: body.metrics.livenessModel ?? null,
          frames_analysed: body.metrics.framesAnalysed ?? null,
        },
        isRedacted: true,
      });
    });

    /**
     * The client's next call is:
     *
     *   supabase.auth.verifyOtp({ token_hash: tokenHash, type: verificationType })
     *
     * `tokenHash` is a live single-use credential in a `no-store` response. It is
     * not stored by us, and `log.ts`'s redactor drops any field whose name
     * matches /token/ — so it cannot reach a log line by accident either.
     *
     * RESPONSE ALLOW-LIST. Present: what the browser needs to open the session
     * and greet the employee. Absent by construction: the descriptor, the
     * distance, the confidence, the threshold, the candidate set size, any other
     * employee's identity, and every HR field.
     */
    const responseBody = {
      action: "verify" as const,
      verified: true,
      tokenHash,
      verificationType: "magiclink" as const,
      email: account.email,
      /**
       * Safe to disclose HERE and only here: the caller has just verified against
       * this account's template. `auth-identify` withholds it pre-auth on purpose.
       */
      mustChangePassword: account.must_change_password === true,
      displayName: account.display_name ?? account.full_name,
      requestId,
    };
    status = 200;

    // ── STEP 11 · Store under the idempotency key ───────────────────────────
    // Not applicable — see step 8. Nothing about this response is replayable.

    log.info("face sign-in verified", {
      profile_id: account.profile_id,
      employee_id: employeeId,
      face_match_log_id: matchLogId,
      candidate_set_size: candidateSetSize,
    });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;
    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // Constant time only on the leg that answers an existence question; see the
    // note on CONSTANT_TIME_MS. An `await` in `finally` delays the returned
    // response, which is exactly what is wanted.
    if (padConstantTime) await padToConstantTime(startedMs);

    // ── STEP 12 · One structured log line per invocation ─────────────────────
    log.finish(status);
  }
});

/** Exported for `supabase/tests` — the same schemas and helpers the handler uses. */
export { ChallengeRequest, FaceLoginBody, VerifyRequest };
