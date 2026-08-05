/**
 * dayRecordedBy — who put this day on the record: the employee, or HR.
 *
 * ASKED FOR: "in calender use color code also for employee, admin/HR". The month
 * grid already colours WHAT each day was (present, absent, on leave). It said
 * nothing about WHERE that came from, and those are different questions with
 * different consequences. A day marked present by a face scan at the gate and a
 * day typed in by HR read identically, which is precisely the distinction behind
 * the earlier instruction that attendance "should be real and only updates
 * attendance when it is punched".
 *
 * THE FOUR ANSWERS, AND WHY THEY ARE RANKED IN THIS ORDER.
 *
 *   `hr_override` — `manual_override_status` or `manual_override_times`. HR set the
 *     day by hand and the attendance engine's own computation was overruled.
 *     `ck_ad__override_reason` (attendance_days) makes a reason of at least ten
 *     characters mandatory to do it, so this is always a deliberate, explained act.
 *     Ranked first because it is the only case where the record does not follow from
 *     punches at all — if it is also flagged as corrected, the hand is the stronger
 *     fact and the one worth showing.
 *
 *   `corrected` — `regularization_id` is set, surfaced as `is_regularized`. The
 *     employee asked for a correction and it was approved, which created real
 *     punches with `source = 'system_regularization'` and recomputed the day
 *     (migration 056). So the day IS computed from punches — they were simply
 *     authorised rather than scanned. That makes it neither a plain self-punch nor
 *     an override, and it earns its own mark.
 *
 *   `self` — punches exist and nobody overrode anything. The ordinary case: the
 *     employee stood in front of the camera.
 *
 *   `none` — no punches and no human decision. A weekly off, a holiday, or a day
 *     that is absent by the simple fact that nothing happened. Deliberately NOT
 *     called "employee" or "HR": nobody recorded it, and inventing an author for an
 *     empty day is the kind of small lie the calendar is built to avoid.
 *
 * A PURE FUNCTION IN ITS OWN MODULE so the ranking above is testable without
 * mounting a calendar — the precedence between an override and a correction is the
 * part a later edit is most likely to get backwards.
 */
import type { AttendanceDay } from "@/features/attendance/api/attendance.api";

export type RecordedBy = "hr_override" | "corrected" | "self" | "none";

/**
 * The four fields this decision needs, rather than the whole 60-column day row —
 * a `Pick` keeps it honest about its inputs and keeps the tests readable.
 */
export type DayProvenance = Pick<
  AttendanceDay,
  "manual_override_status" | "manual_override_times" | "is_regularized" | "punch_count"
>;

export function dayRecordedBy(day: DayProvenance | null): RecordedBy {
  if (day === null) return "none";
  // `=== true`: both override columns are nullable in the row schema, and a null
  // must not be read as "overridden".
  if (day.manual_override_status === true || day.manual_override_times === true) {
    return "hr_override";
  }
  if (day.is_regularized) return "corrected";
  if (day.punch_count > 0) return "self";
  return "none";
}
