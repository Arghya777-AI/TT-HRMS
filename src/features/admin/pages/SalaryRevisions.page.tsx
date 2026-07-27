/**
 * §8 · /admin/payroll/revisions — the organisation-wide salary revision
 * register: every increment, promotion and correction, effective-dated, with the
 * status it is in and who approved it.
 *
 * Three things this screen refuses to do:
 *
 *  1. IT DOES NOT UNMASK PAY. Every rupee renders as `₹•,••,•••`. Unmasking a
 *     person's compensation is a LOGGED read — `reveal_employee_salary` writes
 *     `data_access_log` with the actor, the fields and the purpose before it
 *     returns a figure (D-19/DR-22) — and that ceremony lives on Employee
 *     Compensation. Every row therefore links there instead of growing a second,
 *     quieter reveal path on a register screen.
 *  2. IT DOES NOT COMPUTE AN INCREMENT. `increment_amount_paise`,
 *     `increment_pct` and `months_since_previous` are GENERATED / trigger-set
 *     columns of `employee_salary_revisions` (021), read through
 *     `v_salary_revisions`. `increment_pct` is already a percentage and is NOT
 *     clamped: a first revision after a long gap can legitimately exceed 100%,
 *     and clamping a growth rate is the mirror image of the 1,700% defect.
 *  3. IT DOES NOT COUNT THE ROWS IT LOADED. The header total is a
 *     `HEAD … count=exact` over the SAME filter array as the keyset pages, so
 *     "78 revisions" cannot drift as the operator presses Load more.
 *
 * Status is `public.approval_status`, so `applied` and `auto_approved` are real
 * states an admin must be able to see and distinguish from `approved`.
 *
 * @route /admin/payroll/revisions
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Banknote, TrendingUp } from "lucide-react";
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
import type { RevisionRow } from "../api/payroll.api";
import {
  isRevisionStatus,
  revisionStatusValues,
  type RevisionRegisterFilters,
} from "../api/payroll-masters.api";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, TextField } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import { useProfilePeople } from "../hooks/useAdminPayroll";
import {
  REGISTER_PAGE_SIZE,
  REVISION_STATUS_CHIP,
  flattenPages,
  revisionKindLabel,
  useRevisionCount,
  useRevisionRegister,
} from "../hooks/usePayrollMasters";

const CURRENT_CHIP = {
  current: { label: t("admin.rev.current"), tone: "success" as const },
  historic: { label: t("admin.rev.historic"), tone: "neutral" as const },
};

export default function SalaryRevisionsPage() {
  const [employeeId, setEmployeeId] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const approvers = useProfilePeople();

  const filters = useMemo<RevisionRegisterFilters>(
    () => ({
      ...(employeeId !== "" ? { employeeIds: [employeeId] } : {}),
      ...(status !== "" && isRevisionStatus(status) ? { statuses: [status] } : {}),
      ...(from !== "" ? { from } : {}),
      ...(to !== "" ? { to } : {}),
    }),
    [employeeId, status, from, to],
  );

  const register = useRevisionRegister(filters);
  const total = useRevisionCount(filters);
  const rows = flattenPages(register.data);

  const hasAnyFilter = employeeId !== "" || status !== "" || from !== "" || to !== "";

  function clearAll(): void {
    setEmployeeId("");
    setStatus("");
    setFrom("");
    setTo("");
  }

  const statusOptions = useMemo(
    () =>
      revisionStatusValues.map((value) => ({
        value,
        label: REVISION_STATUS_CHIP[value].label,
      })),
    [],
  );

  const columns: DataGridColumn<RevisionRow>[] = [
    {
      key: "employee",
      header: t("admin.rev.col.employee"),
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
      key: "revision_number",
      header: t("admin.rev.col.number"),
      width: "6rem",
      align: "right",
      sortable: true,
      render: (row) => <span className="num">{formatNumber(row.revision_number)}</span>,
    },
    {
      key: "revision_kind",
      header: t("admin.rev.col.kind"),
      width: "12rem",
      render: (row) => revisionKindLabel(row.revision_kind),
    },
    {
      key: "status",
      header: t("admin.rev.col.status"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={REVISION_STATUS_CHIP} />,
    },
    {
      key: "is_current",
      header: t("admin.rev.col.inForce"),
      width: "9rem",
      render: (row) => (
        <StatusChip status={row.is_current ? "current" : "historic"} map={CURRENT_CHIP} />
      ),
    },
    {
      key: "effective_from",
      header: t("admin.rev.col.effectiveFrom"),
      width: "10rem",
      align: "right",
      sortable: true,
      render: (row) => <span className="num">{fmtCivilDate(row.effective_from)}</span>,
    },
    {
      key: "effective_to",
      header: t("admin.rev.col.effectiveTo"),
      width: "10rem",
      align: "right",
      hideBelow: "lg",
      render: (row) =>
        row.effective_to === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.rev.openEnded")}</span>
        ) : (
          <span className="num">{fmtCivilDate(row.effective_to)}</span>
        ),
    },
    {
      key: "monthly_ctc_paise",
      header: t("admin.rev.col.monthlyCtc"),
      width: "11rem",
      align: "right",
      render: (row) => <Money paise={row.monthly_ctc_paise} masked />,
    },
    {
      key: "annual_ctc_paise",
      header: t("admin.rev.col.annualCtc"),
      width: "11rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <Money paise={row.annual_ctc_paise} masked />,
    },
    {
      key: "increment_amount_paise",
      header: t("admin.rev.col.increment"),
      width: "11rem",
      align: "right",
      hideBelow: "md",
      render: (row) =>
        row.increment_amount_paise === null ? (
          dash(null)
        ) : (
          <Money paise={row.increment_amount_paise} masked />
        ),
    },
    {
      key: "increment_pct",
      header: t("admin.rev.col.incrementPct"),
      width: "9rem",
      align: "right",
      // A growth rate the database generated. Printed as stored, never clamped.
      render: (row) => dash(row.increment_pct, (pct) => formatPercent(pct)),
    },
    {
      key: "months_since_previous",
      header: t("admin.rev.col.monthsSince"),
      width: "10rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => dash(row.months_since_previous, (n) => formatNumber(n)),
    },
    {
      key: "approved_by",
      header: t("admin.rev.col.approver"),
      width: "13rem",
      hideBelow: "md",
      render: (row) => {
        if (row.approved_by === null) return dash(null);
        const person = approvers.data?.get(row.approved_by);
        return person === undefined ? (
          <span className="text-xs text-muted-foreground">{t("admin.rev.approverUnknown")}</span>
        ) : (
          <PersonCell name={person.display_name} code={person.employee_code} secondary={null} />
        );
      },
    },
    {
      key: "approved_at",
      header: t("admin.rev.col.approvedAt"),
      width: "12rem",
      hideBelow: "lg",
      render: (row) => dash(row.approved_at, fmtDateTime),
    },
    {
      key: "notes",
      header: t("admin.rev.col.notes"),
      width: "14rem",
      hideBelow: "lg",
      render: (row) => (
        <span className="line-clamp-2 text-xs text-muted-foreground">{dash(row.notes)}</span>
      ),
    },
    {
      key: "reveal",
      header: t("admin.rev.col.open"),
      width: "10rem",
      align: "right",
      // The compensation register carries the audited reveal. It takes no filter
      // from the URL, so this link does not pretend to pre-select the person.
      render: () => (
        <Button variant="outline" size="sm" asChild>
          <Link to="/admin/payroll/compensation">{t("admin.rev.openCompensation")}</Link>
        </Button>
      ),
    },
  ];

  const subtitle = total.isSuccess
    ? t("admin.rev.subtitle.count", { n: formatNumber(total.data) })
    : t("admin.rev.subtitle");

  return (
    <div className="container py-6">
      <PageHeader icon={TrendingUp} title={t("admin.rev.title")} subtitle={subtitle} />

      <Notice tone="info" className="mb-4">
        {t("admin.rev.maskNotice")}
      </Notice>

      <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.common.filter.employee")}
          value={employeeId}
          options={employeeChoices}
          placeholder={t("admin.common.filter.allEmployees")}
          onChange={setEmployeeId}
          disabled={labels.isLoading}
        />
        <SelectField
          label={t("admin.rev.filter.status")}
          value={status}
          options={statusOptions}
          placeholder={t("admin.rev.filter.allStatuses")}
          onChange={setStatus}
        />
        <TextField
          label={t("admin.common.filter.from")}
          value={from}
          type="date"
          onChange={setFrom}
          hint={t("admin.rev.filter.dateHint")}
        />
        <TextField label={t("admin.common.filter.to")} value={to} type="date" onChange={setTo} />
        {hasAnyFilter ? (
          <div className="flex items-end">
            <Button type="button" variant="ghost" onClick={clearAll}>
              {t("admin.rev.filter.clearAll")}
            </Button>
          </div>
        ) : null}
      </div>

      <StateBoundary
        loading={register.isPending}
        error={register.error}
        onRetry={() => void register.refetch()}
        isEmpty={rows.length === 0}
        partialError={labels.error ?? total.error ?? approvers.error}
        partialLabel={t("admin.rev.partial")}
        empty={
          hasAnyFilter ? (
            <EmptyState
              icon={Banknote}
              title={t("admin.rev.empty.filtered.title")}
              hint={t("admin.rev.empty.filtered.hint")}
              action={
                <Button variant="outline" onClick={clearAll}>
                  {t("admin.rev.filter.clearAll")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Banknote}
              title={t("admin.rev.empty.title")}
              hint={t("admin.rev.empty.hint")}
            />
          )
        }
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.revision_id}
          pageSize={REGISTER_PAGE_SIZE}
        />

        {register.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              onClick={() => void register.fetchNextPage()}
              disabled={register.isFetchingNextPage}
            >
              {register.isFetchingNextPage ? t("admin.rev.loadingMore") : t("admin.rev.loadMore")}
            </Button>
          </div>
        ) : null}
      </StateBoundary>

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.rev.footnote")}</p>
    </div>
  );
}
