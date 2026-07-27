/**
 * activity.api.ts — the server COUNTS behind `/me/activity` and `/me/settings`.
 *
 * WHY THERE ARE NO ROW READS HERE. The row-level reads those two screens need
 * already exist and are already correct, so re-implementing them would create a
 * second definition of the same fact:
 *
 *   * record changes + employment events → `features/profile/api/history.api`
 *     (`fetchChangeRequests`, `fetchLifecycleEvents`, `buildRecordHistory`), the
 *     same functions `/me/profile/history` renders. If the two screens ever
 *     disagreed about a change, that would be the `7 vs 8` defect.
 *   * who read my data → `fetchMyDataAccess` over `v_my_data_access` (037),
 *     owner-executed and pinned to `app.current_employee_id()`.
 *   * sign-in events → `fetchMySessionEvents` over `sessions_audit`, in
 *     `./security.api`, filtered to my own `profile_id` because that table
 *     carries an admin read policy as well.
 *
 * WHAT IS NEW HERE is the counting, and it is counted by Postgres. `selectCount`
 * issues `HEAD ... count=exact` with the SAME filters as the list read, so a
 * tile and the list under it cannot differ. Nothing on either screen tallies a
 * fetched array — a list capped at 200 rows would silently report "200".
 *
 * WHY NOT `audit_log`. The obvious source for "my audit trail" is
 * `v_audit_trail_employee` (037 §8). It is declared `security_invoker = true`
 * over `public.audit_log`, whose only SELECT policy is
 * `audit_log__admin_read USING (app.is_admin())` (006). An employee querying it
 * gets zero rows for a reason that is NOT "nothing happened", which would make
 * the emptiest possible screen also the most misleading one. Hence the four
 * relations above, each of which the employee genuinely owns.
 *
 * Column names verified against migrations 004 (`sessions_audit.profile_id`),
 * 011 (`employee_change_requests.employee_id`,
 * `employee_lifecycle_events.employee_id`), 027
 * (`notification_preferences.profile_id`, `.is_enabled`), 000550
 * (`webauthn_credentials.profile_id`, `.revoked_at`) and 037 (`v_my_data_access`,
 * which needs no filter at all — the view's own WHERE clause is the scope).
 */
import { eq, isNull, isTrue, selectCount } from "@/shared/api/query";
import {
  CHANGE_REQUESTS_TABLE,
  LIFECYCLE_EVENTS_TABLE,
  MY_DATA_ACCESS_VIEW,
} from "@/features/profile/api/history.api";
import { NOTIFICATION_PREFERENCES_TABLE } from "./settings.api";
import { SESSIONS_AUDIT_TABLE, WEBAUTHN_TABLE } from "./security.api";

/** One number per source, each straight from Postgres. */
export interface ActivityCounts {
  /** `employee_change_requests` on my record — requested, not necessarily applied. */
  readonly changeRequests: number;
  /** `employee_lifecycle_events` on my record. */
  readonly lifecycleEvents: number;
  /** Rows in `v_my_data_access` — reveals, exports and reports touching me. */
  readonly dataAccesses: number;
  /** `sessions_audit` rows for my profile. */
  readonly signInEvents: number;
}

/**
 * The four tile numbers for `/me/activity`.
 *
 * Read in parallel and NOT settled individually: all four are self-scoped reads
 * of the same identity, so if one fails the others are not more trustworthy —
 * the screen shows one error with a retry rather than a strip of numbers with a
 * silent hole in it.
 */
export async function fetchActivityCounts(
  employeeId: string,
  profileId: string,
  signal?: AbortSignal,
): Promise<ActivityCounts> {
  const opts = signal ? { signal } : {};
  const [changeRequests, lifecycleEvents, dataAccesses, signInEvents] = await Promise.all([
    selectCount(CHANGE_REQUESTS_TABLE, [eq("employee_id", employeeId)], opts),
    selectCount(LIFECYCLE_EVENTS_TABLE, [eq("employee_id", employeeId)], opts),
    selectCount(MY_DATA_ACCESS_VIEW, [], opts),
    selectCount(SESSIONS_AUDIT_TABLE, [eq("profile_id", profileId)], opts),
  ]);
  return { changeRequests, lifecycleEvents, dataAccesses, signInEvents };
}

/** The counts the `/me/settings` landing states, all server-side. */
export interface SettingsSummaryCounts {
  /** `notification_preferences` rows against my profile. */
  readonly preferences: number;
  /** How many of those are switched on. */
  readonly preferencesEnabled: number;
  /** Passkeys that are still usable (`revoked_at IS NULL`). */
  readonly activePasskeys: number;
}

/**
 * The landing's numbers.
 *
 * `preferences` and `preferencesEnabled` are two counts rather than one count and
 * a client filter, because the preferences screen shows the rows themselves and
 * the two screens must not be able to disagree about how many are on.
 */
export async function fetchSettingsSummaryCounts(
  profileId: string,
  signal?: AbortSignal,
): Promise<SettingsSummaryCounts> {
  const opts = signal ? { signal } : {};
  const mine = [eq("profile_id", profileId)];
  const [preferences, preferencesEnabled, activePasskeys] = await Promise.all([
    selectCount(NOTIFICATION_PREFERENCES_TABLE, mine, opts),
    selectCount(NOTIFICATION_PREFERENCES_TABLE, [...mine, isTrue("is_enabled")], opts),
    selectCount(WEBAUTHN_TABLE, [...mine, isNull("revoked_at")], opts),
  ]);
  return { preferences, preferencesEnabled, activePasskeys };
}
