/**
 * §8 · /admin/payroll/payslips — every published payslip in the organisation,
 * with the run it came from, its net pay and its delivery / payment state.
 *
 * What makes this register trustworthy:
 *
 *  1. HEADER GRAIN, NOT LINE GRAIN. It reads the `payslips` table, one row per
 *     payslip. `v_payslip_detail` is one row PER LINE, so a register over it
 *     would repeat every net figure once per component and its count would count
 *     lines — the classic "8 payslips" that is really 96 rows.
 *  2. THE TOTAL IS POSTGRES'S. The header count is a `HEAD … count=exact` using
 *     the SAME filter array as the keyset page read, so it does not move as the
 *     operator loads more.
 *  3. NOTHING IS ADDED UP. `gross_earnings_paise`, `total_deductions_paise` and
 *     `net_pay_paise` are engine-written columns in integer paise, rendered by
 *     `<Money>`. Run-level and period-level totals belong to Payroll Runs and the
 *     Wage Register, which read them from `payroll_runs`.
 *  4. A REVERSED PAYSLIP SAYS SO. `is_reversed` rows stay in the register — a
 *     reversal is part of the audit trail, not something to filter out of sight —
 *     and are flagged so no one reads the amount as money that was paid.
 *
 * The employee's name and the run number are not columns of `payslips`; they are
 * resolved through the shared label maps (a join, not a computation), and an
 * unresolved id renders the honest "not on your list" line rather than a uuid.
 *
 * @route /admin/payroll/payslips
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatDaysFixed, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import {
  isPayslipPaymentStatus,
  payslipPaymentStatusValues,
  type PayslipHeader,
  type PayslipRegisterFilters,
} from "../api/payroll-masters.api";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import {
  useAdminPayPeriods,
  useAdminPayrollRuns,
  usePayPeriodMap,
} from "../hooks/useAdminPayroll";
import {
  PAYMENT_STATUS_CHIP,
  REGISTER_PAGE_SIZE,
  flattenPages,
  usePayslipCount,
  usePayslipRegister,
  useRunMap,
} from "../hooks/usePayrollMasters";

const REVERSED_CHIP = {
  reversed: { label: t("admin.slips.reversed"), tone: "danger" as const },
  live: { label: t("admin.slips.notReversed"), tone: "neutral" as const },
};

export default function PayslipRegisterPage() {
  const [params, setParams] = useSearchParams();

  const payPeriodId = params.get("period") ?? "";
  const runId = params.get("run") ?? "";
  const employeeId = params.get("employee") ?? "";
  const paymentStatus = params.get("status") ?? "";

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: false });
  }

  const periods = useAdminPayPeriods();
  const periodMap = usePayPeriodMap(periods.data);
  const runs = useAdminPayrollRuns(null);
  const runMap = useRunMap(runs.data);
  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);

  const filters = useMemo<PayslipRegisterFilters>(
    () => ({
      ...(payPeriodId !== "" ? { payPeriodId } : {}),
      ...(runId !== "" ? { runId } : {}),
      ...(employeeId !== "" ? { employeeId } : {}),
      ...(paymentStatus !== "" && isPayslipPaymentStatus(paymentStatus)
        ? { paymentStatuses: [paymentStatus] }
        : {}),
    }),
    [payPeriodId, runId, employeeId, paymentStatus],
  );

  const register = usePayslipRegister(filters);
  const total = usePayslipCount(filters);
  const rows = flattenPages(register.data);

  const hasAnyFilter =
    payPeriodId !== "" || runId !== "" || employeeId !== "" || paymentStatus !== "";

  function clearAll(): void {
    const next = new URLSearchParams(params);
    for (const name of ["period", "run", "employee", "status"]) next.delete(name);
    setParams(next, { replace: false });
  }

  const periodOptions = useMemo(
    () => (periods.data ?? []).map((period) => ({ value: period.id, label: period.name })),
    [periods.data],
  );

  // Runs of the chosen period only — offering a run from another month would
  // produce an empty register and look like missing data.
  const runOptions = useMemo(
    () =>
      (runs.data ?? [])
        .filter((run) => payPeriodId === "" || run.pay_period_id === payPeriodId)
        .map((run) => ({ value: run.id, label: run.run_number })),
    [runs.data, payPeriodId],
  );

  const statusOptions = useMemo(
    () =>
      payslipPaymentStatusValues.map((value) => ({
        value,
        label: PAYMENT_STATUS_CHIP[value].label,
      })),
    [],
  );

  const columns: DataGridColumn<PayslipHeader>[] = [
    {
      key: "employee",
      header: t("admin.slips.col.employee"),
      width: "15rem",
      sortable: true,
      sortValue: (row) => labels.data?.get(row.employee_id)?.name ?? "",
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
      header: t("admin.slips.col.number"),
      width: "12rem",
      sortable: true,
      render: (row) => <span className="num text-xs">{row.payslip_number}</span>,
    },
    {
      key: "period",
      header: t("admin.slips.col.period"),
      width: "13rem",
      render: (row) => {
        const period = periodMap.get(row.pay_period_id);
        return (
          <span className="flex flex-col leading-tight">
            <span>{period?.name ?? t("admin.slips.periodUnknown")}</span>
            <span className="num text-xs text-muted-foreground">
              {t("admin.common.dateRange", {
                from: fmtCivilDate(row.period_start),
                to: fmtCivilDate(row.period_end),
              })}
            </span>
          </span>
        );
      },
    },
    {
      key: "run",
      header: t("admin.slips.col.run"),
      width: "12rem",
      hideBelow: "md",
      render: (row) => {
        const run = runMap.get(row.payroll_run_id);
        if (run === undefined) {
          return <span className="text-xs text-muted-foreground">{t("admin.slips.runUnknown")}</span>;
        }
        return (
          <Link
            to={`/admin/payroll/runs/${run.id}`}
            className="num text-sm underline-offset-2 hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {run.run_number}
          </Link>
        );
      },
    },
    {
      key: "pay_date",
      header: t("admin.slips.col.payDate"),
      width: "10rem",
      align: "right",
      sortable: true,
      render: (row) => <span className="num">{fmtCivilDate(row.pay_date)}</span>,
    },
    {
      key: "paid_days",
      header: t("admin.slips.col.paidDays"),
      width: "10rem",
      align: "right",
      hideBelow: "lg",
      // §9.2: SUM(day_fraction_paid), stamped by the engine. Never derived here.
      render: (row) => (
        <span className="num">
          {t("admin.slips.paidDaysOf", {
            paid: formatDaysFixed(row.paid_days),
            total: formatNumber(row.period_days),
          })}
        </span>
      ),
    },
    {
      key: "gross_earnings_paise",
      header: t("admin.slips.col.gross"),
      width: "11rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <Money paise={row.gross_earnings_paise} />,
    },
    {
      key: "total_deductions_paise",
      header: t("admin.slips.col.deductions"),
      width: "11rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <Money paise={row.total_deductions_paise} />,
    },
    {
      key: "net_pay_paise",
      header: t("admin.slips.col.net"),
      width: "12rem",
      align: "right",
      sortable: true,
      render: (row) => <Money paise={row.net_pay_paise} className="font-semibold" />,
    },
    {
      key: "payment_status",
      header: t("admin.slips.col.paymentStatus"),
      width: "11rem",
      render: (row) => <StatusChip status={row.payment_status} map={PAYMENT_STATUS_CHIP} />,
    },
    {
      key: "paid_on",
      header: t("admin.slips.col.paidOn"),
      width: "10rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{dash(row.paid_on, fmtCivilDate)}</span>,
    },
    {
      key: "payment_reference",
      header: t("admin.slips.col.reference"),
      width: "12rem",
      hideBelow: "lg",
      render: (row) => <span className="num text-xs">{dash(row.payment_reference)}</span>,
    },
    {
      key: "emailed_at",
      header: t("admin.slips.col.delivered"),
      width: "12rem",
      hideBelow: "lg",
      render: (row) => (
        <span className="flex flex-col leading-tight text-xs">
          <span>{dash(row.emailed_at, fmtDateTime)}</span>
          <span className="text-muted-foreground">
            {row.viewed_at === null
              ? t("admin.slips.notViewed")
              : t("admin.slips.viewedAt", { at: fmtDateTime(row.viewed_at) })}
          </span>
        </span>
      ),
    },
    {
      key: "is_reversed",
      header: t("admin.slips.col.reversal"),
      width: "9rem",
      render: (row) =>
        row.is_reversed ? <StatusChip status="reversed" map={REVERSED_CHIP} /> : dash(null),
    },
  ];

  const subtitle = total.isSuccess
    ? t("admin.slips.subtitle.count", { n: formatNumber(total.data) })
    : t("admin.slips.subtitle");

  return (
    <div className="container py-6">
      <PageHeader icon={FileText} title={t("admin.slips.title")} subtitle={subtitle} />

      <Notice tone="info" className="mb-4">
        {t("admin.slips.scopeNotice")}
      </Notice>

      <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.slips.filter.period")}
          value={payPeriodId}
          options={periodOptions}
          placeholder={t("admin.slips.filter.allPeriods")}
          onChange={(value) => setParam("period", value)}
          disabled={periods.isLoading}
        />
        <SelectField
          label={t("admin.slips.filter.run")}
          value={runId}
          options={runOptions}
          placeholder={t("admin.slips.filter.allRuns")}
          onChange={(value) => setParam("run", value)}
          disabled={runs.isLoading}
          {...(payPeriodId === "" ? { hint: t("admin.slips.filter.runHint") } : {})}
        />
        <SelectField
          label={t("admin.common.filter.employee")}
          value={employeeId}
          options={employeeChoices}
          placeholder={t("admin.common.filter.allEmployees")}
          onChange={(value) => setParam("employee", value)}
          disabled={labels.isLoading}
        />
        <SelectField
          label={t("admin.slips.filter.status")}
          value={paymentStatus}
          options={statusOptions}
          placeholder={t("admin.slips.filter.allStatuses")}
          onChange={(value) => setParam("status", value)}
        />
        {hasAnyFilter ? (
          <div className="flex items-end">
            <Button type="button" variant="ghost" onClick={clearAll}>
              {t("admin.slips.filter.clearAll")}
            </Button>
          </div>
        ) : null}
      </div>

      <StateBoundary
        loading={register.isPending}
        error={register.error}
        onRetry={() => void register.refetch()}
        isEmpty={rows.length === 0}
        partialError={labels.error ?? periods.error ?? runs.error ?? total.error}
        partialLabel={t("admin.slips.partial")}
        empty={
          hasAnyFilter ? (
            <EmptyState
              icon={FileText}
              title={t("admin.slips.empty.filtered.title")}
              hint={t("admin.slips.empty.filtered.hint")}
              action={
                <Button variant="outline" onClick={clearAll}>
                  {t("admin.slips.filter.clearAll")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={FileText}
              title={t("admin.slips.empty.title")}
              hint={t("admin.slips.empty.hint")}
            />
          )
        }
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={REGISTER_PAGE_SIZE}
        />

        {register.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              onClick={() => void register.fetchNextPage()}
              disabled={register.isFetchingNextPage}
            >
              {register.isFetchingNextPage
                ? t("admin.slips.loadingMore")
                : t("admin.slips.loadMore")}
            </Button>
          </div>
        ) : null}
      </StateBoundary>

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.slips.footnote")}</p>
    </div>
  );
}
