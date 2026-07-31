/**
 * ticket.api.ts — the reads and the two writes behind `/me/helpdesk/:id`.
 *
 * READ THIS BEFORE CHANGING THE SOURCE. spec-employee §5 E-14 asks for a ticket
 * thread over `tickets` / `ticket_messages` / `ticket_slas` / `ticket_feedback`.
 * None of those tables exists: `grep -rn ticket supabase/migrations/` matches one
 * seed comment and nothing else, and PostgREST answers
 * `GET /rest/v1/helpdesk_tickets` with 404 PGRST205. `/me/helpdesk` (the list)
 * therefore renders an honest gap page rather than approval rows relabelled as
 * tickets, and this screen does NOT relabel them either.
 *
 * What it opens instead is the object that IS deployed and that genuinely has
 * the two properties the route promises — "the conversation and its
 * service-level clock":
 *
 *   * `approval_requests` (029 §4) — one row per raised request, with the
 *     server-issued `request_number`, `status`, `current_level`/`total_levels`,
 *     `submitted_at`, `sla_due_at`, `first_action_at`, `escalated_at` and
 *     `current_approver_ids`. RLS `ar__self_read` returns it when
 *     `subject_employee_id = app.current_employee_id()`, `on_behalf_of` is me, or
 *     `raised_by = app.ctx_actor_id()` — so this is my own thread by
 *     construction, and someone else's reference returns nothing.
 *   * `approval_actions` (029 §5) — THE conversation. Append-only:
 *     `trg_approval_actions__immutable` runs `audit.refuse_mutation()` on UPDATE
 *     and DELETE, so no entry can be edited or removed by anyone. RLS
 *     `aa__via_request_read` inherits the parent request's audience.
 *   * `request_types` (029 §1) — `sla_hours` and `escalation_hours`, i.e. the
 *     clock itself, plus `allows_withdrawal`, which decides whether the withdraw
 *     button may exist at all. `request_types__all_read` gives every employee the
 *     active rows.
 *
 * Deliberately NOT read: `sla_breaches` (029 §7). Its only self policy is
 * `USING (approver_id = app.current_employee_id() OR escalated_to = ...)` — the
 * SUBJECT of a request is not in that audience, so an employee's query returns
 * zero rows whether or not the SLA was breached. Rendering "no breach" from it
 * would be a confident lie about withheld data.
 *
 * WRITES. Neither table has an INSERT/UPDATE/DELETE policy for `authenticated`:
 * `status`, `current_level` and `current_approver_ids` move only inside
 * `public.act_on_approval(uuid, approval_action, text, jsonb)` (SECURITY
 * DEFINER, `GRANT EXECUTE ... TO authenticated`, 029 line 1368). Read against
 * that function's body, an employee — the `v_is_subject` branch — may do exactly
 * three things, and this module exposes exactly those three:
 *   * `comment`      — allowed for subject, approver or admin.
 *   * `provide_info` — "only the requester can provide info", i.e. the reply that
 *     answers an approver's `request_info`.
 *   * `recall`       — "only the requester can recall", and only when
 *     `request_types.allows_withdrawal` and the status is still open.
 * `approve`, `reject`, `escalate`, `delegate` and `reassign` all raise 42501 for
 * a non-approver, so no button for them is offered here.
 */
import { z } from "zod";
import {
  dbInt,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  inList,
  rpcAudited,
  selectOne,
  selectMany,
  MutationError,
} from "@/shared/api/query";
import {
  APPROVAL_REQUESTS_TABLE,
  EMPLOYEE_DIRECTORY_VIEW,
  approvalStatusSchema,
  directoryEntrySchema,
  type DirectoryEntry,
} from "@/features/apply/api/apply.api";
import {
  APPROVAL_ACTIONS_TABLE,
  EMPLOYEE_REF_VIEW,
  approvalActionSchema,
  employeeRefSchema,
  type ApprovalActionRow,
  type EmployeeRef,
} from "@/features/leave/api/leave-apply.api";

/**
 * The one client-facing action RPC. Named here rather than imported from
 * `features/team/api/team.api` on purpose: that module is the manager chunk, and
 * an employee screen should not pull it in to learn a function name. It is the
 * same function, called with the same argument names.
 */
export const ACT_ON_APPROVAL_FN = "act_on_approval";

/** Statuses in which the engine still accepts a comment, an answer or a recall. */
export const OPEN_THREAD_STATUSES = ["pending", "in_progress", "escalated"] as const;

// -----------------------------------------------------------------------------
// 1. The thread head
// -----------------------------------------------------------------------------

/**
 * Projection of `approval_requests` for one thread. Wider than the leave
 * screen's `approvalRequestSchema` because this screen is the request itself
 * rather than a trail beside it: it needs the title, the priority, the money/day
 * selectors and the materialised approver list.
 *
 * `amount` is `numeric(14,2)` RUPEES on this table (029 §4) — NOT paise, so it
 * is formatted with `formatINR` and never with the paise helpers.
 */
export const ticketSchema = z.object({
  id: dbUuid,
  /** Server-issued, e.g. `LEAVE-000004`. The reference we quote. */
  request_number: z.string(),
  request_type_id: dbUuid,
  detail_table: z.string(),
  detail_id: dbUuid,
  subject_employee_id: dbUuid,
  /** `profiles.id` of whoever raised it — mine, or HR's in assisted mode. */
  raised_by: dbUuid,
  on_behalf_of: dbUuidNullable,
  title: z.string(),
  /** Server-rendered jsonb; displayed as key/value pairs, never re-computed. */
  summary: z.unknown(),
  amount: dbNumericNullable,
  days: dbNumericNullable,
  status: approvalStatusSchema,
  current_level: dbInt,
  total_levels: dbInt,
  current_approver_ids: z.array(dbUuid),
  submitted_at: dbTimestamp,
  /** The service-level clock. Computed by the engine at insert; read-only here. */
  sla_due_at: dbTimestamp,
  first_action_at: dbTimestampNullable,
  decided_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
  escalated_at: dbTimestampNullable,
  cancelled_at: dbTimestampNullable,
  cancellation_reason: z.string().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  request_types: z
    .object({
      code: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      sla_hours: dbInt,
      escalation_hours: z.number().int().nullable(),
      allows_withdrawal: z.boolean(),
      icon: z.string().nullable(),
    })
    .nullable(),
});

export type Ticket = z.infer<typeof ticketSchema>;

const TICKET_COLUMNS =
  "id, request_number, request_type_id, detail_table, detail_id, subject_employee_id, " +
  "raised_by, on_behalf_of, title, summary, amount, days, status, current_level, " +
  "total_levels, current_approver_ids, submitted_at, sla_due_at, first_action_at, " +
  "decided_at, decision_comment, escalated_at, cancelled_at, cancellation_reason, " +
  "priority, request_types(code, name, description, sla_hours, escalation_hours, " +
  "allows_withdrawal, icon)";

export interface TicketThread {
  readonly request: Ticket;
  /** The conversation, oldest first — the order it was said in. */
  readonly actions: readonly ApprovalActionRow[];
  /** `profiles.id` → the person, so an entry is attributed by name and code. */
  readonly actors: ReadonlyMap<string, EmployeeRef>;
  /** Who the request is sitting with right now, resolved to names. */
  readonly approvers: readonly DirectoryEntry[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One thread by whatever the URL carries.
 *
 * The route is `/me/helpdesk/:id` and both forms are useful: a uuid is what a
 * deep link from another screen holds, and the `request_number` is what a person
 * reads off a notification and types. `uq_ar__request_number` makes the second
 * lookup single-row, so neither form can quietly return the wrong thread.
 *
 * `null` means "no such row FOR YOU": RLS decides, and the screen says so
 * without claiming the reference does not exist anywhere.
 */
export async function fetchTicketThread(
  idOrNumber: string,
  signal?: AbortSignal,
): Promise<TicketThread | null> {
  const key = idOrNumber.trim();
  if (key.length === 0) return null;

  const request = await selectOne(
    APPROVAL_REQUESTS_TABLE,
    ticketSchema,
    [UUID_PATTERN.test(key) ? eq("id", key) : eq("request_number", key.toUpperCase())],
    { columns: TICKET_COLUMNS, ...(signal ? { signal } : {}) },
  );
  if (request === null) return null;

  const actions = await selectMany(APPROVAL_ACTIONS_TABLE, approvalActionSchema, {
    columns: "id, approval_request_id, level, actor_id, actor_role, acted_as, action, comment, acted_at",
    filters: [eq("approval_request_id", request.id)],
    order: [
      { column: "acted_at", ascending: true },
      { column: "level", ascending: true },
    ],
    limit: 200,
    ...(signal ? { signal } : {}),
  });

  const actorProfileIds = [
    ...new Set(actions.map((a) => a.actor_id).filter((v): v is string => v !== null)),
  ];
  const actors = new Map<string, EmployeeRef>();
  if (actorProfileIds.length > 0) {
    const refs = await selectMany(EMPLOYEE_REF_VIEW, employeeRefSchema, {
      columns: "id, profile_id, employee_code, display_name, designation_name",
      filters: [inList("profile_id", actorProfileIds)],
      limit: actorProfileIds.length,
      ...(signal ? { signal } : {}),
    });
    for (const ref of refs) if (ref.profile_id !== null) actors.set(ref.profile_id, ref);
  }

  const approvers =
    request.current_approver_ids.length === 0
      ? []
      : await selectMany(EMPLOYEE_DIRECTORY_VIEW, directoryEntrySchema, {
          columns: "id, employee_code, display_name, designation_name",
          filters: [inList("id", request.current_approver_ids)],
          limit: request.current_approver_ids.length,
          ...(signal ? { signal } : {}),
        });

  return { request, actions, actors, approvers };
}

// -----------------------------------------------------------------------------
// 2. Where the underlying row lives
// -----------------------------------------------------------------------------

export interface DetailTarget {
  readonly to: string;
  /** True when the route opens THIS row; false when it opens the owning screen. */
  readonly rowSpecific: boolean;
}

/**
 * The self-service screen for a request's `detail_table`.
 *
 * Only `leave_requests` has a per-row employee route (`/me/leave/:id`); the rest
 * of the detail tables are surfaced by the screen that owns them, and the caller
 * labels the link differently for the two cases rather than implying a row view
 * that does not exist. Tables with no employee screen at all return `null` — the
 * seven request types with no chain (`WEB_LOGIN`, `ASSET_REQUEST` and friends,
 * see apply-requests.api) can never produce a request in the first place, but a
 * `resignations` or `travel_requisitions` row raised by HR could.
 */
export function detailTargetFor(request: Ticket): DetailTarget | null {
  switch (request.detail_table) {
    case "leave_requests":
      return { to: `/me/leave/${request.detail_id}`, rowSpecific: true };
    case "attendance_regularizations":
      return { to: "/me/regularizations", rowSpecific: false };
    case "reimbursement_claims":
      return { to: "/me/apply/claim", rowSpecific: false };
    case "comp_off_ledger":
      return { to: "/me/comp-off", rowSpecific: false };
    case "asset_allocations":
      return { to: "/me/assets", rowSpecific: false };
    case "employee_change_requests":
      return { to: "/me/profile/history", rowSpecific: false };
    case "employee_salary_revisions":
      return { to: "/me/profile/salary", rowSpecific: false };
    case "contracts":
      return { to: "/me/profile/documents", rowSpecific: false };
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// 3. The two things an employee may write
// -----------------------------------------------------------------------------

/** What `act_on_approval` hands back: one jsonb object. */
export const actOnApprovalResultSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  status: z.string(),
  current_level: dbInt,
});
export type ActOnApprovalResult = z.infer<typeof actOnApprovalResultSchema>;

/**
 * `comment` is a free reply; `provide_info` is the reply that ANSWERS an
 * approver's `request_info`. The engine treats them differently — only
 * `provide_info` is restricted to the requester — so the caller must decide which
 * one this reply is instead of always posting the weaker one.
 */
export type ReplyAction = "comment" | "provide_info";

/**
 * Which action the next reply from the employee should be.
 *
 * `request_info` is the approver asking a question, `provide_info` is the answer.
 * If the last of those two on the trail was the question, the reply answers it;
 * otherwise it is an ordinary comment. Read off the trail, never guessed from
 * the status: `request_info` sets `status = 'in_progress'`, but so does a
 * delegation, so status alone cannot tell the two apart.
 */
export function nextReplyAction(actions: readonly ApprovalActionRow[]): ReplyAction {
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const action = actions[i]?.action;
    if (action === "request_info") return "provide_info";
    if (action === "provide_info") return "comment";
  }
  return "comment";
}

function firstRowOrThrow(
  rows: readonly ActOnApprovalResult[],
  reference: string,
): ActOnApprovalResult {
  const row = rows[0];
  if (row === undefined) {
    throw new MutationError(
      ACT_ON_APPROVAL_FN,
      "not_found",
      `${ACT_ON_APPROVAL_FN} returned no row for ${reference}, so nothing was recorded.`,
    );
  }
  return row;
}

/**
 * Post a reply on the thread.
 *
 * The text travels TWICE and on purpose: as `p_comment`, where it becomes the
 * `approval_actions.comment` everyone on the thread reads, and as the `x-reason`
 * header via `rpcAudited`, because the same transaction's audit trigger reads
 * `app.reason` and a reply with no stated reason is the thing this build refuses
 * to write. `approval_actions` is not in `audit.reason_required_tables`, so the
 * header is not strictly demanded here — sending it keeps the audit row and the
 * visible comment identical instead of leaving the auditor guessing.
 */
export async function postTicketReply(
  requestId: string,
  action: ReplyAction,
  comment: string,
  reference: string,
  signal?: AbortSignal,
): Promise<ActOnApprovalResult> {
  const rows = await rpcAudited(
    ACT_ON_APPROVAL_FN,
    { p_request_id: requestId, p_action: action, p_comment: comment, p_payload: {} },
    actOnApprovalResultSchema,
    { reason: comment, ...(signal ? { signal } : {}) },
  );
  return firstRowOrThrow(rows, reference);
}

/**
 * Withdraw the request (`recall`).
 *
 * The engine refuses this for anybody but the requester, refuses it when
 * `request_types.allows_withdrawal` is false, and refuses it once the request has
 * been decided. The screen only offers the button when all three would pass, but
 * the server is the one that decides — the button is an affordance, not the check.
 */
export async function withdrawTicket(
  requestId: string,
  reason: string,
  reference: string,
  signal?: AbortSignal,
): Promise<ActOnApprovalResult> {
  const rows = await rpcAudited(
    ACT_ON_APPROVAL_FN,
    { p_request_id: requestId, p_action: "recall", p_comment: reason, p_payload: {} },
    actOnApprovalResultSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
  return firstRowOrThrow(rows, reference);
}
