/**
 * leave.api.ts — Leave administration (§7) reads and writes.
 *
 * What a client may write, checked against the deployed grants (migration 019
 * §grants) rather than assumed:
 *   * `leave_types`   — INSERT/UPDATE granted to `authenticated`, gated by
 *     `leave_types__admin_write`; the table is in `audit.reason_required_tables`,
 *     so every edit carries `X-Reason`.
 *   * `leave_requests` — INSERT/UPDATE/DELETE granted, admin policy is FOR ALL
 *     within scope. Admin approve/reject-on-behalf writes here.
 *   * `leave_ledger`, `leave_balances`, `comp_off_ledger` — INSERT/UPDATE are
 *     granted to `service_role` ONLY. A manual adjustment therefore cannot be a
 *     PostgREST write, and there is no `leave-adjust` edge function deployed:
 *     `/admin/leave/adjustments` has no write path yet. `submitLeaveAdjustment`
 *     below throws that fact instead of pretending, so the screen renders an
 *     honest "not switched on" state rather than a form that 42501s.
 *
 * Balances are read from `v_leave_balance_current` — the materialised running sum
 * of the ledger. The client never adds days up.
 */
import { z } from "zod";
import {
  MutationError,
  SENSITIVE_REASON_LENGTH,
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
  insertRow,
  isNull,
  lte,
  paginate,
  selectMany,
  selectOne,
  softDelete,
  updateRow,
  type Cursor,
  type Filter,
  type Page,
} from "@/shared/api/query";
import { nowInstantIso } from "@/lib/datetime";

export const LEAVE_TYPES_TABLE = "leave_types";
export const LEAVE_REQUESTS_TABLE = "leave_requests";
export const V_BALANCE_CURRENT = "v_leave_balance_current";
export const V_LEDGER_STATEMENT = "v_leave_ledger_statement";
export const V_LEAVE_CALENDAR = "v_leave_calendar";
export const V_COMP_OFF_BALANCE = "v_comp_off_balance";
export const COMP_OFF_LEDGER_TABLE = "comp_off_ledger";

/** `public.leave_request_status` (migration 003). */
export const leaveRequestStatusSchema = z.enum([
  "draft",
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "withdrawn",
  "cancellation_pending",
  "partially_approved",
]);
export type LeaveRequestStatus = z.infer<typeof leaveRequestStatusSchema>;

/** `public.ledger_entry_type` (migration 003). */
export const ledgerEntryTypeSchema = z.enum([
  "opening_balance",
  "accrual",
  "pro_rata_accrual",
  "credit_adjustment",
  "carry_forward_in",
  "carry_forward_out",
  "encashment",
  "lapse",
  "availed",
  "availed_reversal",
  "debit_adjustment",
  "late_deduction",
  "comp_off_credit",
  "comp_off_debit",
  "comp_off_expiry",
  "settlement",
]);

// -----------------------------------------------------------------------------
// 1. Leave Type Master (`/admin/leave/types`)
// -----------------------------------------------------------------------------

export const leaveTypeSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: dbInt,
  is_active: z.boolean(),
  is_paid: z.boolean(),
  unit: z.string(),
  allow_half_day: z.boolean(),
  annual_quota_days: dbNumericNullable,
  accrual_frequency: z.string(),
  accrual_days_per_period: dbNumericNullable,
  accrual_on_working_days_basis: z.boolean(),
  accrual_days_per_worked_days: dbNumericNullable,
  accrual_start_after_months: dbIntNullable,
  availing_allowed_during_probation: z.boolean(),
  pro_rata_on_join: z.boolean(),
  pro_rata_on_exit: z.boolean(),
  max_balance_days: dbNumericNullable,
  carry_forward_allowed: z.boolean(),
  max_carry_forward_days: dbNumericNullable,
  carry_forward_expiry_months: dbIntNullable,
  encashment_allowed: z.boolean(),
  max_encashment_days: dbNumericNullable,
  min_days_per_request: dbNumericNullable,
  max_days_per_request: dbNumericNullable,
  max_consecutive_days: dbNumericNullable,
  min_notice_days: dbIntNullable,
  max_backdated_days: dbIntNullable,
  requires_document_after_days: dbNumericNullable,
  document_type_id: dbUuidNullable,
  allow_negative_balance: z.boolean(),
  max_negative_days: dbNumericNullable,
  sandwich_holidays: z.boolean(),
  count_weekly_off_as_leave: z.boolean(),
  count_holiday_as_leave: z.boolean(),
  gender_restriction: z.string().nullable(),
  min_service_months: dbIntNullable,
  max_times_in_service: dbIntNullable,
  applies_to_employment_types: z.array(z.string()).nullable(),
  requires_approval: z.boolean(),
  approval_chain_id: dbUuidNullable,
  colour_hex: z.string().nullable(),
  is_comp_off: z.boolean(),
  /** System-managed rows refuse most edits via `leave_types_guard()`. */
  is_system_managed: z.boolean(),
  deleted_at: dbTimestampNullable,
  updated_at: dbTimestamp,
});
export type LeaveType = z.infer<typeof leaveTypeSchema>;

export function fetchLeaveTypes(
  opts: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<LeaveType[]> {
  const filters: Filter[] = [isNull("deleted_at")];
  if (opts.includeInactive !== true) filters.push({ op: "is", column: "is_active", value: true });
  return selectMany(LEAVE_TYPES_TABLE, leaveTypeSchema, {
    filters,
    order: [{ column: "sort_order", ascending: true }],
    ...(signal ? { signal } : {}),
  });
}

export function fetchLeaveType(id: string, signal?: AbortSignal): Promise<LeaveType | null> {
  return selectOne(LEAVE_TYPES_TABLE, leaveTypeSchema, [eq("id", id)], {
    ...(signal ? { signal } : {}),
  });
}

/**
 * Edit a leave type. Audited: the table is in `audit.reason_required_tables`, so
 * one audit row per changed field is written with this reason. A rulebook change
 * silently re-prices everybody's entitlement, which is exactly why it is audited.
 */
export function updateLeaveType(
  id: string,
  patch: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<LeaveType> {
  return updateRow(LEAVE_TYPES_TABLE, [eq("id", id)], patch, leaveTypeSchema, {
    reason,
    ...(signal ? { signal } : {}),
  });
}

export function insertLeaveType(
  values: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<LeaveType> {
  return insertRow(LEAVE_TYPES_TABLE, values, leaveTypeSchema, {
    reason,
    ...(signal ? { signal } : {}),
  });
}

/** Retire a leave type. Soft delete keeps historical ledger rows readable. */
export function archiveLeaveType(id: string, reason: string, signal?: AbortSignal): Promise<void> {
  return softDelete(LEAVE_TYPES_TABLE, id, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Balances (`/admin/leave/balances`) and ledger (`/admin/leave/ledger/:code`)
// -----------------------------------------------------------------------------

export const balanceSchema = z.object({
  employee_id: dbUuid,
  leave_type_id: dbUuid,
  leave_type_code: z.string(),
  leave_type_name: z.string(),
  colour_hex: z.string().nullable(),
  is_paid: z.boolean(),
  is_comp_off: z.boolean(),
  allow_half_day: z.boolean(),
  leave_year: dbInt,
  opening_days: dbNumeric,
  accrued_days: dbNumeric,
  carried_forward_days: dbNumeric,
  adjusted_days: dbNumeric,
  entitlement_days: dbNumeric,
  availed_days: dbNumeric,
  pending_days: dbNumeric,
  encashed_days: dbNumeric,
  lapsed_days: dbNumeric,
  /** THE balance. Materialised running sum of the ledger — never recomputed here. */
  available_days: dbNumeric,
  available_after_pending: dbNumeric,
  expiring_soon_days: dbNumeric,
  nearest_expiry: dbDateNullable,
  last_recomputed_at: dbTimestampNullable,
});
export type LeaveBalance = z.infer<typeof balanceSchema>;

export function fetchLeaveBalances(
  f: { employeeIds?: readonly string[]; leaveYear?: number; leaveTypeIds?: readonly string[] },
  limit = 500,
  signal?: AbortSignal,
): Promise<LeaveBalance[]> {
  const filters: Filter[] = [];
  if (f.employeeIds && f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  if (f.leaveTypeIds && f.leaveTypeIds.length > 0) filters.push(inList("leave_type_id", f.leaveTypeIds));
  if (f.leaveYear !== undefined) filters.push(eq("leave_year", f.leaveYear));
  return selectMany(V_BALANCE_CURRENT, balanceSchema, {
    filters,
    order: [{ column: "leave_type_code", ascending: true }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export const ledgerRowSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  leave_type_id: dbUuid,
  leave_type_code: z.string(),
  leave_type_name: z.string(),
  leave_year: dbInt,
  effective_date: dbDate,
  entry_type: ledgerEntryTypeSchema,
  /** Signed: negative is a debit. The view carries the sign, we do not apply one. */
  days: dbNumeric,
  balance_after: dbNumericNullable,
  description: z.string(),
  reason: z.string().nullable(),
  leave_request_id: dbUuidNullable,
  attendance_day_id: dbUuidNullable,
  comp_off_ledger_id: dbUuidNullable,
  payroll_run_id: dbUuidNullable,
  is_reversed: z.boolean(),
  is_reversal: z.boolean(),
  recorded_at: dbTimestamp,
  recorded_at_ist: z.string(),
});
export type LedgerRow = z.infer<typeof ledgerRowSchema>;

export function fetchLeaveLedger(
  employeeId: string,
  f: { leaveTypeId?: string; leaveYear?: number; from?: string; to?: string },
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<LedgerRow>> {
  const filters: Filter[] = [eq("employee_id", employeeId)];
  if (f.leaveTypeId !== undefined) filters.push(eq("leave_type_id", f.leaveTypeId));
  if (f.leaveYear !== undefined) filters.push(eq("leave_year", f.leaveYear));
  if (f.from !== undefined) filters.push(gte("effective_date", f.from));
  if (f.to !== undefined) filters.push(lte("effective_date", f.to));
  return paginate(V_LEDGER_STATEMENT, ledgerRowSchema, {
    orderBy: "effective_date",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Requests (`/admin/leave/requests`)
// -----------------------------------------------------------------------------

export const leaveRequestSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  employee_id: dbUuid,
  leave_type_id: dbUuid,
  from_date: dbDate,
  to_date: dbDate,
  total_days: dbNumeric,
  paid_days: dbNumeric,
  unpaid_days: dbNumeric,
  portion: z.enum(["full_day", "first_half", "second_half"]),
  reason: z.string(),
  contact_during_leave: z.string().nullable(),
  handover_to_employee_id: dbUuidNullable,
  handover_notes: z.string().nullable(),
  status: leaveRequestStatusSchema,
  approval_request_id: dbUuidNullable,
  current_approver_id: dbUuidNullable,
  approved_days: dbNumericNullable,
  decided_by: dbUuidNullable,
  decided_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
  cancelled_by: dbUuidNullable,
  cancelled_at: dbTimestampNullable,
  cancellation_reason: z.string().nullable(),
  supporting_document_id: dbUuidNullable,
  is_backdated: z.boolean(),
  ledger_applied_at: dbTimestampNullable,
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});
export type LeaveRequest = z.infer<typeof leaveRequestSchema>;

export function fetchLeaveRequests(
  f: {
    statuses?: readonly LeaveRequestStatus[];
    employeeIds?: readonly string[];
    leaveTypeIds?: readonly string[];
    from?: string;
    to?: string;
  },
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<LeaveRequest>> {
  const filters: Filter[] = [];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.employeeIds && f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  if (f.leaveTypeIds && f.leaveTypeIds.length > 0) filters.push(inList("leave_type_id", f.leaveTypeIds));
  if (f.from !== undefined) filters.push(gte("from_date", f.from));
  if (f.to !== undefined) filters.push(lte("to_date", f.to));
  return paginate(LEAVE_REQUESTS_TABLE, leaveRequestSchema, {
    orderBy: "from_date",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Admin decision on behalf of an approver (§7.3 `override_of_level_N`).
 *
 * The DB does the rest: `leave_requests_apply_ledger` writes the ledger entries
 * and `leave_requests_recompute_balance` refreshes the balance, both in this
 * transaction. This function only records the intent — it never touches days or
 * balances itself.
 */
export function decideLeaveRequest(
  input: {
    requestId: string;
    decision: "approved" | "rejected";
    decidedBy: string;
    approvedDays?: number;
    comment?: string;
  },
  reason: string,
  signal?: AbortSignal,
): Promise<LeaveRequest> {
  return updateRow(
    LEAVE_REQUESTS_TABLE,
    [eq("id", input.requestId), inList("status", ["pending", "partially_approved"])],
    {
      status: input.decision,
      decided_by: input.decidedBy,
      decided_at: nowInstantIso(),
      ...(input.approvedDays !== undefined ? { approved_days: input.approvedDays } : {}),
      ...(input.comment !== undefined ? { decision_comment: input.comment } : {}),
    },
    leaveRequestSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, ...(signal ? { signal } : {}) },
  );
}

/**
 * Cancel an approved request (§7.3). The ledger credit is the trigger's job; a
 * paid period becomes arrears, never an edited payslip.
 */
export function cancelLeaveRequest(
  requestId: string,
  cancelledBy: string,
  reason: string,
  signal?: AbortSignal,
): Promise<LeaveRequest> {
  return updateRow(
    LEAVE_REQUESTS_TABLE,
    [eq("id", requestId)],
    {
      status: "cancelled",
      cancelled_by: cancelledBy,
      cancelled_at: nowInstantIso(),
      cancellation_reason: reason.trim(),
    },
    leaveRequestSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 4. Org leave calendar + comp-off
// -----------------------------------------------------------------------------

export const leaveCalendarRowSchema = z.object({
  leave_request_day_id: dbUuid,
  leave_request_id: dbUuid,
  request_number: z.string(),
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  photo_path: z.string().nullable(),
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  leave_date: dbDate,
  portion: z.string(),
  day_value: dbNumeric,
  leave_type_id: dbUuid,
  leave_type_code: z.string(),
  leave_type_name: z.string(),
  colour_hex: z.string().nullable(),
  status: leaveRequestStatusSchema,
});
export type LeaveCalendarRow = z.infer<typeof leaveCalendarRowSchema>;

export function fetchLeaveCalendar(
  from: string,
  to: string,
  f: { departmentIds?: readonly string[] } = {},
  signal?: AbortSignal,
): Promise<LeaveCalendarRow[]> {
  const filters: Filter[] = [gte("leave_date", from), lte("leave_date", to)];
  if (f.departmentIds && f.departmentIds.length > 0) filters.push(inList("department_id", f.departmentIds));
  return selectMany(V_LEAVE_CALENDAR, leaveCalendarRowSchema, {
    filters,
    order: [{ column: "leave_date", ascending: true }],
    limit: 1000,
    ...(signal ? { signal } : {}),
  });
}

export const compOffBalanceSchema = z.object({
  employee_id: dbUuid,
  available_days: dbNumeric,
  nearest_expiry: dbDateNullable,
  expiring_within_30_days: dbNumeric,
  open_credits: dbInt,
});
export type CompOffBalance = z.infer<typeof compOffBalanceSchema>;

export function fetchCompOffBalances(
  employeeIds: readonly string[],
  signal?: AbortSignal,
): Promise<CompOffBalance[]> {
  return selectMany(V_COMP_OFF_BALANCE, compOffBalanceSchema, {
    ...(employeeIds.length > 0 ? { filters: [inList("employee_id", employeeIds)] } : {}),
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

export const compOffLedgerRowSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  entry_type: z.string(),
  days: dbNumeric,
  earned_on_date: dbDateNullable,
  earned_from_attendance_day_id: dbUuidNullable,
  earned_minutes: dbIntNullable,
  earn_source: z.string().nullable(),
  event_reference: z.string().nullable(),
  expires_on: dbDateNullable,
  availed_via_leave_request_id: dbUuidNullable,
  availed_on_date: dbDateNullable,
  status: z.string(),
  days_remaining: dbNumericNullable,
  approved_by: dbUuidNullable,
  approved_at: dbTimestampNullable,
  reason: z.string().nullable(),
  recorded_at: dbTimestamp,
});
export type CompOffLedgerRow = z.infer<typeof compOffLedgerRowSchema>;

/** Comp-off ledger is READ-only for every client role (grants: service_role). */
export function fetchCompOffLedger(
  f: { employeeIds?: readonly string[]; statuses?: readonly string[] },
  limit = 300,
  signal?: AbortSignal,
): Promise<CompOffLedgerRow[]> {
  const filters: Filter[] = [];
  if (f.employeeIds && f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  return selectMany(COMP_OFF_LEDGER_TABLE, compOffLedgerRowSchema, {
    filters,
    order: [{ column: "earned_on_date", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. Manual adjustments — NO deployed write path
// -----------------------------------------------------------------------------

export interface LeaveAdjustmentInput {
  readonly employeeId: string;
  readonly leaveTypeId: string;
  readonly days: number;
  readonly effectiveDate: string;
  readonly reasonCategory: string;
}

/**
 * `/admin/leave/adjustments` is specified (§7.2) but has no write path on this
 * backend: `leave_ledger` grants INSERT to `service_role` only, the append-only
 * trigger `leave_ledger_guard_mutation` refuses client mutation, and no
 * `leave-adjust` edge function is deployed. Rather than post a request that is
 * certain to 42501 after an admin has typed a reason, this states the gap.
 */
export function submitLeaveAdjustment(_input: LeaveAdjustmentInput, _reason: string): Promise<never> {
  return Promise.reject(
    new MutationError(
      "leave_ledger",
      "permission_denied",
      "Manual leave adjustments need a server-side endpoint: leave_ledger is append-only and grants INSERT to service_role only. No leave-adjust edge function is deployed yet.",
    ),
  );
}
