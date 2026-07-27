/**
 * self-edit.api.ts — the three writes behind employee self-service editing, and
 * the ONE read that tells the employee where their request actually is.
 *
 * THE MAKER-CHECKER PATH IS NOT NEW HERE. It is the path
 * `features/apply/api/apply-forms.api.ts::submitRegimeElection` already proved
 * against this database, re-used for `employees` columns:
 *
 *   1. INSERT `employee_change_requests` under `ecr__self_insert`
 *      (`employee_id = app.current_employee_id() AND requested_by =
 *      app.ctx_actor_id()`), backed by `GRANT SELECT, INSERT … TO authenticated`
 *      (migration 011 §4). `ecr_insert_guard` forces `status = 'pending'`, nulls
 *      every decision column, and raises 42501 for any `employees` column
 *      outside `public.employee_changeable_fields()` — so `status` is never sent
 *      and the field name is checked client-side only to save a round trip.
 *   2. `public.create_approval_request('PROFILE_CHANGE', …)`. Its
 *      `request_types.detail_table` IS `employee_change_requests`, and migration
 *      045 §3 seeds `AC-PROFILE` → one level, `hr_admin`, so a chain resolves
 *      and the function mints `request_number` instead of raising. The
 *      employee's stated reason travels in `p_summary.summary`, which is where
 *      the approver reads it — `employee_change_requests` has no reason column,
 *      and writing the employee's sentence into `decision_comment` would forge
 *      the approver's own words.
 *   3. Read `request_number` back, so the screen quotes a server-minted
 *      reference rather than inventing one.
 *
 * NO `X-REASON` HEADER ON STEP 1. `employee_change_requests` is not one of the
 * seventeen tables in `audit.reason_required_tables` (migration 006 §1), so
 * `insertOne` is the correct helper and `insertRow` would only add a header the
 * server ignores. The `employees` UPDATE in `updateSelfEditableField` is the
 * opposite case: `public.employees` IS reason-gated for UPDATE, so that one goes
 * through `updateRow`, which carries the reason and refuses a short one before
 * the request leaves the browser.
 *
 * WITHDRAWAL — CHECKED, NOT ASSUMED. `authenticated` holds SELECT and INSERT on
 * `employee_change_requests` and nothing else, so the request ROW can never be
 * edited or deleted from a browser; `history.api.ts` already records that as
 * `WITHDRAW_IS_SERVER_ONLY`. What CAN be withdrawn is the APPROVAL:
 * `act_on_approval(id, 'recall', comment)` is granted to `authenticated`
 * (migration 048 §5 allow-list), refuses anyone but the subject, and
 * `request_types.allows_withdrawal` is `true` for `PROFILE_CHANGE` (045 §2). It
 * sets `approval_requests.status = 'withdrawn'` — and NOT the detail row, which
 * `features/team`'s `decideApproval` documents as a general property of this
 * engine. That is exactly why `fetchMyFieldChangeApprovals` exists: after a
 * recall the change-request row still reads `pending`, so the APPROVAL row is
 * the employee-facing truth and the pending note must be driven by it.
 */
import { z } from "zod";
import {
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  eq,
  rpcOne,
  selectMany,
  selectOne,
  updateRow,
  MutationError,
} from "@/shared/api/query";
import { insertOne } from "@/shared/api/write";
import { t } from "@/shared/i18n/en";
/**
 * Cross-feature import, with precedent: `features/assets/api/my-assets.api.ts`
 * reaches into `features/admin/api/assets.api.ts` and
 * `apply-forms.api.ts` into `features/admin` for the same reason — an employee
 * and an approver must not read two different definitions of one request type.
 */
import { APPROVAL_REQUESTS_TABLE } from "@/features/apply/api/apply.api";
import { CREATE_APPROVAL_REQUEST_FN } from "@/features/apply/api/apply-requests.api";
import { approvalStatusSchema, CHANGE_REQUESTS_TABLE, type ApprovalStatus } from "./history.api";

/**
 * The base table, written to ONLY for the four self-granted columns. Every read
 * on this screen goes through `v_my_employee`; the base table appears here
 * because an UPDATE cannot target a view's grant.
 */
export const EMPLOYEES_TABLE = "employees";
/** `request_types.code` whose `detail_table` is `employee_change_requests`. */
export const REQUEST_CODE_PROFILE_CHANGE = "PROFILE_CHANGE";
export const ACT_ON_APPROVAL_FN = "act_on_approval";

// -----------------------------------------------------------------------------
// 1. Submit a field change request
// -----------------------------------------------------------------------------

const submittedRequestSchema = z.object({
  id: dbUuid,
  status: approvalStatusSchema,
  requested_at: dbTimestamp,
});

const requestRefSchema = z.object({ id: dbUuid, request_number: z.string() });

export interface FieldChangeRequestInput {
  readonly employeeId: string;
  /** `employee_change_requests.requested_by` references PROFILES, not employees. */
  readonly profileId: string;
  /** An `employees` column inside `public.employee_changeable_fields()`. */
  readonly fieldName: string;
  /** The human field name HR reads in the queue — never the column name. */
  readonly fieldLabel: string;
  /** jsonb scalar. `null` when the record holds nothing today. */
  readonly oldValue: string | boolean | null;
  /** jsonb scalar. NOT NULL on the table, so never null. */
  readonly newValue: string | boolean;
  /** Rendered old → new, for the approval title and summary. */
  readonly oldDisplay: string;
  readonly newDisplay: string;
  /** The employee's own sentence, ≥ MIN_REASON_LENGTH, read by the approver. */
  readonly reason: string;
}

export interface SubmittedFieldChange {
  readonly changeRequestId: string;
  readonly approvalRequestId: string;
  /** `approval_requests.request_number`, e.g. `PROFILE_CHANGE-000042`. */
  readonly requestNumber: string | null;
  readonly submittedAt: string;
}

export async function submitFieldChangeRequest(
  input: FieldChangeRequestInput,
  signal?: AbortSignal,
): Promise<SubmittedFieldChange> {
  // 1. The detail row. `status`, `decided_*` and `applied_*` are omitted because
  //    `ecr_insert_guard` overwrites them; sending them would be theatre.
  //    `entity_id` stays NULL: `apply_change_request` keys an `employees` change
  //    off `employee_id`, and only satellites use `entity_id`.
  const created = await insertOne(
    CHANGE_REQUESTS_TABLE,
    submittedRequestSchema,
    {
      employee_id: input.employeeId,
      requested_by: input.profileId,
      entity_table: "employees",
      field_name: input.fieldName,
      field_label: input.fieldLabel,
      old_value: input.oldValue,
      new_value: input.newValue,
    },
    { columns: "id, status, requested_at", ...(signal ? { signal } : {}) },
  );

  // 2. Into the workflow engine. No amount and no days: AC-PROFILE has NULL
  //    bands on both, and NULL selectors are what its chain predicate matches.
  const approvalRequestId = await rpcOne(
    CREATE_APPROVAL_REQUEST_FN,
    {
      p_request_type_code: REQUEST_CODE_PROFILE_CHANGE,
      p_subject_employee_id: input.employeeId,
      p_detail_id: created.id,
      p_title: t("me.edit.approval.title", {
        field: input.fieldLabel,
        from: input.oldDisplay,
        to: input.newDisplay,
      }),
      p_summary: {
        summary: input.reason,
        entity_table: "employees",
        field_name: input.fieldName,
        field_label: input.fieldLabel,
        from_value: input.oldDisplay,
        to_value: input.newDisplay,
      },
      p_amount: null,
      p_days: null,
      p_priority: "normal",
      p_on_behalf_of: null,
    },
    dbUuid,
    signal ? { signal } : {},
  );

  if (approvalRequestId === null) {
    // The field change IS recorded — HR can still see the pending row — so this
    // says what actually happened rather than claiming the whole thing failed.
    // A plain Error, not a MutationError: `MutationError.userMessage` renders the
    // catalogue sentence for its KIND and would drop this one, and there is no
    // kind that means "half of a two-step submission landed".
    throw new Error(t("me.edit.error.noApproval"));
  }

  const ref = await selectOne(APPROVAL_REQUESTS_TABLE, requestRefSchema, [eq("id", approvalRequestId)], {
    columns: "id, request_number",
    ...(signal ? { signal } : {}),
  });

  return {
    changeRequestId: created.id,
    approvalRequestId,
    requestNumber: ref?.request_number ?? null,
    submittedAt: created.requested_at,
  };
}

// -----------------------------------------------------------------------------
// 2. Withdraw the approval behind a field change request
// -----------------------------------------------------------------------------

const actOnApprovalResultSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  status: approvalStatusSchema,
});

export interface WithdrawFieldChangeInput {
  readonly approvalRequestId: string;
  /** Recorded on the `approval_actions` row as the recall comment. */
  readonly comment: string;
}

/**
 * Recall a still-open profile-change approval.
 *
 * `act_on_approval` refuses anyone but the subject employee (42501), refuses a
 * request type whose `allows_withdrawal` is false, and refuses a request that is
 * already decided — all three are the server's calls, not this function's. The
 * detail row is NOT touched by the engine, which is why the caller must re-read
 * the approvals after this and why the UI reads the approval status, not the
 * change-request status, when both exist.
 */
export async function withdrawFieldChangeApproval(
  input: WithdrawFieldChangeInput,
  signal?: AbortSignal,
): Promise<ApprovalStatus> {
  const row = await rpcOne(
    ACT_ON_APPROVAL_FN,
    {
      p_request_id: input.approvalRequestId,
      p_action: "recall",
      p_comment: input.comment,
      p_payload: {},
    },
    actOnApprovalResultSchema,
    signal ? { signal } : {},
  );
  if (row === null) {
    throw new MutationError(
      ACT_ON_APPROVAL_FN,
      "not_found",
      `${ACT_ON_APPROVAL_FN} returned no row, so the request was not taken back.`,
    );
  }
  return row.status;
}

// -----------------------------------------------------------------------------
// 3. Direct self-edit of the four granted columns
// -----------------------------------------------------------------------------

/**
 * The projection read back after a direct save. It may name ONLY columns inside
 * `GRANT SELECT (id, employee_code, display_name, about, photo_path,
 * cover_photo_path, food_preference)` — the base table carries no broader
 * column privilege for `authenticated`, so asking for one more would turn a
 * successful UPDATE into a 42501 on the RETURNING clause.
 */
const selfEditedSchema = z.object({
  id: dbUuid,
  about: z.string().nullable(),
  food_preference: z.string().nullable(),
});

export type SelfEdited = z.infer<typeof selfEditedSchema>;

export interface SelfEditInput {
  readonly employeeId: string;
  /** One of `about` / `food_preference` — the typed columns of the granted four. */
  readonly column: "about" | "food_preference";
  readonly value: string;
  /**
   * The audit sentence. `public.employees` is in `audit.reason_required_tables`
   * with `applies_to = 'update_delete'`, so an UPDATE without ≥10 characters is
   * refused with SQLSTATE 22023 by `audit.log_changes()`.
   */
  readonly reason: string;
}

export async function updateSelfEditableField(
  input: SelfEditInput,
  signal?: AbortSignal,
): Promise<SelfEdited> {
  return updateRow(
    EMPLOYEES_TABLE,
    [eq("id", input.employeeId)],
    { [input.column]: input.value },
    selfEditedSchema,
    {
      reason: input.reason,
      columns: "id, about, food_preference",
      ...(signal ? { signal } : {}),
    },
  );
}

// -----------------------------------------------------------------------------
// 4. Where each request actually is
// -----------------------------------------------------------------------------

/**
 * The approval rows behind this employee's profile-change requests.
 *
 * Readable under `ar__self_read` (`subject_employee_id =
 * app.current_employee_id()`). Filtered on `detail_table` so a leave or claim
 * approval never lands in a profile field's note, and keyed by `detail_id`,
 * which is the `employee_change_requests.id` the engine was pointed at.
 */
export const fieldChangeApprovalSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  detail_id: dbUuid,
  status: approvalStatusSchema,
  submitted_at: dbTimestamp,
  sla_due_at: dbTimestamp,
  decided_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
  cancelled_at: dbTimestampNullable,
  cancellation_reason: z.string().nullable(),
});

export type FieldChangeApproval = z.infer<typeof fieldChangeApprovalSchema>;

export async function fetchMyFieldChangeApprovals(
  employeeId: string,
  signal?: AbortSignal,
): Promise<FieldChangeApproval[]> {
  return selectMany(APPROVAL_REQUESTS_TABLE, fieldChangeApprovalSchema, {
    filters: [
      eq("subject_employee_id", employeeId),
      eq("detail_table", CHANGE_REQUESTS_TABLE),
    ],
    order: [{ column: "submitted_at", ascending: false }],
    columns:
      "id, request_number, detail_id, status, submitted_at, sla_due_at, " +
      "decided_at, decision_comment, cancelled_at, cancellation_reason",
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}
