/**
 * orgOther.ts — "Other…" on the four org lookups, and what it takes to honour it.
 *
 * WHY. Department, Section, Designation and Grade are closed dropdowns fed from the
 * org masters. A venue hiring somebody into a position nobody has entered yet had two
 * options: abandon the wizard, go and create the master, come back and start again —
 * or file the person under the wrong department and mean to fix it later. Nobody does
 * the first. So each of those four selects now carries an "Other" choice with a name
 * box, and the name becomes a real master row before the employee is inserted.
 *
 * IT CREATES A MASTER ROW, IT DOES NOT STASH A STRING. The employee columns are
 * foreign keys (`department_id` and friends), so there is nowhere to put free text and
 * no honest way to fake one — a text column beside the key would be a second source of
 * truth for the same fact. Creating the row is also what makes the value appear in the
 * list "automatically" next time: the list IS the master table.
 *
 * WHAT EACH TABLE DEMANDS, because it shapes the UI:
 *
 *   departments   company_id, code, name
 *   designations  company_id, code, name
 *   grades        company_id, code, name, LEVEL (not null, no default)
 *   sections      DEPARTMENT_ID, code, name  ← not company_id
 *
 * Two consequences are unavoidable and are surfaced rather than guessed:
 *   * A new Section needs a department. Picking "Other" for Section without choosing a
 *     Department first is refused with that sentence, not a foreign-key error.
 *   * A new Grade needs a level, and a band ladder's ordering is a real decision. The
 *     new grade is appended at the BOTTOM of the ladder (`existing + 1`) rather than
 *     inserted at a level this code invents, and the caller is told so. Reordering
 *     bands is the masters screen's job.
 *
 * CODES ARE DERIVED, AND A COLLISION IS THE SERVER'S TO REFUSE. `code` is unique per
 * company, so "Front Office" becomes `FRONT_OFFICE` and a second one fails on the
 * unique index. That is the right place for it to fail — this module does not
 * pre-check, because a check followed by an insert is a race, and it does not
 * auto-suffix, because `FRONT_OFFICE_2` is not a code anybody chose.
 */
import { insertOrgRow } from "../api/org.api";

/** The sentinel a select carries for "Other". Not a uuid, so it can never be an id. */
export const OTHER_VALUE = "__other__";

/** Which masters accept an inline "Other". */
export const OTHER_ENTITIES = ["departments", "sections", "designations", "grades"] as const;
export type OtherEntity = (typeof OTHER_ENTITIES)[number];

/** Companion form key holding the typed name for `field`. */
export function otherNameKey(fieldName: string): string {
  return `${fieldName}__otherName`;
}

/**
 * `Front Office & Banquets` → `FRONT_OFFICE_BANQUETS`.
 *
 * Upper snake case over `[A-Z0-9_]`, collapsed runs, trimmed ends, capped at 30 so a
 * long sentence cannot overflow a code column. Returns `""` for input with no usable
 * characters, which the caller treats as "no name given".
 */
export function deriveCode(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30)
    .replace(/_+$/g, "");
}

export interface OtherFieldSpec {
  /** The employee column, e.g. `department_id`. */
  readonly field: string;
  readonly entity: OtherEntity;
}

/** The four, in the order the wizard shows them. */
export const OTHER_FIELDS: readonly OtherFieldSpec[] = [
  { field: "department_id", entity: "departments" },
  { field: "section_id", entity: "sections" },
  { field: "designation_id", entity: "designations" },
  { field: "grade_id", entity: "grades" },
];

export interface ResolveOtherInput {
  /** The wizard's raw string values, including the `__otherName` companions. */
  readonly values: Readonly<Record<string, string>>;
  readonly companyId: string;
  /** How many grades already exist — the new one is appended after them. */
  readonly existingGradeCount: number;
}

export class OtherFieldError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "OtherFieldError";
    this.field = field;
  }
}

/**
 * The row each entity needs, given a name and the surrounding form.
 *
 * Exported for the test, and because it is the only place the per-table differences
 * live — a fifth lookup gains an "Other" by adding a branch here and a flag on its
 * field, and nothing else changes.
 */
export function buildOtherRow(
  entity: OtherEntity,
  name: string,
  ctx: { companyId: string; departmentId: string; existingGradeCount: number },
): Record<string, unknown> {
  const code = deriveCode(name);
  const base = { code, name: name.trim(), is_active: true };
  switch (entity) {
    case "departments":
      return { ...base, company_id: ctx.companyId };
    case "designations":
      return { ...base, company_id: ctx.companyId };
    case "grades":
      // Appended at the bottom of the ladder. See the header: inventing a level in
      // the middle of a band structure would silently reorder somebody's grades.
      return { ...base, company_id: ctx.companyId, level: ctx.existingGradeCount + 1 };
    case "sections":
      return { ...base, department_id: ctx.departmentId };
  }
}

/**
 * Create a master row for every field set to "Other", and return the ids to write on
 * the employee.
 *
 * Order matters and is not alphabetical: Department is resolved FIRST, because a new
 * Section hangs off it and may need the id that only just came into existence.
 *
 * A failure here happens BEFORE the employee is inserted, so it is thrown — nothing is
 * half-created, and the wizard can show the message against the offending field.
 */
export async function resolveOtherMasters(
  input: ResolveOtherInput,
  reason: string,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  // Department first — sections need its id.
  const ordered = [...OTHER_FIELDS].sort((a, b) =>
    a.entity === "departments" ? -1 : b.entity === "departments" ? 1 : 0,
  );

  for (const spec of ordered) {
    if (input.values[spec.field] !== OTHER_VALUE) continue;

    const name = (input.values[otherNameKey(spec.field)] ?? "").trim();
    if (name === "") {
      throw new OtherFieldError(spec.field, "Type a name for the new entry, or pick one from the list.");
    }
    if (deriveCode(name) === "") {
      throw new OtherFieldError(spec.field, "Use at least one letter or number in the name.");
    }

    // A section's parent may itself be a brand-new department from this same pass.
    const departmentId = resolved["department_id"] ?? input.values["department_id"] ?? "";
    if (spec.entity === "sections" && (departmentId === "" || departmentId === OTHER_VALUE)) {
      throw new OtherFieldError(
        spec.field,
        "Choose a department first — a new section has to belong to one.",
      );
    }

    const row = buildOtherRow(spec.entity, name, {
      companyId: input.companyId,
      departmentId,
      existingGradeCount: input.existingGradeCount,
    });
    const created = await insertOrgRow(spec.entity, row, reason);
    resolved[spec.field] = (created as { id: string }).id;
  }

  return resolved;
}

/**
 * Strip the `__otherName` companions and swap the sentinels for real ids.
 *
 * The companions are form state, not employee columns; sending them would be a
 * PostgREST error naming a column that does not exist.
 */
export function applyResolvedOthers(
  values: Readonly<Record<string, string>>,
  resolved: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.endsWith("__otherName")) continue;
    out[key] = resolved[key] ?? value;
  }
  return out;
}
