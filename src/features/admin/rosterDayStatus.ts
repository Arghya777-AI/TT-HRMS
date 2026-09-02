/**
 * rosterDayStatus.ts — "attended" and "off" for a roster row, in ONE place.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
 * The roster was today-only, reading `v_attendance_today_board`, which publishes `attended` and
 * `off_today` as columns. Showing a PAST day means reading `v_attendance_day_enriched` instead,
 * and that view has neither — so the two booleans have to be derived.
 *
 * Derived once, here, rather than inline at the call site. The status lists below are copied
 * from the board view's own SQL, and `rosterDayStatus.test.ts` reads the deployed view
 * definition and asserts they still match. That test is the whole point of the module: two
 * definitions of "present" would mean today's roster and yesterday's roster disagreeing about
 * the same person on the same evidence, and nobody would know which to believe.
 *
 * ── THE PUNCH-COUNT CLAUSE IS NOT DECORATION ─────────────────────────────────
 * `attended` is the status list AND `punch_count > 0`. The engine can mark a day `present` from
 * a regularisation or an admin override with no scan behind it, and a roster is a record of who
 * turned up — so a day nobody scanned on is not an attendance, whatever the status says.
 */

/** Statuses that mean somebody worked. Mirrors `v_attendance_today_board.attended`. */
export const ATTENDED_STATUSES: ReadonlySet<string> = new Set([
  "present",
  "half_day",
  "weekly_off_worked",
  "holiday_worked",
  "on_duty",
  "work_from_home",
]);

/** Statuses that mean away-and-that-is-fine. Mirrors `v_attendance_today_board.off_today`. */
export const OFF_STATUSES: ReadonlySet<string> = new Set([
  "weekly_off",
  "holiday",
  "on_leave",
  "on_leave_half",
  "comp_off_availed",
]);

export interface DayStatusInput {
  /** The engine's status, or null for a day it has not computed. */
  readonly status: string | null;
  readonly punchCount: number;
}

/** Did they turn up? Status AND a scan — see the note above. */
export function attendedOn(day: DayStatusInput): boolean {
  const status = day.status ?? "pending";
  return ATTENDED_STATUSES.has(status) && day.punchCount > 0;
}

/** Away by arrangement — neither present nor absent. */
export function offOn(day: DayStatusInput): boolean {
  return OFF_STATUSES.has(day.status ?? "pending");
}
