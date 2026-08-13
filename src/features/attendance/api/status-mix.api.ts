/**
 * status-mix.api.ts — the one division of a month that is actually a division.
 *
 * ── WHY THIS EXISTS RATHER THAN A CLIENT SUM ───────────────────────────────
 *
 * A stacked bar of a month's day types was declined when the charts went in,
 * because `f_attendance_period_summary` does not partition anything:
 * `present_days` counts weekly_off_worked and holiday_worked, while
 * `weekly_off_days` counts the is_weekly_off FLAG — so a day somebody worked on
 * their weekly off is in both columns, and `half_days` overlaps `leave_days` the
 * same way. Those columns answer "how many days had this property", which is a
 * good question and not a division of the month. Stacking them asserts a
 * partition the data does not have.
 *
 * `attendance_days.status` IS a partition: one enum value per day, by
 * construction. Migration 042900 added `f_attendance_status_mix` to count it, so
 * the bar can be drawn from a figure the SERVER divided rather than one the
 * browser added up.
 */
import { z } from "zod";
import { dbInt, rpcMany } from "@/shared/api/query";

export const STATUS_MIX_FN = "f_attendance_status_mix";

export const statusMixRowSchema = z.object({
  /** `attendance_status` as text — the vocabulary `statusLabel()` already knows. */
  status: z.string(),
  days: dbInt,
});

export type StatusMixRow = z.infer<typeof statusMixRowSchema>;

/**
 * How the days of one window divide, by status.
 *
 * Only days that HAVE a record are counted, which is why the total can be less
 * than the length of the window — a month in progress, or one the engine has not
 * finished rolling up. The screen says so rather than padding the difference
 * into an "absent" bucket nobody recorded.
 */
export function fetchStatusMix(
  employeeId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<StatusMixRow[]> {
  return rpcMany(
    STATUS_MIX_FN,
    { p_employee_id: employeeId, p_from: from, p_to: to },
    statusMixRowSchema,
    signal ? { signal } : {},
  );
}
