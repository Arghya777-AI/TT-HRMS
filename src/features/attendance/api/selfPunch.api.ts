/**
 * selfPunch.api.ts — the employee's own web punch: the three network calls it
 * needs, and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY AN EDGE FUNCTION AND NOT AN INSERT
 * ─────────────────────────────────────────────────────────────────────────────
 * `public.attendance_punches` is append-only (trigger
 * `attendance_punches_append_only`), partitioned by `punched_at`, and grants
 * `authenticated` SELECT only — INSERT is `service_role`. A punch therefore
 * CANNOT be written from the browser, by design: it goes through
 * `attendance-self-punch`, which holds the service key, runs the 1:1 face
 * confirmation against the caller's OWN `secure.face_templates` row — the
 * identity comes from the JWT, never from this body, so there is no candidate set
 * and no way to punch as somebody else — writes `secure.face_match_log`, checks the
 * DPDP consent row and resolves the geofence against
 * `public.locations.geofence_radius_m`. Everything that matters is decided there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SERVER DECIDES THE DIRECTION. THIS FILE ONLY PREDICTS THE LABEL.
 * ─────────────────────────────────────────────────────────────────────────────
 * `kiosk-punch` stores `direction = 'undetermined'` and the attendance engine
 * derives IN/OUT afterwards (first scan of the business date is the arrival, the
 * last is the departure — §3.1). So there is no column that says "your next
 * punch is an OUT". `fetchSelfPunchState` reads the punch log the employee can
 * already see on their own timeline and asks the server which day is in progress,
 * so the button can say which direction the employee is about to record: the first
 * scan of that day is an arrival, every later one a departure. That prediction is
 * NEVER shown as the outcome: `selfPunch()` returns the server's `direction` and
 * that is what the confirmation renders.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REFUSALS ARE DATA, AND A RECORDED PUNCH IS NEVER REPORTED AS A FAILURE
 * ─────────────────────────────────────────────────────────────────────────────
 * `selfPunch` resolves — it does not throw — so the card degrades to a sentence.
 * Two outcomes exist precisely because a punch is a write that may have landed
 * even when the browser cannot read the answer:
 *   · `already_recorded` — a 409 carrying `idempotent_replay`. Kept because
 *     `TTApiError.isIdempotentReplay` is the repo-wide convention, but note that
 *     THIS function does not take that route: `_shared/idempotency.ts` replays a
 *     completed key by re-serving the ORIGINAL 200 body (plus `replayed: true`),
 *     and a punch whose `clientEventId` already exists is answered 200 from
 *     `replayedResult`. So a double-send lands in `recorded` with the original
 *     punch's own values — which is the better screen anyway. The 409s this
 *     function really emits are `IDEMPOTENCY_KEY_REUSED`, `REQUEST_IN_PROGRESS`
 *     and `SELF_PUNCH_FACE_NOT_ENROLLED`, all handled by `refuse`.
 *   · `unreadable` — 2xx whose body we could not parse. The punch probably
 *     exists, so the copy tells the employee to check their punches rather than
 *     claiming a failure and inviting a duplicate.
 * Where the server wrote user-facing copy (`problem.detail`) that copy wins: it
 * is more specific than ours and it was written by the side that refused.
 */
import { z } from "zod";
import { invokeEdgeFn, TTApiError } from "@/shared/api/invoke";
import { dbDate, dbUuid, rpcOne, selectOne } from "@/shared/api/query";
import { addIstDays, istToday, nowInstantIso } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { toPunchGeo, type SignInGeo } from "@/features/auth/lib/geolocation";
import {
  fetchPunchDuplicateFlags,
  fetchPunchesInRange,
  MY_EMPLOYEE_VIEW,
  type AttendancePunch,
} from "./attendance.api";

/** Catalogue name of the function this module calls. */
export const SELF_PUNCH_FN = "attendance-self-punch";

// -----------------------------------------------------------------------------
// 1. Entitlement — may this employee punch from the web at all?
// -----------------------------------------------------------------------------

/**
 * Read from `v_my_employee`, which is pinned to `app.current_employee_id()`, so
 * these two booleans can only ever be the caller's own.
 *
 * `employees.allow_web_punch` and `allow_mobile_selfie_punch` are both
 * `NOT NULL DEFAULT false` (migration 20260801000800_employees.sql §75-76): the
 * web punch is opt-in per employee, granted by HR. The card reads it to decide
 * whether to offer the button — the function re-checks it, so this is UX.
 */
export const selfPunchEligibilitySchema = z.object({
  id: dbUuid,
  display_name: z.string(),
  allow_web_punch: z.boolean(),
  allow_mobile_selfie_punch: z.boolean(),
});

export type SelfPunchEligibility = z.infer<typeof selfPunchEligibilitySchema>;

/** `null` = no employee row on this login (kiosk-only staff): no punch button. */
export function fetchSelfPunchEligibility(
  signal?: AbortSignal,
): Promise<SelfPunchEligibility | null> {
  return selectOne(MY_EMPLOYEE_VIEW, selfPunchEligibilitySchema, [], {
    columns: "id, display_name, allow_web_punch, allow_mobile_selfie_punch",
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Current state — what the button should say
// -----------------------------------------------------------------------------

/** What the next punch will be, as predicted from the punches already recorded. */
export type NextDirection = "in" | "out";

export interface SelfPunchState {
  /**
   * The business date a scan made RIGHT NOW would be filed under — the server's
   * answer, from `my_punch_business_date()`. Usually today; the previous date for
   * somebody working a shift that crosses midnight, before its cutover. `null`
   * only when the caller has no employee row at all.
   */
  businessDate: string | null;
  /** Punches on that business date, duplicates and voids already excluded. */
  punchCount: number;
  /** The most recent punch instant on that date, for "last scan 09:14". */
  lastPunchAt: string | null;
  /**
   * The FIRST counted punch on that date — the arrival.
   *
   * Needed for anything live: "working for 6h 12m" is measured from when they actually arrived,
   * and `lastPunchAt` cannot answer it. Already available here, since the counted list is built
   * a few lines below; it was simply not being returned.
   */
  firstPunchAt: string | null;
  /**
   * Every COUNTED punch instant on that date, ascending.
   *
   * The card pairs these into sessions, which is the only way to say "two sessions, six hours"
   * for a 9-to-1-then-7-to-9 day. `firstPunchAt` and `lastPunchAt` cannot express it, and the
   * list is already in hand a few lines below — it was simply being thrown away.
   */
  punchInstants: readonly string[];
  /**
   * Would a punch made RIGHT NOW be outside the shift window, and so need a reason?
   *
   * Asked of `punch_within_shift`, the same function the endpoint calls, rather than derived
   * here. The card only needs it to decide whether to show the box before capturing — the
   * server still refuses a punch that actually needed one, so a stale answer costs a retry and
   * never a wrong record.
   *
   * `false` when the check could not be made, so the box stays hidden: prompting somebody for
   * a justification because a lookup failed is worse than the server asking for it a moment
   * later, with the reason it was needed.
   */
  needsOffHoursReason: boolean;
  /** What the next scan will be recorded as, by parity — see `nextDirectionAfter`. */
  next: NextDirection;
}

/**
 * THE RULE, in one place: PARITY. An even number of counted scans means the next one is an
 * arrival, an odd number means a departure.
 *
 * ── THIS REVERSED A DELIBERATE DECISION, SO HERE IS WHY ──────────────────────
 * It used to be "the first scan is the arrival and every scan after it is a departure", and the
 * comment here argued against parity in exactly these words: "a day with three scans has one
 * arrival, not two".
 *
 * That held while a day was one stretch of work. It does not hold for the venue's
 * 9-to-1-then-7-to-9 day, and the old rule's failure on it was visible on the card: somebody
 * back for an evening shift, having already punched out at lunch, was offered "Punch out" — of
 * a day they had left four hours earlier.
 *
 * The engine agrees with parity here, which is the part that matters. It deducts the INTERIOR
 * gap between the second and third scans as a break, so 09:00/13:00/19:00/21:00 is six hours
 * both ways: 21:00−09:00 less the 13:00→19:00 gap, and (13:00−09:00)+(21:00−19:00).
 *
 * ── AND IT CHANGES ONLY THE LABEL ────────────────────────────────────────────
 * Every punch in this system is stored `direction = 'undetermined'` — all 1,188 of them — and
 * the server decides the response's direction itself. So this function feeds the button's words
 * and nothing else. Writing real labels into that column would be the dangerous change: the
 * engine's break detection matches `undetermined` gaps specifically, so labelling them in/out
 * would stop the interior gap counting as a break and turn that six-hour day into twelve.
 */
export function nextDirectionAfter(countedOnBusinessDate: number): NextDirection {
  return countedOnBusinessDate % 2 === 0 ? "in" : "out";
}

/**
 * Predict the direction from the employee's own punch log.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO BUGS THIS FUNCTION USED TO HAVE, BOTH VISIBLE IN ONE SCREENSHOT
 * ─────────────────────────────────────────────────────────────────────────────
 * At 00:37, on a day with nothing recorded, the card offered "Punch out" and said
 * "5 recorded against 28-Jul". Reported as: the day has just started, why is it
 * saying punch out.
 *
 * 1. IT PICKED THE BUSINESS DATE OFF THE LATEST PUNCH IT COULD SEE. Reading a
 *    two-day window, the latest punch just after midnight is last night's, so the
 *    card adopted YESTERDAY as the current day and counted yesterday's scans.
 *
 *    Note that "just use today" is also wrong: `set_punch_business_date` really
 *    does file an early-morning scan under the previous day when that day's shift
 *    crosses midnight, and this venue has two such shifts with an employee on one
 *    of them. That employee at 00:37 is mid-shift and must be offered "Punch out".
 *
 *    So the date comes from `my_punch_business_date()` (migration 085) — the same
 *    function the INSERT trigger calls. The label and the row that gets stored
 *    cannot disagree, because there is one rule and both sides ask it.
 *
 * 2. IT USED PARITY. `count % 2` alternates in/out/in/out, so a third scan in one
 *    day offered "Punch in" again. The rule — and the engine's own reading of a day
 *    (§3.1: first scan is the arrival, last is the departure, the ones between move
 *    neither) — is that only the FIRST scan is an arrival. Anything after it is a
 *    departure, right up to the end of the day.
 *
 * Three reads, all already used on this screen family:
 *   1. `my_punch_business_date()` — which day is in progress.
 *   2. `v_attendance_punch_detail` for yesterday + that date (voided rows are
 *      excluded by the view itself; yesterday is still fetched because the business
 *      date may legitimately BE yesterday).
 *   3. `attendance_punches.duplicate_of_punch_id` — two scans inside 120 s are ONE
 *      event to the engine (§3.1), and counting the swallowed one would turn a
 *      first scan into a second. The timeline strikes them through for the same
 *      reason.
 */
/**
 * Would a punch now fall outside the shift window?
 *
 * The tolerance comes from `attendance.off_hours_reason_tolerance_minutes` server-side, so the
 * card cannot disagree with the endpoint about where the boundary is. A failure resolves to
 * "no reason needed" — see the field's own note.
 */
async function needsOffHoursReason(
  employeeId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const within = await rpcOne(
      "punch_within_shift",
      { p_employee_id: employeeId, p_at: nowInstantIso(), p_tolerance_minutes: null },
      z.boolean().nullable(),
      { ...(signal ? { signal } : {}) },
    );
    // NULL cannot happen — the function returns true for a missing shift — and if it somehow
    // does, it must read as "inside".
    return within === false;
  } catch {
    return false;
  }
}

export async function fetchSelfPunchState(
  employeeId: string,
  signal?: AbortSignal,
): Promise<SelfPunchState> {
  const [serverDate, punches] = await Promise.all([
    // Falls back to the plain IST date if the call fails: a wrong-by-one-day count
    // is better than a card that cannot render, and for every day-shift employee
    // — which is everybody but one — the fallback IS the answer.
    fetchPunchBusinessDate(employeeId, signal).catch(() => istToday()),
    fetchPunchesInRange(employeeId, { from: addIstDays(istToday(), -1), to: istToday() }, signal),
  ]);
  const businessDate = serverDate;

  const onDate = punches.filter((punch) => punch.effective_date === businessDate);
  if (onDate.length === 0) {
    // Nothing on the day in progress. `punches` may well be non-empty — last night's
    // scans are in the window — but reporting those as "last scan" while the count
    // reads zero is how the old bug looked on screen. The day is genuinely empty.
    return {
      businessDate,
      punchCount: 0,
      lastPunchAt: null,
      firstPunchAt: null,
      punchInstants: [],
      needsOffHoursReason: await needsOffHoursReason(employeeId, signal),
      next: nextDirectionAfter(0),
    };
  }

  const duplicateFlags = await fetchPunchDuplicateFlags(employeeId, businessDate, signal);
  const collapsed = new Set(
    duplicateFlags.filter((flag) => flag.duplicate_of_punch_id !== null).map((flag) => flag.id),
  );
  const counted = onDate.filter((punch) => !collapsed.has(punch.id));
  // Every scan today was collapsed into an earlier event (possible only across the
  // midnight boundary): the employee did scan, so show it, but it counts as nothing.
  const last: AttendancePunch =
    counted[counted.length - 1] ?? (onDate[onDate.length - 1] as AttendancePunch);

  return {
    businessDate,
    punchCount: counted.length,
    lastPunchAt: last.punched_at,
    // The arrival. Falls back to the uncounted first scan for the same reason `last` does: the
    // employee did scan, and a live clock measured from nothing would show nothing.
    firstPunchAt: (counted[0] ?? onDate[0])?.punched_at ?? null,
    // Counted only. A suppressed double-scan is not a session boundary, and pairing it would
    // split one session into two and halve the hours on screen.
    // `punched_at` is nullable on the row type; a punch without an instant is not a session
    // boundary and pairing around it would shift every later session by one.
    punchInstants: counted
      .map((punch) => punch.punched_at)
      .filter((at): at is string => at !== null),
    needsOffHoursReason: await needsOffHoursReason(employeeId, signal),
    next: nextDirectionAfter(counted.length),
  };
}

/**
 * Which business date a scan made now would be filed under, straight from the
 * function the INSERT trigger uses. Argument-free for the caller's own employee;
 * the id is passed explicitly because this card is always rendered for `employeeId`.
 */
export async function fetchPunchBusinessDate(
  employeeId: string,
  signal?: AbortSignal,
): Promise<string> {
  const date = await rpcOne(
    "my_punch_business_date",
    { p_employee_id: employeeId },
    dbDate,
    signal ? { signal } : undefined,
  );
  return date ?? istToday();
}

// -----------------------------------------------------------------------------
// 3. The punch itself
// -----------------------------------------------------------------------------

/**
 * The measured numbers the function gates on and records. Not one of them may be
 * invented: `livenessScore` comes from `features/auth/lib/liveness.ts`, which
 * reports 0 when it cannot measure, and `livenessModel` names that heuristic so
 * a reader of `secure.face_match_log` cannot mistake it for an ML estimator.
 */
export interface SelfPunchMetrics {
  readonly detectionScore: number;
  /**
   * OPTIONAL on purpose. `measureLiveness` returns 0 when it could not measure,
   * and the function distinguishes the two cases sharply: a present score below
   * `liveness_pass_threshold` is positive spoof evidence and is REFUSED, whereas
   * an absent score is recorded and flagged `liveness_not_attested`. So the
   * caller must OMIT these rather than assert a 0 it did not measure.
   */
  readonly livenessScore?: number;
  readonly livenessModel?: string;
  readonly framesAnalysed?: number;
}

export interface SelfPunchRequest {
  /** L2-normalised 128-D descriptor of the best frame of the agreeing window. */
  readonly descriptor: readonly number[];
  readonly metrics: SelfPunchMetrics;
  /** `null` when the employee refused, or the browser could not answer. */
  readonly geo: SignInGeo | null;
  /**
   * Why this punch is outside the shift window.
   *
   * Sent whenever the employee typed one. The SERVER decides whether it was needed —
   * `punch_within_shift` resolves the rota, the policy override and the night-shift cutover, and
   * re-deriving that here would be a second implementation of a resolved policy. So the card
   * asks when it believes one is required and the server refuses if it actually was.
   */
  readonly offHoursReason?: string;
  /**
   * A photograph supporting an off-hours punch — a `documents` row of type ATTENDANCE_PROOF
   * the card uploaded before calling this.
   *
   * The card makes it MANDATORY for an off-hours punch, per the venue's instruction ("they
   * should attach, and while checking out also it's mandatory"). It is optional in this type
   * because the server deliberately records a punch that arrives without one and flags it
   * `off_hours_proof_missing` instead of refusing: an upload failing on weak signal at 9 pm
   * must cost a review, not somebody's evening.
   */
  readonly proofDocumentId?: string;
  /** Opaque per-browser label; `null` when localStorage is unavailable. */
  readonly deviceId: string | null;
  /**
   * The body's permanent per-punch dedup key, and the HTTP idempotency key of the
   * first attempt. `invokeEdgeFn` sends the latter as both `x-idempotency-key`
   * and `Idempotency-Key`. A UUID v4 is 36 characters, comfortably over the 16
   * the contract requires.
   *
   * The geo-less fallback re-sends under `retryKeyFor(clientEventId)` — a
   * DIFFERENT header key, because the idempotency store rejects the same key with
   * a different body — while this value stays put. That is deliberate: this is
   * the one that makes a double punch impossible (`attendance_punch_keys`,
   * PK `(employee_id, idempotency_key)`), so it must not vary between attempts.
   */
  readonly clientEventId: string;
}

/**
 * The function's answer. Every field except `direction` is optional-and-nullable
 * on purpose: this client must not turn a punch the server DID record into a
 * red screen because one display field was absent. `direction` is `z.string()`
 * rather than an enum for the same reason — `public.punch_direction` is
 * ('in','out','break_start','break_end','undetermined') and the punch-detail
 * view exposes an upper-case derived form, so the value is normalised below
 * instead of being rejected.
 */
const selfPunchResultSchema = z.object({
  direction: z.string(),
  punchedAt: z.string().nullable().optional(),
  istTime: z.string().nullable().optional(),
  employeeName: z.string().nullable().optional(),
  geofenceOk: z.boolean().nullable().optional(),
  /** True when the punch is held for an administrator — the hours show, starred, until then. */
  requiresApproval: z.boolean().optional(),
  matchConfidence: z.number().nullable().optional(),
  message: z.string().nullable().optional(),
  /**
   * THE SERVER'S review flag — `reviewNotes.length > 0`, which is far more than
   * the geofence: `liveness_not_attested`, `outside_venue_network`,
   * `debounced_duplicate` and a reviewable `employment_status` all set it. The
   * card must not infer "flagged" from `geofenceOk` alone, because that renders a
   * punch the server flagged as an unqualified success.
   */
  needsReview: z.boolean().nullable().optional(),
});

/** Normalised for display. `unknown` keeps an unexpected enum value renderable. */
export type PunchedDirection = "in" | "out" | "unknown";

function normaliseDirection(raw: string): PunchedDirection {
  const value = raw.trim().toLowerCase();
  if (value === "in") return "in";
  if (value === "out") return "out";
  return "unknown";
}

export interface PunchRecorded {
  kind: "recorded";
  /** THE server's decision. The button's predicted label is not consulted. */
  direction: PunchedDirection;
  punchedAt: string | null;
  /** Server-rendered IST clock time — the one the employee is told. */
  istTime: string | null;
  employeeName: string | null;
  /** `true` inside the fence, `false` outside, `null` when there was no fix. */
  geofenceOk: boolean | null;
  matchConfidence: number | null;
  /** The server's own sentence, when it wrote one. */
  message: string | null;
  /**
   * `true` when the server flagged the punch for review, `null` when it did not
   * say. Never guessed from the geofence — see the schema note.
   */
  needsReview: boolean | null;
  /**
   * False when coordinates were taken but the function would not accept them —
   * see `LOCATION_DROPPED` below. The screen says so; it never implies a fix
   * was recorded when it was not.
   */
  locationAttached: boolean;
  /**
   * The coordinate that was ACTUALLY attached to this punch, echoed back from what
   * the browser sent, so the confirmation can name the place the employee was
   * recorded at instead of a geofence verdict.
   *
   * It comes from the request rather than the response because the function does
   * not return the fix — and it does not need to: the browser measured it, so it
   * is already the authority on what was submitted. `null` whenever nothing was
   * attached, INCLUDING the fallback path where coordinates were taken and then
   * refused, because in that case the punch genuinely carries no location and
   * showing the reading would claim otherwise.
   */
  fix: { latitude: number; longitude: number; accuracyMetres: number | null } | null;
}

export interface PunchAlreadyRecorded {
  kind: "already_recorded";
  message: string;
}

export interface PunchUnreadable {
  kind: "unreadable";
  message: string;
}

export interface PunchRefused {
  kind: "refused";
  message: string;
  /** Machine code from the problem document, when there was one. */
  code: string | null;
  /** True when trying again could plausibly succeed (offline, 5xx, rate limit). */
  retryable: boolean;
}

export type SelfPunchOutcome =
  | PunchRecorded
  | PunchAlreadyRecorded
  | PunchUnreadable
  | PunchRefused;

function serverCopy(error: TTApiError): string | null {
  const detail = error.problem.detail;
  if (detail !== undefined && detail.trim() !== "") return detail;
  const title = error.problem.title;
  if (title !== undefined && title.trim() !== "") return title;
  return null;
}

function refuse(error: TTApiError): PunchRefused {
  const said = serverCopy(error);
  const code = error.problem.code ?? null;
  switch (error.status) {
    case 401:
      return { kind: "refused", message: said ?? t("me.punch.error.signedOut"), code, retryable: false };
    case 403:
      return { kind: "refused", message: said ?? t("me.punch.error.notEntitled"), code, retryable: false };
    case 404:
      return { kind: "refused", message: t("me.punch.error.notDeployed"), code, retryable: false };
    case 422:
      return { kind: "refused", message: said ?? t("me.punch.error.rejected"), code, retryable: false };
    case 429:
      return { kind: "refused", message: said ?? t("me.punch.error.tooMany"), code, retryable: true };
    default:
      if (error.status >= 500) {
        const ref = error.problem.error_ref;
        return {
          kind: "refused",
          message:
            ref !== undefined
              ? t("me.punch.error.serverWithRef", { ref })
              : (said ?? t("me.punch.error.server")),
          code,
          retryable: true,
        };
      }
      return { kind: "refused", message: said ?? t("me.punch.error.rejected"), code, retryable: false };
  }
}

/*
  `refusedOnlyTheLocation`, `problemFieldsSchema` and `VALIDATION_STATUS` lived here to decide
  whether a 422 was about the coordinates, so the punch could be re-sent without them. The retry
  is gone (see `selfPunch` below), and so are they — a predicate with no caller is a trap for
  whoever reads it next and assumes the behaviour still exists.
*/

/**
 * `SignInGeo` → the function's wire shape, and the translation is REQUIRED, not
 * cosmetic. The browser-side type is the one that lands in `sessions_audit.geo`
 * (`lat` / `lon` / `accuracy_m`, plus a capture instant and source that belong on
 * an audit row and nowhere else); `attendance-self-punch`'s `Geo` schema is
 * `.strict()` and names its three fields `latitude` / `longitude` /
 * `accuracyMetres`. Posting the browser shape raw makes EVERY located punch a
 * 422 — four unrecognised keys and two missing ones — and the retry above then
 * records the punch with no coordinates at all, so the geofence is never
 * evaluated and nobody sees a failure. That is the whole reason this function
 * exists rather than a spread.
 *
 * It now lives in `features/auth/lib/geolocation.ts`, because the KIOSK needs the
 * identical conversion — it was sending no location at all — and two copies of a
 * shape translation is how one of them ends up a field behind. Aliased rather than
 * inlined so the reasoning above stays attached to the call site it protects.
 */
const toWireGeo = toPunchGeo;

/**
 * The HTTP idempotency key for the second, geo-less attempt — and it MUST differ
 * from the first attempt's.
 *
 * `_shared/idempotency.ts` fingerprints the raw body against the key: "same key +
 * other body → 409, because that is a client bug, not a retry", and that check
 * runs BEFORE the replay check. Dropping `geo` changes the body, so re-sending
 * under the same header key is refused `IDEMPOTENCY_KEY_REUSED` every single
 * time — the retry could never have recorded anything.
 *
 * Two properties make a second key safe here, and both are required:
 *   · DETERMINISTIC, so retrying the retry replays the stored answer instead of
 *     writing a second punch.
 *   · `clientEventId` IS UNCHANGED in the body. That is the permanent guard —
 *     `attendance_punch_keys` is PK `(employee_id, idempotency_key)` and the
 *     insert trigger claims it — so if the FIRST attempt did land a punch, this
 *     one raises 23505 and the function answers with the original punch rather
 *     than doubling it. The HTTP key is a 24-hour response cache; the body's
 *     `clientEventId` is the thing that makes a double punch impossible.
 */
function retryKeyFor(clientEventId: string): string {
  return `${clientEventId}-nogeo`;
}

/**
 * `first` sends whatever the ceremony collected and keys on `clientEventId`
 * itself. `fallback` is the geo-less re-send and keys on `retryKeyFor`, because
 * its body is not the body the first key was claimed for.
 */
type Attempt = "first" | "fallback";

/**
 * The EXACT object posted to `attendance-self-punch`. Extracted and exported so a
 * test can assert its key set against the function's own `.strict()` schema
 * without a network call — the geo shape shipped broken precisely because nothing
 * checked this, and a `.strict()` schema turns one wrong key name into a 422 that
 * kills every located punch.
 */
export function buildSelfPunchBody(
  request: SelfPunchRequest,
  attempt: Attempt,
): Record<string, unknown> {
  const geo = attempt === "fallback" ? null : request.geo;
  return {
    descriptor: request.descriptor,
    metrics: request.metrics,
    ...(geo !== null ? { geo: toWireGeo(geo) } : {}),
    ...(request.deviceId !== null ? { deviceId: request.deviceId } : {}),
    // Omitted entirely when empty: the body schema is `.strict()` and an empty string would be
    // a value the server then has to decide is not a reason.
    ...((request.offHoursReason ?? "").trim() !== ""
      ? { reason: (request.offHoursReason ?? "").trim() }
      : {}),
    // Same reason as the reason field: `.strict()` on the body, so an absent proof is an
    // absent KEY rather than a null the server has to interpret.
    ...((request.proofDocumentId ?? "") !== ""
      ? { proofDocumentId: request.proofDocumentId }
      : {}),
    clientEventId: request.clientEventId,
  };
}

async function postPunch(
  request: SelfPunchRequest,
  attempt: Attempt,
  signal?: AbortSignal,
): Promise<z.infer<typeof selfPunchResultSchema>> {
  return invokeEdgeFn(
    SELF_PUNCH_FN,
    buildSelfPunchBody(request, attempt),
    selfPunchResultSchema,
    {
      idempotencyKey: attempt === "first" ? request.clientEventId : retryKeyFor(request.clientEventId),
      ...(signal ? { signal } : {}),
    },
  );
}

/**
 * Send the punch. Resolves with an outcome the card can render; the only thing
 * that can escape is an `AbortError` from a cancelled request.
 *
 * The descriptor is validated for shape by the caller before we get here and by
 * the function afterwards (norm within 0.02 of 1). It is never logged, never
 * stored in state, and never returned — it exists as an argument and dies with
 * the call.
 */
export async function selfPunch(
  request: SelfPunchRequest,
  signal?: AbortSignal,
): Promise<SelfPunchOutcome> {
  /*
    Always true for a punch that reaches this point: `SelfPunchCard` refuses to start without a
    fix and the function refuses a body without one. Kept as a field rather than deleted because
    `PunchRecorded` is also how a HISTORICAL punch renders, and punches taken before location
    became mandatory genuinely have none.
  */
  const locationAttached = request.geo !== null;
  let result: z.infer<typeof selfPunchResultSchema>;

  try {
    result = await postPunch(request, "first", signal);
  } catch (first) {
    if (first instanceof TTApiError && first.isIdempotentReplay) {
      return { kind: "already_recorded", message: t("me.punch.done.alreadyRecorded") };
    }
    if (first instanceof z.ZodError) {
      return { kind: "unreadable", message: t("me.punch.error.unreadable") };
    }
    /*
      ── THE GEO-LESS RETRY IS GONE ─────────────────────────────────────────────
      A 422 that named only the `geo` used to strip the coordinates and re-send, so a location
      the function would not take could not cost somebody their attendance. That was right while
      coordinates were optional. `attendance-self-punch` now REQUIRES them, so the retry could
      only ever fail — the stripped body is missing a mandatory field — and it would fail
      expensively: a second request means a second refusal row in `secure.face_match_log` for
      one tap, overstating the evidence a spoofing investigation reads. That harm is the exact
      one the old guard was written to avoid, and removing the retry is what actually avoids it.

      It would also have fired on the new `SELF_PUNCH_LOCATION_TOO_COARSE`, whose pointer is
      `/geo/accuracyMetres` — refusing a vague fix and then retrying with no fix at all.

      A location refusal now surfaces as itself, and the card tells the employee what to enable.
    */
    if (first instanceof TTApiError) {
      return refuse(first);
    } else if (first instanceof TypeError) {
      // `fetch` never reached the function — offline, DNS, blocked.
      return { kind: "refused", message: t("me.punch.error.offline"), code: null, retryable: true };
    } else {
      throw first;
    }
  }

  return {
    kind: "recorded",
    direction: normaliseDirection(result.direction),
    punchedAt: result.punchedAt ?? null,
    istTime: result.istTime ?? null,
    employeeName: result.employeeName ?? null,
    geofenceOk: result.geofenceOk ?? null,
    matchConfidence: result.matchConfidence ?? null,
    message: result.message ?? null,
    needsReview: result.needsReview ?? null,
    locationAttached,
    // Gated on `locationAttached`, not on `request.geo`: the fallback path above
    // retries WITHOUT coordinates after the function refuses them, and reporting
    // the reading we took in that case would name a place for a punch that has
    // none stored against it.
    // `SignInGeo` names its fields `lat` / `lon` / `accuracy_m` — the audit-row
    // spelling, NOT the function's wire spelling (`latitude` / `longitude` /
    // `accuracyMetres`). Two shapes for one coordinate is exactly what `toWireGeo`
    // exists to reconcile, and reading the wrong one here is a compile error
    // rather than a silent `undefined`, which is why the field is typed.
    fix:
      locationAttached && request.geo !== null
        ? {
            latitude: request.geo.lat,
            longitude: request.geo.lon,
            accuracyMetres: request.geo.accuracy_m,
          }
        : null,
  };
}
