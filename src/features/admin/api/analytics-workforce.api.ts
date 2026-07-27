/**
 * analytics-workforce.api.ts — the reads behind the four §14 analytics screens
 * this module owns: the analytics home (`/admin/analytics`), Workforce,
 * Attendance and Leave analytics.
 *
 * Everything here obeys one rule that analytics screens break more often than
 * any other kind: THE NUMBER IS THE SERVER'S. Concretely, in this file
 *
 *  * every breakdown ("headcount by department", "records with leave taken") is
 *    a `count=exact` HEAD request built from the SAME filter array the drill
 *    -through list uses, so a bar and the grid it opens cannot disagree;
 *  * every trend point is a column of a deployed view — `late_count`,
 *    `day_count`, `joiners`, `exits`, `attrition_pct` — never a client-side sum
 *    over rows we happen to have loaded;
 *  * the matview-backed reads carry `refreshed_at` out to the caller, because a
 *    figure from `analytics.mv_*` is as of the last refresh and the screen has
 *    to say so.
 *
 * Gaps found during recon and deliberately NOT papered over (the screens name
 * them on-page rather than inventing a number):
 *
 *  1. `v_headcount_monthly`'s grain is (year, month, department) with NO
 *     org-wide rollup row — `GROUP BY … department_id` produces a row for
 *     "no department", not a total. So a joiner/exit series can be plotted per
 *     department, and an org-wide series would need a client sum. The Workforce
 *     screen therefore asks for a department before it draws the series.
 *  2. There is no lifecycle-event analytics view at all
 *     (`employee_lifecycle_events` is a bare RLS-scoped table; no
 *     `v_lifecycle_*` exists). Joiner/exit COUNTS from the event stream are
 *     therefore server counts over that table, and the headcount series comes
 *     from `mv_headcount_daily`'s date predicates instead.
 *  3. No leave aggregate exists anywhere: `v_leave_balance_current` is one row
 *     per employee × type and carries NO department, and no view/function sums
 *     `availed_days` by type, department or month. So "days consumed" is
 *     reported per employee × type from server columns, the by-type panel uses
 *     server COUNTS of employees, and the by-department rollup is stated as
 *     missing.
 *  4. `public.refresh_analytics()` is granted to `service_role` only (031/057),
 *     so no browser can refresh a matview — the staleness line is read-only.
 */
import { z } from "zod";
import {
  dbDate,
  dbInt,
  dbIntNullable,
  dbNumericNullable,
  dbPercentNullable,
  dbTimestamp,
  dbUuid,
  dbUuidNullable,
  eq,
  gt,
  gte,
  inList,
  isFalse,
  isNull,
  lte,
  rpcOne,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { nowIstDate } from "@/lib/datetime";
import {
  ACTIVE_EMPLOYMENT_STATUSES,
  V_ADMIN_EMPLOYEE,
  type EmploymentStatus,
} from "./employees.api";
import { V_BALANCE_CURRENT, V_LEDGER_STATEMENT, balanceSchema } from "./leave.api";

// -----------------------------------------------------------------------------
// Relations — every one verified present in supabase/migrations
// -----------------------------------------------------------------------------

/** 036 §4 wrapper over `analytics.mv_headcount_daily` (admin-gated). */
export const V_HEADCOUNT_DAILY = "v_headcount_daily";
/** 036 §6 live monthly rollup over the same matview (admin-gated). */
export const V_HEADCOUNT_MONTHLY = "v_headcount_monthly";
/** 034 §6 per-date late / on-time / absent counts. */
export const V_LATE_TREND = "v_attendance_late_trend";
/** 034 §7 first-in minutes since IST midnight, per employee × date. */
export const V_IN_TREND = "v_attendance_in_trend";
/** 034 §5 hours-worked distribution per date. */
export const V_HOUR_BUCKETS = "v_attendance_hour_buckets";
/** 036 §6 wrapper over `analytics.mv_attendance_monthly`. */
export const V_ATTENDANCE_MONTHLY = "v_attendance_monthly_summary";
/** 011 append-only lifecycle stream (RLS: `app.can_see_employee`). */
export const LIFECYCLE_EVENTS_TABLE = "employee_lifecycle_events";
export const V_PAYROLL_COST_MONTHLY = "v_payroll_cost_monthly";
export const V_DOCUMENT_COMPLIANCE = "v_document_compliance";
export const V_KIOSK_HEALTH = "v_kiosk_health";
export const AI_USAGE_LEDGER_TABLE = "ai_usage_ledger";
export const EXPORT_LOG_TABLE = "export_log";
/** 019 `public.leave_year_of(date)` — granted to `authenticated`. */
export const LEAVE_YEAR_FN = "leave_year_of";

// -----------------------------------------------------------------------------
// 1. Analytics home — one headline figure per analytics screen
// -----------------------------------------------------------------------------

/**
 * The measures the home screen can actually read from a deployed relation. The
 * screens with no backing relation at all (metric dictionary, scheduled
 * reports, report builder) are absent on purpose and say so on the page.
 */
export const HEADLINE_MEASURES = [
  "workforce",
  "attendance",
  "leave",
  "payroll",
  "compliance",
  "kiosk",
  "ai",
  "exports",
] as const;
export type HeadlineMeasure = (typeof HEADLINE_MEASURES)[number];

export interface HeadlineFigure {
  /** Null only when the relation held no row to read (never a stand-in zero). */
  readonly figure: number | null;
  /** `count` renders with formatNumber, `percent` with formatPercent. */
  readonly unit: "count" | "percent";
  /** The IST date the figure is as of, when the relation carries one. */
  readonly asOfDate: string | null;
}

const lateTrendSchema = z.object({
  ist_date: dbDate,
  working_count: dbInt,
  late_count: dbInt,
  on_time_count: dbInt,
  absent_count: dbInt,
  pending_count: dbInt,
  /** Clamped [0,100] by `fn_late_pct`; NULL when there were no working days. */
  late_pct: dbPercentNullable,
});
export type LateTrendRow = z.infer<typeof lateTrendSchema>;

/** Statuses that mean "currently employed" — the same set the directory uses. */
const ON_ROLL: readonly EmploymentStatus[] = ACTIVE_EMPLOYMENT_STATUSES;

function onRollFilters(): Filter[] {
  return [isNull("deleted_at"), inList("employment_status", [...ON_ROLL])];
}

async function fetchLatestLatePct(signal?: AbortSignal): Promise<HeadlineFigure> {
  const rows = await selectMany(V_LATE_TREND, lateTrendSchema, {
    filters: [lte("ist_date", nowIstDate())],
    order: [{ column: "ist_date", ascending: false }],
    limit: 1,
    ...(signal ? { signal } : {}),
  });
  const row = rows[0];
  return {
    figure: row?.late_pct ?? null,
    unit: "percent",
    asOfDate: row?.ist_date ?? null,
  };
}

async function countTo(
  view: string,
  filters: readonly Filter[],
  signal?: AbortSignal,
): Promise<HeadlineFigure> {
  const figure = await selectCount(view, filters, { ...(signal ? { signal } : {}) });
  return { figure, unit: "count", asOfDate: null };
}

/**
 * One headline figure. Each branch names its own relation and predicate, so the
 * hint under the tile can state what was counted in words.
 */
export function fetchHeadline(
  measure: HeadlineMeasure,
  signal?: AbortSignal,
): Promise<HeadlineFigure> {
  switch (measure) {
    case "workforce":
      return countTo(V_ADMIN_EMPLOYEE, onRollFilters(), signal);
    case "attendance":
      return fetchLatestLatePct(signal);
    case "leave":
      return countTo(V_BALANCE_CURRENT, [gt("availed_days", 0)], signal);
    case "payroll":
      return countTo(V_PAYROLL_COST_MONTHLY, [], signal);
    case "compliance":
      return countTo(
        V_DOCUMENT_COMPLIANCE,
        [inList("compliance_status", ["missing", "expired", "expiring_soon"])],
        signal,
      );
    case "kiosk":
      return countTo(V_KIOSK_HEALTH, [], signal);
    case "ai":
      return countTo(AI_USAGE_LEDGER_TABLE, [], signal);
    case "exports":
      return countTo(EXPORT_LOG_TABLE, [], signal);
  }
}

// -----------------------------------------------------------------------------
// 2. Workforce — server counts per dimension + the matview series
// -----------------------------------------------------------------------------

/**
 * Headcount for one slice, counted by Postgres over `v_admin_employee` with the
 * directory's own predicates. `statuses` defaults to the on-roll set.
 */
export function countHeadcount(
  slice: {
    readonly statuses?: readonly EmploymentStatus[];
    readonly employmentType?: string;
    readonly departmentId?: string;
    /** True → `department_id IS NULL` (employees not yet assigned). */
    readonly noDepartment?: boolean;
  },
  signal?: AbortSignal,
): Promise<number> {
  const filters: Filter[] = [
    isNull("deleted_at"),
    inList("employment_status", [...(slice.statuses ?? ON_ROLL)]),
  ];
  if (slice.employmentType !== undefined) filters.push(eq("employment_type", slice.employmentType));
  if (slice.departmentId !== undefined) filters.push(eq("department_id", slice.departmentId));
  if (slice.noDepartment === true) filters.push(isNull("department_id"));
  return selectCount(V_ADMIN_EMPLOYEE, filters, { ...(signal ? { signal } : {}) });
}

/** Employees in exactly one lifecycle state (the status table's rows). */
export function countByStatus(
  status: EmploymentStatus,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_ADMIN_EMPLOYEE, [isNull("deleted_at"), eq("employment_status", status)], {
    ...(signal ? { signal } : {}),
  });
}

const headcountMonthlySchema = z.object({
  year: dbInt,
  month: dbInt,
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  /** Mean of the exact daily headcount series for the month (server ROUND). */
  avg_headcount: dbNumericNullable,
  joiners: dbInt,
  exits: dbInt,
  /**
   * §9.2 annualised attrition: exits * 12 * 100 / avg_headcount. NOT a
   * `dbPercent` — one exit from a two-person department is legitimately 600%,
   * and clamping it here would hide a real signal.
   */
  attrition_pct: dbNumericNullable,
  probation_count: dbIntNullable,
  tenure_lt_1y: dbIntNullable,
  tenure_1_3y: dbIntNullable,
  tenure_3_5y: dbIntNullable,
  tenure_ge_5y: dbIntNullable,
});
export type HeadcountMonthlyRow = z.infer<typeof headcountMonthlySchema>;

/** One calendar year of month × department rows, oldest month first. */
export function fetchHeadcountMonthly(
  year: number,
  departmentId: string | null,
  signal?: AbortSignal,
): Promise<HeadcountMonthlyRow[]> {
  const filters: Filter[] = [eq("year", year)];
  if (departmentId !== null && departmentId !== "") filters.push(eq("department_id", departmentId));
  return selectMany(V_HEADCOUNT_MONTHLY, headcountMonthlySchema, {
    filters,
    order: [
      { column: "month", ascending: true },
      { column: "department_name", ascending: true },
    ],
    limit: 400,
    ...(signal ? { signal } : {}),
  });
}

const refreshStampSchema = z.object({
  as_of_date: dbDate,
  refreshed_at: dbTimestamp,
});
export type RefreshStamp = z.infer<typeof refreshStampSchema>;

/**
 * When `analytics.mv_headcount_daily` was last refreshed, and the latest date it
 * covers. Both come from the matview itself, so the screen can print an honest
 * "as of" line instead of implying the numbers are live.
 */
export async function fetchHeadcountStamp(signal?: AbortSignal): Promise<RefreshStamp | null> {
  const rows = await selectMany(V_HEADCOUNT_DAILY, refreshStampSchema, {
    columns: "as_of_date,refreshed_at",
    order: [{ column: "as_of_date", ascending: false }],
    limit: 1,
    ...(signal ? { signal } : {}),
  });
  return rows[0] ?? null;
}

/** Lifecycle event types the workforce screen counts (all of them exist in the enum). */
export const LIFECYCLE_COUNTED_TYPES = [
  "joined",
  "confirmed",
  "promoted",
  "transferred",
  "resigned",
  "terminated",
] as const;
export type LifecycleCountedType = (typeof LIFECYCLE_COUNTED_TYPES)[number];

/**
 * How many un-reversed lifecycle events of one type took effect in a window.
 * Counted on the append-only event stream itself — this is the only honest
 * "joiners from the event log" figure available, because no analytics view over
 * `employee_lifecycle_events` is deployed.
 */
export function countLifecycleEvents(
  eventType: LifecycleCountedType,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(
    LIFECYCLE_EVENTS_TABLE,
    [
      eq("event_type", eventType),
      gte("effective_date", from),
      lte("effective_date", to),
      isFalse("is_reversed"),
    ],
    { ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 3. Attendance analytics — the four trend relations
// -----------------------------------------------------------------------------

/** Per-date late / on-time / absent counts over an inclusive IST window. */
export function fetchLateTrend(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<LateTrendRow[]> {
  return selectMany(V_LATE_TREND, lateTrendSchema, {
    filters: [gte("ist_date", from), lte("ist_date", to)],
    order: [{ column: "ist_date", ascending: true }],
    limit: 400,
    ...(signal ? { signal } : {}),
  });
}

const hourBucketSchema = z.object({
  ist_date: dbDate,
  /** '<4', '4–5', … '≥8' — the view's own label, rendered verbatim. */
  bucket: z.string(),
  bucket_sort: dbInt,
  day_count: dbInt,
  pct_of_date: dbPercentNullable,
});
export type HourBucketRow = z.infer<typeof hourBucketSchema>;

/** Hours-worked distribution for ONE date. A range would need a client sum. */
export function fetchHourBuckets(
  isoDate: string,
  signal?: AbortSignal,
): Promise<HourBucketRow[]> {
  return selectMany(V_HOUR_BUCKETS, hourBucketSchema, {
    filters: [eq("ist_date", isoDate)],
    order: [{ column: "bucket_sort", ascending: true }],
    limit: 12,
    ...(signal ? { signal } : {}),
  });
}

const inTrendSchema = z.object({
  employee_id: dbUuid,
  ist_date: dbDate,
  /** Minutes since IST midnight — the fix for "11.3H" meaning 11:18. */
  first_in_minutes: dbIntNullable,
  /** Pre-rendered 24-hour IST wall clock from the view. */
  first_in_hm: z.string().nullable(),
  is_late: z.boolean(),
  late_minutes: dbIntNullable,
});
export type InTrendRow = z.infer<typeof inTrendSchema>;

/** Latest first-scans on one date — server-ordered, so no client ranking. */
export function fetchLatestFirstIns(
  isoDate: string,
  limit: number,
  signal?: AbortSignal,
): Promise<InTrendRow[]> {
  return selectMany(V_IN_TREND, inTrendSchema, {
    filters: [eq("ist_date", isoDate)],
    order: [
      { column: "first_in_minutes", ascending: false },
      { column: "employee_id", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

const attendanceMonthlySchema = z.object({
  employee_id: dbUuid,
  pay_period_code: z.string(),
  year: dbInt,
  month: dbInt,
  total_days: dbInt,
  days_recorded: dbInt,
  present_days: dbInt,
  absent_days: dbInt,
  pending_days: dbInt,
  working_days: dbInt,
  late_days: dbInt,
  late_minutes: dbInt,
  early_exit_days: dbInt,
  overtime_minutes: dbInt,
  total_worked_minutes: dbInt,
  avg_worked_minutes_per_present_day: dbNumericNullable,
  late_pct: dbPercentNullable,
  attendance_pct: dbPercentNullable,
  /** `now()` at the last REFRESH of `analytics.mv_attendance_monthly`. */
  refreshed_at: dbTimestamp,
});
export type AttendanceMonthlyRow = z.infer<typeof attendanceMonthlySchema>;

const ATTENDANCE_MONTHLY_COLUMNS =
  "employee_id,pay_period_code,year,month,total_days,days_recorded,present_days," +
  "absent_days,pending_days,working_days,late_days,late_minutes,early_exit_days," +
  "overtime_minutes,total_worked_minutes,avg_worked_minutes_per_present_day," +
  "late_pct,attendance_pct,refreshed_at";

const attendanceStampSchema = z.object({ refreshed_at: dbTimestamp });

/**
 * When `analytics.mv_attendance_monthly` was last refreshed. Read separately
 * from the month's rows so the staleness line still prints for a month the
 * matview holds no rows for — "as of 03:15" plus "no rows yet" is the honest
 * pair, and a missing stamp would otherwise read as a broken screen.
 */
export async function fetchAttendanceStamp(signal?: AbortSignal): Promise<string | null> {
  const rows = await selectMany(V_ATTENDANCE_MONTHLY, attendanceStampSchema, {
    columns: "refreshed_at",
    order: [{ column: "refreshed_at", ascending: false }],
    limit: 1,
    ...(signal ? { signal } : {}),
  });
  return rows[0]?.refreshed_at ?? null;
}

/**
 * One (year, month) of the matview, most-late employee first. The ordering is
 * the server's; the screen prints columns.
 */
export function fetchAttendanceMonthly(
  year: number,
  month: number,
  limit: number,
  signal?: AbortSignal,
): Promise<AttendanceMonthlyRow[]> {
  return selectMany(V_ATTENDANCE_MONTHLY, attendanceMonthlySchema, {
    columns: ATTENDANCE_MONTHLY_COLUMNS,
    filters: [eq("year", year), eq("month", month)],
    order: [
      { column: "late_days", ascending: false },
      { column: "employee_id", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Leave analytics — server counts + the per-employee balance rows
// -----------------------------------------------------------------------------

/** The current leave year, decided by Postgres (`leave_year_of(ist_today)`). */
export function fetchCurrentLeaveYear(signal?: AbortSignal): Promise<number | null> {
  return rpcOne(LEAVE_YEAR_FN, { p_date: nowIstDate() }, dbInt, {
    ...(signal ? { signal } : {}),
  });
}

/** The scope both the leave counts and the leave grid are built from. */
export interface LeaveScope {
  /** Employees in the chosen department; empty means "no scope filter". */
  readonly employeeIds?: readonly string[];
  readonly leaveTypeId?: string;
}

/** Which slice of `v_leave_balance_current` a tile counts. */
export type LeaveSlice = "all" | "consumed" | "exhausted" | "expiring";

function leaveFilters(scope: LeaveScope, slice: LeaveSlice): Filter[] {
  const filters: Filter[] = [];
  if (scope.employeeIds !== undefined && scope.employeeIds.length > 0)
    filters.push(inList("employee_id", [...scope.employeeIds]));
  if (scope.leaveTypeId !== undefined && scope.leaveTypeId !== "")
    filters.push(eq("leave_type_id", scope.leaveTypeId));
  switch (slice) {
    case "consumed":
      filters.push(gt("availed_days", 0));
      break;
    case "exhausted":
      filters.push(lte("available_days", 0));
      break;
    case "expiring":
      filters.push(gt("expiring_soon_days", 0));
      break;
    case "all":
      break;
  }
  return filters;
}

/**
 * How many employee × leave-type records match, counted by Postgres over the
 * SAME predicate the consumption grid uses.
 */
export function countLeaveRecords(
  scope: LeaveScope,
  slice: LeaveSlice,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_BALANCE_CURRENT, leaveFilters(scope, slice), {
    ...(signal ? { signal } : {}),
  });
}

/**
 * The heaviest consumers first — `availed_days` is a stored column of the
 * balance row, itself a running sum the ledger maintains, so nothing is
 * re-derived here.
 */
export function fetchLeaveConsumption(
  scope: LeaveScope,
  limit: number,
  signal?: AbortSignal,
): Promise<z.infer<typeof balanceSchema>[]> {
  return selectMany(V_BALANCE_CURRENT, balanceSchema, {
    filters: leaveFilters(scope, "all"),
    order: [
      { column: "availed_days", ascending: false },
      { column: "employee_id", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/** Ledger movement kinds the leave screen counts, in ledger-statement order. */
export const LEDGER_COUNTED_TYPES = [
  "accrual",
  "availed",
  "credit_adjustment",
  "debit_adjustment",
  "lapse",
  "encashment",
] as const;
export type LedgerCountedType = (typeof LEDGER_COUNTED_TYPES)[number];

/** How many ledger entries of one kind exist in a leave year, within scope. */
export function countLedgerEntries(
  entryType: LedgerCountedType,
  leaveYear: number,
  scope: LeaveScope,
  signal?: AbortSignal,
): Promise<number> {
  const filters: Filter[] = [eq("entry_type", entryType), eq("leave_year", leaveYear)];
  if (scope.employeeIds !== undefined && scope.employeeIds.length > 0)
    filters.push(inList("employee_id", [...scope.employeeIds]));
  if (scope.leaveTypeId !== undefined && scope.leaveTypeId !== "")
    filters.push(eq("leave_type_id", scope.leaveTypeId));
  return selectCount(V_LEDGER_STATEMENT, filters, { ...(signal ? { signal } : {}) });
}
