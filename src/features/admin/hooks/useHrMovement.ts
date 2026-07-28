/**
 * useHrMovement.ts — TanStack hooks for the Movement & Risk panel. One
 * `AnalyticsFilters` in, every tile, chart and watchlist out.
 *
 * TWO QUERY KEYS, NOT ELEVEN — and not one either.
 * ------------------------------------------------
 * `useAnalytics.ts` proves the pattern: every panel over the same grain shares
 * ONE query key and differs only in `select`, so TanStack fetches once, caches
 * once, and the panels are projections of one array rather than answers to
 * questions asked seconds apart.
 *
 * This panel spans TWO grains, so it has exactly two keys:
 *
 *   * the SNAPSHOT key — `v_headcount_daily`, one row per date × department ×
 *     employment type, refreshed nightly. The headcount line, the joiners/exits
 *     bars, the attrition rate and the department table are all `select`s over it.
 *   * the LIVE key — `v_admin_employee`, five capped watchlist reads. Every
 *     watchlist, the exit-quality breakdown and the live joiner/exit counts are
 *     `select`s over it.
 *
 * Merging them would be wrong, not merely inconvenient: they have different
 * staleness (a nightly matview versus live rows), different natural cache
 * lifetimes, and clearing one must not drop the other. Splitting them further
 * would re-read the same rows once per panel.
 *
 * `today` IS PART OF THE LIVE KEY. Three watchlists are relative to the current
 * IST date, so the cache entry must expire when the date does — otherwise a
 * console left open overnight keeps yesterday's "days left" column, and the
 * notice list keeps somebody whose last day was this morning.
 *
 * Nothing here writes, so there is no invalidation prefix.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { filtersToParams, type AnalyticsFilters } from "@/lib/analyticsFilters";
import { nowIstDate } from "@/lib/datetime";
import {
  contractsOf,
  exitQualityResultOf,
  fetchMovementLists,
  fetchMovementSeries,
  joinersOf,
  liveCountsOf,
  movementScopeFrom,
  noticeOf,
  probationOf,
  reconcileMovement,
  type ContractWatchRow,
  type ExitQualityResult,
  type JoinerListResult,
  type LiveMovementCounts,
  type MovementListsResult,
  type MovementReconciliation,
  type MovementSeriesResult,
  type NoticeWatchRow,
  type ProbationWatchRow,
  type WatchlistResult,
} from "../api/hr-movement.api";

/**
 * The snapshot cannot change until the nightly job runs, so a minute of
 * staleness costs nothing and saves a re-read every time the period is stepped.
 */
const SNAPSHOT_STALE_MS = 60_000;

/**
 * The watchlists are live and are the thing an admin acts on — thirty seconds,
 * so confirming somebody's probation in another tab shows up here promptly
 * without turning the panel into a polling loop.
 */
const LIVE_STALE_MS = 30_000;

// -----------------------------------------------------------------------------
// Keys
// -----------------------------------------------------------------------------

/**
 * Built from `filtersToParams` — the same serialisation the URL uses — so two
 * screens showing the same filtered view share one cache entry, and an entry can
 * be identified from the address bar when a figure looks wrong.
 */
function seriesKey(filters: AnalyticsFilters): readonly unknown[] {
  return qk.admin.list({ movement: "series", ...filtersToParams(filters) });
}

function listsKey(filters: AnalyticsFilters, today: string): readonly unknown[] {
  return qk.admin.list({ movement: "lists", today, ...filtersToParams(filters) });
}

// -----------------------------------------------------------------------------
// The two shared reads
// -----------------------------------------------------------------------------

/**
 * ONE cached snapshot read, projected by `select`.
 *
 * `select` must be referentially stable (a module-level function, or a
 * `useCallback`) or TanStack re-runs the projection on every render.
 */
function useSeries<T>(
  filters: AnalyticsFilters,
  select: (result: MovementSeriesResult) => T,
): UseQueryResult<T, Error> {
  // Pure and master-free (both relations carry the ids), so the scope is built
  // here rather than fetched — see the header of hr-movement.api.ts.
  const scope = useMemo(() => movementScopeFrom(filters), [filters]);
  return useQuery({
    queryKey: seriesKey(filters),
    queryFn: ({ signal }) => fetchMovementSeries(filters, { signal, scope }),
    select,
    staleTime: SNAPSHOT_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/** ONE cached live read of all five watchlists, projected by `select`. */
function useLists<T>(
  filters: AnalyticsFilters,
  select: (result: MovementListsResult) => T,
): UseQueryResult<T, Error> {
  const scope = useMemo(() => movementScopeFrom(filters), [filters]);
  // Read once per render pass and put into the key: see the header on why the
  // IST date has to be part of the cache identity.
  const today = nowIstDate();
  return useQuery({
    queryKey: listsKey(filters, today),
    queryFn: ({ signal }) => fetchMovementLists(filters, today, { signal, scope }),
    select,
    staleTime: LIVE_STALE_MS,
    retry: shouldRetryQuery,
  });
}

const identitySeries = (r: MovementSeriesResult): MovementSeriesResult => r;
const identityLists = (r: MovementListsResult): MovementListsResult => r;

// -----------------------------------------------------------------------------
// Snapshot panels
// -----------------------------------------------------------------------------

/**
 * The whole snapshot answer: the day-by-day series, the attrition rate, the
 * department table, the refresh stamp and the provenance.
 *
 * Returned whole rather than sliced into four hooks because the panel's header
 * needs the stamp, the tiles need the series and the formula card needs the
 * attrition — and every one of them must be describing the same read.
 */
export function useMovementSeries(
  filters: AnalyticsFilters,
): UseQueryResult<MovementSeriesResult, Error> {
  return useSeries(filters, identitySeries);
}

// -----------------------------------------------------------------------------
// Live panels — all six read the ONE cached list result above
// -----------------------------------------------------------------------------

/** Everything the five watchlists were read into, unprojected. */
export function useMovementLists(
  filters: AnalyticsFilters,
): UseQueryResult<MovementListsResult, Error> {
  return useLists(filters, identityLists);
}

/** Confirmations due with nothing recorded — the oldest unmade decision first. */
export function useProbationWatchlist(
  filters: AnalyticsFilters,
): UseQueryResult<WatchlistResult<ProbationWatchRow>, Error> {
  return useLists(filters, probationOf);
}

/** Contracts ending inside the period plus the lookahead. */
export function useContractWatchlist(
  filters: AnalyticsFilters,
): UseQueryResult<WatchlistResult<ContractWatchRow>, Error> {
  return useLists(filters, contractsOf);
}

/** Resignations with a last working day still ahead — soonest leaver first. */
export function useNoticeWatchlist(
  filters: AnalyticsFilters,
): UseQueryResult<WatchlistResult<NoticeWatchRow>, Error> {
  return useLists(filters, noticeOf);
}

/** The period's exits plus the interview / rehire / settlement breakdown. */
export function useExitQuality(
  filters: AnalyticsFilters,
): UseQueryResult<ExitQualityResult, Error> {
  return useLists(filters, exitQualityResultOf);
}

/** The period's joiners — the onboarding side of the same movement. */
export function useJoinerList(filters: AnalyticsFilters): UseQueryResult<JoinerListResult, Error> {
  return useLists(filters, joinersOf);
}

/** The live joiner/exit counts, for the tiles and for the reconciliation below. */
export function useLiveMovementCounts(
  filters: AnalyticsFilters,
): UseQueryResult<LiveMovementCounts, Error> {
  return useLists(filters, liveCountsOf);
}

// -----------------------------------------------------------------------------
// The one derivation that spans both grains
// -----------------------------------------------------------------------------

export interface MovementReconciliationState {
  /** Null until BOTH reads have landed — a half-comparison is worse than none. */
  readonly reconciliation: MovementReconciliation | null;
  readonly isPending: boolean;
}

/**
 * Snapshot movement versus live movement.
 *
 * Deliberately NOT a `select` — it needs both cache entries, and computing it
 * inside either one would make that entry depend on the other's arrival order.
 * Derived in a `useMemo` over the two results instead, and null until both are
 * present so the screen never prints "the snapshot says 0" while the snapshot is
 * still loading.
 */
export function useMovementReconciliation(
  filters: AnalyticsFilters,
): MovementReconciliationState {
  const series = useMovementSeries(filters);
  const live = useLiveMovementCounts(filters);
  const seriesData = series.data;
  const liveData = live.data;

  const reconciliation = useMemo(() => {
    if (seriesData === undefined || liveData === undefined) return null;
    return reconcileMovement(seriesData.series, liveData.joiners, liveData.exits);
  }, [seriesData, liveData]);

  return { reconciliation, isPending: series.isPending || live.isPending };
}
