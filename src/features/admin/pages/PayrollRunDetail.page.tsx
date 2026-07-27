/**
 * /admin/payroll/runs/:id — one payroll run: its totals, who is in it, what moved
 * since last month, and the two-person approve/publish ceremony.
 *
 * Every figure on this page is a server column:
 *   * totals and counts from `payroll_runs` (the engine writes them),
 *   * per-employee state from `payroll_run_employees`,
 *   * `variance_paise` / `variance_pct` from `v_payroll_variance`, which pairs each
 *     payslip with the employee's PREVIOUS payslip in SQL.
 * Nothing on this screen adds two amounts together. That is what makes the summary
 * tiles and the variance grid incapable of disagreeing (DR-29/DR-32).
 *
 * `variance_pct` is NULL when there is no previous payslip — printed as "—", never
 * as 0% and never as ∞ (DR-31/DR-28).
 *
 * Sections rather than tabs: spec-admin §8.5 lists nine detail tabs, but hidden
 * tab state is not addressable and the register/bank-advice/statutory tabs are
 * separate routes in the manifest already. What lives here is what this run's
 * approver has to see before deciding.
 *
 * @route /admin/payroll/runs/:id
 */
import { useMemo, useState } from "react";
import { Banknote, Users } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { formatPaise } from "@/lib/money";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import type { VarianceRow } from "../api/payroll.api";
import type { RunEmployee } from "../api/payroll-detail.api";
import { PAYROLL_RUN_CHIP, RUN_EMPLOYEE_CHIP, isVarianceFlagged } from "../display";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { RunActionsCard } from "../components/RunActionsCard";
import { SelectField } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  useAdminPayPeriods,
  useAdminPayrollRun,
  useAnnotateRun,
  useProfilePeople,
  useRunEmployees,
  useRunVariance,
  usePayPeriodMap,
} from "../hooks/useAdminPayroll";
import { useReasonPrompt } from "../hooks/useReasonPrompt";

/** The two states that stop gate 4 (022: `pre.status = 'error'` blocks approval). */
const BLOCKING_EMPLOYEE_STATUSES: readonly string[] = ["error", "held"];

export default function AdminPayrollRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const runId = id ?? "";
  const { user, employee } = useAuth();
  const myProfileId = user?.id ?? null;

  const run = useAdminPayrollRun(runId);
  const periods = useAdminPayPeriods();
  const periodMap = usePayPeriodMap(periods.data);
  const people = useProfilePeople();
  const labels = useEmployeeLabels();
  const runEmployees = useRunEmployees(runId);

  const [grain, setGrain] = useState<"net_pay" | "component">("net_pay");
  const variance = useRunVariance(runId, grain);

  const [notes, setNotes] = useState<string | null>(null);
  const [noteSaved, setNoteSaved] = useState(false);
  const notePrompt = useReasonPrompt<{ notes: string }>();
  const annotate = useAnnotateRun(() => {
    notePrompt.close();
    setNoteSaved(true);
  });

  const runRow = run.data ?? null;
  const periodRow = runRow === null ? undefined : periodMap.get(runRow.pay_period_id);

  const blockingCount = useMemo(
    () =>
      (runEmployees.data ?? []).filter((row) =>
        BLOCKING_EMPLOYEE_STATUSES.includes(row.status),
      ).length,
    [runEmployees.data],
  );

  const employeeColumns: DataGridColumn<RunEmployee>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.run.emp.col.employee"),
        width: "16rem",
        sortable: true,
        sortValue: (row) => labels.data?.get(row.employee_id)?.name ?? "",
        render: (row) => {
          const label = labels.data?.get(row.employee_id);
          return (
            <PersonCell
              name={label?.name ?? null}
              code={label?.code ?? null}
              secondary={label?.designation ?? null}
            />
          );
        },
      },
      {
        key: "status",
        header: t("admin.run.emp.col.status"),
        width: "10rem",
        render: (row) => <StatusChip status={row.status} map={RUN_EMPLOYEE_CHIP} />,
      },
      {
        key: "why",
        header: t("admin.run.emp.col.why"),
        width: "22rem",
        render: (row) =>
          dash(row.error_detail ?? row.hold_reason ?? row.exclusion_reason ?? null),
      },
      {
        key: "computed_at",
        header: t("admin.run.emp.col.computed"),
        width: "12rem",
        hideBelow: "md",
        render: (row) => dash(row.computed_at, fmtDateTime),
      },
      {
        key: "retry_count",
        header: t("admin.run.emp.col.retries"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{row.retry_count}</span>,
      },
    ],
    [labels.data],
  );

  const varianceColumns: DataGridColumn<VarianceRow>[] = useMemo(() => {
    const base: DataGridColumn<VarianceRow>[] = [
      {
        key: "employee",
        header: t("admin.run.var.col.employee"),
        width: "15rem",
        sortable: true,
        sortValue: (row) => row.display_name ?? "",
        render: (row) => <PersonCell name={row.display_name} code={row.employee_code} />,
      },
    ];
    if (grain === "component") {
      base.push({
        key: "label",
        header: t("admin.run.var.col.component"),
        width: "13rem",
        render: (row) => dash(row.label),
      });
    }
    base.push(
      {
        key: "current_amount_paise",
        header: t("admin.run.var.col.current"),
        width: "11rem",
        align: "right",
        sortable: true,
        render: (row) => <Money paise={row.current_amount_paise} />,
      },
      {
        key: "previous_amount_paise",
        header: t("admin.run.var.col.previous"),
        width: "11rem",
        align: "right",
        render: (row) =>
          row.previous_amount_paise === null ? (
            <span className="text-muted-foreground">{t("admin.run.var.noPrevious")}</span>
          ) : (
            <Money paise={row.previous_amount_paise} />
          ),
      },
      {
        key: "variance_paise",
        header: t("admin.run.var.col.change"),
        width: "11rem",
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
        header: t("admin.run.var.col.pct"),
        width: "9rem",
        align: "right",
        sortable: true,
        render: (row) => {
          if (row.variance_pct === null) return dash(null);
          const text = formatPercent(row.variance_pct);
          return isVarianceFlagged(row.variance_pct) ? (
            <span className="num font-semibold text-warning">{text}</span>
          ) : (
            <span className="num">{text}</span>
          );
        },
      },
    );
    return base;
  }, [grain]);

  const flaggedCount = useMemo(
    () => (variance.data ?? []).filter((row) => isVarianceFlagged(row.variance_pct)).length,
    [variance.data],
  );

  // No run row: either it does not exist or RLS withheld it. Both are honest
  // walls, never an empty summary with zeroes in it.
  if (run.isSuccess && runRow === null) {
    return (
      <div className="container py-6">
        <PageHeader
          icon={Banknote}
          title={t("admin.run.title")}
          subtitle={t("admin.run.subtitle")}
        />
        <EmptyState
          icon={Banknote}
          title={t("admin.run.missing.title")}
          hint={t("admin.run.missing.hint")}
          action={
            <Button variant="outline" asChild>
              <Link to="/admin/payroll/runs">{t("admin.run.backToRuns")}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={Banknote}
        title={
          runRow === null
            ? t("admin.run.title")
            : t("admin.run.titleWithNumber", { number: runRow.run_number })
        }
        subtitle={t("admin.run.subtitle")}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/payroll/runs">{t("admin.run.backToRuns")}</Link>
          </Button>
        }
      />

      <StateBoundary
        loading={run.isLoading}
        error={run.error ?? undefined}
        onRetry={() => void run.refetch()}
        partialError={periods.error ?? undefined}
        partialLabel={t("admin.run.partial.period")}
        skeletonRows={3}
      >
        {runRow !== null ? (
          <>
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <StatusChip status={runRow.status} map={PAYROLL_RUN_CHIP} />
              <span className="text-sm text-muted-foreground">
                {periodRow === undefined
                  ? t("admin.run.periodUnknown")
                  : t("admin.run.periodLine", {
                      name: periodRow.name,
                      from: fmtCivilDate(periodRow.start_date),
                      to: fmtCivilDate(periodRow.end_date),
                    })}
              </span>
              {periodRow?.pay_date != null ? (
                <span className="text-sm text-muted-foreground">
                  {t("admin.run.payDate", { date: fmtCivilDate(periodRow.pay_date) })}
                </span>
              ) : null}
            </div>

            <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <KpiTile
                label={t("admin.run.kpi.employees")}
                value={formatNumber(runRow.employee_count)}
                hint={t("admin.run.kpi.employeesHint")}
              />
              <KpiTile
                label={t("admin.run.kpi.gross")}
                value={<Money paise={runRow.total_gross_paise} />}
              />
              <KpiTile
                label={t("admin.run.kpi.deductions")}
                value={<Money paise={runRow.total_deductions_paise} />}
              />
              <KpiTile
                label={t("admin.run.kpi.net")}
                value={<Money paise={runRow.total_net_paise} />}
                hint={t("admin.run.kpi.netHint")}
              />
              <KpiTile
                label={t("admin.run.kpi.employerCost")}
                value={<Money paise={runRow.total_employer_cost_paise} />}
              />
              <KpiTile
                label={t("admin.run.kpi.variance")}
                value={
                  runRow.variance_vs_previous_pct === null
                    ? t("common.empty")
                    : formatPercent(runRow.variance_vs_previous_pct)
                }
                tone={isVarianceFlagged(runRow.variance_vs_previous_pct) ? "warn" : "neutral"}
                explainer={{
                  formula: t("admin.run.kpi.varianceFormula"),
                  numbers:
                    runRow.variance_vs_previous_pct === null
                      ? t("admin.run.kpi.varianceNoPrevious")
                      : t("admin.run.kpi.varianceNumbers", {
                          pct: formatPercent(runRow.variance_vs_previous_pct),
                          net: formatPaise(runRow.total_net_paise),
                        }),
                }}
              />
            </section>

            <div className="mb-8">
              <RunActionsCard
                run={runRow}
                preparerName={
                  runRow.computed_by === null
                    ? null
                    : people.data?.get(runRow.computed_by)?.display_name ?? null
                }
                reviewerName={
                  runRow.reviewed_by === null
                    ? null
                    : people.data?.get(runRow.reviewed_by)?.display_name ?? null
                }
                approverName={
                  runRow.approved_by === null
                    ? null
                    : people.data?.get(runRow.approved_by)?.display_name ?? null
                }
                myProfileId={myProfileId}
                actorName={employee?.displayName ?? null}
                blockingCount={blockingCount}
                blockersUnknown={runEmployees.isLoading}
              />
            </div>

            {/* Gate 3: out-of-band variance has to be annotated before review passes. */}
            <section className="mb-8 rounded-lg border bg-card p-5">
              <h2 className="font-display text-lg font-semibold">
                {t("admin.run.notes.heading")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("admin.run.notes.hint")}</p>
              {noteSaved ? (
                <Notice tone="success" className="mt-3">
                  {t("admin.run.notes.saved")}
                </Notice>
              ) : null}
              <textarea
                rows={3}
                value={notes ?? runRow.notes ?? ""}
                onChange={(event) => {
                  setNotes(event.target.value);
                  setNoteSaved(false);
                }}
                className="mt-3 flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder={t("admin.run.notes.placeholder")}
                aria-label={t("admin.run.notes.heading")}
              />
              <Button
                variant="outline"
                className="mt-3"
                disabled={annotate.isPending || notes === null || notes === (runRow.notes ?? "")}
                onClick={() => {
                  if (notes === null) return;
                  annotate.reset();
                  notePrompt.ask({ notes });
                }}
              >
                {annotate.isPending
                  ? t("admin.run.notes.saving")
                  : t("admin.run.notes.save")}
              </Button>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 font-display text-lg font-semibold">
                {t("admin.run.emp.heading")}
              </h2>
              <StateBoundary
                loading={runEmployees.isLoading}
                error={runEmployees.error ?? undefined}
                onRetry={() => void runEmployees.refetch()}
                partialError={labels.error ?? undefined}
                partialLabel={t("admin.common.partial.names")}
                skeletonRows={5}
              >
                {blockingCount > 0 ? (
                  <Notice tone="warning" className="mb-3">
                    {t("admin.run.emp.blocking", { count: blockingCount })}
                  </Notice>
                ) : null}
                <DataGrid
                  columns={employeeColumns}
                  rows={runEmployees.data ?? []}
                  rowKey={(row) => row.id}
                  pageSize={25}
                  emptyState={
                    <EmptyState
                      icon={Users}
                      title={t("admin.run.emp.empty.title")}
                      hint={t("admin.run.emp.empty.hint")}
                    />
                  }
                />
              </StateBoundary>
            </section>

            <section>
              <h2 className="mb-3 font-display text-lg font-semibold">
                {t("admin.run.var.heading")}
              </h2>
              <StateBoundary
                loading={variance.isLoading}
                error={variance.error ?? undefined}
                onRetry={() => void variance.refetch()}
                skeletonRows={5}
              >
                {flaggedCount > 0 ? (
                  <Notice tone="warning" className="mb-3">
                    {t("admin.run.var.flagged", { count: flaggedCount })}
                  </Notice>
                ) : null}
                <DataGrid
                  columns={varianceColumns}
                  rows={variance.data ?? []}
                  rowKey={(row) =>
                    `${row.employee_id}:${row.variance_grain}:${row.salary_component_id ?? row.component_code ?? "net"}`
                  }
                  pageSize={25}
                  toolbar={
                    <div className="grid w-full gap-3 sm:max-w-xs">
                      <SelectField
                        label={t("admin.run.var.filter.grain")}
                        value={grain}
                        options={[
                          { value: "net_pay", label: t("admin.run.var.grain.net") },
                          { value: "component", label: t("admin.run.var.grain.component") },
                        ]}
                        onChange={(value) =>
                          setGrain(value === "component" ? "component" : "net_pay")
                        }
                      />
                    </div>
                  }
                  emptyState={
                    <EmptyState
                      icon={Banknote}
                      title={t("admin.run.var.empty.title")}
                      hint={t("admin.run.var.empty.hint")}
                    />
                  }
                />
              </StateBoundary>
            </section>

            <ReasonDialog
              open={notePrompt.isOpen}
              title={t("admin.run.notes.dialogTitle", { number: runRow.run_number })}
              description={t("admin.run.notes.dialogDescription")}
              actorName={employee?.displayName ?? null}
              confirmLabel={t("admin.run.notes.save")}
              pending={annotate.isPending}
              errorMessage={annotate.userMessage}
              onConfirm={(reason) => {
                const target = notePrompt.target;
                if (target !== null) annotate.save({ runId: runRow.id, notes: target.notes }, reason);
              }}
              onCancel={() => {
                annotate.reset();
                notePrompt.close();
              }}
            />
          </>
        ) : null}
      </StateBoundary>
    </div>
  );
}
