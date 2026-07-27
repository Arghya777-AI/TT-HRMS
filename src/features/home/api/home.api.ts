/**
 * home.api.ts — the E-02 `/me` reads.
 *
 * Home shows the same numbers as the detail screens, so it calls the SAME
 * functions those screens call (`fetchAttendanceDay`, `fetchLeaveBalances`,
 * `fetchCompOffBalance`, `fetchLatestPayslip`) instead of issuing its own
 * variants. That is the structural reason a home tile and its detail screen
 * cannot disagree (spec-screens: the "7 vs 8" weekly-offs defect).
 *
 * Only two reads are genuinely local to home: upcoming holidays (needs the
 * employee's `holiday_calendar_id`) and announcements.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  isNull,
  lte,
  selectMany,
  selectOne,
  type Filter,
} from "@/shared/api/query";
import { supabase } from "@/lib/supabase";
import { istToday } from "@/lib/datetime";
import {
  fetchAttendanceDay,
  fetchMonthToDateSummary,
  type AttendanceDay,
  type AttendancePeriodSummary,
} from "@/features/attendance/api/attendance.api";
import {
  fetchCompOffBalance,
  fetchLeaveBalances,
  type CompOffBalance,
  type LeaveBalance,
} from "@/features/leave/api/leave.api";

export const MY_EMPLOYEE_VIEW = "v_my_employee";
export const HOLIDAYS_TABLE = "holidays";
export const ANNOUNCEMENTS_TABLE = "announcements";
export const SHIFTS_TABLE = "shifts";
export const SHIFT_ASSIGNMENTS_TABLE = "shift_assignments";
export const WEEKLY_OFF_RULES_TABLE = "weekly_off_rules";
export const NOTIFICATIONS_TABLE = "notifications";
export const ATTENDANCE_DAYS_TABLE = "attendance_days";

// -----------------------------------------------------------------------------
// 1. Today's attendance row
// -----------------------------------------------------------------------------

/**
 * Today's `attendance_days` row, read through `v_attendance_day_enriched` so the
 * shift and leave-type LABELS come with it (a raw base-table read would leave
 * the shell rendering `shift_id`).
 *
 * `null` is a real, expected state: the engine has not materialised today's row
 * yet. Render "No punches yet today", never a zero-filled card.
 */
export async function fetchTodayAttendance(
  employeeId: string,
  signal?: AbortSignal,
): Promise<AttendanceDay | null> {
  return fetchAttendanceDay(employeeId, istToday(), signal);
}

// -----------------------------------------------------------------------------
// 2. Leave + comp-off summary
// -----------------------------------------------------------------------------

export interface HomeBalances {
  readonly leave: LeaveBalance[];
  readonly compOff: CompOffBalance | null;
}

/**
 * Region E + F of E-02. Both reads are the detail screens' own reads, so the
 * home card and `/me/leave` show identical figures by construction.
 */
export async function fetchHomeBalances(
  employeeId: string,
  signal?: AbortSignal,
): Promise<HomeBalances> {
  const [leave, compOff] = await Promise.all([
    fetchLeaveBalances(employeeId, signal),
    fetchCompOffBalance(employeeId, signal),
  ]);
  return { leave, compOff };
}

/** Region D — the my-month strip. THE summary row, month-to-date. */
export async function fetchHomeMonthStrip(
  employeeId: string,
  signal?: AbortSignal,
): Promise<AttendancePeriodSummary | null> {
  return fetchMonthToDateSummary(employeeId, signal);
}

// -----------------------------------------------------------------------------
// 3. Upcoming holidays
// -----------------------------------------------------------------------------

/**
 * The employee's own record (`v_my_employee` is pinned to
 * `app.current_employee_id()`), narrowed to the columns home needs. Reading a
 * narrow projection of a `SELECT e.*` view keeps home off the PII columns.
 */
export const myEmployeeHomeSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  first_name: z.string(),
  photo_path: z.string().nullable(),
  holiday_calendar_id: dbUuidNullable,
  weekly_off_rule_id: dbUuidNullable,
  shift_id: dbUuidNullable,
  department_id: dbUuidNullable,
  location_id: dbUuidNullable,
  /** Nullable on the base table — a pre-joining record has no join date yet. */
  date_of_join: dbDateNullable,
});

export type MyEmployeeHome = z.infer<typeof myEmployeeHomeSchema>;

const MY_EMPLOYEE_HOME_COLUMNS =
  "id, employee_code, display_name, first_name, photo_path, holiday_calendar_id, " +
  "weekly_off_rule_id, shift_id, department_id, location_id, date_of_join";

/** The caller's own employee row. `null` = kiosk-only / no employee record. */
export async function fetchMyEmployeeForHome(
  signal?: AbortSignal,
): Promise<MyEmployeeHome | null> {
  return selectOne(MY_EMPLOYEE_VIEW, myEmployeeHomeSchema, [], {
    columns: MY_EMPLOYEE_HOME_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/** Mirrors the `holidays` table (migration 014). */
export const holidaySchema = z.object({
  id: dbUuid,
  holiday_calendar_id: dbUuid,
  holiday_date: dbDate,
  name: z.string(),
  local_name: z.string().nullable(),
  holiday_type: z.string(),
  is_paid: z.boolean(),
  /** Restricted/optional holiday — the employee elects it (spec E-15). */
  is_optional: z.boolean(),
  applies_to_department_ids: z.array(dbUuid).nullable(),
  applies_to_location_ids: z.array(dbUuid).nullable(),
  compensatory_off_if_worked: z.boolean(),
  description: z.string().nullable(),
  is_active: z.boolean(),
});

export type Holiday = z.infer<typeof holidaySchema>;

export interface UpcomingHolidaysQuery {
  readonly holidayCalendarId: string;
  /** Inclusive lower bound; defaults to today IST. */
  readonly from?: string;
  /** Inclusive upper bound. Omit for "no end". */
  readonly to?: string;
  readonly limit?: number;
}

/**
 * Upcoming holidays on the employee's calendar, soonest first.
 *
 * Department/location narrowing (`applies_to_*`) is NOT applied here: those
 * columns are nullable arrays meaning "everyone", and deciding applicability is
 * engine logic. The attendance engine already stamps `is_holiday` on
 * `attendance_days`, which is the authoritative per-employee answer; this list
 * is the calendar, so it shows the calendar.
 */
export async function fetchUpcomingHolidays(
  q: UpcomingHolidaysQuery,
  signal?: AbortSignal,
): Promise<Holiday[]> {
  const filters: Filter[] = [
    eq("holiday_calendar_id", q.holidayCalendarId),
    eq("is_active", true),
    gte("holiday_date", q.from ?? istToday()),
  ];
  if (q.to !== undefined) filters.push(lte("holiday_date", q.to));
  return selectMany(HOLIDAYS_TABLE, holidaySchema, {
    filters,
    order: [{ column: "holiday_date", ascending: true }],
    limit: q.limit ?? 5,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Announcements
// -----------------------------------------------------------------------------

/**
 * Mirrors the `announcements` table (migration 027).
 *
 * Audience matching is enforced by RLS (`app.announcement_visible`), so this
 * read never filters on `audience` — the client could not be trusted to and does
 * not need to. The status/window filters are belt-and-braces for the author and
 * admin policies, which are wider than the audience policy.
 */
export const announcementSchema = z.object({
  id: dbUuid,
  title: z.string(),
  body_markdown: z.string(),
  announcement_kind: z.enum([
    "general",
    "policy_change",
    "event_briefing",
    "celebration",
    "safety_alert",
    "roster_published",
    "holiday_notice",
  ]),
  priority: z.enum(["low", "normal", "high", "critical"]),
  banner_image_path: z.string().nullable(),
  publish_at: dbTimestampNullable,
  expires_at: dbTimestampNullable,
  pinned: z.boolean(),
  requires_acknowledgement: z.boolean(),
  document_id: dbUuidNullable,
  published_at: dbTimestampNullable,
  view_count: dbInt,
  status: z.enum(["draft", "scheduled", "published", "archived"]),
});

export type Announcement = z.infer<typeof announcementSchema>;

const ANNOUNCEMENT_COLUMNS =
  "id, title, body_markdown, announcement_kind, priority, banner_image_path, publish_at, " +
  "expires_at, pinned, requires_acknowledgement, document_id, published_at, view_count, status";

/** Live announcements, pinned first then newest. */
export async function fetchAnnouncements(
  limit = 5,
  signal?: AbortSignal,
): Promise<Announcement[]> {
  return selectMany(ANNOUNCEMENTS_TABLE, announcementSchema, {
    filters: [eq("status", "published"), isNull("deleted_at")],
    order: [
      { column: "pinned", ascending: false },
      { column: "published_at", ascending: false, nullsFirst: false },
    ],
    limit,
    columns: ANNOUNCEMENT_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/** Critical/high notices only — the banner slot above the greeting band. */
export async function fetchUrgentAnnouncements(
  signal?: AbortSignal,
): Promise<Announcement[]> {
  return selectMany(ANNOUNCEMENTS_TABLE, announcementSchema, {
    filters: [
      eq("status", "published"),
      isNull("deleted_at"),
      inList("priority", ["high", "critical"]),
    ],
    order: [{ column: "published_at", ascending: false, nullsFirst: false }],
    limit: 3,
    columns: ANNOUNCEMENT_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. Region A context — today's shift window and the weekly-off rule
// -----------------------------------------------------------------------------

/**
 * `shifts` (migration 014). `display_label` is trigger-maintained as
 * `'G — 09:30 AM to 06:30 PM'`; it leads with the internal CODE, which DR-53
 * forbids on screen (and 12h, which §8 forbids), so the UI renders `name` plus
 * `fmtCivilTime(start_time/end_time)` and never this column.
 */
export const shiftSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  /** Postgres `time` — 'HH:MM:SS'. Format with fmtCivilTime, never new Date(). */
  start_time: z.string(),
  end_time: z.string(),
  duration_minutes: dbInt,
  unpaid_break_minutes: dbInt,
  crosses_midnight: z.boolean(),
  display_label: z.string(),
});

export type Shift = z.infer<typeof shiftSchema>;

const SHIFT_COLUMNS =
  "id, code, name, start_time, end_time, duration_minutes, unpaid_break_minutes, " +
  "crosses_midnight, display_label";

/** One date-specific assignment row with its shift embedded (migration 014). */
export const shiftAssignmentSchema = z.object({
  id: dbUuid,
  shift_id: dbUuid,
  effective_from: dbDate,
  /** NULL = open-ended — render "Current", never a sentinel date (DR-19). */
  effective_to: dbDateNullable,
  shift: shiftSchema.nullable(),
});

export type ShiftAssignment = z.infer<typeof shiftAssignmentSchema>;

const SHIFT_ASSIGNMENT_COLUMNS =
  `id, shift_id, effective_from, effective_to, shift:shifts(${SHIFT_COLUMNS})`;

/** Where today's shift came from — the band says so rather than implying it. */
export type ShiftSource = "assignment" | "default";

export interface TodayShiftContext {
  readonly shift: Shift | null;
  readonly source: ShiftSource | null;
}

export interface TodayShiftQuery {
  readonly employeeId: string;
  /** `employees.shift_id` — the fallback when no dated assignment covers today. */
  readonly defaultShiftId: string | null;
  /** IST business date; defaults to today. */
  readonly date?: string;
}

/**
 * Today's shift, resolved exactly as spec §3.3 states it: a dated
 * `shift_assignments` row overrides `employees.shift_id`.
 *
 * The assignment table carries an exclusion constraint on
 * `(employee_id, daterange(effective_from, effective_to))`, so at most one range
 * can cover a date; we take the newest range that starts on or before the date
 * and check its end. `effective_to` is compared as a 'YYYY-MM-DD' string, which
 * is chronological — no client date arithmetic.
 */
export async function fetchTodayShiftContext(
  q: TodayShiftQuery,
  signal?: AbortSignal,
): Promise<TodayShiftContext> {
  const date = q.date ?? istToday();
  const assignments = await selectMany(SHIFT_ASSIGNMENTS_TABLE, shiftAssignmentSchema, {
    filters: [eq("employee_id", q.employeeId), lte("effective_from", date), isNull("deleted_at")],
    order: [{ column: "effective_from", ascending: false }],
    limit: 3,
    columns: SHIFT_ASSIGNMENT_COLUMNS,
    ...(signal ? { signal } : {}),
  });
  const covering = assignments.find(
    (a) => a.effective_to === null || a.effective_to >= date,
  );
  if (covering?.shift) return { shift: covering.shift, source: "assignment" };

  if (q.defaultShiftId === null) return { shift: null, source: null };
  const shift = await fetchShift(q.defaultShiftId, signal);
  return shift === null ? { shift: null, source: null } : { shift, source: "default" };
}

/** One shift by id. `null` = inactive or soft-deleted (RLS `ref_read`). */
export async function fetchShift(
  shiftId: string,
  signal?: AbortSignal,
): Promise<Shift | null> {
  return selectOne(SHIFTS_TABLE, shiftSchema, [eq("id", shiftId)], {
    columns: SHIFT_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `weekly_off_rules` (migration 014). `name` is already the sentence form the
 * register demands ("Sunday + Alternate Saturday", DR-60) — the client must NOT
 * assemble one from `first_off_dow` / `first_off_weeks`.
 */
export const weeklyOffRuleSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  rule_kind: z.string(),
});

export type WeeklyOffRule = z.infer<typeof weeklyOffRuleSchema>;

export async function fetchWeeklyOffRule(
  ruleId: string,
  signal?: AbortSignal,
): Promise<WeeklyOffRule | null> {
  return selectOne(WEEKLY_OFF_RULES_TABLE, weeklyOffRuleSchema, [eq("id", ruleId)], {
    columns: "id, code, name, description, rule_kind",
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 6. Region C — "Needs your attention"
// -----------------------------------------------------------------------------

/**
 * `notifications` (migration 027), the SERVER's own answer to "what needs this
 * employee to act".
 *
 * Spec E-02 Region C names `rpc_my_pending_actions()`; that function is NOT in
 * the deployed schema (no migration defines it). Rather than re-deriving the ten
 * item types in the browser, Region C reads the notification feed the cron jobs
 * and edge functions already write (`cron-expiry-reminders`,
 * `notification-dispatch`, …): each row arrives with its own title, priority and
 * `deep_link`, so the client ranks and truncates but never decides severity.
 *
 * RLS is `employee_id = app.current_employee_id()`; the `employee_id` filter
 * below is for the index, not for safety.
 */
export const notificationSchema = z.object({
  id: dbUuid,
  event_code: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  /** In-app route the server wants the employee taken to. May be absent. */
  deep_link: z.string().nullable(),
  priority: z.enum(["low", "normal", "high", "critical"]),
  read_at: dbTimestampNullable,
  dismissed_at: dbTimestampNullable,
  action_taken_at: dbTimestampNullable,
  expires_at: dbTimestampNullable,
  recorded_at: dbTimestamp,
});

export type NotificationItem = z.infer<typeof notificationSchema>;

const NOTIFICATION_COLUMNS =
  "id, event_code, title, body, deep_link, priority, read_at, dismissed_at, " +
  "action_taken_at, expires_at, recorded_at";

/**
 * In-app notifications still awaiting the employee: not dismissed, not already
 * acted on. Newest first; the caller ranks by priority and shows at most five.
 */
export async function fetchAttentionNotifications(
  employeeId: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<NotificationItem[]> {
  return selectMany(NOTIFICATIONS_TABLE, notificationSchema, {
    filters: [
      eq("employee_id", employeeId),
      eq("channel", "in_app"),
      isNull("dismissed_at"),
      isNull("action_taken_at"),
    ],
    order: [{ column: "recorded_at", ascending: false }],
    limit,
    columns: NOTIFICATION_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 7. Region B realtime — own attendance_days rows only
// -----------------------------------------------------------------------------

/**
 * Subscribe to the caller's OWN `attendance_days` rows (published in migration
 * 040) so a gate scan lands on the Today card within the §10 two-second budget.
 *
 * Lives in the api layer because pages and components may not import the
 * Supabase client (architecture D-01); the hook wraps this and invalidates the
 * affected query keys. Returns its own unsubscribe.
 */
export function subscribeToMyAttendanceDays(
  employeeId: string,
  onChange: () => void,
): () => void {
  const channel = supabase
    .channel(`home-attendance-${employeeId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: ATTENDANCE_DAYS_TABLE,
        filter: `employee_id=eq.${employeeId}`,
      },
      () => onChange(),
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
