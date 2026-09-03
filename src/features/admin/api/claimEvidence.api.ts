/**
 * claimEvidence.api.ts — the bill behind a reimbursement claim, and who has looked at it.
 *
 * ── WHY AN ADMIN COULD NOT SEE A SINGLE ATTACHMENT ───────────────────────────
 * Nothing was broken. Nothing was forbidden either — checked, rather than assumed:
 * `documents__admin__all` and the `documents__admin_all` storage policy both admit every
 * administrator to these rows and to the bucket, and `document-access` serves an unscanned
 * file deliberately. Impersonating each live admin under RLS returns all three claims, all
 * three lines and all three receipts.
 *
 * The receipt was simply never fetched. `/admin/payroll/reimbursements` reads
 * `reimbursement_claims` and nothing else, and the receipt does not live there — it lives on
 * `claim_lines.receipt_document_id`, one level down. So the register offered a Decide button
 * on money while showing no evidence at all, and there was no screen anywhere that could
 * show it. An approver was being asked to take somebody's word for a number.
 *
 * This module reads the level the page skipped:
 *
 *   claim_lines          the date, the expense head, the description, from → to, the
 *                        distance, the amount, the tax and the GST number
 *   documents            the receipt itself, embedded on the line's own FK
 *   document_access_log  every mint, view and download of that receipt, with actor and IP
 *   approval_actions     who decided, at which level, with what comment, from where
 *
 * ── TWO READS, NOT A POSTGREST EMBED ────────────────────────────────────────
 * The obvious shape is one request with the receipt embedded on the line's own foreign key.
 * It is not used, for a reason that is about verification rather than taste: this project's
 * service key has been rotated and interactive sign-in is unavailable here, so an embed
 * written with an FK-constraint hint could NOT be executed against the live API before
 * shipping — and a select string PostgREST rejects fails at runtime, on this screen, on a
 * deployed site, with an empty panel and no type error to catch it.
 *
 * So the receipt is fetched by id list instead. `selectMany` + `inList` is the form used
 * everywhere else in this codebase and is proven by every other register. Two round trips for
 * three claims is not a cost worth one unverifiable query.
 *
 * It also states the RLS case more honestly: a line can hold a `receipt_document_id` whose
 * `documents` row does not come back, and a missing key in the map says exactly that, where an
 * embed would return the same `null` it returns for "no receipt attached".
 *
 * ── NO PERMISSION LOGIC HERE, AND NEVER ANY ─────────────────────────────────
 * Every read below runs under the caller's own token, so the RLS policies decide what comes
 * back. Opening a file goes through `document-access` (see `docs/api/documentAccess.api.ts`),
 * which logs the access BEFORE the URL exists. A second copy of that reasoning in TypeScript
 * is how the two drift apart.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumericNullable,
  dbTimestamp,
  dbUuid,
  dbUuidNullable,
  inList,
  selectMany,
} from "@/shared/api/query";

export const CLAIM_LINES_TABLE = "claim_lines";
export const DOCUMENTS_TABLE = "documents";
export const DOCUMENT_ACCESS_LOG_TABLE = "document_access_log";
export const APPROVAL_ACTIONS_TABLE = "approval_actions";

/**
 * A generous cap. Three claims exist today and each carries one line; a travel claim with
 * thirty legs is the shape this has to survive without a second round trip.
 */
export const EVIDENCE_ROW_CAP = 1000;

/**
 * How many ids may go into one `in.(…)` filter.
 *
 * ── WHY THIS EXISTS, AND WHY IT WOULD NEVER HAVE SHOWN UP IN TESTING ────────
 * The register caps at `REGISTER_ROW_CAP` = 500 claims, and a filter carrying 500 UUIDs is
 * roughly 18.5 kB of comma-separated text. PostgREST takes its filters in the QUERY STRING,
 * so that becomes a ~19 kB request line — comfortably past the ~8 kB a proxy typically allows.
 * The request does not come back slow; it comes back refused.
 *
 * This venue has three claims, so the unchunked version works perfectly today and breaks in
 * the first month that fills a register. 100 ids is ~3.7 kB with the column list, which stays
 * inside the limit with room to spare.
 */
const ID_CHUNK = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// -----------------------------------------------------------------------------
// 1. The receipt, as metadata
// -----------------------------------------------------------------------------

/**
 * `documents`, for one receipt.
 *
 * `virus_scan_status` is carried because this deployment runs no scanner: every receipt sits
 * at 'pending' and `document-access` serves it on purpose, so the screen has to be able to
 * say "not scanned" rather than imply a clean bill of health nobody issued.
 *
 * `checksum_sha256` is what makes the attachment evidence rather than a picture. It is
 * computed in the browser before the upload and stored with the row, so an auditor can prove
 * the bytes served are the bytes filed.
 */
export const claimReceiptSchema = z.object({
  id: dbUuid,
  title: z.string().nullable(),
  file_name: z.string().nullable(),
  mime_type: z.string().nullable(),
  file_size_bytes: dbIntNullable,
  checksum_sha256: z.string().nullable(),
  status: z.string(),
  virus_scan_status: z.string(),
  /** The bill's OWN date, as typed or as read off the receipt — not the upload date. */
  issue_date: dbDateNullable,
  uploaded_by: dbUuidNullable,
  created_at: dbTimestamp,
});
export type ClaimReceipt = z.infer<typeof claimReceiptSchema>;

const RECEIPT_COLUMNS =
  "id, title, file_name, mime_type, file_size_bytes, checksum_sha256, status, " +
  "virus_scan_status, issue_date, uploaded_by, created_at";

// -----------------------------------------------------------------------------
// 2. The claim line
// -----------------------------------------------------------------------------

/**
 * One expense line. THE DATE AND THE PLACE LIVE HERE, nowhere else.
 *
 * `line_date` is the day the expense was incurred, which is not the day the claim was filed
 * and not the day it was approved — a claim filed on the 2nd can carry a line dated the 24th
 * of the month before. An approver checking a bill against a calendar needs the line's date.
 *
 * `from_location`/`to_location` are free text the employee typed; there are no coordinates on
 * a claim line and this module does not invent any. `distance_km` × `rate_per_km_paise` is how
 * a conveyance claim is computed, and both are shown so the arithmetic is checkable rather
 * than asserted.
 */
export const claimLineSchema = z.object({
  id: dbUuid,
  claim_id: dbUuid,
  line_date: dbDateNullable,
  expense_head: z.string().nullable(),
  description: z.string().nullable(),
  from_location: z.string().nullable(),
  to_location: z.string().nullable(),
  distance_km: dbNumericNullable,
  rate_per_km_paise: dbIntNullable,
  amount_claimed_paise: dbInt,
  amount_approved_paise: dbIntNullable,
  tax_amount_paise: dbIntNullable,
  gst_number: z.string().nullable(),
  travel_mode: z.string().nullable(),
  travel_purpose: z.string().nullable(),
  is_receipt_required: z.boolean(),
  receipt_document_id: dbUuidNullable,
  rejection_reason: z.string().nullable(),
  created_at: dbTimestamp,
});
export type ClaimLine = z.infer<typeof claimLineSchema>;

/**
 * A line paired with whatever its receipt id resolved to.
 *
 * `receipt === null` while `receipt_document_id !== null` is a REAL and distinct state: a bill
 * is attached and this reader may not see its row. The screen must not render that as "no
 * attachment" — that would tell an approver the employee filed nothing.
 */
export interface ClaimLineWithReceipt {
  readonly line: ClaimLine;
  readonly receipt: ClaimReceipt | null;
}

export function attachReceipts(
  lines: readonly ClaimLine[],
  receipts: ReadonlyMap<string, ClaimReceipt>,
): ClaimLineWithReceipt[] {
  return lines.map((line) => ({
    line,
    receipt: line.receipt_document_id === null ? null : receipts.get(line.receipt_document_id) ?? null,
  }));
}

const CLAIM_LINE_COLUMNS =
  "id, claim_id, line_date, expense_head, description, from_location, to_location, " +
  "distance_km, rate_per_km_paise, amount_claimed_paise, amount_approved_paise, " +
  "tax_amount_paise, gst_number, travel_mode, travel_purpose, is_receipt_required, " +
  "receipt_document_id, rejection_reason, created_at";

/**
 * Every line of every claim named, with its receipt.
 *
 * ONE REQUEST FOR THE WHOLE PAGE, not one per row. The register shows up to 500 claims and a
 * per-row fetch would be 500 round trips and 500 spinners; the attachment COUNT has to be on
 * screen before anybody clicks anything, so the lines are needed up front regardless.
 */
export async function fetchClaimLines(
  claimIds: readonly string[],
  signal?: AbortSignal,
): Promise<ClaimLine[]> {
  if (claimIds.length === 0) return [];
  const batches = await Promise.all(
    chunk(claimIds, ID_CHUNK).map((ids) =>
      selectMany(CLAIM_LINES_TABLE, claimLineSchema, {
        columns: CLAIM_LINE_COLUMNS,
        filters: [inList("claim_id", ids)],
        order: [{ column: "line_date", ascending: true }],
        limit: EVIDENCE_ROW_CAP,
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  return batches.flat();
}

/**
 * The receipt rows for a set of lines, keyed by document id.
 *
 * Ids are DEDUPLICATED before the request: nothing stops two lines of one claim citing the
 * same bill, and asking for it twice would be a wasted round trip and a duplicated row.
 *
 * A document id that comes back with no row is NOT an error here. It means RLS did not admit
 * this reader to it, and the caller distinguishes that from "no receipt" through
 * `attachReceipts`.
 */
export async function fetchClaimReceipts(
  lines: readonly ClaimLine[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, ClaimReceipt>> {
  const ids = [...new Set(lines.flatMap((l) => (l.receipt_document_id === null ? [] : [l.receipt_document_id])))];
  if (ids.length === 0) return new Map();
  const batches = await Promise.all(
    chunk(ids, ID_CHUNK).map((batch) =>
      selectMany(DOCUMENTS_TABLE, claimReceiptSchema, {
        columns: RECEIPT_COLUMNS,
        filters: [inList("id", batch)],
        limit: batch.length,
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  return new Map(batches.flat().map((r) => [r.id, r]));
}

/** Lines grouped by their claim, so a row can read its own without scanning the list. */
export function groupLinesByClaim(lines: readonly ClaimLine[]): ReadonlyMap<string, ClaimLine[]> {
  const map = new Map<string, ClaimLine[]>();
  for (const line of lines) {
    const existing = map.get(line.claim_id);
    if (existing === undefined) map.set(line.claim_id, [line]);
    else existing.push(line);
  }
  return map;
}

/**
 * How many attachments a claim carries, and how many of its lines still owe one.
 *
 * `missing` counts lines that say a receipt is REQUIRED and carry none.
 * `ck_claim_lines__receipt_present` is `NOT VALID`, so rows filed before that constraint can
 * be in exactly this state — and an approver ought to see it on the row rather than discover
 * it after approving.
 *
 * `unreadable` counts lines that hold a document id whose row did not come back. That is an
 * RLS outcome, not an empty attachment, and saying "none attached" for it would be a lie.
 */
export interface ClaimAttachmentTally {
  readonly attachments: number;
  readonly lines: number;
  readonly missing: number;
  readonly unreadable: number;
}

export function tallyAttachments(
  rows: readonly ClaimLineWithReceipt[],
): ClaimAttachmentTally {
  let attachments = 0;
  let missing = 0;
  let unreadable = 0;
  for (const { line, receipt } of rows) {
    if (receipt !== null) attachments += 1;
    else if (line.receipt_document_id !== null) unreadable += 1;
    else if (line.is_receipt_required) missing += 1;
  }
  return { attachments, lines: rows.length, missing, unreadable };
}

// -----------------------------------------------------------------------------
// 3. Who opened the receipt
// -----------------------------------------------------------------------------

/**
 * `document_access_log`, the read trail. `document_access_log__admin__select` admits any
 * admin; an employee sees only their own reads.
 *
 * TWO ROWS PER CLICK, BY DESIGN: `document-access` writes `signed_url_minted` and then the
 * `view`/`download` it was minted for, both before the URL exists. A URL therefore cannot
 * exist without a record of who asked for it, which is the property that makes this a trail
 * rather than a log. The screen shows the access kinds and lets the mint rows be the
 * corroboration.
 *
 * The table carries NO foreign keys, so `accessed_by` cannot be embedded — it is resolved
 * through `fetchActorNames` like every other actor id in the audit registers.
 */
export const receiptAccessSchema = z.object({
  id: dbUuid,
  document_id: dbUuid,
  access_kind: z.string(),
  accessed_by: dbUuidNullable,
  accessed_by_role: z.string().nullable(),
  on_behalf_of: dbUuidNullable,
  purpose: z.string().nullable(),
  /** `inet`, which PostgREST renders as a string with its mask (`10.0.0.1/32`). */
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  signed_url_expires_at: z.string().nullable(),
  bytes_served: dbIntNullable,
  recorded_at: dbTimestamp,
});
export type ReceiptAccess = z.infer<typeof receiptAccessSchema>;

const ACCESS_COLUMNS =
  "id, document_id, access_kind, accessed_by, accessed_by_role, on_behalf_of, purpose, " +
  "ip, user_agent, signed_url_expires_at, bytes_served, recorded_at";

export async function fetchReceiptAccessLog(
  documentIds: readonly string[],
  signal?: AbortSignal,
): Promise<ReceiptAccess[]> {
  if (documentIds.length === 0) return [];
  const batches = await Promise.all(
    chunk(documentIds, ID_CHUNK).map((ids) =>
      selectMany(DOCUMENT_ACCESS_LOG_TABLE, receiptAccessSchema, {
        columns: ACCESS_COLUMNS,
        filters: [inList("document_id", ids)],
        order: [{ column: "recorded_at", ascending: false }],
        limit: EVIDENCE_ROW_CAP,
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  /* Re-sorted across batches: each request is ordered, the concatenation is not. */
  return batches.flat().sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
}

// -----------------------------------------------------------------------------
// 4. Who decided the claim
// -----------------------------------------------------------------------------

/**
 * `approval_actions` — immutable, one row per act.
 *
 * This is the half of the trail the register already half-told: the page's own header notes
 * that a settled approval is not applied back onto `reimbursement_claims`, so a decided claim
 * can still read `pending`. The decision is nonetheless recorded here, with the actor, the
 * level, the comment and the IP, and showing it is how an approver learns that the status
 * column is behind rather than that nothing happened.
 */
export const claimApprovalActionSchema = z.object({
  id: dbUuid,
  approval_request_id: dbUuid,
  level: dbInt,
  actor_id: dbUuidNullable,
  actor_role: z.string().nullable(),
  acted_as: z.string().nullable(),
  delegated_from: dbUuidNullable,
  action: z.string(),
  comment: z.string().nullable(),
  ip: z.string().nullable(),
  acted_at: dbTimestamp,
  time_to_action_seconds: dbIntNullable,
});
export type ClaimApprovalAction = z.infer<typeof claimApprovalActionSchema>;

const ACTION_COLUMNS =
  "id, approval_request_id, level, actor_id, actor_role, acted_as, delegated_from, " +
  "action, comment, ip, acted_at, time_to_action_seconds";

export async function fetchClaimApprovalActions(
  approvalRequestIds: readonly string[],
  signal?: AbortSignal,
): Promise<ClaimApprovalAction[]> {
  if (approvalRequestIds.length === 0) return [];
  return selectMany(APPROVAL_ACTIONS_TABLE, claimApprovalActionSchema, {
    columns: ACTION_COLUMNS,
    filters: [inList("approval_request_id", approvalRequestIds)],
    order: [{ column: "acted_at", ascending: true }],
    limit: EVIDENCE_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. The actor ids one sheet needs resolving
// -----------------------------------------------------------------------------

/**
 * Every `profiles.id` mentioned by one claim's evidence, deduplicated.
 *
 * Collected in one place because `fetchActorNames` takes a batch and three separate callers
 * would issue three requests for overlapping sets — the uploader is very often the same
 * person as the first approver.
 */
export function evidenceActorIds(
  lines: readonly ClaimLineWithReceipt[],
  access: readonly ReceiptAccess[],
  actions: readonly ClaimApprovalAction[],
): string[] {
  const ids = new Set<string>();
  for (const { receipt } of lines) {
    if (receipt?.uploaded_by != null) ids.add(receipt.uploaded_by);
  }
  for (const row of access) {
    if (row.accessed_by !== null) ids.add(row.accessed_by);
    if (row.on_behalf_of !== null) ids.add(row.on_behalf_of);
  }
  for (const row of actions) {
    if (row.actor_id !== null) ids.add(row.actor_id);
    if (row.delegated_from !== null) ids.add(row.delegated_from);
  }
  return [...ids];
}
