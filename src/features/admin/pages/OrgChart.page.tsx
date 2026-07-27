/**
 * §3 · /admin/org/chart — Org Chart. Who reports to whom, read from the reporting
 * closure the database maintains, with the health flags that make a bad shape
 * visible.
 *
 * THE TREE IS THE MATVIEW'S, NOT THIS SCREEN'S. Every parent/child line comes
 * from `v_team_hierarchy` (over `analytics.mv_team_hierarchy`) and every `Level n`
 * badge is that view's own `depth` column. The client orders siblings by name and
 * nothing else — it never counts levels, and it never re-derives the closure from
 * `employees.reporting_manager_id`, because two sources for one tree is how a
 * chart starts disagreeing with the approval routing that actually uses the
 * closure.
 *
 * SO THE REFRESH TIMESTAMP IS PART OF THE ANSWER (§9.4). `refreshed_at` is
 * constant per refresh and is printed at the top. If the
 * `team_hierarchy_refresh` job has not run since a transfer, this screen is
 * behind — and when the closure comes back EMPTY while people exist, the screen
 * says so in as many words instead of drawing thirteen roots and calling it an
 * organisation.
 *
 * SPANS ARE COUNTED BY POSTGRES. One `count=exact` per manager over
 * `(manager_employee_id = X AND is_direct)` — never `children.length`, which
 * would silently follow the edge read's row cap (DR-29).
 *
 * WHAT THIS SCREEN DOES NOT DO, and where the work actually happens:
 *   * NO DRAG-TO-REPARENT. Moving a reporting line is a `manager_changed`
 *     movement: effective date, reason, approval, and a row in
 *     `employee_lifecycle_events`. That is `/admin/people/transfers`, linked in
 *     the header. A drag gesture that quietly wrote `reporting_manager_id` would
 *     be an unapproved reorganisation with no effective date.
 *   * NO DATE SCRUBBER. `public.employee_movements` does not exist on this
 *     backend; the deployed history is the lifecycle event stream, which is a log
 *     of changes rather than a snapshot per date. The count of recorded
 *     manager changes is shown, and it drills to the register that owns them.
 *   * NO VACANCY GHOSTS. No `positions` / `vacancies` / `requisitions` table
 *     exists, so an empty box would be an invention.
 *
 * @route /admin/org/chart
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, type SelectOption } from "../components/Field";
import { StatTile } from "../components/StatTile";
import { EMPLOYMENT_STATUS_LABELS } from "../api/employees.api";
import {
  CHART_EDGE_CAP,
  CHART_NODE_CAP,
  DEEP_CHAIN_THRESHOLD,
  SPAN_MANAGER_CAP,
  WIDE_SPAN_THRESHOLD,
  type ChartNode,
  type ChartScope,
  type ChartTreeNode,
} from "../api/org-chart.api";
import {
  useChartEdges,
  useChartHeadcount,
  useChartNodes,
  useChartTree,
  useDirectEdgeCount,
  useDirectSpans,
  useDottedLineCount,
  useDottedLineRegister,
  useIndirectEdgeCount,
  useUnmanagedCount,
} from "../hooks/useOrgChart";
import { useLifecycleEventCount } from "../hooks/usePeopleLifecycle";
import { useRefOptions } from "../hooks/useMasters";

/** `public.employment_status`, spelled with the one catalogue every screen uses. */
const STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pre_joining: { label: EMPLOYMENT_STATUS_LABELS.pre_joining, tone: "info" },
  active: { label: EMPLOYMENT_STATUS_LABELS.active, tone: "success" },
  confirmed: { label: EMPLOYMENT_STATUS_LABELS.confirmed, tone: "success" },
  on_probation: { label: EMPLOYMENT_STATUS_LABELS.on_probation, tone: "warn" },
  on_notice: { label: EMPLOYMENT_STATUS_LABELS.on_notice, tone: "warn" },
  suspended: { label: EMPLOYMENT_STATUS_LABELS.suspended, tone: "danger" },
  on_long_leave: { label: EMPLOYMENT_STATUS_LABELS.on_long_leave, tone: "info" },
  absconding: { label: EMPLOYMENT_STATUS_LABELS.absconding, tone: "danger" },
  exited: { label: EMPLOYMENT_STATUS_LABELS.exited, tone: "neutral" },
  retired: { label: EMPLOYMENT_STATUS_LABELS.retired, tone: "neutral" },
  rehired: { label: EMPLOYMENT_STATUS_LABELS.rehired, tone: "success" },
};

/** Designation · department, both optional, joined for the node's second line. */
function nodeSecondary(node: ChartNode): string | null {
  const parts = [node.designation_name, node.department_name].filter(
    (part): part is string => part !== null && part.trim() !== "",
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

export default function OrgChartPage() {
  const [params, setParams] = useSearchParams();

  const departmentId = params.get("dept") ?? "";
  const focusParam = params.get("focus") ?? "";
  const includeExited = params.get("exited") === "1";

  const setParam = (key: string, value: string, alsoClear: readonly string[] = []): void => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    for (const other of alsoClear) next.delete(other);
    setParams(next, { replace: true });
  };

  const scope: ChartScope = useMemo(
    () => ({
      ...(departmentId !== "" ? { departmentId } : {}),
      ...(includeExited ? { includeExited: true } : {}),
    }),
    [departmentId, includeExited],
  );

  const departments = useRefOptions("departments");
  const nodes = useChartNodes(scope);
  const edges = useChartEdges();

  const tree = useChartTree(nodes.data, edges.data, focusParam === "" ? null : focusParam);
  const spans = useDirectSpans(tree.managerIds);

  const headcount = useChartHeadcount(scope);
  const unmanaged = useUnmanagedCount(scope);
  const directLines = useDirectEdgeCount();
  const indirectLines = useIndirectEdgeCount();
  const dottedCount = useDottedLineCount(scope);
  const dottedRows = useDottedLineRegister(scope);
  const managerChanges = useLifecycleEventCount({ eventTypes: ["manager_changed"] });

  // Collapse state holds the ids the admin has CLOSED, so a freshly loaded tree
  // is fully open — on a venue this size the whole shape should be visible at once.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set<string>());

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const spanMap = spans.data ?? null;
  const spansUnavailable = tree.managerIds.length > SPAN_MANAGER_CAP;

  const focusOptions: SelectOption[] = useMemo(() => {
    const byId = new Map<string, ChartNode>();
    for (const node of nodes.data ?? []) byId.set(node.id, node);
    return tree.managerIds
      .map((id) => byId.get(id))
      .filter((node): node is ChartNode => node !== undefined)
      .map((node) => ({ value: node.id, label: `${node.display_name} · ${node.employee_code}` }))
      .sort((a, b) => a.label.localeCompare(b.label, "en-IN"));
  }, [nodes.data, tree.managerIds]);

  const departmentOptions: SelectOption[] = useMemo(
    () => (departments.data ?? []).map((row) => ({ value: row.id, label: row.name })),
    [departments.data],
  );

  const nodeCapHit = (nodes.data ?? []).length >= CHART_NODE_CAP;
  const edgeCapHit = (edges.data ?? []).length >= CHART_EDGE_CAP;
  const closureEmpty =
    edges.isSuccess && (edges.data ?? []).length === 0 && (nodes.data ?? []).length > 1;

  const dottedColumns: DataGridColumn<ChartNode>[] = [
    {
      key: "display_name",
      header: t("admin.org.chart.col.person"),
      sortable: true,
      sortValue: (row) => row.display_name,
      render: (row) => (
        <PersonCell name={row.display_name} code={row.employee_code} secondary={nodeSecondary(row)} />
      ),
    },
    {
      key: "reporting_manager_name",
      header: t("admin.org.chart.col.solidLine"),
      hideBelow: "md",
      render: (row) =>
        row.reporting_manager_name === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.org.chart.noManager")}</span>
        ) : (
          <span className="normal-case">{row.reporting_manager_name}</span>
        ),
    },
    {
      key: "dotted_line_manager_name",
      header: t("admin.org.chart.col.dottedLine"),
      render: (row) => (
        <span className="normal-case">{dash(row.dotted_line_manager_name)}</span>
      ),
    },
    {
      key: "employment_status",
      header: t("admin.org.chart.col.status"),
      width: "10rem",
      hideBelow: "md",
      render: (row) => <StatusChip status={row.employment_status} map={STATUS_CHIP} />,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Users}
        title={t("admin.org.chart.title")}
        subtitle={t("admin.org.chart.subtitle")}
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/people/transfers">{t("admin.org.chart.openTransfers")}</Link>
          </Button>
        }
      />

      <p className="mb-4 text-sm text-muted-foreground">
        {tree.refreshedAt === null
          ? t("admin.org.chart.asOfUnknown")
          : t("admin.org.chart.asOf", { at: fmtDateTime(tree.refreshedAt) })}
      </p>

      {/* ── The shape, in numbers Postgres counted ─────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label={t("admin.org.chart.tile.people")}
          hint={t("admin.org.chart.tile.peopleHint")}
          source={t("admin.org.chart.source.people")}
          query={headcount}
        />
        <StatTile
          label={t("admin.org.chart.tile.solid")}
          hint={t("admin.org.chart.tile.solidHint")}
          source={t("admin.org.chart.source.solid")}
          query={directLines}
        />
        <StatTile
          label={t("admin.org.chart.tile.indirect")}
          hint={t("admin.org.chart.tile.indirectHint")}
          source={t("admin.org.chart.source.indirect")}
          query={indirectLines}
        />
        <StatTile
          label={t("admin.org.chart.tile.unmanaged")}
          hint={t("admin.org.chart.tile.unmanagedHint")}
          source={t("admin.org.chart.source.unmanaged")}
          query={unmanaged}
          toneFor={(count) => (count > 1 ? "warn" : "neutral")}
        />
        <StatTile
          label={t("admin.org.chart.tile.dotted")}
          hint={t("admin.org.chart.tile.dottedHint")}
          source={t("admin.org.chart.source.dotted")}
          query={dottedCount}
        />
        <StatTile
          label={t("admin.org.chart.tile.moves")}
          hint={t("admin.org.chart.tile.movesHint")}
          source={t("admin.org.chart.source.moves")}
          query={managerChanges}
        />
      </div>

      {closureEmpty ? (
        <Notice tone="warning" className="mt-4">
          {t("admin.org.chart.closureEmpty")}
        </Notice>
      ) : null}

      {nodeCapHit || edgeCapHit ? (
        <Notice tone="warning" className="mt-4">
          {t("admin.common.rowCap", { count: nodeCapHit ? CHART_NODE_CAP : CHART_EDGE_CAP })}
        </Notice>
      ) : null}

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <section className="mt-4 rounded-lg border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField
            label={t("admin.org.chart.filter.department")}
            value={departmentId}
            placeholder={t("admin.org.chart.filter.allDepartments")}
            options={departmentOptions}
            disabled={departments.isLoading}
            onChange={(value) => setParam("dept", value, ["focus"])}
            hint={t("admin.org.chart.filter.departmentHint")}
          />
          <SelectField
            label={t("admin.org.chart.filter.focus")}
            value={focusParam}
            placeholder={t("admin.org.chart.filter.wholeCompany")}
            options={focusOptions}
            disabled={focusOptions.length === 0}
            onChange={(value) => setParam("focus", value)}
            hint={t("admin.org.chart.filter.focusHint")}
          />
          <label className="flex items-start gap-2 self-end text-sm">
            <input
              type="checkbox"
              checked={includeExited}
              onChange={(event) => setParam("exited", event.target.checked ? "1" : "")}
              className="mt-0.5 h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <span>
              <span className="font-medium">{t("admin.org.chart.filter.exited")}</span>
              <span className="block text-xs text-muted-foreground">
                {t("admin.org.chart.filter.exitedHint")}
              </span>
            </span>
          </label>
          <div className="flex items-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCollapsed(new Set<string>(tree.managerIds))}
            >
              {t("admin.org.chart.collapseAll")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCollapsed(new Set<string>())}>
              {t("admin.org.chart.expandAll")}
            </Button>
          </div>
        </div>
      </section>

      {/* ── The tree ───────────────────────────────────────────────────────── */}
      <section className="mt-4">
        <h2 className="font-display text-base font-semibold">{t("admin.org.chart.tree.title")}</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          {spansUnavailable
            ? t("admin.org.chart.tree.spansUnavailable", { cap: formatNumber(SPAN_MANAGER_CAP) })
            : t("admin.org.chart.tree.hint", {
                span: formatNumber(WIDE_SPAN_THRESHOLD),
                depth: formatNumber(DEEP_CHAIN_THRESHOLD),
              })}
        </p>

        <StateBoundary
          loading={nodes.isPending || edges.isPending}
          error={nodes.error ?? edges.error ?? undefined}
          onRetry={() => {
            void nodes.refetch();
            void edges.refetch();
          }}
          partialError={spans.error ?? undefined}
          partialLabel={t("admin.org.chart.partial.spans")}
          isEmpty={tree.forest.length === 0}
          empty={
            <EmptyState
              icon={Users}
              title={t("admin.org.chart.empty.title")}
              hint={t("admin.org.chart.empty.hint")}
            />
          }
          skeletonRows={6}
        >
          <ul className="space-y-1 rounded-lg border bg-card p-3">
            {tree.forest.map((node) => (
              <ChartBranch
                key={node.employee.id}
                node={node}
                collapsed={collapsed}
                onToggle={toggle}
                spans={spanMap}
              />
            ))}
          </ul>
        </StateBoundary>

        {tree.unplaced.length > 0 ? (
          <Notice tone="warning" className="mt-3">
            {t("admin.org.chart.unplaced", {
              count: formatNumber(tree.unplaced.length),
              names: tree.unplaced
                .slice(0, 6)
                .map((node) => node.display_name)
                .join(", "),
            })}
          </Notice>
        ) : null}
      </section>

      {/* ── Dotted lines ───────────────────────────────────────────────────── */}
      <section className="mt-6">
        <h2 className="font-display text-base font-semibold">{t("admin.org.chart.dotted.title")}</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          {t("admin.org.chart.dotted.hint")}
        </p>
        <StateBoundary
          loading={dottedRows.isPending}
          error={dottedRows.error}
          onRetry={() => void dottedRows.refetch()}
          skeletonRows={3}
        >
          <DataGrid
            columns={dottedColumns}
            rows={dottedRows.data ?? []}
            rowKey={(row) => row.id}
            pageSize={10}
            emptyState={
              <EmptyState
                icon={Users}
                title={t("admin.org.chart.dotted.empty.title")}
                hint={t("admin.org.chart.dotted.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </section>

      <div className="mt-6 space-y-2">
        <Notice tone="info">{t("admin.org.chart.footnote.reparent")}</Notice>
        <Notice tone="info">{t("admin.org.chart.footnote.scrubber")}</Notice>
      </div>
    </div>
  );
}

interface ChartBranchProps {
  node: ChartTreeNode;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Server span counts, or null when they could not be read for this tree. */
  spans: ReadonlyMap<string, number> | null;
}

/**
 * One person and their subtree.
 *
 * Recursive rather than a flattened list with padding, so the nesting is real for
 * assistive technology too: each level is its own `<ul>` inside the parent's
 * `<li>`, and the toggle carries `aria-expanded`.
 */
function ChartBranch({ node, collapsed, onToggle, spans }: ChartBranchProps) {
  const employee = node.employee;
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(employee.id);
  const span = spans?.get(employee.id);
  const wideSpan = span !== undefined && span > WIDE_SPAN_THRESHOLD;
  const deep = node.depth !== null && node.depth > DEEP_CHAIN_THRESHOLD;

  return (
    <li>
      <div className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(employee.id)}
            aria-expanded={!isCollapsed}
            aria-label={
              isCollapsed
                ? t("admin.org.chart.expandOne", { name: employee.display_name })
                : t("admin.org.chart.collapseOne", { name: employee.display_name })
            }
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isCollapsed ? (
              <ChevronRight className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronDown className="h-4 w-4" aria-hidden />
            )}
          </button>
        ) : (
          <span className="h-6 w-6 shrink-0" aria-hidden />
        )}

        <span className="min-w-0 flex-1">
          <PersonCell
            name={employee.display_name}
            code={employee.employee_code}
            secondary={nodeSecondary(employee)}
          />
        </span>

        <StatusChip status={employee.employment_status} map={STATUS_CHIP} />

        {span !== undefined ? (
          <Badge variant={wideSpan ? "danger" : "neutral"}>
            {t("admin.org.chart.span", { n: formatNumber(span) })}
          </Badge>
        ) : null}

        {node.depth !== null && node.depth > 0 ? (
          <Badge variant={deep ? "warning" : "outline"}>
            {t("admin.org.chart.level", { n: formatNumber(node.depth) })}
          </Badge>
        ) : null}

        {employee.reporting_manager_id === null ? (
          <Badge variant="info">{t("admin.org.chart.rootBadge")}</Badge>
        ) : null}

        {employee.dotted_line_manager_name !== null ? (
          <span className="text-xs text-muted-foreground">
            {t("admin.org.chart.dottedTo", { name: employee.dotted_line_manager_name })}
          </span>
        ) : null}

        <Button asChild variant="ghost" size="sm">
          <Link to={`/admin/people/${employee.employee_code}`}>
            {t("admin.org.chart.openRecord")}
            <ExternalLink className="ml-1 h-3 w-3" aria-hidden />
          </Link>
        </Button>
      </div>

      {hasChildren && !isCollapsed ? (
        <ul className="ml-5 space-y-1 border-l pl-3">
          {node.children.map((child) => (
            <ChartBranch
              key={child.employee.id}
              node={child}
              collapsed={collapsed}
              onToggle={onToggle}
              spans={spans}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
