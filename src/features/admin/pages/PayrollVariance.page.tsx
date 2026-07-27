/**
 * §8 · /admin/payroll/variance — what changed since the previous payslip, per
 * employee and per component, straight out of `v_payroll_variance`.
 *
 * HOW THE VIEW PAIRS ROWS, said in words on the screen: for each payslip in the
 * chosen run it takes that employee's most recent EARLIER payslip (by pay-period
 * start, reversed slips excluded) and subtracts. So "previous" is not "last
 * month" — for a new joiner there is no previous row at all, and then
 * `previous_amount_paise` is NULL, `variance_paise` is the full current amount
 * and `variance_pct` is NULL. The screen prints that as "—", never as 0% and
 * never as ∞.
 *
 * Everything here is a server column: `variance_paise` and `variance_pct` are
 * computed inside the view, and the run's own `variance_vs_previous_pct` comes
 * from `payroll_runs`. This page subtracts nothing. The ±10% tint is the
 * threshold the DATABASE enforces before approval (022 `payroll_runs_guard`
 * requires a reason beyond it) — it chooses a colour, never a figure.
 *
 * Two grains, because they answer different questions: `net_pay` is one row per
 * person ("who is being paid differently?") and `component` is one row per line
 * ("which component moved?"). The count above the grid is a `count=exact` at the
 * SAME grain, so switching grain cannot leave a stale total on screen.
 *
 * @route /admin/payroll/variance
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { VarianceRow } from "../api/payroll.api";
import { PAYROLL_RUN_CHIP, isVarianceFlagged } from "../display";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import {
  useAdminPayPeriods,
  useAdminPayrollRuns,
  usePayPeriodMap,
  useRunVariance,
} from "../hooks/useAdminPayroll";
import {
  LINE_KIND_CHIP,
  VARIANCE_ROW_CAP,
  useRunMap,
  useVarianceCount,
} from "../hooks/usePayrollMasters";

type Grain = "net_pay" | "component";

function isGrain(value: string | null): value is Grain {
  return value === "net_pay" || value === "component";
}

const GRAIN_OPTIONS = [
  { value: "net_pay", label: t("admin.var.grain.net") },
  { value: "component", label: t("admin.var.grain.component") },
];

export default function PayrollVariancePage() {
  const [params, setParams] = useSearchParams();

  const runs = useAdminPayrollRuns(null);
  const runMap = useRunMap(runs.data);
  const periods = useAdminPayPeriods();
  const periodMap = usePayPeriodMap(periods.data);

  // `useAdminPayrollRuns` orders newest-created first, so the default is the run
  // an operator is most likely reviewing right now.
  const runParam = params.get("run");
  const runId = runParam ?? runs.data?.[0]?.id ?? "";
  const grainParam = params.get("grain");
  const grain: Grain = isGrain(grainParam) ? grainParam : "net_pay";

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: false });
  }

  const variance = useRunVariance(runId, grain);
  const total = useVarianceCount(runId === "" ? null : runId, grain);

  const run = runId === "" ? undefined : runMap.get(runId);
  const period = run === undefined ? undefined : periodMap.get(run.pay_period_id);
  const rows = variance.data ?? [];
  const capped = rows.length >= VARIANCE_ROW_CAP;

  const runOptions = useMemo(
    () =>
      (runs.data ?? []).map((row) => {
        const rowPeriod = periodMap.get(row.pay_period_id);
        return {
          value: row.id,
          label:
            rowPeriod === undefined
              ? row.run_number
              : t("admin.var.runOption", { run: row.run_number, period: rowPeriod.name }),
        };
      }),
    [runs.data, periodMap],
  );

  const columns: DataGridColumn<VarianceRow>[] = useMemo(() => {
    const base: DataGridColumn<VarianceRow>[] = [
      {
        key: "employee",
        header: t("admin.var.col.employee"),
        width: "16rem",
        sortable: true,
        sortValue: (row) => row.employee_code ?? "",
        // The view carries the name and code itself (v_employee_ref join).
        render: (row) => (
          <PersonCell name={row.display_name} code={row.employee_code} secondary={null} />
        ),
      },
    ];

    if (grain === "component") {
      base.push(
        {
          key: "component_code",
          header: t("admin.var.col.component"),
          width: "14rem",
          sortable: true,
          render: (row) => (
            <span className="flex flex-col leading-tight">
              <span className="num font-medium">{dash(row.component_code)}</span>
              <span className="text-xs text-muted-foreground">{dash(row.label)}</span>
            </span>
          ),
        },
        {
          key: "line_kind",
          header: t("admin.var.col.lineKind"),
          width: "11rem",
          hideBelow: "md",
          render: (row) =>
            row.line_kind === null ? (
              dash(null)
            ) : (
              <StatusChip status={row.line_kind} map={LINE_KIND_CHIP} />
            ),
        },
      );
    }

    base.push(
      {
        key: "previous_amount_paise",
        header: t("admin.var.col.previous"),
        width: "12rem",
        align: "right",
        render: (row) =>
          row.previous_amount_paise === null ? (
            <span className="flex flex-col items-end leading-tight">
              {dash(null)}
              <span className="text-xs text-muted-foreground">{t("admin.var.noPrevious")}</span>
            </span>
          ) : (
            <Money paise={row.previous_amount_paise} />
          ),
      },
      {
        key: "current_amount_paise",
        header: t("admin.var.col.current"),
        width: "12rem",
        align: "right",
        render: (row) => <Money paise={row.current_amount_paise} />,
      },
      {
        key: "variance_paise",
        header: t("admin.var.col.variance"),
        width: "12rem",
        align: "right",
        sortable: true,
        render: (row) => (
          <Money
            paise={row.variance_paise}
            className={row.variance_paise < 0 ? "text-destructive" : undefined}
          />
        ),
      },
      {
        key: "variance_pct",
        header: t("admin.var.col.variancePct"),
        width: "10rem",
        align: "right",
        sortable: true,
        // A growth rate from the view. NULL when there is nothing to compare to.
        render: (row) => {
          if (row.variance_pct === null) return dash(null);
          const text = formatPercent(row.variance_pct);
          return isVarianceFlagged(row.variance_pct) ? (
            <span className="num text-warning">{text}</span>
          ) : (
            <span className="num">{text}</span>
          );
        },
      },
    );

    return base;
  }, [grain]);

  const subtitle =
    run === undefined
      ? t("admin.var.subtitle")
      : t("admin.var.subtitle.run", {
          run: run.run_number,
          period: period?.name ?? t("admin.var.periodUnknown"),
        });

  return (
    <div className="container py-6">
      <PageHeader icon={BarChart3} title={t("admin.var.title")} subtitle={subtitle} />

      <Notice tone="info" className="mb-4">
        {t("admin.var.pairingNotice")}
      </Notice>

      <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          label={t("admin.var.filter.run")}
          value={runId}
          options={runOptions}
          placeholder={t("admin.var.filter.chooseRun")}
          onChange={(value) => setParam("run", value)}
          disabled={runs.isLoading}
        />
        <SelectField
          label={t("admin.var.filter.grain")}
          value={grain}
          options={GRAIN_OPTIONS}
          onChange={(value) => setParam("grain", value)}
          hint={t("admin.var.filter.grainHint")}
        />
        {run !== undefined ? (
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium">{t("admin.var.runState")}</p>
            <StatusChip status={run.status} map={PAYROLL_RUN_CHIP} />
            <p className="num text-xs text-muted-foreground">
              {period === undefined
                ? t("admin.var.periodUnknown")
                : t("admin.common.dateRange", {
                    from: fmtCivilDate(period.start_date),
                    to: fmtCivilDate(period.end_date),
                  })}
            </p>
          </div>
        ) : null}
      </div>

      {run !== undefined ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label={t("admin.var.tile.runVariance")}
            value={
              run.variance_vs_previous_pct === null
                ? t("common.empty")
                : formatPercent(run.variance_vs_previous_pct)
            }
            hint={t("admin.var.tile.runVarianceHint")}
            tone={isVarianceFlagged(run.variance_vs_previous_pct) ? "warn" : "neutral"}
            to={`/admin/payroll/runs/${run.id}`}
            drillLabel={t("admin.var.tile.drill", { run: run.run_number })}
            explainer={{
              formula: t("admin.var.tile.runVarianceFormula"),
              numbers:
                run.variance_vs_previous_pct === null
                  ? t("admin.var.tile.runVarianceNone")
                  : t("admin.var.tile.runVarianceNumbers", {
                      pct: formatPercent(run.variance_vs_previous_pct),
                    }),
            }}
          />
          <KpiTile
            label={t("admin.var.tile.rows")}
            value={total.isSuccess ? formatNumber(total.data) : t("common.empty")}
            hint={
              grain === "net_pay"
                ? t("admin.var.tile.rowsHintNet")
                : t("admin.var.tile.rowsHintComponent")
            }
            to={`/admin/payroll/runs/${run.id}`}
            drillLabel={t("admin.var.tile.drill", { run: run.run_number })}
            explainer={{
              formula: t("admin.var.tile.rowsFormula"),
              numbers: total.isSuccess
                ? t("admin.var.tile.rowsNumbers", { count: formatNumber(total.data) })
                : t("admin.var.tile.rowsUnavailable"),
            }}
          />
          <KpiTile
            label={t("admin.var.tile.employees")}
            value={formatNumber(run.employee_count)}
            hint={t("admin.var.tile.employeesHint")}
            to={`/admin/payroll/runs/${run.id}`}
            drillLabel={t("admin.var.tile.drill", { run: run.run_number })}
          />
          <KpiTile
            label={t("admin.var.tile.net")}
            value={<Money paise={run.total_net_paise} />}
            hint={t("admin.var.tile.netHint")}
            to={`/admin/payroll/runs/${run.id}`}
            drillLabel={t("admin.var.tile.drill", { run: run.run_number })}
          />
        </div>
      ) : null}

      {capped ? (
        <Notice tone="warning" className="mb-4">
          {t("admin.common.rowCap", { count: VARIANCE_ROW_CAP })}
        </Notice>
      ) : null}

      {runId === "" ? (
        <StateBoundary
          loading={runs.isPending}
          error={runs.error}
          onRetry={() => void runs.refetch()}
          skeletonRows={3}
        >
          <EmptyState
            icon={BarChart3}
            title={t("admin.var.noRun.title")}
            hint={t("admin.var.noRun.hint")}
          />
        </StateBoundary>
      ) : (
        <StateBoundary
          loading={variance.isPending}
          error={variance.error}
          onRetry={() => void variance.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error ?? periods.error}
          partialLabel={t("admin.var.partial")}
          empty={
            <EmptyState
              icon={BarChart3}
              title={t("admin.var.empty.title")}
              hint={t("admin.var.empty.hint")}
              action={
                <Button variant="outline" asChild>
                  <Link to={`/admin/payroll/runs/${runId}`}>{t("admin.var.openRun")}</Link>
                </Button>
              }
            />
          }
          skeletonRows={6}
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) =>
              `${row.employee_id}:${row.variance_grain}:${row.salary_component_id ?? row.component_code ?? "net"}`
            }
            pageSize={50}
          />
        </StateBoundary>
      )}

      <p className="mt-6 text-xs text-muted-foreground">{t("admin.var.footnote")}</p>
    </div>
  );
}
