/**
 * self-edit.ts — the employee self-service edit catalogue: WHICH field, by WHICH
 * mechanism, with WHICH input rule, in one place.
 *
 * Everything here was read out of the migrations, not inferred:
 *
 *  1. `public.employee_changeable_fields()`
 *     (`20260801001100_employee_lifecycle.sql`, §2) returns the 29-name array
 *     mirrored below in `EMPLOYEE_CHANGEABLE_FIELDS`. `ecr_insert_guard` raises
 *     42501 for any other `employees` column on a self-inserted change request,
 *     and `apply_change_request` re-checks the same array before it writes. So
 *     this array is the ONLY set an employee can propose, and a name not in it
 *     must render read-only rather than offer a button that will be refused.
 *
 *  2. FOUR of those columns are additionally writable DIRECTLY by the employee.
 *     `20260801000800_employees.sql` grants
 *     `UPDATE (about, photo_path, cover_photo_path, food_preference)` to
 *     `authenticated` and `employees_self_edit_guard` allows exactly that list;
 *     `20260801004800_grants_final.sql` §4 re-asserts both. Everything else in
 *     the whitelist is maker-checker — including `blood_group`,
 *     `marital_status`, `marriage_anniversary` and `preferred_name`, which the
 *     first cut of this screen marked "You can edit". It was wrong: those four
 *     carry no column grant, so a direct save would be refused with 42501.
 *
 *  3. INPUT RULES ARE THE TABLE'S OWN CHECKs, not invented ones:
 *     `ck_employees__personal_email` `^[^@\s]+@[^@\s]+\.[a-z]{2,}$`,
 *     `ck_employees__mobile_in` `^[6-9][0-9]{9}$`,
 *     `ck_employees__category` IN ('GEN','OBC','SC','ST','EWS'),
 *     `ck_employees__food_preference` IN ('veg','non_veg','jain','eggetarian'),
 *     `ck_employees__relation` IN ('father','spouse'),
 *     `ck_employees__sane_dates` (< 2100), plus the `gender`, `blood_group` and
 *     `marital_status` enums. Validating client-side is not a second rulebook —
 *     it stops a round trip whose only outcome would be a SQLSTATE.
 *
 * TWO DELIBERATE OMISSIONS, both with a server reason:
 *  - `photo_path` / `cover_photo_path` are whitelisted but are storage object
 *    paths, not typed values. An editor here would let an employee point their
 *    photo at an arbitrary path; the honest surface is an upload flow against
 *    the `employee-photos` bucket, which this build does not have yet.
 *  - `date_of_birth_actual` is whitelisted but deliberately unrendered (DR-51):
 *    the reference product's shadow "Original DOB" is the defect this build
 *    removed, and reintroducing it as an editable field would restore it.
 *
 * NOTHING here can empty a field. `employee_change_requests.new_value` is
 * `jsonb NOT NULL`, and PostgREST maps a JSON null to SQL NULL, so a "clear this
 * field" request cannot be expressed on the wire at all. The editor says so
 * instead of failing at the database.
 */
import { z } from "zod";
import { fmtCivilDate, istToday } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import {
  bloodGroupLabel,
  genderLabel,
  maritalStatusLabel,
  relationshipLabel,
} from "./display";
import {
  bloodGroupSchema,
  genderSchema,
  maritalStatusSchema,
  type MyEmployeeProfile,
} from "./api/profile.api";

// -----------------------------------------------------------------------------
// 1. The server whitelist, mirrored verbatim
// -----------------------------------------------------------------------------

/**
 * `public.employee_changeable_fields()`, in the order the function returns it.
 * Keep this array and that function identical: a name here that the function
 * has dropped becomes a 42501 the employee cannot act on, and a name the
 * function gained but this array lacks silently stays read-only.
 */
export const EMPLOYEE_CHANGEABLE_FIELDS = [
  "title",
  "first_name",
  "middle_name",
  "last_name",
  "display_name",
  "preferred_name",
  "name_in_local_script",
  "personal_email",
  "mobile",
  "date_of_birth",
  "date_of_birth_actual",
  "gender",
  "marital_status",
  "marriage_anniversary",
  "father_or_spouse_name",
  "father_or_spouse_relation",
  "mother_name",
  "nationality",
  "religion",
  "category",
  "is_differently_abled",
  "disability_type",
  "mode_of_transport",
  "uniform_size",
  "food_preference",
  "blood_group",
  "about",
  "photo_path",
  "cover_photo_path",
] as const;

export type ChangeableField = (typeof EMPLOYEE_CHANGEABLE_FIELDS)[number];

/** Compile-time proof that a rendered field really is in the server whitelist. */
type Whitelisted<T extends ChangeableField> = T;

/**
 * `employees_self_edit_guard` + the column-level `GRANT UPDATE` — the columns an
 * employee writes directly, with no approval in between.
 */
export const SELF_DIRECT_FIELDS = [
  "about",
  "photo_path",
  "cover_photo_path",
  "food_preference",
] as const;

export type SelfDirectField = (typeof SELF_DIRECT_FIELDS)[number];

/** `employee_change_requests.entity_table` for a column on `employees`. */
export const ECR_ENTITY_EMPLOYEES = "employees";

// -----------------------------------------------------------------------------
// 2. The rendered subset, and its editors
// -----------------------------------------------------------------------------

/**
 * The whitelisted fields this build renders an editor for. Excludes the two
 * storage paths and the shadow DOB for the reasons in the file header.
 */
export type EditableField = Whitelisted<
  | "title"
  | "first_name"
  | "middle_name"
  | "last_name"
  | "display_name"
  | "preferred_name"
  | "name_in_local_script"
  | "personal_email"
  | "mobile"
  | "date_of_birth"
  | "gender"
  | "marital_status"
  | "marriage_anniversary"
  | "father_or_spouse_name"
  | "father_or_spouse_relation"
  | "mother_name"
  | "nationality"
  | "religion"
  | "category"
  | "is_differently_abled"
  | "disability_type"
  | "mode_of_transport"
  | "uniform_size"
  | "food_preference"
  | "blood_group"
  | "about"
>;

/** How the change reaches the database. */
export type EditMechanism = "direct" | "change_request";

export type EditorKind = "text" | "textarea" | "date" | "select" | "boolean";

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface EditableFieldSpec {
  readonly column: EditableField;
  readonly mechanism: EditMechanism;
  readonly editor: EditorKind;
  /** Human field name — the `field_label` HR reads in the approval queue. */
  readonly labelKey: MessageKey;
  /** One line under the control, explaining what the field is for. */
  readonly helpKey?: MessageKey;
  readonly maxLength?: number;
  /** Mirror of the column's own CHECK; the message names the accepted shape. */
  readonly pattern?: RegExp;
  readonly patternMessageKey?: MessageKey;
  /** A date field that cannot be in the future (DOB, wedding date). */
  readonly noFutureDate?: boolean;
  readonly earliestDate?: string;
  readonly inputMode?: "text" | "numeric";
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const MOBILE_PATTERN = /^[6-9][0-9]{9}$/;
/** `ck_employees__sane_dates` bans year-3000 sentinels; 1920 bounds the low end. */
const EARLIEST_PERSONAL_DATE = "1920-01-01";
/** `about` shows on a peer-visible card; spec-employee E-07 caps it at 280. */
export const ABOUT_MAX_LENGTH = 280;

const SPECS: Readonly<Record<EditableField, EditableFieldSpec>> = {
  title: {
    column: "title",
    mechanism: "change_request",
    editor: "text",
    labelKey: "profile.field.salutation",
    maxLength: 16,
  },
  first_name: {
    column: "first_name",
    mechanism: "change_request",
    editor: "text",
    labelKey: "me.edit.field.firstName",
    maxLength: 80,
  },
  middle_name: {
    column: "middle_name",
    mechanism: "change_request",
    editor: "text",
    labelKey: "me.edit.field.middleName",
    maxLength: 80,
  },
  last_name: {
    column: "last_name",
    mechanism: "change_request",
    editor: "text",
    labelKey: "me.edit.field.lastName",
    maxLength: 80,
  },
  display_name: {
    column: "display_name",
    mechanism: "change_request",
    editor: "text",
    labelKey: "profile.field.displayName",
    maxLength: 120,
  },
  preferred_name: {
    column: "preferred_name",
    mechanism: "change_request",
    editor: "text",
    labelKey: "profile.field.preferredName",
    maxLength: 80,
  },
  name_in_local_script: {
    column: "name_in_local_script",
    mechanism: "change_request",
    editor: "text",
    labelKey: "me.edit.field.nameInLocalScript",
    helpKey: "me.edit.field.nameInLocalScript.hint",
    maxLength: 120,
  },
  personal_email: {
    column: "personal_email",
    mechanism: "change_request",
    editor: "text",
    labelKey: "me.edit.field.personalEmail",
    helpKey: "me.edit.field.personalEmail.hint",
    maxLength: 254,
    pattern: EMAIL_PATTERN,
    patternMessageKey: "me.edit.invalid.email",
  },
  mobile: {
    column: "mobile",
    mechanism: "change_request",
    editor: "text",
    labelKey: "me.edit.field.mobile",
    helpKey: "me.edit.field.mobile.hint",
    maxLength: 10,
    pattern: MOBILE_PATTERN,
    patternMessageKey: "me.edit.invalid.mobile",
    inputMode: "numeric",
  },
  date_of_birth: {
    column: "date_of_birth",
    mechanism: "change_request",
    editor: "date",
    labelKey: "profile.field.dob",
    helpKey: "profile.field.dob.hint",
    noFutureDate: true,
    earliestDate: EARLIEST_PERSONAL_DATE,
  },
  gender: {
    column: "gender",
    mechanism: "change_request",
    editor: "select",
    labelKey: "profile.field.gender",
  },
  marital_status: {
    column: "marital_status",
    mechanism: "change_request",
    editor: "select",
    labelKey: "profile.field.maritalStatus",
  },
  marriage_anniversary: {
    column: "marriage_anniversary",
    mechanism: "change_request",
    editor: "date",
    labelKey: "profile.field.marriageAnniversary",
    noFutureDate: true,
    earliestDate: EARLIEST_PERSONAL_DATE,
  },
  father_or_spouse_name: {
    column: "father_or_spouse_name",
    mechanism: "change_request",
    editor: "text",
    labelKey: "profile.field.fatherOrSpouse",
    maxLength: 120,
  },
  father_or_spouse_relation: {
    column: "father_or_spouse_relation",
    mechanism: "change_request",
    editor: "select",
    labelKey: "me.edit.field.relation",
  },
  mother_name: {
    column: "mother_name",
    mechanism: "change_request",
    editor: "text",
    labelKey: "profile.field.motherName",
    maxLength: 120,
  },
  nationality: {
    column: "nationality",
    mechanism: "change_request",
    editor: "text",
    labelKey: "profile.field.nationality",
    maxLength: 60,
  },
  religion: {
    column: "religion",
    mechanism: "change_request",
    editor: "text",
    labelKey: "me.edit.field.religion",
    maxLength: 60,
  },
  category: {
    column: "category",
    mechanism: "change_request",
    editor: "select",
    labelKey: "me.edit.field.category",
    helpKey: "me.edit.field.category.hint",
  },
  is_differently_abled: {
    column: "is_differently_abled",
    mechanism: "change_request",
    editor: "boolean",
    labelKey: "me.edit.field.differentlyAbled",
  },
  disability_type: {
    column: "disability_type",
    mechanism: "change_request",
    editor: "text",
    labelKey: "me.edit.field.disabilityType",
    helpKey: "me.edit.field.disabilityType.hint",
    maxLength: 120,
  },
  mode_of_transport: {
    column: "mode_of_transport",
    mechanism: "change_request",
    editor: "text",
    labelKey: "me.edit.field.modeOfTransport",
    helpKey: "me.edit.field.modeOfTransport.hint",
    maxLength: 60,
  },
  uniform_size: {
    column: "uniform_size",
    mechanism: "change_request",
    editor: "text",
    labelKey: "me.edit.field.uniformSize",
    helpKey: "me.edit.field.uniformSize.hint",
    maxLength: 24,
  },
  blood_group: {
    column: "blood_group",
    mechanism: "change_request",
    editor: "select",
    labelKey: "profile.field.bloodGroup",
  },
  // The two the database really does let the employee write directly.
  food_preference: {
    column: "food_preference",
    mechanism: "direct",
    editor: "select",
    labelKey: "me.edit.field.foodPreference",
    helpKey: "me.edit.field.foodPreference.hint",
  },
  about: {
    column: "about",
    mechanism: "direct",
    editor: "textarea",
    labelKey: "me.edit.field.about",
    helpKey: "me.edit.field.about.hint",
    maxLength: ABOUT_MAX_LENGTH,
  },
};

export function fieldSpec(column: EditableField): EditableFieldSpec {
  return SPECS[column];
}

/** The human field name — also the `field_label` stored on the request row. */
export function fieldLabel(column: EditableField): string {
  return t(SPECS[column].labelKey);
}

/** True when the database lets the employee write this column themselves. */
export function isDirectField(column: EditableField): boolean {
  return SPECS[column].mechanism === "direct";
}

/**
 * The direct-editable columns this build actually renders an editor for. Both are
 * `text`, which is what lets `updateSelfEditableField` take a plain string.
 *
 * `photo_path` and `cover_photo_path` are the other two the grant covers and are
 * NOT here: they are storage object paths, not typed values.
 */
export type DirectEditableField = Whitelisted<"about" | "food_preference">;

/**
 * Narrow a column to one the direct-save path can carry, or `null`.
 *
 * The caller falls back to a change request on `null`, which degrades safely: any
 * column marked `direct` is also in the server whitelist, so the request path
 * accepts it. A silent no-op would not.
 */
export function asDirectField(column: EditableField): DirectEditableField | null {
  return column === "about" || column === "food_preference" ? column : null;
}

// -----------------------------------------------------------------------------
// 3. Option vocabularies
// -----------------------------------------------------------------------------

const CATEGORY_LABEL_KEY = {
  GEN: "me.edit.category.gen",
  OBC: "me.edit.category.obc",
  SC: "me.edit.category.sc",
  ST: "me.edit.category.st",
  EWS: "me.edit.category.ews",
} as const;

const FOOD_LABEL_KEY = {
  veg: "me.edit.food.veg",
  non_veg: "me.edit.food.nonVeg",
  jain: "me.edit.food.jain",
  eggetarian: "me.edit.food.eggetarian",
} as const;

/**
 * `blood_group` carries `'unknown'`, which the display layer renders as an em
 * dash because it means "not recorded". It is therefore not offered as a
 * CHOICE — an employee sets a real group; only HR resets a record to unknown.
 */
const BLOOD_GROUP_CHOICES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;

/** The values a select-style field accepts, already labelled for a person. */
export function fieldOptions(column: EditableField): readonly FieldOption[] {
  switch (column) {
    case "gender":
      return genderSchema.options.map((value) => ({ value, label: genderLabel(value) }));
    case "marital_status":
      return maritalStatusSchema.options.map((value) => ({
        value,
        label: maritalStatusLabel(value),
      }));
    case "blood_group":
      return BLOOD_GROUP_CHOICES.map((value) => ({ value, label: bloodGroupLabel(value) }));
    case "father_or_spouse_relation":
      return (["father", "spouse"] as const).map((value) => ({
        value,
        label: relationshipLabel(value),
      }));
    case "category":
      return (["GEN", "OBC", "SC", "ST", "EWS"] as const).map((value) => ({
        value,
        label: t(CATEGORY_LABEL_KEY[value]),
      }));
    case "food_preference":
      return (["veg", "non_veg", "jain", "eggetarian"] as const).map((value) => ({
        value,
        label: t(FOOD_LABEL_KEY[value]),
      }));
    case "is_differently_abled":
      return [
        { value: "true", label: t("profile.custom.yes") },
        { value: "false", label: t("profile.custom.no") },
      ];
    default:
      return [];
  }
}

// -----------------------------------------------------------------------------
// 4. Reading the current value off THE profile row
// -----------------------------------------------------------------------------

/** A field value as it travels on the wire: a jsonb scalar or nothing. */
export type FieldValue = string | boolean | null;

/**
 * The value currently on the record, as a control value.
 *
 * Exhaustive over `EditableField` on purpose: adding a field to the union
 * without teaching this function to read it is a compile error, not a silently
 * blank editor.
 */
export function readFieldValue(
  profile: MyEmployeeProfile,
  column: EditableField,
): FieldValue {
  switch (column) {
    case "title":
      return profile.title;
    case "first_name":
      return profile.first_name;
    case "middle_name":
      return profile.middle_name;
    case "last_name":
      return profile.last_name;
    case "display_name":
      return profile.display_name;
    case "preferred_name":
      return profile.preferred_name;
    case "name_in_local_script":
      return profile.name_in_local_script;
    case "personal_email":
      return profile.personal_email;
    case "mobile":
      return profile.mobile;
    case "date_of_birth":
      return profile.date_of_birth;
    case "gender":
      return profile.gender;
    case "marital_status":
      return profile.marital_status;
    case "marriage_anniversary":
      return profile.marriage_anniversary;
    case "father_or_spouse_name":
      return profile.father_or_spouse_name;
    case "father_or_spouse_relation":
      return profile.father_or_spouse_relation;
    case "mother_name":
      return profile.mother_name;
    case "nationality":
      return profile.nationality;
    case "religion":
      return profile.religion;
    case "category":
      return profile.category;
    case "is_differently_abled":
      return profile.is_differently_abled;
    case "disability_type":
      return profile.disability_type;
    case "mode_of_transport":
      return profile.mode_of_transport;
    case "uniform_size":
      return profile.uniform_size;
    case "food_preference":
      return profile.food_preference;
    case "blood_group":
      return profile.blood_group === "unknown" ? null : profile.blood_group;
    case "about":
      return profile.about;
  }
}

/** The control's starting string for a value already on the record. */
export function toControlValue(value: FieldValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

// -----------------------------------------------------------------------------
// 5. Rendering a value a person can read
// -----------------------------------------------------------------------------

/**
 * A field value → the sentence shown on the row, in the editor's "on your record
 * now" line, and inside the pending note. One implementation, so the value the
 * employee asked for and the value they see waiting are formatted identically.
 */
export function displayFieldValue(column: EditableField, value: FieldValue): string {
  if (value === null || value === "") return dash(null);
  const spec = SPECS[column];
  if (spec.editor === "date" && typeof value === "string") return fmtCivilDate(value);
  const raw = typeof value === "boolean" ? (value ? "true" : "false") : value;
  const option = fieldOptions(column).find((o) => o.value === raw);
  return option?.label ?? raw;
}

/**
 * The same, for the `new_value`/`old_value` jsonb a change-request row carries.
 * `unknown` in, a sentence out — never `[object Object]` and never a bare code.
 */
export function displayRequestValue(column: EditableField, value: unknown): string {
  if (value === null || value === undefined || value === "") return dash(null);
  if (typeof value === "string" || typeof value === "boolean") {
    return displayFieldValue(column, value);
  }
  if (typeof value === "number") return displayFieldValue(column, String(value));
  return JSON.stringify(value);
}

// -----------------------------------------------------------------------------
// 6. Validation — the table's own rules, checked before the round trip
// -----------------------------------------------------------------------------

export type FieldValidation =
  | { readonly ok: true; readonly value: string | boolean }
  | { readonly ok: false; readonly message: string };

const ENUM_SCHEMA: Partial<Readonly<Record<EditableField, z.ZodTypeAny>>> = {
  gender: genderSchema,
  marital_status: maritalStatusSchema,
  blood_group: bloodGroupSchema,
};

/**
 * Validate a control value against the column's real constraints and hand back
 * the jsonb scalar to send.
 *
 * A blank input is always refused: `employee_change_requests.new_value` is NOT
 * NULL and a direct update to blank would be an unstated deletion. "Remove this
 * value" is an HR action, and the message says so.
 */
export function validateFieldInput(
  column: EditableField,
  raw: string,
  current: FieldValue,
): FieldValidation {
  const spec = SPECS[column];
  const trimmed = raw.trim();

  if (trimmed === "") {
    return {
      ok: false,
      message: spec.mechanism === "direct" ? t("me.edit.invalid.required") : t("me.edit.sheet.noClear"),
    };
  }

  if (spec.editor === "boolean") {
    if (trimmed !== "true" && trimmed !== "false") {
      return { ok: false, message: t("me.edit.invalid.option") };
    }
    const value = trimmed === "true";
    if (value === current) return { ok: false, message: t("me.edit.invalid.unchanged") };
    return { ok: true, value };
  }

  if (spec.editor === "select") {
    const allowed = fieldOptions(column).some((o) => o.value === trimmed);
    const enumSchema = ENUM_SCHEMA[column];
    const enumOk = enumSchema === undefined || enumSchema.safeParse(trimmed).success;
    if (!allowed || !enumOk) return { ok: false, message: t("me.edit.invalid.option") };
  }

  if (spec.editor === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return { ok: false, message: t("me.edit.invalid.date") };
    }
    if (spec.noFutureDate === true && trimmed > istToday()) {
      return { ok: false, message: t("me.edit.invalid.dateFuture") };
    }
    if (spec.earliestDate !== undefined && trimmed < spec.earliestDate) {
      return {
        ok: false,
        message: t("me.edit.invalid.dateTooEarly", { min: fmtCivilDate(spec.earliestDate) }),
      };
    }
  }

  if (spec.maxLength !== undefined && trimmed.length > spec.maxLength) {
    return { ok: false, message: t("me.edit.invalid.tooLong", { max: spec.maxLength }) };
  }

  if (spec.pattern !== undefined && !spec.pattern.test(trimmed)) {
    return {
      ok: false,
      message: spec.patternMessageKey === undefined
        ? t("me.edit.invalid.option")
        : t(spec.patternMessageKey),
    };
  }

  if (trimmed === current) return { ok: false, message: t("me.edit.invalid.unchanged") };

  return { ok: true, value: trimmed };
}

/** `max` bound for a date control, so the platform picker refuses the future. */
export function dateBounds(column: EditableField): {
  readonly min?: string;
  readonly max?: string;
} {
  const spec = SPECS[column];
  if (spec.editor !== "date") return {};
  return {
    ...(spec.earliestDate !== undefined ? { min: spec.earliestDate } : {}),
    ...(spec.noFutureDate === true ? { max: istToday() } : {}),
  };
}
