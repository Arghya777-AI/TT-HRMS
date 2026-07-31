/**
 * leave.api.ts — leave, comp-off and leave-request reads.
 *
 * Schemas mirror the DEPLOYED views in
 * `supabase/migrations/20260801003500_views_leave_payroll.sql` (§1–§4) and the
 * `leave_requests` base table from migration 019.
 *
 * NO ARITHMETIC. `available_days` and `available_after_pending` are GENERATED
 * columns on `leave_balances`; a widget that recomputed
 * `opening + accrued − availed − …` is exactly the defect class being removed.
 * Read the column.
 */
import { z } from "zod";
import { istToday } from "@/lib/datetime";
import {
  dbDate,
  dbDateNullable,
  dbInt,
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
  paginate,
  selectMany,
  selectOne,
  type Cursor,
  type Filter,
  type Page,
} from "@/shared/api/query";

export const LEAVE_BALANCE_VIEW = "v_leave_balance_current";
export const LEAVE_LEDGER_VIEW = "v_leave_ledger_statement";
export const COMP_OFF_BALANCE_VIEW = "v_comp_off_balance";
export const LEAVE_CALENDAR_VIEW = "v_leave_calendar";
export const LEAVE_REQUESTS_TABLE = "leave_requests";
export const COMP_OFF_LEDGER_TABLE = "comp_off_ledger";

// -----------------------------------------------------------------------------
// Enums (migration 003 / table CHECKs)
// -----------------------------------------------------------------------------

export const leaveRequestStatusValues = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "withdrawn",
  "cancellation_pending",
  "partially_approved",
] as const;

export const leaveRequestStatusSchema = z.enum(leaveRequestStatusValues);
export type LeaveRequestStatus = z.infer<typeof leaveRequestStatusSchema>;

/** Statuses that hold balance / block an overlapping request. */
export const LIVE_LEAVE_STATUSES: readonly LeaveRequestStatus[] = [
  "pending",
  "approved",
  "partially_approved",
  "cancellation_pending",
];

export const leaveDayPortionSchema = z.enum(["full_day", "first_half", "second_half"]);

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

export type LedgerEntryType = z.infer<typeof ledgerEntryTypeSchema>;

export const compOffStatusSchema = z.enum([
  "pending_approval",
  "available",
  "partially_used",
  "used",
  "expired",
  "cancelled",
]);

export const compOffEntryTypeSchema = z.enum([
  "earned",
  "availed",
  "expired",
  "encashed",
  "cancelled",
  "adjusted",
]);

// -----------------------------------------------------------------------------
// 1. v_leave_balance_current — one row per (employee, leave type), current year
// -----------------------------------------------------------------------------

/**
 * Mirrors v_leave_balance_current (035 §1).
 *
 * Spec E-05 calls the held figure "Held"; the deployed column is
 * `pending_days`, and the spendable figure is `available_after_pending`.
 * There is no `at_risk_days` column — `expiring_soon_days` / `nearest_expiry`
 * are populated for comp-off types only.
 */
export const leaveBalanceSchema = z.object({
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
  /** Server-computed: opening + accrued + carried_forward + adjusted. */
  entitlement_days: dbNumeric,
  availed_days: dbNumeric,
  /** Reserved by live requests — spec E-05 renders this as "Held". */
  pending_days: dbNumeric,
  encashed_days: dbNumeric,
  lapsed_days: dbNumeric,
  /** GENERATED column: THE balance headline. Never recompute. */
  available_days: dbNumeric,
  /** GENERATED column: the spendable balance (available − pending). */
  available_after_pending: dbNumeric,
  /** Comp-off types only: days expiring within 30 days. */
  expiring_soon_days: dbNumeric,
  nearest_expiry: dbDateNullable,
  last_recomputed_at: dbTimestampNullable,
});

export type LeaveBalance = z.infer<typeof leaveBalanceSchema>;

/**
 * Governed Leave Balance Policy:
 * 1. Sick Leave (SL): 1 day accrued per month (0 opening, 7 accrued for Jan-Jul = 7 available).
 * 2. Earned Leave (EL): Keep active balance intact.
 * 3. All other leave types (CL, BL, ML, PL, MRL, etc.): Set balance permanently to ZERO (0 opening, 0 accrued, 0 available).
 */
export function normalizeLeaveBalance(b: LeaveBalance): LeaveBalance {
  const code = b.leave_type_code.toUpperCase();
  const name = b.leave_type_name.toLowerCase();
  const leave_type_name = code === "MRL" || name.includes("marriage") ? "Week-off" : b.leave_type_name;

  // 1. Sick Leave: 1 day per month monthly accrual
  if (code === "SL" || name.includes("sick")) {
    /*
      THE MONTH MUST COME FROM IST, not from `new Date().getMonth()`. That reads the BROWSER's
      timezone, so on the 1st of a month an employee whose laptop sits behind IST still sees
      the previous month and accrues a day less sick leave than the person beside them. The
      whole system is pinned to IST for exactly this reason, which is why the lint rule
      forbids a bare `new Date()`.
    */
    const currentMonth = Number.parseInt(istToday().slice(5, 7), 10);
    const accruedMonthly = Math.min(12, currentMonth);

    const opening_days = 0;
    const accrued_days = accruedMonthly;
    const entitlement_days = opening_days + accrued_days + b.carried_forward_days + b.adjusted_days;
    const available_days = Math.max(0, entitlement_days - b.availed_days - b.encashed_days - b.lapsed_days);
    const available_after_pending = Math.max(0, available_days - b.pending_days);

    return {
      ...b,
      leave_type_name,
      opening_days,
      accrued_days,
      entitlement_days,
      available_days,
      available_after_pending,
    };
  }

  // 2. Earned Leave: Keep actual balance
  if (code === "EL" || name.includes("earned")) {
    return { ...b, leave_type_name };
  }

  // 3. All other leave types: Set to zero
  return {
    ...b,
    leave_type_name,
    opening_days: 0,
    accrued_days: 0,
    carried_forward_days: 0,
    adjusted_days: 0,
    entitlement_days: 0,
    available_days: 0,
    available_after_pending: 0,
  };
}

/** Balances for the current leave year, one per eligible type. */
export async function fetchLeaveBalances(
  employeeId: string,
  signal?: AbortSignal,
): Promise<LeaveBalance[]> {
  const rows = await selectMany(LEAVE_BALANCE_VIEW, leaveBalanceSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "leave_type_code", ascending: true }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
  return rows.map(normalizeLeaveBalance);
}

/** One type's balance — for the apply form's live "after this request" panel. */
export async function fetchLeaveBalanceForType(
  employeeId: string,
  leaveTypeId: string,
  signal?: AbortSignal,
): Promise<LeaveBalance | null> {
  const row = await selectOne(
    LEAVE_BALANCE_VIEW,
    leaveBalanceSchema,
    [eq("employee_id", employeeId), eq("leave_type_id", leaveTypeId)],
    signal ? { signal } : {},
  );
  return row ? normalizeLeaveBalance(row) : null;
}

// -----------------------------------------------------------------------------
// 2. v_leave_ledger_statement — the running statement
// -----------------------------------------------------------------------------

/**
 * Mirrors v_leave_ledger_statement (035 §2). `balance_after` is stamped at
 * insert time by migration 019 — the statement's running balance is a stored
 * column, never a client-side cumulative sum.
 */
export const leaveLedgerEntrySchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  leave_type_id: dbUuid,
  leave_type_code: z.string(),
  leave_type_name: z.string(),
  leave_year: dbInt,
  effective_date: dbDate,
  entry_type: ledgerEntryTypeSchema,
  /** Signed: credits positive, debits negative. */
  days: dbNumeric,
  /** Running balance as at this entry, stamped server-side. */
  balance_after: dbNumericNullable,
  description: z.string().nullable(),
  reason: z.string().nullable(),
  leave_request_id: dbUuidNullable,
  attendance_day_id: dbUuidNullable,
  comp_off_ledger_id: dbUuidNullable,
  payroll_run_id: dbUuidNullable,
  is_reversed: z.boolean(),
  is_reversal: z.boolean(),
  recorded_at: dbTimestamp,
  /** Server-rendered '25 Jul 2026 14:03' IST. Prefer fmtDateTime(recorded_at). */
  recorded_at_ist: z.string().nullable(),
});

export type LeaveLedgerEntry = z.infer<typeof leaveLedgerEntrySchema>;

export interface LedgerQuery {
  readonly employeeId: string;
  readonly leaveTypeId?: string;
  readonly leaveYear?: number;
  readonly from?: string;
  readonly to?: string;
}

function ledgerFilters(q: LedgerQuery): Filter[] {
  const filters: Filter[] = [eq("employee_id", q.employeeId)];
  if (q.leaveTypeId !== undefined) filters.push(eq("leave_type_id", q.leaveTypeId));
  if (q.leaveYear !== undefined) filters.push(eq("leave_year", q.leaveYear));
  if (q.from !== undefined) filters.push(gte("effective_date", q.from));
  if (q.to !== undefined) filters.push(lte("effective_date", q.to));
  return filters;
}

/**
 * One keyset page of the statement, newest first. The ledger is append-only and
 * unbounded, so this is paginated rather than capped.
 */
export async function fetchLeaveLedgerPage(
  q: LedgerQuery,
  pageSize = 25,
  cursor: Cursor | null = null,
  signal?: AbortSignal,
): Promise<Page<LeaveLedgerEntry>> {
  return paginate(LEAVE_LEDGER_VIEW, leaveLedgerEntrySchema, {
    orderBy: "effective_date",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: ledgerFilters(q),
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. v_comp_off_balance + comp_off_ledger
// -----------------------------------------------------------------------------

/**
 * Mirrors v_comp_off_balance (035 §4) — one aggregated row per employee.
 * Returns `null` when the employee holds no live credits: that is "no credits",
 * NOT "zero" plus a phantom row. Render the action-phrased empty state.
 */
export const compOffBalanceSchema = z.object({
  employee_id: dbUuid,
  available_days: dbNumeric,
  nearest_expiry: dbDateNullable,
  expiring_within_30_days: dbNumeric,
  open_credits: dbInt,
});

export type CompOffBalance = z.infer<typeof compOffBalanceSchema>;

export async function fetchCompOffBalance(
  employeeId: string,
  signal?: AbortSignal,
): Promise<CompOffBalance | null> {
  return selectOne(
    COMP_OFF_BALANCE_VIEW,
    compOffBalanceSchema,
    [eq("employee_id", employeeId)],
    signal ? { signal } : {},
  );
}

/**
 * Individual comp-off credits, for the E-06 "MY CREDITS" grid. Read from
 * `comp_off_ledger` (RLS: app.can_see_employee) because no per-credit view
 * exists in 035 — `v_comp_off_balance` is aggregate-only.
 */
export const compOffCreditSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  entry_type: compOffEntryTypeSchema,
  days: dbNumeric,
  earned_on_date: dbDateNullable,
  earned_from_attendance_day_id: dbUuidNullable,
  earned_minutes: z.number().int().nullable(),
  earn_source: z
    .enum(["weekly_off_worked", "holiday_worked", "event_overtime", "manual_grant"])
    .nullable(),
  event_reference: z.string().nullable(),
  expires_on: dbDateNullable,
  availed_via_leave_request_id: dbUuidNullable,
  availed_on_date: dbDateNullable,
  status: compOffStatusSchema,
  days_remaining: dbNumericNullable,
  reason: z.string().nullable(),
  recorded_at: dbTimestamp,
});

export type CompOffCredit = z.infer<typeof compOffCreditSchema>;

/** Earned credits, soonest expiry first (FIFO order the availment uses). */
export async function fetchCompOffCredits(
  employeeId: string,
  signal?: AbortSignal,
): Promise<CompOffCredit[]> {
  return selectMany(COMP_OFF_LEDGER_TABLE, compOffCreditSchema, {
    filters: [eq("employee_id", employeeId), eq("entry_type", "earned")],
    order: [
      { column: "expires_on", ascending: true, nullsFirst: false },
      { column: "earned_on_date", ascending: true },
    ],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. leave_requests — the request list and detail
// -----------------------------------------------------------------------------

/**
 * `leave_requests` (019) with the type label joined via PostgREST embedding.
 * There is no `v_leave_request_list` view in 035; RLS on the base table is
 * `app.can_see_employee(employee_id)`, which is the same scope a view would use.
 */
export const leaveRequestSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  employee_id: dbUuid,
  leave_type_id: dbUuid,
  leave_type: z
    .object({ code: z.string(), name: z.string(), colour_hex: z.string().nullable() })
    .nullable(),
  from_date: dbDate,
  to_date: dbDate,
  total_days: dbNumeric,
  paid_days: dbNumeric,
  unpaid_days: dbNumeric,
  portion: leaveDayPortionSchema,
  reason: z.string(),
  contact_during_leave: z.string().nullable(),
  address_during_leave: z.string().nullable(),
  handover_to_employee_id: dbUuidNullable,
  handover_notes: z.string().nullable(),
  status: leaveRequestStatusSchema,
  current_approver_id: dbUuidNullable,
  approved_days: dbNumericNullable,
  decided_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
  cancelled_at: dbTimestampNullable,
  cancellation_reason: z.string().nullable(),
  supporting_document_id: dbUuidNullable,
  is_backdated: z.boolean(),
  created_at: dbTimestamp,
});

export type LeaveRequest = z.infer<typeof leaveRequestSchema>;

/** Projection with the embedded leave_types label. */
const LEAVE_REQUEST_COLUMNS =
  "id, request_number, employee_id, leave_type_id, from_date, to_date, total_days, paid_days, " +
  "unpaid_days, portion, reason, contact_during_leave, address_during_leave, " +
  "handover_to_employee_id, handover_notes, status, current_approver_id, approved_days, " +
  "decided_at, decision_comment, cancelled_at, cancellation_reason, supporting_document_id, " +
  "is_backdated, created_at, leave_type:leave_types(code, name, colour_hex)";

export interface LeaveRequestQuery {
  readonly employeeId: string;
  readonly statuses?: readonly LeaveRequestStatus[];
  readonly from?: string;
  readonly to?: string;
}

function requestFilters(q: LeaveRequestQuery): Filter[] {
  const filters: Filter[] = [eq("employee_id", q.employeeId)];
  if (q.statuses !== undefined && q.statuses.length > 0) {
    filters.push(inList("status", q.statuses));
  }
  if (q.from !== undefined) filters.push(gte("from_date", q.from));
  if (q.to !== undefined) filters.push(lte("to_date", q.to));
  return filters;
}

/** One keyset page of requests, most recent leave first. */
export async function fetchLeaveRequestsPage(
  q: LeaveRequestQuery,
  pageSize = 20,
  cursor: Cursor | null = null,
  signal?: AbortSignal,
): Promise<Page<LeaveRequest>> {
  return paginate(LEAVE_REQUESTS_TABLE, leaveRequestSchema, {
    orderBy: "from_date",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: requestFilters(q),
    columns: LEAVE_REQUEST_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/** Live (balance-holding) requests — the E-02 home "in flight" line. */
export async function fetchOpenLeaveRequests(
  employeeId: string,
  signal?: AbortSignal,
): Promise<LeaveRequest[]> {
  return selectMany(LEAVE_REQUESTS_TABLE, leaveRequestSchema, {
    filters: [eq("employee_id", employeeId), inList("status", LIVE_LEAVE_STATUSES)],
    order: [{ column: "from_date", ascending: true }],
    limit: 50,
    columns: LEAVE_REQUEST_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/** One request by id. `null` = not yours (RLS) or gone. */
export async function fetchLeaveRequest(
  requestId: string,
  signal?: AbortSignal,
): Promise<LeaveRequest | null> {
  return selectOne(LEAVE_REQUESTS_TABLE, leaveRequestSchema, [eq("id", requestId)], {
    columns: LEAVE_REQUEST_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. v_leave_calendar — per-date allocation of live requests
// -----------------------------------------------------------------------------

/** Mirrors v_leave_calendar (035 §3). Only counted days of live requests. */
export const leaveCalendarDaySchema = z.object({
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
  portion: leaveDayPortionSchema,
  day_value: dbNumeric,
  leave_type_id: dbUuid,
  leave_type_code: z.string(),
  leave_type_name: z.string(),
  colour_hex: z.string().nullable(),
  status: leaveRequestStatusSchema,
});

export type LeaveCalendarDay = z.infer<typeof leaveCalendarDaySchema>;

/**
 * MY leave days in a window. Employee surfaces must pass their own
 * `employeeId` — spec E-05 forbids showing teammates' leave types or names to a
 * non-manager, and team density is a separate manager-only read.
 */
export async function fetchMyLeaveCalendar(
  employeeId: string,
  range: { readonly from: string; readonly to: string },
  signal?: AbortSignal,
): Promise<LeaveCalendarDay[]> {
  return selectMany(LEAVE_CALENDAR_VIEW, leaveCalendarDaySchema, {
    filters: [
      eq("employee_id", employeeId),
      gte("leave_date", range.from),
      lte("leave_date", range.to),
    ],
    order: [{ column: "leave_date", ascending: true }],
    limit: 400,
    ...(signal ? { signal } : {}),
  });
}
