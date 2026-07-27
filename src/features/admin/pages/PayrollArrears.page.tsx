/**
 * §8 · /admin/payroll/arrears — Arrears & Reversals. Retrospective corrections,
 * fully traced.
 *
 * RECON: arrears ARE modelled, in three deployed places, and this screen is built
 * from exactly those:
 *
 *   1. `payroll_runs.run_kind` ∈ {regular, off_cycle, arrears, bonus,
 *      full_and_final, correction}. A closed run is immutable —
 *      `trg_payroll_runs__immutable` raises "payroll run % is closed and
 *      immutable; corrections require an arrears run" — so an `arrears` or
 *      `correction` run IS the correction mechanism. The screen lists those runs
 *      rather than offering to edit a closed one.
 *   2. `payslip_lines.is_arrear` with `arrear_for_period_id` naming the period
 *      being corrected, and `calc_basis` recording what the engine applied. That
 *      is the trace, at line grain, read through `v_payslip_detail`.
 *   3. `payslips.is_reversed` / `reversed_by_payslip_id` — a published payslip is
 *      never edited; it is reversed and reissued, and the pair of ids is the
 *      evidence.
 *
 * There is NO write here: `payslips` grants SELECT only to `authenticated`, no
 * deployed RPC or edge function reverses a payslip or opens an arrears run for a
 * chosen period, and `payroll-run` computes a run that already exists. Creating an
 * arrears run belongs to the runs screen (which pins the statutory version and the
 * attendance lock); reversal has no client path at all, and the screen says so
 * instead of showing a button that would fail.
 *
 * Every amount is a server column in integer paise. Nothing is netted off here:
 * an arrear line and its reversal are shown as the two rows they are.
 *
 * @route /admin/payroll/arrears
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Banknote, Undo2 } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { Money } from "@/shared/ui/Money";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, type SelectOption } from "../components/Field";
import { CountTile } from "../components/CountTile";
import { PAYROLL_RUN_CHIP } from "../display";
import { useAdminPayPeriods, usePayPeriodMap } from "../hooks/useAdminPayroll";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  useArrearLineCount,
  useArrearLines,
  useArrearsRuns,
  useReversedPayslipCount,
  useReversedPayslips,
} from "../hooks/usePayrollStatutory";
import {
  LINE_ROW_CAP,
  type PayslipPayment,
} from "../api/payroll-statutory.api";
import type { PayrollRun, PayslipLine } from "../api/payroll.api";

const PAYMENT_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pending: { label: t("admin.arrears.pay.pending"), tone: "warn" },
  in_batch: { label: t("admin.arrears.pay.inBatch"), tone: "info" },
  paid: { label: t("admin.arrears.pay.paid"), tone: "success" },
  failed: { label: t("admin.arrears.pay.failed"), tone: "danger" },
  held: { label: t("admin.arrears.pay.held"), tone: "warn" },
  reversed: { label: t("admin.arrears.pay.reversed"), tone: "neutral" },
};

function runOptions(runs: readonly PayrollRun[] | undefined): SelectOption[] {
  return (runs ?? []).map((run) => ({
    value: run.id,
    label: `${run.run_number} · ${PAYROLL_RUN_CHIP[run.status].label}`,
  }));
}

export default function PayrollArrearsPage() {
  const [params, setParams] = useSearchParams();
  const runParam = params.get("run") ?? "";
  const runId = runParam === "" ? null : runParam;

  const arrearsRuns = useArrearsRuns();
  const lines = useArrearLines(runId);
  const lineRows = useMemo(() => lines.data ?? [], [lines.data]);
  const lineCount = useArrearLineCount(runId);
  const reversed = useReversedPayslips(runId);
  const reversedCount = useReversedPayslipCount(runId);
  const periods = useAdminPayPeriods();
  const periodMap = usePayPeriodMap(periods.data);
  const labels = useEmployeeLabels();
  const labelMap = labels.data;

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const runColumns: DataGridColumn<PayrollRun>[] = useMemo(
    () => [
      {
        key: "run_number",
        header: t("admin.arrears.col.run"),
        width: "12rem",
        sortable: true,
        render: (row) => <span className="num font-medium">{row.run_number}</span>,
      },
      {
        key: "run_kind",
        header: t("admin.arrears.col.kind"),
        width: "11rem",
        render: (row) => (
          <span className="text-xs">
            {row.run_kind === "arrears"
              ? t("admin.arrears.kind.arrears")
              : row.run_kind === "correction"
                ? t("admin.arrears.kind.correction")
                : dash(row.run_kind)}
          </span>
        ),
      },
      {
        key: "status",
        header: t("admin.arrears.col.status"),
        width: "12rem",
        render: (row) => <StatusChip status={row.status} map={PAYROLL_RUN_CHIP} />,
      },
      {
        key: "period",
        header: t("admin.arrears.col.period"),
        width: "14rem",
        hideBelow: "md",
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
        key: "employee_count",
        header: t("admin.arrears.col.employees"),
        width: "9rem",
        align: "right",
        render: (row) => <span className="num">{formatNumber(row.employee_count)}</span>,
      },
      {
        key: "total_net_paise",
        header: t("admin.arrears.col.net"),
        width: "12rem",
        align: "right",
        sortable: true,
        render: (row) => <Money paise={row.total_net_paise} className="font-semibold" />,
      },
      {
        key: "computed_at",
        header: t("admin.arrears.col.computed"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => dash(row.computed_at, fmtDateTime),
      },
    ],
    [periodMap],
  );

  const lineColumns: DataGridColumn<PayslipLine>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.arrears.col.employee"),
        width: "16rem",
        render: (row) => (
          <PersonCell
            name={row.display_name}
            code={row.employee_code}
            secondary={row.department_name}
          />
        ),
      },
      {
        key: "label",
        header: t("admin.arrears.col.component"),
        width: "14rem",
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span>{dash(row.label)}</span>
            <span className="num text-xs text-muted-foreground">{dash(row.component_code)}</span>
          </span>
        ),
      },
      {
        key: "arrear_for_period_id",
        header: t("admin.arrears.col.forPeriod"),
        width: "13rem",
        render: (row) => {
          if (row.arrear_for_period_id === null) return dash(null);
          const period = periodMap.get(row.arrear_for_period_id);
          return <span>{period === undefined ? dash(null) : period.name}</span>;
        },
      },
      {
        key: "run_number",
        header: t("admin.arrears.col.paidIn"),
        width: "11rem",
        hideBelow: "md",
        render: (row) => <span className="num">{row.run_number}</span>,
      },
      {
        key: "amount_paise",
        header: t("admin.arrears.col.amount"),
        width: "12rem",
        align: "right",
        sortable: true,
        render: (row) => <Money paise={row.amount_paise} className="font-medium" />,
      },
      {
        key: "full_month_amount_paise",
        header: t("admin.arrears.col.fullMonth"),
        width: "12rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <Money paise={row.full_month_amount_paise} />,
      },
      {
        key: "period_start",
        header: t("admin.arrears.col.slipPeriod"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => (
          <span className="num text-xs">
            {t("admin.common.dateRange", {
              from: fmtCivilDate(row.period_start),
              to: fmtCivilDate(row.period_end),
            })}
          </span>
        ),
      },
    ],
    [periodMap],
  );

  const reversedColumns: DataGridColumn<PayslipPayment>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.arrears.col.employee"),
        width: "16rem",
        render: (row) => {
          const who = labelMap?.get(row.employee_id);
          return (
            <PersonCell
              name={who?.name ?? null}
              code={who?.code ?? null}
              secondary={who?.department ?? null}
            />
          );
        },
      },
      {
        key: "payslip_number",
        header: t("admin.arrears.col.payslip"),
        width: "13rem",
        render: (row) => <span className="num">{row.payslip_number}</span>,
      },
      {
        key: "pay_date",
        header: t("admin.arrears.col.payDate"),
        width: "11rem",
        render: (row) => <span className="num">{fmtCivilDate(row.pay_date)}</span>,
      },
      {
        key: "net_pay_paise",
        header: t("admin.arrears.col.net"),
        width: "12rem",
        align: "right",
        render: (row) => <Money paise={row.net_pay_paise} />,
      },
      {
        key: "payment_status",
        header: t("admin.arrears.col.paymentStatus"),
        width: "11rem",
        render: (row) => <StatusChip status={row.payment_status} map={PAYMENT_CHIP} />,
      },
      {
        key: "reversed_by_payslip_id",
        header: t("admin.arrears.col.reissued"),
        width: "13rem",
        hideBelow: "md",
        render: (row) =>
          row.reversed_by_payslip_id === null ? (
            <span className="text-xs text-warning">{t("admin.arrears.noReissue")}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{t("admin.arrears.reissued")}</span>
          ),
      },
    ],
    [labelMap],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Banknote}
        title={t("admin.arrears.title")}
        subtitle={t("admin.arrears.subtitle")}
      />

      <Notice tone="info" className="mb-4">
        {t("admin.arrears.immutable")}
      </Notice>

      <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <SelectField
          label={t("admin.arrears.filter.run")}
          value={runParam}
          options={runOptions(arrearsRuns.data)}
          placeholder={t("admin.arrears.filter.allRuns")}
          hint={t("admin.arrears.filter.hint")}
          onChange={(value) => setParam("run", value)}
        />
        <div className="flex items-end">
          <p className="text-sm text-muted-foreground">{t("admin.arrears.filter.note")}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <CountTile
          label={t("admin.arrears.tile.lines")}
          hint={t("admin.arrears.tile.linesHint")}
          to={`/admin/payroll/arrears${runId !== null ? `?run=${encodeURIComponent(runId)}` : ""}`}
          drillLabel={t("admin.arrears.tile.lines")}
          source={t("admin.arrears.source.lines")}
          query={lineCount}
        />
        <CountTile
          label={t("admin.arrears.tile.reversed")}
          hint={t("admin.arrears.tile.reversedHint")}
          to={`/admin/payroll/arrears${runId !== null ? `?run=${encodeURIComponent(runId)}` : ""}`}
          drillLabel={t("admin.arrears.tile.reversed")}
          source={t("admin.arrears.source.payslips")}
          query={reversedCount}
        />
      </div>

      <section className="mt-6">
        <h2 className="mb-2 font-display text-lg font-semibold">{t("admin.arrears.runs.title")}</h2>
        <StateBoundary
          loading={arrearsRuns.isPending}
          error={arrearsRuns.error}
          onRetry={() => void arrearsRuns.refetch()}
          partialError={periods.error}
          partialLabel={t("admin.arrears.partial.periods")}
          isEmpty={(arrearsRuns.data ?? []).length === 0}
          empty={
            <EmptyState
              icon={Undo2}
              title={t("admin.arrears.runs.empty.title")}
              hint={t("admin.arrears.runs.empty.hint")}
            />
          }
          skeletonRows={3}
        >
          <DataGrid
            columns={runColumns}
            rows={arrearsRuns.data ?? []}
            rowKey={(row) => row.id}
            pageSize={25}
            onRowClick={(row) => setParam("run", row.id)}
          />
        </StateBoundary>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 font-display text-lg font-semibold">
          {t("admin.arrears.lines.title")}
        </h2>
        <p className="mb-2 text-sm text-muted-foreground">{t("admin.arrears.lines.hint")}</p>
        <StateBoundary
          loading={lines.isPending}
          error={lines.error}
          onRetry={() => void lines.refetch()}
          partialError={periods.error}
          partialLabel={t("admin.arrears.partial.periods")}
          isEmpty={lineRows.length === 0}
          empty={
            <EmptyState
              icon={Undo2}
              title={t("admin.arrears.lines.empty.title")}
              hint={
                runId !== null
                  ? t("admin.arrears.lines.empty.filtered")
                  : t("admin.arrears.lines.empty.hint")
              }
            />
          }
          skeletonRows={4}
        >
          <DataGrid
            columns={lineColumns}
            rows={lineRows}
            rowKey={(row) => row.line_id ?? `${row.payslip_id}:${row.sequence ?? 0}`}
            pageSize={50}
          />
          {lineRows.length >= LINE_ROW_CAP ? (
            <div className="mt-3">
              <Notice tone="warning">
                {t("admin.common.rowCap", { count: formatNumber(LINE_ROW_CAP) })}
              </Notice>
            </div>
          ) : null}
        </StateBoundary>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 font-display text-lg font-semibold">
          {t("admin.arrears.reversals.title")}
        </h2>
        <StateBoundary
          loading={reversed.isPending}
          error={reversed.error}
          onRetry={() => void reversed.refetch()}
          partialError={labels.error}
          partialLabel={t("admin.common.partial.names")}
          isEmpty={(reversed.data ?? []).length === 0}
          empty={
            <EmptyState
              icon={Undo2}
              title={t("admin.arrears.reversals.empty.title")}
              hint={t("admin.arrears.reversals.empty.hint")}
            />
          }
          skeletonRows={3}
        >
          <DataGrid
            columns={reversedColumns}
            rows={reversed.data ?? []}
            rowKey={(row) => row.id}
            pageSize={25}
          />
        </StateBoundary>
      </section>

      <div className="mt-6">
        <Notice tone="warning">{t("admin.arrears.gap.noWritePath")}</Notice>
      </div>
    </div>
  );
}
