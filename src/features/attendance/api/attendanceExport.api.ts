/**
 * attendanceExport.api.ts — gathering what the workbook prints.
 *
 * Every read here already existed and is reused rather than reimplemented: the period summary
 * is `f_attendance_period_summary`, the day rows are `v_attendance_day_enriched`, the balances
 * are `v_leave_balance_current`. That is deliberate — an export that queried its own sources
 * would be a second opinion about the same month, and the console would lose the argument.
 *
 * ── SCOPE IS RLS, NOT A PARAMETER ────────────────────────────────────────────
 * `p_employee_id: null` on the summary RPC means "everybody I am allowed to see", because the
 * function is SECURITY INVOKER over `attendance_days` and the policy decides. An employee
 * running this gets exactly themselves without asking for it; an administrator gets their
 * scope. There is no client-side "am I an admin" branch to get wrong.
 *
 * `v_attendance_day_enriched` additionally hides test accounts from everyone but themselves
 * (migration 20260907140000), so the workbook inherits that too — an administrator's export
 * will not have Arghya's testing history in it.
 *
 * ── WHY THE DAYS ARE READ A MONTH AT A TIME ──────────────────────────────────
 * A year for the whole venue is roughly 31,000 employee-days. One request for all of it either
 * exceeds PostgREST's row cap silently or returns a payload nobody should build in a browser.
 * Reading month by month bounds each request, lets the caller see progress, and — the part
 * that matters — makes "we did not get all of it" a fact this module KNOWS rather than one it
 * has to infer from a suspiciously round row count.
 */
import { gte, inList, lte, selectMany, eq, isTrue } from "@/shared/api/query";
import { istMonthRange } from "@/lib/datetime";
import { EMPLOYEE_REF_VIEW, employeeRefSchema } from "@/features/leave/api/leave-apply.api";
import { LEAVE_BALANCE_VIEW, leaveBalanceSchema } from "@/features/leave/api/leave.api";
import {
  DAY_ENRICHED_VIEW,
  attendanceDaySchema,
  attendancePeriodSummarySchema,
  fetchPeriodSummaryForScope,
  type AttendancePeriodSummary,
} from "./attendance.api";
import type {
  ExportScope,
  WorkbookBalance,
  WorkbookDay,
  WorkbookEmployee,
  WorkbookMonth,
} from "../lib/attendanceWorkbook";

export type { ExportScope };

/**
 * The most employee-days one download will carry.
 *
 * Chosen to sit above a year for this venue (~85 people × 365 ≈ 31,000) and well below the
 * point where the browser struggles. Past it the export still produces every sheet, says so on
 * the About sheet, and blanks the variance columns rather than totalling a subset.
 */
export const EXPORT_DAY_CAP = 40_000;

/** One PostgREST request's worth. A month for the whole venue is ~2,600 rows. */
const PAGE = 5_000;

export interface ExportRange {
  readonly from: string;
  readonly to: string;
}

/** First day of each month the range touches, in order. Both bounds are ISO civil dates. */
export function monthStartsIn(range: ExportRange): string[] {
  const out: string[] = [];
  let year = Number(range.from.slice(0, 4));
  let month = Number(range.from.slice(5, 7));
  const endKey = range.to.slice(0, 7);
  for (let guard = 0; guard < 400; guard += 1) {
    const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    out.push(`${key}-01`);
    if (key >= endKey) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/**
 * The last day of the month that `start` opens.
 *
 * `istMonthRange`, not arithmetic on a `Date`: the first draft ended with
 * `toISOString().slice(0, 10)`, which is a UTC civil date and would have put every IST month
 * boundary a day out for half the clock. The repo lints for exactly that and caught it.
 */
export function monthEnd(start: string): string {
  return istMonthRange(start.slice(0, 7)).to;
}

/** Clip a month's span to the range actually asked for. */
function clip(start: string, range: ExportRange): ExportRange {
  const end = monthEnd(start);
  return {
    from: start < range.from ? range.from : start,
    to: end > range.to ? range.to : end,
  };
}

export interface DayFetchResult {
  readonly days: readonly WorkbookDay[];
  readonly truncated: boolean;
}

/**
 * Every day row in the range, a month at a time.
 *
 * `employeeId` narrows it to one person; `null` leaves it to RLS. `onProgress` is called after
 * each month so a button can say "3 of 12" rather than appearing to hang for ten seconds.
 */
export async function fetchExportDays(
  range: ExportRange,
  employeeId: string | null,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<DayFetchResult> {
  const months = monthStartsIn(range);
  const days: WorkbookDay[] = [];
  let truncated = false;

  for (const [index, start] of months.entries()) {
    if (days.length >= EXPORT_DAY_CAP) {
      truncated = true;
      break;
    }
    const span = clip(start, range);
    const rows = await selectMany(DAY_ENRICHED_VIEW, attendanceDaySchema, {
      filters: [
        ...(employeeId === null ? [] : [eq("employee_id", employeeId)]),
        gte("ist_date", span.from),
        lte("ist_date", span.to),
      ],
      order: [
        { column: "ist_date", ascending: true },
        { column: "id", ascending: true },
      ],
      limit: PAGE,
      ...(signal ? { signal } : {}),
    });
    /*
      A month that fills the page exactly is the one case we cannot tell apart from a month
      that was cut off, so it is treated as cut off. Over-reporting incompleteness costs a
      caveat; under-reporting it costs a wrong total.
    */
    if (rows.length >= PAGE) truncated = true;
    /* No cast: `attendanceDaySchema` carries every field `WorkbookDay` prints, and
       letting the compiler prove that is the point of the structural type. */
    days.push(...rows);
    onProgress?.(index + 1, months.length);
  }

  return { days, truncated };
}

/** The server's summary for the whole range — one row per employee in scope. */
export async function fetchExportSummaries(
  range: ExportRange,
  employeeId: string | null,
  signal?: AbortSignal,
): Promise<AttendancePeriodSummary[]> {
  const rows = await fetchPeriodSummaryForScope(range, signal);
  return employeeId === null ? rows : rows.filter((r) => r.employee_id === employeeId);
}

/** One summary per month, for the year export's month-wise sheet. */
export async function fetchExportMonthlySummaries(
  range: ExportRange,
  employeeId: string | null,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<WorkbookMonth[]> {
  const months = monthStartsIn(range);
  const out: WorkbookMonth[] = [];
  for (const [index, start] of months.entries()) {
    const span = clip(start, range);
    const summaries = await fetchExportSummaries(span, employeeId, signal);
    out.push({ from: start, summaries });
    onProgress?.(index + 1, months.length);
  }
  return out;
}

/** Leave balances for the current leave year. Scope again decided by RLS. */
export async function fetchExportBalances(
  employeeId: string | null,
  signal?: AbortSignal,
): Promise<WorkbookBalance[]> {
  const rows = await selectMany(LEAVE_BALANCE_VIEW, leaveBalanceSchema, {
    filters: [
      ...(employeeId === null ? [] : [eq("employee_id", employeeId)]),
      isTrue("leave_type_active"),
    ],
    order: [{ column: "leave_type_code", ascending: true }],
    limit: 2_000,
    ...(signal ? { signal } : {}),
  });
  return rows;
}

/**
 * Names and codes for the ids the export turned up.
 *
 * Read from `v_employee_ref` rather than carried down from whatever screen launched this: the
 * employee's own page holds one identity and the admin grid holds a map of a few hundred, and
 * a builder that accepted either would have to know which. Ids in, labels out.
 */
export async function fetchExportEmployees(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<WorkbookEmployee[]> {
  if (ids.length === 0) return [];
  const rows = await selectMany(EMPLOYEE_REF_VIEW, employeeRefSchema, {
    columns: "id, profile_id, employee_code, display_name, designation_name",
    filters: [inList("id", [...ids])],
    order: [{ column: "display_name", ascending: true }],
    limit: 2_000,
    ...(signal ? { signal } : {}),
  });
  return rows.map((r) => ({
    employeeId: r.id,
    code: r.employee_code,
    name: r.display_name ?? "",
  }));
}

/** Every employee the export found something for, day rows and summaries alike. */
export function employeeIdsIn(
  days: readonly WorkbookDay[],
  summaries: readonly AttendancePeriodSummary[],
): string[] {
  const seen = new Set<string>();
  for (const d of days) seen.add(d.employee_id);
  for (const s of summaries) seen.add(s.employee_id);
  return [...seen];
}

export { attendancePeriodSummarySchema };
