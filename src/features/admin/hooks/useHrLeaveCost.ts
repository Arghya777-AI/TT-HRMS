/**
 * useHrLeaveCost.ts — TanStack hooks for the Leave & Cost panel. One
 * `AnalyticsFilters` in, seven blocks out.
 *
 * WHY THIS IS NOT `useAnalytics.ts`'S "ONE FETCH, MANY PANELS"
 * ------------------------------------------------------------
 * `useAnalytics.ts` gives every panel the IDENTICAL query key and a different
 * `select`, because all four of its panels are projections of ONE array of
 * attendance day rows. That is exactly right there and would be wrong here: these
 * blocks read six different relations at five different grains. Sharing one key
 * would mean a failure in the payroll read blanking the leave liability, and a
 * caller without the payroll capability paying for a query it must not run.
 *
 * So each relation gets its own cache entry, and the ONE thing that IS shared is
 * shared properly:
 *
 *   * THE SCOPE. Resolving a department to an employee list is a directory read
 *     (a `count=exact` plus, if it is small enough, the ids). It happens ONCE per
 *     filter state in {@link useLeaveCostScope} and every fetcher is handed the
 *     result, so stepping the period re-reads the data and not the masters.
 *   * THE CALENDAR PAGE. "Leave taken" and "roster density" are the same rows
 *     grouped two ways, so they are one query with two projections — the
 *     `useAnalytics` pattern, applied where it actually holds.
 *
 * THE PAYROLL GATE. `useHrPayrollCost` and `useHrPayrollVariance` take an
 * `enabled` flag and the panel passes `can("admin.access")` — the capability every
 * payroll route in `route-manifest.ts` is mapped to (tier A and A/S both resolve to
 * it; no payroll row is tier S). Hiding is UX only, exactly as
 * `shared/auth/capabilities.ts` says: the real gate is `WHERE app.is_admin()`
 * inside `v_payroll_cost_monthly` and `v_payroll_variance`. The flag is here so a
 * user without it does not fire two reads that RLS will return empty, which would
 * render as "cost is zero" rather than "cost is not yours to see".
 *
 * Nothing here writes, so there is no invalidation prefix. `staleTime` is a minute:
 * this is a report, not an operations board.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { filtersToParams, type AnalyticsFilters } from "@/lib/analyticsFilters";
import {
  fetchCompOffExpiry,
  fetchLeaveCalendarPage,
  fetchLeaveLiability,
  fetchLeaveMovement,
  fetchPayrollCost,
  fetchPayrollVariance,
  leaveCostScopeNeedsDirectory,
  resolveLeaveCostScope,
  unscoped,
  type CompOffResult,
  type LeaveCalendarPage,
  type LeaveCostScope,
  type LeaveLiabilityResult,
  type LeaveMovementResult,
  type PayrollCostResult,
  type PayrollVarianceResult,
} from "../api/hr-leavecost.api";

/** Reports refetch on revisit, not on a timer. */
const LEAVE_COST_STALE_MS = 60_000;

/** A department's membership changes a few times a month, not a few times a minute. */
const SCOPE_STALE_MS = 5 * 60_000;

/**
 * The key prefix every block shares, built from `filtersToParams` — the same
 * serialisation the URL uses, so a cache entry can be read straight off the address
 * bar when a figure looks wrong.
 */
function blockKey(filters: AnalyticsFilters, block: string): Record<string, unknown> {
  return { panel: "leave-cost", block, ...filtersToParams(filters) };
}

// -----------------------------------------------------------------------------
// Scope — resolved once, handed to every fetcher
// -----------------------------------------------------------------------------

export interface LeaveCostScopeState {
  /** Null while the directory read a department filter needs is still in flight. */
  readonly scope: LeaveCostScope | null;
  readonly error: Error | null;
  readonly isPending: boolean;
}

/**
 * The resolved scope for these filters.
 *
 * With no department filter this needs no network at all and settles synchronously,
 * which is why the query is disabled rather than merely fast: an unfiltered panel
 * must not read the employee directory to learn that it does not need it.
 */
export function useLeaveCostScope(filters: AnalyticsFilters): LeaveCostScopeState {
  const needsDirectory = leaveCostScopeNeedsDirectory(filters);

  const query = useQuery({
    queryKey: qk.admin.list(blockKey(filters, "scope")),
    queryFn: ({ signal }) => resolveLeaveCostScope(filters, signal),
    enabled: needsDirectory,
    staleTime: SCOPE_STALE_MS,
    retry: shouldRetryQuery,
  });

  const local = useMemo(() => unscoped(filters.period), [filters.period]);

  if (!needsDirectory) return { scope: local, error: null, isPending: false };
  return {
    scope: query.data ?? null,
    error: query.error,
    // A failed masters read is NOT pending: the blocks below must render the error
    // rather than spin behind a query that will never be enabled.
    isPending: query.data === undefined && query.error === null,
  };
}

/**
 * A block's `enabled` flag: run once the scope is known, or once it has definitively
 * failed (the fetcher then resolves the scope itself and rethrows the same error, so
 * the block shows the honest failure instead of an eternal skeleton).
 */
function readyFor(state: LeaveCostScopeState, extra = true): boolean {
  return extra && (state.scope !== null || state.error !== null);
}

/** The fetch options a block passes: the shared scope, when there is one. */
function optsFor(state: LeaveCostScopeState, signal: AbortSignal | undefined) {
  return {
    ...(signal ? { signal } : {}),
    ...(state.scope !== null ? { scope: state.scope } : {}),
  };
}

// -----------------------------------------------------------------------------
// Leave blocks
// -----------------------------------------------------------------------------

/** Balance by type and the accrued liability — in DAYS. As at today, not the period. */
export function useLeaveLiability(
  filters: AnalyticsFilters,
): UseQueryResult<LeaveLiabilityResult, Error> {
  const scope = useLeaveCostScope(filters);
  return useQuery({
    queryKey: qk.admin.leaveBalances(blockKey(filters, "liability")),
    queryFn: ({ signal }) => fetchLeaveLiability(filters, optsFor(scope, signal)),
    enabled: readyFor(scope),
    staleTime: LEAVE_COST_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/**
 * ONE read of `v_leave_calendar`, carrying both the taken-by-type/department
 * rollup and the per-date density. Two blocks, one array of rows, so they cannot
 * disagree about how many days were booked.
 */
export function useLeaveCalendarPage(
  filters: AnalyticsFilters,
): UseQueryResult<LeaveCalendarPage, Error> {
  const scope = useLeaveCostScope(filters);
  return useQuery({
    queryKey: qk.admin.list(blockKey(filters, "calendar")),
    queryFn: ({ signal }) => fetchLeaveCalendarPage(filters, optsFor(scope, signal)),
    enabled: readyFor(scope),
    staleTime: LEAVE_COST_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** Comp-off banked and expiring — the action list. A snapshot, not a period. */
export function useCompOffExpiry(
  filters: AnalyticsFilters,
): UseQueryResult<CompOffResult, Error> {
  const scope = useLeaveCostScope(filters);
  return useQuery({
    queryKey: qk.admin.list(blockKey(filters, "comp-off")),
    queryFn: ({ signal }) => fetchCompOffExpiry(filters, optsFor(scope, signal)),
    enabled: readyFor(scope),
    staleTime: LEAVE_COST_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** How balances moved over the period, by ledger entry type. */
export function useLeaveMovement(
  filters: AnalyticsFilters,
): UseQueryResult<LeaveMovementResult, Error> {
  const scope = useLeaveCostScope(filters);
  return useQuery({
    queryKey: qk.admin.list(blockKey(filters, "movement")),
    queryFn: ({ signal }) => fetchLeaveMovement(filters, optsFor(scope, signal)),
    enabled: readyFor(scope),
    staleTime: LEAVE_COST_STALE_MS,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Cost blocks — capability-gated, see the header
// -----------------------------------------------------------------------------

/**
 * Payroll cost per (month × department) for the months the period touches.
 *
 * @param enabled the caller's payroll capability. False keeps the query out of the
 *   cache entirely rather than caching an empty result that would later be mistaken
 *   for "this venue spent nothing".
 */
export function useHrPayrollCost(
  filters: AnalyticsFilters,
  enabled: boolean,
): UseQueryResult<PayrollCostResult, Error> {
  const scope = useLeaveCostScope(filters);
  return useQuery({
    queryKey: qk.admin.list(blockKey(filters, "payroll-cost")),
    queryFn: ({ signal }) => fetchPayrollCost(filters, optsFor(scope, signal)),
    enabled: readyFor(scope, enabled),
    staleTime: LEAVE_COST_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/**
 * Net-pay variance on the newest released run covering those months.
 *
 * DEPENDENT on the cost read by design: `payPeriodIds` comes from the cost rows,
 * which already name every pay period the window touches. That is one fewer master
 * query AND a guarantee that the variance block and the cost block are describing
 * the same run — two independent lookups could pick different ones the moment a
 * rerun is released mid-session.
 */
export function useHrPayrollVariance(
  filters: AnalyticsFilters,
  payPeriodIds: readonly string[] | undefined,
  enabled: boolean,
): UseQueryResult<PayrollVarianceResult, Error> {
  const scope = useLeaveCostScope(filters);
  const ids = payPeriodIds ?? [];
  return useQuery({
    // The pay periods are IN the key alongside the filters: a different set is a
    // different question, and reusing the entry would show last month's run under
    // this month's heading.
    queryKey: qk.admin.list({ ...blockKey(filters, "variance"), periods: ids.join(",") }),
    queryFn: ({ signal }) => fetchPayrollVariance(ids, filters, optsFor(scope, signal)),
    enabled: readyFor(scope, enabled && payPeriodIds !== undefined),
    staleTime: LEAVE_COST_STALE_MS,
    retry: shouldRetryQuery,
  });
}
