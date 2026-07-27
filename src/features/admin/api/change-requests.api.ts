/**
 * change-requests.api.ts — the HR/admin side of the employee change-request
 * (maker-checker) queue behind /admin/people/changes.
 *
 * The EMPLOYEE side (the row shape, the status vocabulary, the self-insert path)
 * lives in `features/profile/api/history.api.ts` and its status enum is imported
 * rather than re-declared — one vocabulary, or the two surfaces drift about what
 * `applied` means.
 *
 * What is admin-specific here:
 *
 *  * THE ORG-WIDE READ. `ecr__admin_all` is `app.is_admin() AND
 *    app.admin_scope_covers(employee_id)` (011 §2), so the same query an employee
 *    runs against their own row returns the whole queue for an admin — RLS
 *    decides the rows, not a flag in this file.
 *  * THE DECISION, `public.decide_change_request` (migration 062). It exists
 *    because `authenticated` holds SELECT + INSERT on
 *    `employee_change_requests` and NO UPDATE (011 §4, re-asserted by 048), so a
 *    PATCH of `status` from a console is `42501` — and `apply_change_request`
 *    refuses anything not already `approved`. The definer stamps the decision and
 *    calls the applier in ONE transaction, so `applied` and the new field value
 *    are a single fact. It demands the `X-Reason` header (>= 10 chars) and, on
 *    rejection, a `decision_comment` of >= 10 characters — the employee reads
 *    that one on their own record history.
 *  * THE GOVERNING WORKFLOW ROW. `employee_change_requests` carries NO
 *    employee-supplied reason column; the sentence the employee typed travels in
 *    `approval_requests.summary->>'summary'` of the request whose
 *    `detail_table = 'employee_change_requests'` and `detail_id` is the change
 *    request (029 §4, and `submitRegimeElection` writes exactly that). The queue
 *    therefore reads those rows alongside — for the reason, for the request
 *    number, and because a chain still open means the decision belongs in the
 *    approval inbox, which is what 062 enforces.
 *
 * Nothing is derived here. Old and new values arrive as `jsonb` and are rendered
 * as they are; no arithmetic, no coercion, no "helpful" reformatting of a value
 * the employee typed.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbInt,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  isNotNull,
  isNull,
  isTrue,
  rpcAudited,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import {
  CHANGE_REQUESTS_TABLE,
  approvalStatusSchema,
  type ApprovalStatus,
} from "@/features/profile/api/history.api";

export { CHANGE_REQUESTS_TABLE, approvalStatusSchema };
export type { ApprovalStatus };

/** Migration 062. Approve (stamp + apply, one transaction) or reject. */
export const DECIDE_CHANGE_FN = "decide_change_request";
export const APPROVAL_REQUESTS_TABLE = "approval_requests";

/**
 * `ck_ecr__entity_table` (011 §2) — the nine tables a change request may target,
 * exactly as the CHECK constraint lists them. A tenth value cannot exist.
 */
export const entityTableSchema = z.enum([
  "employees",
  "employee_addresses",
  "employee_contacts",
  "employee_dependents",
  "employee_qualifications",
  "employee_identity_documents",
  "employee_statutory",
  "employee_bank_accounts",
  "employee_custom_field_values",
]);
export type ChangeEntityTable = z.infer<typeof entityTableSchema>;

// -----------------------------------------------------------------------------
// 1. The queue row
// -----------------------------------------------------------------------------

export const changeRequestRowSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  /** A `profiles.id` — the employee themselves, or HR acting for them. */
  requested_by: dbUuid,
  /** Requests submitted together share this, so a form is decided as a form. */
  request_group_id: dbUuid,
  entity_table: z.string(),
  /** NULL for `employees`, for a custom field, and for satellites keyed on employee_id. */
  entity_id: dbUuidNullable,
  field_name: z.string(),
  /** Human in the database (NOT NULL) — a column name never reaches the screen. */
  field_label: z.string(),
  old_value: z.unknown().nullable(),
  new_value: z.unknown(),
  is_sensitive: z.boolean(),
  status: approvalStatusSchema,
  approval_request_id: dbUuidNullable,
  decided_by: dbUuidNullable,
  decided_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
  applied_at: dbTimestampNullable,
  apply_error: z.string().nullable(),
  requested_at: dbTimestamp,
  effective_from: dbDateNullable,
});
export type ChangeRequestRow = z.infer<typeof changeRequestRowSchema>;

const QUEUE_COLUMNS =
  "id, employee_id, requested_by, request_group_id, entity_table, entity_id, " +
  "field_name, field_label, old_value, new_value, is_sensitive, status, " +
  "approval_request_id, decided_by, decided_at, decision_comment, applied_at, " +
  "apply_error, requested_at, effective_from";

/** One screenful of debt. Beyond this the filters are the answer, not a longer list. */
export const QUEUE_ROW_CAP = 300;

export interface ChangeQueueFilters {
  /** Omit for every state; the default slice passes `['pending']`. */
  readonly statuses?: readonly ApprovalStatus[];
  readonly entityTables?: readonly string[];
  readonly sensitiveOnly?: boolean;
  /** `applied_at IS NULL` — approved but not written (the satellite limit). */
  readonly notApplied?: boolean;
  /** `applied_at IS NOT NULL` — the ones that landed. */
  readonly appliedOnly?: boolean;
  readonly failedOnly?: boolean;
  readonly since?: string;
}

/** ONE predicate builder feeds both the rows and every count (DR-29). */
function queueFilters(f: ChangeQueueFilters): readonly Filter[] {
  const filters: Filter[] = [];
  if (f.statuses !== undefined && f.statuses.length > 0) {
    filters.push(inList("status", f.statuses));
  }
  if (f.entityTables !== undefined && f.entityTables.length > 0) {
    filters.push(inList("entity_table", f.entityTables));
  }
  if (f.sensitiveOnly === true) filters.push(isTrue("is_sensitive"));
  if (f.notApplied === true) filters.push(isNull("applied_at"));
  if (f.appliedOnly === true) filters.push(isNotNull("applied_at"));
  if (f.failedOnly === true) filters.push(eq("status", "failed"));
  if (f.since !== undefined) filters.push(gte("requested_at", f.since));
  return filters;
}

export function fetchChangeQueue(
  f: ChangeQueueFilters,
  signal?: AbortSignal,
): Promise<ChangeRequestRow[]> {
  return selectMany(CHANGE_REQUESTS_TABLE, changeRequestRowSchema, {
    columns: QUEUE_COLUMNS,
    filters: queueFilters(f),
    // Oldest first: the queue is a debt, and the debt ages.
    order: [{ column: "requested_at", ascending: true }],
    limit: QUEUE_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countChangeQueue(
  f: ChangeQueueFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(CHANGE_REQUESTS_TABLE, queueFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. The governing workflow request — the reason, and the right to decide here
// -----------------------------------------------------------------------------

/**
 * The `approval_requests` row that governs a change request, read through
 * `ar__admin_read`. Two facts the change request itself cannot carry:
 *
 *   * `summary->>'summary'` — the sentence the employee typed. There is no
 *     reason column on `employee_change_requests`;
 *   * `status` + `current_level` — whether the chain is still open. Migration
 *     062 REFUSES a decision here while it is, because AC-BANK-CHANGE has two
 *     levels (hr_admin then finance, 045 §3) and applying the field at level 1
 *     would forge an approval finance never gave.
 */
export const governingRequestSchema = z.object({
  id: dbUuid,
  detail_id: dbUuid,
  request_number: z.string(),
  title: z.string(),
  summary: z.record(z.unknown()).nullable(),
  status: approvalStatusSchema,
  current_level: dbInt,
  total_levels: dbInt,
  submitted_at: dbTimestamp,
  decided_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
});
export type GoverningRequest = z.infer<typeof governingRequestSchema>;

/** How many detail ids may ride in one `IN (…)` — the queue cap is the bound. */
const GOVERNING_ID_CAP = QUEUE_ROW_CAP;

export function fetchGoverningRequests(
  changeRequestIds: readonly string[],
  signal?: AbortSignal,
): Promise<GoverningRequest[]> {
  if (changeRequestIds.length === 0) return Promise.resolve([]);
  return selectMany(APPROVAL_REQUESTS_TABLE, governingRequestSchema, {
    columns:
      "id, detail_id, request_number, title, summary, status, current_level, " +
      "total_levels, submitted_at, decided_at, decision_comment",
    filters: [
      eq("detail_table", CHANGE_REQUESTS_TABLE),
      inList("detail_id", changeRequestIds.slice(0, GOVERNING_ID_CAP)),
    ],
    order: [{ column: "submitted_at", ascending: false }],
    limit: GOVERNING_ID_CAP,
    ...(signal ? { signal } : {}),
  });
}

/** The chain statuses that still hold the request — 062 refuses a decision then. */
export const OPEN_CHAIN_STATUSES: readonly ApprovalStatus[] = [
  "draft",
  "pending",
  "in_progress",
  "escalated",
];

export function isChainOpen(row: GoverningRequest | undefined): boolean {
  return row !== undefined && OPEN_CHAIN_STATUSES.includes(row.status);
}

/** A governing chain that ended in anything else can never be applied (062). */
export function isChainApproved(row: GoverningRequest | undefined): boolean {
  return (
    row !== undefined &&
    (row.status === "approved" || row.status === "auto_approved" || row.status === "applied")
  );
}

const summaryNoteSchema = z.object({ summary: z.string().min(1) });

/** The employee's own sentence, when the workflow row carries one. */
export function readRequesterNote(row: GoverningRequest | undefined): string | null {
  if (row === undefined || row.summary === null) return null;
  const parsed = summaryNoteSchema.safeParse(row.summary);
  return parsed.success ? parsed.data.summary : null;
}

// -----------------------------------------------------------------------------
// 3. The decision
// -----------------------------------------------------------------------------

/** What migration 062 hands back — the row's real post-decision state. */
export const changeDecisionResultSchema = z.object({
  change_request_id: dbUuid,
  decision: z.enum(["approved", "rejected"]),
  status: approvalStatusSchema,
  field_label: z.string(),
  entity_table: z.string(),
  /** False when `apply_change_request` structurally cannot write this row. */
  appliable: z.boolean(),
  applied: z.boolean(),
  apply_error: z.string().nullable(),
});
export type ChangeDecisionResult = z.infer<typeof changeDecisionResultSchema>;

export interface DecideChangeInput {
  readonly changeRequestId: string;
  readonly decision: "approve" | "reject";
  /** Mandatory on reject (>= 10 chars, server-enforced); context on approve. */
  readonly comment?: string;
}

export async function decideChangeRequest(
  input: DecideChangeInput,
  reason: string,
  signal?: AbortSignal,
): Promise<ChangeDecisionResult> {
  const rows = await rpcAudited(
    DECIDE_CHANGE_FN,
    {
      p_change_request_id: input.changeRequestId,
      p_decision: input.decision,
      ...(input.comment !== undefined && input.comment.trim() !== ""
        ? { p_comment: input.comment.trim() }
        : {}),
    },
    changeDecisionResultSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
  const first = rows[0];
  if (first === undefined) {
    throw new Error("decide_change_request returned no result row");
  }
  return first;
}

// -----------------------------------------------------------------------------
// 4. What the applier can and cannot write — stated once, from the migration
// -----------------------------------------------------------------------------

/**
 * `apply_change_request` (011 §3) writes three shapes: an `employees` whitelist
 * column, an `employee_custom_field_values` row (typed column chosen from the
 * def's `field_type`), or a satellite row named by `entity_id` with
 * `WHERE id = $2 AND employee_id = $3`. A satellite request with no `entity_id`
 * — every `employee_statutory` row, because that table is keyed on employee_id
 * and has no `id` column at all — has nothing to update.
 *
 * The console shows this BEFORE the decision, so an approval that will need a
 * manual entry is not a surprise afterwards.
 */
export function isAppliableByServer(row: ChangeRequestRow): boolean {
  return (
    row.entity_table === "employees" ||
    row.entity_table === "employee_custom_field_values" ||
    row.entity_id !== null
  );
}
