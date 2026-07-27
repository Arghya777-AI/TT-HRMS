/**
 * employment.api.ts — the policy rows behind E-07 Tab 2, read so the tab can
 * state them in PLAIN LANGUAGE.
 *
 * The reference product printed `Late: None1`, `Swipe Attendance: SinglePunch`,
 * `Pay Period: PP001`, `Shift: G --- 09:30 AM - 06:30 PM` and two rows of
 * `Weeks 1,2,3,4,5` (DR-53, DR-60). None of those strings tell an employee
 * anything. So this module reads the POLICY ROWS — not codes — and the display
 * layer (`display.ts`) turns each into a sentence.
 *
 * Two deliberate omissions:
 *  - `shifts.display_label` is never selected. The database builds it as
 *    `G — 09:30 AM to 06:30 PM`: a bare code plus a 12-hour clock, both banned
 *    by spec-employee §8. `start_time`/`end_time` go through `fmtCivilTime`.
 *  - No minute arithmetic happens here or in the pages. `duration_minutes`,
 *    `unpaid_break_minutes` and the grace windows are server columns rendered
 *    with `fmtDuration`; nothing is summed to produce a "net hours" figure.
 */
import { z } from "zod";
import { dbDate, dbDateNullable, dbInt, dbIntNullable, dbNumeric, dbTimestampNullable, dbUuid, eq, selectMany, selectOne } from "@/shared/api/query";

export const SHIFTS_TABLE = "shifts";
export const WEEKLY_OFF_RULES_TABLE = "weekly_off_rules";
export const ATTENDANCE_POLICIES_TABLE = "attendance_policies";
export const PAY_PERIODS_TABLE = "pay_periods";
export const HOLIDAY_CALENDARS_TABLE = "holiday_calendars";
export const SWIPE_CARDS_TABLE = "employee_swipe_cards";

// -----------------------------------------------------------------------------
// 1. Shift
// -----------------------------------------------------------------------------

export const shiftSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  /** Postgres `time` — 'HH:MM:SS'. Format with fmtCivilTime, never new Date(). */
  start_time: z.string(),
  end_time: z.string(),
  crosses_midnight: z.boolean(),
  duration_minutes: dbInt,
  unpaid_break_minutes: dbInt,
  paid_break_minutes: dbInt,
  grace_in_minutes: dbInt,
  grace_out_minutes: dbInt,
  half_day_minutes: dbInt,
  full_day_minutes: dbInt,
  night_shift: z.boolean(),
});

export type Shift = z.infer<typeof shiftSchema>;

const SHIFT_COLUMNS =
  "id, code, name, start_time, end_time, crosses_midnight, duration_minutes, " +
  "unpaid_break_minutes, paid_break_minutes, grace_in_minutes, grace_out_minutes, " +
  "half_day_minutes, full_day_minutes, night_shift";

export async function fetchShift(shiftId: string, signal?: AbortSignal): Promise<Shift | null> {
  return selectOne(SHIFTS_TABLE, shiftSchema, [eq("id", shiftId)], {
    columns: SHIFT_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Weekly-off rule
// -----------------------------------------------------------------------------

/**
 * `first_off_dow` / `second_off_dow` / `third_off_dow` are 0=Sunday .. 6=Saturday.
 * The `*_weeks` arrays are weeks-of-month (1..5) that the off applies to;
 * `{1,2,3,4,5}` means "every week". `rule_kind = 'roster_driven'` means the
 * published roster grants the off and `offs_per_week` is the statutory floor.
 */
export const weeklyOffRuleSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  rule_kind: z.enum(["fixed_weekdays", "rotational", "roster_driven", "days_per_week"]),
  first_off_dow: dbIntNullable,
  first_off_weeks: z.array(dbInt).nullable(),
  second_off_dow: dbIntNullable,
  second_off_weeks: z.array(dbInt).nullable(),
  third_off_dow: dbIntNullable,
  third_off_weeks: z.array(dbInt).nullable(),
  offs_per_week: dbIntNullable,
  half_day_dow: dbIntNullable,
  is_rotational: z.boolean(),
  rotation_anchor_date: dbDateNullable,
});

export type WeeklyOffRule = z.infer<typeof weeklyOffRuleSchema>;

const WEEKLY_OFF_COLUMNS =
  "id, code, name, description, rule_kind, first_off_dow, first_off_weeks, " +
  "second_off_dow, second_off_weeks, third_off_dow, third_off_weeks, " +
  "offs_per_week, half_day_dow, is_rotational, rotation_anchor_date";

export async function fetchWeeklyOffRule(
  ruleId: string,
  signal?: AbortSignal,
): Promise<WeeklyOffRule | null> {
  return selectOne(WEEKLY_OFF_RULES_TABLE, weeklyOffRuleSchema, [eq("id", ruleId)], {
    columns: WEEKLY_OFF_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Attendance policy
// -----------------------------------------------------------------------------

export const attendancePolicySchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  grace_in_minutes: dbInt,
  grace_out_minutes: dbInt,
  max_late_days_before_deduction: dbInt,
  late_deduction_leave_days: dbNumeric,
  late_deduction_reset_period: z.enum(["calendar_month", "pay_period"]),
  auto_deduct_break: z.boolean(),
  overtime_enabled: z.boolean(),
  overtime_requires_approval: z.boolean(),
  overtime_min_minutes: dbInt,
  overtime_multiplier: dbNumeric,
  extra_work_compensation: z.enum(["comp_off", "paid", "both", "none"]),
  comp_off_min_minutes: dbInt,
  comp_off_full_day_minutes: dbInt,
  comp_off_expiry_days: dbInt,
  single_punch_treatment: z.enum([
    "absent", "half_day", "present_flag_review", "half_day_flag_review",
  ]),
  regularization_window_days: dbInt,
  max_regularizations_per_month: dbInt,
  absent_marking_delay_hours: dbInt,
  allow_web_punch: z.boolean(),
});

export type AttendancePolicy = z.infer<typeof attendancePolicySchema>;

const ATTENDANCE_POLICY_COLUMNS =
  "id, code, name, description, grace_in_minutes, grace_out_minutes, " +
  "max_late_days_before_deduction, late_deduction_leave_days, " +
  "late_deduction_reset_period, auto_deduct_break, overtime_enabled, " +
  "overtime_requires_approval, overtime_min_minutes, overtime_multiplier, " +
  "extra_work_compensation, comp_off_min_minutes, comp_off_full_day_minutes, " +
  "comp_off_expiry_days, single_punch_treatment, regularization_window_days, " +
  "max_regularizations_per_month, absent_marking_delay_hours, allow_web_punch";

export async function fetchAttendancePolicy(
  policyId: string,
  signal?: AbortSignal,
): Promise<AttendancePolicy | null> {
  return selectOne(ATTENDANCE_POLICIES_TABLE, attendancePolicySchema, [eq("id", policyId)], {
    columns: ATTENDANCE_POLICY_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Pay period
// -----------------------------------------------------------------------------

/**
 * The employee's assigned pay period. `name` is already human in this database
 * ("July 2026 (26 Jun – 25 Jul)"), and `attendance_cutoff_date` is the real
 * cutoff — surfaced as a stated line, never as a 25-day "month" (DR-34).
 */
export const payPeriodSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  period_kind: z.enum(["monthly", "fortnightly", "weekly"]),
  start_date: dbDate,
  end_date: dbDate,
  attendance_cutoff_date: dbDate,
  pay_date: dbDate,
  financial_year: z.string(),
  month_days_basis: z.enum(["actual", "fixed_30", "fixed_26"]),
  is_open: z.boolean(),
  attendance_locked_at: dbTimestampNullable,
});

export type PayPeriod = z.infer<typeof payPeriodSchema>;

const PAY_PERIOD_COLUMNS =
  "id, code, name, period_kind, start_date, end_date, attendance_cutoff_date, " +
  "pay_date, financial_year, month_days_basis, is_open, attendance_locked_at";

export async function fetchPayPeriod(
  payPeriodId: string,
  signal?: AbortSignal,
): Promise<PayPeriod | null> {
  return selectOne(PAY_PERIODS_TABLE, payPeriodSchema, [eq("id", payPeriodId)], {
    columns: PAY_PERIOD_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. Holiday calendar
// -----------------------------------------------------------------------------

export const holidayCalendarSchema = z.object({
  id: dbUuid,
  name: z.string(),
  year: dbInt,
  state: z.string().nullable(),
  optional_holiday_quota: dbInt,
});

export type HolidayCalendar = z.infer<typeof holidayCalendarSchema>;

export async function fetchHolidayCalendar(
  calendarId: string,
  signal?: AbortSignal,
): Promise<HolidayCalendar | null> {
  return selectOne(HOLIDAY_CALENDARS_TABLE, holidayCalendarSchema, [eq("id", calendarId)], {
    columns: "id, name, year, state, optional_holiday_quota",
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 6. Swipe cards (Card 2.3)
// -----------------------------------------------------------------------------

/**
 * `valid_to IS NULL` means no expiry — the database CHECK forbids a year-3000
 * sentinel, so the UI renders "No expiry" and never `01-Jan-3000` (DR-19).
 */
export const swipeCardSchema = z.object({
  id: dbUuid,
  card_number: z.string(),
  card_technology: z.enum(["mifare", "em4100", "hid_prox", "qr"]).nullable(),
  issued_on: dbDate,
  valid_from: dbDate,
  valid_to: dbDateNullable,
  status: z.enum([
    "requested", "approved", "active", "lost", "damaged", "returned", "revoked",
    "reported_lost",
  ]),
  returned_on: dbDateNullable,
  remarks: z.string().nullable(),
});

export type SwipeCard = z.infer<typeof swipeCardSchema>;

export async function fetchSwipeCards(
  employeeId: string,
  signal?: AbortSignal,
): Promise<SwipeCard[]> {
  return selectMany(SWIPE_CARDS_TABLE, swipeCardSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "issued_on", ascending: false }],
    columns:
      "id, card_number, card_technology, issued_on, valid_from, valid_to, status, " +
      "returned_on, remarks",
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 7. The whole Tab-2 policy bundle, in one call
// -----------------------------------------------------------------------------

export interface EmploymentPolicies {
  readonly shift: Shift | null;
  readonly weeklyOff: WeeklyOffRule | null;
  readonly attendancePolicy: AttendancePolicy | null;
  readonly payPeriod: PayPeriod | null;
  readonly holidayCalendar: HolidayCalendar | null;
}

/**
 * Resolve every policy assigned to the employee. A null id is a real state — an
 * employee excluded from attendance has no shift — and each null renders as an
 * honest "Not assigned" line rather than a blank row.
 */
export async function fetchEmploymentPolicies(
  ids: {
    readonly shiftId: string | null;
    readonly weeklyOffRuleId: string | null;
    readonly attendancePolicyId: string | null;
    readonly payPeriodId: string | null;
    readonly holidayCalendarId: string | null;
  },
  signal?: AbortSignal,
): Promise<EmploymentPolicies> {
  const [shift, weeklyOff, attendancePolicy, payPeriod, holidayCalendar] = await Promise.all([
    ids.shiftId === null ? null : fetchShift(ids.shiftId, signal),
    ids.weeklyOffRuleId === null ? null : fetchWeeklyOffRule(ids.weeklyOffRuleId, signal),
    ids.attendancePolicyId === null ? null : fetchAttendancePolicy(ids.attendancePolicyId, signal),
    ids.payPeriodId === null ? null : fetchPayPeriod(ids.payPeriodId, signal),
    ids.holidayCalendarId === null ? null : fetchHolidayCalendar(ids.holidayCalendarId, signal),
  ]);
  return { shift, weeklyOff, attendancePolicy, payPeriod, holidayCalendar };
}
