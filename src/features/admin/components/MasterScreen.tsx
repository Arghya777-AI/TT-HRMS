/**
 * MasterScreen — the list + create + edit + deactivate shell that all nine
 * ORG_ENTITIES-backed masters share (`/admin/org/*`, `/admin/time/shifts`,
 * `weekly-offs`, `attendance-policies`).
 *
 * The three things it centralises are the three things easy to get wrong twelve
 * times over:
 *
 *  1. WHEN A REASON IS ASKED FOR. Retiring, deactivating and reactivating always
 *     open `ReasonDialog` with the D-21 floor of 15 characters. A routine field
 *     edit on an org master saves with the default sentence; a screen whose rows
 *     the attendance engine reads (`promptOnSave`) always asks, and its
 *     mutation carries no default reason at all, so a missed prompt fails loudly
 *     rather than inventing a justification.
 *  2. WHAT GETS SENT. Only changed fields go in a PATCH, derived columns are
 *     never sent, and `company_id` is attached on create for the tables where it
 *     is NOT NULL. A create with no readable entity is refused in the browser
 *     with a sentence, not by a foreign-key error.
 *  3. THE SEVEN STATES. `StateBoundary` covers loading / error+retry / offline /
 *     no-permission / partial; the grid covers empty (contextual, and different
 *     when a filter is on); the form covers pending, field errors, server
 *     rejection and success.
 *
 * Names, never codes (D-10): the first column is always the row's `name`, with
 * the code as a muted monospace sub-line, because an administrator does maintain
 * the code — but nothing else in the product ever shows it.
 */
import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import type { UseQueryResult } from "@tanstack/react-query";
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
import { t } from "@/shared/i18n/en";
import type { OrgEntityKey, OrgListFilters } from "../api/org.api";
import { useMasterArchive, useMasterSave, useMasterSetActive } from "../hooks/useMasters";
import {
  changeSummary,
  coerceValues,
  validateFields,
  valuesFromRow,
  type FieldErrors,
  type FieldGroup,
  type FormValues,
} from "../masters/fields";
import { MasterFormSheet } from "./MasterFormSheet";

/** What every master row must have for this shell to render and act on it. */
export interface MasterRowBase {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly is_active: boolean;
}

export const MASTER_STATUS_MAP: Record<string, StatusChipEntry> = {
  active: { label: t("admin.master.status.active"), tone: "success" },
  inactive: { label: t("admin.master.status.inactive"), tone: "neutral" },
  retired: { label: t("admin.master.status.retired"), tone: "danger" },
};

export interface MasterScreenProps<R extends MasterRowBase> {
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  /** Singular and lower case — "department", "policy set". */
  entityLabel: string;
  entity: OrgEntityKey;
  /**
   * The list hook. Passed in rather than called here so the row type stays
   * concrete per screen (and so a screen can add a parent filter of its own).
   */
  useRows: (filters: OrgListFilters) => UseQueryResult<R[], Error>;
  /** A reference read that failed while the list succeeded — the PARTIAL state. */
  partialError?: unknown;
  partialLabel?: string;
  /** Columns after the name column; status and actions are appended. */
  columns: DataGridColumn<R>[];
  groups: readonly FieldGroup[];
  /**
   * Row-dependent field groups, when a picker has to exclude the row itself (a
   * cost centre that rolls up into itself recurses every finance roll-up).
   * Overrides `groups` when given.
   */
  groupsFor?: (row: R | null) => readonly FieldGroup[];
  /** Seed values for a create form (booleans that start on, sensible numbers). */
  createDefaults?: Readonly<Record<string, string>>;
  /** True when the table's `company_id` is NOT NULL. */
  needsCompanyId?: boolean;
  companyId?: string | null;
  /** 'archive' → soft delete (D-23). 'flag' → `is_active = false`. */
  retire: "archive" | "flag";
  /** Ask for a typed reason on every save, and carry no default. */
  promptOnSave?: boolean;
  /** Cross-field rule mirroring a DB CHECK. Return a sentence or null. */
  validateForm?: (values: FormValues) => string | null;
  /** Last-mile payload shaping — e.g. a shift's server-enforced duration. */
  buildPayload?: (
    payload: Record<string, unknown>,
    values: FormValues,
    mode: "create" | "edit",
  ) => Record<string, unknown>;
  /** Display strings for `derived` fields, recomputed as the form is typed. */
  derivedDisplay?: (values: FormValues) => Record<string, string>;
  /** Interpolations for a field's own help sentence. */
  helpVars?: (values: FormValues) => Record<string, string>;
  /** The "what this screen decides" note, above the grid. */
  banner?: ReactNode;
  /** The same note inside the form, where the numbers are actually typed. */
  formBanner?: ReactNode;
  toolbarExtra?: ReactNode;
  emptyHint?: string;
  pageSize?: number;
  /** Extra server-side filters (a parent id, for sections). */
  extraFilters?: OrgListFilters;
}

type PendingAction<R> =
  | {
      readonly kind: "save";
      readonly mode: "create" | "edit";
      readonly id: string | null;
      readonly values: Record<string, unknown>;
      readonly name: string;
      readonly changes: readonly string[];
    }
  | { readonly kind: "archive"; readonly row: R }
  | { readonly kind: "setActive"; readonly row: R; readonly isActive: boolean };

export function MasterScreen<R extends MasterRowBase>({
  icon,
  title,
  subtitle,
  entityLabel,
  entity,
  useRows,
  partialError,
  partialLabel,
  columns,
  groups: baseGroups,
  groupsFor,
  createDefaults,
  needsCompanyId = false,
  companyId = null,
  retire,
  promptOnSave = false,
  validateForm,
  buildPayload,
  derivedDisplay,
  helpVars,
  banner,
  formBanner,
  toolbarExtra,
  emptyHint,
  pageSize,
  extraFilters,
}: MasterScreenProps<R>) {
  const actorName = useAuth().employee?.displayName ?? null;

  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [archivedOnly, setArchivedOnly] = useState(false);

  const filters: OrgListFilters = useMemo(
    () => ({
      includeInactive: includeInactive || archivedOnly,
      archived: archivedOnly,
      ...(extraFilters ?? {}),
    }),
    [includeInactive, archivedOnly, extraFilters],
  );

  const query = useRows(filters);

  // Form state. The screen owns it so a rejected save keeps the typing.
  const [formOpen, setFormOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [editing, setEditing] = useState<R | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<FormValues>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction<R> | null>(null);

  /** The field model for whatever the form is currently pointed at. */
  const groups = groupsFor?.(editing) ?? baseGroups;

  const save = useMasterSave(entity, { ...(promptOnSave ? { alwaysPrompt: true } : {}) });
  const archive = useMasterArchive(entity);
  const setActive = useMasterSetActive(entity);

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === "") return all;
    // Presentation filter over an already-loaded master (≤500 rows) — not a
    // request per keystroke, and not arithmetic on anything.
    return all.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.code.toLowerCase().includes(needle),
    );
  }, [query.data, search]);

  function openCreate(): void {
    const base = valuesFromRow(groupsFor?.(null) ?? baseGroups, null);
    setMode("create");
    setEditing(null);
    setValues({ ...base, ...(createDefaults ?? {}) });
    setOriginal({ ...base, ...(createDefaults ?? {}) });
    setErrors({});
    setFormError(null);
    save.reset();
    setFormOpen(true);
  }

  function openEdit(row: R): void {
    const base = valuesFromRow(
      groupsFor?.(row) ?? baseGroups,
      row as unknown as Record<string, unknown>,
    );
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

    const crossField = validateForm?.(values) ?? null;
    setFormError(crossField);
    if (crossField !== null) return;

    let payload = coerceValues(groups, values, mode, mode === "edit" ? original : null);
    if (mode === "create" && needsCompanyId) {
      if (companyId === null) {
        setFormError(t("admin.master.noCompany"));
        return;
      }
      payload = { ...payload, company_id: companyId };
    }
    payload = buildPayload?.(payload, values, mode) ?? payload;

    if (mode === "edit" && Object.keys(payload).length === 0) {
      setFormError(t("admin.master.changes.none"));
      return;
    }

    const name = (values["name"] ?? editing?.name ?? "").trim();
    const action = {
      kind: "save" as const,
      mode,
      id: editing?.id ?? null,
      values: payload,
      name,
      changes: mode === "edit" ? changeSummary(groups, original, values) : [],
    };

    if (promptOnSave) {
      setPending(action);
      return;
    }
    void runSave(action);
  }

  async function runSave(action: Extract<PendingAction<R>, { kind: "save" }>, reason?: string) {
    try {
      await save.saveAsync({ id: action.id, values: action.values }, reason);
      toast.success(
        action.mode === "create"
          ? t("admin.master.toast.created", { name: action.name })
          : t("admin.master.toast.saved", { name: action.name }),
      );
      setPending(null);
      setFormOpen(false);
    } catch {
      // The sentence is already on `save.userMessage`; the form stays open.
      setPending(null);
    }
  }

  async function runArchive(row: R, reason: string) {
    try {
      await archive.saveAsync({ id: row.id }, reason);
      toast.success(t("admin.master.toast.retired", { name: row.name }));
      setPending(null);
    } catch {
      /* surfaced in the dialog via archive.userMessage */
    }
  }

  async function runSetActive(row: R, isActive: boolean, reason: string) {
    try {
      await setActive.saveAsync({ id: row.id, isActive }, reason);
      toast.success(
        isActive
          ? t("admin.master.toast.reactivated", { name: row.name })
          : t("admin.master.toast.deactivated", { name: row.name }),
      );
      setPending(null);
    } catch {
      /* surfaced in the dialog via setActive.userMessage */
    }
  }

  const gridColumns: DataGridColumn<R>[] = useMemo(() => {
    const nameColumn: DataGridColumn<R> = {
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
    };

    const statusColumn: DataGridColumn<R> = {
      key: "is_active",
      header: t("admin.master.col.status"),
      width: "8rem",
      hideBelow: "md",
      render: (row) => (
        <StatusChip
          status={archivedOnly ? "retired" : row.is_active ? "active" : "inactive"}
          map={MASTER_STATUS_MAP}
        />
      ),
    };

    const actionsColumn: DataGridColumn<R> = {
      key: "actions",
      header: t("admin.master.col.actions"),
      align: "right",
      width: "13rem",
      render: (row) => (
        <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
            {t("admin.master.action.edit")}
          </Button>
          {archivedOnly ? null : row.is_active ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setPending(
                  retire === "archive"
                    ? { kind: "archive", row }
                    : { kind: "setActive", row, isActive: false },
                )
              }
            >
              {retire === "archive"
                ? t("admin.master.action.retire")
                : t("admin.master.action.deactivate")}
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
        </span>
      ),
    };

    return [nameColumn, ...columns, statusColumn, actionsColumn];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, archivedOnly, retire]);

  const filtersOn = search.trim() !== "" || includeInactive || archivedOnly;

  const dialog = pendingDialog();

  return (
    <div className="container py-6">
      <PageHeader
        icon={icon}
        title={title}
        subtitle={subtitle}
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            {t("admin.master.new", { entity: entityLabel })}
          </Button>
        }
      />

      {banner}

      <StateBoundary
        loading={query.isLoading}
        error={query.error ?? undefined}
        onRetry={() => void query.refetch()}
        partialError={partialError}
        {...(partialLabel !== undefined ? { partialLabel } : {})}
        skeletonRows={6}
      >
        <DataGrid
          columns={gridColumns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={pageSize ?? 25}
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
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeInactive}
                  onChange={(event) => setIncludeInactive(event.target.checked)}
                  className="h-4 w-4 rounded border-input text-primary"
                />
                {t("admin.master.filter.includeInactive")}
              </label>
              {retire === "archive" ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={archivedOnly}
                    onChange={(event) => setArchivedOnly(event.target.checked)}
                    className="h-4 w-4 rounded border-input text-primary"
                  />
                  {t("admin.master.filter.archived")}
                </label>
              ) : null}
              {toolbarExtra}
            </>
          }
          emptyState={
            filtersOn ? (
              <EmptyState
                icon={icon}
                title={t("admin.master.emptyFiltered.title")}
                hint={t("admin.master.emptyFiltered.hint")}
              />
            ) : (
              <EmptyState
                icon={icon}
                title={t("admin.master.empty.title", { entity: entityLabel })}
                hint={emptyHint ?? t("admin.master.empty.hint")}
                action={
                  <Button onClick={openCreate}>
                    {t("admin.master.new", { entity: entityLabel })}
                  </Button>
                }
              />
            )
          }
        />
      </StateBoundary>

      <MasterFormSheet
        open={formOpen}
        mode={mode}
        entityLabel={entityLabel}
        rowName={editing?.name ?? null}
        groups={groups}
        values={values}
        errors={errors}
        pending={save.isPending}
        serverMessage={save.userMessage}
        formError={formError}
        {...(derivedDisplay ? { derived: derivedDisplay(values) } : {})}
        {...(helpVars ? { helpVars: helpVars(values) } : {})}
        {...(formBanner !== undefined ? { banner: formBanner } : {})}
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

      {dialog}
    </div>
  );

  function pendingDialog(): ReactNode {
    if (pending === null) return null;

    if (pending.kind === "save") {
      const description =
        pending.mode === "create"
          ? t("admin.master.changes.created", { name: pending.name })
          : pending.changes.length === 0
            ? t("admin.master.changes.none")
            : t("admin.master.changes.list", { changes: pending.changes.join("; ") });
      return (
        <ReasonDialog
          open
          title={
            pending.mode === "create"
              ? t("admin.master.saveReason.createTitle", { entity: entityLabel })
              : t("admin.master.saveReason.editTitle", { name: pending.name })
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
          title={t("admin.master.retire.title", { name: pending.row.name })}
          description={t("admin.master.retire.description", { name: pending.row.name })}
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

    return (
      <ReasonDialog
        open
        title={
          pending.isActive
            ? t("admin.master.reactivate.title", { name: pending.row.name })
            : t("admin.master.deactivate.title", { name: pending.row.name })
        }
        description={
          pending.isActive
            ? t("admin.master.reactivate.description", { name: pending.row.name })
            : t("admin.master.deactivate.description", { name: pending.row.name })
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

/** The shared "this is what the screen decides" banner. */
export function MasterBanner({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
      {children}
    </p>
  );
}
