/**
 * custom-fields.api.ts — the designer behind §3 `/admin/org/custom-fields`:
 * CRUD over `public.employee_custom_field_defs`, the venue-specific fields that
 * `/me/profile/custom` and Employee 360 Tab 5 render.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `org.api.ts`. The nine ORG_ENTITIES masters
 * share five columns (`code`, `name`, `description`, `sort_order`, `is_active`)
 * and one lifecycle, which is what makes their generic registry safe. This table
 * has NO `name` and NO `description`: its human label is `label`, its help line
 * is `help_text`, and it carries a typed `field_type` + `options` pair that the
 * generic form model cannot shape. Bending it into that registry would mean
 * renaming columns in a zod schema — i.e. lying about the table — so it gets its
 * own reads, its own writes and its own field model.
 *
 * WHAT THE COLUMNS ACTUALLY DO, verified against migration 010:
 *   * `code` — immutable in practice: `uq_ecfd__company_code` is the identity
 *     other systems and exports quote. `ck_ecfd__code` is
 *     `^[A-Z][A-Z0-9_]{1,63}$` — note the UNDERSCORES and the 64-character
 *     ceiling, which is NOT the 12-character `CODE_PATTERN` the org masters use.
 *   * `field_type` — `public.custom_field_type`: text / number / date / boolean /
 *     single_select / multi_select / employee_ref / file. `trg_ecfv__validate`
 *     enforces that a value lands in the MATCHING typed column, so changing the
 *     type of a field that already holds values will make those values fail
 *     validation on their next write. The form says so.
 *   * `options` — jsonb, and `ck_ecfd__options` requires a JSON ARRAY whenever
 *     the type is single_select/multi_select. The validator matches a value
 *     against `o->>'value'`, so each element must be an object with a `value`
 *     key: `[{"value":"M","label":"M"}]`.
 *   * `is_pii` — a real boundary, not a label. `v_team_custom_fields`
 *     (migration 055) filters `NOT f.is_pii`, so a PII field is invisible to a
 *     manager looking at their reportee; only the employee and scoped admins can
 *     read it.
 *   * `is_employee_editable` + `requires_approval` — the authority model Tab 5
 *     renders (self / maker-checker / admin-only). No third flag exists.
 *   * `validation_regex`, `min_value`, `max_value` — applied by
 *     `trg_ecfv__validate` for text and number fields respectively. On any other
 *     type they are inert, and the form says that too.
 *   * `applies_to_employment_types` / `applies_to_department_ids` — targeting
 *     arrays. NULL or empty means EVERYONE (`defApplies` in the profile module),
 *     which is why an empty tick list must never be read as "nobody".
 *
 * REASONS. `employee_custom_field_defs` is audited (trigger attached in migration
 * 038) but is NOT in `audit.reason_required_tables`, so the database would accept
 * a reasonless write. Every write here still carries one and the screen always
 * prompts: these rows decide what the venue asks its staff to disclose, and a
 * field that silently became PII — or silently stopped being PII — is exactly the
 * change an auditor will ask about.
 *
 * NO HARD DELETE. `deleted_at` + `ck_ecfd__deletion_reason` (a ≥10-character
 * reason and a `deleted_by`) is the retire path, and
 * `employee_custom_field_values` keeps its rows: retiring a field hides the
 * question, it does not erase the answers.
 */
import { z } from "zod";
import {
  SENSITIVE_REASON_LENGTH,
  dbInt,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  eq,
  ilike,
  insertRow,
  isNotNull,
  isNull,
  isTrue,
  restoreRow,
  selectCount,
  selectMany,
  softDelete,
  updateRow,
  type Filter,
} from "@/shared/api/query";
import {
  CUSTOM_FIELD_DEFS_TABLE,
  CUSTOM_FIELD_VALUES_TABLE,
  customFieldTypeSchema,
  type CustomFieldType,
} from "@/features/profile/api/custom-fields.api";
import { employmentTypeValues, type EmploymentType } from "./employees.api";

export { CUSTOM_FIELD_DEFS_TABLE, CUSTOM_FIELD_VALUES_TABLE, customFieldTypeSchema };
export type { CustomFieldType };

/** The defs master is small by design — 200 covers every venue field twice over. */
export const CUSTOM_FIELD_ROW_CAP = 200;

/**
 * How many definitions may get a per-definition "values recorded" COUNT in one
 * pass. Each one is its own `count=exact`; beyond this the column says so rather
 * than firing a request per row of a long grid.
 */
export const VALUE_COUNT_CAP = 60;

/** `ck_ecfd__code` — starts with a letter, then capitals/digits/underscore, ≤64. */
export const CUSTOM_FIELD_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** The field types whose `options` array is required by `ck_ecfd__options`. */
export const SELECT_FIELD_TYPES: readonly CustomFieldType[] = ["single_select", "multi_select"];

// -----------------------------------------------------------------------------
// 1. The row
// -----------------------------------------------------------------------------

export const customFieldDefAdminSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  code: z.string(),
  label: z.string(),
  help_text: z.string().nullable(),
  field_type: customFieldTypeSchema,
  /** jsonb — an array for the select types, null otherwise. Shaped by `optionValues`. */
  options: z.unknown().nullable(),
  is_required: z.boolean(),
  is_employee_editable: z.boolean(),
  requires_approval: z.boolean(),
  is_pii: z.boolean(),
  section: z.string(),
  sort_order: dbInt,
  applies_to_employment_types: z.array(z.string()).nullable(),
  applies_to_department_ids: z.array(z.string()).nullable(),
  validation_regex: z.string().nullable(),
  min_value: dbNumericNullable,
  max_value: dbNumericNullable,
  is_active: z.boolean(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
  deleted_at: dbTimestampNullable,
  deletion_reason: z.string().nullable(),
});
export type CustomFieldDefAdmin = z.infer<typeof customFieldDefAdminSchema>;

const DEF_COLUMNS = [
  "id",
  "company_id",
  "code",
  "label",
  "help_text",
  "field_type",
  "options",
  "is_required",
  "is_employee_editable",
  "requires_approval",
  "is_pii",
  "section",
  "sort_order",
  "applies_to_employment_types",
  "applies_to_department_ids",
  "validation_regex",
  "min_value",
  "max_value",
  "is_active",
  "created_at",
  "updated_at",
  "deleted_at",
  "deletion_reason",
].join(",");

// -----------------------------------------------------------------------------
// 2. Reads
// -----------------------------------------------------------------------------

export interface CustomFieldFilters {
  /** Default false — the grid shows fields that are still in use. */
  readonly includeInactive?: boolean;
  /** Retired (soft-deleted) rows only. */
  readonly archived?: boolean;
  readonly labelLike?: string;
  readonly section?: string;
  readonly fieldType?: CustomFieldType;
  readonly piiOnly?: boolean;
  /** Fields the employee may edit themselves (with or without approval). */
  readonly employeeEditableOnly?: boolean;
  /** Fields the employee form insists on. */
  readonly requiredOnly?: boolean;
}

/** One predicate builder, so the tiles and the grid can never disagree. */
export function customFieldFilters(f: CustomFieldFilters): Filter[] {
  const filters: Filter[] = [f.archived === true ? isNotNull("deleted_at") : isNull("deleted_at")];
  if (f.includeInactive !== true && f.archived !== true) filters.push(isTrue("is_active"));
  if (f.labelLike !== undefined && f.labelLike.trim() !== "")
    filters.push(ilike("label", `%${f.labelLike.trim()}%`));
  if (f.section !== undefined && f.section !== "") filters.push(eq("section", f.section));
  if (f.fieldType !== undefined) filters.push(eq("field_type", f.fieldType));
  if (f.piiOnly === true) filters.push(isTrue("is_pii"));
  if (f.employeeEditableOnly === true) filters.push(isTrue("is_employee_editable"));
  if (f.requiredOnly === true) filters.push(isTrue("is_required"));
  return filters;
}

/**
 * The definitions, in the order the employee sees them: section, then
 * `sort_order`, then label — the same ordering `/me/profile/custom` reads with,
 * so the designer's list IS the form's running order.
 */
export function fetchCustomFieldDefs(
  f: CustomFieldFilters = {},
  signal?: AbortSignal,
): Promise<CustomFieldDefAdmin[]> {
  return selectMany(CUSTOM_FIELD_DEFS_TABLE, customFieldDefAdminSchema, {
    filters: customFieldFilters(f),
    columns: DEF_COLUMNS,
    order: [
      { column: "section", ascending: true },
      { column: "sort_order", ascending: true },
      { column: "label", ascending: true },
    ],
    limit: CUSTOM_FIELD_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countCustomFieldDefs(
  f: CustomFieldFilters = {},
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(CUSTOM_FIELD_DEFS_TABLE, customFieldFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

/**
 * How many employee records already answer each definition — one `count=exact`
 * per definition over `employee_custom_field_values`.
 *
 * This is the number that makes a retire decision honest: retiring a field keeps
 * its values (no cascade fires on `deleted_at`), and an admin about to retire
 * "Locker Number" deserves to see that 43 people have one recorded. RLS on the
 * values table is self + scoped admin, so the figure is "within your scope" —
 * which the column header says.
 */
export async function fetchValueCounts(
  defIds: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, number>> {
  if (defIds.length === 0) return new Map<string, number>();
  if (defIds.length > VALUE_COUNT_CAP) {
    throw new Error(
      `fetchValueCounts refuses ${defIds.length} definitions: the cap is ${VALUE_COUNT_CAP} per pass.`,
    );
  }
  const counts = await Promise.all(
    defIds.map((id) =>
      selectCount(CUSTOM_FIELD_VALUES_TABLE, [eq("field_def_id", id)], {
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  const out = new Map<string, number>();
  defIds.forEach((id, index) => {
    const count = counts[index];
    if (count !== undefined) out.set(id, count);
  });
  return out;
}

// -----------------------------------------------------------------------------
// 3. `options` — jsonb in the table, a comma-separated list in the form
// -----------------------------------------------------------------------------

/**
 * The option VALUES of a definition, tolerating both shapes a jsonb array can
 * legitimately hold: `[{"value":"M","label":"Medium"}]` (what this screen
 * writes, and what `trg_ecfv__validate` reads via `o->>'value'`) and a bare
 * `["M","L"]` from an earlier import. Anything else is ignored rather than
 * rendered as `[object Object]`.
 */
export function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const out: string[] = [];
  for (const entry of options) {
    if (typeof entry === "string") {
      if (entry.trim() !== "") out.push(entry.trim());
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const value = (entry as Record<string, unknown>)["value"];
      if (typeof value === "string" && value.trim() !== "") out.push(value.trim());
      else if (typeof value === "number") out.push(String(value));
    }
  }
  return out;
}

/**
 * A typed list ("S, M, L") → the jsonb array the validator expects. `label` is
 * seeded from the value because the employee form shows the label and an
 * option with no label would render blank.
 */
export function optionsFromList(raw: string): { value: string; label: string }[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((value) => ({ value, label: value }));
}

/** The form's own representation of `options`: the values, comma-separated. */
export function optionsToList(options: unknown): string {
  return optionValues(options).join(", ");
}

// -----------------------------------------------------------------------------
// 4. Vocabulary
// -----------------------------------------------------------------------------

/** `public.employment_type` values, for the targeting tick list. */
export const targetingEmploymentTypes: readonly EmploymentType[] = employmentTypeValues;

/**
 * The sections `/me/profile/custom` groups by. `section` is free text with a
 * default of `additional`, so this is a suggestion list for the picker, not a
 * constraint the database enforces — hence "or type your own" in the help.
 */
export const KNOWN_SECTIONS: readonly string[] = [
  "additional",
  "uniform",
  "transport",
  "facilities",
  "preferences",
];

// -----------------------------------------------------------------------------
// 5. Writes — all audited, none defaulted
// -----------------------------------------------------------------------------

export function insertCustomFieldDef(
  values: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<CustomFieldDefAdmin> {
  return insertRow(CUSTOM_FIELD_DEFS_TABLE, values, customFieldDefAdminSchema, {
    reason,
    columns: DEF_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

export function updateCustomFieldDef(
  id: string,
  patch: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<CustomFieldDefAdmin> {
  return updateRow(CUSTOM_FIELD_DEFS_TABLE, [eq("id", id)], patch, customFieldDefAdminSchema, {
    reason,
    columns: DEF_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Stop asking the question without dropping the answers: `is_active = false`
 * removes the field from every employee form and refuses new values
 * (`ecfv_validate` raises on an inactive definition), while the rows already in
 * `employee_custom_field_values` stay exactly where they are.
 */
export function setCustomFieldActive(
  id: string,
  isActive: boolean,
  reason: string,
  signal?: AbortSignal,
): Promise<CustomFieldDefAdmin> {
  return updateRow(
    CUSTOM_FIELD_DEFS_TABLE,
    [eq("id", id)],
    { is_active: isActive },
    customFieldDefAdminSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, columns: DEF_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/** Retire a definition (D-23 soft delete). Values are retained. */
export function archiveCustomFieldDef(
  id: string,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  return softDelete(CUSTOM_FIELD_DEFS_TABLE, id, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

/** Bring a retired definition back. Audited as `restore` by the 006 trigger. */
export function restoreCustomFieldDef(
  id: string,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  return restoreRow(CUSTOM_FIELD_DEFS_TABLE, id, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}
