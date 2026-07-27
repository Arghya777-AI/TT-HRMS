/**
 * §12 · /admin/workflow/sla — SLA & Escalations. Breaches, reminders and
 * escalation paths.
 *
 * TWO REGISTERS, ONE SCREEN, AND THEY ANSWER DIFFERENT QUESTIONS. Confusing them
 * is the defect this layout exists to prevent:
 *
 *  1. WHAT IS LATE RIGHT NOW — `sla_breaches`, one row per (request, level,
 *     approver), written by `sla_sweep()` when `sla_due_at < now()`. Every figure
 *     on it is the SERVER'S: `hours_overdue` was rounded inside the sweep,
 *     `breached_at`, `escalated_at` and `resolved_at` are stamps, and `resolution`
 *     is one of four values the sweep chose ('acted' / 'escalated' /
 *     'auto_approved' / 'cancelled'). Nothing here compares a timestamp to the
 *     browser's clock. The sweep runs on a 30-minute cron, so the register is at
 *     most half an hour behind — the screen says that in words instead of
 *     implying it is live.
 *  2. WHO DECIDES ON TIME — `v_approval_sla`, a roll-up of DECIDED actions per
 *     approver × request type: `decided`, `on_time`, `breached`, `on_time_pct`
 *     (§9.2: `on_time * 100.0 / NULLIF(decided, 0)`, computed in the view) and
 *     `avg_hours_to_decide`. This is history, not a live queue: a person with a
 *     perfect record can still have three requests overdue on their desk today,
 *     and the two registers are stacked rather than merged so that cannot be
 *     misread.
 *
 * The escalation PATH is configuration, not an event: `approval_chain_levels
 * .escalate_to_kind` decides who a late level goes to, and it is read on
 * /admin/workflow/designer. What lands here is the escalation that HAPPENED —
 * `escalated_to` and `escalated_at` on the breach row, plus the `escalate` entry
 * the sweep appends to the request's trail (visible in the Override Log).
 *
 * The compliance chart plots ONLY the view's own `on_time_pct` series and the
 * table below it is the same numbers — a chart here is a second rendering of
 * server columns, never a computation.
 *
 * @route /admin/workflow/sla
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { AlarmClock, TrendingUp } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtDateTime, fmtDurationFromHours } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { BREACH_OPEN_CHIP, BREACH_RESOLUTION_CHIP, REQUEST_STATUS_CHIP } from "../workflow-vocab";
import {
  isBreachSlice,
  type ApprovalSlaRow,
  type BreachFilters,
  type BreachSlice,
  type SlaBreach,
  type SlaFilters,
} from "../api/workflow-admin.api";
import {
  useApprovalSla,
  useApprovalSlaCount,
  usePeopleByEmployeeId,
  useRequestRefs,
  useRequestTypeMap,
  useRequestTypes,
  useSlaBreachCount,
  useSlaBreaches,
  type PersonRefMap,
  type RequestTypeMap,
} from "../hooks/useWorkflowAdmin";
import type { RequestRef } from "../api/workflow-admin.api";

const TILES: readonly { slice: BreachSlice; label: string; ring: string }[] = [
  { slice: "open", label: t("admin.wf.sla.tile.open"), ring: "border-destructive/50" },
  { slice: "escalated", label: t("admin.wf.sla.tile.escalated"), ring: "border-warning/50" },
  { slice: "resolved", label: t("admin.wf.sla.tile.resolved"), ring: "border-success/50" },
  { slice: "all", label: t("admin.wf.sla.tile.all"), ring: "border-border" },
];

/** Compliance bands. The threshold is presentational; the number is the view's. */
function complianceTone(pct: number | null): ComplianceTone {
  if (pct === null) return "neutral";
  if (pct >= 95) return "success";
  if (pct >= 80) return "warn";
  return "danger";
}

type ComplianceTone = "success" | "warn" | "danger" | "neutral";

const BAR_FILL: Readonly<Record<ComplianceTone, string>> = {
  success: "hsl(var(--success))",
  warn: "hsl(var(--warning))",
  danger: "hsl(var(--destructive))",
  neutral: "hsl(var(--muted-foreground))",
};

export default function SlaEscalationsPage() {
  const [params, setParams] = useSearchParams();
  const rawSlice = params.get("slice");
  const slice: BreachSlice = isBreachSlice(rawSlice) ? rawSlice : "open";
  const requestTypeId = params.get("type") ?? "";
  const approverId = params.get("approver") ?? "";

  const types = useRequestTypes();
  const typeMap = useRequestTypeMap(types.data);

  const breachFilters = useMemo<BreachFilters>(
    () => ({
      slice,
      ...(approverId !== "" ? { approverEmployeeId: approverId } : {}),
    }),
    [slice, approverId],
  );

  const slaFilters = useMemo<SlaFilters>(
    () => ({
      ...(requestTypeId !== "" ? { requestTypeId } : {}),
      ...(approverId !== "" ? { approverEmployeeId: approverId } : {}),
    }),
    [requestTypeId, approverId],
  );

  const breaches = useSlaBreaches(breachFilters);
  // Memoised: the id lists below feed query keys for the name joins.
  const breachRows = useMemo(() => breaches.data ?? [], [breaches.data]);
  const breachTotal = useSlaBreachCount(breachFilters);

  const counts: Record<BreachSlice, ReturnType<typeof useSlaBreachCount>> = {
    open: useSlaBreachCount({ ...breachFilters, slice: "open" }),
    escalated: useSlaBreachCount({ ...breachFilters, slice: "escalated" }),
    resolved: useSlaBreachCount({ ...breachFilters, slice: "resolved" }),
    all: useSlaBreachCount({ ...breachFilters, slice: "all" }),
  };

  const compliance = useApprovalSla(slaFilters);
  const complianceRows = useMemo(() => compliance.data ?? [], [compliance.data]);
  const complianceTotal = useApprovalSlaCount(slaFilters);

  // Labels: the approver a breach was recorded against, who it escalated to, and
  // the request it belongs to. Joins keyed by ids already on screen.
  const employeeIds = useMemo(
    () =>
      breachRows
        .flatMap((b) => [b.approver_id, b.escalated_to])
        .filter((v): v is string => v !== null),
    [breachRows],
  );
  const people = usePeopleByEmployeeId(employeeIds);

  const requestIds = useMemo(() => breachRows.map((b) => b.approval_request_id), [breachRows]);
  const requests = useRequestRefs(requestIds);

  const approverOptions = useMemo(
    () =>
      [...new Map(complianceRows.map((r) => [r.approver_employee_id, r])).values()].map((r) => ({
        value: r.approver_employee_id,
        label: `${r.approver_display_name} · ${r.approver_employee_code}`,
      })),
    [complianceRows],
  );

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const lastRecorded = breachRows[0]?.recorded_at ?? null;
  const anyFilter = requestTypeId !== "" || approverId !== "" || slice !== "open";

  return (
    <div className="container py-6">
      <PageHeader
        icon={AlarmClock}
        title={t("admin.wf.sla.title")}
        subtitle={
          breachTotal.isSuccess
            ? t("admin.wf.sla.subtitle.count", { n: formatNumber(breachTotal.data) })
            : t("admin.wf.sla.subtitle.plain")
        }
        actions={
          lastRecorded !== null ? (
            <span className="num text-xs text-muted-foreground">
              {t("admin.wf.sla.lastSweep", { at: fmtDateTime(lastRecorded) })}
            </span>
          ) : null
        }
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TILES.map((tile) => {
          const q = counts[tile.slice];
          const active = slice === tile.slice;
          return (
            <button
              key={tile.slice}
              type="button"
              onClick={() => setParam("slice", active ? "" : tile.slice)}
              aria-pressed={active}
              className={cn(
                "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tile.ring,
                active && "ring-2 ring-primary",
              )}
            >
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p className="num mt-1 font-display text-2xl font-semibold">
                {q.isPending ? "…" : q.error !== null ? dash(null) : formatNumber(q.data)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.wf.sla.filter.approver")}
          value={approverId}
          placeholder={t("admin.wf.sla.filter.anyApprover")}
          options={approverOptions}
          onChange={(v) => setParam("approver", v)}
          hint={t("admin.wf.sla.filter.approverHint")}
        />
        <SelectField
          label={t("admin.wf.sla.filter.type")}
          value={requestTypeId}
          placeholder={t("admin.wf.sla.filter.anyType")}
          options={(types.data ?? []).map((rt) => ({ value: rt.id, label: rt.name }))}
          onChange={(v) => setParam("type", v)}
          hint={t("admin.wf.sla.filter.typeHint")}
        />
        <div className="flex items-end gap-2">
          {anyFilter ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.wf.sla.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      <h2 className="mt-6 font-display text-lg font-semibold">{t("admin.wf.sla.breach.heading")}</h2>
      <p className="text-sm text-muted-foreground">{t("admin.wf.sla.breach.sub")}</p>

      <div className="mt-3">
        <StateBoundary
          loading={breaches.isPending}
          error={breaches.error}
          onRetry={() => void breaches.refetch()}
          isEmpty={breachRows.length === 0}
          partialError={people.error ?? requests.error ?? breachTotal.error}
          partialLabel={t("admin.wf.sla.partial.breach")}
          empty={
            <EmptyState
              icon={AlarmClock}
              title={t("admin.wf.sla.breach.empty.title")}
              hint={t("admin.wf.sla.breach.empty.hint")}
            />
          }
        >
          <DataGrid
            columns={breachColumns(people.data, requests.data, typeMap)}
            rows={breachRows}
            rowKey={(row) => row.id}
            pageSize={25}
          />
        </StateBoundary>
      </div>

      <h2 className="mt-8 flex items-center gap-2 font-display text-lg font-semibold">
        <TrendingUp className="size-5 text-muted-foreground" aria-hidden />
        {t("admin.wf.sla.compliance.heading")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {complianceTotal.isSuccess
          ? t("admin.wf.sla.compliance.sub", { n: formatNumber(complianceTotal.data) })
          : t("admin.wf.sla.compliance.subPlain")}
      </p>

      <div className="mt-3">
        <StateBoundary
          loading={compliance.isPending}
          error={compliance.error}
          onRetry={() => void compliance.refetch()}
          isEmpty={complianceRows.length === 0}
          partialError={complianceTotal.error}
          partialLabel={t("admin.wf.sla.partial.compliance")}
          empty={
            <EmptyState
              icon={TrendingUp}
              title={t("admin.wf.sla.compliance.empty.title")}
              hint={t("admin.wf.sla.compliance.empty.hint")}
            />
          }
        >
          <ComplianceChart rows={complianceRows} />
          <div className="mt-4">
            <DataGrid
              columns={complianceColumns(typeMap)}
              rows={complianceRows}
              rowKey={(row) => `${row.approver_employee_id}|${row.request_type_id}`}
              pageSize={25}
            />
          </div>
        </StateBoundary>
      </div>

      <div className="mt-6 space-y-3">
        <Notice tone="info">{t("admin.wf.sla.sweepNotice")}</Notice>
        <Notice tone="info">{t("admin.wf.sla.pathNotice")}</Notice>
      </div>
    </div>
  );
}

interface ChartDatum {
  readonly label: string;
  readonly pct: number;
  readonly decided: number;
  readonly tone: ComplianceTone;
}

/**
 * `on_time_pct` per approver × request type, plotted as the view returns it.
 *
 * Rows where the view left `on_time_pct` NULL (no decided action, hence no
 * denominator) are excluded rather than drawn as zero — a person who has decided
 * nothing has not been late. The table underneath carries every row including
 * those, which is the chart's own fallback.
 */
function ComplianceChart({ rows }: { rows: readonly ApprovalSlaRow[] }) {
  const data = useMemo<ChartDatum[]>(
    () =>
      rows
        .filter((r): r is ApprovalSlaRow & { on_time_pct: number } => r.on_time_pct !== null)
        .slice(0, 12)
        .map((r) => ({
          label: `${r.approver_display_name} · ${r.request_type_code}`,
          pct: r.on_time_pct,
          decided: r.decided,
          tone: complianceTone(r.on_time_pct),
        })),
    [rows],
  );

  const byLabel = useMemo(
    () => new Map<string, ChartDatum>(data.map((d) => [d.label, d])),
    [data],
  );

  if (data.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        {t("admin.wf.sla.chart.noSeries")}
      </p>
    );
  }

  return (
    <figure className="rounded-lg border bg-card p-4">
      <figcaption className="text-sm font-medium">{t("admin.wf.sla.chart.title")}</figcaption>
      <p className="mt-1 text-xs text-muted-foreground">{t("admin.wf.sla.chart.hint")}</p>
      {/* Wide chart scrolls in its own container below 768px (spec §8 mobile). */}
      <div className="mt-3 overflow-x-auto">
        <div className="h-80 min-w-[560px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={[...data]}
              layout="vertical"
              margin={{ top: 8, right: 24, bottom: 4, left: 8 }}
              accessibilityLayer
            >
              <CartesianGrid stroke="hsl(var(--border))" horizontal={false} />
              <XAxis
                type="number"
                domain={[0, 100]}
                tickFormatter={(value: number) => formatPercent(value, { digits: 0 })}
                tick={{ fontSize: 12 }}
                stroke="hsl(var(--border))"
                tickLine={false}
                className="fill-muted-foreground"
              />
              <YAxis
                type="category"
                dataKey="label"
                width={216}
                tick={{ fontSize: 12 }}
                stroke="hsl(var(--border))"
                tickLine={false}
                className="fill-muted-foreground"
              />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted))", fillOpacity: 0.4 }}
                content={({ active, label }) => {
                  if (active !== true) return null;
                  const datum = byLabel.get(String(label));
                  if (datum === undefined) return null;
                  return (
                    <div className="rounded-md border bg-popover px-3 py-2 text-sm shadow-md">
                      <p className="font-medium">{datum.label}</p>
                      <p className="num mt-0.5">
                        {t("admin.wf.sla.chart.tooltipPct", { pct: formatPercent(datum.pct) })}
                      </p>
                      <p className="num mt-0.5 text-xs text-muted-foreground">
                        {t("admin.wf.sla.chart.tooltipDecided", {
                          n: formatNumber(datum.decided),
                        })}
                      </p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="pct" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {data.map((d) => (
                  <Cell key={d.label} fill={BAR_FILL[d.tone]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </figure>
  );
}

/** The breach register's columns. Every value shown is a column of the row. */
function breachColumns(
  people: PersonRefMap | undefined,
  requests: ReadonlyMap<string, RequestRef> | undefined,
  typeMap: RequestTypeMap,
): DataGridColumn<SlaBreach>[] {
  return [
    {
      key: "approval_request_id",
      header: t("admin.wf.sla.col.request"),
      width: "16rem",
      render: (row) => {
        const ref = requests?.get(row.approval_request_id) ?? null;
        return ref === null ? (
          <span className="text-sm text-muted-foreground">{t("admin.wf.sla.requestUnread")}</span>
        ) : (
          <span className="flex flex-col leading-tight">
            <span className="font-medium">{ref.title}</span>
            <span className="num text-xs text-muted-foreground">
              {ref.request_number}
              {" · "}
              {dash(typeMap.get(ref.request_type_id)?.name ?? null)}
            </span>
          </span>
        );
      },
    },
    {
      key: "level",
      header: t("admin.wf.sla.col.level"),
      width: "6rem",
      align: "right",
      render: (row) => <span className="num">{formatNumber(row.level)}</span>,
    },
    {
      key: "approver_id",
      header: t("admin.wf.sla.col.approver"),
      width: "13rem",
      render: (row) => {
        if (row.approver_id === null) {
          return (
            <span className="text-sm text-muted-foreground">
              {t("admin.wf.sla.noApproverResolved")}
            </span>
          );
        }
        const person = people?.get(row.approver_id) ?? null;
        return person === null ? (
          <span className="text-sm text-muted-foreground">{dash(null)}</span>
        ) : (
          <PersonCell
            name={person.display_name}
            code={person.employee_code}
            secondary={person.department_name}
          />
        );
      },
    },
    {
      key: "sla_due_at",
      header: t("admin.wf.sla.col.due"),
      width: "12rem",
      sortable: true,
      hideBelow: "md",
      render: (row) => <span className="num">{fmtDateTime(row.sla_due_at)}</span>,
    },
    {
      key: "hours_overdue",
      header: t("admin.wf.sla.col.overdue"),
      width: "10rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.hours_overdue ?? 0,
      // The sweep rounded this into the row; it is never measured here.
      render: (row) => (
        <span className="num text-destructive">{fmtDurationFromHours(row.hours_overdue)}</span>
      ),
    },
    {
      key: "escalated_to",
      header: t("admin.wf.sla.col.escalatedTo"),
      width: "13rem",
      hideBelow: "lg",
      render: (row) => {
        if (row.escalated_to === null) {
          return (
            <span className="text-xs text-muted-foreground">
              {t("admin.wf.sla.notEscalated")}
            </span>
          );
        }
        const person = people?.get(row.escalated_to) ?? null;
        return (
          <span className="flex flex-col leading-tight">
            <span className="text-sm">{dash(person?.display_name ?? null)}</span>
            <span className="num text-xs text-muted-foreground">
              {dash(row.escalated_at, fmtDateTime)}
            </span>
          </span>
        );
      },
    },
    {
      key: "notified_count",
      header: t("admin.wf.sla.col.reminders"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{formatNumber(row.notified_count)}</span>,
    },
    {
      key: "resolved_at",
      header: t("admin.wf.sla.col.state"),
      width: "12rem",
      render: (row) =>
        row.resolved_at === null ? (
          <StatusChip status="open" map={BREACH_OPEN_CHIP} />
        ) : (
          <span className="flex flex-col gap-1 leading-tight">
            {row.resolution === null ? (
              <StatusChip status="resolved" map={BREACH_OPEN_CHIP} />
            ) : (
              <StatusChip status={row.resolution} map={BREACH_RESOLUTION_CHIP} />
            )}
            <span className="num text-xs text-muted-foreground">
              {fmtDateTime(row.resolved_at)}
            </span>
          </span>
        ),
    },
    {
      key: "request_status",
      header: t("admin.wf.sla.col.requestState"),
      width: "10rem",
      hideBelow: "lg",
      render: (row) => {
        const ref = requests?.get(row.approval_request_id) ?? null;
        return ref === null ? (
          <span className="text-sm text-muted-foreground">{dash(null)}</span>
        ) : (
          <StatusChip status={ref.status} map={REQUEST_STATUS_CHIP} />
        );
      },
    },
  ];
}

/** `v_approval_sla`, printed. `on_time_pct` arrives ready-rounded from the view. */
function complianceColumns(typeMap: RequestTypeMap): DataGridColumn<ApprovalSlaRow>[] {
  return [
    {
      key: "approver_display_name",
      header: t("admin.wf.sla.col.approver"),
      width: "14rem",
      sortable: true,
      render: (row) => (
        <PersonCell name={row.approver_display_name} code={row.approver_employee_code} />
      ),
    },
    {
      key: "request_type_id",
      header: t("admin.wf.sla.col.type"),
      width: "12rem",
      sortable: true,
      render: (row) => dash(typeMap.get(row.request_type_id)?.name ?? row.request_type_name),
    },
    {
      key: "decided",
      header: t("admin.wf.sla.col.decided"),
      width: "8rem",
      align: "right",
      sortable: true,
      render: (row) => <span className="num">{formatNumber(row.decided)}</span>,
    },
    {
      key: "on_time",
      header: t("admin.wf.sla.col.onTime"),
      width: "8rem",
      align: "right",
      sortable: true,
      render: (row) => <span className="num text-success">{formatNumber(row.on_time)}</span>,
    },
    {
      key: "breached",
      header: t("admin.wf.sla.col.late"),
      width: "8rem",
      align: "right",
      sortable: true,
      render: (row) => (
        <span className={cn("num", row.breached > 0 && "text-destructive")}>
          {formatNumber(row.breached)}
        </span>
      ),
    },
    {
      key: "on_time_pct",
      header: t("admin.wf.sla.col.compliance"),
      width: "10rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.on_time_pct ?? -1,
      render: (row) => (
        <span
          className={cn(
            "num font-medium",
            complianceTone(row.on_time_pct) === "success" && "text-success",
            complianceTone(row.on_time_pct) === "warn" && "text-warning",
            complianceTone(row.on_time_pct) === "danger" && "text-destructive",
          )}
        >
          {formatPercent(row.on_time_pct)}
        </span>
      ),
    },
    {
      key: "avg_hours_to_decide",
      header: t("admin.wf.sla.col.avgDecide"),
      width: "11rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.avg_hours_to_decide ?? -1,
      render: (row) => <span className="num">{fmtDurationFromHours(row.avg_hours_to_decide)}</span>,
    },
  ];
}
