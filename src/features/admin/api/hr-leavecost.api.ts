/**
 * hr-leavecost.api.ts — the filter-aware reads behind the Leave & Cost panel.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE EVERY NUMBER COMES FROM (the repo rule: a displayed figure is traceable)
 * ═══════════════════════════════════════════════════════════════════════════
 * SERVER-COMPUTED, read as-is and never re-derived:
 *   * `v_leave_balance_current.available_days` / `available_after_pending` — the
 *     GENERATED columns of `leave_balances`, the materialised running sum of the
 *     ledger (migration 035 §1);
 *   * `v_leave_calendar.day_value` — the per-day fraction the leave engine wrote;
 *   * `v_comp_off_balance.expiring_within_30_days` and `nearest_expiry` — the
 *     view's own window (`expires_on <= util.ist_today() + 30`), not ours;
 *   * `v_leave_ledger_statement.days` — signed at insert by the ledger;
 *   * every `*_paise` column of `v_payroll_cost_monthly`, including
 *     `total_cost_paise` (§9.2 gross + employer contributions);
 *   * `v_payroll_variance.variance_paise` / `variance_pct`, computed in SQL
 *     against each employee's own preceding payslip.
 *
 * CLIENT-AGGREGATED, in `../hrLeaveCostAggregate.ts` (pure, unit-tested):
 *   * the per-type / per-department / per-date / per-month rollups of those
 *     columns. PostgREST cannot GROUP BY and no deployed relation publishes leave
 *     liability by type, leave density by date, or cost by (month × department).
 *
 * Every result carries {@link AnalyticsProvenance} — the same type the attendance
 * analytics use, so one caveats renderer serves both — saying which relation was
 * read, that the rollup happened here, how many rows it saw and whether the read
 * was capped.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW A DIMENSION FILTER IS APPLIED — investigated per relation, not assumed
 * ═══════════════════════════════════════════════════════════════════════════
 * Checked against migrations 035 (leave/payroll views) and 036 (matview wrappers):
 *
 *   RELATION                     employee_id   department_id
 *   v_leave_calendar             yes           YES  ← filtered directly, by id
 *   v_payroll_cost_monthly       no  (grain)   YES  ← filtered directly, by id
 *   v_leave_balance_current      yes           no
 *   v_comp_off_balance           yes           no
 *   v_leave_ledger_statement     yes           no
 *   v_payroll_variance           yes           no
 *
 * For the four relations with no department column the department is resolved to
 * an EXPLICIT LIST OF EMPLOYEE IDS through the directory (`v_admin_employee`,
 * filtered on `department_id`, so no name matching and no ambiguity) and applied as
 * `employee_id=in.(…)`.
 *
 * `analytics.api.ts` rejects exactly that technique for the attendance day view,
 * and it is right to — but for two reasons that do not hold here, which is why this
 * module does the opposite rather than copying the conclusion:
 *   * "it mis-scopes a mid-period transfer" — true of a DAY row, which records the
 *     department as at that day. A leave balance and a comp-off credit are current
 *     snapshots, so the employee's current department is precisely the right key.
 *     (It IS a real caveat for the ledger, which is period-based; see
 *     `hr.leavecost.caveat.ledgerDepartmentAsAtToday`.)
 *   * "it blows past URL limits at a few hundred people" — true, and handled rather
 *     than ignored: {@link DEPARTMENT_EMPLOYEE_CAP} bounds the list, the size is
 *     established with a Postgres `count=exact` BEFORE the ids are read, and a
 *     department over the cap yields an EMPTY result plus a loud caveat. Showing
 *     whole-organisation liability under one department's heading is the failure
 *     this cap exists to prevent.
 *
 * NOT APPLICABLE, reported rather than silently ignored:
 *   * `AnalyticsFilters.source` — punch source is a per-scan column on
 *     `attendance_punches`. None of these six relations has it.
 *   * `AnalyticsFilters.employeeId` on `v_payroll_cost_monthly` — the matview's
 *     grain is department × cost centre; there is no employee in it.
 *   * `AnalyticsFilters.period` on `v_comp_off_balance` — the view is a snapshot as
 *     at `util.ist_today()`; "comp-off earned in June" is not a question it answers.
 *   * A sub-month period on `v_payroll_cost_monthly` — payroll cost is booked to the
 *     month a pay period ENDS in, so any overlap pulls the whole month.
 */
import {
  eq,
  gt,
  gte,
  inList,
  lte,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import type { MessageKey } from "@/shared/i18n/en";
import type { AnalyticsFilters } from "@/lib/analyticsFilters";
import type { Period } from "@/lib/period";
import { RELEASED_RUN_STATUSES } from "../display";
import type { AnalyticsProvenance } from "./analytics.api";
import { countEmployeeDirectory, fetchEmployeeOptions } from "./employees.api";
import {
  V_BALANCE_CURRENT,
  V_COMP_OFF_BALANCE,
  V_LEAVE_CALENDAR,
  V_LEDGER_STATEMENT,
  balanceSchema,
  compOffBalanceSchema,
  leaveCalendarRowSchema,
  ledgerRowSchema,
} from "./leave.api";
import { V_PAYROLL_COST_MONTHLY, payrollCostRowSchema } from "./analytics-ops.api";
import { V_PAYROLL_VARIANCE, fetchPayrollRuns, varianceRowSchema } from "./payroll.api";
import {
  EMPTY_COMP_OFF,
  EMPTY_COST,
  EMPTY_LIABILITY,
  EMPTY_MOVEMENT,
  EMPTY_VARIANCE,
  aggregateCompOff,
  aggregateLeaveDensity,
  aggregateLeaveLiability,
  aggregateLeaveMovement,
  aggregatePayrollCost,
  aggregatePayrollVariance,
  aggregateLeaveTaken,
  costMonthsForPeriod,
  type CompOffSummary,
  type CostMonthWindow,
  type LeaveDensity,
  type LeaveLiability,
  type LeaveMovement,
  type LeaveTaken,
  type PayrollCostSummary,
  type PayrollVarianceSummary,
} from "../hrLeaveCostAggregate";

// Re-exported so a screen has ONE import for this data layer and never has to know
// that the arithmetic lives in a sibling module.
export {
  DEFAULT_BUSIEST_DATES,
  DEFAULT_MOVER_COUNT,
  MAX_COST_MONTHS,
  MAX_DENSITY_POINTS,
  VARIANCE_FLAG_PCT,
  aggregateCompOff,
  aggregateLeaveDensity,
  aggregateLeaveLiability,
  aggregateLeaveMovement,
  aggregateLeaveTaken,
  aggregatePayrollCost,
  aggregatePayrollVariance,
  classifyLeaveStatus,
  costMonthKey,
  costMonthsForPeriod,
  overtimeSharePct,
} from "../hrLeaveCostAggregate";
export type {
  CompOffExpiryEntry,
  CompOffSummary,
  CostCell,
  CostDepartment,
  CostMonth,
  CostMonthWindow,
  CostTotals,
  LeaveDaySplit,
  LeaveDensity,
  LeaveDensityPoint,
  LeaveLiability,
  LeaveMovement,
  LeaveTaken,
  LeaveTakenByDepartment,
  LeaveTakenByType,
  LeaveTypeBalance,
  LedgerMovementRow,
  PayrollCostSummary,
  PayrollVarianceSummary,
  VarianceMover,
} from "../hrLeaveCostAggregate";

// -----------------------------------------------------------------------------
// Caps — every read is bounded, and every cap is surfaced in the provenance
// -----------------------------------------------------------------------------

/**
 * One row per employee × leave type for the current leave year. At this venue
 * (~200 heads, ~8 types) that is ~1,600 rows; 5,000 leaves headroom for a site
 * three times the size before the liability figure starts to under-report.
 */
export const LEAVE_BALANCE_ROW_CAP = 5_000;

/** One row per counted leave-request DAY. A busy month is a few hundred. */
export const LEAVE_CALENDAR_ROW_CAP = 5_000;

/** One row per employee holding an open comp-off credit. */
export const COMP_OFF_ROW_CAP = 1_000;

/** Ledger entries in the period — accruals alone are one per employee per month. */
export const LEAVE_LEDGER_ROW_CAP = 5_000;

/** (pay period × department × cost centre) cells across the month window. */
export const PAYROLL_COST_ROW_CAP = 1_000;

/** One net-pay row per employee on the run. Same cap the variance report uses. */
export const PAYROLL_VARIANCE_ROW_CAP = 2_000;

/**
 * The most employees a department filter may name in a URL.
 *
 * `employee_id=in.(…)` costs ~37 bytes per uuid, so 120 ids is a ~4.5 KB query
 * string — comfortably inside the 8 KB request-line limit every proxy in front of
 * PostgREST enforces, with room for the rest of the predicate. Over this, the four
 * relations without a department column return EMPTY plus a caveat, because a
 * silently unfiltered answer under a department heading is the worse failure.
 */
export const DEPARTMENT_EMPLOYEE_CAP = 120;

// -----------------------------------------------------------------------------
// Scope — AnalyticsFilters → the predicates each relation can actually honour
// -----------------------------------------------------------------------------

export interface LeaveCostScope {
  readonly period: Period;
  /** Applied DIRECTLY on the two relations that carry `department_id`. */
  readonly departmentId: string | null;
  readonly employeeId: string | null;
  /**
   * The department's employees, for the relations that carry no department. Null
   * means "no narrowing needed" (no department filter); a list means narrow to it.
   */
  readonly employeeIds: readonly string[] | null;
  /**
   * True when a department filter is set but cannot be turned into an employee
   * list — unknown/empty department, or one larger than
   * {@link DEPARTMENT_EMPLOYEE_CAP}. The four relations without a department column
   * must then return EMPTY, never unfiltered.
   */
  readonly employeeScopeBlocked: boolean;
  readonly caveats: readonly MessageKey[];
}

/** The scope for an unfiltered period — no masters read, nothing narrowed. */
export function unscoped(period: Period): LeaveCostScope {
  return {
    period,
    departmentId: null,
    employeeId: null,
    employeeIds: null,
    employeeScopeBlocked: false,
    caveats: [],
  };
}

/** True when resolving these filters needs a directory read. */
export function leaveCostScopeNeedsDirectory(filters: AnalyticsFilters): boolean {
  return filters.departmentId !== undefined;
}

/**
 * Resolve the URL-backed filters into what each relation can honour.
 *
 * The department's size is established with a Postgres `count=exact` BEFORE any ids
 * are read, so an oversized department costs one HEAD request rather than a
 * truncated id list that would silently narrow the answer to the first 120 people
 * in it — a subset presented as a whole is worse than an empty state.
 */
export async function resolveLeaveCostScope(
  filters: AnalyticsFilters,
  signal?: AbortSignal,
): Promise<LeaveCostScope> {
  const caveats: MessageKey[] = [];
  if (filters.source !== "all") caveats.push("hr.leavecost.caveat.sourceNotApplicable");

  const employeeId = filters.employeeId ?? null;
  const departmentId = filters.departmentId ?? null;

  if (departmentId === null) {
    return {
      period: filters.period,
      departmentId: null,
      employeeId,
      employeeIds: null,
      employeeScopeBlocked: false,
      caveats,
    };
  }

  const total = await countEmployeeDirectory(
    { departmentIds: [departmentId] },
    signal,
  );

  if (total === 0) {
    caveats.push("hr.leavecost.caveat.departmentEmpty");
    return {
      period: filters.period,
      departmentId,
      employeeId,
      employeeIds: [],
      employeeScopeBlocked: true,
      caveats,
    };
  }

  if (total > DEPARTMENT_EMPLOYEE_CAP) {
    caveats.push("hr.leavecost.caveat.departmentTooLarge");
    return {
      period: filters.period,
      departmentId,
      employeeId,
      employeeIds: null,
      employeeScopeBlocked: true,
      caveats,
    };
  }

  const people = await fetchEmployeeOptions(
    { departmentIds: [departmentId] },
    DEPARTMENT_EMPLOYEE_CAP,
    signal,
  );
  return {
    period: filters.period,
    departmentId,
    employeeId,
    // Intersected rather than concatenated: an employee filter INSIDE a department
    // filter must narrow to the one person, and only if they are in it.
    employeeIds:
      employeeId === null
        ? people.map((p) => p.id)
        : people.filter((p) => p.id === employeeId).map((p) => p.id),
    employeeScopeBlocked: false,
    caveats: [...caveats, "hr.leavecost.caveat.ledgerDepartmentAsAtToday"],
  };
}

/**
 * The employee predicate for a relation with no department column.
 *
 * Returns null when the scope is blocked — the caller must then return an empty
 * result rather than run the query without the narrowing.
 */
function employeeFilters(scope: LeaveCostScope): Filter[] | null {
  if (scope.employeeScopeBlocked) return null;
  if (scope.employeeIds !== null) {
    if (scope.employeeIds.length === 0) return null;
    return [inList("employee_id", scope.employeeIds)];
  }
  return scope.employeeId === null ? [] : [eq("employee_id", scope.employeeId)];
}

function provenance(
  relation: string,
  rowsScanned: number,
  rowCap: number,
  scope: LeaveCostScope,
  extra: readonly MessageKey[] = [],
): AnalyticsProvenance {
  const truncated = rowsScanned >= rowCap;
  return {
    relation,
    computedBy: "client",
    rowsScanned,
    rowCap,
    truncated,
    caveats: truncated
      ? [...scope.caveats, ...extra, "hr.leavecost.caveat.truncated"]
      : [...scope.caveats, ...extra],
  };
}

/** The provenance of a read that was never issued because the scope blocked it. */
function blockedProvenance(relation: string, cap: number, scope: LeaveCostScope): AnalyticsProvenance {
  return {
    relation,
    computedBy: "client",
    rowsScanned: 0,
    rowCap: cap,
    truncated: false,
    caveats: scope.caveats,
  };
}

export interface LeaveCostFetchOptions {
  readonly signal?: AbortSignal;
  /** Pre-resolved scope, so a panel with six reads resolves the department once. */
  readonly scope?: LeaveCostScope;
}

async function scopeOf(
  filters: AnalyticsFilters,
  opts: LeaveCostFetchOptions,
): Promise<LeaveCostScope> {
  return opts.scope ?? (await resolveLeaveCostScope(filters, opts.signal));
}

// =============================================================================
// 1. Leave balance by type + the liability, IN DAYS — v_leave_balance_current
// =============================================================================

export interface LeaveLiabilityResult {
  readonly liability: LeaveLiability;
  readonly provenance: AnalyticsProvenance;
}

/**
 * The organisation's accrued leave balance, by type.
 *
 * NOT period-filtered, and the view will not let it be: `v_leave_balance_current`
 * is pinned to `leave_year = public.leave_year_of(util.ist_today())`. A balance is
 * a position as at today, so a period filter on it would be a lie — the panel
 * labels this block "as at today" for exactly that reason.
 */
export async function fetchLeaveLiability(
  filters: AnalyticsFilters,
  opts: LeaveCostFetchOptions = {},
): Promise<LeaveLiabilityResult> {
  const scope = await scopeOf(filters, opts);
  const people = employeeFilters(scope);
  if (people === null) {
    return {
      liability: EMPTY_LIABILITY,
      provenance: blockedProvenance(V_BALANCE_CURRENT, LEAVE_BALANCE_ROW_CAP, scope),
    };
  }

  const rows = await selectMany(V_BALANCE_CURRENT, balanceSchema, {
    filters: people,
    order: [
      { column: "leave_type_code", ascending: true },
      { column: "employee_id", ascending: true },
    ],
    limit: LEAVE_BALANCE_ROW_CAP,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return {
    liability: aggregateLeaveLiability(rows),
    provenance: provenance(V_BALANCE_CURRENT, rows.length, LEAVE_BALANCE_ROW_CAP, scope, [
      // The one measure this panel is asked for and cannot give in money.
      "hr.leavecost.caveat.liabilityInDays",
      "hr.leavecost.caveat.balanceAsAtToday",
    ]),
  };
}

// =============================================================================
// 2 + 3. Leave taken and calendar density — one read of v_leave_calendar
// =============================================================================

/**
 * The calendar page every leave-day rollup is derived from.
 *
 * ONE read, two answers: "who took what" and "how many were off at once" are the
 * same rows grouped two ways, and fetching them twice would let the two blocks
 * disagree by a few hundred milliseconds of somebody approving a request.
 */
export interface LeaveCalendarPage {
  readonly taken: LeaveTaken;
  readonly density: LeaveDensity;
  readonly provenance: AnalyticsProvenance;
}

export async function fetchLeaveCalendarPage(
  filters: AnalyticsFilters,
  opts: LeaveCostFetchOptions = {},
): Promise<LeaveCalendarPage> {
  const scope = await scopeOf(filters, opts);

  const predicate: Filter[] = [
    gte("leave_date", scope.period.from),
    lte("leave_date", scope.period.to),
  ];
  // The one relation in this panel that carries BOTH ids — no employee-list
  // fallback and no name matching, so no ambiguity caveat is possible here.
  if (scope.departmentId !== null) predicate.push(eq("department_id", scope.departmentId));
  if (scope.employeeId !== null) predicate.push(eq("employee_id", scope.employeeId));

  const rows = await selectMany(V_LEAVE_CALENDAR, leaveCalendarRowSchema, {
    filters: predicate,
    order: [
      { column: "leave_date", ascending: true },
      { column: "employee_id", ascending: true },
    ],
    limit: LEAVE_CALENDAR_ROW_CAP,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return {
    taken: aggregateLeaveTaken(rows),
    density: aggregateLeaveDensity(rows, scope.period),
    provenance: provenance(V_LEAVE_CALENDAR, rows.length, LEAVE_CALENDAR_ROW_CAP, scope, [
      "hr.leavecost.caveat.calendarIncludesPending",
    ]),
  };
}

// =============================================================================
// 4. Comp-off earned vs expiring — v_comp_off_balance
// =============================================================================

export interface CompOffResult {
  readonly summary: CompOffSummary;
  readonly provenance: AnalyticsProvenance;
}

/**
 * Open comp-off credits and what is about to lapse.
 *
 * The 30-day window is the VIEW's (`expires_on <= util.ist_today() + 30`), not a
 * constant chosen here, which is why nothing in this module names a number of days.
 */
export async function fetchCompOffExpiry(
  filters: AnalyticsFilters,
  opts: LeaveCostFetchOptions = {},
): Promise<CompOffResult> {
  const scope = await scopeOf(filters, opts);
  const people = employeeFilters(scope);
  if (people === null) {
    return {
      summary: EMPTY_COMP_OFF,
      provenance: blockedProvenance(V_COMP_OFF_BALANCE, COMP_OFF_ROW_CAP, scope),
    };
  }

  const rows = await selectMany(V_COMP_OFF_BALANCE, compOffBalanceSchema, {
    filters: people,
    // Soonest expiry first at the SERVER, so a capped read keeps the rows that
    // matter: the action list is about what is closest to being lost.
    order: [{ column: "nearest_expiry", ascending: true }],
    limit: COMP_OFF_ROW_CAP,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return {
    summary: aggregateCompOff(rows),
    provenance: provenance(V_COMP_OFF_BALANCE, rows.length, COMP_OFF_ROW_CAP, scope, [
      "hr.leavecost.caveat.compOffSnapshot",
    ]),
  };
}

// =============================================================================
// 5. How the balance moved in the period — v_leave_ledger_statement
// =============================================================================

export interface LeaveMovementResult {
  readonly movement: LeaveMovement;
  readonly provenance: AnalyticsProvenance;
}

export async function fetchLeaveMovement(
  filters: AnalyticsFilters,
  opts: LeaveCostFetchOptions = {},
): Promise<LeaveMovementResult> {
  const scope = await scopeOf(filters, opts);
  const people = employeeFilters(scope);
  if (people === null) {
    return {
      movement: EMPTY_MOVEMENT,
      provenance: blockedProvenance(V_LEDGER_STATEMENT, LEAVE_LEDGER_ROW_CAP, scope),
    };
  }

  const rows = await selectMany(V_LEDGER_STATEMENT, ledgerRowSchema, {
    filters: [
      ...people,
      gte("effective_date", scope.period.from),
      lte("effective_date", scope.period.to),
    ],
    order: [
      { column: "effective_date", ascending: true },
      { column: "id", ascending: true },
    ],
    limit: LEAVE_LEDGER_ROW_CAP,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return {
    movement: aggregateLeaveMovement(rows),
    provenance: provenance(V_LEDGER_STATEMENT, rows.length, LEAVE_LEDGER_ROW_CAP, scope),
  };
}

// =============================================================================
// 6. Payroll cost by month × department — v_payroll_cost_monthly
// =============================================================================

export interface PayrollCostResult {
  readonly cost: PayrollCostSummary;
  /** The months actually asked for, and whether the period was wider than the cap. */
  readonly window: CostMonthWindow;
  readonly provenance: AnalyticsProvenance;
}

/** Distinct calendar years in a 'YYYY-MM' list, ascending. */
function yearsOf(months: readonly string[]): number[] {
  const years = new Set<number>();
  for (const m of months) years.add(Number(m.slice(0, 4)));
  return [...years].sort((a, b) => a - b);
}

/**
 * Payroll cost for the months the period touches.
 *
 * ONE READ PER CALENDAR YEAR, not one big predicate. `(year, month)` is a compound
 * key and the closed filter vocabulary has no tuple `IN`; asking for
 * `year in (2025,2026) AND month in (11,12,1)` would also return November 2026 and
 * January 2025, which nobody selected. A read per year with that year's own month
 * list is EXACT, and a period spans one or two years in every realistic case (the
 * month window is capped at {@link MAX_COST_MONTHS} regardless).
 */
export async function fetchPayrollCost(
  filters: AnalyticsFilters,
  opts: LeaveCostFetchOptions = {},
): Promise<PayrollCostResult> {
  const scope = await scopeOf(filters, opts);
  const window = costMonthsForPeriod(scope.period);
  const extra: MessageKey[] = ["hr.leavecost.caveat.costIsMonthly"];
  if (window.truncated) extra.push("hr.leavecost.caveat.costMonthsCapped");
  // The employee filter cannot reach a department × cost-centre grain; say so
  // rather than showing whole-department cost under one person's name.
  if (scope.employeeId !== null) extra.push("hr.leavecost.caveat.costEmployeeNotApplicable");

  if (window.months.length === 0) {
    return {
      cost: EMPTY_COST,
      window,
      provenance: provenance(V_PAYROLL_COST_MONTHLY, 0, PAYROLL_COST_ROW_CAP, scope, extra),
    };
  }

  const years = yearsOf(window.months);
  const perYear = await Promise.all(
    years.map((year) => {
      const monthNumbers = window.months
        .filter((m) => Number(m.slice(0, 4)) === year)
        .map((m) => Number(m.slice(5, 7)));
      const predicate: Filter[] = [eq("year", year), inList("month", monthNumbers)];
      if (scope.departmentId !== null) predicate.push(eq("department_id", scope.departmentId));
      return selectMany(V_PAYROLL_COST_MONTHLY, payrollCostRowSchema, {
        filters: predicate,
        order: [
          { column: "month", ascending: true },
          { column: "total_cost_paise", ascending: false },
        ],
        // Each year's read gets the whole cap: one truncated year is still a
        // truncated answer, and the flag below is what the screen acts on.
        limit: PAYROLL_COST_ROW_CAP,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    }),
  );

  const rows = perYear.flat();
  const capHit = perYear.some((year) => year.length >= PAYROLL_COST_ROW_CAP);

  return {
    cost: aggregatePayrollCost(rows),
    window,
    provenance: {
      relation: V_PAYROLL_COST_MONTHLY,
      computedBy: "client",
      rowsScanned: rows.length,
      rowCap: PAYROLL_COST_ROW_CAP,
      truncated: capHit,
      caveats: capHit
        ? [...scope.caveats, ...extra, "hr.leavecost.caveat.truncated"]
        : [...scope.caveats, ...extra],
    },
  };
}

// =============================================================================
// 7. Variance vs the previous run — v_payroll_variance
// =============================================================================

export interface PayrollVarianceResult {
  readonly variance: PayrollVarianceSummary;
  /** The run these figures describe. Null when no released run covers the period. */
  readonly runNumber: string | null;
  readonly runId: string | null;
  readonly provenance: AnalyticsProvenance;
}

/**
 * Net-pay movement on the newest RELEASED run covering the selected months.
 *
 * The pay periods come from the cost read, not from a second master query: the cost
 * rows already name every period the window touches, so the two blocks are looking
 * at the same run by construction. RELEASED_RUN_STATUSES is the same status set
 * `mv_payroll_cost_monthly` filters on — a draft run's variance is not a fact yet.
 *
 * `variance_grain = 'net_pay'` is applied SERVER-side: the per-component rows share
 * the relation and would count every employee once per payslip line.
 */
export async function fetchPayrollVariance(
  payPeriodIds: readonly string[],
  filters: AnalyticsFilters,
  opts: LeaveCostFetchOptions = {},
): Promise<PayrollVarianceResult> {
  const scope = await scopeOf(filters, opts);
  const empty = (extra: readonly MessageKey[]): PayrollVarianceResult => ({
    variance: EMPTY_VARIANCE,
    runNumber: null,
    runId: null,
    provenance: provenance(V_PAYROLL_VARIANCE, 0, PAYROLL_VARIANCE_ROW_CAP, scope, extra),
  });

  if (payPeriodIds.length === 0) return empty(["hr.leavecost.caveat.noReleasedRun"]);

  const people = employeeFilters(scope);
  if (people === null) {
    return {
      variance: EMPTY_VARIANCE,
      runNumber: null,
      runId: null,
      provenance: blockedProvenance(V_PAYROLL_VARIANCE, PAYROLL_VARIANCE_ROW_CAP, scope),
    };
  }

  // Ordered created_at DESC by `fetchPayrollRuns`, so one row is the newest run
  // among these periods — including a rerun, which is the one an admin cares about.
  const runs = await fetchPayrollRuns(
    { statuses: RELEASED_RUN_STATUSES, payPeriodIds },
    1,
    null,
    opts.signal,
  );
  const run = runs.rows[0];
  if (run === undefined) return empty(["hr.leavecost.caveat.noReleasedRun"]);

  const rows = await selectMany(V_PAYROLL_VARIANCE, varianceRowSchema, {
    filters: [...people, eq("payroll_run_id", run.id), eq("variance_grain", "net_pay")],
    order: [{ column: "employee_code", ascending: true }],
    limit: PAYROLL_VARIANCE_ROW_CAP,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return {
    variance: aggregatePayrollVariance(rows),
    runNumber: run.run_number,
    runId: run.id,
    provenance: provenance(V_PAYROLL_VARIANCE, rows.length, PAYROLL_VARIANCE_ROW_CAP, scope, [
      "hr.leavecost.caveat.varianceOneRun",
    ]),
  };
}

// -----------------------------------------------------------------------------
// Count, for the tiles that must not be a `rows.length`
// -----------------------------------------------------------------------------

/**
 * How many employees are losing comp-off inside the view's window, counted by
 * POSTGRES over the same predicate the Command Centre tile uses.
 *
 * Exists because the action list above is capped: `summary.employeesExpiring` is a
 * count of the rows that arrived, and on a truncated read that is smaller than the
 * truth. The tile shows this figure; the list shows what it could fetch.
 */
export function countCompOffExpiring(
  scope: LeaveCostScope,
  signal?: AbortSignal,
): Promise<number> {
  const people = employeeFilters(scope);
  if (people === null) return Promise.resolve(0);
  // `> 0`, the SAME predicate as `COMP_OFF_EXPIRING_FILTERS` on the Command Centre
  // tile, so the two screens cannot report different numbers of people at risk.
  return selectCount(V_COMP_OFF_BALANCE, [...people, gt("expiring_within_30_days", 0)], {
    ...(signal ? { signal } : {}),
  });
}
