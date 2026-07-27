/**
 * /admin/time/pay-periods — the windows payroll runs against (spec-admin §6.5,
 * tier A/S).
 *
 * The seeded shape is `Monthly 26→25`: the window opens on the 26th of one month
 * and closes on the 25th of the next, and the period is named after the month it
 * ENDS in. That is the fact behind DR-34 — attendance is a calendar month, the
 * payroll cutoff is the 25th, and the difference is stated as arrears rather than
 * hidden inside a 25-day "month".
 *
 * Two gates, both honest about which one is real:
 *  - Changing a period is super-admin work; an admin sees it read-only with a
 *    sentence saying so. RLS on `pay_periods` is the actual boundary.
 *  - A period whose payroll is finalised cannot have its window moved at all.
 *    The form does not open, because the alternative is offering an edit the
 *    database will refuse.
 *
 * `pay_periods` is in `audit.reason_required_tables` and moving a window moves
 * what payroll counts, so every save prompts with the D-21 floor of 15
 * characters. There is no `is_active` column here — a period is closed, not
 * deactivated — and no soft delete, so nothing on this screen deletes.
  *
 * @route /admin/time/pay-periods
 */
import { useState } from "react";
import { CalendarRange } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { useAuth } from "@/app/auth/AuthProvider";
import { compareCivilDates, fmtCivilDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { PayPeriod } from "../api/payroll.api";
import { usePayPeriods, usePayPeriodSave, useDefaultCompanyId } from "../hooks/useMasters";
import { MasterBanner } from "../components/MasterScreen";
import { MasterFormSheet } from "../components/MasterFormSheet";
import { useMasterForm, type MasterFormBuild } from "../masters/useMasterForm";
import { codeField, nameField } from "../masters/common";
import type { FieldGroup, FormValues } from "../masters/fields";

const PERIOD_KINDS = [
  { value: "monthly", label: t("admin.time.pp.kind.monthly") },
  { value: "fortnightly", label: t("admin.time.pp.kind.fortnightly") },
  { value: "weekly", label: t("admin.time.pp.kind.weekly") },
] as const;

const BASES = [
  { value: "actual", label: t("admin.time.pp.basis.actual") },
  { value: "fixed_30", label: t("admin.time.pp.basis.fixed_30") },
  { value: "fixed_26", label: t("admin.time.pp.basis.fixed_26") },
] as const;

const PERIOD_STATUS_MAP: Record<string, StatusChipEntry> = {
  open: { label: t("admin.time.pp.state.open"), tone: "success" },
  attendance_locked: { label: t("admin.time.pp.state.attendance_locked"), tone: "warn" },
  finalised: { label: t("admin.time.pp.state.finalised"), tone: "info" },
  closed: { label: t("admin.time.pp.state.closed"), tone: "neutral" },
};

const groups: FieldGroup[] = [
  {
    title: t("admin.master.group.identity"),
    fields: [
      codeField,
      nameField,
      {
        name: "period_kind",
        label: t("admin.time.pp.field.periodKind"),
        kind: "select",
        help: t("admin.time.pp.help.periodKind"),
        required: true,
        options: PERIOD_KINDS,
      },
      {
        name: "financial_year",
        label: t("admin.time.pp.field.fy"),
        kind: "text",
        help: t("admin.time.pp.help.fy"),
        required: true,
        maxLength: 7,
        placeholder: "2026-27",
        pattern: { re: /^\d{4}-\d{2}$/, messageKey: "admin.master.err.pattern.fy" },
      },
    ],
  },
  {
    title: t("admin.time.pp.group.window"),
    fields: [
      {
        name: "start_date",
        label: t("admin.time.pp.field.startDate"),
        kind: "date",
        help: t("admin.time.pp.help.startDate"),
        required: true,
      },
      {
        name: "end_date",
        label: t("admin.time.pp.field.endDate"),
        kind: "date",
        help: t("admin.time.pp.help.endDate"),
        required: true,
      },
      {
        name: "attendance_cutoff_date",
        label: t("admin.time.pp.field.cutoff"),
        kind: "date",
        help: t("admin.time.pp.help.cutoff"),
        required: true,
        wide: true,
      },
    ],
  },
  {
    title: t("admin.time.pp.group.payroll"),
    fields: [
      {
        name: "pay_date",
        label: t("admin.time.pp.field.payDate"),
        kind: "date",
        help: t("admin.time.pp.help.payDate"),
        required: true,
      },
      {
        name: "month_days_basis",
        label: t("admin.time.pp.field.basis"),
        kind: "select",
        help: t("admin.time.pp.help.basis"),
        required: true,
        options: BASES,
      },
      {
        name: "is_open",
        label: t("admin.time.pp.field.isOpen"),
        kind: "checkbox",
        help: t("admin.time.pp.help.isOpen"),
      },
    ],
  },
];

function stateOf(row: PayPeriod): string {
  if (row.payroll_finalised_at !== null) return "finalised";
  if (row.attendance_locked_at !== null) return "attendance_locked";
  return row.is_open ? "open" : "closed";
}

/** Mirrors ck_pp__range plus the two orderings the spec states in words. */
function validateWindow(values: FormValues): string | null {
  const start = values["start_date"] ?? "";
  const end = values["end_date"] ?? "";
  const cutoff = values["attendance_cutoff_date"] ?? "";
  const payDate = values["pay_date"] ?? "";
  if (start === "" || end === "" || cutoff === "" || payDate === "") return null;
  if (compareCivilDates(end, start) < 0) return t("admin.time.pp.err.range");
  if (compareCivilDates(cutoff, start) < 0 || compareCivilDates(cutoff, end) > 0) {
    return t("admin.time.pp.err.cutoff");
  }
  if (compareCivilDates(payDate, cutoff) < 0) return t("admin.time.pp.err.payDate");
  return null;
}

export default function PayPeriodsPage() {
  const { can, employee } = useAuth();
  const mayEdit = can("admin.super");
  const companyId = useDefaultCompanyId();
  const periods = usePayPeriods();
  const save = usePayPeriodSave();
  const form = useMasterForm<PayPeriod>(groups);
  const [pending, setPending] = useState<MasterFormBuild | null>(null);

  const columns: DataGridColumn<PayPeriod>[] = [
    {
      key: "name",
      header: t("admin.master.field.name"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.name}</span>
          <span className="num text-xs text-muted-foreground">{row.code}</span>
        </span>
      ),
    },
    {
      key: "window",
      header: t("admin.time.pp.col.window"),
      width: "15rem",
      render: (row) => (
        <span className="num">
          {t("admin.master.range", {
            from: fmtCivilDate(row.start_date),
            to: fmtCivilDate(row.end_date),
          })}
        </span>
      ),
    },
    {
      key: "attendance_cutoff_date",
      header: t("admin.time.pp.col.cutoff"),
      width: "10rem",
      hideBelow: "md",
      render: (row) => fmtCivilDate(row.attendance_cutoff_date),
    },
    {
      key: "pay_date",
      header: t("admin.time.pp.col.payDate"),
      width: "10rem",
      hideBelow: "md",
      render: (row) => fmtCivilDate(row.pay_date),
    },
    {
      key: "financial_year",
      header: t("admin.time.pp.col.fy"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => <span className="num">{dash(row.financial_year)}</span>,
    },
    {
      key: "month_days_basis",
      header: t("admin.time.pp.col.basis"),
      hideBelow: "lg",
      render: (row) =>
        BASES.find((basis) => basis.value === row.month_days_basis)?.label ??
        dash(row.month_days_basis),
    },
    {
      key: "state",
      header: t("admin.time.pp.col.state"),
      width: "11rem",
      render: (row) => <StatusChip status={stateOf(row)} map={PERIOD_STATUS_MAP} />,
    },
    {
      key: "actions",
      header: t("admin.master.col.actions"),
      align: "right",
      width: "8rem",
      render: (row) => (
        <span className="flex justify-end" onClick={(event) => event.stopPropagation()}>
          {row.payroll_finalised_at !== null ? (
            <span className="text-xs text-muted-foreground">{t("admin.time.pp.lockedRow")}</span>
          ) : (
            <Button variant="outline" size="sm" onClick={() => form.openEdit(row)}>
              {mayEdit ? t("admin.master.action.edit") : t("admin.master.action.view")}
            </Button>
          )}
        </span>
      ),
    },
  ];

  function submit(): void {
    if (!mayEdit) return;
    const built = form.build(validateWindow);
    if (built === null) return;
    if (form.mode === "create") {
      if (companyId === null) {
        form.setFormError(t("admin.master.noCompany"));
        return;
      }
      setPending({ ...built, payload: { ...built.payload, company_id: companyId } });
      return;
    }
    setPending(built);
  }

  async function commit(reason: string): Promise<void> {
    if (pending === null) return;
    try {
      await save.saveAsync({ id: form.editing?.id ?? null, values: pending.payload }, reason);
      toast.success(
        form.mode === "create"
          ? t("admin.master.toast.created", { name: pending.name })
          : t("admin.master.toast.saved", { name: pending.name }),
      );
      setPending(null);
      form.close();
    } catch {
      setPending(null);
    }
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarRange}
        title={t("admin.time.pp.title")}
        subtitle={t("admin.time.pp.subtitle")}
        actions={
          mayEdit ? (
            <Button
              onClick={() =>
                form.openCreate({
                  period_kind: "monthly",
                  month_days_basis: "actual",
                  is_open: "true",
                })
              }
            >
              {t("admin.master.new", { entity: t("admin.time.pp.entity") })}
            </Button>
          ) : undefined
        }
      />

      <MasterBanner>{t("admin.time.pp.banner")}</MasterBanner>
      {mayEdit ? null : <MasterBanner>{t("admin.time.pp.readOnly")}</MasterBanner>}

      <StateBoundary
        loading={periods.isLoading}
        error={periods.error ?? undefined}
        onRetry={() => void periods.refetch()}
        skeletonRows={5}
      >
        <DataGrid
          columns={columns}
          rows={periods.data ?? []}
          rowKey={(row) => row.id}
          pageSize={25}
          onRowClick={(row) => {
            if (row.payroll_finalised_at === null) form.openEdit(row);
          }}
          emptyState={
            <EmptyState
              icon={CalendarRange}
              title={t("admin.time.pp.empty.title")}
              hint={t("admin.time.pp.empty.hint")}
            />
          }
        />
      </StateBoundary>

      <MasterFormSheet
        open={form.open}
        mode={form.mode}
        entityLabel={t("admin.time.pp.entity")}
        rowName={form.editing?.name ?? null}
        groups={groups}
        values={form.values}
        errors={form.errors}
        pending={save.isPending}
        serverMessage={save.userMessage}
        formError={form.formError}
        readOnly={!mayEdit}
        readOnlyNote={t("admin.time.pp.readOnly")}
        banner={<MasterBanner>{t("admin.time.pp.banner")}</MasterBanner>}
        onChange={form.change}
        onSubmit={submit}
        onClose={form.close}
      />

      {pending !== null ? (
        <ReasonDialog
          open
          title={
            form.mode === "create"
              ? t("admin.master.saveReason.createTitle", { entity: t("admin.time.pp.entity") })
              : t("admin.master.saveReason.editTitle", { name: pending.name })
          }
          description={
            pending.changes.length === 0
              ? t("admin.time.pp.reasonPrompt")
              : t("admin.master.changes.list", { changes: pending.changes.join("; ") })
          }
          actorName={employee?.displayName ?? null}
          minLength={SENSITIVE_REASON_LENGTH}
          confirmLabel={t("admin.master.saveReason.confirm")}
          pending={save.isPending}
          errorMessage={save.userMessage}
          onConfirm={(reason) => void commit(reason)}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}
