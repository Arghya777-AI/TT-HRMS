/**
 * workflow-admin.api.ts — the read layer for §12 Approvals & workflow
 * (/admin/workflow/*): the organisation-wide approval inbox, the chain
 * configuration, the SLA/breach register, the delegation register and the
 * override log.
 *
 * WHAT THIS MODULE IS ALLOWED TO BE. Migration 029 is explicit: "Writes to
 * approval_requests / approval_actions never come from clients: status /
 * current_level are engine-owned (SECURITY DEFINER RPCs). Clients only ever call
 * create_approval_request / act_on_approval." There is therefore NO update path
 * here for a request, a chain, a level or a breach — the chain screens are
 * read-only by construction, not by choice, and the only write in this file is
 * the one `delegations` actually grants a policy for.
 *
 * THE ONE DECISION PATH IS RE-USED, NOT FORKED. `act_on_approval` is already
 * wrapped once, in `features/team/api/team.api.ts` (`decideApproval`), together
 * with the "did the settled outcome reach the detail row?" reporting the RPC
 * itself does not do. The admin console calls THAT function rather than a second
 * copy: a second wrapper would be a second place for the leave-apply step to be
 * forgotten, and the two consoles would diverge the first time either changed.
 * The same goes for `fetchApprovalTrail` — one reader for one append-only table.
 *
 * SCOPE IS POSTGRES'S, ALWAYS. `approval_requests` gives an admin
 * `ar__admin_read` = `app.is_admin() AND app.admin_scope_covers(subject)`;
 * `approval_actions` inherits its parent request's audience through an EXISTS
 * that runs under the caller's own RLS; `sla_breaches` and `delegations` each
 * have their own admin-read policy. No filter in this file is a security
 * measure, and none is written as though it were.
 *
 * TWO SERVER-SIDE GAPS, NAMED RATHER THAN PAPERED OVER:
 *
 *  1. There is NO org-wide equivalent of `v_approval_inbox`. That view carries
 *     `is_overdue`, `sla_remaining_hours` and `age_hours` — all evaluated inside
 *     Postgres — but it ends in `app.current_employee_id() = ANY
 *     (ar.current_approver_ids)`, so an administrator sees only their OWN queue
 *     through it. The org console therefore reads the base table, which has
 *     `sla_due_at` but no server-evaluated "is it late yet". Rather than compare
 *     a timestamp against the browser clock (a screen that calls a request
 *     overdue while the database does not is the defect this whole codebase is
 *     written to avoid), the breach slice is driven by `sla_breaches` — rows the
 *     `sla_sweep()` cron writes on the server's clock, every 30 minutes.
 *  2. `v_approval_sla` is a per-approver × per-request-type roll-up of DECIDED
 *     actions. There is no view of pending-vs-target compliance, and none is
 *     invented here.
 */
import { z } from "zod";
import {
  eq,
  gte,
  inList,
  isFalse,
  isNotNull,
  isNull,
  isTrue,
  lt,
  paginate,
  selectCount,
  selectMany,
  updateRow,
  type Cursor,
  type Filter,
  type Page,
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumericNullable,
  dbPercentNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
} from "@/shared/api/query";
import { istRangeInstantBounds } from "@/lib/datetime";

/**
 * The decision RPC wrapper and the trail reader, re-exported from the manager
 * surface so the admin console cannot drift from it. See the header.
 */
export {
  decideApproval,
  fetchApprovalTrail,
  readSummaryFacts,
  LEAVE_REQUESTS_TABLE,
} from "@/features/team/api/team.api";
export type {
  ActorRef,
  ApprovalAction,
  ApprovalDecision,
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalTrail,
} from "@/features/team/api/team.api";

// -----------------------------------------------------------------------------
// Relations — named once
// -----------------------------------------------------------------------------

export const APPROVAL_REQUESTS_TABLE = "approval_requests";
export const APPROVAL_ACTIONS_TABLE = "approval_actions";
export const REQUEST_TYPES_TABLE = "request_types";
export const APPROVAL_CHAINS_TABLE = "approval_chains";
export const APPROVAL_CHAIN_LEVELS_TABLE = "approval_chain_levels";
export const DELEGATIONS_TABLE = "delegations";
export const SLA_BREACHES_TABLE = "sla_breaches";
export const V_APPROVAL_SLA = "v_approval_sla";
export const V_EMPLOYEE_REF = "v_employee_ref";

/** Hard caps. Every list here grows forever; an unbounded read is a defect. */
export const INBOX_PAGE_SIZE = 50;
export const REGISTER_ROW_CAP = 200;
export const OVERRIDE_PAGE_SIZE = 50;
/**
 * How many open-breach request ids the breach slice may carry into an `IN (…)`
 * predicate. Beyond this the SLA register itself is the right screen, and the
 * inbox says so instead of silently truncating.
 */
export const BREACH_ID_CAP = 200;

/**
 * A uuid no row holds, used when a slice's server-derived id set is EMPTY.
 * `IN ()` is not a legal predicate, and "no filter" would mean "every row" —
 * the opposite of the truth. This makes the empty set an empty result.
 */
const NO_SUCH_ID = "00000000-0000-0000-0000-000000000000";

/**
 * `column @> {value}` for a Postgres array column (`current_approver_ids`,
 * `request_type_ids`). The query layer's `Filter` vocabulary carries the
 * `contains` operator but exports no constructor for it, so this is the one
 * place that spells it out — still inside the closed vocabulary, no raw SQL.
 */
const arrayContains = (column: string, values: readonly string[]): Filter => ({
  op: "contains",
  column,
  values,
});

// -----------------------------------------------------------------------------
// 1. Vocabulary — `public.approval_status`, `public.approval_action`, priorities
// -----------------------------------------------------------------------------

/** `public.approval_status` (migration 003), in enum order. */
export const approvalStatusValues = [
  "draft",
  "pending",
  "in_progress",
  "approved",
  "rejected",
  "cancelled",
  "withdrawn",
  "expired",
  "auto_approved",
  "escalated",
  "applied",
  "failed",
] as const;
export type ApprovalStatus = (typeof approvalStatusValues)[number];

/** The three states `advance_approval` leaves a request in while it is live. */
export const OPEN_APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "in_progress",
  "escalated",
];

/** Everything the engine treats as finished. */
export const SETTLED_APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "approved",
  "rejected",
  "cancelled",
  "withdrawn",
  "expired",
  "auto_approved",
  "applied",
  "failed",
];

/** `approval_requests.priority` — a text column with a CHECK, never shown raw. */
export const approvalPriorityValues = ["low", "normal", "high", "urgent"] as const;
export type ApprovalPriority = (typeof approvalPriorityValues)[number];

/** `public.approval_action` (migration 003), in enum order. */
export const approvalActionValues = [
  "submit",
  "approve",
  "reject",
  "request_info",
  "provide_info",
  "delegate",
  "reassign",
  "escalate",
  "recall",
  "cancel",
  "comment",
  "auto_approve",
  "skip_level",
] as const;
export type ApprovalActionKind = (typeof approvalActionValues)[number];

/**
 * `approval_actions.acted_as` — the CHECK constraint's four values, i.e. HOW the
 * actor held the authority they used. `admin_override` is the one the Override
 * Log exists for.
 */
export const actedAsValues = ["approver", "delegate", "escalation", "admin_override"] as const;
export type ActedAs = (typeof actedAsValues)[number];

/** `approval_chain_levels.approver_kind` / `escalate_to_kind` (same CHECK list). */
export const approverKindValues = [
  "reporting_manager",
  "dotted_line_manager",
  "skip_level_manager",
  "department_head",
  "location_head",
  "specific_employee",
  "role",
  "any_of_role",
  "hr_admin",
  "finance",
  "super_admin",
] as const;
export type ApproverKind = (typeof approverKindValues)[number];

/** `delegations.scope` — the CHECK's two values. */
export const delegationScopeValues = ["approvals", "approvals_and_team_view"] as const;
export type DelegationScope = (typeof delegationScopeValues)[number];

// -----------------------------------------------------------------------------
// 2. request_types — the filter vocabulary and the designer's left column
// -----------------------------------------------------------------------------

export const requestTypeSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  detail_table: z.string(),
  sort_order: dbInt,
  is_active: z.boolean(),
  default_approval_chain_id: dbUuidNullable,
  sla_hours: dbInt,
  escalation_hours: dbIntNullable,
  auto_approve_after_hours: dbIntNullable,
  allows_withdrawal: z.boolean(),
  allows_partial_approval: z.boolean(),
  requires_attachment: z.boolean(),
});
export type RequestType = z.infer<typeof requestTypeSchema>;

const REQUEST_TYPE_COLUMNS =
  "id, code, name, description, detail_table, sort_order, is_active, " +
  "default_approval_chain_id, sla_hours, escalation_hours, auto_approve_after_hours, " +
  "allows_withdrawal, allows_partial_approval, requires_attachment";

/**
 * Every request type an admin may see. `request_types__admin_read` is
 * `app.is_admin()` with no `is_active` predicate, so an inactive type still
 * appears — a request raised under one must remain explicable.
 */
export function fetchRequestTypes(signal?: AbortSignal): Promise<RequestType[]> {
  return selectMany(REQUEST_TYPES_TABLE, requestTypeSchema, {
    columns: REQUEST_TYPE_COLUMNS,
    filters: [isNull("deleted_at")],
    order: [{ column: "sort_order", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. The organisation-wide inbox — approval_requests
// -----------------------------------------------------------------------------

export const approvalRequestRowSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  request_type_id: dbUuid,
  approval_chain_id: dbUuid,
  detail_table: z.string(),
  detail_id: dbUuid,
  subject_employee_id: dbUuid,
  raised_by: dbUuid,
  on_behalf_of: dbUuidNullable,
  title: z.string(),
  summary: z.record(z.unknown()).nullable(),
  amount: dbNumericNullable,
  days: dbNumericNullable,
  status: z.string(),
  current_level: dbInt,
  total_levels: dbInt,
  current_approver_ids: z.array(dbUuid),
  priority: z.string(),
  submitted_at: dbTimestamp,
  sla_due_at: dbTimestamp,
  first_action_at: dbTimestampNullable,
  decided_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
  applied_at: dbTimestampNullable,
  apply_error: z.string().nullable(),
  escalated_at: dbTimestampNullable,
  escalated_to: dbUuidNullable,
});
export type ApprovalRequestRow = z.infer<typeof approvalRequestRowSchema>;

const APPROVAL_REQUEST_COLUMNS =
  "id, request_number, request_type_id, approval_chain_id, detail_table, detail_id, " +
  "subject_employee_id, raised_by, on_behalf_of, title, summary, amount, days, status, " +
  "current_level, total_levels, current_approver_ids, priority, submitted_at, sla_due_at, " +
  "first_action_at, decided_at, decision_comment, applied_at, apply_error, escalated_at, " +
  "escalated_to";

/**
 * The slices the console offers. Each is a STATUS-GROUP or a server-recorded
 * fact — never a clock comparison made in the browser:
 *
 *  * `open`      — the three live statuses.
 *  * `mine`      — live, and this admin's employee id is in the materialised
 *                  `current_approver_ids` array (the same predicate
 *                  `v_approval_inbox` and `ar__approver_read` use).
 *  * `escalated` — live, and `escalated_at IS NOT NULL`, stamped by `sla_sweep`.
 *  * `breached`  — live, and the id is in the open-breach set read out of
 *                  `sla_breaches` (see the module header, gap 1).
 *  * `settled`   — everything the engine has finished with.
 *  * `all`       — no status predicate at all.
 */
export const inboxSliceValues = [
  "open",
  "mine",
  "escalated",
  "breached",
  "settled",
  "all",
] as const;
export type InboxSlice = (typeof inboxSliceValues)[number];

export function isInboxSlice(value: string | null): value is InboxSlice {
  return value !== null && (inboxSliceValues as readonly string[]).includes(value);
}

export interface InboxFilters {
  readonly slice: InboxSlice;
  readonly requestTypeId?: string;
  readonly status?: ApprovalStatus;
  readonly priority?: ApprovalPriority;
  /** `employees.id` of the signed-in admin — required by the `mine` slice. */
  readonly approverEmployeeId?: string;
  /** Open-breach request ids from `sla_breaches` — required by `breached`. */
  readonly breachedRequestIds?: readonly string[];
}

/**
 * ONE predicate builder for the grid AND for every tile, so a tile is by
 * construction the cardinality of the rows it opens (DR-29). Filters are
 * AND-only: the query layer's vocabulary has no OR, and a screen that pretends
 * otherwise is worse than one that says which column it is filtering.
 */
export function inboxFilters(f: InboxFilters): readonly Filter[] {
  const out: Filter[] = [];

  switch (f.slice) {
    case "open":
      out.push(inList("status", OPEN_APPROVAL_STATUSES));
      break;
    case "mine":
      out.push(inList("status", OPEN_APPROVAL_STATUSES));
      // No approver id (an admin account with no employee row) means the
      // question "waiting on me" has no answer — not "waiting on everyone".
      out.push(
        f.approverEmployeeId !== undefined && f.approverEmployeeId !== ""
          ? arrayContains("current_approver_ids", [f.approverEmployeeId])
          : eq("id", NO_SUCH_ID),
      );
      break;
    case "escalated":
      out.push(inList("status", OPEN_APPROVAL_STATUSES));
      out.push(isNotNull("escalated_at"));
      break;
    case "breached": {
      out.push(inList("status", OPEN_APPROVAL_STATUSES));
      const ids = f.breachedRequestIds ?? [];
      out.push(ids.length === 0 ? eq("id", NO_SUCH_ID) : inList("id", ids));
      break;
    }
    case "settled":
      out.push(inList("status", SETTLED_APPROVAL_STATUSES));
      break;
    case "all":
      break;
  }

  if (f.requestTypeId !== undefined && f.requestTypeId !== "") {
    out.push(eq("request_type_id", f.requestTypeId));
  }
  if (f.status !== undefined) out.push(eq("status", f.status));
  if (f.priority !== undefined) out.push(eq("priority", f.priority));
  return out;
}

/** Newest submission first, keyset-paged on (submitted_at, id). */
export function fetchApprovalRequests(
  f: InboxFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<ApprovalRequestRow>> {
  return paginate(APPROVAL_REQUESTS_TABLE, approvalRequestRowSchema, {
    orderBy: "submitted_at",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: inboxFilters(f),
    columns: APPROVAL_REQUEST_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/** The same predicate, counted by Postgres (`HEAD` + `count=exact`). */
export function countApprovalRequests(f: InboxFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(APPROVAL_REQUESTS_TABLE, inboxFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. sla_breaches — the register, and the id set the inbox's breach slice uses
// -----------------------------------------------------------------------------

export const slaBreachSchema = z.object({
  id: dbUuid,
  approval_request_id: dbUuid,
  level: dbInt,
  approver_id: dbUuidNullable,
  sla_due_at: dbTimestamp,
  breached_at: dbTimestamp,
  hours_overdue: dbNumericNullable,
  escalated_to: dbUuidNullable,
  escalated_at: dbTimestampNullable,
  resolved_at: dbTimestampNullable,
  resolution: z.string().nullable(),
  notified_count: dbInt,
  recorded_at: dbTimestamp,
});
export type SlaBreach = z.infer<typeof slaBreachSchema>;

const SLA_BREACH_COLUMNS =
  "id, approval_request_id, level, approver_id, sla_due_at, breached_at, hours_overdue, " +
  "escalated_to, escalated_at, resolved_at, resolution, notified_count, recorded_at";

/** `sla_breaches.resolution` — the CHECK's four values. */
export const breachResolutionValues = [
  "acted",
  "escalated",
  "auto_approved",
  "cancelled",
] as const;
export type BreachResolution = (typeof breachResolutionValues)[number];

export const breachSliceValues = ["open", "escalated", "resolved", "all"] as const;
export type BreachSlice = (typeof breachSliceValues)[number];

export function isBreachSlice(value: string | null): value is BreachSlice {
  return value !== null && (breachSliceValues as readonly string[]).includes(value);
}

export interface BreachFilters {
  readonly slice: BreachSlice;
  /** `employees.id` of the approver the breach was recorded against. */
  readonly approverEmployeeId?: string;
}

export function breachFilters(f: BreachFilters): readonly Filter[] {
  const out: Filter[] = [];
  switch (f.slice) {
    case "open":
      out.push(isNull("resolved_at"));
      break;
    case "escalated":
      out.push(isNotNull("escalated_at"));
      break;
    case "resolved":
      out.push(isNotNull("resolved_at"));
      break;
    case "all":
      break;
  }
  if (f.approverEmployeeId !== undefined && f.approverEmployeeId !== "") {
    out.push(eq("approver_id", f.approverEmployeeId));
  }
  return out;
}

/** Most recently breached first — the register is read top-down. */
export function fetchSlaBreaches(
  f: BreachFilters,
  limit = REGISTER_ROW_CAP,
  signal?: AbortSignal,
): Promise<SlaBreach[]> {
  return selectMany(SLA_BREACHES_TABLE, slaBreachSchema, {
    columns: SLA_BREACH_COLUMNS,
    filters: breachFilters(f),
    order: [{ column: "breached_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export function countSlaBreaches(f: BreachFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(SLA_BREACHES_TABLE, breachFilters(f), { ...(signal ? { signal } : {}) });
}

const breachRequestIdSchema = z.object({ approval_request_id: dbUuid });

/**
 * The requests that currently hold an UNRESOLVED breach row, as written by
 * `sla_sweep()` on the server's clock. This is what makes an org-wide "late"
 * slice possible without the browser deciding what "now" is.
 */
export async function fetchOpenBreachRequestIds(
  limit = BREACH_ID_CAP,
  signal?: AbortSignal,
): Promise<string[]> {
  const rows = await selectMany(SLA_BREACHES_TABLE, breachRequestIdSchema, {
    columns: "approval_request_id",
    filters: [isNull("resolved_at")],
    order: [{ column: "breached_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
  return [...new Set(rows.map((r) => r.approval_request_id))];
}

// -----------------------------------------------------------------------------
// 5. v_approval_sla — decided-action compliance, per approver × request type
// -----------------------------------------------------------------------------

export const approvalSlaSchema = z.object({
  approver_employee_id: dbUuid,
  approver_employee_code: z.string(),
  approver_display_name: z.string(),
  request_type_id: dbUuid,
  request_type_code: z.string(),
  request_type_name: z.string(),
  decided: dbInt,
  on_time: dbInt,
  breached: dbInt,
  on_time_pct: dbPercentNullable,
  avg_hours_to_decide: dbNumericNullable,
});
export type ApprovalSlaRow = z.infer<typeof approvalSlaSchema>;

export interface SlaFilters {
  readonly requestTypeId?: string;
  readonly approverEmployeeId?: string;
}

export function slaFilters(f: SlaFilters): readonly Filter[] {
  const out: Filter[] = [];
  if (f.requestTypeId !== undefined && f.requestTypeId !== "") {
    out.push(eq("request_type_id", f.requestTypeId));
  }
  if (f.approverEmployeeId !== undefined && f.approverEmployeeId !== "") {
    out.push(eq("approver_employee_id", f.approverEmployeeId));
  }
  return out;
}

/**
 * `on_time_pct` and `avg_hours_to_decide` are computed INSIDE the view
 * (§9.2 `on_time * 100.0 / NULLIF(decided, 0)`); nothing is divided here.
 */
export function fetchApprovalSla(
  f: SlaFilters,
  limit = REGISTER_ROW_CAP,
  signal?: AbortSignal,
): Promise<ApprovalSlaRow[]> {
  return selectMany(V_APPROVAL_SLA, approvalSlaSchema, {
    filters: slaFilters(f),
    order: [
      { column: "decided", ascending: false },
      { column: "approver_display_name", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export function countApprovalSlaRows(f: SlaFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_APPROVAL_SLA, slaFilters(f), { ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// 6. approval_chains + approval_chain_levels — the configuration, read-only
// -----------------------------------------------------------------------------

export const approvalChainSchema = z.object({
  id: dbUuid,
  request_type_id: dbUuidNullable,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: dbInt,
  is_active: z.boolean(),
  applies_to_department_ids: z.array(dbUuid).nullable(),
  applies_to_grade_ids: z.array(dbUuid).nullable(),
  applies_to_employment_types: z.array(z.string()).nullable(),
  amount_from: dbNumericNullable,
  amount_to: dbNumericNullable,
  days_from: dbNumericNullable,
  days_to: dbNumericNullable,
  priority: dbInt,
  is_default: z.boolean(),
  updated_at: dbTimestamp,
});
export type ApprovalChain = z.infer<typeof approvalChainSchema>;

const APPROVAL_CHAIN_COLUMNS =
  "id, request_type_id, code, name, description, sort_order, is_active, " +
  "applies_to_department_ids, applies_to_grade_ids, applies_to_employment_types, " +
  "amount_from, amount_to, days_from, days_to, priority, is_default, updated_at";

export interface ChainFilters {
  readonly requestTypeId?: string;
  /** Chains an admin has retired. Off by default; the screen labels the toggle. */
  readonly includeInactive?: boolean;
}

export function chainFilters(f: ChainFilters): readonly Filter[] {
  const out: Filter[] = [isNull("deleted_at")];
  if (f.requestTypeId !== undefined && f.requestTypeId !== "") {
    out.push(eq("request_type_id", f.requestTypeId));
  }
  if (f.includeInactive !== true) out.push(isTrue("is_active"));
  return out;
}

/**
 * Chain order is the order `create_approval_request` resolves them in: lowest
 * `priority` first (the narrowest band wins), then `sort_order`.
 */
export function fetchApprovalChains(
  f: ChainFilters,
  signal?: AbortSignal,
): Promise<ApprovalChain[]> {
  return selectMany(APPROVAL_CHAINS_TABLE, approvalChainSchema, {
    columns: APPROVAL_CHAIN_COLUMNS,
    filters: chainFilters(f),
    order: [
      { column: "priority", ascending: true },
      { column: "sort_order", ascending: true },
    ],
    limit: REGISTER_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countApprovalChains(f: ChainFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(APPROVAL_CHAINS_TABLE, chainFilters(f), { ...(signal ? { signal } : {}) });
}

export const approvalChainLevelSchema = z.object({
  id: dbUuid,
  approval_chain_id: dbUuid,
  level: dbInt,
  approver_kind: z.string(),
  specific_employee_id: dbUuidNullable,
  role: z.string().nullable(),
  min_approvals: dbInt,
  is_optional: z.boolean(),
  can_edit_request: z.boolean(),
  sla_hours: dbIntNullable,
  escalate_to_kind: z.string().nullable(),
  skip_if_same_as_previous: z.boolean(),
  notify_only: z.boolean(),
});
export type ApprovalChainLevel = z.infer<typeof approvalChainLevelSchema>;

const CHAIN_LEVEL_COLUMNS =
  "id, approval_chain_id, level, approver_kind, specific_employee_id, role, min_approvals, " +
  "is_optional, can_edit_request, sla_hours, escalate_to_kind, skip_if_same_as_previous, " +
  "notify_only";

/** Every level of the chains on screen, in chain-then-level order. */
export function fetchChainLevels(
  chainIds: readonly string[],
  signal?: AbortSignal,
): Promise<ApprovalChainLevel[]> {
  if (chainIds.length === 0) return Promise.resolve([]);
  return selectMany(APPROVAL_CHAIN_LEVELS_TABLE, approvalChainLevelSchema, {
    columns: CHAIN_LEVEL_COLUMNS,
    filters: [inList("approval_chain_id", chainIds)],
    order: [
      { column: "approval_chain_id", ascending: true },
      { column: "level", ascending: true },
    ],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 7. delegations — the register, plus the ONE write this module has a policy for
// -----------------------------------------------------------------------------

export const delegationSchema = z.object({
  id: dbUuid,
  delegator_profile_id: dbUuid,
  delegate_profile_id: dbUuid,
  request_type_ids: z.array(dbUuid).nullable(),
  scope: z.string(),
  from_date: dbDate,
  to_date: dbDateNullable,
  reason: z.string().nullable(),
  is_active: z.boolean(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});
export type Delegation = z.infer<typeof delegationSchema>;

const DELEGATION_COLUMNS =
  "id, delegator_profile_id, delegate_profile_id, request_type_ids, scope, from_date, " +
  "to_date, reason, is_active, created_at, updated_at";

export const delegationSliceValues = ["active", "ended", "all"] as const;
export type DelegationSlice = (typeof delegationSliceValues)[number];

export function isDelegationSlice(value: string | null): value is DelegationSlice {
  return value !== null && (delegationSliceValues as readonly string[]).includes(value);
}

export interface DelegationFilters {
  readonly slice: DelegationSlice;
  readonly scope?: DelegationScope;
  /** `request_types.id` — matches `request_type_ids @> {id}` (array contains). */
  readonly requestTypeId?: string;
}

/**
 * NOTE ON "ACTIVE": `is_active` is the flag the delegations guard trigger and
 * `resolve_approvers` both read, but the RPC ALSO requires
 * `CURRENT_DATE BETWEEN from_date AND COALESCE(to_date, CURRENT_DATE)`. Whether
 * a flagged-active row is in force TODAY is therefore a date question the server
 * answers, not this filter — the screen prints both facts and never merges them
 * into one word.
 */
export function delegationFilters(f: DelegationFilters): readonly Filter[] {
  const out: Filter[] = [];
  if (f.slice === "active") out.push(isTrue("is_active"));
  if (f.slice === "ended") out.push(isFalse("is_active"));
  if (f.scope !== undefined) out.push(eq("scope", f.scope));
  if (f.requestTypeId !== undefined && f.requestTypeId !== "") {
    out.push(arrayContains("request_type_ids", [f.requestTypeId]));
  }
  return out;
}

export function fetchDelegations(
  f: DelegationFilters,
  limit = REGISTER_ROW_CAP,
  signal?: AbortSignal,
): Promise<Delegation[]> {
  return selectMany(DELEGATIONS_TABLE, delegationSchema, {
    columns: DELEGATION_COLUMNS,
    filters: delegationFilters(f),
    order: [
      { column: "from_date", ascending: false },
      { column: "created_at", ascending: false },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export function countDelegations(f: DelegationFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(DELEGATIONS_TABLE, delegationFilters(f), { ...(signal ? { signal } : {}) });
}

export interface EndDelegationInput {
  readonly delegationId: string;
}

/**
 * End a delegation — the only write on the five workflow screens.
 *
 * It exists because `delegations__own_update` genuinely grants it
 * (`delegator_profile_id = app.ctx_actor_id() OR app.is_admin()`), and because
 * an approval authority that cannot be handed back is a governance hole: the
 * F&B manager delegated their approvals for a 12-hour wedding and left the
 * company three weeks later.
 *
 * `is_active = false` is the ONLY field touched. Dates are history: rewriting
 * `to_date` would retro-narrow a window under which decisions were already
 * taken, and `approval_actions.delegated_from` still points at those.
 */
export function endDelegation(
  input: EndDelegationInput,
  reason: string,
  signal?: AbortSignal,
): Promise<Delegation> {
  return updateRow(
    DELEGATIONS_TABLE,
    [eq("id", input.delegationId), isTrue("is_active")],
    { is_active: false },
    delegationSchema,
    { reason, columns: DELEGATION_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 8. The Override Log — approval_actions, filtered by HOW the authority was held
// -----------------------------------------------------------------------------

export const overrideActionSchema = z.object({
  id: dbUuid,
  approval_request_id: dbUuid,
  level: dbInt,
  actor_id: dbUuidNullable,
  actor_role: z.string().nullable(),
  acted_as: z.string().nullable(),
  delegated_from: dbUuidNullable,
  action: z.string(),
  comment: z.string().nullable(),
  device_id: z.string().nullable(),
  acted_at: dbTimestamp,
  time_to_action_seconds: dbIntNullable,
});
export type OverrideAction = z.infer<typeof overrideActionSchema>;

const OVERRIDE_COLUMNS =
  "id, approval_request_id, level, actor_id, actor_role, acted_as, delegated_from, action, " +
  "comment, device_id, acted_at, time_to_action_seconds";

/**
 * Each kind is ONE server-column predicate, because the query layer has no OR
 * and a "deliberate override" is not one column:
 *
 *  * `admin_override` — `acted_as`, stamped by `act_on_approval` when the actor
 *    was NOT in `current_approver_ids` but IS an admin.
 *  * `delegate`       — `acted_as`, i.e. authority borrowed from someone else.
 *  * `escalation`     — `acted_as`, written by `sla_sweep` with a NULL actor.
 *  * `skip_level`     — the ACTION `advance_approval` records when a level was
 *    skipped (optional level, or `skip_if_same_as_previous`).
 *  * `auto_approve`   — the ACTION `sla_sweep` records when a request type's
 *    `auto_approve_after_hours` elapsed. Nothing at Tamarind Tree sets it, so
 *    this slice reading zero is the configuration being confirmed.
 */
export const overrideKindValues = [
  "admin_override",
  "delegate",
  "escalation",
  "skip_level",
  "auto_approve",
] as const;
export type OverrideKind = (typeof overrideKindValues)[number];

export function isOverrideKind(value: string | null): value is OverrideKind {
  return value !== null && (overrideKindValues as readonly string[]).includes(value);
}

export interface OverrideFilters {
  readonly kind: OverrideKind;
  /** IST civil dates, inclusive — converted to instants by `lib/datetime`. */
  readonly fromDate?: string;
  readonly toDate?: string;
}

export function overrideFilters(f: OverrideFilters): readonly Filter[] {
  const out: Filter[] = [];
  if (f.kind === "skip_level" || f.kind === "auto_approve") {
    out.push(eq("action", f.kind));
  } else {
    out.push(eq("acted_as", f.kind));
  }
  if (f.fromDate !== undefined && f.toDate !== undefined) {
    // `acted_at` is timestamptz: comparing it to a bare 'YYYY-MM-DD' would pin
    // the bound to 05:30 IST and lose the first five and a half hours.
    const { fromInstant, toInstantExclusive } = istRangeInstantBounds(f.fromDate, f.toDate);
    out.push(gte("acted_at", fromInstant));
    out.push(lt("acted_at", toInstantExclusive));
  }
  return out;
}

/** Newest first, keyset-paged on (acted_at, id). Append-only: never rewritten. */
export function fetchOverrideActions(
  f: OverrideFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<OverrideAction>> {
  return paginate(APPROVAL_ACTIONS_TABLE, overrideActionSchema, {
    orderBy: "acted_at",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: overrideFilters(f),
    columns: OVERRIDE_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

export function countOverrideActions(f: OverrideFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(APPROVAL_ACTIONS_TABLE, overrideFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 9. Label joins — an id on an evidence surface must resolve to a person
// -----------------------------------------------------------------------------

/**
 * The requests behind a list of ids, narrowed to what a register row needs to
 * name what was overridden or breached. Same table, same admin policy as the
 * inbox — a second read keyed by ids already on screen, never a second source
 * of truth for a queue.
 */
export const requestRefSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  title: z.string(),
  request_type_id: dbUuid,
  subject_employee_id: dbUuid,
  status: z.string(),
  sla_due_at: dbTimestamp,
});
export type RequestRef = z.infer<typeof requestRefSchema>;

export function fetchRequestRefs(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<RequestRef[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return selectMany(APPROVAL_REQUESTS_TABLE, requestRefSchema, {
    columns: "id, request_number, title, request_type_id, subject_employee_id, status, sla_due_at",
    filters: [inList("id", ids)],
    limit: ids.length,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `profiles.id` → a person, through `v_employee_ref`. `profiles` itself is
 * self-only, so this is the ONLY way to put a name on an actor id or on a
 * delegation's two ends.
 */
export const personRefSchema = z.object({
  id: dbUuid,
  profile_id: dbUuidNullable,
  employee_code: z.string(),
  display_name: z.string(),
  designation_name: z.string().nullable(),
  department_name: z.string().nullable(),
});
export type PersonRef = z.infer<typeof personRefSchema>;

const PERSON_REF_COLUMNS =
  "id, profile_id, employee_code, display_name, designation_name, department_name";

export function fetchPeopleByProfileIds(
  profileIds: readonly string[],
  signal?: AbortSignal,
): Promise<PersonRef[]> {
  if (profileIds.length === 0) return Promise.resolve([]);
  return selectMany(V_EMPLOYEE_REF, personRefSchema, {
    columns: PERSON_REF_COLUMNS,
    filters: [inList("profile_id", profileIds)],
    limit: profileIds.length,
    ...(signal ? { signal } : {}),
  });
}

export function fetchPeopleByEmployeeIds(
  employeeIds: readonly string[],
  signal?: AbortSignal,
): Promise<PersonRef[]> {
  if (employeeIds.length === 0) return Promise.resolve([]);
  return selectMany(V_EMPLOYEE_REF, personRefSchema, {
    columns: PERSON_REF_COLUMNS,
    filters: [inList("id", employeeIds)],
    limit: employeeIds.length,
    ...(signal ? { signal } : {}),
  });
}
