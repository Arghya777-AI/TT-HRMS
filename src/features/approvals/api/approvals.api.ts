/**
 * approvals.api.ts — the E-12 reads.
 *
 * spec-employee §5 E-12 names `rpc_my_pending_actions()`. It is NOT deployed, so
 * "Awaiting your action" is assembled from the FOUR deployed sources that each
 * own one kind of outstanding action, and every row keeps the server's own
 * status and due date:
 *
 *   1. `v_approval_inbox`            — decisions routed to me (managers, and any
 *                                      employee named as an approver).
 *   2. `document_acknowledgements`   — policies assigned to me, not yet agreed.
 *   3. `v_document_compliance`       — required documents missing/expired/expiring.
 *   4. `v_asset_custody`             — handovers I have not confirmed.
 *
 * Nothing here decides severity or invents a deadline: `sla_due_at`, `due_on`,
 * `expiry_date`, `is_overdue` and `is_return_overdue` are all server columns. The
 * client only ORDERS the union, which is why an item cannot appear with a
 * different urgency here than on the screen that owns it.
 *
 * Tracking (things I sent to others) is NOT re-implemented: it calls E-10's
 * `fetchMyOpenRequests`, so the two screens are the same list.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  inList,
  isNull,
  selectMany,
} from "@/shared/api/query";
import { DOCUMENT_ACKS_TABLE, documentAckSchema, type DocumentAck } from "@/features/docs/api/docs.api";

export const APPROVAL_INBOX_VIEW = "v_approval_inbox";
export const DOCUMENT_COMPLIANCE_VIEW = "v_document_compliance";
export const ASSET_CUSTODY_VIEW = "v_asset_custody";

// -----------------------------------------------------------------------------
// 1. Decisions routed to me — v_approval_inbox
// -----------------------------------------------------------------------------

/**
 * The view already filters to `app.current_employee_id() = ANY
 * (current_approver_ids)`, so this read carries no scope filter of its own. For
 * an employee with no reportees it legitimately returns zero rows.
 */
export const approvalInboxSchema = z.object({
  approval_request_id: dbUuid,
  request_number: z.string(),
  request_type_code: z.string(),
  request_type_name: z.string(),
  title: z.string(),
  amount: dbNumericNullable,
  days: dbNumericNullable,
  priority: z.string(),
  status: z.string(),
  current_level: z.number().int(),
  total_levels: z.number().int(),
  subject_employee_id: dbUuidNullable,
  subject_employee_code: z.string().nullable(),
  subject_display_name: z.string().nullable(),
  subject_department_name: z.string().nullable(),
  submitted_at: dbTimestamp,
  sla_due_at: dbTimestamp,
  /** Server-computed countdown; we never recompute it. */
  sla_remaining_hours: dbNumericNullable,
  is_overdue: z.boolean().nullable(),
  age_hours: dbNumericNullable,
  escalated_at: dbTimestampNullable,
});

export type ApprovalInboxRow = z.infer<typeof approvalInboxSchema>;

const APPROVAL_INBOX_COLUMNS =
  "approval_request_id, request_number, request_type_code, request_type_name, title, amount, " +
  "days, priority, status, current_level, total_levels, subject_employee_id, " +
  "subject_employee_code, subject_display_name, subject_department_name, submitted_at, " +
  "sla_due_at, sla_remaining_hours, is_overdue, age_hours, escalated_at";

export async function fetchApprovalInbox(signal?: AbortSignal): Promise<ApprovalInboxRow[]> {
  return selectMany(APPROVAL_INBOX_VIEW, approvalInboxSchema, {
    columns: APPROVAL_INBOX_COLUMNS,
    order: [{ column: "sla_due_at", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Policies assigned to me and not yet acknowledged
// -----------------------------------------------------------------------------

/** Statuses that still owe an acknowledgement. `waived` does not. */
export const OPEN_ACK_STATUSES = ["assigned", "opened", "overdue"] as const;

export async function fetchOpenAcknowledgements(
  employeeId: string,
  signal?: AbortSignal,
): Promise<DocumentAck[]> {
  return selectMany(DOCUMENT_ACKS_TABLE, documentAckSchema, {
    columns:
      "id, document_id, employee_id, assigned_at, due_on, first_opened_at, open_count, " +
      "total_read_seconds, scroll_completion_pct, acknowledged_at, acknowledgement_text, status, " +
      "documents(id, title, current_version, page_count, issue_date, " +
      "document_types(code, name, category, requires_expiry))",
    filters: [eq("employee_id", employeeId), inList("status", OPEN_ACK_STATUSES)],
    order: [{ column: "due_on", ascending: true, nullsFirst: false }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Required documents that are missing, expired or expiring
// -----------------------------------------------------------------------------

export const complianceStatusSchema = z.enum([
  "missing",
  "expired",
  "expiring_soon",
  "valid",
]);
export type ComplianceStatus = z.infer<typeof complianceStatusSchema>;

export const documentGapSchema = z.object({
  employee_id: dbUuid,
  document_type_id: dbUuid,
  document_type_code: z.string(),
  document_type_name: z.string(),
  requires_expiry: z.boolean(),
  document_id: dbUuidNullable,
  expiry_date: dbDateNullable,
  compliance_status: complianceStatusSchema,
});

export type DocumentGap = z.infer<typeof documentGapSchema>;

/** The view's own predicate is `app.can_see_employee`; this narrows it to me. */
export async function fetchMyDocumentGaps(
  employeeId: string,
  signal?: AbortSignal,
): Promise<DocumentGap[]> {
  return selectMany(DOCUMENT_COMPLIANCE_VIEW, documentGapSchema, {
    columns:
      "employee_id, document_type_id, document_type_code, document_type_name, requires_expiry, " +
      "document_id, expiry_date, compliance_status",
    filters: [
      eq("employee_id", employeeId),
      inList("compliance_status", ["missing", "expired", "expiring_soon"]),
    ],
    order: [{ column: "expiry_date", ascending: true, nullsFirst: true }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Asset handovers I have not confirmed
// -----------------------------------------------------------------------------

export const assetCustodySchema = z.object({
  allocation_id: dbUuid,
  allocation_number: z.string().nullable(),
  asset_tag: z.string().nullable(),
  asset_name: z.string().nullable(),
  asset_category_name: z.string().nullable(),
  serial_number: z.string().nullable(),
  employee_id: dbUuidNullable,
  status: z.string(),
  allocated_at: dbTimestamp,
  acknowledged_at: dbTimestampNullable,
  expected_return_date: dbDateNullable,
  is_return_overdue: z.boolean().nullable(),
});

export type AssetCustody = z.infer<typeof assetCustodySchema>;

/**
 * Allocations handed to me that I have not acknowledged. The confirm action
 * itself belongs to E-11 (`/me/assets`) — this screen links there rather than
 * writing `asset_allocations`, which has no self-UPDATE policy anyway.
 */
export async function fetchMyUnacknowledgedAssets(
  employeeId: string,
  signal?: AbortSignal,
): Promise<AssetCustody[]> {
  return selectMany(ASSET_CUSTODY_VIEW, assetCustodySchema, {
    columns:
      "allocation_id, allocation_number, asset_tag, asset_name, asset_category_name, " +
      "serial_number, employee_id, status, allocated_at, acknowledged_at, expected_return_date, " +
      "is_return_overdue",
    filters: [eq("employee_id", employeeId), isNull("acknowledged_at")],
    order: [{ column: "allocated_at", ascending: true }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. The union — one honest list
// -----------------------------------------------------------------------------

export type ActionKind = "decision" | "policy" | "document" | "asset";

export interface PendingAction {
  readonly id: string;
  readonly kind: ActionKind;
  /** What the employee must do, already in words. */
  readonly what: string;
  readonly detail: string;
  /** Server-owned deadline, or null when the source has none. */
  readonly dueOn: string | null;
  readonly dueIsTimestamp: boolean;
  /** Straight from the server (`is_overdue`, `due_on < ist_today()`). */
  readonly overdue: boolean;
  /** Where the employee goes to do it. */
  readonly to: string;
  /**
   * WHEN THIS ARRIVED — the server's own timestamp for each source:
   * `submitted_at` for a decision, `assigned_at` for a policy, `allocated_at`
   * for an asset. Null where the source has no such column (a missing document
   * is a standing gap, not an event).
   *
   * Added because the list was ordered by DEADLINE only, so something raised a
   * minute ago sat at the bottom under items due weeks earlier, and the person
   * who had just submitted it could not find it. Reported as: "show action which
   * is latest not just random".
   */
  readonly raisedAt: string | null;
}

export interface PendingActionsPayload {
  readonly decisions: ApprovalInboxRow[];
  readonly acknowledgements: DocumentAck[];
  readonly documentGaps: DocumentGap[];
  readonly assets: AssetCustody[];
}

/**
 * Read all four sources in parallel.
 *
 * A failure in ONE source must not blank the screen, so each read is settled
 * independently and its rejection is returned for the caller to surface as the
 * partial state. Silently swallowing it would show "You're all caught up" to
 * someone who is not.
 */
export interface PendingActionsResult extends PendingActionsPayload {
  readonly failures: readonly { source: string; error: unknown }[];
}

export async function fetchPendingActions(
  employeeId: string,
  signal?: AbortSignal,
): Promise<PendingActionsResult> {
  const [inbox, acks, gaps, assets] = await Promise.allSettled([
    fetchApprovalInbox(signal),
    fetchOpenAcknowledgements(employeeId, signal),
    fetchMyDocumentGaps(employeeId, signal),
    fetchMyUnacknowledgedAssets(employeeId, signal),
  ]);

  const failures: { source: string; error: unknown }[] = [];
  const take = <T,>(result: PromiseSettledResult<T[]>, source: string): T[] => {
    if (result.status === "fulfilled") return result.value;
    failures.push({ source, error: result.reason });
    return [];
  };

  return {
    decisions: take(inbox, APPROVAL_INBOX_VIEW),
    acknowledgements: take(acks, DOCUMENT_ACKS_TABLE),
    documentGaps: take(gaps, DOCUMENT_COMPLIANCE_VIEW),
    assets: take(assets, ASSET_CUSTODY_VIEW),
    failures,
  };
}
