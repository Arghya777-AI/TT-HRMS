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
 * already see on their own timeline and reports the parity of it, so the button
 * can say which direction the employee is about to record. That prediction is
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
import { dbUuid, selectOne } from "@/shared/api/query";
import { addIstDays, istToday } from "@/lib/datetime";
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
   * The business date the open punches are filed under, or `null` when nothing
   * has been recorded across the two dates read. NOT necessarily today: a night
   * shift's 01:00 scan is filed under the previous business date by the
   * `set_punch_business_date` trigger, which is why two dates are read.
   */
  businessDate: string | null;
  /** Punches on that business date, duplicates and voids already excluded. */
  punchCount: number;
  /** The most recent punch instant, for "last scan 09:14" under the button. */
  lastPunchAt: string | null;
  /** Even count (including zero) → the next scan is an arrival. */
  next: NextDirection;
}

/**
 * Predict the direction from the employee's own punch log.
 *
 * Two reads, both already used elsewhere on this screen family:
 *   1. `v_attendance_punch_detail` for yesterday + today (voided rows are
 *      excluded by the view itself).
 *   2. `attendance_punches.duplicate_of_punch_id` for the resolved business
 *      date — the two scans inside 120 s that the engine collapses (§3.1) are
 *      ONE event, and counting the swallowed one would flip the label. The
 *      timeline already strikes them through for the same reason.
 */
export async function fetchSelfPunchState(
  employeeId: string,
  signal?: AbortSignal,
): Promise<SelfPunchState> {
  const today = istToday();
  const punches = await fetchPunchesInRange(
    employeeId,
    { from: addIstDays(today, -1), to: today },
    signal,
  );
  const latest: AttendancePunch | undefined = punches[punches.length - 1];
  if (latest === undefined) {
    return { businessDate: null, punchCount: 0, lastPunchAt: null, next: "in" };
  }

  const businessDate = latest.effective_date;
  const onDate = punches.filter((punch) => punch.effective_date === businessDate);
  const duplicateFlags = await fetchPunchDuplicateFlags(employeeId, businessDate, signal);
  const collapsed = new Set(
    duplicateFlags.filter((flag) => flag.duplicate_of_punch_id !== null).map((flag) => flag.id),
  );
  const counted = onDate.filter((punch) => !collapsed.has(punch.id));
  const last = counted[counted.length - 1] ?? latest;

  return {
    businessDate,
    punchCount: counted.length,
    lastPunchAt: last.punched_at,
    next: counted.length % 2 === 0 ? "in" : "out",
  };
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

/**
 * Retry-without-coordinates: the request body was rejected while it carried a
 * `geo`, AND the rejection was about the `geo`. Attendance must not be lost to a
 * location the function would not take, so the punch is re-sent once without it
 * — under the SAME idempotency key, so if the first attempt did in fact land,
 * the second replays rather than duplicating.
 *
 * The `refusedOnlyTheLocation` guard is load-bearing. A blanket "any 422 while a
 * geo was attached" retry re-sends the same descriptor after a refusal that had
 * nothing to do with the location (`liveness_below_threshold`,
 * `detection_score_below_minimum`, a non-unit descriptor), which writes a SECOND
 * refusal row into `secure.face_match_log` for one tap and overstates the
 * evidence a spoofing investigation reads.
 */
const VALIDATION_STATUS = 422;

/** `errors[]` of an RFC 9457 422 — `problemSchema` passes it through untyped. */
const problemFieldsSchema = z.object({
  errors: z.array(z.object({ pointer: z.string() })).optional(),
});

/** True when every field the function rejected was part of the `geo` object. */
function refusedOnlyTheLocation(error: TTApiError): boolean {
  const parsed = problemFieldsSchema.safeParse(error.problem);
  if (!parsed.success) return false;
  const items = parsed.data.errors;
  if (items === undefined || items.length === 0) return false;
  return items.every((item) => item.pointer === "/geo" || item.pointer.startsWith("/geo/"));
}

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
      idempotencyKey:
        attempt === "first" ? request.clientEventId : retryKeyFor(request.clientEventId),
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
  let locationAttached = request.geo !== null;
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
    // The body was refused FOR THE COORDINATES: drop them and try once.
    if (
      first instanceof TTApiError &&
      first.status === VALIDATION_STATUS &&
      locationAttached &&
      refusedOnlyTheLocation(first)
    ) {
      locationAttached = false;
      try {
        result = await postPunch(request, "fallback", signal);
      } catch (second) {
        if (second instanceof TTApiError && second.isIdempotentReplay) {
          return { kind: "already_recorded", message: t("me.punch.done.alreadyRecorded") };
        }
        if (second instanceof z.ZodError) {
          return { kind: "unreadable", message: t("me.punch.error.unreadable") };
        }
        if (second instanceof TTApiError) return refuse(second);
        throw second;
      }
    } else if (first instanceof TTApiError) {
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
  };
}
