/**
 * hr-workforce.api.ts — the reads behind the Workforce & Org panel: headcount
 * as at a date, how it splits across the org, span of control, tenure, age,
 * diversity, and the headcount trend over the selected period.
 *
 * WHY A SECOND WORKFORCE MODULE, AND WHAT IT DOES NOT DUPLICATE
 * -------------------------------------------------------------
 * `analytics-workforce.api.ts` already answers the /admin/analytics/workforce
 * screen: server `count=exact` per department / employment type / lifecycle
 * state, plus the `v_headcount_monthly` series. Every one of those is a figure
 * Postgres can produce with a predicate it already has.
 *
 * This module answers the questions Postgres CANNOT be asked through PostgREST
 * at all — a group-by on designation, on grade, on tenure band, on age band, on
 * five diversity attributes, and a reportee count per manager. There is no
 * deployed relation for any of them, and a `count=exact` per bucket is not even
 * possible: `nationality` is free text and the designation master is open, so
 * the bucket vocabulary is unknowable before the rows are read. So the employee
 * rows are read ONCE, bounded (see {@link WORKFORCE_ROW_CAP}), and counted in
 * `../hrWorkforceAggregate` — a module with no client, no clock and a test file.
 * Every result carries {@link AnalyticsProvenance} saying `computedBy: "client"`.
 *
 * Two things are reused rather than rebuilt: `fetchHeadcountStamp` (the matview
 * staleness line) and the relation constants, both from the sibling module, and
 * `ACTIVE_EMPLOYMENT_STATUSES` from `employees.api.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW THE FILTERS ARE APPLIED — investigated, not assumed
 * ═══════════════════════════════════════════════════════════════════════════
 * `v_admin_employee` is `SELECT e.*` over `employees` plus resolved lookup names
 * (migration 033 §5, verified). So unlike the attendance day view, it carries
 * `department_id` AND `location_id` as real uuid columns. Both filters are
 * therefore applied SERVER-SIDE by id, with no name resolution — which also
 * means this panel is immune to the two-departments-share-a-name ambiguity that
 * `analytics.api.ts` has to detect and caveat.
 *
 *   * PERIOD → an AS-AT DATE, not a range. Headcount is a stock, not a flow:
 *     "how many people in July" is only meaningful at an instant. The panel
 *     therefore takes the end of the period, clamped to today
 *     (`resolveAsOf`), and says which date it used.
 *   * EMPLOYEE — refused, not ignored. A headcount of one person is not a
 *     measure. The panel hides that control on the filter bar and reports
 *     `caveat.employeeIgnored` if a URL still carries one.
 *   * SOURCE — not applicable. Punch source is a column of
 *     `attendance_punches`; an employee roster has no such concept.
 *   * LOCATION on the TREND — impossible, and refused rather than faked.
 *     `analytics.mv_headcount_daily` groups by (date × department ×
 *     employment_type) only (migration 036 §4); there is no location column to
 *     filter on. Drawing the whole-venue line under a one-location heading is
 *     exactly the failure this codebase treats as worse than no chart, so
 *     {@link fetchHeadcountTrend} returns `applicable: false` and no rows.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  isNull,
  lte,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { nowIstDate } from "@/lib/datetime";
import type { MessageKey } from "@/shared/i18n/en";
import type { AnalyticsFilters } from "@/lib/analyticsFilters";
import type { Period } from "@/lib/period";
import type { AnalyticsProvenance } from "./analytics.api";
import {
  ACTIVE_EMPLOYMENT_STATUSES,
  V_ADMIN_EMPLOYEE,
  employmentStatusSchema,
  employmentTypeSchema,
} from "./employees.api";
import { V_HEADCOUNT_DAILY, fetchHeadcountStamp } from "./analytics-workforce.api";
import { USER_ROLES_TABLE } from "./system.api";
import {
  aggregateHeadcountTrend,
  aggregateWorkforce,
  resolveAsOf,
  type AsOf,
  type HeadcountDailyRow,
  type HeadcountTrendPoint,
  type WorkforceEmployeeRow,
  type WorkforceSnapshot,
} from "../hrWorkforceAggregate";

// Re-exported so a screen has ONE import for this data layer and does not have
// to know that the arithmetic lives in a sibling module.
export {
  AGE_BANDS,
  EMPTY_DIVERSITY,
  EMPTY_SPAN,
  MIN_PUBLISHABLE_BUCKET,
  TENURE_BANDS,
  WIDE_SPAN_THRESHOLD,
  aggregateHeadcountTrend,
  aggregateWorkforce,
  ageBandOf,
  completedMonths,
  completedYears,
  emptyWorkforceSnapshot,
  headcountBy,
  isOnRollAt,
  onRollAt,
  resolveAsOf,
  spanOfControl,
  suppressSmallBuckets,
  tenureBandOf,
} from "../hrWorkforceAggregate";
export type {
  AgeBand,
  AsOf,
  BandBreakdown,
  DiversityBreakdown,
  HeadcountBucket,
  HeadcountDailyRow,
  HeadcountDimension,
  HeadcountTrendPoint,
  ManagerSpan,
  SpanOfControl,
  SuppressedBreakdown,
  TenureBand,
  WorkforceEmployeeRow,
  WorkforceSnapshot,
} from "../hrWorkforceAggregate";

export { V_ADMIN_EMPLOYEE } from "./employees.api";
export { V_HEADCOUNT_DAILY } from "./analytics-workforce.api";

// -----------------------------------------------------------------------------
// Caps
// -----------------------------------------------------------------------------

/**
 * Hard ceiling on employee rows pulled for one snapshot.
 *
 * The grain here is one row per PERSON, not per person-day, so 5,000 is roughly
 * twenty times this venue's ever-employed population and truncation should
 * never fire. It exists anyway because a cap that never fires is free and a
 * missing cap is how a future tenant's dashboard quietly reports a third of its
 * staff. When it does fire, the read is ordered by `employee_code`, so the rows
 * lost are the last codes issued — the newest joiners — and every bucket on the
 * panel is understated. `provenance.truncated` is what the screen must check.
 */
export const WORKFORCE_ROW_CAP = 5_000;

/**
 * Hard ceiling on `v_headcount_daily` rows for one trend.
 *
 * The grain is (date × department × employment type). At this venue that is
 * roughly 20–30 rows a day, so 12,000 comfortably covers a year and stops a
 * hand-edited five-year range from pulling 50,000 rows to draw 1,500 points.
 * Truncation loses the END of the period (the read is date-ascending), which
 * would draw the workforce collapsing — the screen must say so instead.
 */
export const HEADCOUNT_TREND_ROW_CAP = 12_000;

// -----------------------------------------------------------------------------
// Scope
// -----------------------------------------------------------------------------

export interface WorkforceScope {
  /** Ready for `selectMany({ filters })` against `v_admin_employee`. */
  readonly filters: readonly Filter[];
  readonly asOf: AsOf;
  readonly departmentId: string | null;
  readonly locationId: string | null;
  readonly caveats: readonly MessageKey[];
}

/**
 * `AnalyticsFilters` → the predicates and the as-at date, PURE given `today`.
 *
 * Separated from the fetch so the caveat policy above is testable without a
 * network, and so a screen with five panels resolves the scope once.
 *
 * The join-date predicate is the one that does real work: `date_of_join <=
 * asOf` narrows the read to people who could possibly be on roll, and — because
 * `NULL <= date` is NULL and PostgREST drops it — it also excludes the
 * `pre_joining` rows with no agreed start date, exactly as
 * `analytics.mv_headcount_daily` does. The OTHER half of the as-at test
 * (`last_working_day IS NULL OR last_working_day >= asOf`) is an OR, which the
 * closed filter vocabulary in `query.ts` deliberately cannot express, so it is
 * applied per row by `isOnRollAt` — a predicate, not arithmetic, and under test.
 */
export function workforceScopeFrom(filters: AnalyticsFilters, today: string): WorkforceScope {
  const asOf = resolveAsOf(filters.period, today);
  const caveats: MessageKey[] = [];

  const out: Filter[] = [
    // The view already carries `WHERE e.deleted_at IS NULL` (033 §5). Repeated
    // at the call site so the intent is visible where the number is built, and
    // so a future redefinition that exposes archived rows to the Archive
    // console cannot silently inflate this headcount.
    isNull("deleted_at"),
    lte("date_of_join", asOf.date),
  ];

  const departmentId = filters.departmentId ?? null;
  if (departmentId !== null) out.push(eq("department_id", departmentId));
  const locationId = filters.locationId ?? null;
  if (locationId !== null) out.push(eq("location_id", locationId));

  if (filters.source !== "all") caveats.push("admin.hrwf.caveat.sourceNotApplicable");
  if (filters.employeeId !== undefined) caveats.push("admin.hrwf.caveat.employeeIgnored");
  if (asOf.clamped) caveats.push("admin.hrwf.caveat.asOfClamped");
  if (asOf.historical) caveats.push("admin.hrwf.caveat.dimensionsCurrent");

  return { filters: out, asOf, departmentId, locationId, caveats };
}

// -----------------------------------------------------------------------------
// The roster read
// -----------------------------------------------------------------------------

/**
 * The projection. Named explicitly because `v_admin_employee` is 111 columns
 * wide and this read can return thousands of rows — `*` would put megabytes of
 * masked bank and statutory tails on the wire for measures that need 21 fields.
 *
 * `religion` is absent on purpose. It is a column on `employees` and it is
 * special-category data under the DPDP Act; no measure on this panel needs it,
 * and the most reliable way not to disclose a field is not to fetch it.
 */
const WORKFORCE_COLUMNS = [
  "id",
  "employee_code",
  "display_name",
  "department_id",
  "department_name",
  "designation_name",
  "grade_name",
  "location_id",
  "location_name",
  "employment_type",
  "employment_status",
  "date_of_join",
  "last_working_day",
  "date_of_birth",
  "reporting_manager_id",
  "reporting_manager_name",
  "gender",
  "category",
  "is_differently_abled",
  "nationality",
  "marital_status",
].join(",");

/**
 * `employment_type` and `employment_status` are decoded through the deployed
 * enums, so a value nobody told this module about is a loud parse error rather
 * than a silent extra bar (`employment_status` in particular decides the
 * data-quality anomaly count, and a mystery value there would misreport it).
 *
 * `gender`, `category`, `marital_status` and `nationality` are decoded as plain
 * strings. They are only ever used as bucket keys, never branched on, and
 * `nationality` is free text with no enum at all — parsing them strictly would
 * take the whole panel down over a label.
 */
export const workforceEmployeeSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  grade_name: z.string().nullable(),
  location_id: dbUuidNullable,
  location_name: z.string().nullable(),
  employment_type: employmentTypeSchema,
  employment_status: employmentStatusSchema,
  date_of_join: dbDateNullable,
  last_working_day: dbDateNullable,
  date_of_birth: dbDateNullable,
  reporting_manager_id: dbUuidNullable,
  reporting_manager_name: z.string().nullable(),
  gender: z.string().nullable(),
  category: z.string().nullable(),
  is_differently_abled: z.boolean(),
  nationality: z.string().nullable(),
  marital_status: z.string().nullable(),
});

export interface WorkforceFetchOptions {
  readonly signal?: AbortSignal;
  /** Override {@link WORKFORCE_ROW_CAP} — lower it, never raise it blindly. */
  readonly limit?: number;
  /** Pre-resolved scope, so several panels resolve the filters once. */
  readonly scope?: WorkforceScope;
  /** Injected in tests; production passes the IST clock. */
  readonly today?: string;
}

/** The employee rows plus the scope and provenance every measure inherits. */
export interface WorkforceRosterPage {
  readonly rows: readonly WorkforceEmployeeRow[];
  readonly scope: WorkforceScope;
  readonly provenance: AnalyticsProvenance;
}

function provenanceFor(
  relation: string,
  rowsScanned: number,
  cap: number,
  caveats: readonly MessageKey[],
): AnalyticsProvenance {
  const truncated = rowsScanned >= cap;
  return {
    relation,
    computedBy: "client",
    rowsScanned,
    rowCap: cap,
    truncated,
    caveats: truncated ? [...caveats, "admin.hrwf.caveat.truncated"] : caveats,
  };
}

/**
 * THE roster read. Ordered by `employee_code` so a truncated page is
 * deterministic and so two loads of the same filters produce the same bars.
 */
export async function fetchWorkforceRoster(
  filters: AnalyticsFilters,
  opts: WorkforceFetchOptions = {},
): Promise<WorkforceRosterPage> {
  const scope = opts.scope ?? workforceScopeFrom(filters, opts.today ?? nowIstDate());
  const cap = opts.limit ?? WORKFORCE_ROW_CAP;
  const rows = await selectMany(V_ADMIN_EMPLOYEE, workforceEmployeeSchema, {
    columns: WORKFORCE_COLUMNS,
    filters: scope.filters,
    order: [{ column: "employee_code", ascending: true }],
    limit: cap,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return {
    rows,
    scope,
    provenance: provenanceFor(V_ADMIN_EMPLOYEE, rows.length, cap, scope.caveats),
  };
}

export interface WorkforceSnapshotResult {
  readonly snapshot: WorkforceSnapshot;
  readonly scope: WorkforceScope;
  readonly provenance: AnalyticsProvenance;
}

/**
 * Every measure, from one cached page — synchronous and side-effect free, so
 * the hooks can derive it with `select` off the ONE roster query rather than
 * reading the same rows once per panel.
 */
export function snapshotOf(page: WorkforceRosterPage): WorkforceSnapshotResult {
  return {
    snapshot: aggregateWorkforce(page.rows, {
      asOfDate: page.scope.asOf.date,
      // Passed through rather than redeclared in the pure module, so the
      // anomaly count and the People directory agree on what "on roll" means.
      onRollStatuses: ACTIVE_EMPLOYMENT_STATUSES,
    }),
    scope: page.scope,
    provenance: page.provenance,
  };
}

/** The documented entry point; the hooks use {@link snapshotOf} on a shared read. */
export async function fetchWorkforceSnapshot(
  filters: AnalyticsFilters,
  opts: WorkforceFetchOptions = {},
): Promise<WorkforceSnapshotResult> {
  return snapshotOf(await fetchWorkforceRoster(filters, opts));
}

// -----------------------------------------------------------------------------
// Headcount trend
// -----------------------------------------------------------------------------

const headcountDailySchema = z.object({
  as_of_date: dbDate,
  headcount: dbInt,
  joiners: dbInt,
  exits: dbInt,
});

export interface HeadcountTrendResult {
  readonly points: readonly HeadcountTrendPoint[];
  /**
   * False when the trend cannot honour the filters at all — today only when a
   * LOCATION is selected, because `mv_headcount_daily` has no location column.
   * The panel renders the reason instead of a chart; it must never fall back to
   * an unfiltered line under a filtered heading.
   */
  readonly applicable: boolean;
  /** `now()` at the last matview refresh, and the latest date it covers. */
  readonly refreshedAt: string | null;
  readonly coversTo: string | null;
  readonly provenance: AnalyticsProvenance;
}

/**
 * The headcount line over the period, summed across the matview's department ×
 * employment-type rows.
 *
 * The staleness stamp is read SEPARATELY from the period's rows (reusing
 * `fetchHeadcountStamp`), for the same reason `fetchAttendanceStamp` exists: a
 * period the matview holds no rows for still needs an honest "as of" line, and
 * a missing stamp beside an empty chart reads as a broken screen rather than as
 * a nightly job that has not run over these dates.
 */
export async function fetchHeadcountTrend(
  filters: AnalyticsFilters,
  opts: { readonly signal?: AbortSignal; readonly limit?: number } = {},
): Promise<HeadcountTrendResult> {
  const cap = opts.limit ?? HEADCOUNT_TREND_ROW_CAP;
  const period: Period = filters.period;

  if (filters.locationId !== undefined) {
    return {
      points: [],
      applicable: false,
      refreshedAt: null,
      coversTo: null,
      provenance: {
        relation: V_HEADCOUNT_DAILY,
        computedBy: "client",
        rowsScanned: 0,
        rowCap: cap,
        truncated: false,
        caveats: ["admin.hrwf.caveat.trendNoLocation"],
      },
    };
  }

  const trendFilters: Filter[] = [
    gte("as_of_date", period.from),
    lte("as_of_date", period.to),
  ];
  if (filters.departmentId !== undefined) trendFilters.push(eq("department_id", filters.departmentId));

  const signalOpt = opts.signal ? { signal: opts.signal } : {};
  const [rows, stamp] = await Promise.all([
    selectMany(V_HEADCOUNT_DAILY, headcountDailySchema, {
      columns: "as_of_date,headcount,joiners,exits",
      filters: trendFilters,
      order: [{ column: "as_of_date", ascending: true }],
      limit: cap,
      ...signalOpt,
    }),
    fetchHeadcountStamp(opts.signal),
  ]);

  const daily: HeadcountDailyRow[] = rows;
  return {
    points: aggregateHeadcountTrend(daily, period),
    applicable: true,
    refreshedAt: stamp?.refreshed_at ?? null,
    coversTo: stamp?.as_of_date ?? null,
    provenance: provenanceFor(V_HEADCOUNT_DAILY, rows.length, cap, []),
  };
}

// -----------------------------------------------------------------------------
// The manager ROLE count — a different population, kept apart on purpose
// -----------------------------------------------------------------------------

export interface ManagerRoleCount {
  /** Live (un-revoked) `user_roles.role = 'manager'` grants. */
  readonly grants: number;
  readonly provenance: AnalyticsProvenance;
}

/**
 * How many people hold an explicit `manager` ROLE grant.
 *
 * THIS IS NOT THE NUMBER OF MANAGERS, and the panel labels it so. "People with
 * reportees" is a distinct count of `employees.reporting_manager_id` and comes
 * from {@link snapshotOf}; this is a row count in `public.user_roles`. Three
 * reasons they are different populations, all verified rather than assumed:
 *
 *   1. `shared/auth/capabilities.ts` records that manager status in this
 *      product is DERIVED from reporting lines and never granted (spec-manager
 *      D-02-01), so this figure is expected to be 0 on a healthy deployment.
 *      Zero managers-by-grant alongside forty people-with-reportees is the
 *      correct reading, not a broken tile.
 *   2. `user_roles` keys on `profiles.id` — a login — while reportees point at
 *      `employees.id`. An employee with no account cannot appear here.
 *   3. It has NO org columns, so it cannot be narrowed by department or
 *      location. It is org-wide even when the rest of the panel is filtered,
 *      which the tile has to say.
 *
 * Counted by Postgres (`count=exact`, no rows on the wire), so its provenance is
 * `server` — the only figure on this panel that is.
 */
export async function fetchManagerRoleCount(
  opts: { readonly signal?: AbortSignal } = {},
): Promise<ManagerRoleCount> {
  const grants = await selectCount(
    USER_ROLES_TABLE,
    [eq("role", "manager"), isNull("revoked_at")],
    { ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  return {
    grants,
    provenance: {
      relation: USER_ROLES_TABLE,
      computedBy: "server",
      rowsScanned: grants,
      rowCap: 0,
      truncated: false,
      caveats: ["admin.hrwf.caveat.roleGrantScope"],
    },
  };
}
