/**
 * useHrWorkforce.ts — TanStack hooks for the Workforce & Org panel. One
 * `AnalyticsFilters` in, every measure on the panel out.
 *
 * ONE FETCH, MANY PANELS — the same discipline `useAnalytics.ts` established.
 * Every roster-derived hook calls `useQuery` with the IDENTICAL query key and
 * differs only in its `select`. TanStack dedupes by key, so the employee rows
 * cross the wire ONCE per filter set, are cached once, and each hook receives
 * its own memoised projection. The headline tiles, the five bar charts, the
 * tenure ring, the age ring, the diversity blocks and the span-of-control table
 * are therefore not eight answers gathered a few hundred milliseconds apart —
 * they are eight views of one array of rows, and they cannot disagree.
 *
 * `select` must be referentially stable (module-level, or `useCallback`) or
 * TanStack re-runs the projection on every render.
 *
 * TWO reads have their OWN key on purpose:
 *   * the headcount trend reads `v_headcount_daily`, a different relation at a
 *     different grain (date × department × employment type) with its own row cap
 *     and its own staleness stamp;
 *   * the manager-role grant count reads `public.user_roles`, which has no org
 *     columns at all and therefore does not vary with the filters — so it gets a
 *     filter-free key and is fetched once per session.
 *
 * Nothing here writes, so there is no invalidation prefix. `staleTime` is a
 * minute: a headcount panel is a report, not an operations board.
 */
import { useCallback } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { filtersToParams, type AnalyticsFilters } from "@/lib/analyticsFilters";
import {
  fetchHeadcountTrend,
  fetchManagerRoleCount,
  fetchWorkforceRoster,
  headcountBy,
  onRollAt,
  snapshotOf,
  type HeadcountBucket,
  type HeadcountDimension,
  type HeadcountTrendResult,
  type ManagerRoleCount,
  type WorkforceRosterPage,
  type WorkforceSnapshotResult,
} from "../api/hr-workforce.api";

/** A report refetches on revisit, not on a timer. */
const WORKFORCE_STALE_MS = 60_000;

/** Role grants change a handful of times a year; one read per session is plenty. */
const ROLE_GRANT_STALE_MS = 5 * 60_000;

/**
 * The key EVERY roster hook shares. Built from `filtersToParams` — the same
 * serialisation the URL uses — so two surfaces showing the same filtered view
 * hit one cache entry, and an entry can be identified from the address bar when
 * a number looks wrong.
 *
 * `emp` and `src` ride along in that serialisation even though this panel
 * honours neither. That is deliberate: the fetcher reports them as caveats, so
 * a page with an employee filter set must NOT share a cache entry with one
 * without it, or the caveat line would be inherited by the wrong render.
 */
function rosterKey(filters: AnalyticsFilters): readonly unknown[] {
  return qk.admin.list({ analytics: "hr-workforce", ...filtersToParams(filters) });
}

/** One cached read of the employee rows, projected by `select`. */
function useRoster<T>(
  filters: AnalyticsFilters,
  select: (page: WorkforceRosterPage) => T,
): UseQueryResult<T, Error> {
  return useQuery({
    queryKey: rosterKey(filters),
    queryFn: ({ signal }) => fetchWorkforceRoster(filters, { signal }),
    select,
    staleTime: WORKFORCE_STALE_MS,
    retry: shouldRetryQuery,
  });
}

const identityPage = (page: WorkforceRosterPage): WorkforceRosterPage => page;

/** The raw employee rows behind every measure — for an export or a debug table. */
export function useWorkforceRoster(
  filters: AnalyticsFilters,
): UseQueryResult<WorkforceRosterPage, Error> {
  return useRoster(filters, identityPage);
}

/**
 * Every measure at once: headcount, the five breakdowns, span of control,
 * tenure, age and the suppressed diversity blocks, plus the scope and
 * provenance they were computed under.
 *
 * This is what the panel mounts. The per-dimension hook below exists for a
 * drill screen that wants one chart without paying for the rest of the
 * aggregation — it still shares this hook's cache entry.
 */
export function useWorkforceSnapshot(
  filters: AnalyticsFilters,
): UseQueryResult<WorkforceSnapshotResult, Error> {
  return useRoster(filters, snapshotOf);
}

/**
 * Headcount for ONE dimension, off the same cached rows.
 *
 * The as-at filter is applied inside {@link snapshotOf} for the full snapshot;
 * here it has to be applied explicitly, because `headcountBy` counts whatever
 * rows it is handed and the fetched page still contains people who had already
 * left by the as-at date.
 */
export function useHeadcountByDimension(
  filters: AnalyticsFilters,
  dimension: HeadcountDimension,
): UseQueryResult<readonly HeadcountBucket[], Error> {
  const select = useCallback(
    // `onRollAt` rather than a predicate written here: the headcount definition
    // exists in exactly one place, so this chart and the snapshot's own bars
    // cannot come to differ by a row.
    (page: WorkforceRosterPage) => headcountBy(onRollAt(page.rows, page.scope.asOf.date), dimension),
    [dimension],
  );
  return useRoster(filters, select);
}

/**
 * The headcount line over the period. Its own relation, its own cap, its own
 * staleness stamp — and `applicable: false` when a location filter is set,
 * because `mv_headcount_daily` has no location column and an unfiltered line
 * under a filtered heading is worse than no line.
 */
export function useHeadcountTrend(
  filters: AnalyticsFilters,
): UseQueryResult<HeadcountTrendResult, Error> {
  return useQuery({
    queryKey: qk.admin.list({
      analytics: "hr-workforce-trend",
      from: filters.period.from,
      to: filters.period.to,
      dept: filters.departmentId ?? null,
      loc: filters.locationId ?? null,
    }),
    queryFn: ({ signal }) => fetchHeadcountTrend(filters, { signal }),
    staleTime: WORKFORCE_STALE_MS,
    retry: shouldRetryQuery,
  });
}

/**
 * How many people hold an explicit `manager` role grant — a DIFFERENT
 * population from "people with reportees" (see `fetchManagerRoleCount`), and
 * one that no filter on this panel can narrow, which is why the key carries no
 * filters at all.
 */
export function useManagerRoleCount(): UseQueryResult<ManagerRoleCount, Error> {
  return useQuery({
    queryKey: qk.admin.list({ analytics: "hr-workforce-role-grants" }),
    queryFn: ({ signal }) => fetchManagerRoleCount({ signal }),
    staleTime: ROLE_GRANT_STALE_MS,
    retry: shouldRetryQuery,
  });
}
