/**
 * hrWorkforceAggregate.test.ts — the arithmetic behind every figure on the
 * Workforce & Org panel, pinned to hand-computed values.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * PostgREST cannot GROUP BY, so headcount by designation, tenure bands, age
 * bands, span of control and the diversity blocks are all counted in the
 * browser (see the module header). That is a deliberate, documented exception
 * to "the number is the server's", and the price of the exception is this file:
 * every bucket, every band boundary, every denominator and every suppression
 * decision is exercised here with literals — no database, no clock, no network.
 *
 * The cases that actually break a workforce dashboard, all covered below:
 *   * THE AS-AT RULE — a leaver counted after they left, or a joiner counted
 *     before they started, is a headcount nobody can reconcile with payroll;
 *   * THE BAND BOUNDARY — 3 months, 12 months, 36 months, 25 years: off by one
 *     day at a boundary moves a person between bars;
 *   * A MISSING DATE OF BIRTH — must be excluded and COUNTED as excluded, never
 *     aged zero;
 *   * DIVISION BY ZERO — no managers, no rows, nobody with a birth date;
 *   * THE MANAGER TRAP — reportee counts must survive a manager who is outside
 *     the filtered set;
 *   * K-ANONYMITY — a withheld bucket whose size can be recovered by
 *     subtracting the published ones from the total is not withheld at all;
 *   * A GAP IN THE TREND — a date the matview does not cover must be null, not
 *     a zero that draws the workforce vanishing overnight.
 */
import { describe, expect, it } from "vitest";
import {
  AGE_BANDS,
  MIN_PUBLISHABLE_BUCKET,
  TENURE_BANDS,
  WIDE_SPAN_THRESHOLD,
  ageBandOf,
  ageBands,
  aggregateHeadcountTrend,
  aggregateWorkforce,
  completedMonths,
  completedYears,
  diversityBreakdown,
  headcountBy,
  isOnRollAt,
  onRollAt,
  resolveAsOf,
  spanOfControl,
  suppressSmallBuckets,
  tenureBandOf,
  tenureBands,
  type HeadcountBucket,
  type HeadcountDailyRow,
  type WorkforceEmployeeRow,
} from "./hrWorkforceAggregate";
import type { Period } from "@/lib/period";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/** The directory's on-roll status set, as the api layer passes it in. */
const ON_ROLL = ["pre_joining", "active", "on_probation", "confirmed", "on_notice", "suspended", "on_long_leave", "rehired"];

/**
 * A plain permanent employee. Every test overrides only the fields it is about,
 * so a failure names the measure that broke rather than a wall of literals.
 */
function emp(over: Partial<WorkforceEmployeeRow> = {}): WorkforceEmployeeRow {
  return {
    id: "e1",
    employee_code: "TT-001",
    display_name: "Asha Nair",
    department_id: "d-kitchen",
    department_name: "Kitchen",
    designation_name: "Commis",
    grade_name: "G3",
    location_id: "l-main",
    location_name: "Main venue",
    employment_type: "permanent",
    employment_status: "confirmed",
    date_of_join: "2020-01-01",
    last_working_day: null,
    date_of_birth: "1990-06-15",
    reporting_manager_id: null,
    reporting_manager_name: null,
    gender: "female",
    category: "GEN",
    is_differently_abled: false,
    nationality: "Indian",
    marital_status: "single",
    ...over,
  };
}

/** N people with distinct ids and codes, sharing an override. */
function people(n: number, over: (i: number) => Partial<WorkforceEmployeeRow>): WorkforceEmployeeRow[] {
  return Array.from({ length: n }, (_, i) =>
    emp({ id: `e${String(i)}`, employee_code: `TT-${String(i).padStart(3, "0")}`, ...over(i) }),
  );
}

const AS_OF = "2026-07-31";

const monthPeriod: Period = { granularity: "month", from: "2026-07-01", to: "2026-07-31" };

// -----------------------------------------------------------------------------
// The as-at date
// -----------------------------------------------------------------------------

describe("resolveAsOf", () => {
  it("uses the end of a finished period and marks it historical", () => {
    expect(resolveAsOf({ granularity: "month", from: "2026-06-01", to: "2026-06-30" }, "2026-07-28")).toEqual({
      date: "2026-06-30",
      clamped: false,
      historical: true,
    });
  });

  it("clamps a period that has not finished back to today", () => {
    // The July period runs to the 31st; on the 28th, counting to the 31st would
    // include a joiner dated the 30th who has not started.
    expect(resolveAsOf(monthPeriod, "2026-07-28")).toEqual({
      date: "2026-07-28",
      clamped: true,
      historical: false,
    });
  });

  it("is neither clamped nor historical when the period ends today", () => {
    expect(resolveAsOf({ granularity: "day", from: "2026-07-28", to: "2026-07-28" }, "2026-07-28")).toEqual({
      date: "2026-07-28",
      clamped: false,
      historical: false,
    });
  });
});

// -----------------------------------------------------------------------------
// Headcount membership
// -----------------------------------------------------------------------------

describe("isOnRollAt", () => {
  it("counts somebody who joined earlier and has not left", () => {
    expect(isOnRollAt({ date_of_join: "2020-01-01", last_working_day: null }, AS_OF)).toBe(true);
  });

  it("counts the joining day itself", () => {
    expect(isOnRollAt({ date_of_join: AS_OF, last_working_day: null }, AS_OF)).toBe(true);
  });

  it("does not count somebody who joins tomorrow", () => {
    expect(isOnRollAt({ date_of_join: "2026-08-01", last_working_day: null }, AS_OF)).toBe(false);
  });

  it("counts the last working day itself — they were at work that day", () => {
    expect(isOnRollAt({ date_of_join: "2020-01-01", last_working_day: AS_OF }, AS_OF)).toBe(true);
  });

  it("does not count somebody who left the day before", () => {
    expect(isOnRollAt({ date_of_join: "2020-01-01", last_working_day: "2026-07-30" }, AS_OF)).toBe(false);
  });

  it("does not count an offer with no agreed start date", () => {
    // The matview requires date_of_join IS NOT NULL; counting these would make
    // the snapshot and the trend differ by the number of unconfirmed offers.
    expect(isOnRollAt({ date_of_join: null, last_working_day: null }, AS_OF)).toBe(false);
  });
});

describe("onRollAt", () => {
  it("keeps only the on-roll rows and preserves their order", () => {
    const rows = [
      emp({ id: "a", employee_code: "TT-001" }),
      emp({ id: "b", employee_code: "TT-002", last_working_day: "2026-01-31" }),
      emp({ id: "c", employee_code: "TT-003", date_of_join: "2026-12-01" }),
      emp({ id: "d", employee_code: "TT-004" }),
    ];
    expect(onRollAt(rows, AS_OF).map((r) => r.id)).toEqual(["a", "d"]);
  });
});

// -----------------------------------------------------------------------------
// Calendar arithmetic
// -----------------------------------------------------------------------------

describe("completedMonths", () => {
  it("counts a whole month only on the anniversary day", () => {
    expect(completedMonths("2026-01-15", "2026-02-14")).toBe(0);
    expect(completedMonths("2026-01-15", "2026-02-15")).toBe(1);
  });

  it("crosses a year boundary", () => {
    expect(completedMonths("2025-11-30", "2026-07-31")).toBe(8);
    expect(completedMonths("2025-11-30", "2026-07-29")).toBe(7);
  });

  it("applies the month-end convention documented in the module", () => {
    // 31 Jan has no anniversary in February, so the first month completes on
    // 1 March. Off by at most one day, and never silently shifted.
    expect(completedMonths("2026-01-31", "2026-02-28")).toBe(0);
    expect(completedMonths("2026-01-31", "2026-03-01")).toBe(1);
  });

  it("is negative when the dates are the wrong way round", () => {
    expect(completedMonths("2026-08-01", "2026-07-31")).toBe(-1);
  });

  it("returns null for a malformed date rather than guessing", () => {
    expect(completedMonths("not-a-date", AS_OF)).toBeNull();
    expect(completedMonths(AS_OF, "2026-07")).toBeNull();
  });
});

describe("completedYears", () => {
  it("turns on the birthday, not on 1 January", () => {
    expect(completedYears("1990-06-15", "2026-06-14")).toBe(35);
    expect(completedYears("1990-06-15", "2026-06-15")).toBe(36);
  });
});

// -----------------------------------------------------------------------------
// Headcount breakdowns
// -----------------------------------------------------------------------------

describe("headcountBy", () => {
  const rows = [
    emp({ id: "a", department_id: "d1", department_name: "Kitchen" }),
    emp({ id: "b", department_id: "d1", department_name: "Kitchen" }),
    emp({ id: "c", department_id: "d2", department_name: "Banquet" }),
    emp({ id: "d", department_id: null, department_name: null }),
  ];

  it("keys departments on their id, so two departments of the same name stay apart", () => {
    const twins = [
      emp({ id: "a", department_id: "d1", department_name: "Service" }),
      emp({ id: "b", department_id: "d2", department_name: "Service" }),
    ];
    const out = headcountBy(twins, "department");
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.key).sort()).toEqual(["d1", "d2"]);
    expect(out.every((b) => b.label === "Service")).toBe(true);
  });

  it("orders biggest first and puts the unassigned bucket last", () => {
    expect(headcountBy(rows, "department")).toEqual([
      { key: "d1", label: "Kitchen", count: 2 },
      { key: "d2", label: "Banquet", count: 1 },
      { key: null, label: null, count: 1 },
    ]);
  });

  it("keeps the unassigned bucket rather than dropping it — the bars must sum to the headline", () => {
    const total = headcountBy(rows, "department").reduce((n, b) => n + b.count, 0);
    expect(total).toBe(rows.length);
  });

  it("keys the name-only dimensions on the name itself", () => {
    const mixed = [
      emp({ id: "a", designation_name: "Commis" }),
      emp({ id: "b", designation_name: "Sous Chef" }),
      emp({ id: "c", designation_name: "  " }),
    ];
    // A blank string is an absent value, not a bucket named "".
    expect(headcountBy(mixed, "designation")).toEqual([
      { key: "Commis", label: "Commis", count: 1 },
      { key: "Sous Chef", label: "Sous Chef", count: 1 },
      { key: null, label: null, count: 1 },
    ]);
  });
});

// -----------------------------------------------------------------------------
// Span of control
// -----------------------------------------------------------------------------

describe("spanOfControl", () => {
  it("returns nulls, not zeros, when nobody has a reportee", () => {
    const out = spanOfControl(people(4, () => ({})));
    expect(out.managers).toBe(0);
    expect(out.maxReportees).toBeNull();
    expect(out.spanOfControl).toBeNull();
    expect(out.meanReportees).toBeNull();
    expect(out.peopleWithoutAManager).toBe(4);
  });

  it("counts distinct reporting_manager_id — people WITH reportees, not role holders", () => {
    const rows = [
      emp({ id: "m1", employee_code: "TT-001" }),
      ...people(3, (i) => ({
        id: `r${String(i)}`,
        reporting_manager_id: "m1",
        reporting_manager_name: "Ravi Menon",
      })),
    ];
    const out = spanOfControl(rows);
    expect(out.managers).toBe(1);
    expect(out.peopleWithAManager).toBe(3);
    expect(out.peopleWithoutAManager).toBe(1);
    expect(out.spans[0]).toEqual({
      managerId: "m1",
      managerName: "Ravi Menon",
      reportees: 3,
      inScope: true,
    });
  });

  it("keeps a manager who sits outside the filtered set, flagged as such", () => {
    // Filter to one department: the reportees are in scope, their manager is not.
    const rows = people(2, () => ({ reporting_manager_id: "outsider", reporting_manager_name: "Meera Rao" }));
    const out = spanOfControl(rows);
    expect(out.managers).toBe(1);
    expect(out.spans[0]?.inScope).toBe(false);
  });

  it("keeps the manager's name when a later reportee carries none", () => {
    const rows = [
      emp({ id: "a", reporting_manager_id: "m1", reporting_manager_name: "Ravi Menon" }),
      emp({ id: "b", reporting_manager_id: "m1", reporting_manager_name: null }),
    ];
    expect(spanOfControl(rows).spans[0]?.managerName).toBe("Ravi Menon");
  });

  it("flags a span wider than the threshold — the 19-reportee finding", () => {
    const wide = people(19, () => ({ reporting_manager_id: "m1", reporting_manager_name: "Ravi Menon" }));
    const narrow = people(4, (i) => ({
      id: `n${String(i)}`,
      employee_code: `TT-9${String(i)}`,
      reporting_manager_id: "m2",
      reporting_manager_name: "Sunil Das",
    }));
    const out = spanOfControl([...wide, ...narrow]);
    expect(out.maxReportees).toBe(19);
    expect(out.managersOverThreshold).toBe(1);
    expect(WIDE_SPAN_THRESHOLD).toBe(10);
    // Widest first, so the finding is the first row of the table.
    expect(out.spans.map((s) => s.reportees)).toEqual([19, 4]);
  });

  it("separates the two spans: headcount per manager vs reportees per manager", () => {
    // 6 heads, 1 manager, 5 reportees, 1 person reporting to nobody.
    const rows = [
      emp({ id: "m1", employee_code: "TT-001" }),
      ...people(5, (i) => ({ id: `r${String(i)}`, reporting_manager_id: "m1" })),
    ];
    const out = spanOfControl(rows);
    expect(out.spanOfControl).toBe(6);
    expect(out.meanReportees).toBe(5);
  });
});

// -----------------------------------------------------------------------------
// Tenure and age bands
// -----------------------------------------------------------------------------

describe("tenureBandOf", () => {
  it("pins every boundary", () => {
    expect(tenureBandOf(0)).toBe("lt3m");
    expect(tenureBandOf(2)).toBe("lt3m");
    expect(tenureBandOf(3)).toBe("m3to12");
    expect(tenureBandOf(11)).toBe("m3to12");
    expect(tenureBandOf(12)).toBe("y1to3");
    expect(tenureBandOf(35)).toBe("y1to3");
    expect(tenureBandOf(36)).toBe("y3plus");
  });

  it("refuses a negative tenure rather than putting a future joiner in the first band", () => {
    expect(tenureBandOf(-1)).toBeNull();
  });
});

describe("ageBandOf", () => {
  it("pins every boundary", () => {
    expect(ageBandOf(24)).toBe("lt25");
    expect(ageBandOf(25)).toBe("a25to34");
    expect(ageBandOf(34)).toBe("a25to34");
    expect(ageBandOf(35)).toBe("a35to44");
    expect(ageBandOf(44)).toBe("a35to44");
    expect(ageBandOf(45)).toBe("a45to54");
    expect(ageBandOf(54)).toBe("a45to54");
    expect(ageBandOf(55)).toBe("a55plus");
  });
});

describe("tenureBands", () => {
  it("emits every band in order, zeros included, with the denominator", () => {
    const rows = [
      emp({ id: "a", date_of_join: "2026-07-01" }), // 1 month
      emp({ id: "b", date_of_join: "2026-01-31" }), // 6 months
      emp({ id: "c", date_of_join: "2024-07-31" }), // 24 months
      emp({ id: "d", date_of_join: "2019-01-01" }), // 90 months
    ];
    const out = tenureBands(rows, AS_OF);
    expect(out.bands.map((b) => b.band)).toEqual([...TENURE_BANDS]);
    expect(out.bands.map((b) => b.count)).toEqual([1, 1, 1, 1]);
    expect(out.denominator).toBe(4);
    expect(out.excluded).toBe(0);
  });

  it("excludes a row with no joining date instead of banding it", () => {
    const out = tenureBands([emp({ date_of_join: null })], AS_OF);
    expect(out.denominator).toBe(0);
    expect(out.excluded).toBe(1);
    expect(out.bands.every((b) => b.count === 0)).toBe(true);
  });
});

describe("ageBands", () => {
  it("counts only recorded birth dates and reports the excluded ones", () => {
    const rows = [
      emp({ id: "a", date_of_birth: "2005-01-01" }), // 21
      emp({ id: "b", date_of_birth: "1995-01-01" }), // 31
      emp({ id: "c", date_of_birth: null }),
      emp({ id: "d", date_of_birth: null }),
    ];
    const out = ageBands(rows, AS_OF);
    expect(out.bands.map((b) => b.band)).toEqual([...AGE_BANDS]);
    expect(out.bands.map((b) => b.count)).toEqual([1, 1, 0, 0, 0]);
    // The denominator is the whole point: a missing birth date is not an age.
    expect(out.denominator).toBe(2);
    expect(out.excluded).toBe(2);
  });

  it("does not divide by zero when nobody has a birth date", () => {
    const out = ageBands(people(3, () => ({ date_of_birth: null })), AS_OF);
    expect(out.denominator).toBe(0);
    expect(out.excluded).toBe(3);
  });
});

// -----------------------------------------------------------------------------
// Suppression (DPDP k-anonymity)
// -----------------------------------------------------------------------------

function bucket(key: string, count: number): HeadcountBucket {
  return { key, label: key, count };
}

describe("suppressSmallBuckets", () => {
  it("publishes everything when every bucket clears the floor", () => {
    const out = suppressSmallBuckets([bucket("a", 5), bucket("b", 3)]);
    expect(out.withheld).toBeNull();
    expect(out.kept.map((b) => b.key)).toEqual(["a", "b"]);
    expect(out.total).toBe(8);
  });

  it("withholds two buckets when only one is small — one alone is recoverable", () => {
    // Published 40 + 30, total 73: a lone withheld bucket of 3 is trivially
    // recovered by subtraction, so the smallest published bucket joins it.
    const out = suppressSmallBuckets([bucket("a", 40), bucket("b", 30), bucket("c", 2), bucket("d", 1)]);
    expect(out.kept.map((b) => b.key)).toEqual(["a", "b"]);
    expect(out.withheld).toEqual({ people: 3, buckets: 2 });
  });

  it("absorbs until the withheld group itself clears the floor", () => {
    // One bucket of 1 would leave a withheld group of 1 person — itself a
    // disclosure — so buckets are absorbed until the group holds at least 3.
    const out = suppressSmallBuckets([bucket("a", 20), bucket("b", 4), bucket("c", 1)]);
    expect(out.kept.map((b) => b.key)).toEqual(["a"]);
    expect(out.withheld).toEqual({ people: 5, buckets: 2 });
  });

  it("collapses a binary attribute entirely — the complement gives the answer away", () => {
    // 'yes: 2' against 'no: 198' with a headcount of 200 on the same screen
    // discloses the two people. Total suppression is the correct outcome.
    const out = suppressSmallBuckets([bucket("no", 198), bucket("yes", 2)]);
    expect(out.kept).toEqual([]);
    expect(out.withheld).toEqual({ people: 200, buckets: 2 });
  });

  it("never leaks a withheld label, only a headcount and a group count", () => {
    const out = suppressSmallBuckets([bucket("Indian", 40), bucket("Nepali", 2), bucket("Bhutanese", 1)]);
    expect(JSON.stringify(out.withheld)).not.toContain("Nepali");
    expect(out.withheld?.people).toBe(3);
  });

  it("reconciles: published + withheld always equals the total", () => {
    const buckets = [bucket("a", 9), bucket("b", 4), bucket("c", 2), bucket("d", 1)];
    const out = suppressSmallBuckets(buckets);
    const published = out.kept.reduce((n, b) => n + b.count, 0);
    expect(published + (out.withheld?.people ?? 0)).toBe(out.total);
    expect(out.total).toBe(16);
  });

  it("handles an empty attribute without inventing a withheld group", () => {
    expect(suppressSmallBuckets([])).toEqual({
      kept: [],
      withheld: null,
      total: 0,
      minBucket: MIN_PUBLISHABLE_BUCKET,
    });
  });
});

describe("diversityBreakdown", () => {
  it("treats a missing value as a real bucket, subject to the same floor", () => {
    const rows = [
      ...people(5, () => ({ gender: "female" })),
      ...people(4, (i) => ({ id: `m${String(i)}`, employee_code: `TT-1${String(i)}`, gender: "male" })),
      emp({ id: "x", employee_code: "TT-900", gender: null }),
    ];
    const out = diversityBreakdown(rows);
    expect(out.gender.total).toBe(10);
    // The lone null bucket is withheld, and takes 'male' with it.
    expect(out.gender.kept.map((b) => b.key)).toEqual(["female"]);
    expect(out.gender.withheld).toEqual({ people: 5, buckets: 2 });
  });

  it("buckets is_differently_abled as yes/no — the column is NOT NULL", () => {
    const rows = [
      ...people(6, () => ({ is_differently_abled: false })),
      ...people(3, (i) => ({ id: `y${String(i)}`, employee_code: `TT-2${String(i)}`, is_differently_abled: true })),
    ];
    const out = diversityBreakdown(rows);
    expect(out.differentlyAbled.kept.map((b) => b.key)).toEqual(["no", "yes"]);
    expect(out.differentlyAbled.withheld).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The whole snapshot
// -----------------------------------------------------------------------------

describe("aggregateWorkforce", () => {
  it("is all zeros and nulls on an empty roster, and reports what it read", () => {
    const out = aggregateWorkforce([], { asOfDate: AS_OF, onRollStatuses: ON_ROLL });
    expect(out.headcount).toBe(0);
    expect(out.rowsConsidered).toBe(0);
    expect(out.span.spanOfControl).toBeNull();
    expect(out.age.denominator).toBe(0);
    expect(out.byDepartment).toEqual([]);
  });

  it("counts only the on-roll rows but reports how many it considered", () => {
    const rows = [
      emp({ id: "a", employee_code: "TT-001" }),
      emp({ id: "b", employee_code: "TT-002", last_working_day: "2026-03-31" }),
      emp({ id: "c", employee_code: "TT-003", date_of_join: "2026-09-01" }),
    ];
    const out = aggregateWorkforce(rows, { asOfDate: AS_OF, onRollStatuses: ON_ROLL });
    expect(out.headcount).toBe(1);
    expect(out.rowsConsidered).toBe(3);
  });

  it("flags an exit recorded without a last working day as a mis-stated record", () => {
    // The row passes the as-at test (no leaving date) but says 'exited'. This
    // is exactly why the panel's headcount can differ from a status-based one.
    const rows = [
      emp({ id: "a", employee_code: "TT-001" }),
      emp({ id: "b", employee_code: "TT-002", employment_status: "exited", last_working_day: null }),
    ];
    const out = aggregateWorkforce(rows, { asOfDate: AS_OF, onRollStatuses: ON_ROLL });
    expect(out.headcount).toBe(2);
    expect(out.statusAnomalies).toBe(1);
  });

  it("makes every breakdown add up to the headcount", () => {
    const rows = [
      ...people(4, () => ({ department_id: "d1", department_name: "Kitchen" })),
      ...people(3, (i) => ({
        id: `b${String(i)}`,
        employee_code: `TT-3${String(i)}`,
        department_id: null,
        department_name: null,
        grade_name: null,
      })),
    ];
    const out = aggregateWorkforce(rows, { asOfDate: AS_OF, onRollStatuses: ON_ROLL });
    const sum = (bs: readonly HeadcountBucket[]): number => bs.reduce((n, b) => n + b.count, 0);
    expect(out.headcount).toBe(7);
    for (const bs of [out.byDepartment, out.byDesignation, out.byGrade, out.byLocation, out.byEmploymentType]) {
      expect(sum(bs)).toBe(7);
    }
    // Tenure is total by construction: the as-at test requires a joining date.
    expect(out.tenure.denominator + out.tenure.excluded).toBe(7);
  });
});

// -----------------------------------------------------------------------------
// The trend
// -----------------------------------------------------------------------------

describe("aggregateHeadcountTrend", () => {
  const day = (as_of_date: string, headcount: number, joiners = 0, exits = 0): HeadcountDailyRow => ({
    as_of_date,
    headcount,
    joiners,
    exits,
  });

  it("sums the matview's department × employment-type rows for a date", () => {
    const rows = [day("2026-07-01", 30, 1), day("2026-07-01", 12, 0, 2), day("2026-07-01", 8)];
    const point = aggregateHeadcountTrend(rows, { granularity: "day", from: "2026-07-01", to: "2026-07-01" })[0];
    expect(point).toEqual({
      asOfDate: "2026-07-01",
      isEmpty: false,
      headcount: 50,
      joiners: 1,
      exits: 2,
      rowsSummed: 3,
    });
  });

  it("emits one point per day of the period", () => {
    const out = aggregateHeadcountTrend([day("2026-07-01", 10)], monthPeriod);
    expect(out).toHaveLength(31);
    expect(out[0]?.asOfDate).toBe("2026-07-01");
    expect(out[30]?.asOfDate).toBe("2026-07-31");
  });

  it("draws a date the matview does not cover as a GAP, never as zero", () => {
    // A zero here would render the venue losing its whole workforce overnight.
    const out = aggregateHeadcountTrend([day("2026-07-01", 40)], monthPeriod);
    expect(out[1]).toEqual({
      asOfDate: "2026-07-02",
      isEmpty: true,
      headcount: null,
      joiners: null,
      exits: null,
      rowsSummed: 0,
    });
  });

  it("appends a stray date rather than hiding a row that is counted elsewhere", () => {
    const out = aggregateHeadcountTrend([day("2026-08-05", 40)], monthPeriod);
    expect(out).toHaveLength(32);
    expect(out[31]?.asOfDate).toBe("2026-08-05");
    expect(out[31]?.headcount).toBe(40);
  });

  it("returns nothing for an inverted period rather than looping", () => {
    expect(aggregateHeadcountTrend([], { granularity: "range", from: "2026-07-31", to: "2026-07-01" })).toEqual([]);
  });
});
