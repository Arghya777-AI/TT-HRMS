/**
 * identifier.ts — what the login screen accepts in its ONE field, kept no
 * narrower than the authorities beneath it.
 *
 * THE BUG THIS FILE EXISTS TO PREVENT. `Login.tsx` used to test employee codes
 * against `/^TT\d{4}$/i`, which is narrower than every layer below it and so
 * rejected, in the browser, codes the server would have accepted:
 *
 *   · the edge functions (`auth-identify`, `webauthn-login`, `face-login`, all
 *     three carrying the same `classifyIdentifier`) accept
 *     `^[A-Z]{1,6}[0-9]{1,10}$` after stripping spaces, dots, underscores and
 *     hyphens and upper-casing;
 *   · the DATABASE makes the shape configurable per company —
 *     `public.companies.employee_code_prefix` (text, default 'TT') and
 *     `employee_code_padding` (integer, `ck_companies__code_padding` BETWEEN 1
 *     AND 8), migration 20260801000700_org_structure.sql. Migration
 *     20260801000800_employees.sql allocates codes as
 *     `^' || v_prefix || '[0-9]+$`.
 *
 * So a company configured with prefix `TTV` or padding 5 issues real codes that
 * the old client-side test called invalid — a sign-in screen refusing an
 * employee's own code before the server was ever asked. The rule here mirrors
 * the edge functions exactly: same normalisation, same pattern. Where the two
 * disagree the server must win, which is why this is a "looks like" test and not
 * a validation — the answer to "is this a real code" only exists server-side.
 */

/**
 * The edge functions' `CODE_RE`, character for character. Case-insensitivity is
 * handled by normalising first (they upper-case; so do we), not by an `i` flag,
 * so the two cannot drift.
 */
const CODE_RE = /^[A-Z]{1,6}[0-9]{1,10}$/;

/** The functions' `EMAIL_RE`. An identifier containing '@' is only ever an email. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/;

/**
 * `tt 0042`, `tt-0042` and `TT0042` are one code — the same separators the edge
 * functions strip, stripped the same way, so one budget and one lookup.
 */
export function normaliseEmployeeCode(raw: string): string {
  return raw.trim().replace(/[\s._-]+/g, "").toUpperCase();
}

/** True when the value could be an employee code for ANY configured company. */
export function looksLikeEmployeeCode(raw: string): boolean {
  return CODE_RE.test(normaliseEmployeeCode(raw));
}

/** True when the value is shaped like an email address. */
export function looksLikeEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim().toLowerCase());
}

/**
 * Is this worth sending to `auth-identify` at all? An identifier containing '@'
 * has to be a well-formed address; anything else has to be code-shaped.
 */
export function isPlausibleIdentifier(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  return trimmed.includes("@") ? looksLikeEmail(trimmed) : looksLikeEmployeeCode(trimmed);
}

/**
 * How to show back what was typed: a code in the canonical form the database
 * stores, an email as typed. Used for the "Signing in as …" banner only — the
 * value SENT is always exactly what the employee typed, because the functions
 * normalise it themselves and are the authority on the result.
 */
export function displayIdentifier(raw: string): string {
  const trimmed = raw.trim();
  return looksLikeEmployeeCode(trimmed) ? normaliseEmployeeCode(trimmed) : trimmed;
}
