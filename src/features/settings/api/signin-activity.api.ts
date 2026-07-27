/**
 * signin-activity.api.ts — the employee-visible sign-in record, read from
 * `public.sessions_audit`.
 *
 * WHY A SECOND READ OF THE SAME TABLE. `./security.api`'s `fetchMySessionEvents`
 * already lists my auth events, and it stays: it is the 25-row strip the
 * `/me/settings` LANDING still renders (`SettingsIndex.page.tsx`), and it
 * deliberately does not select `geo`. (The security TAB no longer uses it — it now
 * renders `SignInTrail` off `useMySignInTrail`, sharing this file's cache entry with
 * `/me/activity` so the two cannot disagree.) The transparency trail
 * needs three things that read cannot give and must not be bolted onto it:
 *
 *   1. `geo` and `attempted_email`, so "from where" and "which address was tried"
 *      can be answered at all;
 *   2. a much longer window (200 rows) plus the SERVER's own total, so the screen
 *      can say whether what it shows is the whole history — the new-device and
 *      new-location notes are only true if it is;
 *   3. server COUNTS per event class, because the four numbers above the list must
 *      be the cardinality of the whole record, not of the loaded page (DR-29).
 *
 * WHAT RLS LETS AN EMPLOYEE SEE (checked before designing anything):
 *   * `sessions_audit__self_read USING (profile_id = app.ctx_actor_id())` — and
 *     `app.ctx_actor_id()` (migration 000500) falls back to `auth.uid()`, so a
 *     plain PostgREST session from the browser does resolve to the signed-in
 *     profile. `authenticated` holds SELECT only; INSERT is service_role
 *     (migration 000400 §5 grants), so nothing on this screen can write.
 *   * `sessions_audit__admin_read USING (app.is_admin())` exists as well, which is
 *     exactly why every read below filters `profile_id` EXPLICITLY. Without it an
 *     HR administrator's own transparency screen would list the whole company.
 *   * A failed attempt against an address that resolves to no account carries
 *     `profile_id IS NULL`, so it is invisible to every employee by construction.
 *     The screen says so rather than implying no such attempt happened.
 *
 * COLUMNS AND VALUES verified against migration 20260801000400_identity_core.sql
 * §5 (`profile_id, attempted_email, event, auth_method, ip, user_agent, device_id,
 * geo, failure_reason, recorded_at`, `ck_sessions_audit__event` = the ten event
 * values, `ck_sessions_audit__auth_method` = the five methods) and the policies in
 * 20260801000660_identity_rls_policies.sql §5.
 *
 * `event` is typed `z.string()`, not the ten-value enum: a CHECK constraint can
 * grow, and a new event value must render as an unrecognised-but-recorded row, not
 * as a parse error that hides the nine kinds we do understand.
 */
import { z } from "zod";
import {
  dbTimestamp,
  dbUuid,
  eq,
  inList,
  neq,
  selectCount,
  selectMany,
  selectOne,
  type Filter,
} from "@/shared/api/query";
import { SESSIONS_AUDIT_TABLE } from "./security.api";

/**
 * How many rows the trail loads. Beyond this the screen stops claiming novelty
 * (see `buildSignInTrail`) and says how many events exist in total instead.
 */
export const SIGNIN_TRAIL_LIMIT = 200;

/** `ck_sessions_audit__event` values that mean "you got in". */
export const SIGNIN_EVENTS_SUCCESS = ["login_success", "passkey_used"] as const;
/** The refusal. Ten in a row deactivate the profile (`sessions_audit_apply_event`). */
export const SIGNIN_EVENTS_FAILURE = ["login_failed"] as const;
/** Credential and session changes — not sign-ins, but security-relevant. */
export const SIGNIN_EVENTS_SECURITY = [
  "password_changed",
  "password_reset_requested",
  "passkey_registered",
  "mfa_challenge",
  "session_revoked",
] as const;
/** The one background event. Kept out of the main trail so it cannot bury it. */
export const SIGNIN_EVENT_BACKGROUND = "token_refresh" as const;

export const signInEventRowSchema = z.object({
  id: dbUuid,
  event: z.string(),
  auth_method: z.string().nullable(),
  /** `inet` — arrives as text. Shown as an address, never resolved to a place. */
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  device_id: z.string().nullable(),
  /** Nullable jsonb of unknown shape; parsed defensively by `readPlace`. */
  geo: z.unknown().nullable(),
  failure_reason: z.string().nullable(),
  /** Set instead of a resolved profile on some refusals; kept for the detail block. */
  attempted_email: z.string().nullable(),
  recorded_at: dbTimestamp,
});

export type SignInEventRow = z.infer<typeof signInEventRowSchema>;

const TRAIL_COLUMNS =
  "id, event, auth_method, ip, user_agent, device_id, geo, failure_reason, " +
  "attempted_email, recorded_at";

/**
 * My own auth events, newest first, WITHOUT the background renewals.
 *
 * Renewals are excluded from this read rather than filtered in the browser: one
 * chatty session can write hundreds of `token_refresh` rows, and with them in the
 * projection the 200-row window could contain nothing a person cares about. They
 * are readable through `fetchMySessionRenewals` on request, and counted either
 * way, so nothing is hidden — only de-prioritised.
 */
export async function fetchMySignInTrail(
  profileId: string,
  limit: number = SIGNIN_TRAIL_LIMIT,
  signal?: AbortSignal,
): Promise<SignInEventRow[]> {
  return selectMany(SESSIONS_AUDIT_TABLE, signInEventRowSchema, {
    columns: TRAIL_COLUMNS,
    filters: [eq("profile_id", profileId), neq("event", SIGNIN_EVENT_BACKGROUND)],
    order: [
      { column: "recorded_at", ascending: false },
      { column: "id", ascending: false },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/** The background renewals on their own, for the viewer who asks for them. */
export async function fetchMySessionRenewals(
  profileId: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<SignInEventRow[]> {
  return selectMany(SESSIONS_AUDIT_TABLE, signInEventRowSchema, {
    columns: TRAIL_COLUMNS,
    filters: [eq("profile_id", profileId), eq("event", SIGNIN_EVENT_BACKGROUND)],
    order: [
      { column: "recorded_at", ascending: false },
      { column: "id", ascending: false },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

const lastSuccessSchema = z.object({
  auth_method: z.string().nullable(),
  recorded_at: dbTimestamp,
});

/** One number per event class, plus the newest success. Every count is Postgres'. */
export interface SignInSummary {
  /** `event = 'login_success'` — `passkey_used` is NOT added in; the passkey path
   *  writes both, and summing them would report every passkey sign-in twice. */
  readonly signIns: number;
  readonly failures: number;
  readonly securityChanges: number;
  readonly renewals: number;
  /** Every row against my profile, renewals included. */
  readonly total: number;
  /** The newest `login_success`, whatever the trail window happens to hold. */
  readonly lastSuccessAt: string | null;
  readonly lastSuccessMethod: string | null;
}

/**
 * The four tile numbers and the "last recorded sign-in" line.
 *
 * Read in one `Promise.all` and NOT settled individually: all six are self-scoped
 * reads of the same identity, so a strip of numbers with one silent hole in it
 * would be less honest than one error with a retry.
 *
 * `lastSuccessAt` is its own one-row read rather than the first success in the
 * loaded trail: the trail is capped, and "no sign-in recorded" must mean exactly
 * that and not "none in the last 200 events".
 */
export async function fetchMySignInSummary(
  profileId: string,
  signal?: AbortSignal,
): Promise<SignInSummary> {
  const opts = signal ? { signal } : {};
  const mine: readonly Filter[] = [eq("profile_id", profileId)];
  const [signIns, failures, securityChanges, renewals, total, lastSuccess] = await Promise.all([
    selectCount(SESSIONS_AUDIT_TABLE, [...mine, eq("event", "login_success")], opts),
    selectCount(SESSIONS_AUDIT_TABLE, [...mine, inList("event", SIGNIN_EVENTS_FAILURE)], opts),
    selectCount(SESSIONS_AUDIT_TABLE, [...mine, inList("event", SIGNIN_EVENTS_SECURITY)], opts),
    selectCount(SESSIONS_AUDIT_TABLE, [...mine, eq("event", SIGNIN_EVENT_BACKGROUND)], opts),
    selectCount(SESSIONS_AUDIT_TABLE, [...mine], opts),
    selectOne(SESSIONS_AUDIT_TABLE, lastSuccessSchema, [...mine, eq("event", "login_success")], {
      columns: "auth_method, recorded_at",
      order: [
        { column: "recorded_at", ascending: false },
        { column: "id", ascending: false },
      ],
      ...opts,
    }),
  ]);
  return {
    signIns,
    failures,
    securityChanges,
    renewals,
    total,
    lastSuccessAt: lastSuccess?.recorded_at ?? null,
    lastSuccessMethod: lastSuccess?.auth_method ?? null,
  };
}
