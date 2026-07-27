/**
 * §14 · /admin/analytics/payroll — Payroll & Cost Analytics. Cost per
 * department, per cost centre, over time.
 *
 * THE GRAIN DECIDES WHAT CAN HONESTLY BE SHOWN. `v_payroll_cost_monthly` (over
 * `analytics.mv_payroll_cost_monthly`) has one row per pay period × department ×
 * cost centre. It therefore owns the BREAKDOWN — `total_cost_paise`,
 * `cost_per_employee_paise`, `overtime_share_pct` — and it has no org-total row
 * at all. Adding its rows up in the browser to draw "cost this month" would be
 * client-side business arithmetic on money, so this screen does not:
 *
 *   * the ORG trend and the four headline tiles read `payroll_runs` — the period
 *     totals the payroll engine itself wrote (`total_gross_paise`,
 *     `total_employer_cost_paise`, `total_net_paise`, `employee_count`),
 *     filtered to RELEASED_RUN_STATUSES, which is the SAME status set the
 *     matview's predicate uses. Two views of one number, never two numbers.
 *   * the DEPARTMENT chart and the grid read the matview, at its own grain, with
 *     `total_cost_paise` printed exactly as Postgres computed it.
 *
 * The stacked trend deserves a word: its two segments are `total_gross_paise`
 * and `total_employer_cost_paise`, both server columns, and their sum is the
 * §9.2 definition of Payroll Cost (gross earnings + employer contributions).
 * The bar's height is that sum drawn, not a sum computed — and the caption says
 * exactly that.
 *
 * Money is integer paise throughout, rendered by `<Money>` / `formatPaise`.
 * Nothing on this page divides by 100.
 *
 * @route /admin/analytics/payroll
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { BarChart3, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { KpiTile } from "@/shared/ui/KpiTile";
import { Money } from "@/shared/ui/Money";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { formatPaise } from "@/lib/money";
import { compareCivilDates, fmtDateTime, fmtMonthLong, istMonthOfDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, type SelectOption } from "../components/Field";
import {
  RankedBarsChart,
  StackedBarsChart,
  type ChartPoint,
  type ChartSeries,
} from "../components/AnalyticsOpsCharts";
import { useRefOptions } from "../hooks/useMasters";
import { useAdminPayPeriods, usePayPeriodMap } from "../hooks/useAdminPayroll";
import { usePayrollCost, usePayrollCostCount, useReleasedRuns } from "../hooks/useAnalyticsOps";
import type { PayrollCostRow } from "../api/analytics-ops.api";
import type { PayPeriod, PayrollRun } from "../api/payroll.api";

/** Most recent releases, oldest-first once plotted — twelve months of trend. */
const TREND_MONTHS = 12;

const TREND_SERIES: readonly ChartSeries[] = [
  { key: "gross", label: t("admin.acost.series.gross") },
  { key: "employer", label: t("admin.acost.series.employer") },
];

const DEPARTMENT_MEASURE: ChartSeries = {
  key: "total",
  label: t("admin.acost.series.totalCost"),
};

/** '2026-07' → 'July 2026', via lib/datetime only. */
function periodLabel(period: PayPeriod | undefined, run: PayrollRun): string {
  if (period === undefined) return run.run_number;
  return fmtMonthLong(istMonthOfDate(period.end_date));
}

function scopeLabel(row: PayrollCostRow): string {
  const department = row.department_name ?? t("admin.acost.noDepartment");
  const costCentre = row.cost_centre_name;
  return costCentre === null ? department : `${department} · ${costCentre}`;
}

export default function AnalyticsPayrollPage() {
  const [params, setParams] = useSearchParams();

  const periods = useAdminPayPeriods();
  const periodMap = usePayPeriodMap(periods.data);
  const runs = useReleasedRuns();
  const departments = useRefOptions("departments");
  const costCentres = useRefOptions("costCentres");

  /**
   * The released runs, oldest first, capped to the trend window. The read orders
   * by created_at DESC (its keyset), so this takes the most recent window and
   * re-sorts it by the PERIOD it pays for — a rerun created late must not appear
   * out of order on a time axis. Sorting is presentation, not a re-derivation.
   */
  const trendRuns = useMemo(() => {
    const rows = (runs.data ?? []).slice(0, TREND_MONTHS);
    return [...rows].sort((a, b) => {
      const ea = periodMap.get(a.pay_period_id)?.end_date;
      const eb = periodMap.get(b.pay_period_id)?.end_date;
      if (ea === undefined || eb === undefined) return a.created_at.localeCompare(b.created_at);
      return compareCivilDates(ea, eb);
    });
  }, [runs.data, periodMap]);

  const latestRun = (runs.data ?? [])[0];
  const periodParam = params.get("period") ?? "";
  // Default to the most recent released run's period — the answer to "what did
  // last month cost", which is why an admin opens this screen.
  const periodId = periodParam !== "" ? periodParam : (latestRun?.pay_period_id ?? "");
  const departmentId = params.get("department") ?? "";
  const costCentreId = params.get("costCentre") ?? "";

  const filters = useMemo(
    () => ({
      ...(periodId !== "" ? { payPeriodIds: [periodId] } : {}),
      ...(departmentId !== "" ? { departmentIds: [departmentId] } : {}),
      ...(costCentreId !== "" ? { costCentreIds: [costCentreId] } : {}),
    }),
    [periodId, departmentId, costCentreId],
  );

  const cost = usePayrollCost(filters);
  const costCount = usePayrollCostCount(filters);
  // Memoised so the chart's point list is not rebuilt on every render.
  const rows = useMemo(() => cost.data ?? [], [cost.data]);

  const selectedRun = useMemo(
    () => (runs.data ?? []).find((r) => r.pay_period_id === periodId),
    [runs.data, periodId],
  );
  const selectedPeriod = periodId !== "" ? periodMap.get(periodId) : undefined;

  const periodOptions: SelectOption[] = useMemo(
    () =>
      (runs.data ?? []).map((run) => ({
        value: run.pay_period_id,
        label: periodLabel(periodMap.get(run.pay_period_id), run),
      })),
    [runs.data, periodMap],
  );

  const trendPoints: readonly ChartPoint[] = useMemo(
    () =>
      trendRuns.map((run) => ({
        x: periodLabel(periodMap.get(run.pay_period_id), run),
        values: { gross: run.total_gross_paise, employer: run.total_employer_cost_paise },
      })),
    [trendRuns, periodMap],
  );

  const departmentPoints: readonly ChartPoint[] = useMemo(
    () => rows.map((row) => ({ x: scopeLabel(row), values: { total: row.total_cost_paise } })),
    [rows],
  );

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  const columns: DataGridColumn<PayrollCostRow>[] = useMemo(
    () => [
      {
        key: "department_name",
        header: t("admin.acost.col.department"),
        width: "13rem",
        sortable: true,
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="font-medium">
              {row.department_name ?? t("admin.acost.noDepartment")}
            </span>
            <span className="text-xs text-muted-foreground">
              {row.cost_centre_name ?? t("admin.acost.noCostCentre")}
            </span>
          </span>
        ),
      },
      {
        key: "pay_period_code",
        header: t("admin.acost.col.period"),
        width: "9rem",
        hideBelow: "lg",
        render: (row) => <span className="num">{row.pay_period_code}</span>,
      },
      {
        key: "employee_count",
        header: t("admin.acost.col.employees"),
        width: "7rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.employee_count)}</span>,
      },
      {
        key: "gross_paise",
        header: t("admin.acost.col.gross"),
        width: "9rem",
        align: "right",
        sortable: true,
        hideBelow: "md",
        render: (row) => <Money paise={row.gross_paise} />,
      },
      {
        key: "employer_cost_paise",
        header: t("admin.acost.col.employer"),
        width: "9rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <Money paise={row.employer_cost_paise} />,
      },
      {
        key: "total_cost_paise",
        header: t("admin.acost.col.totalCost"),
        width: "10rem",
        align: "right",
        sortable: true,
        render: (row) => <Money paise={row.total_cost_paise} className="font-medium" />,
      },
      {
        key: "cost_per_employee_paise",
        header: t("admin.acost.col.perEmployee"),
        width: "9rem",
        align: "right",
        sortable: true,
        hideBelow: "md",
        render: (row) => <Money paise={row.cost_per_employee_paise} />,
      },
      {
        key: "overtime_cost_paise",
        header: t("admin.acost.col.overtime"),
        width: "9rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <Money paise={row.overtime_cost_paise} />,
      },
      {
        key: "overtime_share_pct",
        header: t("admin.acost.col.overtimeShare"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        // A SHARE of a whole, so clamped (DR-28) — unlike a growth rate.
        render: (row) => (
          <span className="num">{formatPercent(row.overtime_share_pct, { clamp: true })}</span>
        ),
      },
    ],
    [],
  );

  const refreshedAt = rows[0]?.refreshed_at ?? null;
  const anyFilter = periodParam !== "" || departmentId !== "" || costCentreId !== "";

  return (
    <div className="container py-6">
      <PageHeader
        icon={BarChart3}
        title={t("admin.acost.title")}
        subtitle={t("admin.acost.subtitle")}
      />

      {/* Headline tiles — one payroll_runs row, four of its own columns. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label={t("admin.acost.kpi.employees")}
          value={selectedRun === undefined ? dash(null) : formatNumber(selectedRun.employee_count)}
          hint={t("admin.acost.kpi.employeesHint")}
          explainer={{
            formula: t("admin.acost.kpi.employeesFormula"),
            numbers: t("admin.acost.kpi.source", {
              run: selectedRun?.run_number ?? dash(null),
            }),
          }}
        />
        <KpiTile
          label={t("admin.acost.kpi.gross")}
          value={<Money paise={selectedRun?.total_gross_paise ?? null} />}
          hint={t("admin.acost.kpi.grossHint")}
          explainer={{
            formula: t("admin.acost.kpi.grossFormula"),
            numbers: t("admin.acost.kpi.source", {
              run: selectedRun?.run_number ?? dash(null),
            }),
          }}
        />
        <KpiTile
          label={t("admin.acost.kpi.employer")}
          value={<Money paise={selectedRun?.total_employer_cost_paise ?? null} />}
          hint={t("admin.acost.kpi.employerHint")}
          explainer={{
            formula: t("admin.acost.kpi.employerFormula"),
            numbers: t("admin.acost.kpi.source", {
              run: selectedRun?.run_number ?? dash(null),
            }),
          }}
        />
        <KpiTile
          label={t("admin.acost.kpi.net")}
          value={<Money paise={selectedRun?.total_net_paise ?? null} />}
          hint={t("admin.acost.kpi.netHint")}
          to="/admin/payroll/runs"
          drillLabel={t("admin.acost.kpi.netDrill")}
          explainer={{
            formula: t("admin.acost.kpi.netFormula"),
            numbers: t("admin.acost.kpi.source", {
              run: selectedRun?.run_number ?? dash(null),
            }),
          }}
        />
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.acost.filter.period")}
          value={periodId}
          placeholder={t("admin.acost.filter.anyPeriod")}
          options={periodOptions}
          onChange={(v) => setParam("period", v)}
          hint={
            selectedPeriod === undefined ? undefined : t("admin.acost.filter.periodCode", {
              code: selectedPeriod.code,
            })
          }
        />
        <SelectField
          label={t("admin.acost.filter.department")}
          value={departmentId}
          placeholder={t("admin.acost.filter.anyDepartment")}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => setParam("department", v)}
        />
        <SelectField
          label={t("admin.acost.filter.costCentre")}
          value={costCentreId}
          placeholder={t("admin.acost.filter.anyCostCentre")}
          options={(costCentres.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          onChange={(v) => setParam("costCentre", v)}
        />
        <div className="flex items-end justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {costCount.isSuccess
              ? t("admin.acost.rowCount", { n: formatNumber(costCount.data) })
              : t("admin.acost.rowCountUnknown")}
          </p>
          {anyFilter ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.acost.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Chart 1 — the org trend, from the run headers. */}
      <div className="mt-4 rounded-lg border bg-card p-4">
        <StateBoundary
          loading={runs.isPending || periods.isPending}
          error={runs.error}
          onRetry={() => void runs.refetch()}
          isEmpty={trendPoints.length === 0}
          skeletonRows={4}
          empty={
            <EmptyState
              icon={BarChart3}
              title={t("admin.acost.trend.empty.title")}
              hint={t("admin.acost.trend.empty.hint")}
            />
          }
        >
          <StackedBarsChart
            title={t("admin.acost.trend.title")}
            caption={t("admin.acost.trend.caption")}
            series={TREND_SERIES}
            points={trendPoints}
            format={(v) => formatPaise(v)}
            tickFormat={(v) => formatPaise(v, { paise: false })}
            xHeader={t("admin.acost.col.period")}
          />
        </StateBoundary>
      </div>

      {/* Chart 2 — the breakdown, from the matview, at the matview's grain. */}
      <div className="mt-4 rounded-lg border bg-card p-4">
        <StateBoundary
          loading={cost.isPending}
          error={cost.error}
          onRetry={() => void cost.refetch()}
          isEmpty={departmentPoints.length === 0}
          skeletonRows={4}
          empty={
            <EmptyState
              icon={Layers}
              title={t("admin.acost.breakdown.empty.title")}
              hint={t("admin.acost.breakdown.empty.hint")}
            />
          }
        >
          <RankedBarsChart
            title={t("admin.acost.breakdown.title")}
            caption={t("admin.acost.breakdown.caption")}
            measure={DEPARTMENT_MEASURE}
            points={departmentPoints}
            format={(v) => formatPaise(v)}
            tickFormat={(v) => formatPaise(v, { paise: false })}
            xHeader={t("admin.acost.col.department")}
          />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={cost.isPending}
          error={cost.error}
          onRetry={() => void cost.refetch()}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={Layers}
              title={t("admin.acost.grid.empty.title")}
              hint={t("admin.acost.grid.empty.hint")}
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) =>
              `${row.pay_period_id}:${row.department_key}:${row.cost_centre_key}`
            }
            pageSize={25}
          />
        </StateBoundary>
      </div>

      <div className="mt-4 space-y-2">
        <Notice tone="info">
          {refreshedAt === null
            ? t("admin.acost.note.grain")
            : t("admin.acost.note.grainAsOf", { at: fmtDateTime(refreshedAt) })}
        </Notice>
        <Notice tone="warning">{t("admin.acost.note.noEventCost")}</Notice>
      </div>
    </div>
  );
}
