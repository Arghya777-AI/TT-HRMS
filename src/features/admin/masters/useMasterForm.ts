/**
 * useMasterForm — the form state machine the bespoke master screens share
 * (`/admin/org/entities`, `/admin/time/holidays`, `/admin/time/pay-periods`).
 *
 * `MasterScreen` owns this logic inline for the nine ORG_ENTITIES-backed
 * screens. The three screens that are not a single flat list (a calendar with
 * children, a read-mostly entity, a super-admin-gated window) still need the
 * same guarantees, and re-typing them three times is how one of them ends up
 * PATCHing every column on every save:
 *
 *  - a rejected save keeps the typing,
 *  - only CHANGED fields go into an UPDATE,
 *  - `derived` columns are never sent,
 *  - the diff line for the reason dialog comes from the same comparison.
 */
import { useCallback, useState } from "react";
import { t } from "@/shared/i18n/en";
import {
  changeSummary,
  coerceValues,
  validateFields,
  valuesFromRow,
  type FieldErrors,
  type FieldGroup,
  type FormValues,
} from "./fields";

export interface MasterFormBuild {
  readonly payload: Record<string, unknown>;
  readonly changes: readonly string[];
  readonly name: string;
}

export interface MasterFormState<R> {
  readonly open: boolean;
  readonly mode: "create" | "edit";
  readonly editing: R | null;
  readonly values: Record<string, string>;
  readonly errors: FieldErrors;
  readonly formError: string | null;
  readonly openCreate: (defaults?: Readonly<Record<string, string>>) => void;
  readonly openEdit: (row: R) => void;
  readonly close: () => void;
  readonly change: (name: string, value: string) => void;
  readonly setFormError: (message: string | null) => void;
  /**
   * Validate, then coerce to a DB payload. Returns null when something is wrong
   * — the field errors and/or the cross-field sentence are already set.
   */
  readonly build: (crossField?: (values: FormValues) => string | null) => MasterFormBuild | null;
}

export function useMasterForm<R extends { readonly id: string; readonly name: string }>(
  groups: readonly FieldGroup[],
): MasterFormState<R> {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [editing, setEditing] = useState<R | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<FormValues>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const openCreate = useCallback(
    (defaults?: Readonly<Record<string, string>>) => {
      const base = { ...valuesFromRow(groups, null), ...(defaults ?? {}) };
      setMode("create");
      setEditing(null);
      setValues(base);
      setOriginal(base);
      setErrors({});
      setFormError(null);
      setOpen(true);
    },
    [groups],
  );

  const openEdit = useCallback(
    (row: R) => {
      const base = valuesFromRow(groups, row as unknown as Record<string, unknown>);
      setMode("edit");
      setEditing(row);
      setValues(base);
      setOriginal(base);
      setErrors({});
      setFormError(null);
      setOpen(true);
    },
    [groups],
  );

  const close = useCallback(() => setOpen(false), []);

  const change = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => {
      if (prev[name] === undefined) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setFormError(null);
  }, []);

  const build = useCallback(
    (crossField?: (values: FormValues) => string | null): MasterFormBuild | null => {
      const fieldErrors = validateFields(groups, values, mode);
      setErrors(fieldErrors);
      if (Object.keys(fieldErrors).length > 0) return null;

      const cross = crossField?.(values) ?? null;
      setFormError(cross);
      if (cross !== null) return null;

      const payload = coerceValues(groups, values, mode, mode === "edit" ? original : null);
      if (mode === "edit" && Object.keys(payload).length === 0) {
        setFormError(t("admin.master.changes.none"));
        return null;
      }
      return {
        payload,
        changes: mode === "edit" ? changeSummary(groups, original, values) : [],
        name: (values["name"] ?? editing?.name ?? "").trim(),
      };
    },
    [groups, values, mode, original, editing],
  );

  return {
    open,
    mode,
    editing,
    values,
    errors,
    formError,
    openCreate,
    openEdit,
    close,
    change,
    setFormError,
    build,
  };
}
