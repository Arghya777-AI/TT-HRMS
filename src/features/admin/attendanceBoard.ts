/**
 * attendanceBoard.ts — one row shape for the attendance board, from two server views.
 *
 * WHY TWO SOURCES AT ALL. `v_attendance_today_board` is hardcoded to `util.ist_today()`
 * and cannot answer about any other date. It earns that by carrying three things no
 * historical view can: `expected_by`, `yet_to_reach` and `overdue`, all of which are
 * computed against `now()` and are meaningless for last Tuesday — "yet to reach" for a day
 * that finished is not a fact, it is a category error.
 *
 * So the board reads the today view for today and `v_day_enriched` for any other date or
 * range, and both are normalised HERE into one `BoardRow`. The alternative — branching in
 * the column renderers — is how a column starts showing a different number depending on
 * which date is selected.
 *
 * WHAT IS NULL RATHER THAN ZERO, and why it matters. `expectedBy`, `yetToReach` and
 * `overdue` are `null` on a historical row, not `false`. A `false` would render as a
 * confident "no, she is not overdue" about a day where the question does not apply. Null
 * renders as a dash, which is the truth.
 *
 * NOTHING IS RECOMPUTED. Every field is copied from a server column — including `isLate`,
 * which the engine decides against the resolved grace period. A board that recomputed
 * lateness from `firstIn` versus `shiftStart` would disagree with payroll the first time a
 * policy overrode a shift's grace, which is exactly the bug migration 039100 was about.
 */
import { addIstDays } from "@/lib/datetime";
import type { DayRow, TodayBoardRow } from "./api/attendance.api";

/** One employee-day, whichever view it came from. */
export interface BoardRow {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly displayName: string;
  readonly departmentName: string | null;
  readonly istDate: string;
  readonly status: string | null;
  readonly shiftCode: string | null;
  /** `null` on a historical row: it is computed against `now()`. */
  readonly expectedBy: string | null;
  readonly firstInHm: string | null;
  readonly lastOutHm: string | null;
  readonly punchCount: number;
  readonly workedMinutes: number;
  readonly isLate: boolean;
  readonly lateMinutes: number;
  readonly overtimeMinutes: number;
  readonly approvedOvertimeMinutes: number;
  /** Weekly-off / holiday work. Earns comp-off; is NOT overtime. */
  readonly extraWorkMinutes: number;
  readonly earlyExitMinutes: number;
  /** Live-only flags. `null` when the row is historical — see the header. */
  readonly yetToReach: boolean | null;
  readonly overdue: boolean | null;
}

/** Today's live row. Carries the three `now()`-relative flags. */
export function fromTodayBoard(row: TodayBoardRow): BoardRow {
  return {
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
    displayName: row.display_name,
    departmentName: row.department_name,
    istDate: row.ist_date,
    status: row.status,
    shiftCode: row.shift_code,
    expectedBy: row.expected_by,
    firstInHm: row.first_in_hm,
    lastOutHm: row.last_out_hm,
    punchCount: row.punch_count,
    workedMinutes: row.worked_minutes,
    isLate: row.is_late,
    lateMinutes: row.late_minutes,
    overtimeMinutes: row.overtime_minutes ?? 0,
    approvedOvertimeMinutes: row.approved_overtime_minutes ?? 0,
    extraWorkMinutes: row.extra_work_minutes ?? 0,
    earlyExitMinutes: row.early_exit_minutes ?? 0,
    yetToReach: row.yet_to_reach,
    overdue: row.overdue,
  };
}

/**
 * A settled day from `v_day_enriched`.
 *
 * `expectedBy`, `yetToReach` and `overdue` are null by construction: the view has no
 * grace-resolved expectation and the day is over, so there is nothing to be early or late
 * FOR any more. `late_minutes` is still meaningful and still the engine's.
 */
export function fromDayRecord(row: DayRow): BoardRow {
  return {
    employeeId: row.employee_id,
    employeeCode: row.employee_code ?? "",
    displayName: row.display_name ?? "",
    departmentName: row.department_name,
    istDate: row.ist_date,
    status: row.status,
    shiftCode: row.shift_code,
    expectedBy: null,
    firstInHm: row.first_in_hm,
    lastOutHm: row.last_out_hm,
    punchCount: row.punch_count,
    workedMinutes: row.total_worked_minutes,
    isLate: row.is_late,
    lateMinutes: row.late_minutes,
    overtimeMinutes: row.overtime_minutes,
    approvedOvertimeMinutes: row.approved_overtime_minutes,
    // `v_day_enriched` does not publish extra_work_minutes; 0 is honest here because the
    // column is absent, not because the value is known to be zero. The status still says
    // `weekly_off_worked` / `holiday_worked`, which is what a reader needs.
    extraWorkMinutes: 0,
    earlyExitMinutes: row.early_exit_minutes,
    yetToReach: null,
    overdue: null,
  };
}

export type BoardScope =
  /** One date. `istDate` is that date; today gets the live view. */
  | { readonly kind: "day"; readonly date: string }
  /** A whole month, `YYYY-MM`. Always historical, even for the current month. */
  | { readonly kind: "month"; readonly month: string };

/**
 * Is this scope the live one?
 *
 * ONLY a single day equal to today. The current MONTH is not live: it contains 30 settled
 * days plus today, and the today view can only return one row per employee — showing it
 * for a month scope would silently drop every other day of the month.
 */
export function isLiveScope(scope: BoardScope, today: string): boolean {
  return scope.kind === "day" && scope.date === today;
}

/** The inclusive date range a scope covers, for the historical query. */
export function rangeFor(scope: BoardScope): { readonly from: string; readonly to: string } {
  if (scope.kind === "day") return { from: scope.date, to: scope.date };
  // Last day of the month without a Date object: ask for the 31st and let the range be
  // inclusive — `ist_date <= '2026-02-31'` matches nothing after the 28th, and Postgres
  // compares dates, so an impossible day is simply an upper bound that cannot exclude a
  // real one.
  return { from: `${scope.month}-01`, to: `${scope.month}-31` };
}

/** `YYYY-MM` for a `YYYY-MM-DD`. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/**
 * Step the scope one unit back or forward — a day for a day scope, a month for a month.
 *
 * Month arithmetic is done on the `YYYY-MM` string rather than a Date, for the same reason
 * the rest of this codebase avoids `new Date()` on civil values: a Date is an instant in a
 * timezone, and "the month before August" is neither.
 */
export function stepScope(scope: BoardScope, delta: number): BoardScope {
  if (scope.kind === "month") {
    const year = Number.parseInt(scope.month.slice(0, 4), 10);
    const month = Number.parseInt(scope.month.slice(5, 7), 10);
    // Shift to a 0-based absolute month count so a December→January step carries the year.
    const abs = year * 12 + (month - 1) + delta;
    const y = Math.floor(abs / 12);
    const m = (abs % 12 + 12) % 12 + 1;
    return { kind: "month", month: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}` };
  }
  // `addIstDays` is the project's civil-date arithmetic: it anchors on UTC midnight, so
  // there is no timezone and no DST to get wrong. Doing this with `toISOString()` is
  // exactly what the lint rule forbids, and it forbids it because a business date derived
  // in the browser's own zone is wrong for anybody east of Greenwich after 18:30.
  return { kind: "day", date: addIstDays(scope.date, delta) };
}
