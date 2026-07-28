/**
 * hr-movement.api.ts — the filter-aware reads behind the Movement & Risk panel:
 * joiners, exits, attrition, and the four watchlists that are actual work.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO RELATIONS, TWO GRAINS, TWO CADENCES — and the panel says which is which
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. `public.v_headcount_daily` — the admin-gated wrapper over
 *    `analytics.mv_headcount_daily` (migration 036 §4/§6). Grain is
 *    (as_of_date × department × employment_type); the columns read here are
 *    `headcount`, `joiners` and `exits`, all COUNTED BY POSTGRES inside the
 *    matview from `date_of_join` / `last_working_day` predicates. It is a
 *    MATERIALIZED view refreshed by pg_cron at 20:30 UTC — 02:00 IST (migration
 *    041, job `headcount_snapshot`) — and `public.refresh_analytics()` is granted
 *    to `service_role` only, so no browser can refresh it. Everything derived
 *    from it is therefore "as of" a stamp this module returns.
 *
 *    It is also generated only as far as `util.ist_today()` AT REFRESH TIME, so a
 *    period running into the future, or into today, has dates it does not hold.
 *    Those are gaps, handled in `hrMovementAggregate.ts`, never zeroes.
 *
 * 2. `public.v_admin_employee` — the live, admin-scoped employee master. Every
 *    watchlist, the joiner and exit lists, and the exit-quality breakdown come
 *    from here, from named columns: `date_of_join`, `confirmation_due_date`
 *    (a GENERATED STORED column), `confirmed_on`, `contract_end_date`,
 *    `resignation_date`, `last_working_day`, `notice_period_days`, `exit_type`,
 *    `exit_interview_done`, `is_rehire_eligible`, `full_and_final_settled_on`.
 *
 * The joiner/exit COUNTS are therefore available twice, and both are returned:
 * the snapshot's (which shares a source with the attrition denominator) and the
 * live master's (which is current). `reconcileMovement` compares them so a
 * disagreement is explained on screen rather than silently resolved.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS MODULE DOES NOT USE `scopeFrom` FROM analytics.api.ts
 * ═══════════════════════════════════════════════════════════════════════════
 * That resolver exists because `v_attendance_day_enriched` carries department and
 * location as NAMES ONLY, so an id has to be resolved through the masters — with
 * all the ambiguity handling that implies. Neither relation here has that
 * problem, verified against the migrations:
 *
 *   * `v_headcount_daily` selects `m.*` from the matview, which projects
 *     `department_id` (and `department_key`) directly;
 *   * `v_admin_employee` is `SELECT e.*` from `employees`, so `id`,
 *     `department_id` and `location_id` are all present.
 *
 * So {@link movementScopeFrom} is PURE and needs NO master read at all — one
 * fewer round trip, no name collisions, and a department filter that is exact
 * rather than "everything called Banquet".
 *
 * What the ids CANNOT reach is stated instead of ignored:
 *   * `location_id` — absent from the matview. The series and the attrition rate
 *     ignore a location filter; the watchlists honour it. Caveat
 *     `admin.movement.caveat.locationNotInSnapshot`.
 *   * `employeeId` — the matview has no employee grain at all. Same treatment,
 *     caveat `admin.movement.caveat.employeeNotInSnapshot`.
 *   * `AnalyticsFilters.source` — a per-SCAN attendance column with no bearing on
 *     headcount whatsoever. Reported with the shared
 *     `analytics.caveat.sourceNotApplicable`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS REUSED RATHER THAN RESTATED
 * ═══════════════════════════════════════════════════════════════════════════
 * `lifecycleEmployeeSchema`, `LIFECYCLE_COLUMNS`, `exitTypeValues` and
 * `EXIT_TYPE_LABELS` come from `lifecycle.api.ts`; `V_HEADCOUNT_DAILY` and
 * `fetchHeadcountStamp` from `analytics-workforce.api.ts`; `AnalyticsProvenance`
 * from `analytics.api.ts`. Only the two columns the lifecycle registers do not
 * project (`contract_end_date`, `location_id`) are added here.
 *
 * `lifecycleFilters` itself is NOT reused because it is module-private and cannot
 * express what these lists need — a `date_of_join` window, a `contract_end_date`
 * window, or a single-employee narrowing. Widening another screen's filter model
 * from here would couple two registers' predicates for no gain.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbUuidNullable,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lte,
  selectCount,
  selectMany,
  type Filter,
  type OrderSpec,
} from "@/shared/api/query";
import type { MessageKey } from "@/shared/i18n/en";
import type { AnalyticsFilters } from "@/lib/analyticsFilters";
import { addDays, daysBetween, type Period } from "@/lib/period";
import type { AnalyticsProvenance } from "./analytics.api";
import {
  V_HEADCOUNT_DAILY,
  fetchHeadcountStamp,
  type RefreshStamp,
} from "./analytics-workforce.api";
import { V_ADMIN_EMPLOYEE } from "./employees.api";
import { LIFECYCLE_COLUMNS, lifecycleEmployeeSchema } from "./lifecycle.api";
import {
  aggregateMovementSeries,
  contractWatchlist,
  exitQualityOf,
  groupMovementByDepartment,
  noticeWatchlist,
  probationWatchlist,
  seriesAttrition,
  type AttritionRate,
  type ContractWatchRow,
  type ExitQuality,
  type MovementDepartmentRow,
  type MovementSeries,
  type NoticeWatchRow,
  type ProbationWatchRow,
} from "../hrMovementAggregate";

// Re-exported so a screen has ONE import for this data layer and never has to
// know that the arithmetic lives in a sibling module.
export {
  EMPTY_EXIT_QUALITY,
  EMPTY_MOVEMENT_SERIES,
  MAX_MOVEMENT_POINTS,
  MIN_ANNUALISE_DAYS,
  NO_ATTRITION,
  attritionOf,
  hypotheticalAnnualiseFactor,
  reconcileMovement,
  seriesAttrition,
} from "../hrMovementAggregate";
export type {
  AttritionRate,
  ContractWatchRow,
  ExitQuality,
  ExitTypeCount,
  HeadcountDayRow,
  HeadcountPoint,
  MovementDepartmentRow,
  MovementEmployeeRow,
  MovementReconciliation,
  MovementSeries,
  NoticeWatchRow,
  ProbationWatchRow,
} from "../hrMovementAggregate";
export { EXIT_TYPE_LABELS, exitTypeValues, isExitType, type ExitType } from "./lifecycle.api";

// -----------------------------------------------------------------------------
// Caps
// -----------------------------------------------------------------------------

/**
 * Hard ceiling on snapshot rows for ONE answer.
 *
 * The grain is (date × department × employment_type). At this venue that is on
 * the order of 25 combinations a day, so 20,000 rows is roughly two years —
 * comfortably past the longest period the filter bar can express in one step (a
 * calendar year, ~9,000 rows). Past the cap the read is truncated EARLIEST-first,
 * because the query is ordered by `as_of_date` and PostgREST applies the order
 * before the limit; `provenance.truncated` goes true so the chart can say the
 * tail is missing instead of drawing a cliff.
 */
export const MOVEMENT_HEADCOUNT_ROW_CAP = 20_000;

/**
 * Hard ceiling on ONE watchlist. A watchlist longer than 300 rows is not a
 * to-do list any more, and every table states "showing the first N of M" when it
 * bites — with M counted by Postgres over the SAME predicate, so the header and
 * the rows cannot disagree.
 */
export const MOVEMENT_LIST_CAP = 300;

/**
 * How far past the period's end a contract expiry still counts as "coming up".
 *
 * 30 days, because a contract renewal needs a conversation and a signature and
 * finding out in the last week is finding out too late. It is a product decision,
 * not a data one, so it is named, exported and printed on the screen.
 */
export const CONTRACT_LOOKAHEAD_DAYS = 30;

// -----------------------------------------------------------------------------
// Scope — PURE, no master read (see the header)
// -----------------------------------------------------------------------------

export interface MovementScope {
  /** Dimension predicates for `v_admin_employee`. No date predicate — each list adds its own. */
  readonly employeeFilters: readonly Filter[];
  /** Dimension predicates for `v_headcount_daily`. Same: dates are per-read. */
  readonly headcountFilters: readonly Filter[];
  readonly caveats: readonly MessageKey[];
}

/**
 * `AnalyticsFilters` → the two views' own predicates. Synchronous and total:
 * both relations carry the ids, so nothing can fail to resolve and there is no
 * "unresolved → return nothing" branch to get wrong.
 *
 * `deleted_at IS NULL` is asserted explicitly on the employee side even though
 * `v_admin_employee` already carries it in its own WHERE clause (migration 033).
 * Migration 051 gives admins row visibility over soft-deleted employees for the
 * Archive console, and `lifecycle.api.ts` guards the same way; a watchlist that
 * started listing archived people after a future view change would be a quiet,
 * embarrassing defect.
 */
export function movementScopeFrom(filters: AnalyticsFilters): MovementScope {
  const employeeFilters: Filter[] = [isNull("deleted_at")];
  const headcountFilters: Filter[] = [];
  const caveats: MessageKey[] = [];

  if (filters.departmentId !== undefined) {
    // The one dimension BOTH relations carry as an id.
    employeeFilters.push(eq("department_id", filters.departmentId));
    headcountFilters.push(eq("department_id", filters.departmentId));
  }
  if (filters.locationId !== undefined) {
    employeeFilters.push(eq("location_id", filters.locationId));
    caveats.push("admin.movement.caveat.locationNotInSnapshot");
  }
  if (filters.employeeId !== undefined) {
    employeeFilters.push(eq("id", filters.employeeId));
    caveats.push("admin.movement.caveat.employeeNotInSnapshot");
  }
  // Punch source is a per-scan attendance column; headcount has no such notion.
  if (filters.source !== "all") caveats.push("analytics.caveat.sourceNotApplicable");

  return { employeeFilters, headcountFilters, caveats };
}

// -----------------------------------------------------------------------------
// 1. The headcount / movement series
// -----------------------------------------------------------------------------

/**
 * Named explicitly rather than `*`: the matview also projects `department_key`
 * (a zero-uuid indexing sentinel that must never reach the UI) and `refreshed_at`
 * on every row, and this read can return twenty thousand of them.
 */
const HEADCOUNT_COLUMNS = [
  "as_of_date",
  "department_id",
  "department_name",
  "employment_type",
  "headcount",
  "joiners",
  "exits",
].join(",");

/**
 * Every count column is `::integer` and non-null in the matview definition
 * (COUNT(*) FILTER …), so a NULL here is genuine schema drift and surfaces as a
 * parse error rather than a silent zero in an attrition denominator.
 */
export const headcountDaySchema = z.object({
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD date"),
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  employment_type: z.string(),
  headcount: z.number().int(),
  joiners: z.number().int(),
  exits: z.number().int(),
});

export interface MovementFetchOptions {
  readonly signal?: AbortSignal;
  /** Override the row cap — lower it, never raise it blindly. */
  readonly limit?: number;
  /** Pre-resolved scope, so a screen with several panels builds it once. */
  readonly scope?: MovementScope;
}

export interface MovementSeriesResult {
  readonly period: Period;
  readonly scope: MovementScope;
  readonly series: MovementSeries;
  readonly attrition: AttritionRate;
  readonly departments: readonly MovementDepartmentRow[];
  /**
   * The snapshot's own `refreshed_at` and the latest `as_of_date` it holds
   * ANYWHERE (not just in this period), so the screen can say how current the
   * series is and whether the period runs past the end of the data.
   */
  readonly stamp: RefreshStamp | null;
  /**
   * Days of the period the snapshot does not reach because it stops at
   * `stamp.as_of_date`. Zero when the snapshot covers the whole period.
   */
  readonly daysBeyondSnapshot: number;
  readonly provenance: AnalyticsProvenance;
}

function seriesProvenance(
  scope: MovementScope,
  rowsScanned: number,
  cap: number,
): AnalyticsProvenance {
  const truncated = rowsScanned >= cap;
  return {
    relation: V_HEADCOUNT_DAILY,
    // The matview counted the heads; this browser summed the departments and
    // averaged the days. Both halves are true and the label says the second.
    computedBy: "client",
    rowsScanned,
    rowCap: cap,
    truncated,
    caveats: truncated
      ? [...scope.caveats, "admin.movement.caveat.seriesTruncated"]
      : scope.caveats,
  };
}

/**
 * How many days of `period` fall after the last date the snapshot holds.
 *
 * Calendar arithmetic goes through `period.ts`'s `daysBetween` rather than a
 * local Date computation: one implementation of "how many days apart", used by
 * the pure aggregate and by this staleness check alike, is what keeps the
 * "{days} days missing" sentence agreeing with the gaps the chart draws.
 */
function daysBeyond(period: Period, stamp: RefreshStamp | null): number {
  if (stamp === null) return 0;
  if (period.to <= stamp.as_of_date) return 0;
  // Clamped at the period's own start: a period entirely in the future is
  // uncovered for its whole length, not merely for the gap since the refresh.
  const uncoveredFrom = period.from > stamp.as_of_date ? period.from : addDays(stamp.as_of_date, 1);
  if (uncoveredFrom > period.to) return 0;
  return daysBetween(uncoveredFrom, period.to) + 1;
}

/**
 * THE snapshot read. Ordered (as_of_date, department_id, employment_type) so the
 * series, the department table and a truncated result are all deterministic.
 *
 * The stamp is read in parallel by `fetchHeadcountStamp` — the same helper the
 * Workforce screen uses, so the two screens can never print different "as of"
 * lines for the same matview.
 */
export async function fetchMovementSeries(
  filters: AnalyticsFilters,
  opts: MovementFetchOptions = {},
): Promise<MovementSeriesResult> {
  const scope = opts.scope ?? movementScopeFrom(filters);
  const cap = opts.limit ?? MOVEMENT_HEADCOUNT_ROW_CAP;
  const period = filters.period;

  const [rows, stamp] = await Promise.all([
    selectMany(V_HEADCOUNT_DAILY, headcountDaySchema, {
      columns: HEADCOUNT_COLUMNS,
      filters: [
        gte("as_of_date", period.from),
        lte("as_of_date", period.to),
        ...scope.headcountFilters,
      ],
      order: [
        { column: "as_of_date", ascending: true },
        { column: "department_id", ascending: true, nullsFirst: false },
        { column: "employment_type", ascending: true },
      ],
      limit: cap,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
    fetchHeadcountStamp(opts.signal),
  ]);

  // The zod-parsed row structurally satisfies `HeadcountDayRow`; dropping a
  // column from `headcountDaySchema` therefore fails to compile HERE rather than
  // producing `undefined` inside an average.
  const series = aggregateMovementSeries(rows, period);
  return {
    period,
    scope,
    series,
    attrition: seriesAttrition(series),
    departments: groupMovementByDepartment(rows, period, series.coveredDays),
    stamp,
    daysBeyondSnapshot: daysBeyond(period, stamp),
    provenance: seriesProvenance(scope, rows.length, cap),
  };
}

// -----------------------------------------------------------------------------
// 2. The live employee reads — watchlists and action lists
// -----------------------------------------------------------------------------

/**
 * The lifecycle registers' projection plus the two columns they do not carry:
 * `contract_end_date` (the contract watchlist's whole predicate) and
 * `location_id` (needed so a location-filtered panel can be verified against the
 * rows it returned, and because filtering on an unprojected column is legal but
 * unauditable).
 */
export const MOVEMENT_EMPLOYEE_COLUMNS = `${LIFECYCLE_COLUMNS},contract_end_date,location_id`;

/**
 * `lifecycleEmployeeSchema` extended, not re-declared — the shared columns keep
 * one definition, so a future change to `exit_type`'s shape lands here too.
 */
export const movementEmployeeSchema = lifecycleEmployeeSchema.extend({
  contract_end_date: dbDateNullable,
  location_id: dbUuidNullable,
});
export type MovementEmployee = z.infer<typeof movementEmployeeSchema>;

/** One capped list plus the honest total behind it. */
export interface CappedList<T> {
  readonly rows: readonly T[];
  /**
   * The true cardinality of the predicate. Equal to `rows.length` unless the cap
   * bit, in which case it is counted by Postgres over the SAME filter array —
   * which is what stops the header and the table disagreeing (DR-29).
   */
  readonly total: number;
  readonly truncated: boolean;
}

/**
 * Read a capped list, and only when the cap actually bites pay for a COUNT.
 *
 * A watchlist is normally tens of rows, so the second round trip almost never
 * fires; when it does, the alternative (assuming `rows.length` is the total) is
 * exactly the "showing 300, is that all of them?" ambiguity this exists to kill.
 */
async function cappedList(
  filters: readonly Filter[],
  order: readonly OrderSpec[],
  cap: number,
  signal: AbortSignal | undefined,
): Promise<CappedList<MovementEmployee>> {
  const rows = await selectMany(V_ADMIN_EMPLOYEE, movementEmployeeSchema, {
    columns: MOVEMENT_EMPLOYEE_COLUMNS,
    filters,
    order,
    limit: cap,
    ...(signal ? { signal } : {}),
  });
  if (rows.length < cap) return { rows, total: rows.length, truncated: false };
  const total = await selectCount(V_ADMIN_EMPLOYEE, filters, { ...(signal ? { signal } : {}) });
  return { rows, total, truncated: true };
}

/** Nulls last on every date sort: a row with no date must never head a watchlist. */
const BY_JOIN_DATE: readonly OrderSpec[] = [
  { column: "date_of_join", ascending: true, nullsFirst: false },
  { column: "employee_code", ascending: true },
];
const BY_LAST_WORKING_DAY: readonly OrderSpec[] = [
  { column: "last_working_day", ascending: true, nullsFirst: false },
  { column: "employee_code", ascending: true },
];
const BY_CONFIRMATION_DUE: readonly OrderSpec[] = [
  { column: "confirmation_due_date", ascending: true, nullsFirst: false },
  { column: "employee_code", ascending: true },
];
const BY_CONTRACT_END: readonly OrderSpec[] = [
  { column: "contract_end_date", ascending: true, nullsFirst: false },
  { column: "employee_code", ascending: true },
];

/**
 * Everything the watchlists need, in one shape.
 *
 * `today` is threaded through rather than read here: the predicates that mean
 * "still ahead of now" have to agree with the day counts the pure module derives
 * from the same date, and two `nowIstDate()` calls either side of midnight would
 * produce a row the table then labels "0 days left" while the predicate that
 * fetched it said otherwise.
 */
export interface MovementListsResult {
  readonly period: Period;
  readonly scope: MovementScope;
  /** The IST civil date every "days left / overdue by" figure is relative to. */
  readonly today: string;
  readonly joiners: CappedList<MovementEmployee>;
  readonly exits: CappedList<MovementEmployee>;
  readonly probation: CappedList<MovementEmployee>;
  readonly contracts: CappedList<MovementEmployee>;
  readonly notice: CappedList<MovementEmployee>;
  /** The far end of the contract window — period.to + {@link CONTRACT_LOOKAHEAD_DAYS}. */
  readonly contractWindowTo: string;
  readonly provenance: AnalyticsProvenance;
}

/**
 * The five live reads, in parallel.
 *
 * PREDICATES, each traceable to a named column:
 *   * joiners    — `date_of_join` BETWEEN period.from AND period.to
 *   * exits      — `last_working_day` BETWEEN period.from AND period.to
 *   * probation  — `confirmation_due_date <= period.to` AND `confirmed_on IS NULL`
 *   * contracts  — `contract_end_date` BETWEEN period.from AND period.to + lookahead
 *   * notice     — `resignation_date IS NOT NULL` AND `last_working_day > today`
 *
 * The terminal-status exclusion for the probation and contract lists is applied
 * in the PURE module rather than as a predicate, deliberately: `Filter` has no
 * `not in` operator, and enumerating the nine non-terminal values of
 * `public.employment_status` in a URL would silently drop anybody added to the
 * enum later. Filtering nine statuses in and forgetting to add the tenth is a
 * worse failure than fetching a handful of extra rows and dropping them here,
 * where the rule is one readable line. The counts reported to the screen come
 * from the FILTERED lists for exactly this reason — see
 * `probationWatchlist` / `contractWatchlist`.
 */
export async function fetchMovementLists(
  filters: AnalyticsFilters,
  today: string,
  opts: MovementFetchOptions = {},
): Promise<MovementListsResult> {
  const scope = opts.scope ?? movementScopeFrom(filters);
  const cap = opts.limit ?? MOVEMENT_LIST_CAP;
  const period = filters.period;
  const base = scope.employeeFilters;
  const contractWindowTo = addDays(period.to, CONTRACT_LOOKAHEAD_DAYS);
  const signal = opts.signal;

  const [joiners, exits, probation, contracts, notice] = await Promise.all([
    cappedList(
      [...base, gte("date_of_join", period.from), lte("date_of_join", period.to)],
      BY_JOIN_DATE,
      cap,
      signal,
    ),
    cappedList(
      [...base, gte("last_working_day", period.from), lte("last_working_day", period.to)],
      BY_LAST_WORKING_DAY,
      cap,
      signal,
    ),
    cappedList(
      [...base, lte("confirmation_due_date", period.to), isNull("confirmed_on")],
      BY_CONFIRMATION_DUE,
      cap,
      signal,
    ),
    cappedList(
      [
        ...base,
        gte("contract_end_date", period.from),
        lte("contract_end_date", contractWindowTo),
      ],
      BY_CONTRACT_END,
      cap,
      signal,
    ),
    cappedList(
      [...base, isNotNull("resignation_date"), gt("last_working_day", today)],
      BY_LAST_WORKING_DAY,
      cap,
      signal,
    ),
  ]);

  const lists = [joiners, exits, probation, contracts, notice];
  const rowsScanned = lists.reduce((n, l) => n + l.rows.length, 0);
  const truncated = lists.some((l) => l.truncated);

  return {
    period,
    scope,
    today,
    joiners,
    exits,
    probation,
    contracts,
    notice,
    contractWindowTo,
    provenance: {
      relation: V_ADMIN_EMPLOYEE,
      computedBy: "client",
      rowsScanned,
      rowCap: cap,
      truncated,
      caveats: truncated
        ? [...scope.caveats, "admin.movement.caveat.listTruncated"]
        : scope.caveats,
    },
  };
}

// -----------------------------------------------------------------------------
// 3. Derivations — pure result → panel, so a hook can `select` off ONE fetch
// -----------------------------------------------------------------------------
//
// Same discipline as analytics.api.ts: each `*Of` is synchronous and side-effect
// free, so the five watchlist panels are five projections of ONE cached read
// rather than five fetches of the same rows a few hundred milliseconds apart.

export interface WatchlistResult<T> {
  readonly rows: readonly T[];
  /**
   * Cardinality of the predicate BEFORE the pure module dropped terminal rows.
   * `rows.length` is what the table shows; this is what "of M" means when the
   * server cap bit. They differ only when truncated.
   */
  readonly total: number;
  readonly truncated: boolean;
  readonly provenance: AnalyticsProvenance;
}

export function probationOf(result: MovementListsResult): WatchlistResult<ProbationWatchRow> {
  const rows = probationWatchlist(result.probation.rows, result.period.to, result.today);
  return {
    rows,
    // When nothing was truncated the honest total is what survived the terminal
    // filter, not what the server returned — otherwise the header would promise
    // rows the table deliberately does not show.
    total: result.probation.truncated ? result.probation.total : rows.length,
    truncated: result.probation.truncated,
    provenance: result.provenance,
  };
}

export function contractsOf(result: MovementListsResult): WatchlistResult<ContractWatchRow> {
  const rows = contractWatchlist(
    result.contracts.rows,
    result.period.from,
    result.contractWindowTo,
    result.today,
  );
  return {
    rows,
    total: result.contracts.truncated ? result.contracts.total : rows.length,
    truncated: result.contracts.truncated,
    provenance: result.provenance,
  };
}

export function noticeOf(result: MovementListsResult): WatchlistResult<NoticeWatchRow> {
  const rows = noticeWatchlist(result.notice.rows, result.today);
  return {
    rows,
    total: result.notice.truncated ? result.notice.total : rows.length,
    truncated: result.notice.truncated,
    provenance: result.provenance,
  };
}

export interface ExitQualityResult {
  readonly rows: readonly MovementEmployee[];
  readonly quality: ExitQuality;
  readonly total: number;
  readonly truncated: boolean;
  readonly provenance: AnalyticsProvenance;
}

/**
 * The period's exits plus their quality breakdown.
 *
 * When the read was truncated the breakdown covers only the rows that arrived,
 * and `total` says so — a share of "the first 300 exits" is not a share of the
 * period, and the screen prints the difference rather than implying a rate over
 * the whole.
 */
export function exitQualityResultOf(result: MovementListsResult): ExitQualityResult {
  return {
    rows: result.exits.rows,
    quality: exitQualityOf(result.exits.rows),
    total: result.exits.total,
    truncated: result.exits.truncated,
    provenance: result.provenance,
  };
}

export interface JoinerListResult {
  readonly rows: readonly MovementEmployee[];
  readonly total: number;
  readonly truncated: boolean;
  readonly provenance: AnalyticsProvenance;
}

export function joinersOf(result: MovementListsResult): JoinerListResult {
  return {
    rows: result.joiners.rows,
    total: result.joiners.total,
    truncated: result.joiners.truncated,
    provenance: result.provenance,
  };
}

/** The two live movement counts — the current truth the snapshot is compared to. */
export interface LiveMovementCounts {
  readonly joiners: number;
  readonly exits: number;
}

export function liveCountsOf(result: MovementListsResult): LiveMovementCounts {
  return { joiners: result.joiners.total, exits: result.exits.total };
}
