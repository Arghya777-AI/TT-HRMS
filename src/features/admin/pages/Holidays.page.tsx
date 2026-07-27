/**
 * /admin/time/holidays — holiday calendars and the holidays on them
 * (spec-admin §6.3).
 *
 * Two masters on one route, because a calendar with no visible holidays is not a
 * thing anyone can check against the Karnataka statutory list. Pick a calendar,
 * see its days.
 *
 * What the copy has to carry, because it is genuinely three decisions in one row:
 *   * `is_paid` — does the day count as paid even though nobody works it,
 *   * `working_if_event_booked` — the venue's busiest days ARE holidays, so a
 *     booked event turns the day back into a working day,
 *   * `compensatory_off_if_worked` / `pay_multiplier_if_worked` — what someone
 *     who does work it earns.
 *
 * `holidays` is in `audit.reason_required_tables`, so every write here prompts
 * and none of them carries a default reason. Weekdays are derived at render
 * (DR-39) and holiday names come from the master, spelled once (DR-03).
  *
 * @route /admin/time/holidays
 */
import { useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtCivilDateWeekday, nowIstDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { Holiday, HolidayCalendar, OrgListFilters } from "../api/org.api";
import {
  useDefaultCompanyId,
  useHolidays,
  useHolidaySave,
  useHolidayWithdraw,
  useMasterArchive,
  useMasterSave,
  useOrgList,
  useRefOptions,
} from "../hooks/useMasters";
import { MasterBanner, MASTER_STATUS_MAP } from "../components/MasterScreen";
import { MasterFormSheet } from "../components/MasterFormSheet";
import { useMasterForm, type MasterFormBuild } from "../masters/useMasterForm";
import { identityGroup, BASE_CREATE_DEFAULTS } from "../masters/common";
import { refOptions, type FieldGroup } from "../masters/fields";

const HOLIDAY_TYPES = [
  { value: "national", label: t("admin.time.hol.type.national") },
  { value: "state", label: t("admin.time.hol.type.state") },
  { value: "festival", label: t("admin.time.hol.type.festival") },
  { value: "restricted", label: t("admin.time.hol.type.restricted") },
  { value: "optional", label: t("admin.time.hol.type.optional") },
  { value: "company", label: t("admin.time.hol.type.company") },
  { value: "venue_closure", label: t("admin.time.hol.type.venue_closure") },
] as const;

const calendarGroups: FieldGroup[] = [
  identityGroup([
    {
      name: "year",
      label: t("admin.time.hol.field.year"),
      kind: "number",
      help: t("admin.time.hol.help.year"),
      required: true,
      min: 2020,
      max: 2099,
    },
    {
      name: "state",
      label: t("admin.time.hol.field.state"),
      kind: "text",
      help: t("admin.time.hol.help.state"),
      maxLength: 80,
    },
    {
      name: "is_default",
      label: t("admin.time.hol.field.isDefault"),
      kind: "checkbox",
      help: t("admin.time.hol.help.isDefault"),
    },
    {
      name: "total_holiday_quota",
      label: t("admin.time.hol.field.totalQuota"),
      kind: "number",
      help: t("admin.time.hol.help.totalQuota"),
      min: 0,
      max: 60,
    },
    {
      name: "optional_holiday_quota",
      label: t("admin.time.hol.field.optionalQuota"),
      kind: "number",
      help: t("admin.time.hol.help.optionalQuota"),
      min: 0,
      max: 30,
    },
  ]),
];

function useCalendarRows(filters: OrgListFilters) {
  return useOrgList("holidayCalendars", filters);
}

function workedLabel(row: Holiday): string {
  const multiplier = row.pay_multiplier_if_worked;
  const paid = multiplier !== null && multiplier > 1;
  if (row.compensatory_off_if_worked && paid) {
    return t("admin.time.hol.worked.both", { n: multiplier });
  }
  if (row.compensatory_off_if_worked) return t("admin.time.hol.worked.compOff");
  if (paid) return t("admin.time.hol.worked.multiplier", { n: multiplier });
  return t("admin.time.hol.worked.none");
}

export default function HolidaysPage() {
  const { employee } = useAuth();
  const actorName = employee?.displayName ?? null;
  const companyId = useDefaultCompanyId();
  const departments = useRefOptions("departments");

  const [includeInactive, setIncludeInactive] = useState(false);
  const calendarFilters: OrgListFilters = useMemo(
    () => ({ includeInactive }),
    [includeInactive],
  );
  const calendars = useCalendarRows(calendarFilters);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    (calendars.data ?? []).find((row) => row.id === selectedId) ?? (calendars.data ?? [])[0] ?? null;
  const holidays = useHolidays(selected?.id ?? null);

  const holidayGroups: FieldGroup[] = useMemo(
    () => [
      {
        title: t("admin.time.hol.col.holiday"),
        fields: [
          {
            name: "holiday_date",
            label: t("admin.time.hol.field.date"),
            kind: "date",
            help: t("admin.time.hol.help.date"),
            required: true,
          },
          {
            name: "name",
            label: t("admin.time.hol.field.holidayName"),
            kind: "text",
            help: t("admin.time.hol.help.holidayName"),
            required: true,
            maxLength: 120,
          },
          {
            name: "local_name",
            label: t("admin.time.hol.field.localName"),
            kind: "text",
            help: t("admin.time.hol.help.localName"),
            maxLength: 120,
          },
          {
            name: "holiday_type",
            label: t("admin.time.hol.field.type"),
            kind: "select",
            help: t("admin.time.hol.help.type"),
            required: true,
            options: HOLIDAY_TYPES,
          },
          {
            name: "description",
            label: t("admin.master.field.description"),
            kind: "textarea",
            maxLength: 500,
          },
          {
            // The withdraw action clears this flag; the form is how a withdrawn
            // holiday is put back on the calendar.
            name: "is_active",
            label: t("admin.master.field.isActive"),
            kind: "checkbox",
            help: t("admin.master.help.isActive"),
          },
        ],
      },
      {
        title: t("admin.time.hol.col.worked"),
        fields: [
          {
            name: "is_paid",
            label: t("admin.time.hol.field.isPaid"),
            kind: "checkbox",
            help: t("admin.time.hol.help.isPaid"),
          },
          {
            name: "is_optional",
            label: t("admin.time.hol.field.isOptional"),
            kind: "checkbox",
            help: t("admin.time.hol.help.isOptional"),
          },
          {
            name: "working_if_event_booked",
            label: t("admin.time.hol.field.workingIfEvent"),
            kind: "checkbox",
            help: t("admin.time.hol.help.workingIfEvent"),
          },
          {
            name: "compensatory_off_if_worked",
            label: t("admin.time.hol.field.compOff"),
            kind: "checkbox",
            help: t("admin.time.hol.help.compOff"),
          },
          {
            name: "pay_multiplier_if_worked",
            label: t("admin.time.hol.field.multiplier"),
            kind: "decimal",
            help: t("admin.time.hol.help.multiplier"),
            min: 1,
            max: 5,
          },
          {
            name: "applies_to_department_ids",
            label: t("admin.time.hol.field.departments"),
            kind: "multi",
            help: t("admin.time.hol.help.departments"),
            options: refOptions(departments.data),
            wide: true,
          },
        ],
      },
    ],
    [departments.data],
  );

  const calendarForm = useMasterForm<HolidayCalendar>(calendarGroups);
  const holidayForm = useMasterForm<Holiday>(holidayGroups);

  const calendarSave = useMasterSave("holidayCalendars", { alwaysPrompt: true });
  const calendarArchive = useMasterArchive("holidayCalendars");
  const holidaySave = useHolidaySave();
  const holidayWithdraw = useHolidayWithdraw();

  const [pendingCalendar, setPendingCalendar] = useState<MasterFormBuild | null>(null);
  const [pendingHoliday, setPendingHoliday] = useState<MasterFormBuild | null>(null);
  const [retiring, setRetiring] = useState<HolidayCalendar | null>(null);
  const [withdrawing, setWithdrawing] = useState<Holiday | null>(null);

  const calendarColumns: DataGridColumn<HolidayCalendar>[] = [
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
      key: "year",
      header: t("admin.time.hol.col.year"),
      width: "6rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.year,
    },
    {
      key: "state",
      header: t("admin.time.hol.col.state"),
      hideBelow: "md",
      render: (row) => dash(row.state),
    },
    {
      key: "is_default",
      header: t("admin.time.hol.col.default"),
      width: "7rem",
      hideBelow: "md",
      render: (row) => (row.is_default ? t("admin.master.yes") : t("admin.master.no")),
    },
    {
      key: "quota",
      header: t("admin.time.hol.col.quota"),
      width: "10rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => {
        // Counting the loaded child rows of the SELECTED calendar only; other
        // rows show their quota alone rather than a number we have not read.
        if (row.id !== selected?.id) {
          return row.total_holiday_quota === null
            ? dash(null)
            : String(row.total_holiday_quota);
        }
        const actual = (holidays.data ?? []).length;
        return row.total_holiday_quota === null
          ? t("admin.time.hol.quotaUnset", { actual })
          : t("admin.time.hol.quotaOf", { actual, quota: row.total_holiday_quota });
      },
    },
    {
      key: "is_active",
      header: t("admin.master.col.status"),
      width: "8rem",
      hideBelow: "md",
      render: (row) => (
        <StatusChip status={row.is_active ? "active" : "inactive"} map={MASTER_STATUS_MAP} />
      ),
    },
    {
      key: "actions",
      header: t("admin.master.col.actions"),
      align: "right",
      width: "11rem",
      render: (row) => (
        <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={() => calendarForm.openEdit(row)}>
            {t("admin.master.action.edit")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRetiring(row)}>
            {t("admin.master.action.retire")}
          </Button>
        </span>
      ),
    },
  ];

  const holidayColumns: DataGridColumn<Holiday>[] = [
    {
      key: "holiday_date",
      header: t("admin.time.hol.col.date"),
      width: "12rem",
      sortable: true,
      sortValue: (row) => row.holiday_date,
      render: (row) => fmtCivilDateWeekday(row.holiday_date),
    },
    {
      key: "name",
      header: t("admin.time.hol.col.holiday"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.name}</span>
          {row.local_name === null ? null : (
            <span className="text-xs text-muted-foreground">{row.local_name}</span>
          )}
        </span>
      ),
    },
    {
      key: "holiday_type",
      header: t("admin.time.hol.col.type"),
      width: "9rem",
      hideBelow: "md",
      render: (row) =>
        HOLIDAY_TYPES.find((type) => type.value === row.holiday_type)?.label ??
        dash(row.holiday_type),
    },
    {
      key: "is_paid",
      header: t("admin.time.hol.col.paid"),
      width: "6rem",
      hideBelow: "lg",
      render: (row) => (row.is_paid ? t("admin.master.yes") : t("admin.master.no")),
    },
    {
      key: "is_optional",
      header: t("admin.time.hol.col.optional"),
      width: "7rem",
      hideBelow: "lg",
      render: (row) => (row.is_optional ? t("admin.master.yes") : t("admin.master.no")),
    },
    {
      key: "worked",
      header: t("admin.time.hol.col.worked"),
      hideBelow: "md",
      render: (row) => workedLabel(row),
    },
    {
      key: "departments",
      header: t("admin.time.hol.col.departments"),
      hideBelow: "lg",
      render: (row) => {
        const ids = row.applies_to_department_ids;
        if (ids === null || ids.length === 0) return t("admin.master.multi.all");
        return ids
          .map((id) => (departments.data ?? []).find((dept) => dept.id === id)?.name ?? dash(null))
          .join(", ");
      },
    },
    {
      key: "is_active",
      header: t("admin.master.col.status"),
      width: "8rem",
      render: (row) => (
        <StatusChip status={row.is_active ? "active" : "inactive"} map={MASTER_STATUS_MAP} />
      ),
    },
    {
      key: "actions",
      header: t("admin.master.col.actions"),
      align: "right",
      width: "12rem",
      render: (row) => (
        <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={() => holidayForm.openEdit(row)}>
            {t("admin.master.action.edit")}
          </Button>
          {row.is_active ? (
            <Button variant="ghost" size="sm" onClick={() => setWithdrawing(row)}>
              {t("admin.master.action.deactivate")}
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  function submitCalendar(): void {
    const built = calendarForm.build();
    if (built === null) return;
    if (calendarForm.mode === "create") {
      if (companyId === null) {
        calendarForm.setFormError(t("admin.master.noCompany"));
        return;
      }
      setPendingCalendar({ ...built, payload: { ...built.payload, company_id: companyId } });
      return;
    }
    setPendingCalendar(built);
  }

  async function commitCalendar(reason: string): Promise<void> {
    if (pendingCalendar === null) return;
    try {
      await calendarSave.saveAsync(
        { id: calendarForm.editing?.id ?? null, values: pendingCalendar.payload },
        reason,
      );
      toast.success(
        calendarForm.mode === "create"
          ? t("admin.master.toast.created", { name: pendingCalendar.name })
          : t("admin.master.toast.saved", { name: pendingCalendar.name }),
      );
      setPendingCalendar(null);
      calendarForm.close();
    } catch {
      setPendingCalendar(null);
    }
  }

  function submitHoliday(): void {
    const built = holidayForm.build();
    if (built === null) return;
    setPendingHoliday(built);
  }

  async function commitHoliday(reason: string): Promise<void> {
    if (pendingHoliday === null || selected === null) return;
    const payload = pendingHoliday.payload;
    try {
      if (holidayForm.mode === "create") {
        await holidaySave.saveAsync(
          {
            id: null,
            create: {
              holidayCalendarId: selected.id,
              holidayDate: String(payload["holiday_date"] ?? ""),
              name: String(payload["name"] ?? ""),
              holidayType: String(payload["holiday_type"] ?? "national"),
              isPaid: payload["is_paid"] === true,
              isOptional: payload["is_optional"] === true,
              ...(typeof payload["local_name"] === "string"
                ? { localName: payload["local_name"] }
                : {}),
              ...(Array.isArray(payload["applies_to_department_ids"])
                ? {
                    appliesToDepartmentIds: payload["applies_to_department_ids"] as string[],
                  }
                : {}),
              compensatoryOffIfWorked: payload["compensatory_off_if_worked"] === true,
              workingIfEventBooked: payload["working_if_event_booked"] === true,
              ...(typeof payload["pay_multiplier_if_worked"] === "number"
                ? { payMultiplierIfWorked: payload["pay_multiplier_if_worked"] }
                : {}),
              ...(typeof payload["description"] === "string"
                ? { description: payload["description"] }
                : {}),
            },
          },
          reason,
        );
      } else {
        await holidaySave.saveAsync(
          { id: holidayForm.editing?.id ?? "", patch: payload },
          reason,
        );
      }
      toast.success(
        holidayForm.mode === "create"
          ? t("admin.master.toast.created", { name: pendingHoliday.name })
          : t("admin.master.toast.saved", { name: pendingHoliday.name }),
      );
      setPendingHoliday(null);
      holidayForm.close();
    } catch {
      setPendingHoliday(null);
    }
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarDays}
        title={t("admin.time.hol.title")}
        subtitle={t("admin.time.hol.subtitle")}
        actions={
          <Button
            onClick={() =>
              calendarForm.openCreate({
                ...BASE_CREATE_DEFAULTS,
                year: nowIstDate().slice(0, 4),
                state: "Karnataka",
                is_default: "false",
                optional_holiday_quota: "2",
              })
            }
          >
            {t("admin.master.new", { entity: t("admin.time.hol.calendar.entity") })}
          </Button>
        }
      />

      <MasterBanner>{t("admin.time.hol.banner")}</MasterBanner>

      <h2 className="mb-3 font-display text-lg font-semibold">{t("admin.time.hol.calendars")}</h2>

      <StateBoundary
        loading={calendars.isLoading}
        error={calendars.error ?? undefined}
        onRetry={() => void calendars.refetch()}
        skeletonRows={3}
      >
        <DataGrid
          columns={calendarColumns}
          rows={calendars.data ?? []}
          rowKey={(row) => row.id}
          pageSize={10}
          onRowClick={(row) => setSelectedId(row.id)}
          toolbar={
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(event) => setIncludeInactive(event.target.checked)}
                className="h-4 w-4 rounded border-input text-primary"
              />
              {t("admin.master.filter.includeInactive")}
            </label>
          }
          emptyState={
            <EmptyState
              icon={CalendarDays}
              title={t("admin.master.empty.title", {
                entity: t("admin.time.hol.calendar.entity"),
              })}
              hint={t("admin.master.empty.hint")}
            />
          }
        />
      </StateBoundary>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">
          {selected === null
            ? t("admin.time.hol.pick")
            : t("admin.time.hol.holidays", { name: selected.name })}
        </h2>
        {selected === null ? null : (
          <Button
            variant="outline"
            onClick={() =>
              holidayForm.openCreate({
                holiday_type: "national",
                is_paid: "true",
                is_optional: "false",
                is_active: "true",
                working_if_event_booked: "true",
                compensatory_off_if_worked: "true",
                pay_multiplier_if_worked: "2",
              })
            }
          >
            {t("admin.master.new", { entity: t("admin.time.hol.holiday.entity") })}
          </Button>
        )}
      </div>

      <div className="mt-3">
        <StateBoundary
          loading={selected !== null && holidays.isLoading}
          error={holidays.error ?? undefined}
          onRetry={() => void holidays.refetch()}
          partialError={departments.error ?? undefined}
          partialLabel={t("admin.time.hol.col.departments")}
          isEmpty={selected === null}
          empty={
            <EmptyState
              icon={CalendarDays}
              title={t("admin.time.hol.pick")}
              hint={t("admin.master.empty.hint")}
            />
          }
          skeletonRows={5}
        >
          <DataGrid
            columns={holidayColumns}
            rows={holidays.data ?? []}
            rowKey={(row) => row.id}
            pageSize={25}
            onRowClick={(row) => holidayForm.openEdit(row)}
            emptyState={
              <EmptyState
                icon={CalendarDays}
                title={t("admin.time.hol.empty.title")}
                hint={t("admin.time.hol.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </div>

      <MasterFormSheet
        open={calendarForm.open}
        mode={calendarForm.mode}
        entityLabel={t("admin.time.hol.calendar.entity")}
        rowName={calendarForm.editing?.name ?? null}
        groups={calendarGroups}
        values={calendarForm.values}
        errors={calendarForm.errors}
        pending={calendarSave.isPending}
        serverMessage={calendarSave.userMessage}
        formError={calendarForm.formError}
        onChange={calendarForm.change}
        onSubmit={submitCalendar}
        onClose={calendarForm.close}
      />

      <MasterFormSheet
        open={holidayForm.open}
        mode={holidayForm.mode}
        entityLabel={t("admin.time.hol.holiday.entity")}
        rowName={holidayForm.editing?.name ?? null}
        groups={holidayGroups}
        values={holidayForm.values}
        errors={holidayForm.errors}
        pending={holidaySave.isPending}
        serverMessage={holidaySave.userMessage}
        formError={holidayForm.formError}
        banner={<MasterBanner>{t("admin.time.hol.banner")}</MasterBanner>}
        onChange={holidayForm.change}
        onSubmit={submitHoliday}
        onClose={holidayForm.close}
      />

      {pendingCalendar !== null ? (
        <ReasonDialog
          open
          title={
            calendarForm.mode === "create"
              ? t("admin.master.saveReason.createTitle", {
                  entity: t("admin.time.hol.calendar.entity"),
                })
              : t("admin.master.saveReason.editTitle", { name: pendingCalendar.name })
          }
          description={
            pendingCalendar.changes.length === 0
              ? t("admin.master.changes.created", { name: pendingCalendar.name })
              : t("admin.master.changes.list", { changes: pendingCalendar.changes.join("; ") })
          }
          actorName={actorName}
          confirmLabel={t("admin.master.saveReason.confirm")}
          pending={calendarSave.isPending}
          errorMessage={calendarSave.userMessage}
          onConfirm={(reason) => void commitCalendar(reason)}
          onCancel={() => setPendingCalendar(null)}
        />
      ) : null}

      {pendingHoliday !== null ? (
        <ReasonDialog
          open
          title={
            holidayForm.mode === "create"
              ? t("admin.master.saveReason.createTitle", {
                  entity: t("admin.time.hol.holiday.entity"),
                })
              : t("admin.master.saveReason.editTitle", { name: pendingHoliday.name })
          }
          description={
            pendingHoliday.changes.length === 0
              ? t("admin.master.changes.created", { name: pendingHoliday.name })
              : t("admin.master.changes.list", { changes: pendingHoliday.changes.join("; ") })
          }
          actorName={actorName}
          confirmLabel={t("admin.master.saveReason.confirm")}
          pending={holidaySave.isPending}
          errorMessage={holidaySave.userMessage}
          onConfirm={(reason) => void commitHoliday(reason)}
          onCancel={() => setPendingHoliday(null)}
        />
      ) : null}

      {retiring !== null ? (
        <ReasonDialog
          open
          title={t("admin.master.retire.title", { name: retiring.name })}
          description={t("admin.master.retire.description", { name: retiring.name })}
          actorName={actorName}
          minLength={SENSITIVE_REASON_LENGTH}
          confirmLabel={t("admin.master.retire.confirm")}
          pending={calendarArchive.isPending}
          errorMessage={calendarArchive.userMessage}
          onConfirm={(reason) => {
            const row = retiring;
            void calendarArchive
              .saveAsync({ id: row.id }, reason)
              .then(() => {
                toast.success(t("admin.master.toast.retired", { name: row.name }));
                setRetiring(null);
              })
              .catch(() => undefined);
          }}
          onCancel={() => setRetiring(null)}
        />
      ) : null}

      {withdrawing !== null ? (
        <ReasonDialog
          open
          title={t("admin.time.hol.withdraw.title", { name: withdrawing.name })}
          description={t("admin.time.hol.withdraw.description")}
          actorName={actorName}
          minLength={SENSITIVE_REASON_LENGTH}
          confirmLabel={t("admin.time.hol.withdraw.confirm")}
          pending={holidayWithdraw.isPending}
          errorMessage={holidayWithdraw.userMessage}
          onConfirm={(reason) => {
            const row = withdrawing;
            void holidayWithdraw
              .saveAsync({ id: row.id }, reason)
              .then(() => {
                toast.success(t("admin.time.hol.toast.withdrawn", { name: row.name }));
                setWithdrawing(null);
              })
              .catch(() => undefined);
          }}
          onCancel={() => setWithdrawing(null)}
        />
      ) : null}
    </div>
  );
}
