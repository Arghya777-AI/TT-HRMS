/**
 * useOrgChart.ts — the hooks behind `/admin/org/chart`.
 *
 * Every key lives under `qk.admin.orgList("chart", …)`, i.e. the
 * `["admin","org",…]` prefix, so an org-master write (a transfer, a department
 * rename) invalidates the chart along with the grid that caused it.
 *
 * Two rules the file exists to hold:
 *   1. THE TILES AND THE TREE SHARE ONE PREDICATE. Each count hook passes the
 *      same `ChartScope` object as the node list, and `chartNodeFilters` turns it
 *      into the same `Filter[]` for both — so "13 people in scope" and the tree
 *      below it cannot drift.
 *   2. NOTHING IS COUNTED IN THE BROWSER. Spans come back one `count=exact` per
 *      manager; the tree helper only orders rows.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  SPAN_MANAGER_CAP,
  buildChartTree,
  countChartNodes,
  countDirectEdges,
  countDottedLines,
  countIndirectEdges,
  countUnmanaged,
  fetchChartNodes,
  fetchDirectSpans,
  fetchDottedLines,
  fetchHierarchyEdges,
  type ChartNode,
  type ChartScope,
  type ChartTree,
  type TeamEdge,
} from "../api/org-chart.api";

/** Query keys have to be plain data; `ChartScope` is an interface. */
function scopeKey(scope: ChartScope, part: string): Record<string, unknown> {
  return {
    view: "org-chart",
    part,
    department: scope.departmentId ?? null,
    includeExited: scope.includeExited === true,
  };
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** The people the chart draws. */
export function useChartNodes(scope: ChartScope): UseQueryResult<ChartNode[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("chart", scopeKey(scope, "nodes")),
    queryFn: ({ signal }) => fetchChartNodes(scope, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * The closure edges. Unscoped on purpose — `v_team_hierarchy` decides what an
 * admin may see, and the department narrowing happens where the nodes are (an
 * edge whose two ends are not both in scope is dropped by `buildChartTree`).
 */
export function useChartEdges(): UseQueryResult<TeamEdge[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("chart", { view: "org-chart", part: "edges" }),
    queryFn: ({ signal }) => fetchHierarchyEdges(signal),
    retry: shouldRetryQuery,
  });
}

export function useChartHeadcount(scope: ChartScope): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("chart", scopeKey(scope, "headcount")),
    queryFn: ({ signal }) => countChartNodes(scope, signal),
    retry: shouldRetryQuery,
  });
}

/** People with no manager — the orphan health flag, counted by Postgres. */
export function useUnmanagedCount(scope: ChartScope): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("chart", scopeKey(scope, "unmanaged")),
    queryFn: ({ signal }) => countUnmanaged(scope, signal),
    retry: shouldRetryQuery,
  });
}

export function useDirectEdgeCount(): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("chart", { view: "org-chart", part: "direct-edges" }),
    queryFn: ({ signal }) => countDirectEdges(signal),
    retry: shouldRetryQuery,
  });
}

export function useIndirectEdgeCount(): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("chart", { view: "org-chart", part: "indirect-edges" }),
    queryFn: ({ signal }) => countIndirectEdges(signal),
    retry: shouldRetryQuery,
  });
}

export function useDottedLineCount(scope: ChartScope): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("chart", scopeKey(scope, "dotted-count")),
    queryFn: ({ signal }) => countDottedLines(scope, signal),
    retry: shouldRetryQuery,
  });
}

/** The dotted-line register itself — the rows behind the count above. */
export function useDottedLineRegister(scope: ChartScope): UseQueryResult<ChartNode[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("chart", scopeKey(scope, "dotted-rows")),
    queryFn: ({ signal }) => fetchDottedLines(scope, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Span of control per manager: one server count each.
 *
 * `enabled` is honesty, not optimisation — with more managers than
 * `SPAN_MANAGER_CAP` the query is not run and the screen says spans are
 * unavailable for a tree this size, instead of firing hundreds of requests or
 * counting loaded edges (which the cap could have truncated).
 */
export function useDirectSpans(
  managerIds: readonly string[],
): UseQueryResult<ReadonlyMap<string, number>, Error> {
  const ids = useMemo(() => [...managerIds].sort(), [managerIds]);
  return useQuery({
    queryKey: qk.admin.orgList("chart", { view: "org-chart", part: "spans", managers: ids }),
    enabled: ids.length > 0 && ids.length <= SPAN_MANAGER_CAP,
    queryFn: ({ signal }) => fetchDirectSpans(ids, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Shaping
// -----------------------------------------------------------------------------

/**
 * Nodes × edges → the forest the page renders. Pure and memoised: the same two
 * server row sets always produce the same tree, and no figure is derived.
 */
export function useChartTree(
  nodes: readonly ChartNode[] | undefined,
  edges: readonly TeamEdge[] | undefined,
  focusId: string | null,
): ChartTree {
  return useMemo(
    () => buildChartTree(nodes ?? [], edges ?? [], focusId),
    [nodes, edges, focusId],
  );
}
