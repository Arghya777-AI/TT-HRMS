/**
 * hrLeaveCostAggregate.test.ts — the file `hrLeaveCostAggregate.ts` has claimed
 * since it was written ("the whole of the maths is exercised by
 * hrLeaveCostAggregate.test.ts with literals") and which did not exist.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * 1,400 lines of money and day arithmetic shipped with no test at all, while both
 * its sibling aggregates carry ~50 cases each. Two of its docstrings assert a test
 * that pins them — `overtimeSharePct` says so in as many words. An untested pure
 * module is the cheapest possible thing to get wrong and the most expensive to
 * notice, because every figure it produces is plausible.
 *
 * What is pinned here is chosen by what actually breaks an HR dashboard:
 *
 *   * NULL vs ZERO ON EVERY RATIO AND MEAN. "No overtime" and "no payroll at all"
 *     are opposite findings that both render as 0%; "nobody holds this type" and
 *     "everybody holds zero days" are opposite findings that both render as 0.0.
 *     Each is asserted to be `null`, not `0`.
 *   * MONEY STAYS INTEGER PAISE. Sums of the `*_paise` columns are asserted to be
 *     exact integers — `Number.isInteger`, not a tolerance — because the moment a
 *     float creeps in, a rupee total is wrong in the last two digits forever.
 *   * PAID AND UNPAID ARE NOT ADDED. An unpaid balance costs nothing to honour, so
 *     folding it into the liability overstates the obligation.
 *   * THE DENOMINATOR IS THE PERIOD, NOT THE ROWS. Leave density zero-fills — the
 *     one place in this repo where that is honest — so the mean must be over every
 *     calendar date, and a period the rows do not fill must drag it DOWN.
 *   * THE MONTH WINDOW DROPS THE EARLIEST, NOT THE LATEST. A capped cost trend that
 *     lost its right-hand end would show the current month as missing.
 *   * GROUPING ON IDS, NOT NAMES. Two departments can share a name and two leave
 *     types can be renamed into one label; merging them makes a figure unauditable.
 */
import { describe, expect, it } from "vitest";
import type { Period } from "@/lib/period";
import {
  EMPTY_COST,
  EMPTY_LIABILITY,
  MAX_COST_MONTHS,
  aggregateLeaveDensity,
  aggregateLeaveLiability,
  aggregateLeaveTaken,
  aggregatePayrollCost,
  classifyLeaveStatus,
  costMonthKey,
  costMonthsForPeriod,
  overtimeSharePct,
  roundDays,
  type LeaveBalanceRow,
  type LeaveCalendarDayRow,
  type PayrollCostGrainRow,
} from "./hrLeaveCostAggregate";

// -----------------------------------------------------------------------------
// Builders — every field explicit at the call site that matters, defaults elsewhere
// -----------------------------------------------------------------------------

/** A Period literal — `periodFor` derives both ends from ONE anchor, and these
 *  cases need both ends pinned independently. */
function range(from: string, to: string): Period {
  return { granularity: "range", from, to };
}

function balance(over: Partial<LeaveBalanceRow> = {}): LeaveBalanceRow {
  return {
    employee_id: "e1",
    leave_type_id: "t1",
    leave_type_code: "EL",
    leave_type_name: "Earned Leave",
    is_paid: true,
    is_comp_off: false,
    entitlement_days: 12,
    availed_days: 2,
    pending_days: 1,
    encashed_days: 0,
    lapsed_days: 0,
    available_days: 10,
    available_after_pending: 9,
    ...over,
  };
}

function calDay(over: Partial<LeaveCalendarDayRow> = {}): LeaveCalendarDayRow {
  return {
    employee_id: "e1",
    display_name: "A",
    department_id: "d1",
    department_name: "Kitchen",
    leave_date: "2026-07-10",
    day_value: 1,
    leave_type_code: "EL",
    leave_type_name: "Earned Leave",
    status: "approved",
    ...over,
  };
}

function costRow(over: Partial<PayrollCostGrainRow> = {}): PayrollCostGrainRow {
  return {
    year: 2026,
    month: 7,
    pay_period_id: "p-2026-07",
    pay_period_code: "2026-07",
    department_id: "d1",
    department_name: "Kitchen",
    cost_centre_id: "c1",
    cost_centre_name: "CC1",
    employee_count: 4,
    gross_paise: 10_000_00,
    deductions_paise: 1_000_00,
    net_paise: 9_000_00,
    employer_cost_paise: 2_000_00,
    total_cost_paise: 12_000_00,
    cost_per_employee_paise: null,
    overtime_cost_paise: 600_00,
    overtime_share_pct: 5,
    refreshed_at: "2026-07-25T04:00:00.000Z",
    ...over,
  };
}

// =============================================================================
// overtimeSharePct — the ONE division in the money path
// =============================================================================

describe("overtimeSharePct", () => {
  it("is null, never 0, when there was no cost at all", () => {
    // A month with no payroll has no overtime SHARE. 0% would read as "no
    // overtime was worked", which is a claim about a month nobody was paid in.
    expect(overtimeSharePct(0, 0)).toBeNull();
    expect(overtimeSharePct(500, 0)).toBeNull();
  });

  it("returns a 0–100 percentage, not a 0–1 fraction", () => {
    // The repo's `_pct` convention: formatPercent appends '%' and must not
    // multiply again, so 600/12000 is 5, not 0.05.
    expect(overtimeSharePct(600_00, 12_000_00)).toBe(5);
  });

  it("is 0 — not null — when there is cost but genuinely no overtime", () => {
    expect(overtimeSharePct(0, 12_000_00)).toBe(0);
  });

  it("multiplies before dividing, so a small share does not vanish", () => {
    // (1 * 100) / 1e9 survives; (1 / 1e9) * 100 loses precision on the way.
    expect(overtimeSharePct(1, 1_000_000_000)).toBeGreaterThan(0);
  });
});

// =============================================================================
// Leave liability — days, and the paid/unpaid split that must not be added up
// =============================================================================

describe("aggregateLeaveLiability", () => {
  it("returns the shared empty value for no rows, with liability in days as null", () => {
    expect(aggregateLeaveLiability([])).toBe(EMPTY_LIABILITY);
    expect(EMPTY_LIABILITY.liabilityPaise).toBeNull();
  });

  it("never puts a money figure on a day balance", () => {
    // Typed `null` by construction — no relation carries a per-employee daily
    // rate, so any rupee figure here would be invented. See the module header.
    const out = aggregateLeaveLiability([balance()]);
    expect(out.liabilityPaise).toBeNull();
  });

  it("keeps paid and unpaid balances apart and does not fold them together", () => {
    const out = aggregateLeaveLiability([
      balance({ leave_type_id: "t1", is_paid: true, available_days: 10 }),
      balance({ leave_type_id: "t2", leave_type_code: "LOP", is_paid: false, available_days: 4 }),
    ]);
    expect(out.paidAvailableDays).toBe(10);
    expect(out.unpaidAvailableDays).toBe(4);
    // The total is still both, because it is labelled "total" on screen — the
    // point is that the PAID tile, the money-bearing one, excludes the unpaid 4.
    expect(out.totalAvailableDays).toBe(14);
  });

  it("counts distinct employees across types, not the sum of the per-type counts", () => {
    // One person holding two types is one employee. Summing the per-type
    // denominators would report two heads at a two-person venue.
    const out = aggregateLeaveLiability([
      balance({ employee_id: "e1", leave_type_id: "t1" }),
      balance({ employee_id: "e1", leave_type_id: "t2", leave_type_code: "CL" }),
    ]);
    expect(out.employees).toBe(1);
    expect(out.rows).toHaveLength(2);
  });

  it("groups on leave_type_id, so two types sharing a name stay separate", () => {
    const out = aggregateLeaveLiability([
      balance({ leave_type_id: "t1", leave_type_name: "Leave", available_days: 3 }),
      balance({ leave_type_id: "t2", leave_type_name: "Leave", available_days: 7 }),
    ]);
    expect(out.rows).toHaveLength(2);
  });

  it("breaks comp-off out of the balance view", () => {
    const out = aggregateLeaveLiability([
      balance({ leave_type_id: "t1", is_comp_off: false, available_days: 10 }),
      balance({ leave_type_id: "t2", leave_type_code: "CO", is_comp_off: true, available_days: 2 }),
    ]);
    expect(out.compOffAvailableDays).toBe(2);
  });

  it("averages over the employees who HOLD the type", () => {
    const out = aggregateLeaveLiability([
      balance({ employee_id: "e1", available_days: 10 }),
      balance({ employee_id: "e2", available_days: 20 }),
    ]);
    const row = out.rows[0];
    expect(row).toBeDefined();
    expect(row?.employees).toBe(2);
    expect(row?.avgAvailableDaysPerEmployee).toBe(15);
  });

  it("sums the spendable column separately from the raw balance", () => {
    // `available_after_pending` is the view's own column, not `available - pending`
    // recomputed here — a half-day pending must not be re-derived and re-rounded.
    const out = aggregateLeaveLiability([
      balance({ available_days: 10, pending_days: 1.5, available_after_pending: 8.5 }),
    ]);
    expect(out.rows[0]?.availableAfterPendingDays).toBe(8.5);
  });
});

// =============================================================================
// roundDays — 0.1 + 0.2, at the boundary only
// =============================================================================

describe("roundDays", () => {
  it("removes binary-float residue from summed half-days", () => {
    expect(roundDays(0.1 + 0.2)).toBe(0.3);
    expect(roundDays(0.5 + 0.5 + 0.5)).toBe(1.5);
  });
});

// =============================================================================
// classifyLeaveStatus — cancellation_pending is its OWN class
// =============================================================================

describe("classifyLeaveStatus", () => {
  it("does not fold a pending cancellation into confirmed", () => {
    // The person is still booked off, but somebody has asked to take it back. A
    // confirmed total that hid this would move the moment it is decided.
    expect(classifyLeaveStatus("cancellation_pending")).toBe("cancelling");
    expect(classifyLeaveStatus("approved")).toBe("confirmed");
    expect(classifyLeaveStatus("partially_approved")).toBe("confirmed");
    expect(classifyLeaveStatus("pending")).toBe("pending");
  });

  it("counts withdrawn, rejected, cancelled and draft nowhere", () => {
    for (const s of ["draft", "rejected", "cancelled", "withdrawn"] as const) {
      expect(classifyLeaveStatus(s)).toBe("not_counted");
    }
  });
});

// =============================================================================
// Leave taken — the status split, and grouping on ids
// =============================================================================

describe("aggregateLeaveTaken", () => {
  it("splits days by status class and counts distinct people", () => {
    const out = aggregateLeaveTaken([
      calDay({ employee_id: "e1", status: "approved", day_value: 1 }),
      calDay({ employee_id: "e2", status: "pending", day_value: 1 }),
      calDay({ employee_id: "e3", status: "cancellation_pending", day_value: 0.5 }),
    ]);
    expect(out.total.confirmedDays).toBe(1);
    expect(out.total.pendingDays).toBe(1);
    expect(out.total.cancellingDays).toBe(0.5);
    expect(out.total.employees).toBe(3);
    expect(out.total.dayRows).toBe(3);
  });

  it("keeps a null department as ONE bucket rather than one per row", () => {
    // The sentinel key — two unassigned rows must not become two bars.
    const out = aggregateLeaveTaken([
      calDay({ employee_id: "e1", department_id: null, department_name: null }),
      calDay({ employee_id: "e2", department_id: null, department_name: null }),
    ]);
    const unassigned = out.byDepartment.filter((r) => r.departmentId === null);
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]?.employees).toBe(2);
  });

  it("keeps two departments that share a name apart", () => {
    const out = aggregateLeaveTaken([
      calDay({ department_id: "d1", department_name: "Service" }),
      calDay({ department_id: "d2", department_name: "Service" }),
    ]);
    expect(out.byDepartment).toHaveLength(2);
  });
});

// =============================================================================
// Leave density — the one honest zero-fill in this repo
// =============================================================================

describe("aggregateLeaveDensity", () => {
  const period = range("2026-07-01", "2026-07-10");

  it("states the denominator as every date in the period, not the dates with rows", () => {
    const out = aggregateLeaveDensity([calDay({ leave_date: "2026-07-03" })], period);
    expect(out.daysInPeriod).toBe(10);
    expect(out.points).toHaveLength(10);
  });

  it("divides by the period, so unfilled dates drag the mean DOWN", () => {
    // One person away on one date out of ten is a mean of 0.1, not of 1. A mean
    // over only the dates that had rows would report a venue ten times emptier.
    const out = aggregateLeaveDensity([calDay({ leave_date: "2026-07-03" })], period);
    expect(out.meanHeadcount).toBeCloseTo(0.1, 10);
  });

  it("zero-fills a date with no rows, because the view has a row only for leave", () => {
    const out = aggregateLeaveDensity([calDay({ leave_date: "2026-07-03" })], period);
    const quiet = out.points.find((p) => p.istDate === "2026-07-04");
    expect(quiet?.headcount).toBe(0);
  });

  it("counts a person once per date however many half-days they booked", () => {
    // headcount is the ROSTER number (distinct people); days is the COVER number.
    const out = aggregateLeaveDensity(
      [
        calDay({ employee_id: "e1", leave_date: "2026-07-03", day_value: 0.5 }),
        calDay({ employee_id: "e1", leave_date: "2026-07-03", day_value: 0.5 }),
      ],
      period,
    );
    const day = out.points.find((p) => p.istDate === "2026-07-03");
    expect(day?.headcount).toBe(1);
    expect(day?.days).toBe(1);
  });

  it("returns EVERY date that tied the peak, not just the first", () => {
    // A single "worst day" hides a pattern that repeats every Friday.
    const out = aggregateLeaveDensity(
      [
        calDay({ employee_id: "e1", leave_date: "2026-07-03" }),
        calDay({ employee_id: "e2", leave_date: "2026-07-10" }),
      ],
      period,
    );
    expect(out.peakHeadcount).toBe(1);
    expect([...out.peakDates].sort()).toEqual(["2026-07-03", "2026-07-10"]);
  });

  it("counts a pending cancellation toward the roster but not toward confirmed", () => {
    const out = aggregateLeaveDensity(
      [calDay({ leave_date: "2026-07-03", status: "cancellation_pending" })],
      period,
    );
    const day = out.points.find((p) => p.istDate === "2026-07-03");
    expect(day?.headcount).toBe(1);
    expect(day?.confirmedHeadcount).toBe(0);
    expect(day?.pendingHeadcount).toBe(0);
  });

  it("lists only dates with somebody away in the roster-risk list", () => {
    const out = aggregateLeaveDensity([calDay({ leave_date: "2026-07-03" })], period);
    expect(out.busiestDates).toHaveLength(1);
    expect(out.busiestDates[0]?.istDate).toBe("2026-07-03");
  });

  it("appends a row dated outside the period rather than dropping it", () => {
    // Should be impossible — the fetch filters the same window — but silently
    // hiding one would make this chart disagree with the totals beside it.
    const out = aggregateLeaveDensity([calDay({ leave_date: "2026-08-01" })], period);
    expect(out.points.some((p) => p.istDate === "2026-08-01")).toBe(true);
  });
});

// =============================================================================
// The cost month window — capping drops the EARLIEST months
// =============================================================================

describe("costMonthsForPeriod", () => {
  it("includes every month a period overlaps at all", () => {
    // The matview books a whole period against the month its END DATE falls in,
    // so there is no sub-month grain to narrow to.
    const out = costMonthsForPeriod(range("2026-06-28", "2026-08-02"));
    expect(out.months).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(out.totalMonths).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it("keeps a single month for a single day", () => {
    const out = costMonthsForPeriod(range("2026-07-25", "2026-07-25"));
    expect(out.months).toEqual(["2026-07"]);
  });

  it("drops the earliest months and KEEPS the newest when the span is capped", () => {
    // Losing the right-hand end would show the current month as missing rather
    // than as capped, which reads as a payroll engine that stopped running.
    const out = costMonthsForPeriod(range("2020-01-01", "2026-07-31"));
    expect(out.truncated).toBe(true);
    expect(out.months).toHaveLength(MAX_COST_MONTHS);
    expect(out.months.at(-1)).toBe("2026-07");
    expect(out.totalMonths).toBeGreaterThan(MAX_COST_MONTHS);
  });

  it("terminates on an inverted period instead of looping", () => {
    const out = costMonthsForPeriod(range("2026-08-01", "2026-07-01"));
    expect(out.months).toEqual([]);
    expect(out.truncated).toBe(false);
  });
});

describe("costMonthKey", () => {
  it("zero-pads the month so the keys sort lexicographically", () => {
    expect(costMonthKey({ year: 2026, month: 7 })).toBe("2026-07");
    expect(costMonthKey({ year: 2026, month: 12 })).toBe("2026-12");
  });
});

// =============================================================================
// Payroll cost — integer paise, and the share recomputed from the sums
// =============================================================================

describe("aggregatePayrollCost", () => {
  it("returns the shared empty value for no rows, with a null share", () => {
    const out = aggregatePayrollCost([]);
    expect(out).toBe(EMPTY_COST);
    expect(out.overtimeSharePct).toBeNull();
    expect(out.costPerEmployeePaise).toBeNull();
  });

  it("adds paise as integers and never as floats", () => {
    // Three rows whose rupee values would be exact but whose paise sums must be
    // integers regardless — the assertion is on integrality, not a tolerance.
    const out = aggregatePayrollCost([
      costRow({ cost_centre_id: "c1", gross_paise: 33_33, total_cost_paise: 33_33 }),
      costRow({ cost_centre_id: "c2", gross_paise: 33_33, total_cost_paise: 33_33 }),
      costRow({ cost_centre_id: "c3", gross_paise: 33_34, total_cost_paise: 33_34 }),
    ]);
    expect(out.grossPaise).toBe(10_000);
    expect(Number.isInteger(out.grossPaise)).toBe(true);
    expect(Number.isInteger(out.totalCostPaise)).toBe(true);
  });

  it("collapses the cost-centre level by addition and counts what it collapsed", () => {
    const out = aggregatePayrollCost([
      costRow({ cost_centre_id: "c1", total_cost_paise: 100 }),
      costRow({ cost_centre_id: "c2", total_cost_paise: 200 }),
    ]);
    expect(out.cells).toHaveLength(1);
    expect(out.cells[0]?.totalCostPaise).toBe(300);
    expect(out.cells[0]?.costCentres).toBe(2);
  });

  it("recomputes the overtime share from the summed columns, not by averaging the view's ratio", () => {
    // Averaging a per-row ratio across rows of different sizes is the classic
    // wrong answer: 5% of a large row and 50% of a tiny one is not 27.5%.
    const out = aggregatePayrollCost([
      costRow({ cost_centre_id: "c1", overtime_cost_paise: 500, total_cost_paise: 10_000, overtime_share_pct: 5 }),
      costRow({ cost_centre_id: "c2", overtime_cost_paise: 500, total_cost_paise: 1_000, overtime_share_pct: 50 }),
    ]);
    // 1000 / 11000 = 9.0909…%, not the mean of 5 and 50.
    expect(out.overtimeSharePct).toBeCloseTo((1000 * 100) / 11_000, 10);
  });

  it("refuses a per-employee cost, because employee_count cannot be added across grains", () => {
    // COUNT(DISTINCT employee) per cost centre: one person split across two cost
    // centres is counted twice, so the sum is not a headcount.
    const out = aggregatePayrollCost([costRow()]);
    expect(out.costPerEmployeePaise).toBeNull();
    expect(out.cells[0]?.costPerEmployeePaise).toBeNull();
  });

  it("names every pay period the window touches, for the variance read to reuse", () => {
    const out = aggregatePayrollCost([
      costRow({ year: 2026, month: 6, pay_period_id: "p-06" }),
      costRow({ year: 2026, month: 7, pay_period_id: "p-07" }),
    ]);
    expect([...out.payPeriodIds]).toEqual(["p-06", "p-07"]);
  });

  it("reports the LATEST refreshed_at as the matview's as-of", () => {
    const out = aggregatePayrollCost([
      costRow({ cost_centre_id: "c1", refreshed_at: "2026-07-25T04:00:00.000Z" }),
      costRow({ cost_centre_id: "c2", refreshed_at: "2026-07-26T04:00:00.000Z" }),
    ]);
    expect(out.refreshedAt).toBe("2026-07-26T04:00:00.000Z");
  });

  it("keeps a null department as one bucket and two same-named departments apart", () => {
    const out = aggregatePayrollCost([
      costRow({ department_id: null, department_name: null, cost_centre_id: "c1" }),
      costRow({ department_id: null, department_name: null, cost_centre_id: "c2" }),
      costRow({ department_id: "d1", department_name: "Service" }),
      costRow({ department_id: "d2", department_name: "Service" }),
    ]);
    expect(out.departments.filter((d) => d.departmentId === null)).toHaveLength(1);
    expect(out.departments.filter((d) => d.departmentName === "Service")).toHaveLength(2);
  });

  it("makes the month margin add up to the headline total", () => {
    const out = aggregatePayrollCost([
      costRow({ year: 2026, month: 6, pay_period_id: "p-06", total_cost_paise: 111 }),
      costRow({ year: 2026, month: 7, pay_period_id: "p-07", total_cost_paise: 222 }),
    ]);
    const summed = out.months.reduce((n, m) => n + m.totalCostPaise, 0);
    expect(summed).toBe(out.totalCostPaise);
    expect(out.totalCostPaise).toBe(333);
  });
});
