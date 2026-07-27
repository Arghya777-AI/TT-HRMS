/**
 * useAttendance.ts — TanStack Query hooks over attendance.api.
 *
 * Keys come from `qk.attendance.*` only (frontend-contract §5); an inline key
 * array cannot be invalidated reliably and is banned.
 *
 * Every hook is scoped to the signed-in employee and stays disabled until
 * identity resolves, so no read fires that RLS would only reject.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import {
  fetchAttendanceDay,
  fetchAttendanceDays,
  fetchMonthToDateSummary,
  fetchMyAttendanceContext,
  fetchPayPeriodByCode,
  fetchPeriodSummary,
  fetchPunchDuplicateFlags,
  fetchPunchesForDay,
  fetchShiftsByIds,
  fetchWeeklyOffRuleRef,
  type AttendanceDay,
  type AttendancePeriodSummary,
  type AttendancePunch,
  type MyAttendanceContext,
  type PayPeriod,
  type PeriodRange,
  type ShiftRefRow,
  type WeeklyOffRuleRef,
} from "../api/attendance.api";

/** Key placeholder while identity resolves; the query is disabled anyway. */
const NO_EMPLOYEE = "no-employee";

/**
 * THE summary row for one calendar month, via `f_attendance_period_summary`.
 *
 * `month` is 'YYYY-MM' (the `?m=` URL param) and only identifies the cache
 * entry; `range` carries the inclusive bounds the server actually aggregates.
 * Deriving month bounds is a date concern and belongs in `lib/datetime`.
 *
 * `data === null` means the period has no attendance rows (before joining, or
 * withheld by RLS) — render the empty/no-permission state, never zeroes.
 */
export function useAttendancePeriodSummary(
  month: string,
  range: PeriodRange,
): UseQueryResult<AttendancePeriodSummary | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.attendance.periodSummary(employeeId ?? NO_EMPLOYEE, month),
    queryFn: ({ signal }) => fetchPeriodSummary(requireEmployeeId(employeeId), range, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** The same row for an arbitrary inclusive range (exports, FY roll-ups). */
export function useAttendanceRangeSummary(
  range: PeriodRange,
  enabled = true,
): UseQueryResult<AttendancePeriodSummary | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.attendance.rangeSummary(employeeId ?? NO_EMPLOYEE, range.from, range.to),
    queryFn: ({ signal }) => fetchPeriodSummary(requireEmployeeId(employeeId), range, signal),
    enabled: enabled && employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Month-to-date summary from the zero-argument view wrapper. Same SQL as the
 * RPC, so the home strip and the attendance screen cannot disagree.
 */
export function useMonthToDateSummary(): UseQueryResult<AttendancePeriodSummary | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.attendance.monthToDate(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchMonthToDateSummary(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** One row per date in the range — the day-by-day grid. */
export function useAttendanceDays(range: PeriodRange): UseQueryResult<AttendanceDay[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.attendance.days(employeeId ?? NO_EMPLOYEE, range.from, range.to),
    queryFn: ({ signal }) => fetchAttendanceDays(requireEmployeeId(employeeId), range, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** One date. `null` = not computed yet (or not visible). */
export function useAttendanceDay(
  istDate: string | undefined,
): UseQueryResult<AttendanceDay | null, Error> {
  const employeeId = useEmployeeId();
  const date = istDate ?? "";
  return useQuery({
    queryKey: qk.attendance.day(employeeId ?? NO_EMPLOYEE, date),
    queryFn: ({ signal }) => fetchAttendanceDay(requireEmployeeId(employeeId), date, signal),
    enabled: employeeId !== null && date.length > 0,
    retry: shouldRetryQuery,
  });
}

/**
 * Every scan filed under one business date. Keyed and filtered on the EFFECTIVE
 * date, so a night-shift punch after midnight lands on the shift's start date.
 */
export function useAttendancePunches(
  effectiveDate: string | undefined,
): UseQueryResult<AttendancePunch[], Error> {
  const employeeId = useEmployeeId();
  const date = effectiveDate ?? "";
  return useQuery({
    queryKey: qk.attendance.punches(employeeId ?? NO_EMPLOYEE, date),
    queryFn: ({ signal }) => fetchPunchesForDay(requireEmployeeId(employeeId), date, signal),
    enabled: employeeId !== null && date.length > 0,
    retry: shouldRetryQuery,
  });
}

/**
 * The ids of the scans the engine collapsed as duplicates on one business date.
 * A Set, because the timeline asks "is this one struck through?" per row.
 */
export function usePunchDuplicateIds(
  effectiveDate: string | undefined,
): UseQueryResult<ReadonlySet<string>, Error> {
  const employeeId = useEmployeeId();
  const date = effectiveDate ?? "";
  return useQuery({
    queryKey: qk.attendance.punchDuplicates(employeeId ?? NO_EMPLOYEE, date),
    queryFn: async ({ signal }) => {
      const rows = await fetchPunchDuplicateFlags(requireEmployeeId(employeeId), date, signal);
      return new Set(rows.filter((r) => r.duplicate_of_punch_id !== null).map((r) => r.id));
    },
    enabled: employeeId !== null && date.length > 0,
    retry: shouldRetryQuery,
  });
}

/**
 * The caller's own join date and policy ids. `null` = no employee record on the
 * login (kiosk-only staff), which the screen renders as no-permission.
 */
export function useMyAttendanceContext(): UseQueryResult<MyAttendanceContext | null, Error> {
  return useQuery({
    queryKey: qk.attendance.context(),
    queryFn: ({ signal }) => fetchMyAttendanceContext(signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Shift master rows for the ids a month's register actually references, keyed by
 * id. The key carries the sorted id list, so navigating months re-reads only
 * when the set of shifts changes.
 */
export function useShiftRefs(
  shiftIds: readonly string[],
): UseQueryResult<ReadonlyMap<string, ShiftRefRow>, Error> {
  const ids = [...new Set(shiftIds)].sort();
  return useQuery({
    queryKey: qk.attendance.shiftRefs(ids),
    queryFn: async ({ signal }) => {
      const rows = await fetchShiftsByIds(ids, signal);
      return new Map(rows.map((row) => [row.id, row]));
    },
    enabled: ids.length > 0,
    retry: shouldRetryQuery,
  });
}

/** The weekly-off rule behind the banner chip. Disabled until the id resolves. */
export function useWeeklyOffRuleRef(
  ruleId: string | null | undefined,
): UseQueryResult<WeeklyOffRuleRef | null, Error> {
  const id = ruleId ?? "";
  return useQuery({
    queryKey: qk.attendance.weeklyOffRule(id),
    queryFn: ({ signal }) => fetchWeeklyOffRuleRef(id, signal),
    enabled: id.length > 0,
    retry: shouldRetryQuery,
  });
}

/**
 * The pay period for a 'YYYY-MM' month — the cutoff date behind the arrears line
 * and the lock that decides whether corrections are still possible.
 */
export function usePayPeriod(month: string): UseQueryResult<PayPeriod | null, Error> {
  return useQuery({
    queryKey: qk.attendance.payPeriod(month),
    queryFn: ({ signal }) => fetchPayPeriodByCode(month, signal),
    enabled: month.length > 0,
    retry: shouldRetryQuery,
  });
}
