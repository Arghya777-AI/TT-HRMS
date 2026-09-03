/**
 * evidenceFields.ts — turning a detail row into something an approver can read.
 *
 * ── WHY THIS IS A MODULE AND NOT INLINE JSX ─────────────────────────────────
 * `approval_request_evidence` returns whatever the detail row holds, across 13 tables. That is
 * deliberate — a closed schema per table is 13 chances to forget the reason column — but it
 * puts the whole burden of "is this readable by a human" here. Two rules do the work:
 *
 *   ORDER    The reason is what an approver is looking for, so it is never below a
 *            bookkeeping column. Known keys sort by an explicit rank; unknown keys keep
 *            alphabetical order after them, so a new column appears rather than hides.
 *
 *   TYPE     Decided by the key's SUFFIX, not by guessing from the value: `*_paise` is money,
 *            `*_at` is an instant, `*_date` is a civil date. A value whose type does not match
 *            its suffix is rendered as text rather than mis-formatted — a string in a `_paise`
 *            column should look wrong, not look like ₹0.
 *
 * Testable on its own, which is the point: the JSX around it cannot be.
 */

/** Keys an approver reads first, in the order they should appear. */
const RANK: readonly string[] = [
  // What it is
  "leave_type", "claim_type", "claim_kind", "regularization_kind", "asset_type",
  "request_number", "claim_number",
  // Why — the thing HR said was missing
  "reason", "employee_reason", "purpose", "travel_purpose", "reason_category",
  "declaration_note", "notes", "note", "event_reference",
  // When
  "ist_date", "from_date", "to_date", "period_from", "period_to",
  "requested_first_in_at", "requested_last_out_at", "requested_status",
  "portion", "total_days", "paid_days", "unpaid_days", "approved_days",
  // How much
  "total_claimed_paise", "total_approved_paise", "advance_adjusted_paise", "amount_paise",
  // Where / who to reach
  "from_location", "to_location", "address_during_leave", "contact_during_leave",
  "handover_notes", "lat", "lng", "geofence_ok",
  // State
  "status", "is_backdated", "month_quota_counter",
  // The decision, last: it is the approver's own words, not the request
  "decision_comment", "decided_comment", "decided_at", "applied_at",
];

const RANK_OF = new Map(RANK.map((k, i) => [k, i]));

export function orderEvidenceKeys(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => {
    const ra = RANK_OF.get(a);
    const rb = RANK_OF.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    // Ranked keys first; everything else alphabetically AFTER them, so a column
    // nobody has ranked yet still shows up.
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.localeCompare(b);
  });
}

export type EvidenceValueKind = "money" | "instant" | "date" | "boolean" | "text";

/**
 * How to render one key's value.
 *
 * SUFFIX FIRST, VALUE SECOND. `total_claimed_paise` is money because of its name; if it
 * arrives as something other than a number it falls back to text, because a mis-typed value
 * should look wrong rather than be quietly formatted into a plausible amount.
 */
export function evidenceValueKind(key: string, value: unknown): EvidenceValueKind {
  if (typeof value === "boolean") return "boolean";
  if (key.endsWith("_paise")) return typeof value === "number" ? "money" : "text";
  if (key.endsWith("_at")) return typeof value === "string" ? "instant" : "text";
  if (key.endsWith("_date") || key === "ist_date") return typeof value === "string" ? "date" : "text";
  return "text";
}

/**
 * A label for a key with no translation of its own.
 *
 * `employee_reason` becomes "Employee reason". Not a substitute for a real label — the ranked
 * keys above get translated ones — but far better than printing the column name, and it means
 * a new column is legible the day it appears instead of after a deploy.
 */
export function humaniseKey(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Long free text gets its own full-width row; short values sit in the grid.
 *
 * A reason is the field an approver actually reads, and squeezing "We have a meeting with Mr
 * Sadanand to discuss the decor deck" into a third of a column is how it gets skipped.
 */
export function isWideField(key: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.length > 48 || /reason|note|purpose|handover|address|comment/.test(key);
}
