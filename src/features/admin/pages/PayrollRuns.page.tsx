/**
 * /admin/payroll/runs — every payroll run and where it is in the lifecycle
 * (spec-admin §8.5: draft → inputs_locked → computed → in_review → approved →
 * disbursement_pending → paid → closed, plus cancelled/failed).
 *
 * The status column is a chip from PAYROLL_RUN_CHIP, never the enum — `in_review`
 * and `disbursement_pending` are internal words (DR-53). Money is integer paise
 * rendered by `<Money>` in en-IN (DR-20); `variance_vs_previous_pct` is printed
 * exactly as the server computed it and is NOT clamped: a first run legitimately
 * varies by more than 100%, and clamping a growth rate would be the mirror image
 * of the `1,700.00%` defect (DR-28 clamps SHARES, not growth).
 *
 * There is no "create run" button here. Creating a run pins a statutory settings
 * version and an attendance lock; that ceremony belongs to the run detail and its
 * gates, not to a list toolbar.
 *
 * @route /admin/payroll/runs
 */
import { useMemo } from "react";
import { Banknote } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import {
  payrollRunStatusValues,
  type PayrollRun,
  type PayrollRunStatus,
} from "../api/payroll.api";
import { PAYROLL_RUN_CHIP, isVarianceFlagged } from "../display";
import { Notice } from "../components/Notice";
import { SelectField, type SelectOption } from "../components/Field";
import {
  useAdminPayPeriods,
  useAdminPayrollRuns,
  usePayPeriodMap,
} from "../hooks/useAdminPayroll";

function statusChoices(): SelectOption[] {
  return payrollRunStatusValues.map((status) => ({
    value: status,
    label: PAYROLL_RUN_CHIP[status].label,
  }));
}

function isRunStatus(value: string): value is PayrollRunStatus {
  return (payrollRunStatusValues as readonly string[]).includes(value);
}

export default function AdminPayrollRunsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const statusParam = params.get("status");
  const statuses = statusParam !== null && isRunStatus(statusParam) ? [statusParam] : null;

  const runs = useAdminPayrollRuns(statuses);
  const periods = useAdminPayPeriods();
  const periodMap = usePayPeriodMap(periods.data);

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: false });
  }

  const columns: DataGridColumn<PayrollRun>[] = useMemo(
    () => [
      {
        key: "run_number",
        header: t("admin.runs.col.run"),
        width: "11rem",
        sortable: true,
        render: (row) => <span className="num font-medium">{row.run_number}</span>,
      },
      {
        key: "period",
        header: t("admin.runs.col.period"),
        width: "15rem",
        render: (row) => {
          const period = periodMap.get(row.pay_period_id);
          if (period === undefined) return dash(null);
          return (
            <span className="flex flex-col leading-tight">
              <span>{period.name}</span>
              <span className="num text-xs text-muted-foreground">
                {t("admin.common.dateRange", {
                  from: fmtCivilDate(period.start_date),
                  to: fmtCivilDate(period.end_date),
                })}
              </span>
            </span>
          );
        },
      },
      {
        key: "status",
        header: t("admin.runs.col.status"),
        width: "12rem",
        render: (row) => <StatusChip status={row.status} map={PAYROLL_RUN_CHIP} />,
      },
      {
        key: "employee_count",
        header: t("admin.runs.col.employees"),
        width: "8rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.employee_count)}</span>,
      },
      {
        key: "total_gross_paise",
        header: t("admin.runs.col.gross"),
        width: "11rem",
        align: "right",
        hideBelow: "md",
        render: (row) => <Money paise={row.total_gross_paise} />,
      },
      {
        key: "total_deductions_paise",
        header: t("admin.runs.col.deductions"),
        width: "11rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <Money paise={row.total_deductions_paise} />,
      },
      {
        key: "total_net_paise",
        header: t("admin.runs.col.net"),
        width: "11rem",
        align: "right",
        sortable: true,
        render: (row) => <Money paise={row.total_net_paise} className="font-semibold" />,
      },
      {
        key: "variance_vs_previous_pct",
        header: t("admin.runs.col.variance"),
        width: "9rem",
        align: "right",
        hideBelow: "md",
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
      {
        key: "exception_count",
        header: t("admin.runs.col.exceptions"),
        width: "9rem",
        align: "right",
        hideBelow: "lg",
        render: (row) =>
          row.exception_count > 0 ? (
            <span className="num text-warning">{formatNumber(row.exception_count)}</span>
          ) : (
            <span className="num">0</span>
          ),
      },
      {
        key: "open",
        header: t("admin.runs.col.open"),
        width: "7rem",
        align: "right",
        render: (row) => (
          <span onClick={(event) => event.stopPropagation()}>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/admin/payroll/runs/${row.id}`}>{t("admin.runs.open")}</Link>
            </Button>
          </span>
        ),
      },
      {
        key: "computed_at",
        header: t("admin.runs.col.computed"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => dash(row.computed_at, fmtDateTime),
      },
      {
        key: "approved_at",
        header: t("admin.runs.col.approved"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => dash(row.approved_at, fmtDateTime),
      },
    ],
    [periodMap],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Banknote}
        title={t("admin.runs.title")}
        subtitle={t("admin.runs.subtitle")}
      />

      <Notice tone="info" className="mb-4">
        {t("admin.runs.lifecycle")}
      </Notice>

      <StateBoundary
        loading={runs.isLoading}
        error={runs.error ?? undefined}
        onRetry={() => void runs.refetch()}
        partialError={periods.error ?? undefined}
        partialLabel={t("admin.runs.partial")}
        skeletonRows={5}
      >
        <DataGrid
          columns={columns}
          rows={runs.data ?? []}
          rowKey={(row) => row.id}
          pageSize={25}
          onRowClick={(row) => navigate(`/admin/payroll/runs/${row.id}`)}
          toolbar={
            <div className="grid w-full gap-3 sm:max-w-sm">
              <SelectField
                label={t("admin.runs.filter.status")}
                value={statusParam ?? ""}
                options={statusChoices()}
                placeholder={t("admin.runs.filter.allStatuses")}
                onChange={(value) => setParam("status", value)}
              />
            </div>
          }
          emptyState={
            <EmptyState
              icon={Banknote}
              title={t("admin.runs.empty.title")}
              hint={
                statusParam !== null ? t("admin.runs.empty.filtered") : t("admin.runs.empty.hint")
              }
            />
          }
        />
      </StateBoundary>
    </div>
  );
}
