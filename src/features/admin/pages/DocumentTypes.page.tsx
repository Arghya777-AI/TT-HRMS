/**
 * §9 · /admin/documents/types — Document Type Master. Categories, expiry rules
 * and requirements.
 *
 * These 26 rows are not decoration. `v_document_compliance` reads
 * `is_required_for_onboarding`, `required_for_employment_types` and
 * `required_for_department_ids` to decide what every employee is MISSING;
 * `requires_expiry` decides what can lapse; `visible_to_employee` /
 * `visible_to_manager` are read inside the RLS policies on `documents`, so a
 * tick here changes who can see a file. Every field therefore carries a help
 * line saying what it does in the running system, and a POLICY change always
 * asks for a typed reason — an untyped default sentence is fine for renaming a
 * type, not for making the whole kitchen produce an annual medical certificate.
 *
 * This is the `MasterScreen` shape, hand-rolled: `MasterScreen` is keyed to
 * `ORG_ENTITIES` in `org.api.ts`, `document_types` is not in that registry, and
 * adding it would mean editing a module this screen does not own. The same
 * pieces (`MasterFormSheet`, `masters/fields`, `ReasonDialog`, `DataGrid`) are
 * reused directly, so the form, the coercion and the diff line behave identically.
 *
 * @route /admin/documents/types
 */
import { useMemo, useState } from "react";
import { FileCog, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { useAuth } from "@/app/auth/AuthProvider";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { MasterFormSheet } from "../components/MasterFormSheet";
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
import {
  BASE_CREATE_DEFAULTS,
  descriptionField,
  isActiveField,
  nameField,
  sortOrderField,
} from "../masters/common";
import { useRefOptions } from "../hooks/useMasters";
import { EMPLOYMENT_TYPE_LABELS, employmentTypeValues } from "../api/employees.api";
import {
  useArchiveDocumentType,
  useDocumentTypeCount,
  useDocumentTypes,
  useSaveDocumentType,
} from "../hooks/useDocumentsAdmin";
import {
  allowedMimeValues,
  documentBucketValues,
  documentCategoryValues,
  retentionBasisValues,
  type DocumentCategory,
  type DocumentType,
} from "../api/documents.api";
import { CATEGORY_LABELS, retentionBasisLabel } from "../documents/labels";

const MASTER_STATUS: Readonly<Record<string, StatusChipEntry>> = {
  active: { label: t("admin.master.status.active"), tone: "success" },
  inactive: { label: t("admin.master.status.inactive"), tone: "neutral" },
  retired: { label: t("admin.master.status.retired"), tone: "danger" },
};

/**
 * The fields that change what the SYSTEM demands or who can see a file. Touching
 * any of them opens the reason dialog; renaming a type does not.
 */
const POLICY_FIELDS: readonly string[] = [
  "category",
  "is_required_for_onboarding",
  "required_for_employment_types",
  "required_for_department_ids",
  "requires_expiry",
  "expiry_reminder_days",
  "requires_approval",
  "requires_acknowledgement",
  "acknowledgement_deadline_days",
  "requires_esign",
  "retention_years",
  "retention_basis",
  "is_sensitive",
  "visible_to_employee",
  "visible_to_manager",
  "storage_bucket",
  "allowed_mime_types",
  "max_file_size_mb",
];

/**
 * `public.employment_type`, read from the ONE place the console already declares
 * it — a second hand-written list is how `daily_wage` (which does not exist in
 * the enum) gets written into an array column.
 */
const EMPLOYMENT_TYPE_OPTIONS: readonly { value: string; label: string }[] =
  employmentTypeValues.map((value) => ({ value, label: EMPLOYMENT_TYPE_LABELS[value] }));

/**
 * This table's own code shape, NOT the shared `CODE_PATTERN`.
 *
 * The shared pattern is `^[A-Z0-9][A-Z0-9-]{1,11}$` — no underscore, twelve
 * characters — because that is what the org masters use. `document_types` has no
 * pattern constraint at all, and the 26 seeded rows include
 * `APPOINTMENT_LETTER`, `POLICE_VERIFICATION` and `FIRE_SAFETY_CERT`. Reusing the
 * org pattern would make it impossible to CREATE a type that looks like the ones
 * already there, which is how a master ends up with two naming conventions.
 */
const DOC_TYPE_CODE_FIELD: FieldSpec = {
  name: "code",
  label: t("admin.master.field.code"),
  kind: "code",
  help: t("admin.master.help.code"),
  required: true,
  createOnly: true,
  maxLength: 24,
  pattern: {
    re: /^[A-Z0-9][A-Z0-9_]{1,23}$/,
    messageKey: "admin.docs.types.err.pattern.code",
  },
};

type PendingAction =
  | {
      readonly kind: "save";
      readonly mode: "create" | "edit";
      readonly id: string | null;
      readonly values: Record<string, unknown>;
      readonly name: string;
      readonly changes: readonly string[];
    }
  | { readonly kind: "archive"; readonly row: DocumentType };

export default function DocumentTypesPage() {
  const actorName = useAuth().employee?.displayName ?? null;

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<DocumentCategory | "">("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [archivedOnly, setArchivedOnly] = useState(false);

  const departments = useRefOptions("departments");

  const filters = useMemo(
    () => ({
      includeInactive: includeInactive || archivedOnly,
      archived: archivedOnly,
      ...(category !== "" ? { categories: [category] } : {}),
    }),
    [includeInactive, archivedOnly, category],
  );

  const query = useDocumentTypes(filters);
  const total = useDocumentTypeCount(filters);

  const [formOpen, setFormOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [editing, setEditing] = useState<DocumentType | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<FormValues>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const save = useSaveDocumentType();
  const promptedSave = useSaveDocumentType({ alwaysPrompt: true });
  const archive = useArchiveDocumentType();

  const groups: readonly FieldGroup[] = useMemo(() => {
    const categoryField: FieldSpec = {
      name: "category",
      label: t("admin.docs.types.field.category"),
      kind: "select",
      help: t("admin.docs.types.help.category"),
      required: true,
      options: documentCategoryValues.map((value) => ({
        value,
        label: CATEGORY_LABELS[value],
      })),
    };
    return [
      {
        title: t("admin.master.group.identity"),
        fields: [
          DOC_TYPE_CODE_FIELD,
          nameField,
          descriptionField,
          sortOrderField,
          categoryField,
          isActiveField,
        ],
      },
      {
        title: t("admin.docs.types.group.required"),
        hint: t("admin.docs.types.group.requiredHint"),
        fields: [
          {
            name: "is_required_for_onboarding",
            label: t("admin.docs.types.field.onboarding"),
            kind: "checkbox",
            help: t("admin.docs.types.help.onboarding"),
          },
          {
            name: "required_for_employment_types",
            label: t("admin.docs.types.field.empTypes"),
            kind: "multi",
            help: t("admin.docs.types.help.empTypes"),
            options: EMPLOYMENT_TYPE_OPTIONS,
            wide: true,
          },
          {
            name: "required_for_department_ids",
            label: t("admin.docs.types.field.departments"),
            kind: "multi",
            help: t("admin.docs.types.help.departments"),
            options: refOptions(departments.data),
            wide: true,
          },
        ],
      },
      {
        title: t("admin.docs.types.group.lifecycle"),
        fields: [
          {
            name: "requires_expiry",
            label: t("admin.docs.types.field.requiresExpiry"),
            kind: "checkbox",
            help: t("admin.docs.types.help.requiresExpiry"),
          },
          {
            name: "expiry_reminder_days",
            label: t("admin.docs.types.field.reminderDays"),
            kind: "dowList",
            help: t("admin.docs.types.help.reminderDays"),
            placeholder: "60,30,14,7,1",
          },
          {
            name: "requires_approval",
            label: t("admin.docs.types.field.requiresApproval"),
            kind: "checkbox",
            help: t("admin.docs.types.help.requiresApproval"),
          },
          {
            name: "requires_acknowledgement",
            label: t("admin.docs.types.field.requiresAck"),
            kind: "checkbox",
            help: t("admin.docs.types.help.requiresAck"),
          },
          {
            name: "acknowledgement_deadline_days",
            label: t("admin.docs.types.field.ackDays"),
            kind: "number",
            help: t("admin.docs.types.help.ackDays"),
            min: 1,
            max: 365,
          },
          {
            name: "requires_esign",
            label: t("admin.docs.types.field.requiresEsign"),
            kind: "checkbox",
            help: t("admin.docs.types.help.requiresEsign"),
          },
        ],
      },
      {
        title: t("admin.docs.types.group.storage"),
        fields: [
          {
            name: "storage_bucket",
            label: t("admin.docs.types.field.bucket"),
            kind: "select",
            help: t("admin.docs.types.help.bucket"),
            required: true,
            options: documentBucketValues.map((value) => ({ value, label: value })),
          },
          {
            name: "max_file_size_mb",
            label: t("admin.docs.types.field.maxSize"),
            kind: "number",
            help: t("admin.docs.types.help.maxSize"),
            min: 1,
            max: 200,
          },
          {
            name: "allowed_mime_types",
            label: t("admin.docs.types.field.mimeTypes"),
            kind: "multi",
            help: t("admin.docs.types.help.mimeTypes"),
            options: allowedMimeValues.map((value) => ({ value, label: value })),
            wide: true,
          },
          {
            name: "retention_years",
            label: t("admin.docs.types.field.retentionYears"),
            kind: "number",
            help: t("admin.docs.types.help.retentionYears"),
            min: 0,
            max: 99,
          },
          {
            name: "retention_basis",
            label: t("admin.docs.types.field.retentionBasis"),
            kind: "select",
            help: t("admin.docs.types.help.retentionBasis"),
            required: true,
            options: retentionBasisValues.map((value) => ({
              value,
              label: retentionBasisLabel(value),
            })),
          },
        ],
      },
      {
        title: t("admin.docs.types.group.visibility"),
        hint: t("admin.docs.types.group.visibilityHint"),
        fields: [
          {
            name: "is_sensitive",
            label: t("admin.docs.types.field.sensitive"),
            kind: "checkbox",
            help: t("admin.docs.types.help.sensitive"),
          },
          {
            name: "visible_to_employee",
            label: t("admin.docs.types.field.visibleEmployee"),
            kind: "checkbox",
            help: t("admin.docs.types.help.visibleEmployee"),
          },
          {
            name: "visible_to_manager",
            label: t("admin.docs.types.field.visibleManager"),
            kind: "checkbox",
            help: t("admin.docs.types.help.visibleManager"),
          },
        ],
      },
    ];
  }, [departments.data]);

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === "") return all;
    // A presentation filter over an already-loaded master (≤500 rows).
    return all.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.code.toLowerCase().includes(needle),
    );
  }, [query.data, search]);

  function openCreate(): void {
    const base = valuesFromRow(groups, null);
    setMode("create");
    setEditing(null);
    setValues({
      ...base,
      ...BASE_CREATE_DEFAULTS,
      category: "employment",
      storage_bucket: "documents",
      retention_basis: "from_exit",
      retention_years: "8",
      max_file_size_mb: "10",
      expiry_reminder_days: "1,7,14,30,60",
      allowed_mime_types: "application/pdf,image/jpeg,image/png",
      visible_to_employee: "true",
    });
    setOriginal({});
    setErrors({});
    setFormError(null);
    save.reset();
    promptedSave.reset();
    setFormOpen(true);
  }

  function openEdit(row: DocumentType): void {
    const base = valuesFromRow(groups, row as unknown as Record<string, unknown>);
    setMode("edit");
    setEditing(row);
    setValues(base);
    setOriginal(base);
    setErrors({});
    setFormError(null);
    save.reset();
    promptedSave.reset();
    setFormOpen(true);
  }

  function submitForm(): void {
    const fieldErrors = validateFields(groups, values, mode);
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    // Mirrors `ck_document_types__ack_deadline` + the seed's own convention.
    if (values["requires_acknowledgement"] === "true" && (values["acknowledgement_deadline_days"] ?? "").trim() === "") {
      setFormError(t("admin.docs.types.err.ackDaysNeeded"));
      return;
    }
    setFormError(null);

    const payload = coerceValues(groups, values, mode, mode === "edit" ? original : null);
    if (mode === "edit" && Object.keys(payload).length === 0) {
      setFormError(t("admin.master.changes.none"));
      return;
    }

    const name = (values["name"] ?? editing?.name ?? "").trim();
    const action: PendingAction = {
      kind: "save",
      mode,
      id: editing?.id ?? null,
      values: payload,
      name,
      changes: mode === "edit" ? changeSummary(groups, original, values) : [],
    };

    const touchesPolicy =
      mode === "create" || POLICY_FIELDS.some((field) => field in payload);
    if (touchesPolicy) {
      setPending(action);
      return;
    }
    void runSave(action);
  }

  async function runSave(
    action: Extract<PendingAction, { kind: "save" }>,
    reason?: string,
  ): Promise<void> {
    const mutation = reason === undefined ? save : promptedSave;
    try {
      await mutation.saveAsync({ id: action.id, values: action.values }, reason);
      toast.success(
        action.mode === "create"
          ? t("admin.master.toast.created", { name: action.name })
          : t("admin.master.toast.saved", { name: action.name }),
      );
      setPending(null);
      setFormOpen(false);
    } catch {
      // The sentence is on `userMessage`; the form stays open with the typing.
      setPending(null);
    }
  }

  async function runArchive(row: DocumentType, reason: string): Promise<void> {
    try {
      await archive.saveAsync({ id: row.id }, reason);
      toast.success(t("admin.master.toast.retired", { name: row.name }));
      setPending(null);
    } catch {
      /* surfaced in the dialog via archive.userMessage */
    }
  }

  const columns: DataGridColumn<DocumentType>[] = [
    {
      key: "name",
      header: t("admin.master.field.name"),
      sortable: true,
      sortValue: (row) => row.name,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.name}</span>
          <span className="num text-xs text-muted-foreground">{row.code}</span>
        </span>
      ),
    },
    {
      key: "category",
      header: t("admin.docs.types.col.category"),
      width: "10rem",
      sortable: true,
      sortValue: (row) => CATEGORY_LABELS[row.category],
      render: (row) => CATEGORY_LABELS[row.category],
    },
    {
      key: "is_required_for_onboarding",
      header: t("admin.docs.types.col.required"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => {
        const bits: string[] = [];
        if (row.is_required_for_onboarding) bits.push(t("admin.docs.types.req.everyone"));
        if ((row.required_for_employment_types ?? []).length > 0)
          bits.push(
            t("admin.docs.types.req.byType", {
              n: formatNumber((row.required_for_employment_types ?? []).length),
            }),
          );
        if ((row.required_for_department_ids ?? []).length > 0)
          bits.push(
            t("admin.docs.types.req.byDept", {
              n: formatNumber((row.required_for_department_ids ?? []).length),
            }),
          );
        return bits.length === 0 ? t("admin.docs.types.req.optional") : bits.join(" · ");
      },
    },
    {
      key: "requires_expiry",
      header: t("admin.docs.types.col.expiry"),
      width: "7rem",
      hideBelow: "lg",
      render: (row) => (row.requires_expiry ? t("admin.master.yes") : t("admin.master.no")),
    },
    {
      key: "requires_acknowledgement",
      header: t("admin.docs.types.col.ack"),
      width: "9rem",
      hideBelow: "lg",
      render: (row) =>
        row.requires_acknowledgement
          ? row.acknowledgement_deadline_days === null
            ? t("admin.master.yes")
            : t("admin.docs.types.ackWithin", {
                n: formatNumber(row.acknowledgement_deadline_days),
              })
          : t("admin.master.no"),
    },
    {
      key: "requires_esign",
      header: t("admin.docs.types.col.esign"),
      width: "7rem",
      hideBelow: "lg",
      render: (row) => (row.requires_esign ? t("admin.master.yes") : t("admin.master.no")),
    },
    {
      key: "visible_to_employee",
      header: t("admin.docs.types.col.visibility"),
      width: "11rem",
      hideBelow: "lg",
      render: (row) => {
        const who: string[] = [];
        if (row.visible_to_employee) who.push(t("admin.docs.types.vis.employee"));
        if (row.visible_to_manager) who.push(t("admin.docs.types.vis.manager"));
        return who.length === 0 ? t("admin.docs.types.vis.hrOnly") : who.join(" · ");
      },
    },
    {
      key: "retention_years",
      header: t("admin.docs.types.col.retention"),
      width: "11rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => (
        <span className="num">
          {t("admin.docs.types.retentionValue", {
            years: formatNumber(row.retention_years),
            basis: retentionBasisLabel(row.retention_basis),
          })}
        </span>
      ),
    },
    {
      key: "is_active",
      header: t("admin.master.col.status"),
      width: "8rem",
      render: (row) => (
        <StatusChip
          status={archivedOnly ? "retired" : row.is_active ? "active" : "inactive"}
          map={MASTER_STATUS}
        />
      ),
    },
    {
      key: "actions",
      header: t("admin.master.col.actions"),
      align: "right",
      width: "11rem",
      render: (row) => (
        <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
            {t("admin.master.action.edit")}
          </Button>
          {archivedOnly ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPending({ kind: "archive", row })}
            >
              {t("admin.master.action.retire")}
            </Button>
          )}
        </span>
      ),
    },
  ];

  const filtersOn = search.trim() !== "" || category !== "" || includeInactive || archivedOnly;
  const savePending = save.isPending || promptedSave.isPending;
  const saveMessage = promptedSave.userMessage ?? save.userMessage;

  return (
    <div className="container py-6">
      <PageHeader
        icon={FileCog}
        title={t("admin.docs.types.title")}
        subtitle={
          total.isSuccess
            ? t("admin.docs.types.subtitle", { n: formatNumber(total.data) })
            : t("admin.docs.types.subtitlePlain")
        }
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            {t("admin.docs.types.new")}
          </Button>
        }
      />

      <div className="mt-4">
        <Notice tone="info">{t("admin.docs.types.banner")}</Notice>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          partialError={total.error ?? departments.error}
          partialLabel={t("admin.docs.types.partial")}
          skeletonRows={6}
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={25}
            onRowClick={(row) => openEdit(row)}
            toolbar={
              <>
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("admin.master.search")}
                  aria-label={t("admin.master.search")}
                  className="h-9 w-full sm:w-64"
                />
                <select
                  value={category}
                  onChange={(event) => setCategory(event.target.value as DocumentCategory | "")}
                  aria-label={t("admin.docs.types.col.category")}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">{t("admin.docs.repo.filter.anyCategory")}</option>
                  {documentCategoryValues.map((value) => (
                    <option key={value} value={value}>
                      {CATEGORY_LABELS[value]}
                    </option>
                  ))}
                </select>
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
                  icon={FileCog}
                  title={t("admin.master.emptyFiltered.title")}
                  hint={t("admin.master.emptyFiltered.hint")}
                />
              ) : (
                <EmptyState
                  icon={FileCog}
                  title={t("admin.docs.types.empty.title")}
                  hint={t("admin.docs.types.empty.hint")}
                  action={<Button onClick={openCreate}>{t("admin.docs.types.new")}</Button>}
                />
              )
            }
          />
        </StateBoundary>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.docs.types.footnote")}</p>

      <MasterFormSheet
        open={formOpen}
        mode={mode}
        entityLabel={t("admin.docs.types.entity")}
        rowName={editing?.name ?? null}
        groups={groups}
        values={values}
        errors={errors}
        pending={savePending}
        serverMessage={saveMessage}
        formError={formError}
        banner={<Notice tone="info">{t("admin.docs.types.formBanner")}</Notice>}
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
        onClose={() => {
          setFormOpen(false);
          setPending(null);
        }}
      />

      {pending?.kind === "save" ? (
        <ReasonDialog
          open
          title={
            pending.mode === "create"
              ? t("admin.docs.types.reason.createTitle")
              : t("admin.docs.types.reason.editTitle", { name: pending.name })
          }
          description={
            pending.mode === "create"
              ? t("admin.master.changes.created", { name: pending.name })
              : pending.changes.length === 0
                ? t("admin.master.changes.none")
                : t("admin.master.changes.list", { changes: pending.changes.join("; ") })
          }
          actorName={actorName}
          confirmLabel={t("admin.master.saveReason.confirm")}
          pending={promptedSave.isPending}
          errorMessage={promptedSave.userMessage}
          onConfirm={(reason) => void runSave(pending, reason)}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === "archive" ? (
        <ReasonDialog
          open
          title={t("admin.master.retire.title", { name: pending.row.name })}
          description={t("admin.docs.types.retire.description", { name: pending.row.name })}
          actorName={actorName}
          minLength={SENSITIVE_REASON_LENGTH}
          confirmLabel={t("admin.master.retire.confirm")}
          pending={archive.isPending}
          errorMessage={archive.userMessage}
          onConfirm={(reason) => void runArchive(pending.row, reason)}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}
