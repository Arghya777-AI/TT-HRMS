/**
 * history.api.ts — E-07 Tab 8: change requests + own-record history.
 *
 * READ THIS BEFORE CHANGING THE SOURCES — the spec asks for
 * `v_my_record_history` over `audit_events`. Neither exists in the deployed
 * database, and the nearest relation is NOT usable by an employee:
 *
 *   * `v_my_record_history`      — no such view in migrations 033–037.
 *   * `v_audit_trail_employee`   — exists (037) but is declared
 *     `security_invoker = true` over `public.audit_log`, whose only SELECT
 *     policy is `audit_log__admin_read USING (app.is_admin())` (006). An
 *     employee reading it gets zero rows for a reason that is NOT "nothing
 *     happened". Querying it here would manufacture exactly the lie this build
 *     exists to remove: a confident empty state over withheld data.
 *
 * So Card 8.2 is assembled from the two relations an employee genuinely owns,
 * both of which carry a real From → To pair:
 *
 *   1. `employee_change_requests` where `applied_at IS NOT NULL` — every field
 *      change that actually landed, with `old_value` / `new_value` jsonb.
 *   2. `employee_lifecycle_events` — RLS `ele__scope_read USING
 *      (app.can_see_employee(employee_id))`, so self-readable; `from_values` /
 *      `to_values` jsonb plus a mandatory `reason` (CHECK length ≥ 10).
 *
 * Card 8.3 adds `v_my_data_access` — owner-executed and pinned to
 * `app.current_employee_id()` (037), the statutory "who read my data" surface
 * and the place a PAN/bank reveal shows up.
 *
 * Attribution ("HR on your behalf"): `employee_change_requests.requested_by` is
 * a `profiles.id`. Comparing it to the signed-in user's own profile id is how a
 * request the employee raised is told apart from one HR raised for them. Names
 * of OTHER actors are not resolvable — `profiles` grants employees
 * `profiles__self_read USING (id = app.ctx_actor_id())` only — so the UI
 * attributes by ROLE, never by a fabricated name.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  eq,
  selectMany,
} from "@/shared/api/query";
import { insertOne } from "@/shared/api/write";

export const CHANGE_REQUESTS_TABLE = "employee_change_requests";
export const LIFECYCLE_EVENTS_TABLE = "employee_lifecycle_events";
export const MY_DATA_ACCESS_VIEW = "v_my_data_access";

export const approvalStatusSchema = z.enum([
  "draft", "pending", "in_progress", "approved", "rejected", "cancelled",
  "withdrawn", "expired", "auto_approved", "escalated", "applied", "failed",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** Statuses that still hold the request open — the ones offering `[Withdraw]`. */
export const OPEN_CHANGE_REQUEST_STATUSES: readonly ApprovalStatus[] = [
  "draft", "pending", "in_progress", "escalated",
];

// -----------------------------------------------------------------------------
// 1. Card 8.1 — profile change requests (the maker-checker queue)
// -----------------------------------------------------------------------------

export const changeRequestSchema = z.object({
  id: dbUuid,
  entity_table: z.string(),
  field_name: z.string(),
  /** Already human in the DB (NOT NULL) — never a column name on screen. */
  field_label: z.string(),
  /** jsonb: a scalar for most fields, an object for composite ones. */
  old_value: z.unknown().nullable(),
  new_value: z.unknown(),
  is_sensitive: z.boolean(),
  status: approvalStatusSchema,
  requested_by: dbUuid,
  requested_at: dbTimestamp,
  decided_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
  applied_at: dbTimestampNullable,
  apply_error: z.string().nullable(),
  effective_from: dbDateNullable,
});

export type ChangeRequest = z.infer<typeof changeRequestSchema>;

const CHANGE_REQUEST_COLUMNS =
  "id, entity_table, field_name, field_label, old_value, new_value, is_sensitive, " +
  "status, requested_by, requested_at, decided_at, decision_comment, applied_at, " +
  "apply_error, effective_from";

/** Every change request on the caller's record, newest first. */
export async function fetchChangeRequests(
  employeeId: string,
  signal?: AbortSignal,
): Promise<ChangeRequest[]> {
  return selectMany(CHANGE_REQUESTS_TABLE, changeRequestSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "requested_at", ascending: false }],
    columns: CHANGE_REQUEST_COLUMNS,
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The self-service field-change path, and the ONLY way a client changes a
 * whitelisted `employees` column.
 *
 * An employee cannot write the column directly: migration 048 does
 * `REVOKE UPDATE ON public.employees FROM authenticated` and re-grants only
 * `(about, photo_path, cover_photo_path, food_preference)`, and
 * `employees_self_edit_guard` raises `42501 self_edit_not_allowed: change % via
 * a profile change request` for anything outside that four. `mobile`,
 * `date_of_birth`, the name fields and the rest of
 * `public.employee_changeable_fields()` are reachable ONLY as a row here, which
 * `ecr_insert_guard` forces to `status='pending'` with the decision columns
 * nulled — so this proposes a change, it never applies one. HR's approval runs
 * `public.apply_change_request()`, which holds the pen.
 *
 * `employee_change_requests` is not in `audit.reason_required_tables`, so
 * `insertOne` is the correct helper and NO `X-Reason` is sent. That is the point:
 * a reason on a sensitive field belongs to the approver who decides, and
 * inventing one here would forge it. `field_label` is the human name shown in
 * the approval queue and on the employee's own history tab.
 */
export interface SelfChangeRequestInput {
  readonly employeeId: string;
  /** `profiles.id` of the signed-in user — `ecr__self_insert` checks it. */
  readonly requestedBy: string;
  readonly entityTable: string;
  readonly fieldName: string;
  /** Human field name, e.g. "Mobile number" — never the column name. */
  readonly fieldLabel: string;
  readonly oldValue?: unknown;
  readonly newValue: unknown;
}

export async function submitSelfChangeRequest(
  input: SelfChangeRequestInput,
  signal?: AbortSignal,
): Promise<ChangeRequest> {
  return insertOne(
    CHANGE_REQUESTS_TABLE,
    changeRequestSchema,
    {
      employee_id: input.employeeId,
      requested_by: input.requestedBy,
      entity_table: input.entityTable,
      field_name: input.fieldName,
      field_label: input.fieldLabel,
      old_value: input.oldValue ?? null,
      new_value: input.newValue,
    },
    { columns: CHANGE_REQUEST_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 2. Card 8.2 source B — employment lifecycle events
// -----------------------------------------------------------------------------

export const lifecycleEventTypeSchema = z.enum([
  "offer_accepted", "joined", "probation_started", "confirmed",
  "probation_extended", "promoted", "transferred", "department_changed",
  "manager_changed", "salary_revised", "suspended", "reinstated",
  "notice_started", "resigned", "terminated", "absconded", "retired",
  "contract_ended", "rehired", "deceased",
]);
export type LifecycleEventType = z.infer<typeof lifecycleEventTypeSchema>;

export const lifecycleEventSchema = z.object({
  id: dbUuid,
  event_type: lifecycleEventTypeSchema,
  effective_date: dbDate,
  recorded_at: dbTimestamp,
  /** A `profiles.id` — only ever an admin's, since only admins may insert. */
  recorded_by: dbUuid,
  reason: z.string(),
  from_values: z.unknown().nullable(),
  to_values: z.unknown().nullable(),
  is_reversed: z.boolean(),
});

export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

export async function fetchLifecycleEvents(
  employeeId: string,
  signal?: AbortSignal,
): Promise<LifecycleEvent[]> {
  return selectMany(LIFECYCLE_EVENTS_TABLE, lifecycleEventSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "effective_date", ascending: false }, { column: "recorded_at", ascending: false }],
    columns:
      "id, event_type, effective_date, recorded_at, recorded_by, reason, " +
      "from_values, to_values, is_reversed",
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Card 8.3 — who read my details
// -----------------------------------------------------------------------------

/**
 * `accessed_by` is resolved to a NAME by the view itself (it joins `profiles`
 * while running as owner), so this is the one place an employee legitimately
 * sees another actor's name. `purpose` is the written reason the reveal
 * function demanded before it returned anything.
 */
export const dataAccessSchema = z.object({
  id: dbUuid,
  accessed_at: dbTimestamp,
  accessed_by: z.string(),
  actor_role: z.string().nullable(),
  actor_source: z.string().nullable(),
  entity_table: z.string(),
  fields: z.array(z.string()).nullable(),
  access_kind: z.string(),
  purpose: z.string().nullable(),
  record_count: dbInt,
});

export type DataAccessEntry = z.infer<typeof dataAccessSchema>;

export async function fetchMyDataAccess(signal?: AbortSignal): Promise<DataAccessEntry[]> {
  return selectMany(MY_DATA_ACCESS_VIEW, dataAccessSchema, {
    order: [{ column: "accessed_at", ascending: false }],
    columns:
      "id, accessed_at, accessed_by, actor_role, actor_source, entity_table, " +
      "fields, access_kind, purpose, record_count",
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. The unified record-history row
// -----------------------------------------------------------------------------

export type HistoryOrigin = "change_request" | "lifecycle_event";

/** Who caused a change, at the granularity the data can actually support. */
export type HistoryActor = "you" | "hr_on_your_behalf" | "hr" | "system";

export interface RecordHistoryEntry {
  readonly id: string;
  readonly origin: HistoryOrigin;
  /** The instant to display — always through fmtDateTime (IST suffix). */
  readonly occurredAt: string;
  /** Human label of what changed. */
  readonly what: string;
  /** jsonb before-value; null/absent renders "(not set)". */
  readonly from: unknown;
  readonly to: unknown;
  readonly actor: HistoryActor;
  readonly reason: string | null;
  /** True when the change was recorded but later reversed by a new event. */
  readonly reversed: boolean;
}

/**
 * Merge the two readable sources into one reverse-chronological history.
 *
 * `myProfileId` is the signed-in user's `profiles.id`. When a change request was
 * raised by someone else, the change is attributed "HR on your behalf" — the
 * assisted-mode case (spec-employee E-01: HR acts for kiosk-only staff), which
 * the reference product rendered indistinguishably from a self-edit.
 */
export function buildRecordHistory(
  changeRequests: readonly ChangeRequest[],
  lifecycleEvents: readonly LifecycleEvent[],
  myProfileId: string | null,
  labelForEvent: (event: LifecycleEvent) => string,
): RecordHistoryEntry[] {
  const applied: RecordHistoryEntry[] = changeRequests
    .filter((cr) => cr.applied_at !== null)
    .map((cr) => ({
      id: `cr-${cr.id}`,
      origin: "change_request" as const,
      occurredAt: cr.applied_at ?? cr.requested_at,
      what: cr.field_label,
      from: cr.old_value,
      to: cr.new_value,
      actor:
        myProfileId !== null && cr.requested_by === myProfileId
          ? ("you" as const)
          : ("hr_on_your_behalf" as const),
      reason: cr.decision_comment,
      reversed: false,
    }));

  const lifecycle: RecordHistoryEntry[] = lifecycleEvents.map((ev) => ({
    id: `ele-${ev.id}`,
    origin: "lifecycle_event" as const,
    occurredAt: ev.recorded_at,
    what: labelForEvent(ev),
    from: ev.from_values,
    to: ev.to_values,
    actor: "hr" as const,
    reason: ev.reason,
    reversed: ev.is_reversed,
  }));

  return [...applied, ...lifecycle].sort((a, b) =>
    a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
  );
}

// -----------------------------------------------------------------------------
// 5. Withdraw an open request
// -----------------------------------------------------------------------------

/**
 * There is no self-UPDATE policy on `employee_change_requests` — migration 011
 * grants the employee `ecr__self_read` and `ecr__self_insert` only, and every
 * decision column is server-owned. Withdrawal therefore is NOT a client write;
 * this constant records that fact for the page, which renders the honest route
 * (Help Desk) instead of a button that would fail with `42501`.
 */
export const WITHDRAW_IS_SERVER_ONLY = true;

/** Exported for the hook's "still open" filter without re-deriving the list. */
export function isOpenChangeRequest(status: ApprovalStatus): boolean {
  return OPEN_CHANGE_REQUEST_STATUSES.includes(status);
}
