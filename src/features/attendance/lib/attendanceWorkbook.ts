/**
 * attendanceWorkbook.ts — the attendance export, as sheets.
 *
 * ── WHAT IS IN THE FILE, AND WHY EACH SHEET EXISTS ───────────────────────────
 *   Summary         one row per employee: the period's days, hours and variance
 *   Leave balances  one row per employee per leave type: taken, held, left, carried forward
 *   Day wise        one row per employee per DATE          (week and month exports)
 *   Month wise      one row per employee per MONTH         (year exports)
 *
 * The scope decides the last sheet and nothing else, which is why "day wise inside the months"
 * and "month wise inside the year" are one builder rather than three.
 *
 * ── EVERY NUMBER COMES FROM WHERE THE SCREEN GOT IT ──────────────────────────
 * The day counts, paid days, worked minutes and overtime are `f_attendance_period_summary`
 * columns — the server's own aggregate, the same row the month screens render. The over/under
 * figures come from `periodVariance`, the one shared module the employee's screen and the
 * admin's screen both use.
 *
 * NOTHING IS RE-DERIVED HERE. That matters more for an export than for a screen: a spreadsheet
 * outlives the session it was taken from, gets mailed around, and is quoted back months later.
 * If it disagreed with the console by even a minute, the console would lose the argument.
 *
 * ── MINUTES, AND ALSO HOURS ──────────────────────────────────────────────────
 * Durations appear twice: a real number of minutes, and the "7h 12m" string the screen shows.
 * The number is there because a workbook exists to be summed and pivoted and "7h 12m" cannot
 * be; the string is there so a reader can check a cell against the screen without doing
 * arithmetic in their head. They are the same figure, never two sources.
 *
 * ── AND IT SAYS WHAT IT COULD NOT COUNT ──────────────────────────────────────
 * Today is still being measured, next week has not happened, and a day the engine has not
 * resolved is unknown. All three are excluded from the variance and NAMED on the summary
 * sheet, because a total that quietly omits days is how a spreadsheet becomes an argument.
 */
import { fmtCivilDayMonthWeekday, fmtDurationHm, fmtMonthLong } from "@/lib/datetime";
import type { XlsxSheet, XlsxValue } from "@/lib/xlsx";
import { t } from "@/shared/i18n/en";
import type { AttendancePeriodSummary } from "../api/attendance.api";
import {
  dayVariance,
  isGettingProcessed,
  periodVariance,
  type VarianceDay,
} from "./variance";

/** Week and month list their days; a year lists its months. */
export type ExportScope = "week" | "month" | "year";

/** Who a row belongs to. Resolved by the caller, which already holds the labels. */
export interface WorkbookEmployee {
  readonly employeeId: string;
  readonly code: string | null;
  readonly name: string;
}

/**
 * Exactly the day fields the sheets print — nothing more.
 *
 * Structural, like `VarianceDay` and for the same reason: the employee's schema and the
 * admin's schema over `v_attendance_day_enriched` select different column sets, and a builder
 * that demanded either one would shut the other out. Both satisfy this.
 */
export interface WorkbookDay extends VarianceDay {
  readonly employee_id: string;
  readonly late_minutes: number | null;
  readonly early_exit_minutes: number | null;
  readonly overtime_minutes: number | null;
  readonly day_fraction_paid: number | null;
  readonly leave_type_name?: string | null;
  readonly shift_code?: string | null;
}

/** One leave type's standing, per employee. `v_leave_balance_current`, verbatim. */
export interface WorkbookBalance {
  readonly employee_id: string;
  readonly leave_type_name: string;
  readonly entitlement_days: number;
  readonly carried_forward_days: number;
  readonly accrued_days: number;
  readonly availed_days: number;
  readonly pending_days: number;
  readonly available_days: number;
  readonly lapsed_days: number;
}

/** A month of the year export, with the server's summary for it. */
export interface WorkbookMonth {
  /** First day of the month, ISO. */
  readonly from: string;
  readonly summaries: readonly AttendancePeriodSummary[];
}

export interface WorkbookInput {
  readonly scope: ExportScope;
  readonly from: string;
  readonly to: string;
  /** "September 2026", "Week of 14 Sep 2026", "2026" — the caller words it. */
  readonly rangeLabel: string;
  readonly generatedAt: string;
  readonly employees: readonly WorkbookEmployee[];
  readonly summaries: readonly AttendancePeriodSummary[];
  readonly days: readonly WorkbookDay[];
  readonly balances: readonly WorkbookBalance[];
  /** Year exports only: one entry per month, in order. */
  readonly months?: readonly WorkbookMonth[];
  /**
   * True when the day read hit its cap.
   *
   * It does not merely annotate the file — it SUPPRESSES the variance figures, because a
   * total computed over some of the days is worse than no total. Same rule
   * `PeriodVariancePanel` keeps for a capped period.
   */
  readonly truncated?: boolean;
}

const n = (v: number | null | undefined): XlsxValue => (v === null || v === undefined ? null : Number(v));
const hm = (v: number | null | undefined): XlsxValue =>
  v === null || v === undefined ? null : fmtDurationHm(v);

/** Minutes → a signed number, for a cell that has to be summable. */
function signedMinutes(v: number): number {
  return v;
}

function employeeOf(
  employees: readonly WorkbookEmployee[],
  id: string,
): WorkbookEmployee {
  return (
    employees.find((e) => e.employeeId === id) ?? {
      employeeId: id,
      code: null,
      name: t("admin.common.unknownPerson"),
    }
  );
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

function summarySheet(input: WorkbookInput): XlsxSheet {
  const rows: XlsxValue[][] = [];

  for (const employee of input.employees) {
    const summary = input.summaries.find((s) => s.employee_id === employee.employeeId) ?? null;
    const mine = input.days.filter((d) => d.employee_id === employee.employeeId);
    const v = periodVariance(mine);

    rows.push([
      employee.code,
      employee.name,
      input.from,
      input.to,
      n(summary?.working_days),
      n(summary?.present_days),
      n(summary?.half_days),
      n(summary?.absent_days),
      n(summary?.leave_days),
      n(summary?.weekly_off_days),
      n(summary?.holiday_days),
      n(summary?.paid_days),
      n(summary?.total_worked_minutes),
      hm(summary?.total_worked_minutes),
      n(summary?.overtime_minutes),
      n(summary?.approved_overtime_minutes),
      n(summary?.late_days),
      n(summary?.late_minutes),
      n(summary?.early_exit_days),
      n(summary?.early_exit_minutes),
      /*
        Suppressed when the day read was capped. A variance over an unknown subset of the
        period is not a smaller truth, it is a different and wrong one.
      */
      input.truncated === true ? null : signedMinutes(v.varianceMinutes),
      input.truncated === true ? null : v.surplusMinutes,
      input.truncated === true ? null : v.shortfallMinutes,
      input.truncated === true ? null : v.countedDays,
      input.truncated === true ? null : v.openDays,
      input.truncated === true ? null : v.futureDays,
      input.truncated === true ? null : v.unresolvedDays,
    ]);
  }

  return {
    name: t("attendance.export.sheet.summary"),
    columns: [
      { header: t("attendance.export.col.code"), width: 10 },
      { header: t("attendance.export.col.name"), width: 26 },
      { header: t("attendance.export.col.from"), width: 12 },
      { header: t("attendance.export.col.to"), width: 12 },
      { header: t("attendance.export.col.workingDays"), width: 13 },
      { header: t("attendance.export.col.present"), width: 10 },
      { header: t("attendance.export.col.halfDays"), width: 11 },
      { header: t("attendance.export.col.absent"), width: 9 },
      { header: t("attendance.export.col.leaveDays"), width: 12 },
      { header: t("attendance.export.col.weeklyOffs"), width: 12 },
      { header: t("attendance.export.col.holidays"), width: 10 },
      { header: t("attendance.export.col.paidDays"), width: 11 },
      { header: t("attendance.export.col.workedMin"), width: 14 },
      { header: t("attendance.export.col.workedHm"), width: 12 },
      { header: t("attendance.export.col.otMin"), width: 14 },
      { header: t("attendance.export.col.otApprovedMin"), width: 17 },
      { header: t("attendance.export.col.lateDays"), width: 11 },
      { header: t("attendance.export.col.lateMin"), width: 12 },
      { header: t("attendance.export.col.earlyDays"), width: 12 },
      { header: t("attendance.export.col.earlyMin"), width: 13 },
      { header: t("attendance.export.col.varianceMin"), width: 17 },
      { header: t("attendance.export.col.extraMin"), width: 16 },
      { header: t("attendance.export.col.shortMin"), width: 16 },
      { header: t("attendance.export.col.counted"), width: 14 },
      { header: t("attendance.export.col.processing"), width: 17 },
      { header: t("attendance.export.col.future"), width: 14 },
      { header: t("attendance.export.col.unresolved"), width: 16 },
    ],
    rows,
  };
}

// -----------------------------------------------------------------------------
// Leave balances
// -----------------------------------------------------------------------------

function balanceSheet(input: WorkbookInput): XlsxSheet {
  const rows: XlsxValue[][] = input.balances.map((b) => {
    const employee = employeeOf(input.employees, b.employee_id);
    return [
      employee.code,
      employee.name,
      b.leave_type_name,
      n(b.entitlement_days),
      n(b.carried_forward_days),
      n(b.accrued_days),
      n(b.availed_days),
      n(b.pending_days),
      n(b.available_days),
      n(b.lapsed_days),
    ];
  });

  return {
    name: t("attendance.export.sheet.balances"),
    columns: [
      { header: t("attendance.export.col.code"), width: 10 },
      { header: t("attendance.export.col.name"), width: 26 },
      { header: t("attendance.export.col.leaveType"), width: 22 },
      { header: t("attendance.export.col.entitlement"), width: 14 },
      { header: t("attendance.export.col.carriedForward"), width: 16 },
      { header: t("attendance.export.col.accrued"), width: 12 },
      { header: t("attendance.export.col.taken"), width: 12 },
      { header: t("attendance.export.col.held"), width: 12 },
      { header: t("attendance.export.col.left"), width: 12 },
      { header: t("attendance.export.col.lapsed"), width: 11 },
    ],
    rows,
  };
}

// -----------------------------------------------------------------------------
// Day wise
// -----------------------------------------------------------------------------

function daySheet(input: WorkbookInput): XlsxSheet {
  const rows: XlsxValue[][] = [];

  /* Employee, then date — the order somebody reads a register in. */
  const ordered = [...input.days].sort(
    (a, b) =>
      a.employee_id.localeCompare(b.employee_id) || a.ist_date.localeCompare(b.ist_date),
  );

  for (const day of ordered) {
    const employee = employeeOf(input.employees, day.employee_id);
    const v = dayVariance(day);
    rows.push([
      employee.code,
      employee.name,
      day.ist_date,
      fmtCivilDayMonthWeekday(day.ist_date),
      day.status,
      day.leave_type_name ?? null,
      day.shift_code ?? null,
      day.first_in_at,
      day.last_out_at,
      n(day.payable_worked_minutes ?? day.total_worked_minutes),
      hm(day.payable_worked_minutes ?? day.total_worked_minutes),
      n(day.shift_duration_minutes),
      /* Blank rather than 0 on a day that does not count — see `note`. */
      v.counts ? signedMinutes(v.varianceMinutes) : null,
      n(day.late_minutes),
      n(day.early_exit_minutes),
      n(day.overtime_minutes),
      n(day.day_fraction_paid),
      noteFor(day),
    ]);
  }

  return {
    name: t("attendance.export.sheet.dayWise"),
    columns: [
      { header: t("attendance.export.col.code"), width: 10 },
      { header: t("attendance.export.col.name"), width: 26 },
      { header: t("attendance.export.col.date"), width: 12 },
      { header: t("attendance.export.col.day"), width: 18 },
      { header: t("attendance.export.col.status"), width: 16 },
      { header: t("attendance.export.col.leaveType"), width: 18 },
      { header: t("attendance.export.col.shift"), width: 10 },
      { header: t("attendance.export.col.firstIn"), width: 22 },
      { header: t("attendance.export.col.lastOut"), width: 22 },
      { header: t("attendance.export.col.workedMin"), width: 14 },
      { header: t("attendance.export.col.workedHm"), width: 12 },
      { header: t("attendance.export.col.shiftMin"), width: 14 },
      { header: t("attendance.export.col.varianceMin"), width: 17 },
      { header: t("attendance.export.col.lateMin"), width: 12 },
      { header: t("attendance.export.col.earlyMin"), width: 13 },
      { header: t("attendance.export.col.otMin"), width: 14 },
      { header: t("attendance.export.col.paidFraction"), width: 14 },
      { header: t("attendance.export.col.note"), width: 34 },
    ],
    rows,
  };
}

/** Why a day contributed nothing, in the words the screens use. */
function noteFor(day: WorkbookDay): string | null {
  if (isGettingProcessed(day)) return t("attendance.variance.cell.inProgress");
  const v = dayVariance(day);
  if (v.counts) return null;
  switch (v.reason) {
    case "future":
      return t("attendance.export.note.future");
    case "unresolved":
      return t("attendance.export.note.unresolved");
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Month wise
// -----------------------------------------------------------------------------

function monthSheet(input: WorkbookInput): XlsxSheet {
  const rows: XlsxValue[][] = [];
  const months = input.months ?? [];

  for (const employee of input.employees) {
    for (const month of months) {
      const summary = month.summaries.find((s) => s.employee_id === employee.employeeId) ?? null;
      /* The month's own days, so the variance is the same rule the screens apply. */
      const mine = input.days.filter(
        (d) => d.employee_id === employee.employeeId && d.ist_date.slice(0, 7) === month.from.slice(0, 7),
      );
      const v = periodVariance(mine);

      rows.push([
        employee.code,
        employee.name,
        /* `fmtMonthLong` takes a month KEY, not a date — it throws on "2026-01-01". */
        fmtMonthLong(month.from.slice(0, 7)),
        n(summary?.working_days),
        n(summary?.present_days),
        n(summary?.half_days),
        n(summary?.absent_days),
        n(summary?.leave_days),
        n(summary?.paid_days),
        n(summary?.total_worked_minutes),
        hm(summary?.total_worked_minutes),
        n(summary?.overtime_minutes),
        n(summary?.late_days),
        input.truncated === true ? null : signedMinutes(v.varianceMinutes),
        input.truncated === true ? null : v.surplusMinutes,
        input.truncated === true ? null : v.shortfallMinutes,
      ]);
    }
  }

  return {
    name: t("attendance.export.sheet.monthWise"),
    columns: [
      { header: t("attendance.export.col.code"), width: 10 },
      { header: t("attendance.export.col.name"), width: 26 },
      { header: t("attendance.export.col.month"), width: 18 },
      { header: t("attendance.export.col.workingDays"), width: 13 },
      { header: t("attendance.export.col.present"), width: 10 },
      { header: t("attendance.export.col.halfDays"), width: 11 },
      { header: t("attendance.export.col.absent"), width: 9 },
      { header: t("attendance.export.col.leaveDays"), width: 12 },
      { header: t("attendance.export.col.paidDays"), width: 11 },
      { header: t("attendance.export.col.workedMin"), width: 14 },
      { header: t("attendance.export.col.workedHm"), width: 12 },
      { header: t("attendance.export.col.otMin"), width: 14 },
      { header: t("attendance.export.col.lateDays"), width: 11 },
      { header: t("attendance.export.col.varianceMin"), width: 17 },
      { header: t("attendance.export.col.extraMin"), width: 16 },
      { header: t("attendance.export.col.shortMin"), width: 16 },
    ],
    rows,
  };
}

// -----------------------------------------------------------------------------
// The cover, and the assembly
// -----------------------------------------------------------------------------

/**
 * The first sheet: what this file is, over what period, for whom, and what it could not count.
 *
 * A spreadsheet with no period on it is worthless in a meeting and dangerous in a file — the
 * same rule `exportReport.ts` enforces for CSV and PDF, and for the same reason: nobody
 * downstream can tell a figure from a different, wrong one.
 */
function aboutSheet(input: WorkbookInput): XlsxSheet {
  const rows: XlsxValue[][] = [
    [t("attendance.export.about.report"), t("attendance.export.title")],
    [t("attendance.export.about.period"), input.rangeLabel],
    [t("attendance.export.about.from"), input.from],
    [t("attendance.export.about.to"), input.to],
    [t("attendance.export.about.people"), input.employees.length],
    [t("attendance.export.about.generated"), input.generatedAt],
    [t("attendance.export.about.basis"), t("attendance.export.about.basisText")],
  ];
  if (input.truncated === true) {
    rows.push([t("attendance.export.about.capped"), t("attendance.export.about.cappedText")]);
  }
  return {
    name: t("attendance.export.sheet.about"),
    columns: [
      { header: t("attendance.export.col.field"), width: 22 },
      { header: t("attendance.export.col.value"), width: 80 },
    ],
    rows,
  };
}

export function buildAttendanceSheets(input: WorkbookInput): XlsxSheet[] {
  return [
    aboutSheet(input),
    summarySheet(input),
    balanceSheet(input),
    /* The scope decides only this one. */
    input.scope === "year" ? monthSheet(input) : daySheet(input),
  ];
}
