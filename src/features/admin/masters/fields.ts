/**
 * fields.ts — the declarative field model behind every lookup-master form in
 * `/admin/org/**` and `/admin/time/**`.
 *
 * Why a model instead of twelve hand-written forms:
 *
 *  1. `help` is REQUIRED on anything the engine reads. These rows are not
 *     decoration — an attendance policy's grace is the number the engine
 *     applies, and a shift's thresholds decide whether a day is an absent. A
 *     form that shows `grace_in_minutes` without saying what it does is how a
 *     venue ends up docking pay it did not mean to dock.
 *  2. One coercion path. A `time` input yields 'HH:MM', a checkbox yields a
 *     boolean, an empty text box yields NULL not ''. Doing that per screen is
 *     how a NOT NULL column gets an empty string.
 *  3. One validation path, mirroring the DB CHECKs the admin can actually hit
 *     (threshold order on shifts, window order on pay periods), so the round
 *     trip is spent on real work rather than on a constraint we could have
 *     caught in the browser.
 *
 * Everything here is pure. No supabase, no React.
 */
import { t, type MessageKey } from "@/shared/i18n/en";

export type FieldKind =
  | "text"
  | "textarea"
  | "code"
  | "number"
  | "decimal"
  /** Rupees in the input, integer paise on the wire. */
  | "rupees"
  | "checkbox"
  | "select"
  /** Postgres `date` — 'YYYY-MM-DD'. */
  | "date"
  /** Postgres `time` — 'HH:MM'. */
  | "time"
  /** 0–6 weekday, Sunday = 0. */
  | "dow"
  /** smallint[] of week-of-month numbers 1–5. */
  | "weeks"
  /** smallint[] of weekday numbers, typed as '2,3' — a rotation cycle. */
  | "dowList"
  /** uuid[] as a tick list. */
  | "multi"
  /** Hex colour. */
  | "colour";

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldSpec {
  /** The database column. Also the form-state key. */
  readonly name: string;
  readonly label: string;
  readonly kind: FieldKind;
  /**
   * What this field MEANS in the running system. Mandatory for every number and
   * every flag; omitted only for name/description-style fields whose meaning is
   * the label.
   */
  readonly help?: string;
  readonly required?: boolean;
  readonly options?: readonly FieldOption[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly pattern?: { readonly re: RegExp; readonly messageKey: MessageKey };
  /** Writable on create, read-only afterwards (a code others already quote). */
  readonly createOnly?: boolean;
  /** Never writable: the database computes it. Rendered, never sent. */
  readonly derived?: boolean;
  /** Full-width in the two-column grid. */
  readonly wide?: boolean;
  /**
   * A closed lookup that also offers "Other", with a name box that becomes a real
   * master row on save. Only meaningful for `kind: "select"`; the entity names which
   * table the new row goes into. See `people/orgOther.ts` for what each table demands
   * and why a new Section needs a Department first.
   */
  readonly allowOther?: boolean;
  readonly otherEntity?: string;
}

export interface FieldGroup {
  readonly title: string;
  readonly hint?: string;
  readonly fields: readonly FieldSpec[];
}

/** Form state: every field is a string, exactly as the DOM holds it. */
export type FormValues = Readonly<Record<string, string>>;
export type FieldErrors = Readonly<Record<string, string>>;

export const CODE_PATTERN = {
  re: /^[A-Z0-9][A-Z0-9-]{1,11}$/,
  messageKey: "admin.master.err.pattern.code" as MessageKey,
};

export const COLOUR_PATTERN = {
  re: /^#[0-9A-Fa-f]{6}$/,
  messageKey: "admin.master.err.pattern.colour" as MessageKey,
};

// -----------------------------------------------------------------------------
// Row → form values
// -----------------------------------------------------------------------------

function stringifyOne(kind: FieldKind, raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  switch (kind) {
    case "checkbox":
      return raw === true ? "true" : "false";
    case "time":
      // Postgres hands back '09:30:00'; <input type="time"> wants '09:30'.
      return typeof raw === "string" ? raw.slice(0, 5) : "";
    case "rupees":
      // Integer paise on the wire, rupees in the box. A unit change on an input
      // value — not a business figure, which always comes from a server view.
      return typeof raw === "number" ? String(raw / 100) : "";
    case "weeks":
    case "dowList":
    case "multi":
      return Array.isArray(raw) ? raw.map((v) => String(v)).join(",") : "";
    default:
      return String(raw);
  }
}

/** Initial form state for `row` (null → a create form of empty strings). */
export function valuesFromRow(
  groups: readonly FieldGroup[],
  row: Readonly<Record<string, unknown>> | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const group of groups) {
    for (const field of group.fields) {
      out[field.name] = row === null ? "" : stringifyOne(field.kind, row[field.name]);
    }
  }
  return out;
}

/** Defaults for a create form: booleans that should start on, seed numbers. */
export function withDefaults(
  values: Record<string, string>,
  defaults: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...values, ...defaults };
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function isBlank(value: string): boolean {
  return value.trim() === "";
}

/** Field-level validation. Returns `{}` when everything passes. */
export function validateFields(
  groups: readonly FieldGroup[],
  values: FormValues,
  mode: "create" | "edit",
): FieldErrors {
  const errors: Record<string, string> = {};
  for (const group of groups) {
    for (const field of group.fields) {
      if (field.derived) continue;
      if (field.createOnly && mode === "edit") continue;
      const raw = values[field.name] ?? "";
      const value = raw.trim();

      if (field.required === true && isBlank(value) && field.kind !== "checkbox") {
        errors[field.name] = t("admin.master.err.required");
        continue;
      }
      if (isBlank(value)) continue;

      if (field.maxLength !== undefined && value.length > field.maxLength) {
        errors[field.name] = t("admin.master.err.maxLength", { max: field.maxLength });
        continue;
      }

      if (field.kind === "number" || field.kind === "dow") {
        if (!/^-?\d+$/.test(value)) {
          errors[field.name] = t("admin.master.err.int");
          continue;
        }
      } else if (field.kind === "decimal" || field.kind === "rupees") {
        if (!/^-?\d+(\.\d+)?$/.test(value)) {
          errors[field.name] = t("admin.master.err.number");
          continue;
        }
      }

      if (
        field.kind === "number" ||
        field.kind === "decimal" ||
        field.kind === "rupees" ||
        field.kind === "dow"
      ) {
        const n = Number(value);
        const min = field.min;
        const max = field.max;
        if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
          errors[field.name] = t("admin.master.err.range", {
            min: min ?? 0,
            max: max ?? 0,
          });
          continue;
        }
      }

      if (field.pattern && !field.pattern.re.test(value)) {
        errors[field.name] = t(field.pattern.messageKey);
      }
    }
  }
  return errors;
}

// -----------------------------------------------------------------------------
// Form values → DB payload
// -----------------------------------------------------------------------------

function coerceOne(field: FieldSpec, raw: string): unknown {
  const value = raw.trim();
  switch (field.kind) {
    case "checkbox":
      return value === "true";
    case "number":
    case "dow":
      return value === "" ? null : Number.parseInt(value, 10);
    case "decimal":
      return value === "" ? null : Number(value);
    case "rupees":
      return value === "" ? null : Math.round(Number(value) * 100);
    case "weeks":
    case "dowList":
      return value === ""
        ? null
        : value
            .split(",")
            .map((part) => Number.parseInt(part.trim(), 10))
            .filter((n) => Number.isInteger(n))
            .sort((a, b) => a - b);
    case "multi":
      return value === "" ? null : value.split(",").filter((part) => part.trim() !== "");
    default:
      return value === "" ? null : value;
  }
}

/**
 * The patch/insert payload. `derived` fields are never sent (the database owns
 * them) and `createOnly` fields are dropped on an edit, so an untouched code
 * cannot be rewritten by accident.
 *
 * On EDIT only changed fields are included: `updateRow` refuses an empty patch,
 * and a patch that re-states every column writes a pointless audit diff.
 */
export function coerceValues(
  groups: readonly FieldGroup[],
  values: FormValues,
  mode: "create" | "edit",
  original: FormValues | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const group of groups) {
    for (const field of group.fields) {
      if (field.derived) continue;
      if (field.createOnly && mode === "edit") continue;
      const raw = values[field.name] ?? "";
      if (mode === "edit" && original !== null && (original[field.name] ?? "") === raw) continue;
      out[field.name] = coerceOne(field, raw);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Change summary — the diff line the reason dialog shows (spec-admin §3.5)
// -----------------------------------------------------------------------------

const EMPTY_DISPLAY = "—";

function displayFor(field: FieldSpec, raw: string): string {
  const value = raw.trim();
  if (value === "") return EMPTY_DISPLAY;
  switch (field.kind) {
    case "checkbox":
      return value === "true" ? t("admin.master.yes") : t("admin.master.no");
    case "select":
      return field.options?.find((o) => o.value === value)?.label ?? value;
    case "dow":
      return dowLabel(Number(value));
    case "weeks":
      return value
        .split(",")
        .map((n) => weekLabel(Number(n.trim())))
        .join(", ");
    case "dowList":
      return value
        .split(",")
        .map((n) => dowLabel(Number(n.trim())))
        .join(", ");
    case "multi":
      return String(value.split(",").length);
    default:
      return value;
  }
}

/** Human list of what is about to change, for the reason dialog's description. */
export function changeSummary(
  groups: readonly FieldGroup[],
  before: FormValues,
  after: FormValues,
): string[] {
  const changes: string[] = [];
  for (const group of groups) {
    for (const field of group.fields) {
      if (field.derived) continue;
      const from = before[field.name] ?? "";
      const to = after[field.name] ?? "";
      if (from === to) continue;
      changes.push(
        t("admin.master.changes.one", {
          label: field.label,
          before: displayFor(field, from),
          after: displayFor(field, to),
        }),
      );
    }
  }
  return changes;
}

// -----------------------------------------------------------------------------
// Weekday / week-of-month labels (rendered, never a bare number — D-10)
// -----------------------------------------------------------------------------

const DOW_KEYS: readonly MessageKey[] = [
  "admin.master.dow.0",
  "admin.master.dow.1",
  "admin.master.dow.2",
  "admin.master.dow.3",
  "admin.master.dow.4",
  "admin.master.dow.5",
  "admin.master.dow.6",
];

const WEEK_KEYS: readonly MessageKey[] = [
  "admin.master.week.1",
  "admin.master.week.2",
  "admin.master.week.3",
  "admin.master.week.4",
  "admin.master.week.5",
];

/** 0 → 'Sunday'. Out of range → '—' rather than an invented day. */
export function dowLabel(dow: number | null | undefined): string {
  if (dow === null || dow === undefined) return EMPTY_DISPLAY;
  const key = DOW_KEYS[dow];
  return key === undefined ? EMPTY_DISPLAY : t(key);
}

/** 2 → '2nd'. */
export function weekLabel(week: number | null | undefined): string {
  if (week === null || week === undefined) return EMPTY_DISPLAY;
  const key = WEEK_KEYS[week - 1];
  return key === undefined ? EMPTY_DISPLAY : t(key);
}

export const DOW_OPTIONS: readonly FieldOption[] = DOW_KEYS.map((key, i) => ({
  value: String(i),
  label: t(key),
}));

/** Options built from a reference list, so a picker shows names, never codes. */
export function refOptions(
  rows: readonly { readonly id: string; readonly name: string }[] | undefined,
  excludeId?: string,
): FieldOption[] {
  return (rows ?? [])
    .filter((row) => row.id !== excludeId)
    .map((row) => ({ value: row.id, label: row.name }));
}
