/**
 * realtime.ts — one live connection for the whole app.
 *
 * WHY ONE, AND WHY HERE. Realtime was inert for the life of this project (a signing-key
 * rotation to ES256 meant `postgres_changes` declined every binding silently — see the
 * 2026-08-01 fix), so only two screens had ever subscribed: the home Today card and the
 * analytics board. Now that it works, the answer is NOT to sprinkle a channel into every
 * screen. Each channel is a websocket join and a set of server-side bindings; twenty
 * screens with their own would mean twenty joins, twenty teardowns on every navigation,
 * and twenty places for a table to be forgotten.
 *
 * So: ONE channel, opened once for a signed-in session, bound to every table in the
 * `supabase_realtime` publication, mapping each table to the query-key roots that depend
 * on it. React Query does the rest — an invalidated root refetches only what is actually
 * mounted, so a leave request arriving while somebody is on the payroll screen costs
 * nothing until they navigate.
 *
 * RLS STILL DECIDES WHAT ARRIVES. `postgres_changes` evaluates the subscriber's policies
 * per row, so an employee's channel carries their own rows and an admin's carries their
 * scope. This file therefore does not filter by employee — filtering here would be a
 * second, weaker copy of the policies, and the kind that drifts.
 *
 * INVALIDATE, NEVER PATCH. A payload could be written straight into the cache and it is
 * tempting, because it is faster. It is also how a screen starts showing a row the
 * database would not have returned: the payload is the raw row, not the view with its
 * joins, its generated columns and its scope predicate. Invalidating means the next read
 * comes from the same view the screen always used, so live and reloaded data cannot
 * disagree.
 */
import { supabase } from "@/lib/supabase";
import { qk } from "./keys";

/** Every table in the `supabase_realtime` publication, as of 2026-08-01. */
export const REALTIME_TABLES = [
  "ai_messages",
  "announcements",
  "approval_requests",
  "attendance_days",
  "attendance_punches",
  "attendance_recompute_runs",
  "kiosk_devices",
  "leave_requests",
  "notifications",
  "payroll_runs",
  "roster_slots",
  "sessions_audit",
  "system_health",
] as const;

export type RealtimeTable = (typeof REALTIME_TABLES)[number];

/**
 * Which query-key roots a change to each table invalidates.
 *
 * Roots rather than precise keys, deliberately. A punch changes today's card, the month
 * strip, the live board, the day records, the exception queue and four analytics tiles;
 * enumerating those here would be a list that goes stale the first time somebody adds a
 * screen. A root is coarse and cannot be wrong.
 *
 * `admin.all` appears on almost everything because the admin console reads nearly every
 * table — and an admin watching a live board is exactly the person who must not see a
 * stale number.
 */
const INVALIDATES: Readonly<Record<RealtimeTable, readonly (readonly string[])[]>> = {
  // A gate scan or a self-punch: the employee's own day, and every admin attendance view.
  attendance_punches: [qk.attendance.all, qk.home.all, qk.admin.all, qk.team.all],
  attendance_days: [qk.attendance.all, qk.home.all, qk.admin.all, qk.team.all],
  attendance_recompute_runs: [qk.attendance.all, qk.admin.all],

  // Leave: the applicant's own screens, their manager's inbox, and the admin calendars.
  leave_requests: [qk.leave.all, qk.home.all, qk.team.all, qk.approvals.all, qk.admin.all],
  approval_requests: [qk.approvals.all, qk.team.all, qk.home.all, qk.admin.all],

  // The bell, and the badge count that hangs off it.
  notifications: [qk.notifications.all, qk.home.all],

  announcements: [qk.home.all, qk.admin.all],
  ai_messages: [qk.ai.all],
  kiosk_devices: [qk.admin.all],
  payroll_runs: [qk.pay.all, qk.admin.all],
  roster_slots: [qk.team.all, qk.admin.all, qk.attendance.all],
  sessions_audit: [qk.admin.all],
  system_health: [qk.admin.all],
};

export interface RealtimeChange {
  readonly table: RealtimeTable;
  readonly eventType: string;
}

/**
 * Open the app's single realtime channel.
 *
 * `onChange` is called once per change with the table that moved, so the caller can
 * invalidate and — where it matters — surface the fact that something arrived. Returns
 * its own teardown.
 *
 * The channel name carries the profile id so a sign-out and a sign-in as somebody else
 * cannot land on a channel still carrying the previous user's bindings.
 */
export function subscribeToAppChanges(
  profileId: string,
  onChange: (change: RealtimeChange) => void,
): () => void {
  let channel = supabase.channel(`app-live-${profileId}`);

  for (const table of REALTIME_TABLES) {
    channel = channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table },
      (payload) => onChange({ table, eventType: payload.eventType }),
    );
  }

  channel.subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** The roots a table's change touches. Exported for the test. */
export function invalidationRootsFor(table: RealtimeTable): readonly (readonly string[])[] {
  return INVALIDATES[table];
}
