/**
 * leave-apply.api.ts — the reads and writes E-05.4 (apply), E-05.6 (calendar),
 * E-05.7 (detail) and E-06 (comp-off) need on top of `leave.api.ts`.
 *
 * THE SERVER PREVIEW (spec E-05: "cannot submit without preview loaded")
 * ---------------------------------------------------------------------
 * `rpc_leave_preview()` named in the spec is NOT deployed — there is no such
 * function in migrations 019 or 033–037, and no leave edge function. What IS
 * deployed is the same computation under a different door:
 *
 *   1. INSERT a `leave_requests` row with `status='draft'`
 *      (RLS `leave_requests__self_insert` permits exactly this).
 *   2. `calc_leave_days(request_id)` — SECURITY DEFINER, granted to
 *      `authenticated` (019 line 1466). It calls `rebuild_leave_request_days`,
 *      which resolves the employee's holiday calendar and weekly-off rule for
 *      EVERY date in the range and writes one `leave_request_days` row per date
 *      with `is_holiday`, `is_weekly_off`, `is_counted`, `day_value`, then
 *      stamps `total_days` / `paid_days` / `unpaid_days` on the request.
 *   3. SELECT those rows back.
 *
 * That is the per-date allocation the spec asks for, computed by the same
 * function the submit guard re-runs at submit time — so the preview cannot
 * disagree with what is actually recorded. The client contributes no arithmetic:
 * `day_value`, `total_days`, `paid_days` and `unpaid_days` are all read.
 *
 * The draft is REUSED, never accumulated: `authenticated` has no DELETE grant on
 * `leave_requests` (migration 048 revokes DELETE across `public`), so the apply
 * form finds the employee's existing draft and rewrites it instead of leaving a
 * trail of abandoned rows. A draft holds no balance — `pending_days` moves only
 * on the transition to `pending`.
 */
import { z } from "zod";
import {
  QueryError,
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumeric,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  lte,
  rpcMany,
  rpcOne,
  selectMany,
  selectOne,
  type Filter,
} from "@/shared/api/query";
import { insertOne, updateOne } from "@/shared/api/write";
import { istToday, nowInstantIso } from "@/lib/datetime";
import {
  fetchLeaveRequest,
  leaveDayPortionSchema,
  LEAVE_REQUESTS_TABLE,
  type LeaveRequest,
} from "./leave.api";

export const LEAVE_TYPES_TABLE = "leave_types";
export const LEAVE_REQUEST_DAYS_TABLE = "leave_request_days";
export const APPROVAL_REQUESTS_TABLE = "approval_requests";
export const APPROVAL_ACTIONS_TABLE = "approval_actions";
export const HOLIDAYS_TABLE = "holidays";
export const EMPLOYEE_REF_VIEW = "v_employee_ref";
export const MY_EMPLOYEE_VIEW = "v_my_employee";
export const CALC_LEAVE_DAYS_FN = "calc_leave_days";

export type LeaveDayPortion = z.infer<typeof leaveDayPortionSchema>;

// -----------------------------------------------------------------------------
// 1. leave_types — the rulebook the form explains (never enforces alone)
// -----------------------------------------------------------------------------

/**
 * The subset of `leave_types` (019 §1) the apply form needs to TELL the user
 * what the rules are. Enforcement is `leave_requests_submit_guard`; these
 * columns exist so the form can say "3 consecutive days maximum for Casual
 * Leave" before the server says it, not instead of.
 *
 * `leave_types` is readable by `authenticated` for active rows
 * (`leave_types__ref_read`).
 */
export const leaveTypeRuleSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: dbInt,
  is_paid: z.boolean(),
  is_comp_off: z.boolean(),
  unit: z.string(),
  allow_half_day: z.boolean(),
  min_days_per_request: dbNumeric,
  max_days_per_request: dbNumericNullable,
  max_consecutive_days: dbNumericNullable,
  min_notice_days: dbInt,
  max_backdated_days: dbInt,
  requires_document_after_days: dbNumericNullable,
  availing_allowed_during_probation: z.boolean(),
  allow_negative_balance: z.boolean(),
  max_negative_days: dbNumeric,
  count_weekly_off_as_leave: z.boolean(),
  count_holiday_as_leave: z.boolean(),
  min_service_months: dbInt,
  max_times_in_service: dbIntNullable,
  /** NULL = every employment type. Otherwise an allowlist. */
  applies_to_employment_types: z.array(z.string()).nullable(),
  gender_restriction: z.string().nullable(),
  colour_hex: z.string().nullable(),
  /**
   * False when this type must be taken ALONE — a combined application may not mix it with
   * any other type. Added by migration 039700 for Sick Leave. A property of the type, so
   * the allocation form never names a code.
   */
  allows_combination: z.boolean(),
  /*
    ── THE TWO 041600 COLUMNS ARE OPTIONAL, AND THAT IS DELIBERATE ────────────

    A deployment's database can be BEHIND its browser — the code ships to Vercel
    the moment it is pushed, and a migration is applied by hand afterwards. When
    these two were required, the whole apply screen died on
    "column leave_types.requires_reason does not exist": PostgREST refuses the
    entire query if one name in the select list is unknown, so one pending
    migration took out every leave type, every balance and the form.

    Optional with a default means the screen degrades to the OLD behaviour
    instead of to a red box, and picks up the real values the moment the
    migration lands — with no second deploy.

    THE DEFAULT IS `true`, NOT `false`, AND THAT IS THE WHOLE POINT. A database
    without this column is a database that still carries `ck_lr__reason`, which
    demands ten characters on EVERY leave request. Defaulting to "no reason
    needed" would produce a form that cheerfully submits and a server that
    refuses it — worse than the error box, because the employee would have typed
    the whole application first. The absent column means the old rule, so the old
    rule is what the form asks for.

    This is also why the read below no longer names its columns. An explicit
    list cannot express "this one if you have it".
  */
  requires_reason: z.boolean().optional().default(true),
  max_days_per_month: dbNumericNullable.optional().default(null),
});

export type LeaveTypeRule = z.infer<typeof leaveTypeRuleSchema>;

/*
  No explicit column list, on purpose — see the note on `requires_reason` above.
  `leave_types` is a dozen rows of configuration read once and cached for five
  minutes, so the handful of extra columns costs nothing, and the schema above is
  still what decides which of them this module can see.
*/

/** Active leave types, in the order the admin console assigned them. */
export async function fetchLeaveTypeRules(signal?: AbortSignal): Promise<LeaveTypeRule[]> {
  return selectMany(LEAVE_TYPES_TABLE, leaveTypeRuleSchema, {
    filters: [eq("is_active", true)],
    order: [
      { column: "sort_order", ascending: true },
      { column: "code", ascending: true },
    ],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. My employment context — probation is SHOWN, not silently blocked (§4)
// -----------------------------------------------------------------------------

/**
 * The employment facts that change what the leave screens may offer:
 * probation (EL accrues but cannot be availed until confirmation),
 * the holiday calendar the range preview resolves against, and the department
 * the concurrency notice would apply to.
 *
 * `v_my_employee` is pinned to `app.current_employee_id()`; a narrow projection
 * keeps this read off every PII column of `SELECT e.*`.
 */
export const myLeaveContextSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  employment_status: z.string(),
  employment_type: z.string(),
  /** Read only to hide leave types with a `gender_restriction` the user fails. */
  gender: z.string().nullable(),
  date_of_join: dbDateNullable,
  confirmation_due_date: dbDateNullable,
  confirmed_on: dbDateNullable,
  holiday_calendar_id: dbUuidNullable,
  weekly_off_rule_id: dbUuidNullable,
  department_id: dbUuidNullable,
  mobile: z.string().nullable(),
});

export type MyLeaveContext = z.infer<typeof myLeaveContextSchema>;

const MY_LEAVE_CONTEXT_COLUMNS =
  "id, employee_code, display_name, employment_status, employment_type, gender, " +
  "date_of_join, confirmation_due_date, confirmed_on, holiday_calendar_id, " +
  "weekly_off_rule_id, department_id, mobile";

/**
 * `null` = no employee record (kiosk-only account) → no-permission state.
 *
 * ── WHY `holiday_calendar_id` IS RESOLVED AND NOT JUST READ ──────────────────
 * The column on `employees` is NULL for 80 of the venue's 83 people; only three rows ever had
 * one set. Every consumer that read it straight off the row therefore got NULL, and the leave
 * calendar's `useHolidaysInWindow` is `enabled: calendarId.length > 0` — so for almost everybody
 * the holiday query never ran at all and the calendar showed no holidays. There are nineteen
 * defined, seven of them still ahead.
 *
 * `resolve_policy` is the system's own answer and it resolves for all 83, because a calendar
 * assigned at COMPANY scope covers everyone without being copied onto each row. Migration
 * 20260801040000 wrote this rule down after the same mistake — "THE ROTA IS RESOLVED, NOT READ
 * OFF THE EMPLOYEE" — and this path had not been brought in line with it.
 *
 * The row's own value still wins when it is set, so a per-employee override keeps working.
 */
export async function fetchMyLeaveContext(signal?: AbortSignal): Promise<MyLeaveContext | null> {
  const row = await selectOne(MY_EMPLOYEE_VIEW, myLeaveContextSchema, [], {
    columns: MY_LEAVE_CONTEXT_COLUMNS,
    ...(signal ? { signal } : {}),
  });
  if (row === null || row.holiday_calendar_id !== null) return row;

  /*
    A resolver failure must not take the whole leave screen down: without a calendar the page
    renders every other thing it knows and simply shows no holidays, which is the behaviour that
    existed before this call. So the fallback is the unresolved row, not an exception.
  */
  try {
    const resolved = await rpcOne(
      "resolve_policy",
      { p_kind: "holiday_calendar", p_employee_id: row.id, p_date: istToday() },
      z.string().uuid().nullable(),
      { ...(signal ? { signal } : {}) },
    );
    return resolved === null ? row : { ...row, holiday_calendar_id: resolved };
  } catch {
    return row;
  }
}

/**
 * Is this employee's department an operational one?
 *
 * `leave_requests_submit_guard` refuses a request with no
 * `handover_to_employee_id` when it is — "handover_to_employee_id is mandatory
 * for operational departments", which is the sentence people were getting AFTER
 * filling the whole form. The form can ask first: `departments` is readable by
 * every signed-in user (`departments__all_read__select`), so this is one small
 * read rather than a rule the browser has to guess at.
 *
 * `null` department means the question does not apply — not that the answer is
 * yes. Refusing to submit because we could not read a flag would be worse than
 * letting the server say so.
 */
export async function fetchDepartmentIsOperational(
  departmentId: string | null,
  signal?: AbortSignal,
): Promise<boolean> {
  if (departmentId === null) return false;
  const row = await selectOne(
    "departments",
    z.object({ is_operational: z.boolean() }),
    [eq("id", departmentId)],
    signal ? { signal } : {},
  );
  return row?.is_operational ?? false;
}

/** True when this type may not be availed yet because the employee is on probation. */
export function isProbationLocked(rule: LeaveTypeRule, ctx: MyLeaveContext | null): boolean {
  if (ctx === null) return false;
  if (rule.availing_allowed_during_probation) return false;
  return ctx.employment_status === "on_probation";
}

/**
 * The structural eligibility gates `leave_requests_submit_guard` applies to
 * everyone — employment type and gender restriction. Mirrored here so the form
 * does not OFFER a type the server will certainly refuse; the server remains the
 * only thing that decides. Probation is deliberately NOT a gate: spec §4 says it
 * is shown, not silently blocked.
 */
export function isEligibleLeaveType(rule: LeaveTypeRule, ctx: MyLeaveContext | null): boolean {
  if (ctx === null) return true;
  const types = rule.applies_to_employment_types;
  if (types !== null && types.length > 0 && !types.includes(ctx.employment_type)) return false;
  if (rule.gender_restriction !== null && ctx.gender !== rule.gender_restriction) return false;
  return true;
}

// -----------------------------------------------------------------------------
// 3. leave_request_days — the per-date allocation
// -----------------------------------------------------------------------------

/** Mirrors `leave_request_days` (019 §3). Written only by the server. */
export const leaveRequestDaySchema = z.object({
  id: dbUuid,
  leave_request_id: dbUuid,
  leave_date: dbDate,
  portion: leaveDayPortionSchema,
  /** 0.000 / 0.500 / 1.000 — the days this date deducts. Server-computed. */
  day_value: dbNumeric,
  is_holiday: z.boolean(),
  is_weekly_off: z.boolean(),
  /** false = the date falls inside the leave but deducts nothing. */
  is_counted: z.boolean(),
  status: z.string(),
});

export type LeaveRequestDay = z.infer<typeof leaveRequestDaySchema>;

/** Why a date inside the range deducts nothing. Spec E-05 `reason_skipped`. */
export type LeaveSkipReason = "weekly_off" | "holiday" | "already_leave";

/**
 * The allocation row as the screens render it: the server row plus the
 * `reason_skipped` label E-05 specifies.
 *
 * This is a re-LABELLING of booleans the server already decided
 * (`is_counted`, `is_holiday`, `is_weekly_off`) — not a computation. No fraction,
 * total or balance is derived here; `day_value` is read as-is.
 */
export interface LeaveAllocationDay extends LeaveRequestDay {
  readonly reason_skipped: LeaveSkipReason | null;
}

function withSkipReason(day: LeaveRequestDay): LeaveAllocationDay {
  if (day.is_counted) return { ...day, reason_skipped: null };
  if (day.is_holiday) return { ...day, reason_skipped: "holiday" };
  if (day.is_weekly_off) return { ...day, reason_skipped: "weekly_off" };
  return { ...day, reason_skipped: "already_leave" };
}

/** Every date of one request, earliest first. */
export async function fetchLeaveAllocation(
  requestId: string,
  signal?: AbortSignal,
): Promise<LeaveAllocationDay[]> {
  const rows = await selectMany(LEAVE_REQUEST_DAYS_TABLE, leaveRequestDaySchema, {
    filters: [eq("leave_request_id", requestId)],
    order: [{ column: "leave_date", ascending: true }],
    limit: 400,
    ...(signal ? { signal } : {}),
  });
  return rows.map(withSkipReason);
}

// -----------------------------------------------------------------------------
// 4. The server preview: draft → calc_leave_days → read back
// -----------------------------------------------------------------------------

/** Placeholder that satisfies `ck_lr__reason` (≥10 chars) while still a draft. */
const DRAFT_REASON_PLACEHOLDER = "Draft — reason not entered yet";

export interface LeavePreviewInput {
  readonly employeeId: string;
  readonly leaveTypeId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly portion: LeaveDayPortion;
  /** The user's reason so far; the placeholder is used until it is long enough. */
  readonly reason: string;
}

export interface LeavePreview {
  readonly requestId: string;
  readonly requestNumber: string;
  /** `leave_requests.total_days`, stamped by `calc_leave_days`. */
  readonly totalDays: number;
  readonly paidDays: number;
  readonly unpaidDays: number;
  readonly days: readonly LeaveAllocationDay[];
  /** The instant this preview was read, for the "as at" line. */
  readonly readAt: string;
}

const draftIdentitySchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  status: z.string(),
});

/** The employee's reusable draft, if one already exists. */
async function fetchMyDraftRequest(
  employeeId: string,
  signal?: AbortSignal,
): Promise<{ id: string; request_number: string; status: string } | null> {
  return selectOne(
    LEAVE_REQUESTS_TABLE,
    draftIdentitySchema,
    [eq("employee_id", employeeId), eq("status", "draft")],
    {
      columns: "id, request_number, status",
      order: [{ column: "created_at", ascending: false }],
      ...(signal ? { signal } : {}),
    },
  );
}

function draftValues(input: LeavePreviewInput): Record<string, unknown> {
  const reason = input.reason.trim();
  return {
    leave_type_id: input.leaveTypeId,
    from_date: input.fromDate,
    to_date: input.toDate,
    portion: input.portion,
    reason: reason.length >= 10 ? reason : DRAFT_REASON_PLACEHOLDER,
  };
}

/**
 * Ask the server for the per-date allocation of a not-yet-submitted request.
 *
 * Returns the draft id as well, so submitting is a status transition on the very
 * row that was previewed — the preview and the submission cannot drift apart.
 */
export async function previewLeaveRequest(
  input: LeavePreviewInput,
  signal?: AbortSignal,
): Promise<LeavePreview> {
  const existing = await fetchMyDraftRequest(input.employeeId, signal);
  const draft =
    existing === null
      ? await insertOne(
          LEAVE_REQUESTS_TABLE,
          draftIdentitySchema,
          { employee_id: input.employeeId, status: "draft", ...draftValues(input) },
          { columns: "id, request_number, status", ...(signal ? { signal } : {}) },
        )
      : await updateOne(
          LEAVE_REQUESTS_TABLE,
          draftIdentitySchema,
          draftValues(input),
          { id: existing.id },
          { columns: "id, request_number, status", ...(signal ? { signal } : {}) },
        );

  // The server expands the range: holidays and weekly offs per THIS employee's
  // calendar and rule, half-day portions, and the day_value of each date.
  await rpcOne(
    CALC_LEAVE_DAYS_FN,
    { p_leave_request_id: draft.id },
    dbNumeric,
    signal ? { signal } : {},
  );

  const [request, days] = await Promise.all([
    fetchLeaveRequest(draft.id, signal),
    fetchLeaveAllocation(draft.id, signal),
  ]);

  return {
    requestId: draft.id,
    requestNumber: draft.request_number,
    // Read, never derived: calc_leave_days stamped these three columns.
    totalDays: request?.total_days ?? 0,
    paidDays: request?.paid_days ?? 0,
    unpaidDays: request?.unpaid_days ?? 0,
    days,
    readAt: nowInstantIso(),
  };
}

export interface SubmitLeaveInput {
  /** The id returned by `previewLeaveRequest` — submission is never blind. */
  readonly requestId: string;
  readonly reason: string;
  readonly contactDuringLeave: string | null;
  readonly handoverToEmployeeId: string | null;
  readonly handoverNotes: string | null;
  /** Tick "take the excess as loss of pay"; the server clamps it to total_days. */
  readonly unpaidDays: number | null;
}

/**
 * draft → pending. Every rule (V1–V20: notice, max consecutive, overlap,
 * backdating, probation, balance, gender/employment-type eligibility, document
 * requirement) is checked by `leave_requests_submit_guard` inside this one
 * UPDATE, and the day expansion is recomputed from the submitted values. A
 * rejection arrives as `QueryError{kind:'conflict'}` carrying the server's own
 * sentence.
 */
export async function submitLeaveRequest(
  input: SubmitLeaveInput,
  signal?: AbortSignal,
): Promise<LeaveRequest> {
  const values: Record<string, unknown> = {
    status: "pending",
    reason: input.reason.trim(),
    contact_during_leave: input.contactDuringLeave,
    handover_to_employee_id: input.handoverToEmployeeId,
    handover_notes: input.handoverNotes,
  };
  if (input.unpaidDays !== null) values["unpaid_days"] = input.unpaidDays;
  try {
    await updateOne(LEAVE_REQUESTS_TABLE, draftIdentitySchema, values, { id: input.requestId }, {
      columns: "id, request_number, status",
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    // Replay: the row is already out of `draft|pending`, so the RLS USING clause
    // no longer matches and PostgREST updates nothing. That is the table-path
    // equivalent of a 409 idempotent replay — if the request did move to
    // `pending`, the submit succeeded and the UI must treat it as success
    // (frontend-contract §5). Anything else rethrows.
    if (!(e instanceof QueryError) || e.kind !== "not_found") throw e;
    const replayed = await fetchLeaveRequest(input.requestId, signal);
    if (replayed === null || replayed.status === "draft") throw e;
    return replayed;
  }
  const request = await fetchLeaveRequest(input.requestId, signal);
  if (request === null) {
    throw new QueryError(
      LEAVE_REQUESTS_TABLE,
      "not_found",
      "The request was submitted but is no longer readable.",
    );
  }
  return request;
}

/**
 * Withdraw a request that has not been decided yet. RLS permits the
 * `draft|pending → withdrawn` transition for the owner
 * (`leave_requests__self_update`), and `leave_requests_apply_ledger` releases
 * the reserved days.
 */
export async function withdrawLeaveRequest(
  requestId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  await updateOne(
    LEAVE_REQUESTS_TABLE,
    draftIdentitySchema,
    { status: "withdrawn", cancellation_reason: reason.trim() },
    { id: requestId },
    { columns: "id, request_number, status", ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 5. Approval trail (E-05.7)
// -----------------------------------------------------------------------------

export const approvalRequestSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  detail_table: z.string(),
  detail_id: dbUuid,
  status: z.string(),
  current_level: dbInt,
  total_levels: dbInt,
  submitted_at: dbTimestamp,
  sla_due_at: dbTimestamp,
  first_action_at: dbTimestampNullable,
  decided_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
  escalated_at: dbTimestampNullable,
  cancelled_at: dbTimestampNullable,
  cancellation_reason: z.string().nullable(),
});

export type ApprovalRequestRow = z.infer<typeof approvalRequestSchema>;

export const approvalActionSchema = z.object({
  id: dbUuid,
  approval_request_id: dbUuid,
  level: dbInt,
  actor_id: dbUuidNullable,
  actor_role: z.string().nullable(),
  acted_as: z.string().nullable(),
  action: z.string(),
  comment: z.string().nullable(),
  acted_at: dbTimestamp,
});

export type ApprovalActionRow = z.infer<typeof approvalActionSchema>;

/** Directory-safe label for a person, resolved from a `profiles.id`. */
export const employeeRefSchema = z.object({
  id: dbUuid,
  profile_id: dbUuidNullable,
  employee_code: z.string(),
  display_name: z.string(),
  designation_name: z.string().nullable(),
});

export type EmployeeRef = z.infer<typeof employeeRefSchema>;

export interface ApprovalTrail {
  readonly request: ApprovalRequestRow | null;
  readonly actions: readonly ApprovalActionRow[];
  /** `profiles.id` → the person, so a decision is attributed by name + role. */
  readonly actors: ReadonlyMap<string, EmployeeRef>;
}

/**
 * The decision trail of one leave request.
 *
 * `approval_requests` is visible to the subject (`ar__self_read`) and
 * `approval_actions` inherits that audience. Actor names come from
 * `v_employee_ref` keyed by `profile_id` — `profiles` itself is self-only, so a
 * name+role attribution (DR-23/DR-53) has to be resolved through the directory
 * view rather than an embedded join.
 *
 * `request === null` is normal: the deployed workflow only materialises an
 * `approval_requests` row when a chain is configured for the type. The screen
 * then falls back to the decision columns on `leave_requests` itself.
 */
export async function fetchApprovalTrail(
  leaveRequestId: string,
  signal?: AbortSignal,
): Promise<ApprovalTrail> {
  const request = await selectOne(
    APPROVAL_REQUESTS_TABLE,
    approvalRequestSchema,
    [eq("detail_table", "leave_requests"), eq("detail_id", leaveRequestId)],
    {
      order: [{ column: "submitted_at", ascending: false }],
      ...(signal ? { signal } : {}),
    },
  );
  if (request === null) return { request: null, actions: [], actors: new Map() };

  const actions = await selectMany(APPROVAL_ACTIONS_TABLE, approvalActionSchema, {
    filters: [eq("approval_request_id", request.id)],
    order: [
      { column: "level", ascending: true },
      { column: "acted_at", ascending: true },
    ],
    limit: 100,
    ...(signal ? { signal } : {}),
  });

  const profileIds = [...new Set(actions.map((a) => a.actor_id).filter((v): v is string => v !== null))];
  const actors = new Map<string, EmployeeRef>();
  if (profileIds.length > 0) {
    const refs = await selectMany(EMPLOYEE_REF_VIEW, employeeRefSchema, {
      filters: [inList("profile_id", profileIds)],
      limit: 100,
      columns: "id, profile_id, employee_code, display_name, designation_name",
      ...(signal ? { signal } : {}),
    });
    for (const ref of refs) if (ref.profile_id !== null) actors.set(ref.profile_id, ref);
  }
  return { request, actions, actors };
}

// -----------------------------------------------------------------------------
// 6. Holidays in a window (E-05.6)
// -----------------------------------------------------------------------------

/**
 * `holidays` (014) narrowed to what a calendar cell renders. Deliberately a
 * local projection rather than an import from `home.api`: `home.api` imports
 * `leave.api`, and reaching back into it from the leave feature would make the
 * leave chunk pull the home chunk's graph.
 *
 * Department/location narrowing is not applied client-side — `applies_to_*` are
 * "everyone when null" arrays and applicability is engine logic. The per-date,
 * per-employee truth is `is_holiday` on the allocation/attendance rows.
 */
export const calendarHolidaySchema = z.object({
  id: dbUuid,
  holiday_date: dbDate,
  name: z.string(),
  holiday_type: z.string(),
  is_optional: z.boolean(),
  compensatory_off_if_worked: z.boolean(),
});

export type CalendarHoliday = z.infer<typeof calendarHolidaySchema>;

export interface HolidayWindow {
  readonly holidayCalendarId: string;
  readonly from: string;
  readonly to: string;
}

export async function fetchHolidaysInWindow(
  w: HolidayWindow,
  signal?: AbortSignal,
): Promise<CalendarHoliday[]> {
  const filters: Filter[] = [
    eq("holiday_calendar_id", w.holidayCalendarId),
    eq("is_active", true),
    gte("holiday_date", w.from),
    lte("holiday_date", w.to),
  ];
  return selectMany(HOLIDAYS_TABLE, calendarHolidaySchema, {
    filters,
    order: [{ column: "holiday_date", ascending: true }],
    limit: 60,
    columns: "id, holiday_date, name, holiday_type, is_optional, compensatory_off_if_worked",
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 8. Colleagues an employee can name — handover, and peers to mention
// -----------------------------------------------------------------------------

/**
 * The people this employee may name on a leave application.
 *
 * `v_employee_ref` is the one employee-readable roster: it filters archived and non-active
 * staff itself, and it publishes name, code and designation only — no PII. That is exactly
 * the shape a "who is covering for me" picker needs, and it is why the handover field can be
 * offered to an employee at all without a new grant.
 *
 * SELF IS EXCLUDED BY THE CALLER, not here, because the same list serves the handover picker
 * (where naming yourself is meaningless) and any future mention list (where it is merely
 * redundant). Filtering in one place and not the other would be the kind of difference nobody
 * remembers.
 */
export async function fetchColleagues(
  limit = 300,
  signal?: AbortSignal,
): Promise<EmployeeRef[]> {
  return selectMany(EMPLOYEE_REF_VIEW, employeeRefSchema, {
    order: [{ column: "display_name", ascending: true }],
    columns: "id, profile_id, employee_code, display_name, designation_name",
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 9. Which dates in a range would actually cost leave (migration 039900)
// -----------------------------------------------------------------------------

export const COUNTABLE_DATES_FN = "leave_countable_dates";

export const countableDateSchema = z.object({
  leave_date: dbDate,
  is_weekly_off: z.boolean(),
  is_holiday: z.boolean(),
  holiday_name: z.string().nullable(),
  /** False for a weekly off or a holiday — the day is free and costs no balance. */
  would_count: z.boolean(),
  /** 1, 0.5 or 0 — the same figure the engine writes to `leave_request_days.day_value`. */
  day_value: z.number(),
  /**
   * True when a leave type's own rules decide this day and none was supplied. A sandwich type
   * counts the weekly off in the middle of a leave; without a type the answer given is the
   * plain one, and this flag is how the screen can avoid promising it.
   */
  type_dependent: z.boolean(),
});

export type CountableDate = z.infer<typeof countableDateSchema>;

/**
 * Advisory preview of a from–to range, per date.
 *
 * ADVISORY IS THE POINT. `calc_leave_days` is the authority but takes an EXISTING request, so
 * it cannot answer about a range somebody is still typing — the old screen had to write a
 * draft to find out. This is a read-only mirror of the engine's own day loop
 * (`rebuild_leave_request_days`): the same `resolve_policy` lookups for rota and holiday
 * calendar, the same active/non-optional/department/location holiday filter, and the same
 * per-leave-type counting rules.
 *
 * VERIFIED, NOT ASSUMED: 279 comparisons — 31 days × 9 active leave types, for an employee
 * whose rota is overridden by a policy assignment — matched the engine's own
 * `leave_request_days` rows date for date, flag for flag, value for value. The check that
 * caught the first version was exactly this one: that employee's `weekly_off_rule_id` column
 * says Sunday + alternate Saturday, while `resolve_policy` says Tuesday, and the engine
 * follows `resolve_policy`.
 *
 * `leaveTypeId` is optional. Omit it to paint a calendar before a type is chosen — the answer
 * is then the plain reading, with `type_dependent` set on the days a type could change.
 *
 * The real request still gets its `total_days` stamped by `calc_leave_days` on submit.
 */
export async function fetchCountableDates(
  employeeId: string,
  fromDate: string,
  toDate: string,
  leaveTypeId?: string | null,
  signal?: AbortSignal,
): Promise<CountableDate[]> {
  return rpcMany(
    COUNTABLE_DATES_FN,
    {
      p_employee_id: employeeId,
      p_from: fromDate,
      p_to: toDate,
      p_leave_type_id: leaveTypeId ?? null,
    },
    countableDateSchema,
    signal ? { signal } : {},
  );
}

// -----------------------------------------------------------------------------
// Who else is on leave — the company-wide roster
// -----------------------------------------------------------------------------

/**
 * `v_leave_roster` — approved leave for everyone, readable by any signed-in employee.
 *
 * A DIFFERENT VIEW FROM `v_leave_calendar` ON PURPOSE. That one is `security_invoker`, so it
 * returns only the rows RLS allows — your own, plus your reports if you manage anybody — and it
 * carries the whole request. This one runs as its owner and exposes name, department, leave type
 * and portion, and nothing else: never the reason, the address, the contact number, the handover
 * notes or the supporting document that sit on `leave_requests`.
 *
 * Approved only. A pending request is not a fact, and rendering "Ravi is on leave" for a day
 * nobody has granted would be wrong on a screen people plan around.
 */
export const leaveRosterRowSchema = z.object({
  leave_request_day_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  department_name: z.string().nullable(),
  leave_date: z.string(),
  portion: z.string(),
  leave_type_code: z.string(),
  leave_type_name: z.string(),
  colour_hex: z.string().nullable(),
});
export type LeaveRosterRow = z.infer<typeof leaveRosterRowSchema>;

export function fetchLeaveRoster(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<LeaveRosterRow[]> {
  return selectMany("v_leave_roster", leaveRosterRowSchema, {
    filters: [gte("leave_date", from), lte("leave_date", to)],
    order: [{ column: "leave_date", ascending: true }],
    // A month across the whole venue. Bounded so a wide range cannot pull the table.
    limit: 1000,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Who is at the venue — the presence roster
// -----------------------------------------------------------------------------

/**
 * `v_presence_roster` — who is on site today, readable by any signed-in employee.
 *
 * `presence` is decided by HOW the punch was taken, not by comparing coordinates:
 * `on_campus` means a gate scan exists today (the tablet is bolted to a known wall, so a gate
 * scan IS the venue), `remote` means punches exist but none from the gate, `not_in` means no
 * punch. Deliberately not `geofence_ok` — a web punch from the car park is inside the fence and
 * still not somebody at their desk.
 *
 * Carries no lateness, no worked minutes and no paid fraction. "Is Ravi at the venue" is a
 * different question from Ravi's punctuality record.
 */
export const presenceRosterRowSchema = z.object({
  employee_id: z.string().uuid(),
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  department_name: z.string().nullable(),
  presence: z.enum(["on_campus", "remote", "not_in"]),
  first_in_hm: z.string().nullable(),
  last_out_hm: z.string().nullable(),
  day_status: z.string(),
});
export type PresenceRosterRow = z.infer<typeof presenceRosterRowSchema>;

export function fetchPresenceRoster(signal?: AbortSignal): Promise<PresenceRosterRow[]> {
  return selectMany("v_presence_roster", presenceRosterRowSchema, {
    order: [{ column: "display_name", ascending: true }],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}
