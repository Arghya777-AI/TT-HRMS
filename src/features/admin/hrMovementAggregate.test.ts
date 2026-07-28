/**
 * hrMovementAggregate.test.ts — every number the Movement & Risk panel shows,
 * pinned to hand-computed values.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `analytics.mv_headcount_daily` cannot be rolled up over an arbitrary period by
 * PostgREST, so the series, the department table and the attrition rate are
 * computed in the browser (see the header of `hrMovementAggregate.ts`). That is a
 * documented exception to "the number is the server's", and the price of the
 * exception is this file: every mean, every denominator, every watchlist
 * predicate and every empty-set case is exercised with literals — no database, no
 * clock, no network.
 *
 * The cases that actually break an HR dashboard, all covered below:
 *   * A PERIOD THE SNAPSHOT DOES NOT COVER. The matview stops at the last
 *     refresh; a period running into the future must yield gaps and a mean over
 *     COVERED days, not a mean dragged toward zero by days nobody measured.
 *   * A MISSING DEPARTMENT ON A COVERED DAY — the opposite call: a real zero,
 *     because the snapshot covers the whole organisation for every date it holds.
 *     Get this backwards and the department rows stop adding up to the headline.
 *   * DIVISION BY ZERO — attrition with no headcount, shares with no exits.
 *   * ANNUALISING A SHORT WINDOW — the ×52 that turns one leaver into a crisis.
 *   * THE THREE-STATE REHIRE FLAG — a NULL that must never be counted as a "no".
 *   * WATCHLIST BOUNDARIES — due today, expiring today, last working day today.
 *     Every one of them is an off-by-one waiting to put the wrong person on a
 *     list (or leave the right one off it).
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_EXIT_QUALITY,
  EMPTY_MOVEMENT_SERIES,
  MAX_MOVEMENT_POINTS,
  MIN_ANNUALISE_DAYS,
  aggregateMovementSeries,
  attritionOf,
  contractWatchlist,
  exitQualityOf,
  groupMovementByDepartment,
  hypotheticalAnnualiseFactor,
  noticeWatchlist,
  probationWatchlist,
  reconcileMovement,
  seriesAttrition,
  type HeadcountDayRow,
  type MovementEmployeeRow,
} from "./hrMovementAggregate";
import type { Period } from "@/lib/period";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function period(from: string, to: string): Period {
  return { granularity: "range", from, to };
}

/** One snapshot row. Tests override only the fields they are about. */
function snap(over: Partial<HeadcountDayRow> = {}): HeadcountDayRow {
  return {
    as_of_date: "2026-07-01",
    department_id: "d-kitchen",
    department_name: "Kitchen",
    employment_type: "permanent",
    headcount: 10,
    joiners: 0,
    exits: 0,
    ...over,
  };
}

/** One employee row. Everything is "nothing happening" until a test says otherwise. */
function emp(over: Partial<MovementEmployeeRow> = {}): MovementEmployeeRow {
  return {
    id: "e1",
    employee_code: "TT-001",
    display_name: "Asha Nair",
    employment_status: "on_probation",
    employment_type: "probation",
    date_of_join: "2026-01-15",
    probation_months: 6,
    confirmation_due_date: "2026-07-15",
    confirmed_on: null,
    contract_end_date: null,
    notice_period_days: 30,
    resignation_date: null,
    last_working_day: null,
    exit_type: null,
    exit_reason: null,
    exit_interview_done: false,
    is_rehire_eligible: null,
    full_and_final_settled_on: null,
    department_name: "Kitchen",
    designation_name: "Commis I",
    location_name: "Main",
    reporting_manager_name: "Ravi Menon",
    ...over,
  };
}

// -----------------------------------------------------------------------------
// The series
// -----------------------------------------------------------------------------

describe("aggregateMovementSeries", () => {
  it("returns the honest empty answer for no rows: zero counts, a NULL average", () => {
    const s = aggregateMovementSeries([], period("2026-07-01", "2026-07-03"));
    expect(s.points).toHaveLength(3);
    expect(s.points.every((p) => !p.isCovered)).toBe(true);
    expect(s.coveredDays).toBe(0);
    expect(s.periodDays).toBe(3);
    // Null, NOT zero: "we have no headcount data" and "there were no people" are
    // different facts and an attrition denominator must not confuse them.
    expect(s.avgHeadcount).toBeNull();
    expect(s.openingHeadcount).toBeNull();
    expect(s.closingHeadcount).toBeNull();
  });

  it("sums departments and employment types within a date", () => {
    const s = aggregateMovementSeries(
      [
        snap({ as_of_date: "2026-07-01", department_id: "d1", headcount: 10, joiners: 1 }),
        snap({ as_of_date: "2026-07-01", department_id: "d2", headcount: 7, exits: 2 }),
        snap({
          as_of_date: "2026-07-01",
          department_id: "d1",
          employment_type: "contract",
          headcount: 3,
        }),
      ],
      period("2026-07-01", "2026-07-01"),
    );
    expect(s.points[0]?.headcount).toBe(20);
    expect(s.points[0]?.joiners).toBe(1);
    expect(s.points[0]?.exits).toBe(2);
    expect(s.avgHeadcount).toBe(20);
    expect(s.netChange).toBe(-1);
  });

  it("averages over COVERED days, not calendar days — the snapshot stops at its refresh", () => {
    // Three-day period; the snapshot only holds the first two. A mean over three
    // days would be 30/3 = 10 and would understate the venue by a third.
    const s = aggregateMovementSeries(
      [
        snap({ as_of_date: "2026-07-01", headcount: 14 }),
        snap({ as_of_date: "2026-07-02", headcount: 16 }),
      ],
      period("2026-07-01", "2026-07-03"),
    );
    expect(s.coveredDays).toBe(2);
    expect(s.periodDays).toBe(3);
    expect(s.avgHeadcount).toBe(15);
    expect(s.points[2]).toEqual({
      istDate: "2026-07-03",
      isCovered: false,
      headcount: null,
      joiners: null,
      exits: null,
    });
  });

  it("reports opening and closing headcount from the first and last COVERED day", () => {
    const s = aggregateMovementSeries(
      [
        snap({ as_of_date: "2026-07-02", headcount: 20 }),
        snap({ as_of_date: "2026-07-04", headcount: 23 }),
      ],
      period("2026-07-01", "2026-07-05"),
    );
    expect(s.firstCoveredDate).toBe("2026-07-02");
    expect(s.lastCoveredDate).toBe("2026-07-04");
    expect(s.openingHeadcount).toBe(20);
    expect(s.closingHeadcount).toBe(23);
    // The uncovered 1st and 5th contribute to neither the mean nor the totals.
    expect(s.coveredDays).toBe(2);
    expect(s.avgHeadcount).toBe(21.5);
  });

  it("ignores rows outside the period so the rate cannot cover a window its label denies", () => {
    const s = aggregateMovementSeries(
      [
        snap({ as_of_date: "2026-06-30", headcount: 100, exits: 9 }),
        snap({ as_of_date: "2026-07-01", headcount: 10, exits: 1 }),
      ],
      period("2026-07-01", "2026-07-01"),
    );
    expect(s.coveredDays).toBe(1);
    expect(s.exits).toBe(1);
    expect(s.avgHeadcount).toBe(10);
  });

  it("returns the empty series for an inverted period rather than throwing", () => {
    expect(aggregateMovementSeries([snap()], period("2026-07-05", "2026-07-01"))).toEqual(
      EMPTY_MOVEMENT_SERIES,
    );
  });

  it("caps the point count so a hand-edited decade-long URL cannot freeze the chart", () => {
    const s = aggregateMovementSeries([], period("2020-01-01", "2039-12-31"));
    expect(s.points).toHaveLength(MAX_MOVEMENT_POINTS);
  });
});

// -----------------------------------------------------------------------------
// Attrition
// -----------------------------------------------------------------------------

describe("attritionOf", () => {
  it("is exits ÷ average headcount × 100, over the stated window", () => {
    const r = attritionOf(3, 120, 31);
    expect(r.periodPct).toBeCloseTo(2.5, 10);
    expect(r.windowDays).toBe(31);
  });

  it("annualises a month-long window and labels the factor", () => {
    const r = attritionOf(3, 120, 30);
    expect(r.annualiseFactor).toBeCloseTo(365 / 30, 10);
    expect(r.annualisedPct).toBeCloseTo(2.5 * (365 / 30), 10);
  });

  it("REFUSES to annualise a week — one leaver would read as 52% a year", () => {
    const r = attritionOf(1, 100, 7);
    expect(r.periodPct).toBeCloseTo(1, 10);
    expect(r.annualiseFactor).toBeNull();
    expect(r.annualisedPct).toBeNull();
    // …but the screen can still say what the factor WOULD have been.
    expect(hypotheticalAnnualiseFactor(7)).toBeCloseTo(365 / 7, 10);
  });

  it("annualises exactly at the floor and not one day below it", () => {
    expect(attritionOf(1, 100, MIN_ANNUALISE_DAYS).annualisedPct).not.toBeNull();
    expect(attritionOf(1, 100, MIN_ANNUALISE_DAYS - 1).annualisedPct).toBeNull();
  });

  it("returns null rather than Infinity when there is no denominator", () => {
    expect(attritionOf(4, null, 30).periodPct).toBeNull();
    expect(attritionOf(4, 0, 30).periodPct).toBeNull();
    expect(attritionOf(0, 0, 30).periodPct).toBeNull();
    // And the null propagates — no NaN reaches a formatter.
    expect(attritionOf(4, 0, 30).annualisedPct).toBeNull();
  });

  it("takes both numerator and denominator from ONE series", () => {
    const s = aggregateMovementSeries(
      [
        snap({ as_of_date: "2026-07-01", headcount: 100, exits: 1 }),
        snap({ as_of_date: "2026-07-02", headcount: 99 }),
      ],
      period("2026-07-01", "2026-07-02"),
    );
    const r = seriesAttrition(s);
    expect(r.exits).toBe(1);
    expect(r.avgHeadcount).toBe(99.5);
    // The window is COVERED days — labelling it with the calendar period would
    // overstate the observation window and understate the rate.
    expect(r.windowDays).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// By department
// -----------------------------------------------------------------------------

describe("groupMovementByDepartment", () => {
  const rows = [
    snap({ as_of_date: "2026-07-01", department_id: "d1", department_name: "Kitchen", headcount: 10, joiners: 1 }),
    snap({ as_of_date: "2026-07-01", department_id: "d2", department_name: "Service", headcount: 6 }),
    // Kitchen only; Service has NOBODY on the 2nd and therefore has no row.
    snap({ as_of_date: "2026-07-02", department_id: "d1", department_name: "Kitchen", headcount: 11, exits: 2 }),
  ];
  const p = period("2026-07-01", "2026-07-02");

  it("divides every department by the SAME covered-day count, zero-filling gaps", () => {
    const out = groupMovementByDepartment(rows, p, 2);
    const service = out.find((r) => r.departmentId === "d2");
    // 6 on the 1st, genuinely nobody on the 2nd → 6/2 = 3, not 6/1 = 6.
    // The snapshot covers the whole organisation for a date it holds, so an
    // absent (date, department) pair is a real zero.
    expect(service?.avgHeadcount).toBe(3);
    const kitchen = out.find((r) => r.departmentId === "d1");
    expect(kitchen?.avgHeadcount).toBe(10.5);
  });

  it("makes the departments add up to the organisation-wide average", () => {
    const series = aggregateMovementSeries(rows, p);
    const out = groupMovementByDepartment(rows, p, series.coveredDays);
    const sum = out.reduce((n, r) => n + (r.avgHeadcount ?? 0), 0);
    expect(sum).toBeCloseTo(series.avgHeadcount ?? 0, 10);
    expect(out.reduce((n, r) => n + r.joiners, 0)).toBe(series.joiners);
    expect(out.reduce((n, r) => n + r.exits, 0)).toBe(series.exits);
  });

  it("keeps two same-named departments apart because it groups on the id", () => {
    const out = groupMovementByDepartment(
      [
        snap({ department_id: "d1", department_name: "Banquet", exits: 1 }),
        snap({ department_id: "d2", department_name: "Banquet", exits: 4 }),
      ],
      period("2026-07-01", "2026-07-01"),
      1,
    );
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.exits).sort()).toEqual([1, 4]);
  });

  it("keeps the unassigned bucket rather than dropping people with no department", () => {
    const out = groupMovementByDepartment(
      [snap({ department_id: null, department_name: null, headcount: 2, joiners: 2 })],
      period("2026-07-01", "2026-07-01"),
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.departmentId).toBeNull();
    expect(out[0]?.joiners).toBe(2);
  });

  it("sorts busiest first with a stable name tiebreak", () => {
    const out = groupMovementByDepartment(
      [
        snap({ department_id: "a", department_name: "Alpha", joiners: 1 }),
        snap({ department_id: "b", department_name: "Beta", joiners: 3, exits: 2 }),
        snap({ department_id: "c", department_name: "Gamma", exits: 1 }),
      ],
      period("2026-07-01", "2026-07-01"),
      1,
    );
    expect(out.map((r) => r.departmentName)).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("gives a null average when nothing is covered, never a divide by zero", () => {
    const out = groupMovementByDepartment([snap()], period("2026-07-01", "2026-07-01"), 0);
    expect(out[0]?.avgHeadcount).toBeNull();
    expect(out[0]?.attrition.periodPct).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Probation watchlist
// -----------------------------------------------------------------------------

describe("probationWatchlist", () => {
  const today = "2026-07-10";

  it("lists an unconfirmed employee whose due date falls on or before the period end", () => {
    const out = probationWatchlist([emp({ confirmation_due_date: "2026-07-31" })], "2026-07-31", today);
    expect(out).toHaveLength(1);
    expect(out[0]?.dueOn).toBe("2026-07-31");
    expect(out[0]?.daysUntilDue).toBe(21);
    expect(out[0]?.isOverdue).toBe(false);
  });

  it("excludes anyone already confirmed", () => {
    expect(
      probationWatchlist([emp({ confirmed_on: "2026-07-01" })], "2026-07-31", today),
    ).toHaveLength(0);
  });

  it("excludes a due date past the period end — the window is the period, not 'ever'", () => {
    expect(
      probationWatchlist([emp({ confirmation_due_date: "2026-08-01" })], "2026-07-31", today),
    ).toHaveLength(0);
  });

  it("excludes rows with no due date at all (no joining date recorded yet)", () => {
    expect(
      probationWatchlist(
        [emp({ date_of_join: null, confirmation_due_date: null })],
        "2026-07-31",
        today,
      ),
    ).toHaveLength(0);
  });

  it("excludes people who have already left — confirming a leaver is not work", () => {
    expect(
      probationWatchlist([emp({ employment_status: "exited" })], "2026-07-31", today),
    ).toHaveLength(0);
    expect(
      probationWatchlist([emp({ employment_status: "retired" })], "2026-07-31", today),
    ).toHaveLength(0);
    // …but an absconder IS shown: their confirmation is a genuinely open decision.
    expect(
      probationWatchlist([emp({ employment_status: "absconding" })], "2026-07-31", today),
    ).toHaveLength(1);
  });

  it("marks an overdue confirmation with a NEGATIVE day count, and 'due today' as zero", () => {
    const overdue = probationWatchlist(
      [emp({ confirmation_due_date: "2026-07-01" })],
      "2026-07-31",
      today,
    );
    expect(overdue[0]?.daysUntilDue).toBe(-9);
    expect(overdue[0]?.isOverdue).toBe(true);

    // The boundary: due TODAY is not yet overdue.
    const dueToday = probationWatchlist(
      [emp({ confirmation_due_date: today })],
      "2026-07-31",
      today,
    );
    expect(dueToday[0]?.daysUntilDue).toBe(0);
    expect(dueToday[0]?.isOverdue).toBe(false);
  });

  it("sorts the oldest unmade decision first", () => {
    const out = probationWatchlist(
      [
        emp({ id: "b", employee_code: "TT-002", confirmation_due_date: "2026-07-20" }),
        emp({ id: "a", employee_code: "TT-001", confirmation_due_date: "2026-06-01" }),
      ],
      "2026-07-31",
      today,
    );
    expect(out.map((r) => r.employee.id)).toEqual(["a", "b"]);
  });
});

// -----------------------------------------------------------------------------
// Contract watchlist
// -----------------------------------------------------------------------------

describe("contractWatchlist", () => {
  const today = "2026-07-10";

  it("lists contracts inside the window, inclusive of both ends", () => {
    const rows = [
      emp({ id: "a", contract_end_date: "2026-07-01" }),
      emp({ id: "b", contract_end_date: "2026-08-30" }),
      emp({ id: "c", contract_end_date: "2026-08-31" }),
    ];
    const out = contractWatchlist(rows, "2026-07-01", "2026-08-30", today);
    expect(out.map((r) => r.employee.id)).toEqual(["a", "b"]);
  });

  it("flags an already-lapsed contract nobody acted on", () => {
    const out = contractWatchlist(
      [emp({ contract_end_date: "2026-07-05" })],
      "2026-07-01",
      "2026-08-30",
      today,
    );
    expect(out[0]?.hasExpired).toBe(true);
    expect(out[0]?.daysUntilEnd).toBe(-5);
  });

  it("treats a contract ending today as not yet expired", () => {
    const out = contractWatchlist([emp({ contract_end_date: today })], "2026-07-01", "2026-08-30", today);
    expect(out[0]?.daysUntilEnd).toBe(0);
    expect(out[0]?.hasExpired).toBe(false);
  });

  it("shows nobody without a contract end date — a permanent employee is not at risk", () => {
    expect(
      contractWatchlist([emp({ contract_end_date: null })], "2026-07-01", "2026-08-30", today),
    ).toHaveLength(0);
  });

  it("excludes people who have already left", () => {
    expect(
      contractWatchlist(
        [emp({ contract_end_date: "2026-07-20", employment_status: "exited" })],
        "2026-07-01",
        "2026-08-30",
        today,
      ),
    ).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Notice watchlist
// -----------------------------------------------------------------------------

describe("noticeWatchlist", () => {
  const today = "2026-07-10";

  it("lists a resignation whose last working day is still ahead", () => {
    const out = noticeWatchlist(
      [emp({ resignation_date: "2026-07-01", last_working_day: "2026-07-31" })],
      today,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.daysRemaining).toBe(21);
    expect(out[0]?.noticeServedDays).toBe(30);
    // 30-day policy, 30 days served → no shortfall.
    expect(out[0]?.noticeShortfallDays).toBe(0);
  });

  it("computes the shortfall against the notice period on the record", () => {
    const out = noticeWatchlist(
      [
        emp({
          resignation_date: "2026-07-05",
          last_working_day: "2026-07-20",
          notice_period_days: 30,
        }),
      ],
      today,
    );
    expect(out[0]?.noticeServedDays).toBe(15);
    expect(out[0]?.noticeShortfallDays).toBe(15);
  });

  it("reports serving MORE than the policy as a negative shortfall, not as zero", () => {
    const out = noticeWatchlist(
      [
        emp({
          resignation_date: "2026-06-01",
          last_working_day: "2026-07-31",
          notice_period_days: 30,
        }),
      ],
      today,
    );
    expect(out[0]?.noticeServedDays).toBe(60);
    expect(out[0]?.noticeShortfallDays).toBe(-30);
  });

  it("drops somebody whose last working day is today or past — notice is over", () => {
    expect(
      noticeWatchlist([emp({ resignation_date: "2026-06-10", last_working_day: today })], today),
    ).toHaveLength(0);
    expect(
      noticeWatchlist(
        [emp({ resignation_date: "2026-06-01", last_working_day: "2026-07-01" })],
        today,
      ),
    ).toHaveLength(0);
  });

  it("needs BOTH a resignation date and a last working day", () => {
    expect(
      noticeWatchlist([emp({ resignation_date: null, last_working_day: "2026-07-31" })], today),
    ).toHaveLength(0);
    expect(
      noticeWatchlist([emp({ resignation_date: "2026-07-01", last_working_day: null })], today),
    ).toHaveLength(0);
  });

  it("puts the soonest leaver at the top — that is the most urgent handover", () => {
    const out = noticeWatchlist(
      [
        emp({ id: "late", employee_code: "TT-002", resignation_date: "2026-07-01", last_working_day: "2026-08-31" }),
        emp({ id: "soon", employee_code: "TT-001", resignation_date: "2026-07-01", last_working_day: "2026-07-15" }),
      ],
      today,
    );
    expect(out.map((r) => r.employee.id)).toEqual(["soon", "late"]);
  });
});

// -----------------------------------------------------------------------------
// Exit quality
// -----------------------------------------------------------------------------

describe("exitQualityOf", () => {
  it("returns the empty answer with no exits — no share divides by zero downstream", () => {
    expect(exitQualityOf([])).toEqual(EMPTY_EXIT_QUALITY);
  });

  it("counts the three rehire states separately and never folds NULL into 'no'", () => {
    const q = exitQualityOf([
      emp({ id: "a", is_rehire_eligible: true }),
      emp({ id: "b", is_rehire_eligible: false }),
      emp({ id: "c", is_rehire_eligible: null }),
      emp({ id: "d", is_rehire_eligible: null }),
    ]);
    expect(q.rehireEligible).toBe(1);
    expect(q.rehireNotEligible).toBe(1);
    expect(q.rehireUndecided).toBe(2);
    // The check that the NULL state was not quietly dropped.
    expect(q.rehireEligible + q.rehireNotEligible + q.rehireUndecided).toBe(q.exits);
  });

  it("counts interviews and settlements with their complements", () => {
    const q = exitQualityOf([
      emp({ id: "a", exit_interview_done: true, full_and_final_settled_on: "2026-07-20" }),
      emp({ id: "b", exit_interview_done: false, full_and_final_settled_on: null }),
      emp({ id: "c", exit_interview_done: true, full_and_final_settled_on: null }),
    ]);
    expect(q.exits).toBe(3);
    expect(q.interviewDone).toBe(2);
    expect(q.interviewPending).toBe(1);
    expect(q.settled).toBe(1);
    expect(q.settlementPending).toBe(2);
  });

  it("breaks exits down by type, biggest first, with the unrecorded bucket LAST", () => {
    const q = exitQualityOf([
      emp({ id: "a", exit_type: null }),
      emp({ id: "b", exit_type: null }),
      emp({ id: "c", exit_type: null }),
      emp({ id: "d", exit_type: "resignation" }),
      emp({ id: "e", exit_type: "resignation" }),
      emp({ id: "f", exit_type: "termination" }),
    ]);
    // "Not recorded" is the biggest bucket here and still sorts last: it is an
    // absence of data, not the commonest reason people leave.
    expect(q.byType.map((r) => r.exitType)).toEqual(["resignation", "termination", null]);
    expect(q.byType.map((r) => r.exits)).toEqual([2, 1, 3]);
  });

  it("treats an empty-string exit type as unrecorded rather than as its own bucket", () => {
    const q = exitQualityOf([emp({ id: "a", exit_type: "" }), emp({ id: "b", exit_type: null })]);
    expect(q.byType).toHaveLength(1);
    expect(q.byType[0]).toEqual({ exitType: null, exits: 2 });
  });

  it("does not invent a voluntary/involuntary split — the six recorded types stand", () => {
    const q = exitQualityOf([
      emp({ id: "a", exit_type: "end_of_contract" }),
      emp({ id: "b", exit_type: "absconding" }),
    ]);
    expect(q.byType.map((r) => r.exitType).sort()).toEqual(["absconding", "end_of_contract"]);
  });
});

// -----------------------------------------------------------------------------
// Reconciliation
// -----------------------------------------------------------------------------

describe("reconcileMovement", () => {
  const s = aggregateMovementSeries(
    [snap({ as_of_date: "2026-07-01", joiners: 2, exits: 1 })],
    period("2026-07-01", "2026-07-01"),
  );

  it("agrees when the nightly snapshot and the live master match", () => {
    const r = reconcileMovement(s, 2, 1);
    expect(r.agrees).toBe(true);
    expect(r.joinersDelta).toBe(0);
    expect(r.exitsDelta).toBe(0);
  });

  it("reports the delta rather than picking a winner when they differ", () => {
    // Somebody joined after the 02:00 refresh: the live master is ahead.
    const r = reconcileMovement(s, 3, 1);
    expect(r.agrees).toBe(false);
    expect(r.joinersDelta).toBe(1);
    expect(r.snapshotJoiners).toBe(2);
    expect(r.liveJoiners).toBe(3);
  });

  it("handles an empty snapshot without claiming the live figures are wrong", () => {
    const empty = aggregateMovementSeries([], period("2026-07-01", "2026-07-01"));
    const r = reconcileMovement(empty, 4, 2);
    expect(r.snapshotJoiners).toBe(0);
    expect(r.joinersDelta).toBe(4);
    expect(r.exitsDelta).toBe(2);
    expect(r.agrees).toBe(false);
  });
});
