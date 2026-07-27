/**
 * types.ts — the E-07 edit-authority model, as data.
 *
 * spec-employee §6 defines four authorities per field. The reference product
 * exposed none of them: an employee discovered a field was HR-owned by editing
 * it and watching the save fail, or worse, by watching an edit silently vanish.
 * So authority is a first-class, RENDERED property of every field on every tab —
 * `<FieldRow authority="maker_checker">` prints the marker next to the label and
 * the legend at the top of the card explains it once.
 *
 * `admin_hidden` (🔒) exists in the model for completeness but must never reach
 * a component: those fields are not selected by any `api/` module here, and the
 * database does not grant them to `authenticated` either (migration 033 revokes
 * table SELECT and re-grants a narrow column list).
 */

export type EditAuthority = "self" | "maker_checker" | "admin_only" | "admin_hidden";

/** The three authorities an employee can actually see on their own record. */
export const VISIBLE_AUTHORITIES: readonly EditAuthority[] = [
  "self",
  "maker_checker",
  "admin_only",
];

/** i18n key of the short marker label, e.g. "Needs HR approval". */
export const AUTHORITY_LABEL_KEY = {
  self: "profile.authority.self",
  maker_checker: "profile.authority.makerChecker",
  admin_only: "profile.authority.adminOnly",
  admin_hidden: "profile.authority.adminHidden",
} as const;

/** i18n key of the one-line explanation shown in the legend and tooltip. */
export const AUTHORITY_HINT_KEY = {
  self: "profile.authority.self.hint",
  maker_checker: "profile.authority.makerChecker.hint",
  admin_only: "profile.authority.adminOnly.hint",
  admin_hidden: "profile.authority.adminHidden.hint",
} as const;
