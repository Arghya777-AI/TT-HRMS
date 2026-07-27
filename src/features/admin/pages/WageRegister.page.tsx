/**
 * §8 · /admin/payroll/register — the wage register for one pay period: the runs
 * that make up the period with their own totals, and one line per employee.
 *
 * THE GAP THIS SCREEN IS HONEST ABOUT. There is no view in the deployed schema
 * that totals a pay PERIOD. The server-side sums that exist are per RUN —
 * `payroll_runs.total_gross_paise / total_deductions_paise / total_net_paise /
 * total_employer_cost_paise / employee_count`, maintained by the compute engine —
 * and per month × department × cost centre in `analytics.mv_payroll_cost_monthly`
 * (exposed as `v_payroll_cost_monthly`), which is a different grain again.
 *
 * So this screen shows each run's own totals and refuses to add them together.
 * A period with a regular run plus an off-cycle arrears run has two sets of
 * figures, and inventing a third by summing them in the browser would produce a
 * number no audit trail could reproduce. Pick a run to see its totals as tiles;
 * with "All runs" selected the per-run table IS the total row set, and the notice
 * says which server view is missing.
 *
 * The employee lines come from `payslips` at header grain, ordered by
 * `payslip_number` (which starts with the employee code — the traditional
 * register order), capped, and the cap is stated on screen. The count above the
 * grid is a `count=exact` over the same filters, never `rows.length`.
 *
 * @route /admin/payroll/register
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FileText } from "lucide-react";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate } from "@/lib/datetime";
import { dash, formatDaysFixed, formatNumber, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { PayrollRun } from "../api/payroll.api";
import {
  REGISTER_ROW_CAP,
  type PayslipHeader,
  type PayslipRegisterFilters,
} from "../api/payroll-masters.api";
import { PAYROLL_RUN_CHIP, isVarianceFlagged } from "../display";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import { useAdminPayPeriods, usePayPeriodMap } from "../hooks/useAdminPayroll";
import {
  PAYMENT_STATUS_CHIP,
  runKindLabel,
  usePayslipCount,
  usePeriodPayslips,
  usePeriodRuns,
  useRunMap,
} from "../hooks/usePayrollMasters";

export default function WageRegisterPage() {
  const [params, setParams] = useSearchParams();

  const periods = useAdminPayPeriods();
  const periodMap = usePayPeriodMap(periods.data);

  // `fetchPayPeriods` orders by start_date DESC, so the first row is the newest
  // period — the one an operator opening the register almost always wants.
  const periodParam = params.get("period");
  const periodId = periodParam ?? periods.data?.[0]?.id ?? "";
  const runId = params.get("run") ?? "";

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    // Changing the period invalidates the run choice inside it.
    if (name === "period") next.delete("run");
    setParams(next, { replace: false });
  }

  const runs = usePeriodRuns(periodId === "" ? null : periodId);
  const runMap = useRunMap(runs.data);
  const payslips = usePeriodPayslips(periodId === "" ? null : periodId);
  const labels = useEmployeeLabels();

  const countFilters = useMemo<PayslipRegisterFilters>(
    () => ({
      ...(periodId !== "" ? { payPeriodId: periodId } : {}),
      ...(runId !== "" ? { runId } : {}),
    }),
    [periodId, runId],
  );
  const total = usePayslipCount(countFilters);

  const period = periodId === "" ? undefined : periodMap.get(periodId);
  const selectedRun = runId === "" ? undefined : runMap.get(runId);

  /** Selecting a run narrows the register; it never changes a figure. */
  const rows = useMemo(() => {
    const all = payslips.data ?? [];
    return runId === "" ? all : all.filter((row) => row.payroll_run_id === runId);
  }, [payslips.data, runId]);

  const capped = (payslips.data ?? []).length >= REGISTER_ROW_CAP;

  const periodOptions = useMemo(
    () => (periods.data ?? []).map((row) => ({ value: row.id, label: row.name })),
    [periods.data],
  );
  const runOptions = useMemo(
    () => (runs.data ?? []).map((row) => ({ value: row.id, label: row.run_number })),
    [runs.data],
  );

  const runColumns: DataGridColumn<PayrollRun>[] = [
    {
      key: "run_number",
      header: t("admin.wreg.run.col.run"),
      width: "11rem",
      render: (row) => (
        <Link
          to={`/admin/payroll/runs/${row.id}`}
          className="num font-medium underline-offset-2 hover:underline"
        >
          {row.run_number}
        </Link>
      ),
    },
    {
      key: "run_kind",
      header: t("admin.wreg.run.col.kind"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => <span className="text-xs">{runKindLabel(row.run_kind)}</span>,
    },
    {
      key: "status",
      header: t("admin.wreg.run.col.status"),
      width: "11rem",
      render: (row) => <StatusChip status={row.status} map={PAYROLL_RUN_CHIP} />,
    },
    {
      key: "employee_count",
      header: t("admin.wreg.run.col.employees"),
      width: "8rem",
      align: "right",
      render: (row) => <span className="num">{formatNumber(row.employee_count)}</span>,
    },
    {
      key: "total_gross_paise",
      header: t("admin.wreg.run.col.gross"),
      width: "11rem",
      align: "right",
      render: (row) => <Money paise={row.total_gross_paise} />,
    },
    {
      key: "total_deductions_paise",
      header: t("admin.wreg.run.col.deductions"),
      width: "11rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <Money paise={row.total_deductions_paise} />,
    },
    {
      key: "total_net_paise",
      header: t("admin.wreg.run.col.net"),
      width: "12rem",
      align: "right",
      render: (row) => <Money paise={row.total_net_paise} className="font-semibold" />,
    },
    {
      key: "total_employer_cost_paise",
      header: t("admin.wreg.run.col.employerCost"),
      width: "12rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <Money paise={row.total_employer_cost_paise} />,
    },
    {
      key: "variance_vs_previous_pct",
      header: t("admin.wreg.run.col.variance"),
      width: "9rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => {
        if (row.variance_vs_previous_pct === null) return dash(null);
        const text = formatPercent(row.variance_vs_previous_pct);
        return isVarianceFlagged(row.variance_vs_previous_pct) ? (
          <span className="num text-warning">{text}</span>
        ) : (
          <span className="num">{text}</span>
        );
      },
    },
  ];

  const registerColumns: DataGridColumn<PayslipHeader>[] = [
    {
      key: "employee",
      header: t("admin.wreg.col.employee"),
      width: "15rem",
      sortable: true,
      sortValue: (row) => labels.data?.get(row.employee_id)?.code ?? "",
      render: (row) => {
        const label = labels.data?.get(row.employee_id);
        return (
          <PersonCell
            name={label?.name ?? null}
            code={label?.code ?? null}
            secondary={label?.department ?? null}
          />
        );
      },
    },
    {
      key: "payslip_number",
      header: t("admin.wreg.col.number"),
      width: "12rem",
      sortable: true,
      render: (row) => <span className="num text-xs">{row.payslip_number}</span>,
    },
    {
      key: "run",
      header: t("admin.wreg.col.run"),
      width: "10rem",
      hideBelow: "md",
      render: (row) => {
        const run = runMap.get(row.payroll_run_id);
        return run === undefined ? (
          <span className="text-xs text-muted-foreground">{t("admin.wreg.runUnknown")}</span>
        ) : (
          <span className="num text-xs">{run.run_number}</span>
        );
      },
    },
    {
      key: "paid_days",
      header: t("admin.wreg.col.paidDays"),
      width: "10rem",
      align: "right",
      render: (row) => (
        <span className="num">
          {t("admin.wreg.paidDaysOf", {
            paid: formatDaysFixed(row.paid_days),
            total: formatNumber(row.period_days),
          })}
        </span>
      ),
    },
    {
      key: "lop_days",
      header: t("admin.wreg.col.lop"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{formatDaysFixed(row.lop_days)}</span>,
    },
    {
      key: "gross_earnings_paise",
      header: t("admin.wreg.col.gross"),
      width: "11rem",
      align: "right",
      render: (row) => <Money paise={row.gross_earnings_paise} />,
    },
    {
      key: "total_deductions_paise",
      header: t("admin.wreg.col.deductions"),
      width: "11rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <Money paise={row.total_deductions_paise} />,
    },
    {
      key: "net_pay_paise",
      header: t("admin.wreg.col.net"),
      width: "12rem",
      align: "right",
      sortable: true,
      render: (row) => <Money paise={row.net_pay_paise} className="font-semibold" />,
    },
    {
      key: "employer_contributions_paise",
      header: t("admin.wreg.col.employerCost"),
      width: "12rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <Money paise={row.employer_contributions_paise} />,
    },
    {
      key: "total_ctc_for_period_paise",
      header: t("admin.wreg.col.ctc"),
      width: "12rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <Money paise={row.total_ctc_for_period_paise} />,
    },
    {
      key: "payment_status",
      header: t("admin.wreg.col.paymentStatus"),
      width: "11rem",
      render: (row) => <StatusChip status={row.payment_status} map={PAYMENT_STATUS_CHIP} />,
    },
  ];

  const subtitle =
    period === undefined
      ? t("admin.wreg.subtitle")
      : t("admin.wreg.subtitle.period", {
          name: period.name,
          from: fmtCivilDate(period.start_date),
          to: fmtCivilDate(period.end_date),
        });

  return (
    <div className="container py-6">
      <PageHeader icon={FileText} title={t("admin.wreg.title")} subtitle={subtitle} />

      <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          label={t("admin.wreg.filter.period")}
          value={periodId}
          options={periodOptions}
          placeholder={t("admin.wreg.filter.choosePeriod")}
          onChange={(value) => setParam("period", value)}
          disabled={periods.isLoading}
        />
        <SelectField
          label={t("admin.wreg.filter.run")}
          value={runId}
          options={runOptions}
          placeholder={t("admin.wreg.filter.allRuns")}
          onChange={(value) => setParam("run", value)}
          disabled={runs.isLoading || periodId === ""}
          hint={t("admin.wreg.filter.runHint")}
        />
        {period !== undefined ? (
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium">{t("admin.wreg.periodState")}</p>
            <p className="text-xs text-muted-foreground">
              {period.payroll_finalised_at !== null
                ? t("admin.wreg.periodFinalised")
                : period.is_open
                  ? t("admin.wreg.periodOpen")
                  : t("admin.wreg.periodClosed")}
            </p>
            <p className="num text-xs text-muted-foreground">
              {period.pay_date === null
                ? t("admin.wreg.noPayDate")
                : t("admin.wreg.payDate", { date: fmtCivilDate(period.pay_date) })}
            </p>
          </div>
        ) : null}
      </div>

      {periodId === "" ? (
        <StateBoundary
          loading={periods.isPending}
          error={periods.error}
          onRetry={() => void periods.refetch()}
          skeletonRows={3}
        >
          <EmptyState
            icon={FileText}
            title={t("admin.wreg.noPeriod.title")}
            hint={t("admin.wreg.noPeriod.hint")}
          />
        </StateBoundary>
      ) : (
        <>
          {/* Per-run server totals. No period total exists in the schema. */}
          <section className="mb-6">
            <h2 className="font-display text-lg font-semibold">{t("admin.wreg.runs.heading")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("admin.wreg.runs.hint")}</p>

            {selectedRun === undefined ? (
              <Notice tone="warning" className="mt-3">
                {t("admin.wreg.noPeriodTotalView")}
              </Notice>
            ) : (
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <KpiTile
                  label={t("admin.wreg.tile.employees")}
                  value={formatNumber(selectedRun.employee_count)}
                  hint={t("admin.wreg.tile.employeesHint", { run: selectedRun.run_number })}
                  to={`/admin/payroll/runs/${selectedRun.id}`}
                  drillLabel={t("admin.wreg.tile.drill", { run: selectedRun.run_number })}
                  explainer={{
                    formula: t("admin.wreg.tile.formula", { run: selectedRun.run_number }),
                    numbers: t("admin.wreg.tile.employeesNumbers", {
                      count: formatNumber(selectedRun.employee_count),
                    }),
                  }}
                />
                <KpiTile
                  label={t("admin.wreg.tile.gross")}
                  value={<Money paise={selectedRun.total_gross_paise} />}
                  hint={t("admin.wreg.tile.fromRun", { run: selectedRun.run_number })}
                  to={`/admin/payroll/runs/${selectedRun.id}`}
                  drillLabel={t("admin.wreg.tile.drill", { run: selectedRun.run_number })}
                />
                <KpiTile
                  label={t("admin.wreg.tile.deductions")}
                  value={<Money paise={selectedRun.total_deductions_paise} />}
                  hint={t("admin.wreg.tile.fromRun", { run: selectedRun.run_number })}
                  to={`/admin/payroll/runs/${selectedRun.id}`}
                  drillLabel={t("admin.wreg.tile.drill", { run: selectedRun.run_number })}
                />
                <KpiTile
                  label={t("admin.wreg.tile.net")}
                  value={<Money paise={selectedRun.total_net_paise} />}
                  hint={t("admin.wreg.tile.fromRun", { run: selectedRun.run_number })}
                  to={`/admin/payroll/runs/${selectedRun.id}`}
                  drillLabel={t("admin.wreg.tile.drill", { run: selectedRun.run_number })}
                />
                <KpiTile
                  label={t("admin.wreg.tile.employerCost")}
                  value={<Money paise={selectedRun.total_employer_cost_paise} />}
                  hint={t("admin.wreg.tile.fromRun", { run: selectedRun.run_number })}
                  to={`/admin/payroll/runs/${selectedRun.id}`}
                  drillLabel={t("admin.wreg.tile.drill", { run: selectedRun.run_number })}
                />
              </div>
            )}

            <div className="mt-4">
              <StateBoundary
                loading={runs.isPending}
                error={runs.error}
                onRetry={() => void runs.refetch()}
                skeletonRows={2}
              >
                <DataGrid
                  columns={runColumns}
                  rows={runs.data ?? []}
                  rowKey={(row) => row.id}
                  pageSize={10}
                  emptyState={
                    <EmptyState
                      icon={FileText}
                      title={t("admin.wreg.runs.empty.title")}
                      hint={t("admin.wreg.runs.empty.hint")}
                    />
                  }
                />
              </StateBoundary>
            </div>
          </section>

          <section>
            <h2 className="font-display text-lg font-semibold">
              {total.isSuccess
                ? t("admin.wreg.lines.headingCount", { n: formatNumber(total.data) })
                : t("admin.wreg.lines.heading")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("admin.wreg.lines.hint")}</p>

            {capped ? (
              <Notice tone="warning" className="mt-3">
                {t("admin.common.rowCap", { count: REGISTER_ROW_CAP })}
              </Notice>
            ) : null}

            <div className="mt-4">
              <StateBoundary
                loading={payslips.isPending}
                error={payslips.error}
                onRetry={() => void payslips.refetch()}
                isEmpty={rows.length === 0}
                partialError={labels.error ?? total.error}
                partialLabel={t("admin.wreg.partial")}
                empty={
                  <EmptyState
                    icon={FileText}
                    title={t("admin.wreg.empty.title")}
                    hint={t("admin.wreg.empty.hint")}
                  />
                }
                skeletonRows={6}
              >
                <DataGrid
                  columns={registerColumns}
                  rows={rows}
                  rowKey={(row) => row.id}
                  pageSize={50}
                />
              </StateBoundary>
            </div>
          </section>
        </>
      )}

      <p className="mt-6 text-xs text-muted-foreground">{t("admin.wreg.footnote")}</p>
    </div>
  );
}
