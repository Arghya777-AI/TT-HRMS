/**
 * attendance.api.ts — Attendance administration (§4) reads and writes.
 *
 * The two-table model (D-13) decides the shape of this file:
 *   * `attendance_punches` is append-only evidence. There is NO admin INSERT or
 *     UPDATE policy on it (migration 016 grants admins SELECT only), so a manual
 *     punch and a void CANNOT be PostgREST writes — they go through the
 *     `kiosk-punch` and `void-punch` edge functions, which hold the service role
 *     and write the audit row in the same transaction.
 *   * `attendance_days` is fully derived and also SELECT-only for admins
 *     (migration 017 has `attendance_days__admin_read` and no write policy). An
 *     override is therefore NOT a PATCH from this client either; it is a
 *     recompute driven by `attendance-recompute`.
 * Both are stated here as functions that call the edge function, rather than as
 * a `updateRow("attendance_days", …)` that would fail at 42501 after the admin
 * has typed a reason. The audited PostgREST helpers are used for the one
 * attendance table a client may write: `attendance_locks` (insert = admin,
 * update/unlock = super admin).
 *
 * NO ARITHMETIC. Every KPI comes from `f_attendance_period_summary(from, to,
 * employee_id)` — the same function the Command Centre calls, which is what
 * makes the 14-KPI strip and the tiles agree by construction.
 */
import { z } from "zod";
import {
  SENSITIVE_REASON_LENGTH,
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumeric,
  dbNumericNullable,
  dbPercentNullable,
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
  rpcMany,
  rpcOne,
  selectCount,
  selectMany,
  selectOne,
  updateRow,
  type Cursor,
  type Filter,
  type Page,
} from "@/shared/api/query";
import { invokeEdgeFn, newIdempotencyKey } from "@/shared/api/invoke";
import { nowInstantIso } from "@/lib/datetime";

export const V_DAY_ENRICHED = "v_attendance_day_enriched";
export const V_PUNCH_DETAIL = "v_attendance_punch_detail";
export const V_TODAY_BOARD = "v_attendance_today_board";
export const V_EXCEPTION_QUEUE = "v_exception_queue";
export const ATTENDANCE_LOCKS_TABLE = "attendance_locks";
export const PERIOD_SUMMARY_FN = "f_attendance_period_summary";

/** `public.attendance_status` (migration 003) — the deployed enum. */
export const attendanceStatusValues = [
  "present",
  "half_day",
  "absent",
  "weekly_off",
  "holiday",
  "on_leave",
  "on_leave_half",
  "weekly_off_worked",
  "holiday_worked",
  "comp_off_availed",
  "on_duty",
  "work_from_home",
  "suspended",
  "not_yet_joined",
  "post_exit",
  "pending",
] as const;
export const attendanceStatusSchema = z.enum(attendanceStatusValues);
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;

// -----------------------------------------------------------------------------
// 1. Day Records grid (`/admin/attendance/days`)
// -----------------------------------------------------------------------------

export const dayRowSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  photo_path: z.string().nullable(),
  ist_date: dbDate,
  status: attendanceStatusSchema,
  status_source: z.string(),
  department_name: z.string().nullable(),
  section_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  location_name: z.string().nullable(),
  shift_id: dbUuidNullable,
  shift_code: z.string().nullable(),
  /** Already formatted by the server, e.g. 'SEC-N — 07:00 PM to 07:00 AM'. */
  shift_display_label: z.string().nullable(),
  shift_start_at: dbTimestampNullable,
  shift_end_at: dbTimestampNullable,
  shift_duration_minutes: dbIntNullable,
  manager_id: dbUuidNullable,
  manager_name: z.string().nullable(),
  holiday_id: dbUuidNullable,
  holiday_name: z.string().nullable(),
  leave_type_id: dbUuidNullable,
  leave_type_code: z.string().nullable(),
  leave_type_name: z.string().nullable(),
  leave_request_id: dbUuidNullable,
  leave_day_fraction: dbNumeric,
  first_in_at: dbTimestampNullable,
  last_out_at: dbTimestampNullable,
  /** Server-rendered IST wall clock — do NOT re-derive from the instant. */
  first_in_hm: z.string().nullable(),
  last_out_hm: z.string().nullable(),
  punch_count: dbInt,
  gross_span_minutes: dbInt,
  break_minutes: dbInt,
  break_count: dbInt,
  total_worked_minutes: dbInt,
  payable_worked_minutes: dbInt,
  worked_hm: z.string().nullable(),
  is_late: z.boolean(),
  late_minutes: dbInt,
  late_hm: z.string().nullable(),
  is_early_exit: z.boolean(),
  early_exit_minutes: dbInt,
  overtime_minutes: dbInt,
  approved_overtime_minutes: dbInt,
  day_fraction_paid: dbNumeric,
  late_deduction_leave_days: dbNumeric,
  is_holiday: z.boolean(),
  is_weekly_off: z.boolean(),
  is_working_day: z.boolean(),
  manual_override_status: z.boolean(),
  manual_override_times: z.boolean(),
  manual_override_reason: z.string().nullable(),
  is_regularized: z.boolean(),
  regularization_id: dbUuidNullable,
  anomaly_flags: z.array(z.string()),
  has_anomalies: z.boolean(),
  is_locked: z.boolean(),
  computed_at: dbTimestampNullable,
  computed_version: dbIntNullable,
});
export type DayRow = z.infer<typeof dayRowSchema>;

export interface DayFilters {
  readonly from: string;
  readonly to: string;
  readonly employeeIds?: readonly string[];
  readonly departmentIds?: readonly string[];
  readonly statuses?: readonly AttendanceStatus[];
  readonly onlyExceptions?: boolean;
  readonly onlyLate?: boolean;
  readonly onlyLocked?: boolean;
  /**
   * Days whose `anomaly_flags` array CONTAINS all of these engine flags — e.g.
   * `[SINGLE_PUNCH_FLAG]` for "scanned in and never out".
   *
   * It exists so the Exception Dashboard can select that case from a structured
   * server predicate (`anomaly_flags=cs.{…}`) instead of pattern-matching the
   * sentence `v_exception_queue.description` builds
   * ('Anomalies: single_punch_only, …'), which is the only place that view
   * exposes the flags at all. A count and a list built from this filter agree
   * with each other and with the engine.
   */
  readonly anomalyFlags?: readonly string[];
}

/**
 * The engine's flag for a day with exactly ONE surviving scan (migration 018:
 * `IF v_count = 1 THEN v_last := NULL; v_flags || 'single_punch_only'`). Never
 * rendered — it selects rows; the screen writes the sentence.
 */
export const SINGLE_PUNCH_FLAG = "single_punch_only";

function dayFilters(f: DayFilters): Filter[] {
  const filters: Filter[] = [gte("ist_date", f.from), lte("ist_date", f.to)];
  if (f.employeeIds && f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  if (f.departmentIds && f.departmentIds.length > 0)
    filters.push(inList("department_name", f.departmentIds));
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.onlyExceptions === true) filters.push({ op: "is", column: "has_anomalies", value: true });
  if (f.onlyLate === true) filters.push({ op: "is", column: "is_late", value: true });
  if (f.onlyLocked === true) filters.push({ op: "is", column: "is_locked", value: true });
  if (f.anomalyFlags && f.anomalyFlags.length > 0)
    filters.push({ op: "contains", column: "anomaly_flags", values: f.anomalyFlags });
  return filters;
}

/** Keyset page of day records, newest date first. */
export function fetchDayRecords(
  filters: DayFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<DayRow>> {
  return paginate(V_DAY_ENRICHED, dayRowSchema, {
    orderBy: "ist_date",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: dayFilters(filters),
    ...(signal ? { signal } : {}),
  });
}

/**
 * How many employee-days match, counted by Postgres over the SAME predicate as
 * `fetchDayRecords`. The Bulk Actions preview needs to state the size of a scope
 * before anything is applied to it, and `rows.length` would state the size of
 * the page instead — which is how an operator ends up committing a change to
 * 1,240 days believing they had reviewed 200.
 */
export function countDayRecords(filters: DayFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_DAY_ENRICHED, dayFilters(filters), { ...(signal ? { signal } : {}) });
}

/** One day for one employee — the day-detail drawer. */
export function fetchDay(
  employeeId: string,
  isoDate: string,
  signal?: AbortSignal,
): Promise<DayRow | null> {
  return selectOne(V_DAY_ENRICHED, dayRowSchema, [eq("employee_id", employeeId), eq("ist_date", isoDate)], {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. The ONE summary row (14-KPI strip AND Command Centre)
// -----------------------------------------------------------------------------

export const periodSummarySchema = z.object({
  employee_id: dbUuidNullable,
  from_date: dbDate,
  to_date: dbDate,
  total_days: dbInt,
  present_days: dbInt,
  half_days: dbInt,
  absent_days: dbInt,
  /** Days the engine has not processed yet — never folded into absents. */
  pending_days: dbInt,
  weekly_off_days: dbInt,
  holiday_days: dbInt,
  leave_days: dbInt,
  comp_off_days: dbInt,
  paid_days: dbNumeric,
  working_days: dbInt,
  late_days: dbInt,
  late_minutes: dbInt,
  early_exit_days: dbInt,
  early_exit_minutes: dbInt,
  overtime_minutes: dbInt,
  approved_overtime_minutes: dbInt,
  extra_work_minutes: dbInt,
  total_worked_minutes: dbInt,
  /** Averages over the named denominator; NULL (not 0) when there is no data. */
  avg_worked_minutes_per_present_day: dbNumericNullable,
  avg_worked_minutes_per_working_day: dbNumericNullable,
  /** Clamped [0,100] by fn_late_pct; NULL when the denominator is 0. */
  late_pct: dbPercentNullable,
  attendance_pct: dbPercentNullable,
  late_deduction_leave_days: dbNumeric,
  break_minutes: dbInt,
  break_count: dbInt,
  avg_breaks_per_present_day: dbNumericNullable,
});
export type PeriodSummary = z.infer<typeof periodSummarySchema>;

/**
 * Org-wide or per-employee period summary. `employeeId = null` aggregates every
 * employee the caller may see — one row per employee, so an org-level KPI strip
 * is the server's sum of these rows, requested with `employeeId` set to null and
 * displayed per employee; a single org TOTAL is not in any deployed view (see
 * the notes returned with this module).
 */
export function fetchPeriodSummary(
  from: string,
  to: string,
  employeeId: string | null,
  signal?: AbortSignal,
): Promise<PeriodSummary[]> {
  return rpcMany(
    PERIOD_SUMMARY_FN,
    { p_from: from, p_to: to, p_employee_id: employeeId },
    periodSummarySchema,
    { ...(signal ? { signal } : {}) },
  );
}

/** One employee's summary for a period — the 360 Attendance tab strip. */
export function fetchEmployeePeriodSummary(
  employeeId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<PeriodSummary | null> {
  return rpcOne(
    PERIOD_SUMMARY_FN,
    { p_from: from, p_to: to, p_employee_id: employeeId },
    periodSummarySchema,
    { ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 3. Punch log (`/admin/attendance/punches`)
// -----------------------------------------------------------------------------

export const punchRowSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  /*
    NULLABLE. `v_attendance_punch_detail` labels a punch through
    `LEFT JOIN public.v_employee_ref`, and that view filters
    `WHERE e.deleted_at IS NULL` — so an archived employee's punches survive
    (correctly: the scan happened) with no name attached. Live count at the time
    of writing: 591 of 674 punches, all belonging to archived staff.

    Every sibling schema over this view — `attendancePunchSchema`,
    `leaveCalendarRowSchema`, `payslipLineSchema`, `varianceRowSchema`,
    `custodyRowSchema` — already declares both nullable. This one did not, so the
    punch log threw a parse error and rendered "Something went wrong" instead of
    the log.
  */
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  punched_at: dbTimestamp,
  ist_date: dbDate,
  ist_time: z.string(),
  effective_date: dbDate,
  ist_time_display: z.string(),
  direction: z.string().nullable(),
  /** 'IN' / 'OUT' — derived by the server, not by the kiosk (D-13). */
  derived_direction: z.string().nullable(),
  source: z.string(),
  source_label: z.string(),
  kiosk_device_id: dbUuidNullable,
  device_label: z.string().nullable(),
  operator_id: dbUuidNullable,
  operator_name: z.string().nullable(),
  match_confidence: dbNumericNullable,
  confidence_badge: z.string().nullable(),
  photo_path: z.string().nullable(),
  lat: dbNumericNullable,
  lng: dbNumericNullable,
  /**
   * Metres of horizontal uncertainty the DEVICE reported. NULL means it reported
   * none — which is not the same as "accurate", and `PunchLocation` says so rather
   * than letting six decimal places of latitude imply a survey.
   *
   * Projected by migration 076. `PunchLocationColumns` requires this field
   * precisely because leaving it optional let this schema — which had lat and lng
   * and no accuracy — satisfy the component and render "accuracy not reported" on
   * every row while typechecking clean.
   */
  location_accuracy_m: dbNumericNullable,
  /** Source address — a web punch's only provenance besides its coordinate. */
  ip_address: z.string().nullable(),
  geofence_ok: z.boolean().nullable(),
  is_offline_replay: z.boolean(),
  needs_review: z.boolean(),
  is_voided: z.boolean(),
  voided_at: dbTimestampNullable,
  void_reason: z.string().nullable(),
  reason: z.string().nullable(),
  operator_note: z.string().nullable(),
  recorded_at: dbTimestamp,
});
export type PunchRow = z.infer<typeof punchRowSchema>;

export interface PunchFilters {
  readonly from: string;
  readonly to: string;
  readonly employeeIds?: readonly string[];
  readonly deviceIds?: readonly string[];
  readonly sources?: readonly string[];
  /** Default false → voided rows are EXCLUDED. The Punch Log passes true. */
  readonly includeVoided?: boolean;
  /** Narrow to voided scans only — the "what has been corrected" review. */
  readonly onlyVoided?: boolean;
  readonly onlyNeedsReview?: boolean;
}

/**
 * ONE predicate builder, shared by the paged read and the `count=exact`, exactly
 * as `dayFilters` is. The Punch Log header total must be Postgres's answer to the
 * same question the rows answer; counting loaded rows would make it depend on how
 * far the admin has scrolled (DR-29, the `7 vs 8` defect).
 *
 * `onlyVoided` is deliberately separate from `includeVoided`: the log is evidence,
 * so the default view SHOWS voided rows (struck through, never hidden) and
 * `onlyVoided` narrows to just them. `includeVoided: false` is the opt-OUT.
 */
function punchFilters(f: PunchFilters): Filter[] {
  const filters: Filter[] = [gte("effective_date", f.from), lte("effective_date", f.to)];
  if (f.employeeIds && f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  if (f.deviceIds && f.deviceIds.length > 0) filters.push(inList("kiosk_device_id", f.deviceIds));
  if (f.sources && f.sources.length > 0) filters.push(inList("source", f.sources));
  if (f.includeVoided !== true) filters.push({ op: "is", column: "is_voided", value: false });
  if (f.onlyVoided === true) filters.push({ op: "is", column: "is_voided", value: true });
  if (f.onlyNeedsReview === true) filters.push({ op: "is", column: "needs_review", value: true });
  return filters;
}

export function fetchPunchLog(
  f: PunchFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<PunchRow>> {
  const filters = punchFilters(f);
  return paginate(V_PUNCH_DETAIL, punchRowSchema, {
    orderBy: "punched_at",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters,
    ...(signal ? { signal } : {}),
  });
}

/**
 * How many scans match, counted by Postgres over the SAME predicate as
 * `fetchPunchLog`. Kept a separate query so a failed count degrades the header to
 * an em dash while the log itself still renders (the PARTIAL state).
 */
export function countPunchLog(f: PunchFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_PUNCH_DETAIL, punchFilters(f), { ...(signal ? { signal } : {}) });
}

/** The scans behind one day — the day-detail timeline. */
export function fetchPunchesForDay(
  employeeId: string,
  effectiveDate: string,
  signal?: AbortSignal,
): Promise<PunchRow[]> {
  return selectMany(V_PUNCH_DETAIL, punchRowSchema, {
    filters: [eq("employee_id", employeeId), eq("effective_date", effectiveDate)],
    order: [{ column: "punched_at", ascending: true }],
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Live board + exception queue
// -----------------------------------------------------------------------------

export const todayBoardRowSchema = z.object({
  employee_id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  photo_path: z.string().nullable(),
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  ist_date: dbDate,
  attendance_day_id: dbUuidNullable,
  status: attendanceStatusSchema.nullable(),
  shift_id: dbUuidNullable,
  shift_code: z.string().nullable(),
  shift_display_label: z.string().nullable(),
  shift_start_at: dbTimestampNullable,
  expected_by: dbTimestampNullable,
  first_in_at: dbTimestampNullable,
  first_in_hm: z.string().nullable(),
  last_out_at: dbTimestampNullable,
  last_out_hm: z.string().nullable(),
  punch_count: dbInt,
  worked_minutes: dbInt,
  worked_hm: z.string().nullable(),
  is_late: z.boolean(),
  late_minutes: dbInt,
  web_punch_count: dbInt,
  /** The board's own state flags — the tiles branch on these, never recompute. */
  attended: z.boolean(),
  off_today: z.boolean(),
  yet_to_reach: z.boolean(),
  late_in: z.boolean(),
  on_time: z.boolean(),
  overdue: z.boolean(),
  /*
    OVERTIME AND ITS THREE NEIGHBOURS, added to the view by migration 039200.

    Four columns rather than one because they answer different questions and
    conflating them is how an overtime figure stops being trusted:
      overtime_minutes           what the engine computed for a normal working day
      approved_overtime_minutes  what a manager signed off — what payroll actually pays
      extra_work_minutes         time on a weekly off or holiday, which is NOT overtime
                                 and earns comp-off instead
      early_exit_minutes         the mirror of late_minutes
  */
  overtime_minutes: dbIntNullable,
  approved_overtime_minutes: dbIntNullable,
  extra_work_minutes: dbIntNullable,
  early_exit_minutes: dbIntNullable,
});
export type TodayBoardRow = z.infer<typeof todayBoardRowSchema>;

export interface TodayBoardFilters {
  readonly departmentIds?: readonly string[];
  /** 'in' | 'yet_to_reach' | 'off' | 'late' | 'overdue' — the tile drill-downs. */
  readonly state?: "in" | "yet_to_reach" | "off" | "late" | "overdue";
}

export function fetchTodayBoard(
  f: TodayBoardFilters,
  signal?: AbortSignal,
): Promise<TodayBoardRow[]> {
  const filters: Filter[] = [];
  if (f.departmentIds && f.departmentIds.length > 0) filters.push(inList("department_id", f.departmentIds));
  if (f.state === "in") filters.push({ op: "is", column: "attended", value: true });
  if (f.state === "yet_to_reach") filters.push({ op: "is", column: "yet_to_reach", value: true });
  if (f.state === "off") filters.push({ op: "is", column: "off_today", value: true });
  if (f.state === "late") filters.push({ op: "is", column: "late_in", value: true });
  if (f.state === "overdue") filters.push({ op: "is", column: "overdue", value: true });
  return selectMany(V_TODAY_BOARD, todayBoardRowSchema, {
    filters,
    order: [{ column: "display_name", ascending: true }],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

export const exceptionRowSchema = z.object({
  exception_kind: z.string(),
  severity: z.string(),
  entity_table: z.string(),
  entity_id: dbUuid,
  employee_id: dbUuidNullable,
  ist_date: dbDateNullable,
  /** Human sentence built by the view, e.g. 'Anomalies: single_punch_only…'. */
  description: z.string(),
  occurred_at: dbTimestamp,
});
export type ExceptionRow = z.infer<typeof exceptionRowSchema>;

export interface ExceptionFilters {
  readonly from?: string;
  readonly to?: string;
  readonly kinds?: readonly string[];
  readonly severities?: readonly string[];
  /**
   * Scope the queue to named employees.
   *
   * `v_exception_queue` has published `employee_id` all along and this filter did not
   * exist, so "this employee's exceptions" could not be asked for — which is why the
   * employee record linked to the attendance screen instead and left the exception queue
   * unreachable per person.
   */
  readonly employeeIds?: readonly string[];
}

/** One predicate builder, so the queue and its per-kind counts cannot disagree. */
function exceptionFilters(f: ExceptionFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.from !== undefined) filters.push(gte("ist_date", f.from));
  if (f.to !== undefined) filters.push(lte("ist_date", f.to));
  if (f.kinds && f.kinds.length > 0) filters.push(inList("exception_kind", f.kinds));
  if (f.severities && f.severities.length > 0) filters.push(inList("severity", f.severities));
  if (f.employeeIds && f.employeeIds.length > 0)
    filters.push(inList("employee_id", f.employeeIds));
  return filters;
}

export function fetchExceptionQueue(
  f: ExceptionFilters,
  limit = 200,
  signal?: AbortSignal,
): Promise<ExceptionRow[]> {
  const filters = exceptionFilters(f);
  return selectMany(V_EXCEPTION_QUEUE, exceptionRowSchema, {
    filters,
    order: [{ column: "occurred_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/**
 * How many exceptions match — counted by Postgres over the SAME predicate as
 * `fetchExceptionQueue`. The Exception Dashboard's per-kind figure must be the
 * cardinality of the list that kind opens, not the length of a capped page: the
 * queue read is limited to 200 rows, so `rows.length` would silently plateau at
 * 200 and a growing problem would look stable (DR-29).
 */
export function countExceptionQueue(f: ExceptionFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_EXCEPTION_QUEUE, exceptionFilters(f), { ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// 5. Period locks (`/admin/attendance/locks`) — the one writable table here
// -----------------------------------------------------------------------------

export const lockSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  scope: z.string(),
  location_id: dbUuidNullable,
  department_id: dbUuidNullable,
  employee_id: dbUuidNullable,
  pay_period_id: dbUuidNullable,
  from_date: dbDate,
  to_date: dbDate,
  lock_kind: z.string(),
  reason: z.string(),
  locked_by: dbUuid,
  locked_at: dbTimestamp,
  unlocked_by: dbUuidNullable,
  unlocked_at: dbTimestampNullable,
  unlock_reason: z.string().nullable(),
});
export type AttendanceLock = z.infer<typeof lockSchema>;

export function fetchLocks(
  opts: { onlyOpen?: boolean } = {},
  signal?: AbortSignal,
): Promise<AttendanceLock[]> {
  const filters: Filter[] = [];
  if (opts.onlyOpen === true) filters.push(isNull("unlocked_at"));
  return selectMany(ATTENDANCE_LOCKS_TABLE, lockSchema, {
    filters,
    order: [{ column: "from_date", ascending: false }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

export interface CreateLockInput {
  readonly companyId: string;
  readonly fromDate: string;
  readonly toDate: string;
  /** 'company' | 'location' | 'department' | 'employee'. */
  readonly scope: string;
  readonly locationId?: string;
  readonly departmentId?: string;
  readonly employeeId?: string;
  readonly payPeriodId?: string;
  /** 'soft' (admin) or 'hard' (super admin only, RLS-enforced). */
  readonly lockKind?: "soft" | "hard";
  readonly lockedBy: string;
}

/**
 * Lock a period. `attendance_locks` is in `audit.reason_required_tables` AND the
 * table has a NOT NULL `reason` column, so the sentence is written twice: once as
 * data the Locks grid renders, once as the audit row. Always prompts.
 */
export function createLock(
  input: CreateLockInput,
  reason: string,
  signal?: AbortSignal,
): Promise<AttendanceLock> {
  return insertRow(
    ATTENDANCE_LOCKS_TABLE,
    {
      company_id: input.companyId,
      scope: input.scope,
      from_date: input.fromDate,
      to_date: input.toDate,
      lock_kind: input.lockKind ?? "soft",
      reason: reason.trim(),
      locked_by: input.lockedBy,
      ...(input.locationId !== undefined ? { location_id: input.locationId } : {}),
      ...(input.departmentId !== undefined ? { department_id: input.departmentId } : {}),
      ...(input.employeeId !== undefined ? { employee_id: input.employeeId } : {}),
      ...(input.payPeriodId !== undefined ? { pay_period_id: input.payPeriodId } : {}),
    },
    lockSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, ...(signal ? { signal } : {}) },
  );
}

/**
 * Unlock. RLS restricts the UPDATE to super_admin (`attendance_locks__super_update`),
 * so an admin attempt returns zero rows and surfaces as `not_found` — the screen
 * should hide the action unless the caller holds `admin.super`.
 */
export function unlockPeriod(
  lockId: string,
  unlockedBy: string,
  reason: string,
  signal?: AbortSignal,
): Promise<AttendanceLock> {
  return updateRow(
    ATTENDANCE_LOCKS_TABLE,
    [eq("id", lockId), isNull("unlocked_at")],
    { unlocked_at: nowInstantIso(), unlocked_by: unlockedBy, unlock_reason: reason.trim() },
    lockSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 6. Writes that are NOT PostgREST writes — edge functions only
// -----------------------------------------------------------------------------

/**
 * `void-punch` reason codes, prefixed onto the human reason as
 * `"<code>: <sentence>"`. The DB column is free text with a ≥10-character CHECK
 * rather than an enum, so the code is a greppable machine-readable prefix.
 *
 * THIS ARRAY MUST EQUAL `VOID_REASON_CODES` in
 * `supabase/functions/void-punch/index.ts`. That function validates the body with
 * `z.enum(VOID_REASON_CODES)` inside a `.strict()` object, so a code this client
 * offers but the function does not know is a 422 AFTER the admin has typed their
 * reason — the exact failure `useAuditedMutation` validates the reason locally to
 * avoid. It previously listed six invented codes (`duplicate_scan`,
 * `wrong_person`, `device_error`, `test_scan`, `clock_skew`, `abuse_confirmed`),
 * none of which the deployed function accepts; only `admin_void` overlapped.
 */
export const voidReasonCodes = [
  "admin_void",
  "reassigned",
  "import_correction",
  "debounce",
  "rate_limit_day",
  "spoof_rejected",
] as const;
export type VoidReasonCode = (typeof voidReasonCodes)[number];

const voidResultSchema = z
  .object({
    punch_id: dbUuid.optional(),
    void_reason_code: z.string().optional(),
  })
  .passthrough();

/**
 * Void a punch. Punches are immutable evidence — the remedy is void + insert, and
 * there is no UPDATE endpoint. The edge function sets the four void columns
 * inside one transaction with the audit row.
 */
export function voidPunch(
  input: { punchId: string; punchedAt?: string; voidReasonCode?: VoidReasonCode },
  reason: string,
  idempotencyKey?: string,
): Promise<z.infer<typeof voidResultSchema>> {
  return invokeEdgeFn(
    "void-punch",
    {
      punchId: input.punchId,
      ...(input.punchedAt !== undefined ? { punchedAt: input.punchedAt } : {}),
      voidReasonCode: input.voidReasonCode ?? "admin_void",
      reason: reason.trim(),
    },
    voidResultSchema,
    { idempotencyKey: idempotencyKey ?? newIdempotencyKey() },
  );
}

const recomputeResultSchema = z
  .object({
    mode: z.string().optional(),
    changed_days: z.number().nullable().optional(),
    done: z.boolean().optional(),
  })
  .passthrough();

/**
 * Recompute Console (§5.6). `dry_run` writes nothing and returns the diff;
 * `commit` applies it. This is also the ONLY sanctioned way to change what a day
 * means, because `attendance_days` is derived and not client-writable.
 */
export function recomputeAttendance(
  input: {
    from: string;
    to: string;
    employeeIds?: readonly string[];
    mode: "dry_run" | "commit";
    overrideLock?: boolean;
  },
  reason: string,
  idempotencyKey?: string,
): Promise<z.infer<typeof recomputeResultSchema>> {
  return invokeEdgeFn(
    "attendance-recompute",
    {
      from: input.from,
      to: input.to,
      mode: input.mode,
      reason: reason.trim(),
      overrideLock: input.overrideLock ?? false,
      ...(input.employeeIds && input.employeeIds.length > 0
        ? { employeeIds: [...input.employeeIds] }
        : {}),
    },
    recomputeResultSchema,
    { idempotencyKey: idempotencyKey ?? newIdempotencyKey() },
  );
}
