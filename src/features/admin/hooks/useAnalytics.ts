/**
 * useAnalytics.ts — TanStack hooks for the filterable, drill-through analytics
 * surface. One `AnalyticsFilters` in, every panel on the screen out.
 *
 * THE ONE THING WORTH UNDERSTANDING HERE: ONE FETCH, MANY PANELS.
 * ---------------------------------------------------------------
 * A single analytics screen wants the headline tiles, the department bars, the
 * employee list and the daily line — all four over the SAME period and the SAME
 * dimensions. Naively that is four hooks, four query keys and four reads of the
 * same ten thousand day rows.
 *
 * Instead every panel hook calls `useQuery` with the IDENTICAL query key and its
 * own `select`. TanStack dedupes by key, so the network read happens ONCE, is
 * cached once, and each hook receives its own projection of that one page —
 * memoised per hook and structurally shared across refetches. It also means the
 * four panels can never disagree: they are four views of one array of rows, not
 * four answers to four questions asked a few hundred milliseconds apart.
 *
 * The dimension masters (departments, locations) are read through their own
 * cached query and the scope is derived from them SYNCHRONOUSLY, so stepping the
 * period a dozen times re-reads the day rows and nothing else.
 *
 * Nothing here writes, so there is no invalidation prefix. `staleTime` is a
 * minute: this is a report, not an operations board — the exception being
 * `useTodayBoard`, which is exactly an operations board and is given fifteen
 * seconds.
 */
import { useCallback, useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { filtersToParams, type AnalyticsFilters } from "@/lib/analyticsFilters";
import type { Period } from "@/lib/period";
import {
  EMPTY_CAPTURE_SPLIT,
  NO_ORG_REFS,
  analyticsScopeNeedsMasters,
  dailyTrendOf,
  departmentBreakdownOf,
  employeeBreakdownOf,
  employeeDetailOf,
  fetchAnalyticsDays,
  fetchCaptureSplit,
  fetchFilterOptions,
  fetchTodayBoard,
  locationBreakdownOf,
  scopeFrom,
  summaryOf,
  type AnalyticsDayPage,
  type AttendanceSummaryResult,
  type CaptureSplitResult,
  type DailyTrendResult,
  type DepartmentBreakdownResult,
  type EmployeeBreakdownResult,
  type EmployeeDetailResult,
  type FilterOptions,
  type LocationBreakdownResult,
  type ResolvedScope,
  type TodayBoardResult,
} from "../api/analytics.api";

/** Reports refetch on revisit, not on a timer. */
const ANALYTICS_STALE_MS = 60_000;

/** The live board is a different animal — it is answering "right now". */
const BOARD_STALE_MS = 15_000;

/** Masters change a few times a year; one read per session is plenty. */
const MASTERS_STALE_MS = 5 * 60_000;

// -----------------------------------------------------------------------------
// Filter bar options + scope
// -----------------------------------------------------------------------------

/**
 * Departments and locations for the filter bar dropdowns.
 *
 * `enabled` exists so an unfiltered dashboard does not read two master tables it
 * has no use for; the filter bar itself always passes true.
 */
export function useAnalyticsFilterOptions(enabled = true): UseQueryResult<FilterOptions, Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "filter-options" }),
    queryFn: ({ signal }) => fetchFilterOptions(signal),
    enabled,
    staleTime: MASTERS_STALE_MS,
    retry: shouldRetryQuery,
  });
}

export interface AnalyticsScopeState {
  /** Null while the masters a dimension filter needs are still loading. */
  readonly scope: ResolvedScope | null;
  /** The masters read failed — the panels below cannot be trusted to be scoped. */
  readonly error: Error | null;
  readonly isPending: boolean;
}

/**
 * The resolved scope for these filters: the `query.ts` predicates, the resolved
 * department/location names for headings, and the caveats
 * (`analytics.caveat.*`) the screen must print.
 *
 * Derived synchronously from the cached masters — see the header. Exposed on its
 * own because the filter bar wants to name the department it is filtering by
 * before ten thousand day rows have arrived.
 */
export function useAnalyticsScope(filters: AnalyticsFilters): AnalyticsScopeState {
  const needsMasters = analyticsScopeNeedsMasters(filters);
  const options = useAnalyticsFilterOptions(needsMasters);
  const refs = options.data;

  const scope = useMemo<ResolvedScope | null>(() => {
    if (!needsMasters) return scopeFrom(filters, NO_ORG_REFS);
    if (refs === undefined) return null;
    return scopeFrom(filters, refs);
  }, [filters, needsMasters, refs]);

  return {
    scope,
    error: needsMasters ? options.error : null,
    isPending: scope === null && options.error === null,
  };
}

// -----------------------------------------------------------------------------
// The shared day-page query
// -----------------------------------------------------------------------------

/**
 * The key EVERY panel hook shares. Built from `filtersToParams`, which is the
 * same serialisation the URL uses — so two screens showing the same filtered
 * view hit the same cache entry, and a cache entry can be read off the address
 * bar when something looks wrong.
 */
function dayPageKey(filters: AnalyticsFilters): readonly unknown[] {
  return qk.admin.list({ analytics: "days", ...filtersToParams(filters) });
}

/**
 * One cached read of the day rows, projected by `select`.
 *
 * `select` must be referentially stable (module-level function, or `useCallback`)
 * or TanStack re-runs the projection on every render.
 */
function useDayPage<T>(
  filters: AnalyticsFilters,
  select: (page: AnalyticsDayPage) => T,
  enabled = true,
): UseQueryResult<T, Error> {
  const { scope, error: scopeError } = useAnalyticsScope(filters);
  return useQuery({
    queryKey: dayPageKey(filters),
    queryFn: ({ signal }) =>
      // With no pre-resolved scope (the masters read failed) the fetcher resolves
      // it itself and rethrows the same failure — so the panel shows the honest
      // error instead of spinning forever behind a disabled query.
      fetchAnalyticsDays(filters, { signal, ...(scope !== null ? { scope } : {}) }),
    enabled: enabled && (scope !== null || scopeError !== null),
    select,
    staleTime: ANALYTICS_STALE_MS,
    retry: shouldRetryQuery,
  });
}

const identityPage = (page: AnalyticsDayPage): AnalyticsDayPage => page;

/** The raw day rows behind every panel — for an export or a debug table. */
export function useAnalyticsDays(filters: AnalyticsFilters): UseQueryResult<AnalyticsDayPage, Error> {
  return useDayPage(filters, identityPage);
}

// -----------------------------------------------------------------------------
// Panels — all four read the ONE cached page above
// -----------------------------------------------------------------------------

/** Headline aggregates for the period: the KPI strip. */
export function useAttendanceSummary(
  filters: AnalyticsFilters,
): UseQueryResult<AttendanceSummaryResult, Error> {
  return useDayPage(filters, summaryOf);
}

/** The same measures per department — the bars you click to drill in. */
export function useDepartmentBreakdown(
  filters: AnalyticsFilters,
): UseQueryResult<DepartmentBreakdownResult, Error> {
  return useDayPage(filters, departmentBreakdownOf);
}

/** The same measures per location. */
export function useLocationBreakdown(
  filters: AnalyticsFilters,
): UseQueryResult<LocationBreakdownResult, Error> {
  return useDayPage(filters, locationBreakdownOf);
}

/** The same measures per employee — the list the department bars open. */
export function useEmployeeBreakdown(
  filters: AnalyticsFilters,
): UseQueryResult<EmployeeBreakdownResult, Error> {
  return useDayPage(filters, employeeBreakdownOf);
}

/** One point per IST date in the period — the charts. */
export function useDailyTrend(filters: AnalyticsFilters): UseQueryResult<DailyTrendResult, Error> {
  return useDayPage(filters, dailyTrendOf);
}

/**
 * One employee's days plus their averages. Disabled until an employee is chosen:
 * without `filters.employeeId` this would read the whole venue to describe
 * nobody.
 *
 * Note the shared key still applies — when the employee filter is set, the page
 * behind every panel is already narrowed to that employee server-side, so this
 * hook adds no network traffic at all.
 */
export function useEmployeeDetail(
  filters: AnalyticsFilters,
): UseQueryResult<EmployeeDetailResult, Error> {
  const employeeId = filters.employeeId ?? null;
  const select = useCallback(
    (page: AnalyticsDayPage) => employeeDetailOf(page, employeeId),
    [employeeId],
  );
  return useDayPage(filters, select, employeeId !== null);
}

/**
 * How one employee's scans were captured over the period — web, gate tablet,
 * mobile, hand-entered, imported.
 *
 * A different GRAIN from every hook above (scans, not days) and therefore a
 * different key: it must not share the day-page cache entry, or clearing one
 * would drop the other. Disabled until the employee is known, because the
 * predicate without an employee is the whole venue's scan log.
 */
export function useCaptureSplit(
  employeeId: string | null,
  period: Period,
): UseQueryResult<CaptureSplitResult, Error> {
  return useQuery({
    queryKey: qk.admin.punches({
      analytics: "capture-split",
      employee: employeeId,
      from: period.from,
      to: period.to,
    }),
    queryFn: ({ signal }) =>
      employeeId === null
        ? Promise.resolve(EMPTY_CAPTURE_SPLIT)
        : fetchCaptureSplit(employeeId, period, { signal }),
    enabled: employeeId !== null,
    staleTime: ANALYTICS_STALE_MS,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Today board
// -----------------------------------------------------------------------------

/**
 * "How many are in today" — its own relation, its own grain, its own cadence.
 * Deliberately takes no filters: `v_attendance_today_board` is pinned to
 * `util.ist_today()` and answering a period from it would be a lie.
 */
export function useTodayBoard(): UseQueryResult<TodayBoardResult, Error> {
  return useQuery({
    queryKey: qk.admin.todayBoard({ analytics: "tiles" }),
    queryFn: ({ signal }) => fetchTodayBoard({ signal }),
    staleTime: BOARD_STALE_MS,
    retry: shouldRetryQuery,
  });
}
