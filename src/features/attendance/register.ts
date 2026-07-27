/**
 * register.ts — the row model behind the E-03 day-by-day register, and the
 * donut-slice ↔ row correspondence.
 *
 * Two rules live here, and both are display rules over server rows:
 *
 *  1. The register has one row per DATE OF THE MONTH, not one per row the view
 *     returned. A month the engine has not finished processing still shows every
 *     date, and a date after today shows as `not_yet` — never as an absent
 *     (DR-30). The calendar supplies the dates (`istMonthDates`), the view
 *     supplies the facts, and `displayStatus` decides which of the two wins.
 *
 *  2. Clicking a donut slice filters the register. The predicate below uses the
 *     SAME column the summary view counted (`is_weekly_off` for weekly offs,
 *     `status` for the rest), so the filtered row count and the slice count
 *     cannot disagree — that is the dashboard-vs-modal defect (DR-29) in its
 *     smallest form.
 *
 * Nothing here sums, averages or re-derives anything.
 */
import { istMonthDates } from "@/lib/datetime";
import type { AttendanceDay } from "./api/attendance.api";
import { displayStatus } from "./display";

export interface RegisterRow {
  /** IST civil date, 'YYYY-MM-DD'. Also the row key and the deep-link param. */
  readonly istDate: string;
  /** The view row for that date, or null when the engine has written none. */
  readonly day: AttendanceDay | null;
  /** The status to DISPLAY — `not_yet` for the future, never `absent`. */
  readonly status: string;
}

/** One row per date of `month`, oldest first, joined to the view rows by date. */
export function buildRegisterRows(month: string, days: readonly AttendanceDay[]): RegisterRow[] {
  const byDate = new Map(days.map((d) => [d.ist_date, d]));
  return istMonthDates(month).map((istDate) => {
    const day = byDate.get(istDate) ?? null;
    return { istDate, day, status: displayStatus(day, istDate) };
  });
}

/** The donut's slice identities. Colour and label are bound to these, not to order. */
export type SliceKey =
  | "attended"
  | "half"
  | "weeklyOff"
  | "holiday"
  | "leave"
  | "compOff"
  | "absent"
  | "pending";

/** The statuses `f_attendance_period_summary` folds into `present_days`. */
const ATTENDED_STATUSES: ReadonlySet<string> = new Set([
  "present",
  "weekly_off_worked",
  "holiday_worked",
  "on_duty",
  "work_from_home",
]);

/**
 * Does a register row belong to a slice? Mirrors the view's own FILTER clauses.
 * A worked weekly off is counted by the view in BOTH `present_days` and
 * `weekly_off_days`, so it matches both slices here too — deliberately, because
 * a filter that disagreed with the count would be the worse lie.
 */
export function sliceMatchesRow(slice: SliceKey, row: RegisterRow): boolean {
  const day = row.day;
  if (day === null) return false;
  switch (slice) {
    case "attended":
      return ATTENDED_STATUSES.has(day.status);
    case "half":
      return day.status === "half_day";
    case "weeklyOff":
      return day.is_weekly_off;
    case "holiday":
      return day.is_holiday;
    case "leave":
      return day.leave_day_fraction !== null && day.leave_day_fraction > 0;
    case "compOff":
      return day.status === "comp_off_availed";
    case "absent":
      return day.status === "absent";
    case "pending":
      return day.status === "pending";
  }
}
