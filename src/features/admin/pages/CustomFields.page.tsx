/**
 * §3 · /admin/org/custom-fields — Custom Field Designer. Add a venue-specific
 * field to the employee record without a deploy: uniform sizes, locker numbers,
 * mode of commute, willingness for night shifts.
 *
 * WHAT A ROW HERE ACTUALLY DOES, which is why every field carries help text:
 *   * It appears on `/me/profile/custom` and on Employee 360 Tab 5, in this
 *     screen's own `section` → `sort_order` → label order. The designer's list IS
 *     the form's running order.
 *   * `is_employee_editable` + `requires_approval` decide whether the employee
 *     may change it themselves, must raise a change request, or may only read it.
 *     There is no third flag.
 *   * `is_pii` is a real boundary, not a label: `v_team_custom_fields` filters
 *     `NOT is_pii`, so a PII field is invisible to a manager looking at their own
 *     reportee. Turning it off exposes an answer to every manager above that
 *     person, which is why this screen prompts for a reason on every save.
 *   * `field_type` decides which typed column a value lands in, and
 *     `trg_ecfv__validate` enforces the match — so changing the type of a field
 *     that already holds values makes those values fail their next write. The
 *     "values recorded" column exists so that is a visible decision.
 *
 * NOT A POLICY SWITCH (DR-50). The reference product used custom fields as
 * behaviour toggles ("Selfie Attendance", "Dynamic WeekOff Calc"). Nothing here
 * changes system behaviour: these rows are DATA on an employee record. Attendance
 * capture, week-offs and grace live in `attendance_policies` / `weekly_off_rules`,
 * where they get a versioned audit trail of their own.
 *
 * WRITES. `employee_custom_field_defs` is audited (migration 038) but is NOT in
 * `audit.reason_required_tables`, so the database would take a reasonless write.
 * This screen prompts anyway, on every save, retire, deactivate and restore, and
 * the mutation hooks carry NO default reason — a missed prompt has to fail loudly
 * rather than record "admin console: edited a field".
 *
 * NOTHING IS DELETED. Retire is `deleted_at` + a ≥10-character reason
 * (`ck_ecfd__deletion_reason`); `employee_custom_field_values` keeps its rows.
 * Retiring "Locker Number" stops the question, it does not erase the answers.
 *
 * @route /admin/org/custom-fields
 */
import { useMemo, useState, type ReactNode } from "react";
import { Cog, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { useAuth } from "@/app/auth/AuthProvider";
import { dash, formatNumber } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import { authorityOf } from "@/features/profile/api/custom-fields.api";
import type { EditAuthority } from "@/features/profile/types";
import { Notice } from "../components/Notice";
import { MasterFormSheet } from "../components/MasterFormSheet";
import { StatTile } from "../components/StatTile";
import { EMPLOYMENT_TYPE_LABELS, type EmploymentType } from "../api/employees.api";
import {
  CUSTOM_FIELD_CODE_RE,
  CUSTOM_FIELD_ROW_CAP,
  KNOWN_SECTIONS,
  SELECT_FIELD_TYPES,
  VALUE_COUNT_CAP,
  optionsFromList,
  optionsToList,
  optionValues,
  targetingEmploymentTypes,
  type CustomFieldDefAdmin,
  type CustomFieldFilters,
  type CustomFieldType,
} from "../api/custom-fields.api";
import {
  useCustomFieldArchive,
  useCustomFieldCount,
  useCustomFieldDefs,
  useCustomFieldRestore,
  useCustomFieldSave,
  useCustomFieldSetActive,
  useCustomFieldValueCounts,
} from "../hooks/useCustomFieldDefs";
import { useDefaultCompanyId, useRefOptions } from "../hooks/useMasters";
import {
  changeSummary,
  coerceValues,
  refOptions,
  validateFields,
  valuesFromRow,
  type FieldErrors,
  type FieldGroup,
  type FieldSpec,
  type FormValues,
} from "../masters/fields";

/**
 * `ck_ecfd__code`: a letter, then capitals/digits/underscores, 2–64 characters.
 * Deliberately NOT `CODE_PATTERN` from masters/fields.ts — that one is the org
 * masters' 2–12 characters with hyphens and would reject `UNIFORM_SHIRT_SIZE`,
 * which the database accepts.
 */
const CF_CODE_PATTERN = {
  re: CUSTOM_FIELD_CODE_RE,
  messageKey: "admin.org.cf.err.code" as MessageKey,
};

/** `public.custom_field_type` — the eight values the enum allows. */
const TYPE_LABEL: Readonly<Record<CustomFieldType, string>> = {
  text: t("admin.org.cf.type.text"),
  number: t("admin.org.cf.type.number"),
  date: t("admin.org.cf.type.date"),
  boolean: t("admin.org.cf.type.boolean"),
  single_select: t("admin.org.cf.type.singleSelect"),
  multi_select: t("admin.org.cf.type.multiSelect"),
  employee_ref: t("admin.org.cf.type.employeeRef"),
  file: t("admin.org.cf.type.file"),
};

const TYPE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  text: { label: TYPE_LABEL.text, tone: "neutral" },
  number: { label: TYPE_LABEL.number, tone: "neutral" },
  date: { label: TYPE_LABEL.date, tone: "neutral" },
  boolean: { label: TYPE_LABEL.boolean, tone: "neutral" },
  single_select: { label: TYPE_LABEL.single_select, tone: "info" },
  multi_select: { label: TYPE_LABEL.multi_select, tone: "info" },
  employee_ref: { label: TYPE_LABEL.employee_ref, tone: "info" },
  file: { label: TYPE_LABEL.file, tone: "info" },
};

/**
 * Admin-facing wording for the authority pair. The employee surface says "You can
 * edit"; a designer needs to read it the other way round — who is allowed to
 * change this on somebody's record.
 */
const AUTHORITY_CHIP: Readonly<Record<EditAuthority, StatusChipEntry>> = {
  self: { label: t("admin.org.cf.authority.self"), tone: "success" },
  maker_checker: { label: t("admin.org.cf.authority.makerChecker"), tone: "warn" },
  admin_only: { label: t("admin.org.cf.authority.adminOnly"), tone: "neutral" },
  admin_hidden: { label: t("admin.org.cf.authority.adminHidden"), tone: "neutral" },
};

const STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  active: { label: t("admin.master.status.active"), tone: "success" },
  inactive: { label: t("admin.master.status.inactive"), tone: "neutral" },
  retired: { label: t("admin.master.status.retired"), tone: "danger" },
};

function isSelectType(type: string): boolean {
  return (SELECT_FIELD_TYPES as readonly string[]).includes(type);
}

/** The create form's starting point: visible, admin-maintained, not PII. */
const CREATE_DEFAULTS: Readonly<Record<string, string>> = {
  field_type: "text",
  section: "additional",
  sort_order: "100",
  is_active: "true",
  is_required: "false",
  is_employee_editable: "false",
  requires_approval: "true",
  is_pii: "false",
};

type PendingAction =
  | {
      readonly kind: "save";
      readonly mode: "create" | "edit";
      readonly id: string | null;
      readonly values: Record<string, unknown>;
      readonly label: string;
      readonly changes: readonly string[];
    }
  | { readonly kind: "archive"; readonly row: CustomFieldDefAdmin; readonly values: number | null }
  | { readonly kind: "restore"; readonly row: CustomFieldDefAdmin }
  | { readonly kind: "setActive"; readonly row: CustomFieldDefAdmin; readonly isActive: boolean };

export default function CustomFieldsPage() {
  const actorName = useAuth().employee?.displayName ?? null;
  const companyId = useDefaultCompanyId();
  const departments = useRefOptions("departments");

  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [archivedOnly, setArchivedOnly] = useState(false);

  const filters: CustomFieldFilters = useMemo(
    () => ({
      ...(includeInactive ? { includeInactive: true } : {}),
      ...(archivedOnly ? { archived: true } : {}),
    }),
    [includeInactive, archivedOnly],
  );

  const defs = useCustomFieldDefs(filters);

  const defIds = useMemo(() => (defs.data ?? []).map((row) => row.id), [defs.data]);
  const valueCounts = useCustomFieldValueCounts(defIds);
  const valueCountsUnavailable = defIds.length > VALUE_COUNT_CAP;

  const inUse = useCustomFieldCount({});
  const piiFields = useCustomFieldCount({ piiOnly: true });
  const selfService = useCustomFieldCount({ employeeEditableOnly: true });
  const mandatory = useCustomFieldCount({ requiredOnly: true });
  const retired = useCustomFieldCount({ archived: true });

  // ── Form state. The screen owns it, so a rejected save keeps the typing. ────
  const [formOpen, setFormOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [editing, setEditing] = useState<CustomFieldDefAdmin | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<FormValues>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const save = useCustomFieldSave();
  const archive = useCustomFieldArchive();
  const restore = useCustomFieldRestore();
  const setActive = useCustomFieldSetActive();

  const groups = useMemo(() => fieldGroups(values, departments.data), [values, departments.data]);

  const rows = useMemo(() => {
    const all = defs.data ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === "") return all;
    // A presentation filter over an already-loaded master (≤200 rows) — not a
    // request per keystroke, and nothing is counted from it.
    return all.filter(
      (row) =>
        row.label.toLowerCase().includes(needle) ||
        row.code.toLowerCase().includes(needle) ||
        row.section.toLowerCase().includes(needle),
    );
  }, [defs.data, search]);

  function openCreate(): void {
    const base = valuesFromRow(fieldGroups(CREATE_DEFAULTS, departments.data), null);
    const seeded = { ...base, ...CREATE_DEFAULTS };
    setMode("create");
    setEditing(null);
    setValues(seeded);
    setOriginal(seeded);
    setErrors({});
    setFormError(null);
    save.reset();
    setFormOpen(true);
  }

  function openEdit(row: CustomFieldDefAdmin): void {
    const rowGroups = fieldGroups({ field_type: row.field_type }, departments.data);
    const base = valuesFromRow(rowGroups, row as unknown as Record<string, unknown>);
    // `options` is jsonb: the generic stringifier would render '[object Object]',
    // so the form's representation is the option VALUES, comma-separated.
    base["options"] = optionsToList(row.options);
    setMode("edit");
    setEditing(row);
    setValues(base);
    setOriginal(base);
    setErrors({});
    setFormError(null);
    save.reset();
    setFormOpen(true);
  }

  function closeForm(): void {
    setFormOpen(false);
    setPending(null);
  }

  function submitForm(): void {
    const fieldErrors = validateFields(groups, values, mode);
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    const crossField = crossFieldError(values);
    setFormError(crossField);
    if (crossField !== null) return;

    let payload = coerceValues(groups, values, mode, mode === "edit" ? original : null);

    // `options` travels as a typed list and must land as the jsonb ARRAY that
    // `ck_ecfd__options` demands and `trg_ecfv__validate` reads via `o->>'value'`.
    if (Object.prototype.hasOwnProperty.call(payload, "options")) {
      const raw = payload["options"];
      payload = { ...payload, options: typeof raw === "string" ? optionsFromList(raw) : null };
    }
    const type = values["field_type"] ?? "";
    if (!isSelectType(type)) {
      // A leftover options array on a text field is inert but misleading; clear it
      // when the type is (or has become) something that has no options.
      const had = editing !== null && optionValues(editing.options).length > 0;
      if (mode === "create" || had) payload = { ...payload, options: null };
    }

    if (mode === "create") {
      if (companyId === null) {
        setFormError(t("admin.master.noCompany"));
        return;
      }
      payload = { ...payload, company_id: companyId };
    }

    if (mode === "edit" && Object.keys(payload).length === 0) {
      setFormError(t("admin.master.changes.none"));
      return;
    }

    setPending({
      kind: "save",
      mode,
      id: editing?.id ?? null,
      values: payload,
      label: (values["label"] ?? editing?.label ?? "").trim(),
      changes: mode === "edit" ? changeSummary(groups, original, values) : [],
    });
  }

  async function runSave(
    action: Extract<PendingAction, { kind: "save" }>,
    reason: string,
  ): Promise<void> {
    try {
      await save.saveAsync({ id: action.id, values: action.values }, reason);
      toast.success(
        action.mode === "create"
          ? t("admin.master.toast.created", { name: action.label })
          : t("admin.master.toast.saved", { name: action.label }),
      );
      setPending(null);
      setFormOpen(false);
    } catch {
      // The sentence is on `save.userMessage`, inside the dialog; nothing is lost.
      setPending(null);
    }
  }

  async function runArchive(row: CustomFieldDefAdmin, reason: string): Promise<void> {
    try {
      await archive.saveAsync({ id: row.id }, reason);
      toast.success(t("admin.master.toast.retired", { name: row.label }));
      setPending(null);
    } catch {
      /* surfaced in the dialog via archive.userMessage */
    }
  }

  async function runRestore(row: CustomFieldDefAdmin, reason: string): Promise<void> {
    try {
      await restore.saveAsync({ id: row.id }, reason);
      toast.success(t("admin.org.cf.toast.restored", { name: row.label }));
      setPending(null);
    } catch {
      /* surfaced in the dialog via restore.userMessage */
    }
  }

  async function runSetActive(
    row: CustomFieldDefAdmin,
    isActive: boolean,
    reason: string,
  ): Promise<void> {
    try {
      await setActive.saveAsync({ id: row.id, isActive }, reason);
      toast.success(
        isActive
          ? t("admin.master.toast.reactivated", { name: row.label })
          : t("admin.master.toast.deactivated", { name: row.label }),
      );
      setPending(null);
    } catch {
      /* surfaced in the dialog via setActive.userMessage */
    }
  }

  const columns: DataGridColumn<CustomFieldDefAdmin>[] = [
    {
      key: "label",
      header: t("admin.org.cf.col.field"),
      sortable: true,
      sortValue: (row) => row.label,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium normal-case">{row.label}</span>
          <span className="num text-xs text-muted-foreground">{row.code}</span>
          {row.help_text !== null && row.help_text.trim() !== "" ? (
            <span className="truncate text-xs text-muted-foreground normal-case">
              {row.help_text}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "field_type",
      header: t("admin.org.cf.col.type"),
      width: "11rem",
      render: (row) => (
        <span className="flex flex-col items-start gap-1">
          <StatusChip status={row.field_type} map={TYPE_CHIP} />
          {isSelectType(row.field_type) ? (
            <span className="text-xs text-muted-foreground normal-case">
              {dash(optionsToList(row.options))}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "section",
      header: t("admin.org.cf.col.section"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="normal-case">{row.section}</span>
          <span className="num text-xs text-muted-foreground">
            {t("admin.org.cf.orderValue", { n: formatNumber(row.sort_order) })}
          </span>
        </span>
      ),
    },
    {
      key: "authority",
      header: t("admin.org.cf.col.authority"),
      width: "13rem",
      hideBelow: "md",
      render: (row) => (
        <span className="flex flex-col items-start gap-1">
          <StatusChip status={authorityOf(row)} map={AUTHORITY_CHIP} />
          {row.is_required ? (
            <span className="text-xs text-muted-foreground">{t("admin.org.cf.requiredFlag")}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "is_pii",
      header: t("admin.org.cf.col.pii"),
      width: "10rem",
      render: (row) =>
        row.is_pii ? (
          <StatusChip
            status="pii"
            map={{ pii: { label: t("admin.org.cf.piiYes"), tone: "warn" } }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">{t("admin.org.cf.piiNo")}</span>
        ),
    },
    {
      key: "values",
      header: t("admin.org.cf.col.values"),
      width: "9rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => {
        if (valueCountsUnavailable) {
          return <span className="text-xs text-muted-foreground">{t("common.empty")}</span>;
        }
        if (valueCounts.error !== null) {
          return <span className="text-xs text-muted-foreground">{t("common.empty")}</span>;
        }
        const count = valueCounts.data?.get(row.id);
        return (
          <span className="num">{count === undefined ? t("common.empty") : formatNumber(count)}</span>
        );
      },
    },
    {
      key: "targeting",
      header: t("admin.org.cf.col.appliesTo"),
      hideBelow: "lg",
      render: (row) => <TargetingCell row={row} departments={departments.data} />,
    },
    {
      key: "is_active",
      header: t("admin.master.col.status"),
      width: "8rem",
      render: (row) => (
        <StatusChip
          status={row.deleted_at !== null ? "retired" : row.is_active ? "active" : "inactive"}
          map={STATUS_CHIP}
        />
      ),
    },
    {
      key: "actions",
      header: t("admin.master.col.actions"),
      align: "right",
      width: "15rem",
      render: (row) => (
        <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          {row.deleted_at !== null ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPending({ kind: "restore", row })}
            >
              {t("admin.org.cf.action.restore")}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
                {t("admin.master.action.edit")}
              </Button>
              {row.is_active ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPending({ kind: "setActive", row, isActive: false })}
                >
                  {t("admin.master.action.deactivate")}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPending({ kind: "setActive", row, isActive: true })}
                >
                  {t("admin.master.action.reactivate")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setPending({
                    kind: "archive",
                    row,
                    values: valueCounts.data?.get(row.id) ?? null,
                  })
                }
              >
                {t("admin.master.action.retire")}
              </Button>
            </>
          )}
        </span>
      ),
    },
  ];

  const filtersOn = search.trim() !== "" || includeInactive || archivedOnly;
  const capped = (defs.data ?? []).length >= CUSTOM_FIELD_ROW_CAP;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Cog}
        title={t("admin.org.cf.title")}
        subtitle={t("admin.org.cf.subtitle")}
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            {t("admin.org.cf.new")}
          </Button>
        }
      />

      <Notice tone="info" className="mb-4">
        {t("admin.org.cf.banner")}
      </Notice>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label={t("admin.org.cf.tile.inUse")}
          hint={t("admin.org.cf.tile.inUseHint")}
          source={t("admin.org.cf.source.inUse")}
          query={inUse}
        />
        <StatTile
          label={t("admin.org.cf.tile.pii")}
          hint={t("admin.org.cf.tile.piiHint")}
          source={t("admin.org.cf.source.pii")}
          query={piiFields}
        />
        <StatTile
          label={t("admin.org.cf.tile.selfService")}
          hint={t("admin.org.cf.tile.selfServiceHint")}
          source={t("admin.org.cf.source.selfService")}
          query={selfService}
        />
        <StatTile
          label={t("admin.org.cf.tile.required")}
          hint={t("admin.org.cf.tile.requiredHint")}
          source={t("admin.org.cf.source.required")}
          query={mandatory}
        />
        <StatTile
          label={t("admin.org.cf.tile.retired")}
          hint={t("admin.org.cf.tile.retiredHint")}
          source={t("admin.org.cf.source.retired")}
          query={retired}
        />
      </div>

      {capped ? (
        <Notice tone="warning" className="mt-4">
          {t("admin.common.rowCap", { count: CUSTOM_FIELD_ROW_CAP })}
        </Notice>
      ) : null}

      {valueCountsUnavailable ? (
        <Notice tone="warning" className="mt-4">
          {t("admin.org.cf.valueCountsUnavailable", { cap: formatNumber(VALUE_COUNT_CAP) })}
        </Notice>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={defs.isPending}
          error={defs.error}
          onRetry={() => void defs.refetch()}
          partialError={departments.error ?? valueCounts.error ?? undefined}
          partialLabel={t("admin.org.cf.partial")}
          skeletonRows={6}
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={25}
            onRowClick={(row) => {
              if (row.deleted_at === null) openEdit(row);
            }}
            toolbar={
              <>
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("admin.org.cf.search")}
                  aria-label={t("admin.org.cf.search")}
                  className="h-9 w-full sm:w-64"
                />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={includeInactive}
                    onChange={(event) => setIncludeInactive(event.target.checked)}
                    className="h-4 w-4 rounded border-input text-primary"
                  />
                  {t("admin.master.filter.includeInactive")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={archivedOnly}
                    onChange={(event) => setArchivedOnly(event.target.checked)}
                    className="h-4 w-4 rounded border-input text-primary"
                  />
                  {t("admin.master.filter.archived")}
                </label>
              </>
            }
            emptyState={
              filtersOn ? (
                <EmptyState
                  icon={Cog}
                  title={t("admin.master.emptyFiltered.title")}
                  hint={t("admin.master.emptyFiltered.hint")}
                />
              ) : (
                <EmptyState
                  icon={Cog}
                  title={t("admin.org.cf.empty.title")}
                  hint={t("admin.org.cf.empty.hint")}
                  action={<Button onClick={openCreate}>{t("admin.org.cf.new")}</Button>}
                />
              )
            }
          />
        </StateBoundary>
      </div>

      <MasterFormSheet
        open={formOpen}
        mode={mode}
        entityLabel={t("admin.org.cf.entity")}
        rowName={editing?.label ?? null}
        groups={groups}
        values={values}
        errors={errors}
        pending={save.isPending}
        serverMessage={save.userMessage}
        formError={formError}
        banner={<FormBanner values={values} editing={editing} />}
        onChange={(name, value) => {
          setValues((prev) => ({ ...prev, [name]: value }));
          setErrors((prev) => {
            if (prev[name] === undefined) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
          });
          setFormError(null);
        }}
        onSubmit={submitForm}
        onClose={closeForm}
      />

      {renderDialog()}

      <div className="mt-4">
        <Notice tone="info">{t("admin.org.cf.footnote")}</Notice>
      </div>
    </div>
  );

  function renderDialog(): ReactNode {
    if (pending === null) return null;

    if (pending.kind === "save") {
      const description =
        pending.mode === "create"
          ? t("admin.master.changes.created", { name: pending.label })
          : pending.changes.length === 0
            ? t("admin.master.changes.none")
            : t("admin.master.changes.list", { changes: pending.changes.join("; ") });
      return (
        <ReasonDialog
          open
          title={
            pending.mode === "create"
              ? t("admin.org.cf.reason.createTitle")
              : t("admin.org.cf.reason.editTitle", { name: pending.label })
          }
          description={description}
          actorName={actorName}
          confirmLabel={t("admin.master.saveReason.confirm")}
          pending={save.isPending}
          errorMessage={save.userMessage}
          onConfirm={(reason) => void runSave(pending, reason)}
          onCancel={() => setPending(null)}
        />
      );
    }

    if (pending.kind === "archive") {
      return (
        <ReasonDialog
          open
          title={t("admin.org.cf.reason.retireTitle", { name: pending.row.label })}
          description={
            pending.values === null || pending.values === 0
              ? t("admin.org.cf.reason.retireNoValues", { name: pending.row.label })
              : t("admin.org.cf.reason.retireWithValues", {
                  name: pending.row.label,
                  count: formatNumber(pending.values),
                })
          }
          actorName={actorName}
          minLength={SENSITIVE_REASON_LENGTH}
          confirmLabel={t("admin.master.retire.confirm")}
          pending={archive.isPending}
          errorMessage={archive.userMessage}
          onConfirm={(reason) => void runArchive(pending.row, reason)}
          onCancel={() => setPending(null)}
        />
      );
    }

    if (pending.kind === "restore") {
      return (
        <ReasonDialog
          open
          title={t("admin.org.cf.reason.restoreTitle", { name: pending.row.label })}
          description={t("admin.org.cf.reason.restoreDescription", { name: pending.row.label })}
          actorName={actorName}
          minLength={SENSITIVE_REASON_LENGTH}
          confirmLabel={t("admin.org.cf.action.restore")}
          pending={restore.isPending}
          errorMessage={restore.userMessage}
          onConfirm={(reason) => void runRestore(pending.row, reason)}
          onCancel={() => setPending(null)}
        />
      );
    }

    return (
      <ReasonDialog
        open
        title={
          pending.isActive
            ? t("admin.master.reactivate.title", { name: pending.row.label })
            : t("admin.master.deactivate.title", { name: pending.row.label })
        }
        description={
          pending.isActive
            ? t("admin.org.cf.reason.reactivate", { name: pending.row.label })
            : t("admin.org.cf.reason.deactivate", { name: pending.row.label })
        }
        actorName={actorName}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={
          pending.isActive
            ? t("admin.master.reactivate.confirm")
            : t("admin.master.deactivate.confirm")
        }
        pending={setActive.isPending}
        errorMessage={setActive.userMessage}
        onConfirm={(reason) => void runSetActive(pending.row, pending.isActive, reason)}
        onCancel={() => setPending(null)}
      />
    );
  }
}

// -----------------------------------------------------------------------------
// The field model — it changes with the chosen type, because the database does
// -----------------------------------------------------------------------------

/**
 * `field_type` decides which columns mean anything: `options` is required for the
 * two select types (`ck_ecfd__options`), `validation_regex` is applied to text
 * only and `min_value`/`max_value` to numbers only (`trg_ecfv__validate`). The
 * form therefore shows exactly the fields that will be honoured, so an admin
 * cannot set a minimum on a date and wonder why nothing enforces it.
 */
function fieldGroups(
  values: FormValues,
  departments: readonly { readonly id: string; readonly name: string }[] | undefined,
): FieldGroup[] {
  const type = values["field_type"] ?? "text";
  const groups: FieldGroup[] = [
    {
      title: t("admin.org.cf.group.identity"),
      hint: t("admin.org.cf.group.identityHint"),
      fields: [
        {
          name: "code",
          label: t("admin.org.cf.field.code"),
          kind: "code",
          help: t("admin.org.cf.help.code"),
          required: true,
          createOnly: true,
          maxLength: 64,
          pattern: CF_CODE_PATTERN,
        },
        {
          name: "label",
          label: t("admin.org.cf.field.label"),
          kind: "text",
          help: t("admin.org.cf.help.label"),
          required: true,
          maxLength: 120,
        },
        {
          name: "help_text",
          label: t("admin.org.cf.field.helpText"),
          kind: "textarea",
          help: t("admin.org.cf.help.helpText"),
          maxLength: 300,
        },
        {
          name: "field_type",
          label: t("admin.org.cf.field.type"),
          kind: "select",
          help: t("admin.org.cf.help.type"),
          required: true,
          options: (Object.keys(TYPE_LABEL) as CustomFieldType[]).map((value) => ({
            value,
            label: TYPE_LABEL[value],
          })),
        },
        {
          name: "section",
          label: t("admin.org.cf.field.section"),
          kind: "select",
          help: t("admin.org.cf.help.section"),
          required: true,
          options: KNOWN_SECTIONS.map((value) => ({ value, label: sectionLabel(value) })),
        },
        {
          name: "sort_order",
          label: t("admin.org.cf.field.sortOrder"),
          kind: "number",
          help: t("admin.org.cf.help.sortOrder"),
          min: 0,
          max: 9999,
        },
      ],
    },
    {
      title: t("admin.org.cf.group.authority"),
      hint: t("admin.org.cf.group.authorityHint"),
      fields: [
        {
          name: "is_employee_editable",
          label: t("admin.org.cf.field.employeeEditable"),
          kind: "checkbox",
          help: t("admin.org.cf.help.employeeEditable"),
        },
        {
          name: "requires_approval",
          label: t("admin.org.cf.field.requiresApproval"),
          kind: "checkbox",
          help: t("admin.org.cf.help.requiresApproval"),
        },
        {
          name: "is_required",
          label: t("admin.org.cf.field.required"),
          kind: "checkbox",
          help: t("admin.org.cf.help.required"),
        },
        {
          name: "is_pii",
          label: t("admin.org.cf.field.pii"),
          kind: "checkbox",
          help: t("admin.org.cf.help.pii"),
        },
        {
          name: "is_active",
          label: t("admin.org.cf.field.isActive"),
          kind: "checkbox",
          help: t("admin.org.cf.help.isActive"),
        },
      ],
    },
  ];

  if (isSelectType(type)) {
    groups.push({
      title: t("admin.org.cf.group.options"),
      hint: t("admin.org.cf.group.optionsHint"),
      fields: [
        {
          name: "options",
          label: t("admin.org.cf.field.options"),
          kind: "text",
          help: t("admin.org.cf.help.options"),
          required: true,
          wide: true,
          placeholder: t("admin.org.cf.field.optionsPlaceholder"),
        },
      ],
    });
  }

  const validation: FieldSpec[] = [];
  if (type === "text") {
    validation.push({
      name: "validation_regex",
      label: t("admin.org.cf.field.regex"),
      kind: "text",
      help: t("admin.org.cf.help.regex"),
      wide: true,
      maxLength: 200,
      placeholder: "^[A-Z]{2}[0-9]{4}$",
    });
  }
  if (type === "number") {
    validation.push(
      {
        name: "min_value",
        label: t("admin.org.cf.field.min"),
        kind: "decimal",
        help: t("admin.org.cf.help.min"),
      },
      {
        name: "max_value",
        label: t("admin.org.cf.field.max"),
        kind: "decimal",
        help: t("admin.org.cf.help.max"),
      },
    );
  }
  if (validation.length > 0) {
    groups.push({
      title: t("admin.org.cf.group.validation"),
      hint: t("admin.org.cf.group.validationHint"),
      fields: validation,
    });
  }

  groups.push({
    title: t("admin.org.cf.group.targeting"),
    hint: t("admin.org.cf.group.targetingHint"),
    fields: [
      {
        name: "applies_to_employment_types",
        label: t("admin.org.cf.field.employmentTypes"),
        kind: "multi",
        help: t("admin.org.cf.help.employmentTypes"),
        wide: true,
        options: targetingEmploymentTypes.map((value: EmploymentType) => ({
          value,
          label: EMPLOYMENT_TYPE_LABELS[value],
        })),
      },
      {
        name: "applies_to_department_ids",
        label: t("admin.org.cf.field.departments"),
        kind: "multi",
        help: t("admin.org.cf.help.departments"),
        wide: true,
        options: refOptions(departments),
      },
    ],
  });

  return groups;
}

/** `ck_ecfd__minmax` mirrored in the browser, so the round trip is not wasted. */
function crossFieldError(values: FormValues): string | null {
  const min = (values["min_value"] ?? "").trim();
  const max = (values["max_value"] ?? "").trim();
  if (min !== "" && max !== "" && Number(max) < Number(min)) {
    return t("admin.org.cf.err.minMax");
  }
  return null;
}

/** `section` is free text in the schema; these are the groups the profile renders. */
function sectionLabel(section: string): string {
  switch (section) {
    case "uniform":
      return t("admin.org.cf.section.uniform");
    case "transport":
      return t("admin.org.cf.section.transport");
    case "facilities":
      return t("admin.org.cf.section.facilities");
    case "preferences":
      return t("admin.org.cf.section.preferences");
    default:
      return t("admin.org.cf.section.additional");
  }
}

/** Who a definition applies to. An empty array means EVERYONE — never "nobody". */
function TargetingCell({
  row,
  departments,
}: {
  row: CustomFieldDefAdmin;
  departments: readonly { readonly id: string; readonly name: string }[] | undefined;
}) {
  const types = row.applies_to_employment_types ?? [];
  const deptIds = row.applies_to_department_ids ?? [];
  if (types.length === 0 && deptIds.length === 0) {
    return <span className="text-xs text-muted-foreground">{t("admin.org.cf.appliesEveryone")}</span>;
  }
  const typeNames = types
    .map((value) => EMPLOYMENT_TYPE_LABELS[value as EmploymentType] ?? value)
    .join(", ");
  const deptNames = deptIds
    .map((id) => departments?.find((dept) => dept.id === id)?.name ?? t("admin.org.cf.unknownDept"))
    .join(", ");
  return (
    <span className="flex flex-col gap-0.5 text-xs leading-tight">
      {types.length > 0 ? (
        <span>{t("admin.org.cf.appliesTypes", { list: typeNames })}</span>
      ) : null}
      {deptIds.length > 0 ? (
        <span>{t("admin.org.cf.appliesDepts", { list: deptNames })}</span>
      ) : null}
    </span>
  );
}

/** The consequence of the two flags being typed into, said where they are typed. */
function FormBanner({
  values,
  editing,
}: {
  values: FormValues;
  editing: CustomFieldDefAdmin | null;
}) {
  const isPii = values["is_pii"] === "true";
  const typeChanged =
    editing !== null && (values["field_type"] ?? "") !== editing.field_type;
  return (
    <div className="space-y-2">
      <Notice tone={isPii ? "warning" : "info"}>
        {isPii ? t("admin.org.cf.form.piiOn") : t("admin.org.cf.form.piiOff")}
      </Notice>
      {typeChanged ? (
        <Notice tone="warning">{t("admin.org.cf.form.typeChanged")}</Notice>
      ) : null}
    </div>
  );
}
