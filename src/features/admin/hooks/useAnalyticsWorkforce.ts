/**
 * useAnalyticsWorkforce.ts — TanStack hooks for the four §14 analytics screens
 * in this module: the analytics home, Workforce, Attendance and Leave.
 *
 * Two shapes recur here and both are deliberate:
 *
 *  1. A BREAKDOWN IS N SERVER COUNTS, NOT ONE SUM. "Headcount by department" is
 *     one `count=exact` per department built from the directory's own
 *     predicates, so every bar equals the row set its drill-through opens. The
 *     alternative — load rows, group them in the browser — is client arithmetic
 *     and is how a chart and a grid start disagreeing.
 *  2. `useQueries` for the fan-out. Each slice keeps its own cache entry, error
 *     and pending state, so one failed count renders as `—` on ONE bar instead
 *     of blanking the whole panel.
 *
 * Query keys hang off `qk.admin.list({ analytics: … })`. Nothing here writes, so
 * no invalidation prefix is needed; `staleTime` is a minute because these are
 * reports, not an operations board.
 */
import { useMemo } from "react";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { istMonthRange, nowIstDate } from "@/lib/datetime";
import { countDayRecords } from "../api/attendance.api";
import {
  employmentStatusValues,
  employmentTypeValues,
  type EmploymentStatus,
  type EmploymentType,
} from "../api/employees.api";
import { fetchEmployeeOptions } from "../api/employees.api";
import { fetchLeaveTypes, type LeaveBalance, type LeaveType } from "../api/leave.api";
import {
  HEADLINE_MEASURES,
  LEDGER_COUNTED_TYPES,
  LIFECYCLE_COUNTED_TYPES,
  countByStatus,
  countHeadcount,
  countLeaveRecords,
  countLedgerEntries,
  countLifecycleEvents,
  fetchAttendanceMonthly,
  fetchAttendanceStamp,
  fetchCurrentLeaveYear,
  fetchHeadcountMonthly,
  fetchHeadcountStamp,
  fetchHeadline,
  fetchHourBuckets,
  fetchLatestFirstIns,
  fetchLateTrend,
  fetchLeaveConsumption,
  type AttendanceMonthlyRow,
  type HeadcountMonthlyRow,
  type HeadlineFigure,
  type HeadlineMeasure,
  type HourBucketRow,
  type InTrendRow,
  type LateTrendRow,
  type LeaveScope,
  type LeaveSlice,
  type LedgerCountedType,
  type LifecycleCountedType,
  type RefreshStamp,
} from "../api/analytics-workforce.api";
import type { RefOption } from "./useMasters";

/** Reports refetch on revisit, not on a timer. */
const REPORT_STALE_MS = 60_000;

/** Row cap on every analytics grid — the screen says so when it is reached. */
export const ANALYTICS_ROW_CAP = 200;

/** How many "latest first scan" rows the attendance screen lists. */
export const FIRST_IN_ROW_CAP = 20;

// -----------------------------------------------------------------------------
// 1. Analytics home
// -----------------------------------------------------------------------------

export type HeadlineQuery = UseQueryResult<HeadlineFigure, Error>;

/**
 * One headline figure per analytics screen that has a deployed relation behind
 * it, keyed by measure. Screens with no backing relation are simply absent from
 * the map and the page says why.
 */
export function useAnalyticsHeadlines(): ReadonlyMap<HeadlineMeasure, HeadlineQuery> {
  const results = useQueries({
    queries: HEADLINE_MEASURES.map((measure) => ({
      queryKey: qk.admin.list({ analytics: "home", measure }),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchHeadline(measure, signal),
      staleTime: REPORT_STALE_MS,
      retry: shouldRetryQuery,
    })),
  });
  return useMemo(() => {
    const map = new Map<HeadlineMeasure, HeadlineQuery>();
    HEADLINE_MEASURES.forEach((measure, i) => {
      const result = results[i];
      if (result !== undefined) map.set(measure, result);
    });
    return map;
  }, [results]);
}

// -----------------------------------------------------------------------------
// 2. Workforce
// -----------------------------------------------------------------------------

/** A named slice and the server count behind it. */
export interface CountSlice {
  readonly key: string;
  readonly label: string;
  readonly query: UseQueryResult<number, Error>;
}

/** Employees on roll right now — the same predicate as the directory's default. */
export function useOnRollCount(): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "workforce", dim: "onRoll" }),
    queryFn: ({ signal }) => countHeadcount({}, signal),
    staleTime: REPORT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** One count per lifecycle state, in the enum's own order. */
export function useHeadcountByStatus(): readonly CountSlice[] {
  const results = useQueries({
    queries: employmentStatusValues.map((status: EmploymentStatus) => ({
      queryKey: qk.admin.list({ analytics: "workforce", dim: "status", status }),
      queryFn: ({ signal }: { signal: AbortSignal }) => countByStatus(status, signal),
      staleTime: REPORT_STALE_MS,
      retry: shouldRetryQuery,
    })),
  });
  return useMemo(
    () =>
      employmentStatusValues.flatMap((status, i) => {
        const query = results[i];
        return query === undefined ? [] : [{ key: status, label: status, query }];
      }),
    [results],
  );
}

/** One count per employment type, on-roll employees only. */
export function useHeadcountByType(): readonly CountSlice[] {
  const results = useQueries({
    queries: employmentTypeValues.map((employmentType: EmploymentType) => ({
      queryKey: qk.admin.list({ analytics: "workforce", dim: "type", employmentType }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        countHeadcount({ employmentType }, signal),
      staleTime: REPORT_STALE_MS,
      retry: shouldRetryQuery,
    })),
  });
  return useMemo(
    () =>
      employmentTypeValues.flatMap((employmentType, i) => {
        const query = results[i];
        return query === undefined ? [] : [{ key: employmentType, label: employmentType, query }];
      }),
    [results],
  );
}

/**
 * One count per department, plus an "unassigned" slice for
 * `department_id IS NULL` — the rows a per-department sum would silently drop.
 */
export function useHeadcountByDepartment(
  departments: readonly RefOption[],
  unassignedLabel: string,
): readonly CountSlice[] {
  const results = useQueries({
    queries: [
      ...departments.map((department) => ({
        queryKey: qk.admin.list({ analytics: "workforce", dim: "dept", id: department.id }),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          countHeadcount({ departmentId: department.id }, signal),
        staleTime: REPORT_STALE_MS,
        retry: shouldRetryQuery,
      })),
      {
        queryKey: qk.admin.list({ analytics: "workforce", dim: "dept", id: "none" }),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          countHeadcount({ noDepartment: true }, signal),
        staleTime: REPORT_STALE_MS,
        retry: shouldRetryQuery,
      },
    ],
  });
  return useMemo(() => {
    const slices: CountSlice[] = [];
    departments.forEach((department, i) => {
      const query = results[i];
      if (query !== undefined) slices.push({ key: department.id, label: department.name, query });
    });
    const unassigned = results[departments.length];
    if (unassigned !== undefined)
      slices.push({ key: "none", label: unassignedLabel, query: unassigned });
    return slices;
  }, [departments, results, unassignedLabel]);
}

/** `v_headcount_monthly` for one calendar year, optionally one department. */
export function useHeadcountMonthly(
  year: number,
  departmentId: string | null,
): UseQueryResult<HeadcountMonthlyRow[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "workforce", series: "monthly", year, departmentId }),
    queryFn: ({ signal }) => fetchHeadcountMonthly(year, departmentId, signal),
    staleTime: REPORT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** The matview's own refresh stamp — the workforce screen's "as of" line. */
export function useHeadcountStamp(): UseQueryResult<RefreshStamp | null, Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "workforce", stamp: true }),
    queryFn: ({ signal }) => fetchHeadcountStamp(signal),
    staleTime: REPORT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** Un-reversed lifecycle events of each counted type inside one calendar year. */
export function useLifecycleCounts(year: number): readonly CountSlice[] {
  const from = `${String(year)}-01-01`;
  const to = `${String(year)}-12-31`;
  const results = useQueries({
    queries: LIFECYCLE_COUNTED_TYPES.map((eventType: LifecycleCountedType) => ({
      queryKey: qk.admin.list({ analytics: "workforce", lifecycle: eventType, year }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        countLifecycleEvents(eventType, from, to, signal),
      staleTime: REPORT_STALE_MS,
      retry: shouldRetryQuery,
    })),
  });
  return useMemo(
    () =>
      LIFECYCLE_COUNTED_TYPES.flatMap((eventType, i) => {
        const query = results[i];
        return query === undefined ? [] : [{ key: eventType, label: eventType, query }];
      }),
    [results],
  );
}

// -----------------------------------------------------------------------------
// 3. Attendance analytics
// -----------------------------------------------------------------------------

/** Per-date late / on-time / absent counts for a month window. */
export function useLateTrend(from: string, to: string): UseQueryResult<LateTrendRow[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "attendance", trend: "late", from, to }),
    queryFn: ({ signal }) => fetchLateTrend(from, to, signal),
    staleTime: REPORT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** Hours-worked distribution for one date. */
export function useHourBuckets(isoDate: string): UseQueryResult<HourBucketRow[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "attendance", buckets: isoDate }),
    queryFn: ({ signal }) => fetchHourBuckets(isoDate, signal),
    staleTime: REPORT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** The latest first-scans on one date (server-ordered). */
export function useLatestFirstIns(isoDate: string): UseQueryResult<InTrendRow[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "attendance", firstIn: isoDate }),
    queryFn: ({ signal }) => fetchLatestFirstIns(isoDate, FIRST_IN_ROW_CAP, signal),
    staleTime: REPORT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** `v_attendance_monthly_summary` rows for one (year, month). */
export function useAttendanceMonthly(
  year: number,
  month: number,
): UseQueryResult<AttendanceMonthlyRow[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "attendance", monthly: `${String(year)}-${String(month)}` }),
    queryFn: ({ signal }) => fetchAttendanceMonthly(year, month, ANALYTICS_ROW_CAP, signal),
    staleTime: REPORT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** The attendance matview's refresh stamp, independent of the chosen month. */
export function useAttendanceStamp(): UseQueryResult<string | null, Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "attendance", stamp: true }),
    queryFn: ({ signal }) => fetchAttendanceStamp(signal),
    staleTime: REPORT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** Which slice of the month's employee-days a tile counts. */
export type DaySlice = "all" | "late" | "absent" | "exceptions";

const DAY_SLICES: readonly DaySlice[] = ["all", "late", "absent", "exceptions"];

/**
 * Employee-day counts for a month, over `v_attendance_day_enriched` — the same
 * view and the same predicates as the Day Records grid these tiles link into.
 */
export function useMonthDayCounts(month: string): ReadonlyMap<DaySlice, UseQueryResult<number, Error>> {
  const { from, to } = istMonthRange(month);
  const results = useQueries({
    queries: DAY_SLICES.map((slice) => ({
      queryKey: qk.admin.list({ analytics: "attendance", days: slice, month }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        countDayRecords(
          {
            from,
            to,
            ...(slice === "late" ? { onlyLate: true } : {}),
            ...(slice === "absent" ? { statuses: ["absent" as const] } : {}),
            ...(slice === "exceptions" ? { onlyExceptions: true } : {}),
          },
          signal,
        ),
      staleTime: REPORT_STALE_MS,
      retry: shouldRetryQuery,
    })),
  });
  return useMemo(() => {
    const map = new Map<DaySlice, UseQueryResult<number, Error>>();
    DAY_SLICES.forEach((slice, i) => {
      const result = results[i];
      if (result !== undefined) map.set(slice, result);
    });
    return map;
  }, [results]);
}

// -----------------------------------------------------------------------------
// 4. Leave analytics
// -----------------------------------------------------------------------------

/** The leave year Postgres is in today. */
export function useCurrentLeaveYear(): UseQueryResult<number | null, Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "leave", leaveYear: nowIstDate() }),
    queryFn: ({ signal }) => fetchCurrentLeaveYear(signal),
    staleTime: REPORT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** Active leave types, for the type filter and the per-type panel. */
export function useAnalyticsLeaveTypes(): UseQueryResult<LeaveType[], Error> {
  return useQuery({
    queryKey: qk.admin.leaveTypes(),
    queryFn: ({ signal }) => fetchLeaveTypes({ includeInactive: true }, signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/**
 * The employee ids in one department. `v_leave_balance_current` carries no
 * department column, so scoping leave to a department means naming its
 * employees — a join the client is allowed to make, unlike a rollup it is not.
 */
export function useDepartmentEmployeeIds(
  departmentId: string,
): UseQueryResult<readonly string[], Error> {
  return useQuery({
    queryKey: qk.admin.employees({ scope: "analytics-leave-dept", departmentId }),
    queryFn: async ({ signal }) => {
      const rows = await fetchEmployeeOptions({ departmentIds: [departmentId] }, 500, signal);
      return rows.map((row) => row.id);
    },
    enabled: departmentId !== "",
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

function scopeKey(scope: LeaveScope): Record<string, unknown> {
  return {
    employeeIds: scope.employeeIds === undefined ? null : [...scope.employeeIds].sort(),
    leaveTypeId: scope.leaveTypeId ?? null,
  };
}

const LEAVE_SLICES: readonly LeaveSlice[] = ["all", "consumed", "exhausted", "expiring"];

/** Four server counts over `v_leave_balance_current`, all in the same scope. */
export function useLeaveSliceCounts(
  scope: LeaveScope,
  enabled: boolean,
): ReadonlyMap<LeaveSlice, UseQueryResult<number, Error>> {
  const key = scopeKey(scope);
  const results = useQueries({
    queries: LEAVE_SLICES.map((slice) => ({
      queryKey: qk.admin.leaveBalances({ analytics: "slice", slice, ...key }),
      queryFn: ({ signal }: { signal: AbortSignal }) => countLeaveRecords(scope, slice, signal),
      enabled,
      staleTime: REPORT_STALE_MS,
      retry: shouldRetryQuery,
    })),
  });
  return useMemo(() => {
    const map = new Map<LeaveSlice, UseQueryResult<number, Error>>();
    LEAVE_SLICES.forEach((slice, i) => {
      const result = results[i];
      if (result !== undefined) map.set(slice, result);
    });
    return map;
  }, [results]);
}

/**
 * Per leave type: how many employee × type records hold it, and how many of
 * those show consumption. Two counts per type, each one a server count in the
 * same scope as the grid below it.
 */
export interface LeaveTypeSlice {
  readonly id: string;
  readonly name: string;
  readonly holders: UseQueryResult<number, Error>;
  readonly consumers: UseQueryResult<number, Error>;
}

export function useLeaveTypeCounts(
  types: readonly LeaveType[],
  scope: LeaveScope,
  enabled: boolean,
): readonly LeaveTypeSlice[] {
  const key = scopeKey(scope);
  const results = useQueries({
    queries: types.flatMap((type) => [
      {
        queryKey: qk.admin.leaveBalances({
          analytics: "type",
          slice: "all",
          typeId: type.id,
          ...key,
        }),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          countLeaveRecords({ ...scope, leaveTypeId: type.id }, "all", signal),
        enabled,
        staleTime: REPORT_STALE_MS,
        retry: shouldRetryQuery,
      },
      {
        queryKey: qk.admin.leaveBalances({
          analytics: "type",
          slice: "consumed",
          typeId: type.id,
          ...key,
        }),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          countLeaveRecords({ ...scope, leaveTypeId: type.id }, "consumed", signal),
        enabled,
        staleTime: REPORT_STALE_MS,
        retry: shouldRetryQuery,
      },
    ]),
  });
  return useMemo(
    () =>
      types.flatMap((type, i) => {
        const holders = results[i * 2];
        const consumers = results[i * 2 + 1];
        if (holders === undefined || consumers === undefined) return [];
        return [{ id: type.id, name: type.name, holders, consumers }];
      }),
    [results, types],
  );
}

/** The heaviest-consumption balance rows in scope, server-ordered. */
export function useLeaveConsumption(
  scope: LeaveScope,
  enabled: boolean,
): UseQueryResult<LeaveBalance[], Error> {
  return useQuery({
    queryKey: qk.admin.leaveBalances({ analytics: "consumption", ...scopeKey(scope) }),
    queryFn: ({ signal }) => fetchLeaveConsumption(scope, ANALYTICS_ROW_CAP, signal),
    enabled,
    staleTime: REPORT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** How many ledger movements of each counted kind exist in the leave year. */
export function useLedgerKindCounts(
  leaveYear: number | null,
  scope: LeaveScope,
): readonly CountSlice[] {
  const key = scopeKey(scope);
  const year = leaveYear ?? 0;
  const results = useQueries({
    queries: LEDGER_COUNTED_TYPES.map((entryType: LedgerCountedType) => ({
      queryKey: qk.admin.leaveLedger("analytics", { entryType, year, ...key }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        countLedgerEntries(entryType, year, scope, signal),
      enabled: leaveYear !== null,
      staleTime: REPORT_STALE_MS,
      retry: shouldRetryQuery,
    })),
  });
  return useMemo(
    () =>
      LEDGER_COUNTED_TYPES.flatMap((entryType, i) => {
        const query = results[i];
        return query === undefined ? [] : [{ key: entryType, label: entryType, query }];
      }),
    [results],
  );
}
