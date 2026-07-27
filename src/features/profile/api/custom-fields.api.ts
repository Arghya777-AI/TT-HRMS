/**
 * custom-fields.api.ts — E-07 Tab 5: organisation-defined fields on the record.
 *
 * The defs table carries the authority directly: `is_employee_editable` +
 * `requires_approval` map onto the three authorities the tab renders, which is
 * why Tab 5 needs no hard-coded field list. DR-50 is the reason this stays
 * strictly DATA: the reference product used custom fields as behaviour switches
 * ("Selfie Attendance", "Dynamic WeekOff Calc"), and this build keeps policy in
 * `attendance_policies` / `weekly_off_rules` where an audit trail applies.
 *
 * `employee_custom_field_defs` has NO `visible_to` column in the deployed
 * schema — visibility is `is_active` plus the `applies_to_*` targeting arrays.
 * The pages therefore filter on applicability, not on a visibility enum.
 *
 * THE WRITE HALF (§5 below) has TWO paths, and which one a field takes is the
 * definition's own decision, not this module's:
 *
 *   requires_approval = false → a direct write to
 *     `employee_custom_field_values`, allowed by `ecfv__self_insert` /
 *     `ecfv__self_update` (migration 20260801014000), whose predicate is
 *     `app.custom_field_is_self_writable()` = `is_employee_editable AND NOT
 *     requires_approval`. The table is NOT in `audit.reason_required_tables`,
 *     so `insertOne`/`updateOne` (no `X-Reason`) are the right helpers — asking
 *     someone to justify their shoe size in ten characters is not governance.
 *
 *   requires_approval = true → an `employee_change_requests` row with
 *     `entity_table = 'employee_custom_field_values'` and
 *     `field_name = 'custom:<CODE>'`. That convention is NOT a preference:
 *     `ecr_insert_guard` (migration 011) raises errcode 22023 —
 *     "custom-field requests use field_name = custom:<code>" — for anything
 *     else, and then rejects the request outright unless the def is
 *     `is_employee_editable`. HR decides it with
 *     `public.decide_change_request`, which calls `apply_change_request`, which
 *     reads the code back out with `substring(field_name FROM 8)`.
 *
 * NOTHING here validates a value as if it were the authority. `trg_ecfv__validate`
 * owns that: the typed-column match, `validation_regex`, `min_value`/`max_value`
 * and — the one that bites — `single_select` values checked against
 * `o->>'value'` of each `options` element. `validateCustomFieldDraft` is a
 * pre-flight so the employee is told before a round trip, and it deliberately
 * mirrors those four rules rather than inventing a fifth.
 */
import { z } from "zod";
import { dbDateNullable, dbInt, dbNumericNullable, dbUuid, dbUuidNullable, eq, isTrue, selectMany } from "@/shared/api/query";
import { insertOne, updateOne } from "@/shared/api/write";
import { submitSelfChangeRequest, type ChangeRequest } from "./history.api";
import type { EditAuthority } from "../types";

export const CUSTOM_FIELD_DEFS_TABLE = "employee_custom_field_defs";
export const CUSTOM_FIELD_VALUES_TABLE = "employee_custom_field_values";

export const customFieldTypeSchema = z.enum([
  "text", "number", "date", "boolean", "single_select", "multi_select",
  "employee_ref", "file",
]);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

export const customFieldDefSchema = z.object({
  id: dbUuid,
  code: z.string(),
  label: z.string(),
  help_text: z.string().nullable(),
  field_type: customFieldTypeSchema,
  options: z.unknown().nullable(),
  is_required: z.boolean(),
  is_employee_editable: z.boolean(),
  requires_approval: z.boolean(),
  is_pii: z.boolean(),
  section: z.string(),
  sort_order: dbInt,
  applies_to_employment_types: z.array(z.string()).nullable(),
  applies_to_department_ids: z.array(z.string()).nullable(),
  /** `text` fields only — the pattern `trg_ecfv__validate` applies with `!~`. */
  validation_regex: z.string().nullable(),
  /** `number` fields only. numeric(14,2) in the table, so possibly a string. */
  min_value: dbNumericNullable,
  max_value: dbNumericNullable,
});

export type CustomFieldDef = z.infer<typeof customFieldDefSchema>;

const DEF_COLUMNS =
  "id, code, label, help_text, field_type, options, is_required, " +
  "is_employee_editable, requires_approval, is_pii, section, sort_order, " +
  "applies_to_employment_types, applies_to_department_ids, validation_regex, " +
  "min_value, max_value";

export async function fetchCustomFieldDefs(signal?: AbortSignal): Promise<CustomFieldDef[]> {
  return selectMany(CUSTOM_FIELD_DEFS_TABLE, customFieldDefSchema, {
    filters: [isTrue("is_active")],
    order: [{ column: "section" }, { column: "sort_order" }, { column: "label" }],
    columns: DEF_COLUMNS,
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

export const customFieldValueSchema = z.object({
  id: dbUuid,
  field_def_id: dbUuid,
  value_text: z.string().nullable(),
  value_number: dbNumericNullable,
  value_date: dbDateNullable,
  value_boolean: z.boolean().nullable(),
  value_json: z.unknown().nullable(),
  value_document_id: dbUuidNullable,
});

export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

export async function fetchCustomFieldValues(
  employeeId: string,
  signal?: AbortSignal,
): Promise<CustomFieldValue[]> {
  return selectMany(CUSTOM_FIELD_VALUES_TABLE, customFieldValueSchema, {
    filters: [eq("employee_id", employeeId)],
    columns:
      "id, field_def_id, value_text, value_number, value_date, value_boolean, " +
      "value_json, value_document_id",
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Joining defs to values — the shape the tab renders
// -----------------------------------------------------------------------------

export interface CustomFieldRow {
  readonly def: CustomFieldDef;
  readonly value: CustomFieldValue | null;
  readonly authority: EditAuthority;
}

/**
 * The def's two booleans ARE the authority model:
 *   employee-editable + no approval → ✅ self
 *   employee-editable + approval    → 🔶 maker-checker
 *   not employee-editable           → ❌ admin-only, read-only
 */
export function authorityOf(def: CustomFieldDef): EditAuthority {
  if (!def.is_employee_editable) return "admin_only";
  return def.requires_approval ? "maker_checker" : "self";
}

/**
 * A def applies when its targeting arrays are empty/null, or when they contain
 * the employee's own employment type / department. A null array means "everyone"
 * in this schema, so an unfiltered def must NOT be hidden.
 */
export function defApplies(
  def: CustomFieldDef,
  employmentType: string,
  departmentId: string | null,
): boolean {
  const types = def.applies_to_employment_types;
  if (types !== null && types.length > 0 && !types.includes(employmentType)) return false;
  const depts = def.applies_to_department_ids;
  if (depts !== null && depts.length > 0) {
    if (departmentId === null || !depts.includes(departmentId)) return false;
  }
  return true;
}

/** Left-join defs → values, dropping defs that do not apply to this employee. */
export function joinCustomFields(
  defs: readonly CustomFieldDef[],
  values: readonly CustomFieldValue[],
  employmentType: string,
  departmentId: string | null,
): CustomFieldRow[] {
  const byDef = new Map<string, CustomFieldValue>();
  for (const v of values) byDef.set(v.field_def_id, v);
  return defs
    .filter((def) => defApplies(def, employmentType, departmentId))
    .map((def) => ({
      def,
      value: byDef.get(def.id) ?? null,
      authority: authorityOf(def),
    }));
}

export interface CustomFieldsBundle {
  readonly defs: CustomFieldDef[];
  readonly values: CustomFieldValue[];
}

export async function fetchCustomFields(
  employeeId: string,
  signal?: AbortSignal,
): Promise<CustomFieldsBundle> {
  const [defs, values] = await Promise.all([
    fetchCustomFieldDefs(signal),
    fetchCustomFieldValues(employeeId, signal),
  ]);
  return { defs, values };
}

// -----------------------------------------------------------------------------
// 4. `options` and the typed column — the two things a renderer must get right
// -----------------------------------------------------------------------------

export interface CustomFieldOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The `{value,label}` pairs of a `single_select` / `multi_select` definition.
 *
 * Tolerates the two shapes the jsonb column can legitimately hold, because
 * `ck_ecfd__options` only checks `jsonb_typeof(options) = 'array'`:
 * `[{"value":"M","label":"Medium"}]` (what the admin screen writes and what
 * `trg_ecfv__validate` reads) and a bare `["M","L"]` from an older import,
 * whose label falls back to the value. Anything else is dropped rather than
 * rendered as `[object Object]` — a select that offers a choice the validator
 * will reject is worse than a select with one option fewer.
 */
export function customFieldOptions(def: CustomFieldDef): CustomFieldOption[] {
  if (!Array.isArray(def.options)) return [];
  const out: CustomFieldOption[] = [];
  for (const entry of def.options) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed !== "") out.push({ value: trimmed, label: trimmed });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const rawValue = record["value"];
    const value =
      typeof rawValue === "string" ? rawValue.trim() : typeof rawValue === "number" ? String(rawValue) : "";
    if (value === "") continue;
    const rawLabel = record["label"];
    const label = typeof rawLabel === "string" && rawLabel.trim() !== "" ? rawLabel.trim() : value;
    out.push({ value, label });
  }
  return out;
}

/**
 * The field types this screen can render a control for.
 *
 * `multi_select` and `employee_ref` land in `value_json` and `file` in
 * `value_document_id`; none has a control here, so the page says so per field
 * instead of offering a text box that `trg_ecfv__validate` would refuse for
 * putting a value in the wrong typed column.
 */
export const EDITABLE_CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = [
  "text",
  "number",
  "date",
  "boolean",
  "single_select",
];

export function isEditableFieldType(fieldType: CustomFieldType): boolean {
  return EDITABLE_CUSTOM_FIELD_TYPES.includes(fieldType);
}

/**
 * A pending value, in the shape of the ONE typed column it belongs in.
 *
 * `as` is the discriminant rather than the def's `field_type` because `text`
 * and `single_select` share `value_text`: collapsing them here means
 * `draftColumns` cannot put a select's value anywhere else by accident.
 */
export type CustomFieldDraft =
  | { readonly as: "text"; readonly value: string }
  | { readonly as: "number"; readonly value: number }
  | { readonly as: "date"; readonly value: string }
  | { readonly as: "boolean"; readonly value: boolean };

/** Which draft kind a definition's `field_type` requires, or null if unsupported. */
export function draftKindFor(fieldType: CustomFieldType): CustomFieldDraft["as"] | null {
  switch (fieldType) {
    case "text":
    case "single_select":
      return "text";
    case "number":
      return "number";
    case "date":
      return "date";
    case "boolean":
      return "boolean";
    default:
      return null;
  }
}

/**
 * The value already on the record, as a draft — the editor's initial state.
 * `null` means "no value yet", which for a boolean is distinct from `false`.
 */
export function draftFromValue(
  def: CustomFieldDef,
  value: CustomFieldValue | null,
): CustomFieldDraft | null {
  if (value === null) return null;
  switch (draftKindFor(def.field_type)) {
    case "text":
      return value.value_text === null ? null : { as: "text", value: value.value_text };
    case "number":
      return value.value_number === null ? null : { as: "number", value: value.value_number };
    case "date":
      return value.value_date === null ? null : { as: "date", value: value.value_date };
    case "boolean":
      return value.value_boolean === null ? null : { as: "boolean", value: value.value_boolean };
    default:
      return null;
  }
}

export function draftsEqual(a: CustomFieldDraft | null, b: CustomFieldDraft | null): boolean {
  if (a === null || b === null) return a === b;
  return a.as === b.as && a.value === b.value;
}

/**
 * The full six-column value bag with EXACTLY ONE column populated.
 *
 * All six are always sent, the five others explicitly null: on an UPDATE that
 * is what keeps `ck_ecfv__one_value` satisfied (it counts non-null columns on
 * the resulting row, not on the patch), and on an INSERT it documents at the
 * call site that the constraint was considered.
 */
export function draftColumns(draft: CustomFieldDraft): Record<string, unknown> {
  return {
    value_text: draft.as === "text" ? draft.value : null,
    value_number: draft.as === "number" ? draft.value : null,
    value_date: draft.as === "date" ? draft.value : null,
    value_boolean: draft.as === "boolean" ? draft.value : null,
    value_json: null,
    value_document_id: null,
  };
}

/**
 * The draft as the jsonb scalar `employee_change_requests.new_value` wants.
 *
 * `apply_change_request` reads it back with `r.new_value #>> '{}'` and casts —
 * `::numeric` for number, `::date` for date, `::boolean` for boolean — so a
 * JSON scalar of the natural type is exactly right, and an object or array here
 * would make the cast fail inside the applier and land as `apply_error`.
 */
export function draftToJson(draft: CustomFieldDraft): string | number | boolean {
  return draft.value;
}

// -----------------------------------------------------------------------------
// 5. Writing — direct where the def allows it, change request where it does not
// -----------------------------------------------------------------------------

/** Why a draft cannot be sent, in a shape the component turns into a sentence. */
export type CustomFieldDraftProblem =
  | { readonly code: "empty" }
  | { readonly code: "number" }
  | { readonly code: "min"; readonly min: number }
  | { readonly code: "max"; readonly max: number }
  | { readonly code: "date" }
  | { readonly code: "option" }
  | { readonly code: "pattern" };

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pre-flight mirror of `trg_ecfv__validate`. The trigger remains the authority;
 * this exists so "XXXL is not one of the configured options" is said before the
 * request leaves, not after.
 */
export function validateCustomFieldDraft(
  def: CustomFieldDef,
  draft: CustomFieldDraft,
): CustomFieldDraftProblem | null {
  if (draft.as === "text") {
    if (draft.value.trim() === "") return { code: "empty" };
    if (def.field_type === "single_select") {
      const allowed = customFieldOptions(def).map((o) => o.value);
      if (!allowed.includes(draft.value)) return { code: "option" };
      return null;
    }
    // `trg_ecfv__validate` applies validation_regex to `text` only, and does so
    // with Postgres `!~` — a partial match, not an anchored one. `RegExp.test`
    // is the same semantics, so an unanchored pattern behaves identically here.
    if (def.validation_regex !== null && def.validation_regex !== "") {
      try {
        if (!new RegExp(def.validation_regex).test(draft.value)) return { code: "pattern" };
      } catch {
        // An admin-authored pattern Postgres accepts but JavaScript will not
        // compile must not block the save — the trigger still checks it.
        return null;
      }
    }
    return null;
  }
  if (draft.as === "number") {
    if (!Number.isFinite(draft.value)) return { code: "number" };
    if (def.min_value !== null && draft.value < def.min_value) return { code: "min", min: def.min_value };
    if (def.max_value !== null && draft.value > def.max_value) return { code: "max", max: def.max_value };
    return null;
  }
  if (draft.as === "date") {
    if (!CIVIL_DATE.test(draft.value)) return { code: "date" };
    return null;
  }
  return null;
}

const VALUE_COLUMNS =
  "id, field_def_id, value_text, value_number, value_date, value_boolean, " +
  "value_json, value_document_id";

export interface SaveCustomFieldValueInput {
  readonly employeeId: string;
  readonly def: CustomFieldDef;
  /** `employee_custom_field_values.id` when a value already exists, else null. */
  readonly valueRowId: string | null;
  readonly draft: CustomFieldDraft;
}

/**
 * Write the value straight onto the record. Only legitimate when
 * `authorityOf(def) === 'self'`; the policy re-decides that server-side and
 * answers 42501 if the def says otherwise, so a mis-wired caller fails loudly.
 *
 * UPDATE-when-known / INSERT-otherwise rather than an upsert: `upsertRow` in
 * `query.ts` demands an audit reason (it is the admin-console helper) and
 * `employee_custom_field_values` is not reason-gated, so inventing a sentence
 * to satisfy a helper would put a fabricated reason in `audit_log`. The unique
 * index `uq_ecfv__employee_field` makes the INSERT branch safe: a second tab
 * that raced ahead turns into a 23505 the form reports, not a duplicate row.
 */
export async function saveCustomFieldValue(
  input: SaveCustomFieldValueInput,
  signal?: AbortSignal,
): Promise<CustomFieldValue> {
  const columns = draftColumns(input.draft);
  if (input.valueRowId !== null) {
    return updateOne(
      CUSTOM_FIELD_VALUES_TABLE,
      customFieldValueSchema,
      columns,
      { id: input.valueRowId },
      { columns: VALUE_COLUMNS, ...(signal ? { signal } : {}) },
    );
  }
  return insertOne(
    CUSTOM_FIELD_VALUES_TABLE,
    customFieldValueSchema,
    {
      employee_id: input.employeeId,
      field_def_id: input.def.id,
      ...columns,
    },
    { columns: VALUE_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/**
 * `employee_change_requests.field_name` for a custom field.
 *
 * `ecr_insert_guard` raises errcode 22023 for anything that does not match
 * `'^custom:'`, and `apply_change_request` recovers the code with
 * `substring(field_name FROM 8)` — i.e. it assumes exactly seven characters of
 * prefix. Both halves live in this one function so neither can drift.
 */
export function customFieldRequestFieldName(code: string): string {
  return `custom:${code}`;
}

/** The def code carried by a change request, or null if it is not a custom field. */
export function customFieldCodeOf(request: ChangeRequest): string | null {
  if (request.entity_table !== CUSTOM_FIELD_VALUES_TABLE) return null;
  if (!request.field_name.startsWith("custom:")) return null;
  const code = request.field_name.slice("custom:".length);
  return code === "" ? null : code;
}

export interface RequestCustomFieldChangeInput {
  readonly employeeId: string;
  /** `profiles.id` of the signed-in user — `ecr__self_insert` checks it. */
  readonly requestedBy: string;
  readonly def: CustomFieldDef;
  readonly draft: CustomFieldDraft;
  /** The value on the record now, so the queue shows a real From → To pair. */
  readonly current: CustomFieldDraft | null;
}

/**
 * Propose the value instead of writing it. Used for `requires_approval = true`
 * fields, and as the fallback when a direct write is refused — a change request
 * is legal for ANY `is_employee_editable` def, so the employee's value is never
 * lost to a missing policy.
 */
export async function requestCustomFieldChange(
  input: RequestCustomFieldChangeInput,
  signal?: AbortSignal,
): Promise<ChangeRequest> {
  return submitSelfChangeRequest(
    {
      employeeId: input.employeeId,
      requestedBy: input.requestedBy,
      entityTable: CUSTOM_FIELD_VALUES_TABLE,
      fieldName: customFieldRequestFieldName(input.def.code),
      fieldLabel: input.def.label,
      ...(input.current !== null ? { oldValue: draftToJson(input.current) } : {}),
      newValue: draftToJson(input.draft),
    },
    signal,
  );
}
