/**
 * common.ts — the five columns every `public.*` reference table shares
 * (`code`, `name`, `description`, `sort_order`, `is_active`), expressed once.
 *
 * Twelve screens repeating these five specs is twelve chances for the help text
 * to drift, and the help text is the point: "Short code — exports and the audit
 * trail only, never in front of an employee" is the sentence that stops the
 * reference product's `PP001` / `None1` leakage from coming back (DR-53).
 */
import { t } from "@/shared/i18n/en";
import { CODE_PATTERN, type FieldSpec } from "./fields";

/** Immutable after creation: other systems and exports already quote it. */
export const codeField: FieldSpec = {
  name: "code",
  label: t("admin.master.field.code"),
  kind: "code",
  help: t("admin.master.help.code"),
  required: true,
  createOnly: true,
  maxLength: 12,
  pattern: CODE_PATTERN,
};

export const nameField: FieldSpec = {
  name: "name",
  label: t("admin.master.field.name"),
  kind: "text",
  help: t("admin.master.help.name"),
  required: true,
  maxLength: 120,
};

export const descriptionField: FieldSpec = {
  name: "description",
  label: t("admin.master.field.description"),
  kind: "textarea",
  help: t("admin.master.help.description"),
  maxLength: 500,
};

export const sortOrderField: FieldSpec = {
  name: "sort_order",
  label: t("admin.master.field.sortOrder"),
  kind: "number",
  help: t("admin.master.help.sortOrder"),
  min: 0,
  max: 9999,
};

export const isActiveField: FieldSpec = {
  name: "is_active",
  label: t("admin.master.field.isActive"),
  kind: "checkbox",
  help: t("admin.master.help.isActive"),
};

/** Identity group for a master that has all five shared columns. */
export function identityGroup(extra: readonly FieldSpec[] = []): {
  title: string;
  fields: readonly FieldSpec[];
} {
  return {
    title: t("admin.master.group.identity"),
    fields: [codeField, nameField, descriptionField, sortOrderField, ...extra, isActiveField],
  };
}

/** Defaults every create form starts from. */
export const BASE_CREATE_DEFAULTS: Readonly<Record<string, string>> = {
  is_active: "true",
  sort_order: "100",
};
