/**
 * org-chart.api.ts — the reads behind §3 `/admin/org/chart` (Org Chart), and the
 * pure shaping that turns a set of closure EDGES into a tree.
 *
 * WHERE THE TREE COMES FROM. `analytics.mv_team_hierarchy` (migration 036) is the
 * recursive reporting closure — one row per (manager, descendant) pair, carrying
 * the server's own `depth`, `is_direct` and, because it is a matview, a
 * `refreshed_at` that is CONSTANT per refresh. Clients never touch the matview
 * (it has zero grants and no RLS); they read `public.v_team_hierarchy`, whose own
 * predicate is `manager = me OR employee = me OR app.is_admin()`. An admin
 * therefore sees every edge, and this module adds no scope predicate of its own
 * because there is none to add — RLS is the boundary.
 *
 * WHY `refreshed_at` IS PRINTED, ALWAYS. §9.4: a matview-backed screen must say
 * as of when. The closure is rebuilt by the `team_hierarchy_refresh` cron and on
 * manager change; if that job has not run since a transfer, this screen is
 * stale — and the honest fix is to show the timestamp, not to silently redraw a
 * tree from `employees.reporting_manager_id` and hope the two agree.
 *
 * WHAT IS A SERVER NUMBER HERE, AND WHAT IS NOT:
 *   * Every headline figure is a `count=exact` over the SAME predicate array the
 *     list uses (`selectCount`), so a tile cannot disagree with its own tree.
 *   * A manager's SPAN is one `count=exact` per manager over
 *     `v_team_hierarchy (manager_employee_id = X AND is_direct)`. It is never
 *     `children.length`: the edge read is capped, and counting loaded rows would
 *     make the badge depend on the cap (spec-screens DR-29, the `7 vs 8` defect).
 *   * `depth` is the matview's column, read back unchanged. Nothing here adds 1
 *     to anything.
 * The tree building below is PRESENTATION — it groups server rows into
 * parent/child order exactly as `useRosterGrid` pivots slots, and derives no
 * quantity.
 *
 * WHAT THIS SCREEN DELIBERATELY CANNOT DO, verified against the migrations:
 *   1. DRAG-TO-REPARENT. Re-pointing `employees.reporting_manager_id` is a
 *      `manager_changed` MOVEMENT: it wants an effective date, a reason, an
 *      approval chain and a `employee_lifecycle_events` row. That pipeline is
 *      `/admin/people/transfers`, and duplicating a governed write behind a drag
 *      gesture is how an unapproved reorganisation happens. This module exports
 *      NO write function.
 *   2. A DATE SCRUBBER. Reconstructing the tree "as at 1 April" needs a dated
 *      history of the manager column. `public.employee_movements` does not exist
 *      on this backend; the closest deployed fact is
 *      `employee_lifecycle_events (event_type = 'manager_changed')` with
 *      `from_values`/`to_values` — which is a LOG of changes, not a snapshot per
 *      date. So the screen shows the log (through the existing lifecycle reads,
 *      not a second copy of them) and says the tree is as of now.
 *   3. VACANCY GHOST NODES. Nothing in the schema models an open position:
 *      `positions`, `vacancies` and `requisitions` appear in no migration. A
 *      ghost node would be an invention, so there is none.
 */
import { z } from "zod";
import {
  dbUuid,
  dbUuidNullable,
  eq,
  inList,
  isFalse,
  isNotNull,
  isNull,
  isTrue,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { V_TEAM_HIERARCHY, teamEdgeSchema, type TeamEdge } from "@/features/team/api/team.api";
import {
  ACTIVE_EMPLOYMENT_STATUSES,
  V_ADMIN_EMPLOYEE,
  employmentStatusSchema,
} from "./employees.api";

export { V_TEAM_HIERARCHY };
export type { TeamEdge };

/**
 * Row caps. The closure is one row per ancestor-descendant pair, so it grows
 * faster than headcount (13 people ≈ 20 edges; 500 people ≈ a few thousand).
 * Both caps are surfaced on screen when they bite — a silently truncated tree is
 * a wrong tree.
 */
export const CHART_NODE_CAP = 500;
export const CHART_EDGE_CAP = 3000;

/**
 * How many managers may get a per-manager span COUNT in one pass. Each span is
 * its own `count=exact`, and 50 parallel HEAD requests is already generous for a
 * venue; beyond that the screen states that spans are unavailable rather than
 * firing hundreds of requests or falling back to counting loaded rows.
 */
export const SPAN_MANAGER_CAP = 50;

/** spec-admin §3 org-chart health flags: span > 12, depth > 6, orphans. */
export const WIDE_SPAN_THRESHOLD = 12;
export const DEEP_CHAIN_THRESHOLD = 6;

// -----------------------------------------------------------------------------
// 1. Nodes — `v_admin_employee`, narrowed to what a chart node renders
// -----------------------------------------------------------------------------

/**
 * `v_admin_employee` is 100+ columns wide (it is `employees.*` plus resolved
 * lookups plus masked statutory/bank identifiers). A chart node needs eleven of
 * them, and asking for `*` here would pull masked PAN and bank columns onto a
 * screen that has no business holding them.
 */
export const CHART_NODE_COLUMNS = [
  "id",
  "employee_code",
  "display_name",
  "department_name",
  "designation_name",
  "employment_status",
  "reporting_manager_id",
  "reporting_manager_name",
  "dotted_line_manager_id",
  "dotted_line_manager_name",
  "deleted_at",
].join(",");

export const chartNodeSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  department_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  employment_status: employmentStatusSchema,
  reporting_manager_id: dbUuidNullable,
  reporting_manager_name: z.string().nullable(),
  /** Visibility only — a dotted line carries NO approval authority (spec §2.1). */
  dotted_line_manager_id: dbUuidNullable,
  dotted_line_manager_name: z.string().nullable(),
});
export type ChartNode = z.infer<typeof chartNodeSchema>;

export interface ChartScope {
  /** One department, when the admin narrows the chart. */
  readonly departmentId?: string;
  /**
   * Include people who have left. Default false: an exited employee still holds
   * a manager pointer, and drawing them keeps a line alive that no longer is.
   */
  readonly includeExited?: boolean;
}

/**
 * The one predicate builder, so the tiles and the tree read the same row set.
 *
 * `v_admin_employee` deliberately shows soft-deleted rows to admins (the Archive
 * console needs them, migration 051 §1), so `deleted_at IS NULL` is explicit.
 */
export function chartNodeFilters(scope: ChartScope): Filter[] {
  const filters: Filter[] = [isNull("deleted_at")];
  if (scope.includeExited !== true) {
    filters.push(inList("employment_status", ACTIVE_EMPLOYMENT_STATUSES));
  }
  if (scope.departmentId !== undefined && scope.departmentId !== "") {
    filters.push(eq("department_id", scope.departmentId));
  }
  return filters;
}

export function fetchChartNodes(scope: ChartScope, signal?: AbortSignal): Promise<ChartNode[]> {
  return selectMany(V_ADMIN_EMPLOYEE, chartNodeSchema, {
    filters: chartNodeFilters(scope),
    columns: CHART_NODE_COLUMNS,
    order: [{ column: "display_name", ascending: true }],
    limit: CHART_NODE_CAP,
    ...(signal ? { signal } : {}),
  });
}

/** Headcount the chart covers — Postgres's count over the tree's own predicate. */
export function countChartNodes(scope: ChartScope, signal?: AbortSignal): Promise<number> {
  return selectCount(V_ADMIN_EMPLOYEE, chartNodeFilters(scope), { ...(signal ? { signal } : {}) });
}

/**
 * People with no reporting manager. On a venue chart this is normally exactly one
 * (the owner); anything more is either a genuine second root or a record that was
 * never given a line — which is why it is a health flag, not a silent fact.
 */
export function countUnmanaged(scope: ChartScope, signal?: AbortSignal): Promise<number> {
  return selectCount(
    V_ADMIN_EMPLOYEE,
    [...chartNodeFilters(scope), isNull("reporting_manager_id")],
    { ...(signal ? { signal } : {}) },
  );
}

/** People who also report, informally, to somebody else. */
export function countDottedLines(scope: ChartScope, signal?: AbortSignal): Promise<number> {
  return selectCount(
    V_ADMIN_EMPLOYEE,
    [...chartNodeFilters(scope), isNotNull("dotted_line_manager_id")],
    { ...(signal ? { signal } : {}) },
  );
}

/** The dotted-line register: every employee who has one, with both names. */
export function fetchDottedLines(scope: ChartScope, signal?: AbortSignal): Promise<ChartNode[]> {
  return selectMany(V_ADMIN_EMPLOYEE, chartNodeSchema, {
    filters: [...chartNodeFilters(scope), isNotNull("dotted_line_manager_id")],
    columns: CHART_NODE_COLUMNS,
    order: [{ column: "display_name", ascending: true }],
    limit: CHART_NODE_CAP,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Edges — `v_team_hierarchy` (the matview wrapper)
// -----------------------------------------------------------------------------

const EDGE_COLUMNS = "manager_employee_id, employee_id, depth, is_direct, refreshed_at";

/**
 * Every closure edge this admin can see, shallowest first.
 *
 * No `manager_employee_id` filter: on the manager surface that predicate is a
 * CORRECTNESS filter selecting one person's downward half, but the admin chart is
 * the whole tree, and the view's `app.is_admin()` branch already decides which
 * rows exist.
 */
export function fetchHierarchyEdges(signal?: AbortSignal): Promise<TeamEdge[]> {
  return selectMany(V_TEAM_HIERARCHY, teamEdgeSchema, {
    columns: EDGE_COLUMNS,
    order: [
      { column: "depth", ascending: true },
      { column: "employee_id", ascending: true },
    ],
    limit: CHART_EDGE_CAP,
    ...(signal ? { signal } : {}),
  });
}

/** Solid reporting lines (`is_direct`) — one per person who has a manager. */
export function countDirectEdges(signal?: AbortSignal): Promise<number> {
  return selectCount(V_TEAM_HIERARCHY, [isTrue("is_direct")], { ...(signal ? { signal } : {}) });
}

/** Indirect pairs — how much of the tree sits below somebody else's reportee. */
export function countIndirectEdges(signal?: AbortSignal): Promise<number> {
  return selectCount(V_TEAM_HIERARCHY, [isFalse("is_direct")], { ...(signal ? { signal } : {}) });
}

/**
 * One `count=exact` per manager: their number of DIRECT reportees.
 *
 * Deliberately N requests rather than one read divided N ways — the same shape
 * Event Coverage uses for its seven per-date counts. `managerIds` is expected to
 * be the distinct managers of the loaded direct edges; longer than
 * `SPAN_MANAGER_CAP` and this refuses rather than flooding PostgREST, so the
 * screen can say spans are unavailable instead of showing wrong ones.
 */
export async function fetchDirectSpans(
  managerIds: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, number>> {
  if (managerIds.length === 0) return new Map<string, number>();
  if (managerIds.length > SPAN_MANAGER_CAP) {
    throw new Error(
      `fetchDirectSpans refuses ${managerIds.length} managers: the cap is ${SPAN_MANAGER_CAP} per pass.`,
    );
  }
  const counts = await Promise.all(
    managerIds.map((id) =>
      selectCount(V_TEAM_HIERARCHY, [eq("manager_employee_id", id), isTrue("is_direct")], {
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  const out = new Map<string, number>();
  managerIds.forEach((id, index) => {
    const count = counts[index];
    if (count !== undefined) out.set(id, count);
  });
  return out;
}

// -----------------------------------------------------------------------------
// 3. Pure shaping: edges + nodes → a tree
// -----------------------------------------------------------------------------

export interface ChartTreeNode {
  readonly employee: ChartNode;
  /**
   * The matview's own `depth` below this branch's root (the root itself is 0).
   * `null` when the closure did not carry the pair — which happens only if the
   * edge read hit its cap, and is rendered as "—" rather than guessed.
   */
  readonly depth: number | null;
  readonly children: readonly ChartTreeNode[];
}

export interface ChartTree {
  readonly forest: readonly ChartTreeNode[];
  /** Managers with at least one direct reportee — the span-count candidates. */
  readonly managerIds: readonly string[];
  /**
   * Loaded employees the forest could not place: their manager is outside the
   * scope (a different department, or an exited manager). Named, never dropped.
   */
  readonly unplaced: readonly ChartNode[];
  /** Constant per matview refresh; null when no edge was returned at all. */
  readonly refreshedAt: string | null;
}

/**
 * Group edges into `manager → direct reportees`, keeping only pairs whose BOTH
 * ends are in the loaded node set (a manager filtered out by the department
 * scope must not resurrect their reportee under a phantom parent).
 */
function directChildren(
  edges: readonly TeamEdge[],
  byId: ReadonlyMap<string, ChartNode>,
): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.is_direct) continue;
    const managerId = edge.manager_employee_id;
    if (managerId === null) continue;
    if (!byId.has(managerId) || !byId.has(edge.employee_id)) continue;
    const list = children.get(managerId);
    if (list === undefined) children.set(managerId, [edge.employee_id]);
    else list.push(edge.employee_id);
  }
  return children;
}

/**
 * `employee_id → depth`, taken from the edges whose manager is one of `rootIds`.
 * The value is the matview's column, unchanged: the client never counts levels.
 */
function depthsBelowRoots(
  edges: readonly TeamEdge[],
  rootIds: readonly string[],
): Map<string, number> {
  const roots = new Set(rootIds);
  const depths = new Map<string, number>();
  for (const edge of edges) {
    const managerId = edge.manager_employee_id;
    if (managerId === null || !roots.has(managerId)) continue;
    const existing = depths.get(edge.employee_id);
    // A person can sit under two roots only in a broken tree; keep the shallower
    // reading rather than the last one to arrive.
    if (existing === undefined || edge.depth < existing) depths.set(edge.employee_id, edge.depth);
  }
  return depths;
}

/**
 * Build the forest.
 *
 * `focusId === null` renders every root (an employee whose `reporting_manager_id`
 * is null, or whose manager is not in scope). A focus renders that one person's
 * subtree, which is what an admin wants when the venue tree is 500 people.
 *
 * The `seen` set is a cycle guard. `trg_employees__manager_cycle` refuses a cycle
 * at write time and the matview caps recursion at 8, so this should be
 * unreachable — but an infinite render is not the way to find out.
 */
export function buildChartTree(
  nodes: readonly ChartNode[],
  edges: readonly TeamEdge[],
  focusId: string | null,
): ChartTree {
  const byId = new Map<string, ChartNode>();
  for (const node of nodes) byId.set(node.id, node);

  const children = directChildren(edges, byId);

  const rootIds: string[] = [];
  if (focusId !== null && byId.has(focusId)) {
    rootIds.push(focusId);
  } else {
    for (const node of nodes) {
      const managerId = node.reporting_manager_id;
      if (managerId === null || !byId.has(managerId)) rootIds.push(node.id);
    }
  }

  const depths = depthsBelowRoots(edges, rootIds);
  const seen = new Set<string>();

  function build(id: string, isRoot: boolean): ChartTreeNode | null {
    const employee = byId.get(id);
    if (employee === undefined || seen.has(id)) return null;
    seen.add(id);
    const kids = (children.get(id) ?? [])
      .map((childId) => build(childId, false))
      .filter((child): child is ChartTreeNode => child !== null)
      // Presentation order only: siblings by name, as every other list here.
      .sort((a, b) => a.employee.display_name.localeCompare(b.employee.display_name, "en-IN"));
    return {
      employee,
      depth: isRoot ? 0 : (depths.get(id) ?? null),
      children: kids,
    };
  }

  const forest = rootIds
    .map((id) => build(id, true))
    .filter((node): node is ChartTreeNode => node !== null)
    .sort((a, b) => a.employee.display_name.localeCompare(b.employee.display_name, "en-IN"));

  const unplaced = nodes.filter((node) => !seen.has(node.id));
  const managerIds = [...children.keys()].sort();
  const refreshedAt = edges[0]?.refreshed_at ?? null;

  return { forest, managerIds, unplaced, refreshedAt };
}

/** Flatten the forest in render order, so one grid can list a whole subtree. */
export function flattenChartTree(forest: readonly ChartTreeNode[]): ChartTreeNode[] {
  const out: ChartTreeNode[] = [];
  const walk = (node: ChartTreeNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const node of forest) walk(node);
  return out;
}
