/**
 * §2 · /admin/people/:code/compensation — one employee's pay: the structure in
 * force, every revision behind it, and the payslips it produced.
 *
 * Three rules, and the first two are the reason this screen is read-only:
 *
 *  1. MONEY IS INTEGER PAISE, END TO END. Every amount here is a `*_paise`
 *     column rendered by <Money>. Nothing is divided by 100 in this file, and no
 *     total is added up: `v_employee_current_salary` is a JOIN that repeats the
 *     revision's header totals on every component line, so the totals are read
 *     off ONE row while the lines are listed — reading them off a sum would let a
 *     structure and a payslip drift apart by a rupee.
 *  2. INCREMENTS ARE THE VIEW'S ARITHMETIC. `increment_amount_paise`,
 *     `increment_pct` and `months_since_previous` are columns of
 *     `v_salary_revisions`. This page never subtracts two CTCs to find a raise,
 *     and never multiplies a ratio by 100 (the incumbent's '1,700.00%').
 *  3. NO COMPENSATION WRITE LIVES HERE. `monthly_ctc`, the component amounts and
 *     the revision rows are NOT in the admin's granted UPDATE set on `employees`
 *     (`updateEmployee` refuses them by name), and a revision is created and
 *     approved through the payroll masters screens where the two-person rule
 *     applies. So this screen reads, links to those screens, and offers no field
 *     that would fail at the database.
 *
 * Absence is stated, not smoothed: `v_employee_current_salary` and
 * `v_salary_revisions` are RLS-protected, so "no approved revision" and "not in
 * your scope" arrive identically — as no rows — and the empty states say so.
 *
 * @route /admin/people/:code/compensation
 */
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Banknote, FileText, Layers, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Money } from "@/shared/ui/Money";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatDays, formatNumber, formatPercent } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { useAdminEmployee } from "../hooks/usePeople";
import {
  useEmployeeCurrentSalary,
  useEmployeeSalaryRevisions,
} from "../hooks/usePeopleLifecycle";
import { flattenPages, usePayslipCount, usePayslipRegister } from "../hooks/usePayrollMasters";
import type { CurrentSalaryLine, SalaryRevision } from "../api/employees.api";
import type { PayslipHeader, PayslipRegisterFilters } from "../api/payroll-masters.api";

/** Revision lifecycle, as `v_salary_revisions.status` reports it. */
const REVISION_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("admin.pComp.revStatus.draft"), tone: "neutral" },
  pending_approval: { label: t("admin.pComp.revStatus.pendingApproval"), tone: "warn" },
  approved: { label: t("admin.pComp.revStatus.approved"), tone: "success" },
  rejected: { label: t("admin.pComp.revStatus.rejected"), tone: "danger" },
  superseded: { label: t("admin.pComp.revStatus.superseded"), tone: "neutral" },
  cancelled: { label: t("admin.pComp.revStatus.cancelled"), tone: "neutral" },
};

const PAYMENT_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pending: { label: t("admin.pComp.payStatus.pending"), tone: "warn" },
  in_advice: { label: t("admin.pComp.payStatus.inAdvice"), tone: "info" },
  paid: { label: t("admin.pComp.payStatus.paid"), tone: "success" },
  failed: { label: t("admin.pComp.payStatus.failed"), tone: "danger" },
  on_hold: { label: t("admin.pComp.payStatus.onHold"), tone: "danger" },
};

/** A syntactically valid uuid that matches no employee — the loading scope. */
const NO_EMPLOYEE = "00000000-0000-0000-0000-000000000000";

export default function EmployeeCompensationPage() {
  const { code = "" } = useParams<{ code: string }>();
  const employee = useAdminEmployee(code);
  const person = employee.data ?? null;
  const employeeId = person?.id ?? null;

  const salary = useEmployeeCurrentSalary(employeeId);
  const revisions = useEmployeeSalaryRevisions(employeeId);

  /**
   * The payslip register, scoped to this employee. An OMITTED `employeeId` would
   * drop the predicate and list the whole company's payslips, so while the record
   * loads the scope is a valid uuid that matches no row: on a pay screen an
   * unscoped read is worse than a spinner.
   */
  const payslipFilters = useMemo<PayslipRegisterFilters>(
    () => ({ employeeId: employeeId ?? NO_EMPLOYEE }),
    [employeeId],
  );
  const payslips = usePayslipRegister(payslipFilters);
  const payslipTotal = usePayslipCount(payslipFilters);

  const lines = employeeId === null ? [] : (salary.data ?? []);
  const revisionRows = employeeId === null ? [] : (revisions.data ?? []);
  const payslipRows = employeeId === null ? [] : flattenPages(payslips.data);
  // Header totals ride on every line of the view's join: read them off one row.
  const header = lines[0] ?? null;

  const componentColumns: DataGridColumn<CurrentSalaryLine>[] = [
    {
      key: "component_name",
      header: t("admin.pComp.comp.col.component"),
      render: (r) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{dash(r.component_name)}</span>
          <span className="num text-xs text-muted-foreground">{dash(r.component_code)}</span>
        </span>
      ),
    },
    {
      key: "line_kind",
      header: t("admin.pComp.comp.col.kind"),
      width: "10rem",
      hideBelow: "md",
      render: (r) => (r.line_kind === null ? dash(null) : <StatusChip status={r.line_kind} />),
    },
    {
      key: "ctc_bucket",
      header: t("admin.pComp.comp.col.bucket"),
      width: "9rem",
      hideBelow: "lg",
      render: (r) => dash(r.ctc_bucket),
    },
    {
      key: "monthly_amount_paise",
      header: t("admin.pComp.comp.col.monthly"),
      width: "10rem",
      align: "right",
      render: (r) => <Money paise={r.monthly_amount_paise} />,
    },
    {
      key: "annual_amount_paise",
      header: t("admin.pComp.comp.col.annual"),
      width: "11rem",
      align: "right",
      hideBelow: "md",
      render: (r) => <Money paise={r.annual_amount_paise} />,
    },
  ];

  const revisionColumns: DataGridColumn<SalaryRevision>[] = [
    {
      key: "effective_from",
      header: t("admin.pComp.rev.col.effective"),
      width: "11rem",
      render: (r) => (
        <span className="flex flex-col leading-tight">
          <span className="num">{fmtCivilDate(r.effective_from)}</span>
          {r.is_current ? (
            <span className="text-xs text-success">{t("admin.pComp.rev.current")}</span>
          ) : r.effective_to === null ? null : (
            <span className="num text-xs text-muted-foreground">
              {t("admin.pComp.rev.until", { date: fmtCivilDate(r.effective_to) })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "revision_number",
      header: t("admin.pComp.rev.col.number"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (r) => <span className="num">{formatNumber(r.revision_number)}</span>,
    },
    {
      key: "revision_kind",
      header: t("admin.pComp.rev.col.kind"),
      width: "10rem",
      render: (r) => <StatusChip status={r.revision_kind} />,
    },
    {
      key: "status",
      header: t("admin.pComp.rev.col.status"),
      width: "10rem",
      render: (r) => <StatusChip status={r.status} map={REVISION_STATUS_CHIP} />,
    },
    {
      key: "monthly_ctc_paise",
      header: t("admin.pComp.rev.col.monthlyCtc"),
      width: "11rem",
      align: "right",
      render: (r) => <Money paise={r.monthly_ctc_paise} />,
    },
    {
      key: "annual_ctc_paise",
      header: t("admin.pComp.rev.col.annualCtc"),
      width: "12rem",
      align: "right",
      hideBelow: "md",
      render: (r) => <Money paise={r.annual_ctc_paise} />,
    },
    {
      key: "increment_amount_paise",
      header: t("admin.pComp.rev.col.increment"),
      width: "12rem",
      align: "right",
      // Both figures are the view's own: no subtraction, no ratio × 100.
      render: (r) =>
        r.increment_amount_paise === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.pComp.rev.noPrevious")}</span>
        ) : (
          <span className="flex flex-col items-end leading-tight">
            <Money paise={r.increment_amount_paise} />
            <span className="num text-xs text-muted-foreground">
              {formatPercent(r.increment_pct)}
            </span>
          </span>
        ),
    },
    {
      key: "months_since_previous",
      header: t("admin.pComp.rev.col.gap"),
      width: "9rem",
      align: "right",
      hideBelow: "lg",
      render: (r) =>
        r.months_since_previous === null ? (
          <span className="text-muted-foreground">{t("common.empty")}</span>
        ) : (
          <span className="num">
            {t("admin.pComp.rev.months", { n: formatNumber(r.months_since_previous) })}
          </span>
        ),
    },
    {
      key: "approved_at",
      header: t("admin.pComp.rev.col.approved"),
      width: "12rem",
      align: "right",
      hideBelow: "lg",
      render: (r) =>
        r.approved_at === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.pComp.rev.notApproved")}</span>
        ) : (
          <span className="num text-xs">{fmtDateTime(r.approved_at)}</span>
        ),
    },
  ];

  const payslipColumns: DataGridColumn<PayslipHeader>[] = [
    {
      key: "pay_date",
      header: t("admin.pComp.slip.col.payDate"),
      width: "11rem",
      render: (r) => <span className="num">{fmtCivilDate(r.pay_date)}</span>,
    },
    {
      key: "payslip_number",
      header: t("admin.pComp.slip.col.number"),
      width: "14rem",
      hideBelow: "md",
      render: (r) => <span className="num text-xs">{r.payslip_number}</span>,
    },
    {
      key: "period_start",
      header: t("admin.pComp.slip.col.period"),
      width: "14rem",
      hideBelow: "lg",
      render: (r) => (
        <span className="num text-xs">
          {fmtCivilDate(r.period_start)} – {fmtCivilDate(r.period_end)}
        </span>
      ),
    },
    {
      key: "paid_days",
      header: t("admin.pComp.slip.col.paidDays"),
      width: "9rem",
      align: "right",
      // §9.2's one definition of paid days, as the payslip stored it.
      render: (r) => <span className="num">{formatDays(r.paid_days)}</span>,
    },
    {
      key: "gross_earnings_paise",
      header: t("admin.pComp.slip.col.gross"),
      width: "11rem",
      align: "right",
      render: (r) => <Money paise={r.gross_earnings_paise} />,
    },
    {
      key: "total_deductions_paise",
      header: t("admin.pComp.slip.col.deductions"),
      width: "11rem",
      align: "right",
      hideBelow: "md",
      render: (r) => <Money paise={r.total_deductions_paise} />,
    },
    {
      key: "net_pay_paise",
      header: t("admin.pComp.slip.col.net"),
      width: "11rem",
      align: "right",
      render: (r) => <Money paise={r.net_pay_paise} className="font-semibold" />,
    },
    {
      key: "payment_status",
      header: t("admin.pComp.slip.col.payment"),
      width: "10rem",
      render: (r) => (
        <span className="flex flex-col items-start gap-1">
          <StatusChip status={r.payment_status} map={PAYMENT_STATUS_CHIP} />
          {r.is_reversed ? (
            <span className="text-xs text-destructive">{t("admin.pComp.slip.reversed")}</span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Banknote}
        title={t("admin.pComp.title")}
        subtitle={
          person === null
            ? t("admin.pComp.subtitle.plain")
            : t("admin.pComp.subtitle.person", {
                name: person.display_name,
                code: person.employee_code,
              })
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={`/admin/people/${encodeURIComponent(code)}`}>
              <ArrowLeft className="mr-2 size-4" aria-hidden />
              {t("admin.pComp.backToPerson")}
            </Link>
          </Button>
        }
      />

      <StateBoundary
        loading={employee.isPending}
        error={employee.error}
        onRetry={() => void employee.refetch()}
        isEmpty={person === null && !employee.isPending && employee.error === null}
        skeletonRows={2}
        empty={
          <EmptyState
            icon={Banknote}
            title={t("admin.pComp.noPerson.title")}
            hint={t("admin.pComp.noPerson.hint")}
          />
        }
      >
        {person !== null ? (
          <>
            <div className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <PersonCell
                  name={person.display_name}
                  code={person.employee_code}
                  secondary={person.designation_name}
                />
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span>{dash(person.department_name)}</span>
                  <span>{dash(person.grade_name)}</span>
                  <span className="num">
                    {t("admin.pComp.joined", { date: fmtCivilDate(person.date_of_join) })}
                  </span>
                  <span>{dash(person.payment_mode)}</span>
                </div>
              </div>
            </div>

            {person.exclude_from_payroll ? (
              <div className="mt-4">
                <Notice tone="warning">{t("admin.pComp.excluded")}</Notice>
              </div>
            ) : null}

            {/* 1 · The structure in force — totals read off the view, never summed. */}
            <h2 className="mt-6 flex items-center gap-2 font-display text-lg font-semibold">
              <Layers className="size-4" aria-hidden />
              {t("admin.pComp.comp.title")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("admin.pComp.comp.hint")}</p>

            <div className="mt-3">
              <StateBoundary
                loading={salary.isPending}
                error={salary.error}
                onRetry={() => void salary.refetch()}
                isEmpty={header === null}
                skeletonRows={3}
                empty={
                  <EmptyState
                    icon={Layers}
                    title={t("admin.pComp.comp.empty.title")}
                    hint={t("admin.pComp.comp.empty.hint")}
                  />
                }
              >
                {header !== null ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <Kpi
                        label={t("admin.pComp.kpi.monthlyGross")}
                        paise={header.monthly_gross_paise}
                      />
                      <Kpi
                        label={t("admin.pComp.kpi.employerContribution")}
                        paise={header.monthly_employer_contribution_paise}
                      />
                      <Kpi label={t("admin.pComp.kpi.monthlyCtc")} paise={header.monthly_ctc_paise} />
                      <Kpi label={t("admin.pComp.kpi.annualCtc")} paise={header.annual_ctc_paise} />
                      <Kpi label={t("admin.pComp.kpi.bucketA")} paise={header.bucket_a_monthly_paise} />
                      <Kpi label={t("admin.pComp.kpi.bucketB")} paise={header.bucket_b_monthly_paise} />
                      <Kpi label={t("admin.pComp.kpi.bucketC")} paise={header.bucket_c_monthly_paise} />
                      <Kpi label={t("admin.pComp.kpi.ctcAtJoin")} paise={header.ctc_at_join_paise} />
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        {t("admin.pComp.comp.effective", {
                          date: fmtCivilDate(header.effective_from),
                        })}
                      </span>
                      <span className="num">
                        {t("admin.pComp.comp.revisionNumber", {
                          n: formatNumber(header.revision_number),
                        })}
                      </span>
                      <span className="num">{dash(header.salary_structure_code)}</span>
                    </div>

                    <div className="mt-3">
                      <DataGrid
                        columns={componentColumns}
                        rows={lines}
                        rowKey={(r) => `${r.revision_id}:${r.component_code ?? String(r.sequence)}`}
                        pageSize={50}
                      />
                    </div>
                  </>
                ) : null}
              </StateBoundary>
            </div>

            {/* 2 · Revisions — the view's own increment figures. */}
            <h2 className="mt-8 flex items-center gap-2 font-display text-lg font-semibold">
              <TrendingUp className="size-4" aria-hidden />
              {t("admin.pComp.rev.title")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("admin.pComp.rev.hint")}</p>

            <div className="mt-3">
              <StateBoundary
                loading={revisions.isPending}
                error={revisions.error}
                onRetry={() => void revisions.refetch()}
                isEmpty={revisionRows.length === 0}
                skeletonRows={2}
                empty={
                  <EmptyState
                    icon={TrendingUp}
                    title={t("admin.pComp.rev.empty.title")}
                    hint={t("admin.pComp.rev.empty.hint")}
                  />
                }
              >
                <DataGrid
                  columns={revisionColumns}
                  rows={revisionRows}
                  rowKey={(r) => r.revision_id}
                  pageSize={50}
                />
              </StateBoundary>
            </div>

            {/* 3 · Payslips this compensation produced. */}
            <h2 className="mt-8 flex items-center gap-2 font-display text-lg font-semibold">
              <FileText className="size-4" aria-hidden />
              {t("admin.pComp.slip.title")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {payslipTotal.isSuccess
                ? t("admin.pComp.slip.count", { n: formatNumber(payslipTotal.data) })
                : t("admin.pComp.slip.hint")}
            </p>

            <div className="mt-3">
              <StateBoundary
                loading={payslips.isPending}
                error={payslips.error}
                onRetry={() => void payslips.refetch()}
                isEmpty={payslipRows.length === 0}
                partialError={payslipTotal.error}
                partialLabel={t("admin.pComp.slip.partial.total")}
                skeletonRows={2}
                empty={
                  <EmptyState
                    icon={FileText}
                    title={t("admin.pComp.slip.empty.title")}
                    hint={t("admin.pComp.slip.empty.hint")}
                  />
                }
              >
                <DataGrid
                  columns={payslipColumns}
                  rows={payslipRows}
                  rowKey={(r) => r.id}
                  pageSize={50}
                />
                {payslips.hasNextPage ? (
                  <div className="mt-4 flex justify-center">
                    <Button
                      variant="outline"
                      onClick={() => void payslips.fetchNextPage()}
                      disabled={payslips.isFetchingNextPage}
                    >
                      {payslips.isFetchingNextPage
                        ? t("admin.pComp.slip.loadingMore")
                        : t("admin.pComp.slip.loadMore")}
                    </Button>
                  </div>
                ) : null}
              </StateBoundary>
            </div>

            <div className="mt-6">
              <Notice tone="info">{t("admin.pComp.readOnlyNotice")}</Notice>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/admin/payroll/revisions">{t("admin.pComp.openRevisions")}</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link to="/admin/payroll/structures">{t("admin.pComp.openStructures")}</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link to={`/admin/people/${encodeURIComponent(code)}/audit`}>
                  {t("admin.pComp.openHistory")}
                </Link>
              </Button>
            </div>
          </>
        ) : null}
      </StateBoundary>
    </div>
  );
}

/** One labelled money total, straight from a server column in paise. */
function Kpi({ label, paise }: { label: string; paise: number | null }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-lg font-semibold">
        <Money paise={paise} />
      </p>
    </div>
  );
}
