/**
 * hrLeaveCostAggregate.ts — the arithmetic behind the Leave & Cost panel, in a
 * module that touches no network client and reads no clock. (`@/lib/period` and
 * the two month helpers it borrows from `@/lib/datetime` are pure calendar
 * arithmetic on explicit strings; nothing here asks what time it is.)
 *
 * WHY A SECOND AGGREGATE MODULE AND NOT MORE OF analyticsAggregate.ts
 * -------------------------------------------------------------------
 * `analyticsAggregate.ts` is one grain — `v_attendance_day_enriched`, one row per
 * employee per IST day — and every function in it takes that row. This panel reads
 * SIX relations at five different grains (a balance snapshot, a ledger entry, a
 * leave-request day, a comp-off credit summary, a payroll cost cell, a payslip
 * variance row). Folding them into that file would mean one module whose functions
 * silently disagree about what a "row" is. They share its discipline instead:
 *
 *   * PURE. Rows in, measures out. The whole of the maths is exercised by
 *     `hrLeaveCostAggregate.test.ts` with literals — no database, no network.
 *   * DENOMINATORS SHIP WITH AVERAGES. Every mean below names the set it is a mean
 *     over, in the returned object, so the screen can print it.
 *   * MONEY IS INTEGER PAISE AND STAYS INTEGER. Every money figure here is a sum of
 *     `*_paise` integers — `+` only, never `/`, never `*`, never a float. The one
 *     division in the file (`overtimeSharePct`) divides two paise SUMS to produce a
 *     percentage, which is a ratio and not money.
 *
 * THREE THINGS THIS FILE REFUSES TO COMPUTE, and says so in its types
 * -------------------------------------------------------------------
 *  1. LEAVE LIABILITY IN MONEY. Converting an accrued day to rupees needs a daily
 *     rate per employee. No relation this panel reads carries one:
 *     `v_leave_balance_current` is days only, and the salary relations
 *     (`v_employee_current_salary`, `v_payslip_detail`) are a different grain with
 *     several defensible bases (gross ÷ 26, gross ÷ period_days, basic only…).
 *     Picking one would be inventing a number, so {@link LeaveLiability.liabilityPaise}
 *     is typed `null` — the refusal is a compile-time constant, not a runtime hope.
 *  2. COST PER EMPLOYEE ACROSS COST CENTRES. `mv_payroll_cost_monthly` groups by
 *     (period × department × cost centre) and its `employee_count` is a
 *     COUNT(DISTINCT employee) AT THAT GRAIN. One person split across two cost
 *     centres is counted twice, so summing the column and dividing would understate
 *     cost per head. `cost_per_employee_paise` survives only at the view's own grain;
 *     the collapsed cells type it `null`.
 *  3. AN AVERAGE OF `overtime_share_pct`. A ratio cannot be summed or averaged across
 *     rows of different sizes. The panel's share is recomputed from
 *     `SUM(overtime_cost_paise) / SUM(total_cost_paise)`, both named columns.
 *
 * WHAT IS SUMMED IN THE BROWSER, AND WHY THAT IS ALLOWED HERE
 * -----------------------------------------------------------
 * `AnalyticsPayroll.page.tsx` refuses to add matview rows up for an ORG total, and
 * is right to: `payroll_runs` already carries the engine's own period totals, so a
 * second, client-made org number could disagree with the engine's. This panel is a
 * different question — cost per (month × department) — and NO relation publishes it:
 * the matview's grain is one level finer (cost centre) and `payroll_runs` is one
 * level coarser (whole run). Collapsing the cost-centre level is exact integer
 * addition of a named column, it is labelled `computedBy: "client"` in the
 * provenance, and the panel points at the engine's own total for the org figure.
 */
import { addIstMonths } from "@/lib/datetime";
import { addDays, daysBetween, type Period } from "@/lib/period";

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

/** Ordinal sort with nulls last. Not locale-aware: a chart must order the same in
 *  every browser, and `localeCompare` does not. Copied in spirit from
 *  analyticsAggregate.ts's `compareNullableName` — same reason, different module. */
function compareNullableName(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** Only finite numbers are added. A NULL numeric is an absence, not a zero. */
function addFinite(total: number, value: number | null | undefined): number {
  return value === null || value === undefined || !Number.isFinite(value) ? total : total + value;
}

/**
 * Days are `numeric(6,2)` in Postgres and arrive as halves and quarters. Summing
 * them in binary floating point drifts (0.1 + 0.2), and a leave balance that reads
 * `12.499999999999998` destroys trust faster than a wrong number does. Every day
 * total is therefore rounded to two decimals — the column's own scale — at the
 * moment it leaves an accumulator, never mid-loop.
 */
export function roundDays(value: number): number {
  return Math.round(value * 100) / 100;
}

// =============================================================================
// 1. Leave balance by type, and the liability the company owes — IN DAYS
//    Source: v_leave_balance_current (one row per employee × type, current year)
// =============================================================================

/**
 * The projection of `v_leave_balance_current` this module needs, in the view's own
 * snake_case so a reader can check a measure against migration 035 without
 * translating names. Structural: the api module's zod-parsed row satisfies it.
 */
export interface LeaveBalanceRow {
  readonly employee_id: string;
  readonly leave_type_id: string;
  readonly leave_type_code: string;
  readonly leave_type_name: string;
  readonly is_paid: boolean;
  readonly is_comp_off: boolean;
  readonly entitlement_days: number;
  readonly availed_days: number;
  readonly pending_days: number;
  readonly encashed_days: number;
  readonly lapsed_days: number;
  /** THE balance — a generated column on `leave_balances`, never recomputed here. */
  readonly available_days: number;
  /** Balance less what is already applied for: the spendable figure. */
  readonly available_after_pending: number;
}

export interface LeaveTypeBalance {
  readonly leaveTypeId: string;
  readonly leaveTypeCode: string;
  readonly leaveTypeName: string;
  readonly isPaid: boolean;
  readonly isCompOff: boolean;
  /** Distinct employees holding a balance row of this type — this row's denominator. */
  readonly employees: number;
  readonly entitlementDays: number;
  readonly availedDays: number;
  readonly pendingDays: number;
  readonly encashedDays: number;
  readonly lapsedDays: number;
  /** The liability carried by this type, in days. */
  readonly availableDays: number;
  readonly availableAfterPendingDays: number;
  /** Mean balance per employee holding this type. Null when nobody holds it. */
  readonly avgAvailableDaysPerEmployee: number | null;
}

export interface LeaveLiability {
  readonly rows: readonly LeaveTypeBalance[];
  /** Distinct employees across every type — NOT the sum of the per-type counts. */
  readonly employees: number;
  readonly totalAvailableDays: number;
  /**
   * The money-bearing part: types where `leave_types.is_paid` is true. An unpaid
   * type's balance costs the company nothing to honour, so folding the two together
   * would overstate the obligation.
   */
  readonly paidAvailableDays: number;
  readonly unpaidAvailableDays: number;
  /** Comp-off inside the balance view (`is_comp_off`), broken out because its
   *  expiry behaviour — and therefore its urgency — is different. */
  readonly compOffAvailableDays: number;
  /**
   * ALWAYS null, by construction. See this module's header: no relation the panel
   * reads carries a per-employee daily rate, so the liability is reported in DAYS.
   * Typed `null` rather than `number | null` so a future caller cannot start
   * assigning a rate here without changing the type and reading the reason.
   */
  readonly liabilityPaise: null;
}

export const EMPTY_LIABILITY: LeaveLiability = {
  rows: [],
  employees: 0,
  totalAvailableDays: 0,
  paidAvailableDays: 0,
  unpaidAvailableDays: 0,
  compOffAvailableDays: 0,
  liabilityPaise: null,
};

interface BalanceAcc {
  code: string;
  name: string;
  isPaid: boolean;
  isCompOff: boolean;
  employees: Set<string>;
  entitlement: number;
  availed: number;
  pending: number;
  encashed: number;
  lapsed: number;
  available: number;
  afterPending: number;
}

/**
 * Balance per leave type plus the organisation's accrued leave liability.
 *
 * Grouped on `leave_type_id`, not on the name: two types can be renamed into the
 * same label and a liability that silently merged them would be unauditable.
 */
export function aggregateLeaveLiability(
  rows: readonly LeaveBalanceRow[],
): LeaveLiability {
  if (rows.length === 0) return EMPTY_LIABILITY;

  const byType = new Map<string, BalanceAcc>();
  const allEmployees = new Set<string>();

  for (const row of rows) {
    allEmployees.add(row.employee_id);
    let acc = byType.get(row.leave_type_id);
    if (acc === undefined) {
      acc = {
        code: row.leave_type_code,
        name: row.leave_type_name,
        isPaid: row.is_paid,
        isCompOff: row.is_comp_off,
        employees: new Set<string>(),
        entitlement: 0,
        availed: 0,
        pending: 0,
        encashed: 0,
        lapsed: 0,
        available: 0,
        afterPending: 0,
      };
      byType.set(row.leave_type_id, acc);
    }
    acc.employees.add(row.employee_id);
    acc.entitlement = addFinite(acc.entitlement, row.entitlement_days);
    acc.availed = addFinite(acc.availed, row.availed_days);
    acc.pending = addFinite(acc.pending, row.pending_days);
    acc.encashed = addFinite(acc.encashed, row.encashed_days);
    acc.lapsed = addFinite(acc.lapsed, row.lapsed_days);
    acc.available = addFinite(acc.available, row.available_days);
    acc.afterPending = addFinite(acc.afterPending, row.available_after_pending);
  }

  const out: LeaveTypeBalance[] = [];
  let total = 0;
  let paid = 0;
  let unpaid = 0;
  let compOff = 0;

  for (const [leaveTypeId, acc] of byType) {
    const employees = acc.employees.size;
    total += acc.available;
    if (acc.isPaid) paid += acc.available;
    else unpaid += acc.available;
    if (acc.isCompOff) compOff += acc.available;
    out.push({
      leaveTypeId,
      leaveTypeCode: acc.code,
      leaveTypeName: acc.name,
      isPaid: acc.isPaid,
      isCompOff: acc.isCompOff,
      employees,
      entitlementDays: roundDays(acc.entitlement),
      availedDays: roundDays(acc.availed),
      pendingDays: roundDays(acc.pending),
      encashedDays: roundDays(acc.encashed),
      lapsedDays: roundDays(acc.lapsed),
      availableDays: roundDays(acc.available),
      availableAfterPendingDays: roundDays(acc.afterPending),
      // Null, not 0, when nobody holds the type: "no holders" and "everybody holds
      // zero days" are different facts and only one of them is an average.
      avgAvailableDaysPerEmployee:
        employees === 0 ? null : roundDays(acc.available / employees),
    });
  }

  // Biggest liability first — the order the question "what do we owe" is asked in.
  out.sort((a, b) =>
    b.availableDays !== a.availableDays
      ? b.availableDays - a.availableDays
      : compareNullableName(a.leaveTypeCode, b.leaveTypeCode),
  );

  return {
    rows: out,
    employees: allEmployees.size,
    totalAvailableDays: roundDays(total),
    paidAvailableDays: roundDays(paid),
    unpaidAvailableDays: roundDays(unpaid),
    compOffAvailableDays: roundDays(compOff),
    liabilityPaise: null,
  };
}

// =============================================================================
// 2. Leave TAKEN in the period, by type and by department
//    Source: v_leave_calendar (one row per counted leave-request DAY)
// =============================================================================

/**
 * `public.leave_request_status` (migration 003), all eight values.
 *
 * `v_leave_calendar` emits only four of them (`pending`, `approved`,
 * `partially_approved`, `cancellation_pending` — its own WHERE clause), but the
 * type is declared whole so the api module's enum-parsed row is assignable and so
 * {@link classifyLeaveStatus} has to be updated if the deployed enum ever grows.
 */
export type LeaveDayStatus =
  | "draft"
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "withdrawn"
  | "cancellation_pending"
  | "partially_approved";

/**
 * What a leave day counts as on a roster board.
 *
 * `cancellation_pending` is its OWN class and is never folded into confirmed: the
 * day is approved and the person is expected to be away, but somebody has asked to
 * take it back. A roster planner needs to see that separately, and a leave-taken
 * total that hid it would move the moment the cancellation is decided.
 */
export type LeaveDayClass = "confirmed" | "pending" | "cancelling" | "not_counted";

/** Exhaustive by construction — no `default`, so a new enum value fails to compile. */
export function classifyLeaveStatus(status: LeaveDayStatus): LeaveDayClass {
  switch (status) {
    case "approved":
    case "partially_approved":
      return "confirmed";
    case "pending":
      return "pending";
    case "cancellation_pending":
      return "cancelling";
    // Never present in v_leave_calendar; counted nowhere if the view ever widens.
    case "draft":
    case "rejected":
    case "cancelled":
    case "withdrawn":
      return "not_counted";
  }
}

export interface LeaveCalendarDayRow {
  readonly employee_id: string;
  readonly display_name: string | null;
  readonly department_id: string | null;
  readonly department_name: string | null;
  readonly leave_date: string;
  /** 1 for a full day, 0.5 for a half — the view's own `day_value`. */
  readonly day_value: number;
  readonly leave_type_code: string;
  readonly leave_type_name: string;
  readonly status: LeaveDayStatus;
}

/** The four day totals every leave grouping carries, so a caller can always see
 *  how much of a figure is not yet decided. */
export interface LeaveDaySplit {
  /** Every counted day row, whatever its status. */
  readonly days: number;
  readonly confirmedDays: number;
  readonly pendingDays: number;
  readonly cancellingDays: number;
  /** Row count — "three occasions totalling 2.5 days" answers a different question. */
  readonly dayRows: number;
  readonly employees: number;
}

export interface LeaveTakenByType extends LeaveDaySplit {
  readonly leaveTypeCode: string;
  readonly leaveTypeName: string;
}

export interface LeaveTakenByDepartment extends LeaveDaySplit {
  readonly departmentId: string | null;
  /** Null is a real bucket — an employee can exist before they are placed. */
  readonly departmentName: string | null;
}

export interface LeaveTaken {
  readonly total: LeaveDaySplit;
  readonly byType: readonly LeaveTakenByType[];
  readonly byDepartment: readonly LeaveTakenByDepartment[];
}

export const EMPTY_DAY_SPLIT: LeaveDaySplit = {
  days: 0,
  confirmedDays: 0,
  pendingDays: 0,
  cancellingDays: 0,
  dayRows: 0,
  employees: 0,
};

export const EMPTY_LEAVE_TAKEN: LeaveTaken = {
  total: EMPTY_DAY_SPLIT,
  byType: [],
  byDepartment: [],
};

interface SplitAcc {
  days: number;
  confirmed: number;
  pending: number;
  cancelling: number;
  rows: number;
  employees: Set<string>;
}

function newSplit(): SplitAcc {
  return { days: 0, confirmed: 0, pending: 0, cancelling: 0, rows: 0, employees: new Set<string>() };
}

function addToSplit(acc: SplitAcc, row: LeaveCalendarDayRow): void {
  acc.rows += 1;
  acc.employees.add(row.employee_id);
  const value = Number.isFinite(row.day_value) ? row.day_value : 0;
  acc.days += value;
  switch (classifyLeaveStatus(row.status)) {
    case "confirmed":
      acc.confirmed += value;
      break;
    case "pending":
      acc.pending += value;
      break;
    case "cancelling":
      acc.cancelling += value;
      break;
    case "not_counted":
      break;
  }
}

function finaliseSplit(acc: SplitAcc): LeaveDaySplit {
  return {
    days: roundDays(acc.days),
    confirmedDays: roundDays(acc.confirmed),
    pendingDays: roundDays(acc.pending),
    cancellingDays: roundDays(acc.cancelling),
    dayRows: acc.rows,
    employees: acc.employees.size,
  };
}

/**
 * Leave taken in the period, split by type and by department.
 *
 * `days` sums `day_value`, never rows: a half day is 0.5, and counting it as one
 * would make this panel disagree with the leave ledger it is standing next to.
 */
export function aggregateLeaveTaken(rows: readonly LeaveCalendarDayRow[]): LeaveTaken {
  if (rows.length === 0) return EMPTY_LEAVE_TAKEN;

  const total = newSplit();
  const byType = new Map<string, { name: string; acc: SplitAcc }>();
  const byDept = new Map<string, { id: string | null; name: string | null; acc: SplitAcc }>();

  for (const row of rows) {
    addToSplit(total, row);

    let type = byType.get(row.leave_type_code);
    if (type === undefined) {
      type = { name: row.leave_type_name, acc: newSplit() };
      byType.set(row.leave_type_code, type);
    }
    addToSplit(type.acc, row);

    // Keyed on the id, with the unassigned bucket given an explicit sentinel key so
    // "no department" is one bucket rather than one per row. NUL cannot appear in a
    // uuid, so the sentinel cannot collide with a real key. Written as the ESCAPE and
    // never as a literal NUL byte: a raw NUL makes the whole file binary to file(1)
    // and to plain grep, and a silent no-match is how a defined symbol comes to look
    // undefined during a review.
    const deptKey = row.department_id ?? "\u0000unassigned";
    let dept = byDept.get(deptKey);
    if (dept === undefined) {
      dept = { id: row.department_id, name: row.department_name, acc: newSplit() };
      byDept.set(deptKey, dept);
    }
    addToSplit(dept.acc, row);
  }

  const typeRows: LeaveTakenByType[] = [];
  for (const [leaveTypeCode, { name, acc }] of byType) {
    typeRows.push({ leaveTypeCode, leaveTypeName: name, ...finaliseSplit(acc) });
  }
  typeRows.sort((a, b) =>
    b.days !== a.days ? b.days - a.days : compareNullableName(a.leaveTypeCode, b.leaveTypeCode),
  );

  const deptRows: LeaveTakenByDepartment[] = [];
  for (const { id, name, acc } of byDept.values()) {
    deptRows.push({ departmentId: id, departmentName: name, ...finaliseSplit(acc) });
  }
  deptRows.sort((a, b) =>
    b.days !== a.days ? b.days - a.days : compareNullableName(a.departmentName, b.departmentName),
  );

  return { total: finaliseSplit(total), byType: typeRows, byDepartment: deptRows };
}

// =============================================================================
// 3. Leave calendar density — how many people are off on the same day
//    Source: v_leave_calendar again, at the DATE grain. Roster risk.
// =============================================================================

export interface LeaveDensityPoint {
  readonly istDate: string;
  /** Distinct employees away — the roster number. Two half-days by one person is 1. */
  readonly headcount: number;
  /** Sum of `day_value` — the cover number. Two half-days by one person is 1.0. */
  readonly days: number;
  readonly confirmedHeadcount: number;
  readonly pendingHeadcount: number;
}

export interface LeaveDensity {
  /** One point per IST date in the period, in date order, gaps included as zeroes. */
  readonly points: readonly LeaveDensityPoint[];
  /** THE denominator of {@link meanHeadcount}, stated so the screen can print it. */
  readonly daysInPeriod: number;
  readonly peakHeadcount: number;
  /** Every date that hit the peak — a single "worst day" hides a repeating pattern. */
  readonly peakDates: readonly string[];
  /**
   * Mean people away per calendar day, over EVERY date in the period.
   *
   * Zero-filled deliberately, and this is the one place in the repo where that is
   * the honest choice: `v_leave_calendar` has a row only when somebody is on leave,
   * so a date with no rows means nobody was away — a real zero, not a missing
   * measurement. (It stops being true if the read truncated, which is why the api
   * layer ships `provenance.truncated` and the panel refuses to draw this on a
   * capped read.) Null only when the period itself is empty.
   */
  readonly meanHeadcount: number | null;
  /** Dates with anybody away, worst first — the roster-risk list, capped. */
  readonly busiestDates: readonly LeaveDensityPoint[];
}

export const EMPTY_DENSITY: LeaveDensity = {
  points: [],
  daysInPeriod: 0,
  peakHeadcount: 0,
  peakDates: [],
  meanHeadcount: null,
  busiestDates: [],
};

/** Same guard as `MAX_TREND_POINTS` in analyticsAggregate: a hand-edited URL must
 *  not ask for a ten-year daily series and freeze the tab on 3,650 SVG nodes. */
export const MAX_DENSITY_POINTS = 1500;

/** How many roster-risk dates the action list shows by default. */
export const DEFAULT_BUSIEST_DATES = 10;

interface DensityAcc {
  employees: Set<string>;
  confirmed: Set<string>;
  pending: Set<string>;
  days: number;
}

/**
 * Leave density per IST date across the period.
 *
 * Dates carrying rows but lying OUTSIDE the period are appended rather than
 * dropped — they should be impossible (the fetch filters on the same window) and
 * silently hiding one would make this chart disagree with the totals beside it.
 */
export function aggregateLeaveDensity(
  rows: readonly LeaveCalendarDayRow[],
  period: Period,
  busiestCount: number = DEFAULT_BUSIEST_DATES,
): LeaveDensity {
  const byDate = new Map<string, DensityAcc>();
  for (const row of rows) {
    let acc = byDate.get(row.leave_date);
    if (acc === undefined) {
      acc = {
        employees: new Set<string>(),
        confirmed: new Set<string>(),
        pending: new Set<string>(),
        days: 0,
      };
      byDate.set(row.leave_date, acc);
    }
    acc.employees.add(row.employee_id);
    acc.days = addFinite(acc.days, row.day_value);
    const cls = classifyLeaveStatus(row.status);
    // `cancellation_pending` counts toward the roster headcount (the person is
    // still booked off) but is not "confirmed" — it sits in neither sub-count, and
    // that is why the two sub-counts are not required to add up to `headcount`.
    if (cls === "confirmed") acc.confirmed.add(row.employee_id);
    if (cls === "pending") acc.pending.add(row.employee_id);
  }

  const dates: string[] = [];
  const seen = new Set<string>();
  const span = daysBetween(period.from, period.to);
  if (span >= 0) {
    const points = Math.min(span + 1, MAX_DENSITY_POINTS);
    for (let i = 0; i < points; i += 1) {
      const date = addDays(period.from, i);
      dates.push(date);
      seen.add(date);
    }
  }
  const strays: string[] = [];
  for (const date of byDate.keys()) if (!seen.has(date)) strays.push(date);
  strays.sort();
  dates.push(...strays);
  if (dates.length > MAX_DENSITY_POINTS) dates.length = MAX_DENSITY_POINTS;

  if (dates.length === 0) return EMPTY_DENSITY;

  const points: LeaveDensityPoint[] = dates.map((istDate) => {
    const acc = byDate.get(istDate);
    return acc === undefined
      ? { istDate, headcount: 0, days: 0, confirmedHeadcount: 0, pendingHeadcount: 0 }
      : {
          istDate,
          headcount: acc.employees.size,
          days: roundDays(acc.days),
          confirmedHeadcount: acc.confirmed.size,
          pendingHeadcount: acc.pending.size,
        };
  });

  let peak = 0;
  let headSum = 0;
  for (const p of points) {
    headSum += p.headcount;
    if (p.headcount > peak) peak = p.headcount;
  }
  const peakDates = peak === 0 ? [] : points.filter((p) => p.headcount === peak).map((p) => p.istDate);

  const busiest = points
    .filter((p) => p.headcount > 0)
    .sort((a, b) =>
      b.headcount !== a.headcount ? b.headcount - a.headcount : compareNullableName(a.istDate, b.istDate),
    )
    .slice(0, Math.max(0, busiestCount));

  return {
    points,
    daysInPeriod: points.length,
    peakHeadcount: peak,
    peakDates,
    // Rounded to one decimal at the boundary: "2.3 people away per day" is a
    // meaningful statement, "2.2999999999999998" is not.
    meanHeadcount: Math.round((headSum / points.length) * 10) / 10,
    busiestDates: busiest,
  };
}

// =============================================================================
// 4. Comp-off earned vs EXPIRING — an action list, not a statistic
//    Source: v_comp_off_balance (one row per employee with open credits)
// =============================================================================

export interface CompOffBalanceRow {
  readonly employee_id: string;
  /** Open earned credits, expiry-filtered by the view itself. */
  readonly available_days: number;
  readonly nearest_expiry: string | null;
  /** The view's OWN 30-day window (`expires_on <= ist_today() + 30`). Not ours. */
  readonly expiring_within_30_days: number;
  readonly open_credits: number;
}

export interface CompOffExpiryEntry {
  readonly employeeId: string;
  readonly availableDays: number;
  readonly expiringDays: number;
  readonly nearestExpiry: string | null;
  readonly openCredits: number;
}

export interface CompOffSummary {
  /** Employees holding at least one open credit — the view's whole population. */
  readonly employees: number;
  readonly availableDays: number;
  readonly openCredits: number;
  /** Days lapsing inside the view's window. The number that needs acting on. */
  readonly expiringDays: number;
  readonly employeesExpiring: number;
  /** The action list: whoever is losing days, soonest expiry first. */
  readonly expiring: readonly CompOffExpiryEntry[];
  /** The earliest expiry anywhere in the population, or null when nothing expires. */
  readonly nearestExpiry: string | null;
}

export const EMPTY_COMP_OFF: CompOffSummary = {
  employees: 0,
  availableDays: 0,
  openCredits: 0,
  expiringDays: 0,
  employeesExpiring: 0,
  expiring: [],
  nearestExpiry: null,
};

/**
 * Comp-off: what is banked, and what is about to be lost.
 *
 * NOT PERIOD-FILTERED, and it cannot be: `v_comp_off_balance` is a snapshot as at
 * `util.ist_today()` — it filters credits to `status IN ('available','partially_used')`
 * and `expires_on >= today`. "Comp-off earned in June" is not a question this
 * relation can answer, and the panel says so rather than implying the period applies.
 */
export function aggregateCompOff(rows: readonly CompOffBalanceRow[]): CompOffSummary {
  if (rows.length === 0) return EMPTY_COMP_OFF;

  let available = 0;
  let expiring = 0;
  let credits = 0;
  let employeesExpiring = 0;
  let nearest: string | null = null;
  const list: CompOffExpiryEntry[] = [];

  for (const row of rows) {
    available = addFinite(available, row.available_days);
    expiring = addFinite(expiring, row.expiring_within_30_days);
    credits = addFinite(credits, row.open_credits);
    if (row.nearest_expiry !== null && (nearest === null || row.nearest_expiry < nearest)) {
      nearest = row.nearest_expiry;
    }
    if (Number.isFinite(row.expiring_within_30_days) && row.expiring_within_30_days > 0) {
      employeesExpiring += 1;
      list.push({
        employeeId: row.employee_id,
        availableDays: roundDays(row.available_days),
        expiringDays: roundDays(row.expiring_within_30_days),
        nearestExpiry: row.nearest_expiry,
        openCredits: row.open_credits,
      });
    }
  }

  // Soonest expiry first, then most days at risk — the order somebody works the
  // list in. A null expiry sorts last: it is not urgent, it is unbounded.
  list.sort((a, b) => {
    const byDate = compareNullableName(a.nearestExpiry, b.nearestExpiry);
    return byDate !== 0 ? byDate : b.expiringDays - a.expiringDays;
  });

  return {
    employees: rows.length,
    availableDays: roundDays(available),
    openCredits: credits,
    expiringDays: roundDays(expiring),
    employeesExpiring,
    expiring: list,
    nearestExpiry: nearest,
  };
}

// =============================================================================
// 5. How the balance MOVED in the period — the ledger, by entry type
//    Source: v_leave_ledger_statement (one row per signed ledger entry)
// =============================================================================

/** `public.ledger_entry_type` (migration 003), all sixteen values. */
export type LedgerEntryType =
  | "opening_balance"
  | "accrual"
  | "pro_rata_accrual"
  | "credit_adjustment"
  | "carry_forward_in"
  | "carry_forward_out"
  | "encashment"
  | "lapse"
  | "availed"
  | "availed_reversal"
  | "debit_adjustment"
  | "late_deduction"
  | "comp_off_credit"
  | "comp_off_debit"
  | "comp_off_expiry"
  | "settlement";

export interface LeaveLedgerEntryRow {
  readonly employee_id: string;
  readonly leave_type_code: string;
  readonly entry_type: LedgerEntryType;
  /** SIGNED by the ledger — a debit arrives negative. No sign is applied here. */
  readonly days: number;
  readonly effective_date: string;
  /** True when a later entry reversed this one. The reversal is its OWN row. */
  readonly is_reversed: boolean;
}

export interface LedgerMovementRow {
  readonly entryType: LedgerEntryType;
  /** Signed sum: credits positive, debits negative, exactly as the ledger stores them. */
  readonly days: number;
  readonly entries: number;
  readonly employees: number;
}

export interface LeaveMovement {
  readonly rows: readonly LedgerMovementRow[];
  readonly creditedDays: number;
  /** Positive magnitude of the debits — printed with an explicit minus by the UI. */
  readonly debitedDays: number;
  readonly netDays: number;
  readonly entries: number;
  /**
   * Entries a later entry reversed. NOT excluded from the sums: the reversal is its
   * own signed row, so the net is already correct and dropping the original would
   * double-count the correction. Surfaced because a period with many reversals is a
   * period somebody should look at.
   */
  readonly reversedEntries: number;
  readonly employees: number;
}

export const EMPTY_MOVEMENT: LeaveMovement = {
  rows: [],
  creditedDays: 0,
  debitedDays: 0,
  netDays: 0,
  entries: 0,
  reversedEntries: 0,
  employees: 0,
};

/**
 * How leave balances moved over the period, by ledger entry type.
 *
 * This is the complement of {@link aggregateLeaveLiability}: the balance view is a
 * snapshot of where things stand, the ledger is what happened. Accruals, lapses,
 * encashments and adjustments all show here and nowhere else on the panel.
 */
export function aggregateLeaveMovement(
  rows: readonly LeaveLedgerEntryRow[],
): LeaveMovement {
  if (rows.length === 0) return EMPTY_MOVEMENT;

  const byType = new Map<LedgerEntryType, { days: number; entries: number; employees: Set<string> }>();
  const allEmployees = new Set<string>();
  let credited = 0;
  let debited = 0;
  let reversed = 0;

  for (const row of rows) {
    allEmployees.add(row.employee_id);
    if (row.is_reversed) reversed += 1;
    const value = Number.isFinite(row.days) ? row.days : 0;
    if (value >= 0) credited += value;
    else debited += -value;

    let acc = byType.get(row.entry_type);
    if (acc === undefined) {
      acc = { days: 0, entries: 0, employees: new Set<string>() };
      byType.set(row.entry_type, acc);
    }
    acc.days += value;
    acc.entries += 1;
    acc.employees.add(row.employee_id);
  }

  const out: LedgerMovementRow[] = [];
  for (const [entryType, acc] of byType) {
    out.push({
      entryType,
      days: roundDays(acc.days),
      entries: acc.entries,
      employees: acc.employees.size,
    });
  }
  // Largest movement first, in either direction: a 40-day lapse and a 40-day accrual
  // are equally worth looking at.
  out.sort((a, b) => {
    const byMagnitude = Math.abs(b.days) - Math.abs(a.days);
    return byMagnitude !== 0 ? byMagnitude : compareNullableName(a.entryType, b.entryType);
  });

  return {
    rows: out,
    creditedDays: roundDays(credited),
    debitedDays: roundDays(debited),
    netDays: roundDays(credited - debited),
    entries: rows.length,
    reversedEntries: reversed,
    employees: allEmployees.size,
  };
}

// =============================================================================
// 6. Payroll cost by month and department — INTEGER PAISE, addition only
//    Source: v_payroll_cost_monthly (period × department × cost centre)
// =============================================================================

export interface PayrollCostGrainRow {
  readonly year: number;
  readonly month: number;
  readonly pay_period_id: string;
  readonly pay_period_code: string;
  readonly department_id: string | null;
  readonly department_name: string | null;
  readonly cost_centre_id: string | null;
  readonly cost_centre_name: string | null;
  readonly employee_count: number;
  readonly gross_paise: number;
  readonly deductions_paise: number;
  readonly net_paise: number;
  readonly employer_cost_paise: number;
  /** §9.2 Payroll Cost = gross earnings + employer contributions. The view's column. */
  readonly total_cost_paise: number;
  /** Only meaningful AT THIS ROW'S GRAIN — see this module's header. */
  readonly cost_per_employee_paise: number | null;
  readonly overtime_cost_paise: number;
  readonly overtime_share_pct: number | null;
  readonly refreshed_at: string;
}

/** Every money total this panel publishes, all in integer paise. */
export interface CostTotals {
  readonly grossPaise: number;
  readonly deductionsPaise: number;
  readonly netPaise: number;
  readonly employerCostPaise: number;
  readonly totalCostPaise: number;
  readonly overtimeCostPaise: number;
}

const ZERO_TOTALS: CostTotals = {
  grossPaise: 0,
  deductionsPaise: 0,
  netPaise: 0,
  employerCostPaise: 0,
  totalCostPaise: 0,
  overtimeCostPaise: 0,
};

/** One (month × department) cell: the cost-centre level collapsed by addition. */
export interface CostCell extends CostTotals {
  /** 'YYYY-MM', from the view's own `year`/`month` (taken off `pay_periods.end_date`). */
  readonly month: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  /** How many cost-centre rows were added together to make this cell. */
  readonly costCentres: number;
  /**
   * Null by construction. `employee_count` is COUNT(DISTINCT employee) per cost
   * centre, so somebody split across two centres appears twice and a summed
   * denominator would understate cost per head. Read it at row grain instead.
   */
  readonly costPerEmployeePaise: null;
}

export interface CostMonth extends CostTotals {
  readonly month: string;
  readonly departments: number;
  readonly rows: number;
}

export interface CostDepartment extends CostTotals {
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly months: number;
  readonly rows: number;
}

export interface PayrollCostSummary extends CostTotals {
  /** (month × department), month ascending then biggest cost first. The matrix. */
  readonly cells: readonly CostCell[];
  readonly months: readonly CostMonth[];
  readonly departments: readonly CostDepartment[];
  /**
   * Overtime as a share of total cost, recomputed from the two summed paise
   * columns — never an average of the view's per-row `overtime_share_pct`, which is
   * a ratio and cannot be averaged across rows of different sizes. Null when the
   * denominator is zero.
   */
  readonly overtimeSharePct: number | null;
  /** Null for the same reason as {@link CostCell.costPerEmployeePaise}. */
  readonly costPerEmployeePaise: null;
  /**
   * Distinct `pay_period_id`s covered, month-ascending. This is how the variance
   * panel finds the run to report on WITHOUT a second master read: the cost rows
   * already name the pay periods the selected window touches.
   */
  readonly payPeriodIds: readonly string[];
  /** Latest `refreshed_at` across the rows — the matview's "as of". */
  readonly refreshedAt: string | null;
  readonly rows: number;
}

export const EMPTY_COST: PayrollCostSummary = {
  ...ZERO_TOTALS,
  cells: [],
  months: [],
  departments: [],
  overtimeSharePct: null,
  costPerEmployeePaise: null,
  payPeriodIds: [],
  refreshedAt: null,
  rows: 0,
};

interface TotalsAcc {
  gross: number;
  deductions: number;
  net: number;
  employer: number;
  total: number;
  overtime: number;
}

function newTotals(): TotalsAcc {
  return { gross: 0, deductions: 0, net: 0, employer: 0, total: 0, overtime: 0 };
}

/**
 * Integer addition only. Every one of these columns is a Postgres integer count of
 * paise; `+` on integers below 2^53 is exact, which is the whole reason money is
 * carried in minor units rather than as a decimal.
 */
function addTotals(acc: TotalsAcc, row: PayrollCostGrainRow): void {
  acc.gross = addFinite(acc.gross, row.gross_paise);
  acc.deductions = addFinite(acc.deductions, row.deductions_paise);
  acc.net = addFinite(acc.net, row.net_paise);
  acc.employer = addFinite(acc.employer, row.employer_cost_paise);
  acc.total = addFinite(acc.total, row.total_cost_paise);
  acc.overtime = addFinite(acc.overtime, row.overtime_cost_paise);
}

function totalsOf(acc: TotalsAcc): CostTotals {
  return {
    grossPaise: acc.gross,
    deductionsPaise: acc.deductions,
    netPaise: acc.net,
    employerCostPaise: acc.employer,
    totalCostPaise: acc.total,
    overtimeCostPaise: acc.overtime,
  };
}

/** `year`/`month` integers → the 'YYYY-MM' key the rest of the panel sorts on. */
export function costMonthKey(row: { readonly year: number; readonly month: number }): string {
  const m = row.month;
  return `${String(row.year)}-${m < 10 ? "0" : ""}${String(m)}`;
}

/**
 * Ceiling on the months one cost read covers. Three years of monthly periods is
 * already a wider question than this panel is for, and the read fans out to one
 * request per calendar YEAR (see `hr-leavecost.api.ts`), so an unbounded range
 * would also be an unbounded number of round trips.
 */
export const MAX_COST_MONTHS = 36;

export interface CostMonthWindow {
  /** 'YYYY-MM' keys, ascending. Possibly a suffix of the period — see `truncated`. */
  readonly months: readonly string[];
  /** How many months the period actually spans, before the cap. */
  readonly totalMonths: number;
  /** True when the EARLIEST months were dropped to fit {@link MAX_COST_MONTHS}. */
  readonly truncated: boolean;
}

/**
 * The calendar months a period touches, which is the grain
 * `mv_payroll_cost_monthly` is keyed on (`EXTRACT(... FROM pay_periods.end_date)`).
 *
 * A period that overlaps a month at all includes that month, because the matview
 * has no sub-month grain to narrow to — the whole period's cost is booked against
 * the month its END DATE falls in. The panel says so rather than implying that a
 * three-day filter narrows a payroll figure.
 *
 * When the span exceeds the cap the EARLIEST months are dropped, not the latest: a
 * cost trend is read for what happened recently, and losing the right-hand end of
 * the axis would show the current month as missing rather than as capped.
 */
export function costMonthsForPeriod(
  period: Period,
  max: number = MAX_COST_MONTHS,
): CostMonthWindow {
  const first = period.from.slice(0, 7);
  const last = period.to.slice(0, 7);
  if (first > last) return { months: [], totalMonths: 0, truncated: false };

  const months: string[] = [];
  let cursor = first;
  // Bounded by `max * 4` rather than `while (true)`: a malformed period that never
  // reaches `last` must terminate, and the cap below trims the excess anyway.
  for (let i = 0; i < Math.max(1, max) * 4 && cursor <= last; i += 1) {
    months.push(cursor);
    cursor = addIstMonths(cursor, 1);
  }

  const totalMonths = months.length;
  if (totalMonths <= max) return { months, totalMonths, truncated: false };
  return { months: months.slice(totalMonths - max), totalMonths, truncated: true };
}

/**
 * Overtime share as a percentage of total cost. Exported because it is the ONE
 * division in the money path and a test pins it directly.
 *
 * Null — not zero — when the denominator is zero: a month with no cost has no
 * overtime share, and printing 0% would read as "no overtime", which is a claim
 * about a month that had no payroll at all.
 */
export function overtimeSharePct(
  overtimePaise: number,
  totalCostPaise: number,
): number | null {
  if (totalCostPaise === 0) return null;
  return (overtimePaise * 100) / totalCostPaise;
}

/**
 * Payroll cost per (month × department), plus the month and department margins.
 *
 * The only arithmetic is integer addition of named paise columns; see the module
 * header for why collapsing the cost-centre level is legitimate here and is not the
 * org total that `AnalyticsPayroll.page.tsx` deliberately reads from the engine.
 */
export function aggregatePayrollCost(
  rows: readonly PayrollCostGrainRow[],
): PayrollCostSummary {
  if (rows.length === 0) return EMPTY_COST;

  const cells = new Map<
    string,
    { month: string; id: string | null; name: string | null; centres: number; acc: TotalsAcc }
  >();
  const months = new Map<string, { departments: Set<string>; rows: number; acc: TotalsAcc }>();
  const depts = new Map<
    string,
    { id: string | null; name: string | null; months: Set<string>; rows: number; acc: TotalsAcc }
  >();
  const grand = newTotals();
  const payPeriods = new Map<string, string>();
  let refreshedAt: string | null = null;

  for (const row of rows) {
    const month = costMonthKey(row);
    // Keyed by pay period, valued by its month, so the list can be month-ordered
    // below without assuming one period per month (a special run can add another).
    if (!payPeriods.has(row.pay_period_id)) payPeriods.set(row.pay_period_id, month);
    // The matview's own `department_key` sentinel is not projected through every
    // caller, so the unassigned bucket gets an explicit key here instead.
    const deptKey = row.department_id ?? "\u0000unassigned";
    const cellKey = `${month}\u0000${deptKey}`;

    addTotals(grand, row);
    if (refreshedAt === null || row.refreshed_at > refreshedAt) refreshedAt = row.refreshed_at;

    let cell = cells.get(cellKey);
    if (cell === undefined) {
      cell = { month, id: row.department_id, name: row.department_name, centres: 0, acc: newTotals() };
      cells.set(cellKey, cell);
    }
    cell.centres += 1;
    addTotals(cell.acc, row);

    let m = months.get(month);
    if (m === undefined) {
      m = { departments: new Set<string>(), rows: 0, acc: newTotals() };
      months.set(month, m);
    }
    m.departments.add(deptKey);
    m.rows += 1;
    addTotals(m.acc, row);

    let d = depts.get(deptKey);
    if (d === undefined) {
      d = {
        id: row.department_id,
        name: row.department_name,
        months: new Set<string>(),
        rows: 0,
        acc: newTotals(),
      };
      depts.set(deptKey, d);
    }
    d.months.add(month);
    d.rows += 1;
    addTotals(d.acc, row);
  }

  const cellRows: CostCell[] = [];
  for (const cell of cells.values()) {
    cellRows.push({
      month: cell.month,
      departmentId: cell.id,
      departmentName: cell.name,
      costCentres: cell.centres,
      costPerEmployeePaise: null,
      ...totalsOf(cell.acc),
    });
  }
  // Month ascending (a time axis reads left to right), biggest cost first inside it.
  cellRows.sort((a, b) => {
    const byMonth = compareNullableName(a.month, b.month);
    if (byMonth !== 0) return byMonth;
    return b.totalCostPaise !== a.totalCostPaise
      ? b.totalCostPaise - a.totalCostPaise
      : compareNullableName(a.departmentName, b.departmentName);
  });

  const monthRows: CostMonth[] = [];
  for (const [month, m] of months) {
    monthRows.push({ month, departments: m.departments.size, rows: m.rows, ...totalsOf(m.acc) });
  }
  monthRows.sort((a, b) => compareNullableName(a.month, b.month));

  const deptRows: CostDepartment[] = [];
  for (const d of depts.values()) {
    deptRows.push({
      departmentId: d.id,
      departmentName: d.name,
      months: d.months.size,
      rows: d.rows,
      ...totalsOf(d.acc),
    });
  }
  deptRows.sort((a, b) =>
    b.totalCostPaise !== a.totalCostPaise
      ? b.totalCostPaise - a.totalCostPaise
      : compareNullableName(a.departmentName, b.departmentName),
  );

  const periodIds = [...payPeriods.entries()]
    .sort((a, b) => compareNullableName(a[1], b[1]) || compareNullableName(a[0], b[0]))
    .map(([id]) => id);

  const totals = totalsOf(grand);
  return {
    ...totals,
    cells: cellRows,
    months: monthRows,
    departments: deptRows,
    overtimeSharePct: overtimeSharePct(totals.overtimeCostPaise, totals.totalCostPaise),
    costPerEmployeePaise: null,
    payPeriodIds: periodIds,
    refreshedAt,
    rows: rows.length,
  };
}

// =============================================================================
// 7. Variance vs the previous run — the pre-approval sanity check
//    Source: v_payroll_variance, `variance_grain = 'net_pay'` rows
// =============================================================================

export interface PayrollVarianceNetRow {
  readonly employee_id: string;
  readonly employee_code: string | null;
  readonly display_name: string | null;
  readonly variance_grain: "component" | "net_pay";
  readonly current_amount_paise: number;
  /** NULL when the employee has no earlier payslip — a first run, not a zero. */
  readonly previous_amount_paise: number | null;
  readonly variance_paise: number;
  /** NULL when there is no previous amount. Never 0, never Infinity (the view's own rule). */
  readonly variance_pct: number | null;
}

export interface VarianceMover {
  readonly employeeId: string;
  readonly employeeCode: string | null;
  readonly displayName: string | null;
  readonly currentPaise: number;
  readonly previousPaise: number | null;
  readonly variancePaise: number;
  readonly variancePct: number | null;
  /** |variance_pct| exceeds the deployed approval threshold — needs a reason. */
  readonly flagged: boolean;
}

/**
 * ±10%, and it is NOT a number this file chose. Migration 022 installs an approval
 * trigger that blocks a run whose net pay moves more than ±10% without a written
 * reason, and the `v_payroll_variance` comment says so. The panel flags exactly what
 * the database will stop, so an admin sees the blocker before they hit approve.
 */
export const VARIANCE_FLAG_PCT = 10;

export interface PayrollVarianceSummary {
  /** Employees on the run — every net_pay row. */
  readonly employees: number;
  /**
   * Employees who HAVE an earlier payslip. THE denominator of every comparison
   * below: a first-time joiner has no variance, and averaging them in as a 100%
   * increase is how a clean run looks like a crisis.
   */
  readonly comparable: number;
  /** Employees with no earlier payslip. Excluded from the change figures, counted here. */
  readonly firstPayslip: number;
  /** Sum of `current_amount_paise` over EVERY employee — the run's net pay. */
  readonly currentTotalPaise: number;
  /** Sum of `previous_amount_paise` over the COMPARABLE employees only. */
  readonly previousTotalPaise: number;
  /** currentTotal(comparable) − previousTotal(comparable). Like for like. */
  readonly netChangePaise: number;
  readonly increased: number;
  readonly decreased: number;
  readonly unchanged: number;
  /** Comparable employees past ±{@link VARIANCE_FLAG_PCT}. The action list's length. */
  readonly flagged: number;
  /** Biggest absolute movement first — what a reviewer opens the screen for. */
  readonly movers: readonly VarianceMover[];
  /**
   * Rows handed in at the wrong grain and ignored. Should always be 0 — the fetch
   * asks for `variance_grain = 'net_pay'` — and a non-zero value means a caller
   * passed the per-component rows, which would double-count every employee.
   */
  readonly componentRowsIgnored: number;
}

export const EMPTY_VARIANCE: PayrollVarianceSummary = {
  employees: 0,
  comparable: 0,
  firstPayslip: 0,
  currentTotalPaise: 0,
  previousTotalPaise: 0,
  netChangePaise: 0,
  increased: 0,
  decreased: 0,
  unchanged: 0,
  flagged: 0,
  movers: [],
  componentRowsIgnored: 0,
};

/** How many movers the action list carries by default. */
export const DEFAULT_MOVER_COUNT = 15;

/**
 * Net-pay movement against each employee's previous payslip.
 *
 * Every figure is the view's: `variance_paise` and `variance_pct` are computed in
 * SQL against the employee's own preceding pay period, and this function counts and
 * sums them. The only judgement applied is which employees are COMPARABLE, and that
 * judgement is stated in the result rather than buried in an average.
 */
export function aggregatePayrollVariance(
  rows: readonly PayrollVarianceNetRow[],
  moverCount: number = DEFAULT_MOVER_COUNT,
): PayrollVarianceSummary {
  if (rows.length === 0) return EMPTY_VARIANCE;

  let employees = 0;
  let comparable = 0;
  let firstPayslip = 0;
  let currentTotal = 0;
  let previousTotal = 0;
  let comparableCurrent = 0;
  let increased = 0;
  let decreased = 0;
  let unchanged = 0;
  let flagged = 0;
  let ignored = 0;
  const movers: VarianceMover[] = [];

  for (const row of rows) {
    if (row.variance_grain !== "net_pay") {
      ignored += 1;
      continue;
    }
    employees += 1;
    currentTotal = addFinite(currentTotal, row.current_amount_paise);

    if (row.previous_amount_paise === null) {
      firstPayslip += 1;
      continue;
    }
    comparable += 1;
    previousTotal = addFinite(previousTotal, row.previous_amount_paise);
    comparableCurrent = addFinite(comparableCurrent, row.current_amount_paise);

    if (row.variance_paise > 0) increased += 1;
    else if (row.variance_paise < 0) decreased += 1;
    else unchanged += 1;

    const isFlagged =
      row.variance_pct !== null &&
      Number.isFinite(row.variance_pct) &&
      Math.abs(row.variance_pct) > VARIANCE_FLAG_PCT;
    if (isFlagged) flagged += 1;

    movers.push({
      employeeId: row.employee_id,
      employeeCode: row.employee_code,
      displayName: row.display_name,
      currentPaise: row.current_amount_paise,
      previousPaise: row.previous_amount_paise,
      variancePaise: row.variance_paise,
      variancePct: row.variance_pct,
      flagged: isFlagged,
    });
  }

  movers.sort((a, b) => {
    const byMagnitude = Math.abs(b.variancePaise) - Math.abs(a.variancePaise);
    return byMagnitude !== 0 ? byMagnitude : compareNullableName(a.employeeCode, b.employeeCode);
  });

  return {
    employees,
    comparable,
    firstPayslip,
    currentTotalPaise: currentTotal,
    previousTotalPaise: previousTotal,
    // Like for like: the comparable employees' current pay minus their previous pay.
    // Using the whole run's current total here would book every new joiner's first
    // salary as an increase, which is the classic way a variance report cries wolf.
    netChangePaise: comparableCurrent - previousTotal,
    increased,
    decreased,
    unchanged,
    flagged,
    movers: movers.slice(0, Math.max(0, moverCount)),
    componentRowsIgnored: ignored,
  };
}
