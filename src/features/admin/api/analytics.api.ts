/**
 * analytics.api.ts — the filter-aware reads behind the drill-through analytics
 * surface: one period, one set of dimensions, and the same measures whether you
 * are looking at the whole venue, one department, one employee or one date.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE EVERY NUMBER COMES FROM (the repo rule: a displayed figure is traceable)
 * ═══════════════════════════════════════════════════════════════════════════
 * SERVER-COMPUTED, read as-is and never re-derived here:
 *   * every per-day column of `v_attendance_day_enriched` — `status`,
 *     `total_worked_minutes`, `gross_span_minutes`, `break_minutes`,
 *     `late_minutes`, `overtime_minutes`, `is_working_day`, `has_anomalies`,
 *     and the IST wall clocks `first_in_hm` / `last_out_hm`;
 *   * every state flag of `v_attendance_today_board` — `attended`, `off_today`,
 *     `yet_to_reach`, `late_in`, `on_time`, `overdue`, each decided by Postgres
 *     from the shift, the grace period and `now()`.
 *
 * CLIENT-AGGREGATED, in `src/features/admin/analyticsAggregate.ts`:
 *   * every rollup — the headline totals, the per-department and per-employee
 *     breakdowns, the daily trend, and the today-board tile counts.
 *
 * WHY the rollups are client-side: PostgREST cannot GROUP BY, and no deployed
 * relation rolls the day grain up over an ARBITRARY period. `f_attendance_period_summary`
 * is per employee, `v_attendance_monthly_summary` is a matview pinned to
 * (year, month), and `v_attendance_late_trend` covers only late/on-time/absent
 * counts. Adding SQL was not in scope for this layer, so the day rows are fetched
 * (bounded, see {@link ANALYTICS_DAY_ROW_CAP}) and added up in a module that
 * imports no network client — which is what makes the arithmetic unit-testable.
 * Every result carries {@link AnalyticsProvenance} saying so, plus the row count
 * it was computed over and whether that row set was truncated.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW A DIMENSION FILTER IS APPLIED — investigated, not assumed
 * ═══════════════════════════════════════════════════════════════════════════
 * `AnalyticsFilters` holds IDS (a department can be renamed; the label is looked
 * up, the filter is the key). The views do not all carry those ids:
 *
 *   * `employee_id`  — PRESENT on `v_attendance_day_enriched`. Filtered directly
 *     with `eq('employee_id', …)`. No resolution needed.
 *   * `department_id` / `location_id` — ABSENT. Migration 034 builds the view as
 *     `LEFT JOIN departments d ON d.id = ad.department_id` and selects only
 *     `d.name AS department_name` (same for `locations`). Verified against
 *     supabase/migrations/20260801003400_views_attendance.sql; no later migration
 *     redefines the view.
 *
 * So the id is RESOLVED TO A NAME through `fetchOrgRefs`, and the query filters
 * `eq('department_name', name)`. Three consequences, all handled rather than
 * hidden:
 *
 *   1. TWO DEPARTMENTS CAN SHARE A NAME. Then the filter matches both and the
 *      figures are wider than the filter says. Detected here (more than one
 *      active master row with that name) and reported as
 *      `analytics.caveat.departmentAmbiguous` so the screen can say it.
 *   2. AN ID THAT IS NOT IN THE ACTIVE MASTER LIST resolves to nothing. The scope
 *      is then marked `unresolved` and every fetcher returns an EMPTY result —
 *      never an unfiltered one. Silently dropping the predicate would print
 *      whole-organisation numbers under one department's heading, which is the
 *      worst possible failure mode for a filter bar.
 *   3. `fetchOrgRefs` is the SAME list that populates the filter dropdowns, so
 *      the resolver and the filter bar cannot disagree about what an id means.
 *
 * Two alternatives were rejected. Resolving a department to its employee ids and
 * sending `employee_id=in.(…)` blows past URL limits at a few hundred people and
 * silently mis-scopes anyone who transferred mid-period (the day row records the
 * department AS AT that day; the employee row records it as at now). Filtering
 * client-side after fetching everything would make every department view scan the
 * whole venue and truncate sooner.
 *
 * NOT APPLICABLE: `AnalyticsFilters.source`. Punch source lives on
 * `attendance_punches.source` — a per-SCAN column. The day view has no source
 * column at all (only `v_attendance_today_board` exposes `web_punch_count`), so a
 * source filter cannot be honoured at day grain. It is reported as
 * `analytics.caveat.sourceNotApplicable` rather than silently ignored.
 */
import { z } from "zod";
import {
  dbDate,
  dbInt,
  dbNumeric,
  dbUuid,
  eq,
  gte,
  isFalse,
  lte,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import type { MessageKey } from "@/shared/i18n/en";
import type { AnalyticsFilters } from "@/lib/analyticsFilters";
import type { Period } from "@/lib/period";
import {
  V_DAY_ENRICHED,
  V_PUNCH_DETAIL,
  V_TODAY_BOARD,
  attendanceStatusSchema,
  todayBoardRowSchema,
  type TodayBoardRow,
} from "./attendance.api";
import { fetchOrgRefs } from "./org.api";
import {
  aggregateDailyTrend,
  aggregateEmployeeDetail,
  aggregateMeasures,
  groupByDepartment,
  groupByEmployee,
  groupByLocation,
  summariseTodayBoard,
  type AnalyticsDayRow,
  type AttendanceMeasures,
  type DailyTrendPoint,
  type DepartmentBreakdownRow,
  type EmployeeBreakdownRow,
  type EmployeeDetailAggregate,
  type LocationBreakdownRow,
  type TodayTiles,
} from "../analyticsAggregate";

// Re-exported so a screen has ONE import for the analytics data layer and does
// not have to know that the arithmetic lives in a sibling module.
export {
  EMPTY_MEASURES,
  EMPTY_TODAY_TILES,
  MAX_TREND_POINTS,
  aggregateDailyTrend,
  aggregateEmployeeDetail,
  aggregateMeasures,
  classifyDayStatus,
  dayClockMinutes,
  groupByDepartment,
  groupByEmployee,
  groupByLocation,
  groupLeaveDaysByType,
  hmToMinutes,
  meanIgnoringNulls,
  summariseTodayBoard,
} from "../analyticsAggregate";
export type {
  AnalyticsDayRow,
  AttendanceMeasures,
  DailyTrendPoint,
  DayClass,
  DayStatus,
  DepartmentBreakdownRow,
  EmployeeBreakdownRow,
  EmployeeDetailAggregate,
  LeaveTypeDays,
  LocationBreakdownRow,
  TodayBoardFlags,
  TodayTiles,
} from "../analyticsAggregate";

// -----------------------------------------------------------------------------
// Caps
// -----------------------------------------------------------------------------

/**
 * Hard ceiling on day rows pulled for ONE analytics answer.
 *
 * 10,000 employee-days is roughly a year for a 30-person department, or seven
 * weeks for the whole venue at 200 heads. Past it the rows are truncated —
 * EARLIEST dates first, because the query is ordered by `ist_date` and PostgREST
 * applies the order before the limit — and `provenance.truncated` goes true so
 * the screen can tell the user the answer is partial instead of quietly showing
 * half a year. It is not raised further because the wire cost is linear and an
 * admin waiting on 40,000 rows will assume the page is broken.
 */
export const ANALYTICS_DAY_ROW_CAP = 10_000;

/**
 * The live board is one row per active, attendance-tracked employee the caller
 * may see. 1,000 is comfortably above this venue's headcount; the flag exists so
 * a future site does not silently under-count the tiles.
 */
export const TODAY_BOARD_ROW_CAP = 1_000;

// -----------------------------------------------------------------------------
// Provenance — shipped with every result
// -----------------------------------------------------------------------------

export interface AnalyticsProvenance {
  /** The relation the rows came from, for the error_ref and the "source" line. */
  readonly relation: string;
  /** `server` = Postgres counted it; `client` = this browser added it up. */
  readonly computedBy: "server" | "client";
  /** How many rows the figures were computed over. */
  readonly rowsScanned: number;
  /** The cap in force, so the screen can interpolate it into the caveat. */
  readonly rowCap: number;
  /** True when `rowsScanned` hit the cap: the answer covers part of the period. */
  readonly truncated: boolean;
  /** i18n keys for everything the reader must know. May be empty. */
  readonly caveats: readonly MessageKey[];
}

// -----------------------------------------------------------------------------
// Scope resolution — AnalyticsFilters → query.ts Filters
// -----------------------------------------------------------------------------

export interface ResolvedScope {
  /** Ready for `selectMany({ filters })` — period plus every honoured dimension. */
  readonly filters: readonly Filter[];
  /** The name the department id resolved to, for headings. Null when unfiltered. */
  readonly departmentName: string | null;
  readonly locationName: string | null;
  /**
   * A dimension id named something we cannot see. Fetchers MUST return an empty
   * result rather than an unfiltered one — see the header.
   */
  readonly unresolved: boolean;
  readonly caveats: readonly MessageKey[];
}

/** The period predicate on its own — every analytics read starts here. */
function periodFilters(period: Period): Filter[] {
  return [gte("ist_date", period.from), lte("ist_date", period.to)];
}

interface OrgRef {
  readonly id: string;
  readonly name: string;
}

/** The active masters the resolver needs. Both lists come from `fetchOrgRefs`. */
export interface OrgRefs {
  readonly departments: readonly OrgRef[];
  readonly locations: readonly OrgRef[];
}

export const NO_ORG_REFS: OrgRefs = { departments: [], locations: [] };

/**
 * True when these filters cannot be turned into a query without reading the
 * department/location masters. Lets a caller skip the round trip entirely on an
 * unfiltered dashboard, and lets the hooks gate on the cached masters instead of
 * re-reading them every time the period is stepped.
 */
export function analyticsScopeNeedsMasters(filters: AnalyticsFilters): boolean {
  return filters.departmentId !== undefined || filters.locationId !== undefined;
}

/** id → name, plus whether that name is unique among the active masters. */
function resolveRef(
  refs: readonly OrgRef[],
  id: string,
): { name: string; ambiguous: boolean } | null {
  const mine = refs.find((r) => r.id === id);
  if (mine === undefined) return null;
  let sameName = 0;
  for (const r of refs) if (r.name === mine.name) sameName += 1;
  return { name: mine.name, ambiguous: sameName > 1 };
}

/**
 * Turn the URL-backed filter model into a `query.ts` filter array — PURE, given
 * the masters. Separated from the fetch so the period can be stepped a dozen
 * times without re-reading the department table, and so the id→name policy
 * described in the header is testable without a network.
 *
 * Pass {@link NO_ORG_REFS} only when {@link analyticsScopeNeedsMasters} is
 * false; passing it with a department set (correctly) yields `unresolved`.
 */
export function scopeFrom(filters: AnalyticsFilters, refs: OrgRefs): ResolvedScope {
  const out: Filter[] = periodFilters(filters.period);
  const caveats: MessageKey[] = [];

  // The day grain has no punch-source column; say so rather than pretend.
  if (filters.source !== "all") caveats.push("analytics.caveat.sourceNotApplicable");

  // The one dimension the view carries as an id.
  if (filters.employeeId !== undefined) out.push(eq("employee_id", filters.employeeId));

  let departmentName: string | null = null;
  let locationName: string | null = null;
  let unresolved = false;

  if (filters.departmentId !== undefined) {
    const hit = resolveRef(refs.departments, filters.departmentId);
    if (hit === null) {
      unresolved = true;
      caveats.push("analytics.caveat.departmentUnknown");
    } else {
      departmentName = hit.name;
      out.push(eq("department_name", hit.name));
      if (hit.ambiguous) caveats.push("analytics.caveat.departmentAmbiguous");
    }
  }

  if (filters.locationId !== undefined) {
    const hit = resolveRef(refs.locations, filters.locationId);
    if (hit === null) {
      unresolved = true;
      caveats.push("analytics.caveat.locationUnknown");
    } else {
      locationName = hit.name;
      out.push(eq("location_name", hit.name));
      if (hit.ambiguous) caveats.push("analytics.caveat.locationAmbiguous");
    }
  }

  return { filters: out, departmentName, locationName, unresolved, caveats };
}

/**
 * {@link scopeFrom} with the masters fetched for you — one read of each master
 * that is actually needed, none at all when no dimension is set.
 *
 * Callers rendering several panels from one filter state should read the masters
 * once (`fetchFilterOptions` / `useAnalyticsFilterOptions`) and call
 * {@link scopeFrom} instead, or pass the result as `opts.scope`.
 */
export async function resolveAnalyticsScope(
  filters: AnalyticsFilters,
  signal?: AbortSignal,
): Promise<ResolvedScope> {
  if (!analyticsScopeNeedsMasters(filters)) return scopeFrom(filters, NO_ORG_REFS);
  const [departments, locations] = await Promise.all([
    filters.departmentId === undefined
      ? Promise.resolve<OrgRef[]>([])
      : fetchOrgRefs("departments", signal),
    filters.locationId === undefined
      ? Promise.resolve<OrgRef[]>([])
      : fetchOrgRefs("locations", signal),
  ]);
  return scopeFrom(filters, { departments, locations });
}

// -----------------------------------------------------------------------------
// The one day-grain read every rollup is built from
// -----------------------------------------------------------------------------

/**
 * The projection. Named explicitly because `v_attendance_day_enriched` is ~60
 * columns wide and this read can return 10,000 rows — selecting `*` would put
 * several megabytes on the wire for measures that need 25 fields.
 */
const ANALYTICS_DAY_COLUMNS = [
  "employee_id",
  "employee_code",
  "display_name",
  "ist_date",
  "status",
  "department_name",
  "location_name",
  "first_in_hm",
  "last_out_hm",
  "punch_count",
  "gross_span_minutes",
  "break_minutes",
  "break_count",
  "total_worked_minutes",
  "is_late",
  "late_minutes",
  "is_early_exit",
  "early_exit_minutes",
  "overtime_minutes",
  "approved_overtime_minutes",
  "leave_type_name",
  "leave_day_fraction",
  "is_holiday",
  "is_weekly_off",
  "is_working_day",
  "has_anomalies",
].join(",");

/**
 * Every numeric column below is `NOT NULL DEFAULT 0` in `attendance_days`
 * (migration 017) — verified, not assumed — so the schema is non-nullable and a
 * NULL arriving here is a genuine schema drift that surfaces as a parse error
 * rather than a silent zero in an average.
 */
export const analyticsDaySchema = z.object({
  employee_id: dbUuid,
  /*
    NULLABLE, and the paragraph above does not cover these two: they are not
    columns of `attendance_days` at all. `v_attendance_day_enriched` reaches them
    through `LEFT JOIN public.v_employee_ref`, and that view carries
    `WHERE e.deleted_at IS NULL` plus a visibility predicate — so the label is
    null for an attendance day whose employee has since been archived, or who
    falls outside the caller's scope. The join is LEFT precisely so the day still
    exists; the label going missing is the designed behaviour, not drift.

    Declaring them `z.string()` turned that into a thrown parse error that took
    down the whole panel with "Something went wrong" — one archived employee with
    history was enough. Reported after the demo staff were archived and their
    seeded attendance days outlived them.
  */
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  ist_date: dbDate,
  status: attendanceStatusSchema,
  department_name: z.string().nullable(),
  location_name: z.string().nullable(),
  first_in_hm: z.string().nullable(),
  last_out_hm: z.string().nullable(),
  punch_count: dbInt,
  gross_span_minutes: dbInt,
  break_minutes: dbInt,
  break_count: dbInt,
  total_worked_minutes: dbInt,
  is_late: z.boolean(),
  late_minutes: dbInt,
  is_early_exit: z.boolean(),
  early_exit_minutes: dbInt,
  overtime_minutes: dbInt,
  approved_overtime_minutes: dbInt,
  leave_type_name: z.string().nullable(),
  leave_day_fraction: dbNumeric,
  is_holiday: z.boolean(),
  is_weekly_off: z.boolean(),
  is_working_day: z.boolean(),
  has_anomalies: z.boolean(),
});

export interface AnalyticsFetchOptions {
  readonly signal?: AbortSignal;
  /** Override {@link ANALYTICS_DAY_ROW_CAP} — lower it, never raise it blindly. */
  readonly limit?: number;
  /** Pre-resolved scope, so a screen with five panels resolves the ids once. */
  readonly scope?: ResolvedScope;
}

/** The day rows plus the scope and provenance every rollup inherits. */
export interface AnalyticsDayPage {
  readonly rows: readonly AnalyticsDayRow[];
  readonly scope: ResolvedScope;
  readonly period: Period;
  readonly provenance: AnalyticsProvenance;
}

function provenanceFor(
  scope: ResolvedScope,
  rowsScanned: number,
  cap: number,
  relation: string,
  unattributable = 0,
): AnalyticsProvenance {
  const truncated = rowsScanned >= cap;
  const caveats = [...scope.caveats];
  if (truncated) caveats.push("analytics.caveat.truncated");
  // Dropping rows without saying so would make every figure quietly smaller than
  // the truth. Same reasoning as the truncation caveat.
  if (unattributable > 0) caveats.push("analytics.caveat.unattributable");
  return {
    relation,
    computedBy: "client",
    rowsScanned,
    rowCap: cap,
    truncated,
    caveats,
  };
}

/**
 * THE read. Ordered by (ist_date, employee_id) so the trend, the breakdowns and
 * a truncated result are all deterministic, and so `groupByEmployee` can take
 * the last row of the period as an employee's current department.
 */
export async function fetchAnalyticsDays(
  filters: AnalyticsFilters,
  opts: AnalyticsFetchOptions = {},
): Promise<AnalyticsDayPage> {
  const scope = opts.scope ?? (await resolveAnalyticsScope(filters, opts.signal));
  const cap = opts.limit ?? ANALYTICS_DAY_ROW_CAP;

  // An id we could not resolve means "show nothing", never "show everything".
  if (scope.unresolved) {
    return {
      rows: [],
      scope,
      period: filters.period,
      provenance: provenanceFor(scope, 0, cap, V_DAY_ENRICHED),
    };
  }

  const scanned = await selectMany(V_DAY_ENRICHED, analyticsDaySchema, {
    columns: ANALYTICS_DAY_COLUMNS,
    filters: scope.filters,
    order: [
      { column: "ist_date", ascending: true },
      { column: "employee_id", ascending: true },
    ],
    limit: cap,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  /*
    A day whose employee label is null cannot be attributed to anybody the caller
    can see — the employee is archived, or outside their scope. It is dropped
    rather than counted: it would move a headcount and a late-percentage against a
    person who does not appear anywhere else on the screen, and `groupByEmployee`
    would key them all together under one null name.

    Dropping is reported through the caveat above, never silently. Narrowing this
    in the query instead (`employee_code=not.is.null`) would hide the same rows
    without any count to report.
  */
  const rows = scanned.filter(
    (r): r is AnalyticsDayRow => r.employee_code !== null && r.display_name !== null,
  );

  return {
    rows,
    scope,
    period: filters.period,
    provenance: provenanceFor(scope, scanned.length, cap, V_DAY_ENRICHED, scanned.length - rows.length),
  };
}

// -----------------------------------------------------------------------------
// Rollups — pure page → result, so a hook can `select` them off ONE cached fetch
// -----------------------------------------------------------------------------
//
// Each `*Of` function is synchronous and side-effect free. The async `fetch*`
// below it is the documented entry point; the hooks in useAnalytics.ts run the
// day read ONCE and derive all five results with these, because five separate
// fetches of the same 10,000 rows is not an acceptable way to draw one screen.

export interface AttendanceSummaryResult {
  readonly period: Period;
  readonly scope: ResolvedScope;
  readonly measures: AttendanceMeasures;
  readonly provenance: AnalyticsProvenance;
}

export function summaryOf(page: AnalyticsDayPage): AttendanceSummaryResult {
  return {
    period: page.period,
    scope: page.scope,
    measures: aggregateMeasures(page.rows),
    provenance: page.provenance,
  };
}

/**
 * Headline aggregates for the period: days counted, distinct employees, the
 * present / absent / leave / holiday split, the duration averages and their
 * denominators, lateness, overtime and anomalies.
 */
export async function fetchAttendanceSummary(
  filters: AnalyticsFilters,
  opts: AnalyticsFetchOptions = {},
): Promise<AttendanceSummaryResult> {
  return summaryOf(await fetchAnalyticsDays(filters, opts));
}

export interface DepartmentBreakdownResult {
  readonly rows: readonly DepartmentBreakdownRow[];
  readonly provenance: AnalyticsProvenance;
}

export function departmentBreakdownOf(page: AnalyticsDayPage): DepartmentBreakdownResult {
  return { rows: groupByDepartment(page.rows), provenance: page.provenance };
}

/** The same measures, one row per `department_name` (unassigned included). */
export async function fetchDepartmentBreakdown(
  filters: AnalyticsFilters,
  opts: AnalyticsFetchOptions = {},
): Promise<DepartmentBreakdownResult> {
  return departmentBreakdownOf(await fetchAnalyticsDays(filters, opts));
}

export interface LocationBreakdownResult {
  readonly rows: readonly LocationBreakdownRow[];
  readonly provenance: AnalyticsProvenance;
}

export function locationBreakdownOf(page: AnalyticsDayPage): LocationBreakdownResult {
  return { rows: groupByLocation(page.rows), provenance: page.provenance };
}

/** The same measures, one row per `location_name`. */
export async function fetchLocationBreakdown(
  filters: AnalyticsFilters,
  opts: AnalyticsFetchOptions = {},
): Promise<LocationBreakdownResult> {
  return locationBreakdownOf(await fetchAnalyticsDays(filters, opts));
}

export interface EmployeeBreakdownResult {
  readonly rows: readonly EmployeeBreakdownRow[];
  readonly provenance: AnalyticsProvenance;
}

export function employeeBreakdownOf(page: AnalyticsDayPage): EmployeeBreakdownResult {
  return { rows: groupByEmployee(page.rows), provenance: page.provenance };
}

/**
 * The same measures, one row per employee — the list the department bars drill
 * into, and the list whose rows drill into {@link fetchEmployeeDetail}.
 */
export async function fetchEmployeeBreakdown(
  filters: AnalyticsFilters,
  opts: AnalyticsFetchOptions = {},
): Promise<EmployeeBreakdownResult> {
  return employeeBreakdownOf(await fetchAnalyticsDays(filters, opts));
}

export interface EmployeeDetailResult {
  readonly detail: EmployeeDetailAggregate;
  readonly provenance: AnalyticsProvenance;
}

export function employeeDetailOf(
  page: AnalyticsDayPage,
  employeeId: string | null,
): EmployeeDetailResult {
  return {
    detail: aggregateEmployeeDetail(page.rows, employeeId),
    provenance: page.provenance,
  };
}

/**
 * One employee's period: their day rows oldest-first plus their own averages
 * (first in, last out, worked, span, leave days, late days).
 *
 * `filters.employeeId` is applied SERVER-side by the scope, so the fetch pulls
 * only that employee's days — a month is ~31 rows and can never truncate. The
 * client-side re-filter in `aggregateEmployeeDetail` is belt and braces for the
 * case where a caller passes a page that was fetched for everybody.
 */
export async function fetchEmployeeDetail(
  filters: AnalyticsFilters,
  opts: AnalyticsFetchOptions = {},
): Promise<EmployeeDetailResult> {
  const page = await fetchAnalyticsDays(filters, opts);
  return employeeDetailOf(page, filters.employeeId ?? null);
}

export interface DailyTrendResult {
  readonly points: readonly DailyTrendPoint[];
  readonly provenance: AnalyticsProvenance;
}

export function dailyTrendOf(page: AnalyticsDayPage): DailyTrendResult {
  return { points: aggregateDailyTrend(page.rows, page.period), provenance: page.provenance };
}

/**
 * One point per IST date in the period, gaps flagged rather than closed over.
 *
 * A truncated page matters most here: the missing days are at the END of the
 * period (the read is date-ascending), so the tail of the line would fall to
 * zero and read as a collapse in attendance. The chart must check
 * `provenance.truncated` before drawing.
 */
export async function fetchDailyTrend(
  filters: AnalyticsFilters,
  opts: AnalyticsFetchOptions = {},
): Promise<DailyTrendResult> {
  return dailyTrendOf(await fetchAnalyticsDays(filters, opts));
}

// -----------------------------------------------------------------------------
// Today board — a different relation, a different grain, its own provenance
// -----------------------------------------------------------------------------

export interface TodayBoardResult {
  readonly rows: readonly TodayBoardRow[];
  readonly tiles: TodayTiles;
  readonly provenance: AnalyticsProvenance;
}

/**
 * "How many are in today". Deliberately takes NO period: the board is pinned to
 * `util.ist_today()` inside the view, so passing it a period would imply a
 * history it cannot serve — that question is `fetchDailyTrend`'s.
 *
 * Every flag counted here was decided by Postgres against the employee's shift
 * and grace period; the tiles are counts of those flags and nothing else. The
 * flags overlap on purpose (someone who arrived late is both `attended` and
 * `late_in`), so the tiles are independent counts, never a breakdown of a whole.
 */
export async function fetchTodayBoard(
  opts: { readonly signal?: AbortSignal; readonly limit?: number } = {},
): Promise<TodayBoardResult> {
  const cap = opts.limit ?? TODAY_BOARD_ROW_CAP;
  const rows = await selectMany(V_TODAY_BOARD, todayBoardRowSchema, {
    order: [{ column: "display_name", ascending: true }],
    limit: cap,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const truncated = rows.length >= cap;
  return {
    rows,
    tiles: summariseTodayBoard(rows),
    provenance: {
      relation: V_TODAY_BOARD,
      computedBy: "client",
      rowsScanned: rows.length,
      rowCap: cap,
      truncated,
      caveats: truncated ? ["analytics.caveat.truncated"] : [],
    },
  };
}

// -----------------------------------------------------------------------------
// Capture split — web vs the gate tablet, counted by Postgres
// -----------------------------------------------------------------------------
//
// The client asked for web and on-premise punches to be told apart. The DAY view
// cannot answer it (see the header: `source` is a per-SCAN column, which is why
// `scopeFrom` reports `analytics.caveat.sourceNotApplicable`), so this is the one
// place the question is asked of the scan grain instead — `v_attendance_punch_detail`,
// the same relation the Punch Log reads.
//
// Counted, never fetched: six `count=exact` HEADs put no rows on the wire and the
// figures are Postgres's, not this browser's. Six round trips is the price of not
// pulling a period of scans to call `.length` on them.

/**
 * `public.punch_source`, in the order the split is presented — the gate tablet
 * first because it is the norm at this venue, hand-entry and import last because
 * those are the rows a reviewer is actually hunting for.
 */
export const PUNCH_SOURCES = ["kiosk_face", "web", "mobile", "manual", "import"] as const;

export type PunchSource = (typeof PUNCH_SOURCES)[number];

export interface CaptureSplitRow {
  readonly source: PunchSource;
  readonly punches: number;
}

export interface CaptureSplitResult {
  readonly rows: readonly CaptureSplitRow[];
  /**
   * The SAME predicate with no source narrowing. It is read separately rather
   * than added up here, so `rows` summing to `total` is a CHECK on this list
   * against the deployed enum — a punch_source nobody told this module about
   * shows up as a gap between the two instead of being silently absorbed.
   */
  readonly total: number;
}

export const EMPTY_CAPTURE_SPLIT: CaptureSplitResult = {
  rows: PUNCH_SOURCES.map((source) => ({ source, punches: 0 })),
  total: 0,
};

/**
 * How one employee's scans were captured over a period.
 *
 * VOIDED SCANS ARE EXCLUDED. The Punch Log shows them (struck through) because it
 * is evidence; a capture-method split is a question about how attendance was
 * actually recorded, and a voided scan recorded nothing.
 *
 * Filtered on `effective_date`, not `ist_date` — same column `punchFilters` uses,
 * so a night shift's 02:00 scan is counted against the business day it belongs to
 * and this panel cannot disagree with the day rows beside it.
 */
export async function fetchCaptureSplit(
  employeeId: string,
  period: Period,
  opts: { readonly signal?: AbortSignal } = {},
): Promise<CaptureSplitResult> {
  const base: Filter[] = [
    gte("effective_date", period.from),
    lte("effective_date", period.to),
    eq("employee_id", employeeId),
    isFalse("is_voided"),
  ];
  const countOpts = opts.signal ? { signal: opts.signal } : {};
  const [total, counts] = await Promise.all([
    selectCount(V_PUNCH_DETAIL, base, countOpts),
    Promise.all(
      PUNCH_SOURCES.map((source) => selectCount(V_PUNCH_DETAIL, [...base, eq("source", source)], countOpts)),
    ),
  ]);
  return { total, rows: PUNCH_SOURCES.map((source, i) => ({ source, punches: counts[i] ?? 0 })) };
}

// -----------------------------------------------------------------------------
// Filter bar options
// -----------------------------------------------------------------------------

export interface FilterOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface FilterOptions {
  readonly departments: readonly FilterOption[];
  readonly locations: readonly FilterOption[];
}

/**
 * The dropdown contents for the filter bar — active masters only, name-ordered
 * by the server.
 *
 * This is the SAME call `resolveAnalyticsScope` uses to turn an id back into a
 * name, which is what guarantees that anything the bar can offer, the resolver
 * can resolve. Employees are deliberately absent: that list is thousands long,
 * belongs to the employee picker, and the employee filter is normally set by
 * drilling into a row rather than by choosing from a dropdown.
 */
export async function fetchFilterOptions(signal?: AbortSignal): Promise<FilterOptions> {
  const [departments, locations] = await Promise.all([
    fetchOrgRefs("departments", signal),
    fetchOrgRefs("locations", signal),
  ]);
  return { departments, locations };
}
