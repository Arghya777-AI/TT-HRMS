/**
 * attendance.api.ts — every attendance read, and nothing else.
 *
 * Schemas mirror the DEPLOYED views in
 * `supabase/migrations/20260801003400_views_attendance.sql` column for column.
 * Where spec-employee §3.6 names a column the deployed view does not have, the
 * column is ABSENT here rather than reconstructed on the client — see the
 * "Columns the deployed view does not expose" note below.
 *
 * NO ARITHMETIC. Not a sum, not an average, not a percentage. Every number a
 * KPI tile shows comes from a named column of `f_attendance_period_summary`,
 * which is the single implementation the payslip also reads. That is what makes
 * the dashboard-vs-modal disagreement (spec-screens) unrepresentable.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumeric,
  dbNumericNullable,
  dbPercentNullable,
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

// -----------------------------------------------------------------------------
// Enums, straight from migration 003
// -----------------------------------------------------------------------------

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

export const attendanceDaySourceSchema = z.enum([
  "computed",
  "regularized",
  "admin_override",
  "imported",
  "leave_applied",
  "holiday_calendar",
  "roster_absence",
]);

/** Derived in the view: first punch of the business date = IN, last = OUT. */
export const punchDerivedDirectionSchema = z.enum(["IN", "OUT", "SCAN"]);

export const punchSourceSchema = z.enum([
  "kiosk_face",
  "kiosk_fingerprint",
  "kiosk_card",
  "kiosk_manual",
  "web",
  "mobile",
  "biometric_device",
  "manual_admin",
  "import",
  "system_regularization",
]);

// -----------------------------------------------------------------------------
// 1. THE one summary row — f_attendance_period_summary / v_attendance_period_summary
// -----------------------------------------------------------------------------

/**
 * `f_attendance_period_summary(p_from, p_to, p_employee_id)` RETURNS TABLE.
 *
 * `v_attendance_period_summary` is a ZERO-ARGUMENT wrapper hard-pinned to
 * month-to-date (`date_trunc('month', ist_today()) .. ist_today()`). Any other
 * period — including a whole past month — MUST go through the function, which is
 * why `fetchPeriodSummary` uses the RPC and only `fetchMonthToDateSummary`
 * reads the view. Both are the same SQL, so they cannot disagree.
 *
 * Columns the deployed view does NOT expose (do not invent them client-side):
 *   elapsed_days, remaining_days, leave_days_unpaid, missing_punch_days,
 *   at_risk_days, extra_working_days, worked_days_count,
 *   ot_eligible_minutes_total, computed_at, computed_version.
 * `attendance_pct` here divides paid_days by TOTAL days in the period, not by
 * elapsed days as spec §3.7 K17 requires.
 */
export const attendancePeriodSummarySchema = z.object({
  employee_id: dbUuid,
  from_date: dbDate,
  to_date: dbDate,
  total_days: dbInt,
  present_days: dbInt,
  half_days: dbInt,
  absent_days: dbInt,
  /** Days the engine has not resolved yet. Never folded into absents. */
  pending_days: dbInt,
  weekly_off_days: dbInt,
  holiday_days: dbInt,
  leave_days: dbNumeric,
  comp_off_days: dbInt,
  /** THE Paid Days definition: SUM(day_fraction_paid). */
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
  /** NULL when the denominator is 0 — render '—', never 0. */
  avg_worked_minutes_per_present_day: dbNumericNullable,
  avg_worked_minutes_per_working_day: dbNumericNullable,
  /** Already a percentage, clamped [0,100] by fn_late_pct. NULL if no working days. */
  late_pct: dbPercentNullable,
  attendance_pct: dbPercentNullable,
  late_deduction_leave_days: dbNumeric,
  break_minutes: dbInt,
  break_count: dbInt,
  avg_breaks_per_present_day: dbNumericNullable,
});

export type AttendancePeriodSummary = z.infer<typeof attendancePeriodSummarySchema>;

export const PERIOD_SUMMARY_FN = "f_attendance_period_summary";
export const PERIOD_SUMMARY_VIEW = "v_attendance_period_summary";
export const DAY_ENRICHED_VIEW = "v_attendance_day_enriched";
export const PUNCH_DETAIL_VIEW = "v_attendance_punch_detail";

export interface PeriodRange {
  /** Inclusive 'YYYY-MM-DD'. */
  readonly from: string;
  /** Inclusive 'YYYY-MM-DD'. */
  readonly to: string;
}

/**
 * The summary row for an arbitrary inclusive period. Returns `null` when the
 * period contains no attendance_days rows for the employee (a month before the
 * date of joining, or a period RLS withholds) — the caller renders the empty or
 * no-permission state; it must not substitute zeroes.
 */
export async function fetchPeriodSummary(
  employeeId: string,
  range: PeriodRange,
  signal?: AbortSignal,
): Promise<AttendancePeriodSummary | null> {
  return rpcOne(
    PERIOD_SUMMARY_FN,
    { p_from: range.from, p_to: range.to, p_employee_id: employeeId },
    attendancePeriodSummarySchema,
    signal ? { signal } : {},
  );
}

/** The month-to-date row, read from the view wrapper. Same SQL as the RPC. */
export async function fetchMonthToDateSummary(
  employeeId: string,
  signal?: AbortSignal,
): Promise<AttendancePeriodSummary | null> {
  return selectOne(
    PERIOD_SUMMARY_VIEW,
    attendancePeriodSummarySchema,
    [eq("employee_id", employeeId)],
    signal ? { signal } : {},
  );
}

/**
 * Summary rows for several employees over one period (manager surfaces).
 * `p_employee_id = null` lets RLS decide the scope.
 */
export async function fetchPeriodSummaryForScope(
  range: PeriodRange,
  signal?: AbortSignal,
): Promise<AttendancePeriodSummary[]> {
  return rpcMany(
    PERIOD_SUMMARY_FN,
    { p_from: range.from, p_to: range.to, p_employee_id: null },
    attendancePeriodSummarySchema,
    signal ? { signal } : {},
  );
}

// -----------------------------------------------------------------------------
// 2. v_attendance_day_enriched — one row per date
// -----------------------------------------------------------------------------

/** Mirrors v_attendance_day_enriched (034 §1) exactly. */
export const attendanceDaySchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  photo_path: z.string().nullable(),
  ist_date: dbDate,
  status: attendanceStatusSchema,
  status_source: attendanceDaySourceSchema.nullable(),
  department_name: z.string().nullable(),
  section_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  location_name: z.string().nullable(),
  shift_id: dbUuidNullable,
  shift_code: z.string().nullable(),
  /** Render this, never `shift_code` (spec §3.3: never a bare code on screen). */
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
  leave_day_fraction: dbNumericNullable,
  first_in_at: dbTimestampNullable,
  last_out_at: dbTimestampNullable,
  /** Server-rendered 'HH24:MI' in IST. Prefer fmtTime(first_in_at) for display. */
  first_in_hm: z.string().nullable(),
  last_out_hm: z.string().nullable(),
  punch_count: dbInt,
  gross_span_minutes: dbIntNullable,
  break_minutes: dbIntNullable,
  break_count: dbIntNullable,
  total_worked_minutes: dbIntNullable,
  payable_worked_minutes: dbIntNullable,
  /** Server 'H:MM' text. fmtDurationHm(total_worked_minutes) is the display form. */
  worked_hm: z.string().nullable(),
  is_late: z.boolean(),
  late_minutes: dbIntNullable,
  late_hm: z.string().nullable(),
  is_early_exit: z.boolean(),
  early_exit_minutes: dbIntNullable,
  overtime_minutes: dbIntNullable,
  approved_overtime_minutes: dbIntNullable,
  extra_work_minutes: dbIntNullable,
  day_fraction_paid: dbNumericNullable,
  late_deduction_leave_days: dbNumericNullable,
  is_holiday: z.boolean(),
  is_weekly_off: z.boolean(),
  is_working_day: z.boolean(),
  manual_override_status: z.boolean().nullable(),
  manual_override_times: z.boolean().nullable(),
  manual_override_reason: z.string().nullable(),
  is_regularized: z.boolean(),
  regularization_id: dbUuidNullable,
  anomaly_flags: z.array(z.string()).nullable(),
  has_anomalies: z.boolean().nullable(),
  is_locked: z.boolean(),
  computed_at: dbTimestampNullable,
  computed_version: dbIntNullable,
});

export type AttendanceDay = z.infer<typeof attendanceDaySchema>;

/** Every date in an inclusive range, oldest first. One row per date. */
export async function fetchAttendanceDays(
  employeeId: string,
  range: PeriodRange,
  signal?: AbortSignal,
): Promise<AttendanceDay[]> {
  return selectMany(DAY_ENRICHED_VIEW, attendanceDaySchema, {
    filters: [eq("employee_id", employeeId), gte("ist_date", range.from), lte("ist_date", range.to)],
    order: [{ column: "ist_date", ascending: true }],
    // A calendar month cannot exceed 31 rows; the cap is a guard, not paging.
    limit: 400,
    ...(signal ? { signal } : {}),
  });
}

/** One date. `null` = no row computed yet, or not visible to the caller. */
export async function fetchAttendanceDay(
  employeeId: string,
  istDate: string,
  signal?: AbortSignal,
): Promise<AttendanceDay | null> {
  return selectOne(
    DAY_ENRICHED_VIEW,
    attendanceDaySchema,
    [eq("employee_id", employeeId), eq("ist_date", istDate)],
    signal ? { signal } : {},
  );
}

// -----------------------------------------------------------------------------
// 3. v_attendance_punch_detail — the per-scan drill-down
// -----------------------------------------------------------------------------

/**
 * Mirrors v_attendance_punch_detail (034 §2).
 *
 * `match_confidence` and `confidence_badge` exist on the view but spec-employee
 * §5 E-03 forbids showing a match score to an employee (defect A12). Render
 * `source_label`; leave the score for admin surfaces only.
 */
export const attendancePunchSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  punched_at: dbTimestampNullable,
  ist_date: dbDateNullable,
  ist_time: z.string().nullable(),
  /** The business date the punch is filed under (night shifts differ from ist_date). */
  effective_date: dbDate,
  ist_time_display: z.string().nullable(),
  /** The raw stored direction; may be null. Prefer derived_direction. */
  direction: z.string().nullable(),
  derived_direction: punchDerivedDirectionSchema,
  source: punchSourceSchema,
  /** Human label — 'Kiosk — Face'. Never render `source`. */
  source_label: z.string().nullable(),
  kiosk_device_id: dbUuidNullable,
  device_label: z.string().nullable(),
  operator_id: dbUuidNullable,
  operator_name: z.string().nullable(),
  match_confidence: dbNumericNullable,
  confidence_badge: z.enum(["high", "medium", "low"]).nullable(),
  /** Storage path only. A signed URL is minted per request; never rendered raw. */
  photo_path: z.string().nullable(),
  lat: dbNumericNullable,
  lng: dbNumericNullable,
  /**
   * Metres of horizontal uncertainty the device itself reported; NULL when it
   * reported none, which is NOT the same as "accurate". Projected by migration 076
   * — it had been written to `attendance_punches` since the first located punch but
   * was missing from the view, so the UI could show a coordinate to six decimal
   * places with no way to say how much of it to believe.
   */
  location_accuracy_m: dbNumericNullable,
  geofence_ok: z.boolean().nullable(),
  is_offline_replay: z.boolean().nullable(),
  needs_review: z.boolean().nullable(),
  is_voided: z.boolean(),
  voided_at: dbTimestampNullable,
  void_reason: z.string().nullable(),
  reason: z.string().nullable(),
  operator_note: z.string().nullable(),
  recorded_at: dbTimestampNullable,
});

export type AttendancePunch = z.infer<typeof attendancePunchSchema>;

/**
 * Every scan filed under one business date, chronological.
 * Filters on `effective_date`, NOT `ist_date`: a night-shift punch after
 * midnight belongs to the previous business day. Voided punches are already
 * excluded by the view.
 */
export async function fetchPunchesForDay(
  employeeId: string,
  effectiveDate: string,
  signal?: AbortSignal,
): Promise<AttendancePunch[]> {
  return selectMany(PUNCH_DETAIL_VIEW, attendancePunchSchema, {
    filters: [eq("employee_id", employeeId), eq("effective_date", effectiveDate)],
    order: [{ column: "punched_at", ascending: true }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Which punches of a day the engine treated as duplicates.
 *
 * `v_attendance_punch_detail` does not project `duplicate_of_punch_id`, and the
 * timeline has to strike the collapsed scan through rather than show it as a
 * real event (spec-employee §3.1: two scans within 120s collapse, the later one
 * is stored `duplicate_of_punch_id = <earlier>`). So this reads the flag column
 * off the append-only log itself, under the `attendance_punches__self_read` RLS
 * policy — two ids and nothing else, no PII, no match score, no aggregate.
 */
export const punchDuplicateFlagSchema = z.object({
  id: dbUuid,
  duplicate_of_punch_id: dbUuidNullable,
});

export type PunchDuplicateFlag = z.infer<typeof punchDuplicateFlagSchema>;

export const PUNCHES_TABLE = "attendance_punches";

export async function fetchPunchDuplicateFlags(
  employeeId: string,
  effectiveDate: string,
  signal?: AbortSignal,
): Promise<PunchDuplicateFlag[]> {
  return selectMany(PUNCHES_TABLE, punchDuplicateFlagSchema, {
    filters: [eq("employee_id", employeeId), eq("effective_date", effectiveDate)],
    columns: "id, duplicate_of_punch_id",
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Period context — the reference rows the banner and the register need
// -----------------------------------------------------------------------------

export const MY_EMPLOYEE_VIEW = "v_my_employee";
export const SHIFTS_TABLE = "shifts";
export const WEEKLY_OFF_RULES_TABLE = "weekly_off_rules";
export const PAY_PERIODS_TABLE = "pay_periods";

/**
 * The caller's own row, narrowed to what E-03 needs: the join date bounds the
 * period selector (there is no attendance before it), and the two policy ids
 * resolve to the shift and weekly-off chips on the banner.
 */
export const myAttendanceContextSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  /** NULL on a record created before the join date was set. */
  date_of_join: dbDateNullable,
  shift_id: dbUuidNullable,
  weekly_off_rule_id: dbUuidNullable,
});

export type MyAttendanceContext = z.infer<typeof myAttendanceContextSchema>;

/** `null` = no employee record on this login (kiosk-only staff). */
export async function fetchMyAttendanceContext(
  signal?: AbortSignal,
): Promise<MyAttendanceContext | null> {
  return selectOne(MY_EMPLOYEE_VIEW, myAttendanceContextSchema, [], {
    columns: "id, employee_code, display_name, date_of_join, shift_id, weekly_off_rule_id",
    ...(signal ? { signal } : {}),
  });
}

/**
 * Shift master rows, by id. The register renders `name` + the window built from
 * `start_time`/`end_time`; it never renders `code` or `display_label` (the DB
 * builds that as `G — 09:30 AM to 06:30 PM`, a bare code on a 12-hour clock,
 * both banned by §3.3/§8).
 */
export const shiftRefSchema = z.object({
  id: dbUuid,
  name: z.string(),
  /** Postgres `time` — format with fmtCivilTime, never new Date(). */
  start_time: z.string(),
  end_time: z.string(),
  crosses_midnight: z.boolean(),
  unpaid_break_minutes: dbInt,
});

export type ShiftRefRow = z.infer<typeof shiftRefSchema>;

export async function fetchShiftsByIds(
  shiftIds: readonly string[],
  signal?: AbortSignal,
): Promise<ShiftRefRow[]> {
  if (shiftIds.length === 0) return [];
  return selectMany(SHIFTS_TABLE, shiftRefSchema, {
    filters: [inList("id", shiftIds)],
    columns: "id, name, start_time, end_time, crosses_midnight, unpaid_break_minutes",
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `weekly_off_rules.name` is already the sentence a person reads ("Sunday +
 * 2nd & 4th Saturday", DR-60). The client must never assemble one out of
 * `first_off_dow` / `first_off_weeks`.
 */
export const weeklyOffRuleRefSchema = z.object({
  id: dbUuid,
  name: z.string(),
  description: z.string().nullable(),
});

export type WeeklyOffRuleRef = z.infer<typeof weeklyOffRuleRefSchema>;

export async function fetchWeeklyOffRuleRef(
  ruleId: string,
  signal?: AbortSignal,
): Promise<WeeklyOffRuleRef | null> {
  return selectOne(WEEKLY_OFF_RULES_TABLE, weeklyOffRuleRefSchema, [eq("id", ruleId)], {
    columns: "id, name, description",
    ...(signal ? { signal } : {}),
  });
}

/**
 * The published pay period whose `code` is the 'YYYY-MM' month.
 *
 * This is what makes the arrears line honest rather than a hard-coded "25th":
 * `attendance_cutoff_date` is a real column, and `attendance_locked_at` is what
 * decides whether a day can still be corrected (§3.2). Nothing is computed here
 * — the banner states the two dates the row carries.
 */
export const payPeriodSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  start_date: dbDate,
  end_date: dbDate,
  attendance_cutoff_date: dbDate,
  pay_date: dbDate,
  is_open: z.boolean(),
  attendance_locked_at: dbTimestampNullable,
});

export type PayPeriod = z.infer<typeof payPeriodSchema>;

/** `null` = no pay period published for that month yet. */
export async function fetchPayPeriodByCode(
  code: string,
  signal?: AbortSignal,
): Promise<PayPeriod | null> {
  return selectOne(PAY_PERIODS_TABLE, payPeriodSchema, [eq("code", code)], {
    columns:
      "id, code, name, start_date, end_date, attendance_cutoff_date, pay_date, is_open, attendance_locked_at",
    ...(signal ? { signal } : {}),
  });
}

/** Punches across a range — for an export or the day-detail prefetch. */
export async function fetchPunchesInRange(
  employeeId: string,
  range: PeriodRange,
  signal?: AbortSignal,
): Promise<AttendancePunch[]> {
  const filters: readonly Filter[] = [
    eq("employee_id", employeeId),
    gte("effective_date", range.from),
    lte("effective_date", range.to),
  ];
  return selectMany(PUNCH_DETAIL_VIEW, attendancePunchSchema, {
    filters,
    order: [
      { column: "effective_date", ascending: true },
      { column: "punched_at", ascending: true },
    ],
    limit: 2000,
    ...(signal ? { signal } : {}),
  });
}
