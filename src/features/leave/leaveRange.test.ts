/**
 * Tests for leaveRange.
 *
 * The cases that matter are the ones the old single-date screen got wrong: a range spanning a
 * weekly off, and an allocation that does not match what the range actually costs. The
 * `WO-SUN-ALTSAT` shape is used deliberately — Sunday AND an alternate Saturday free — because
 * it is the rule a browser reimplementation would have got wrong, and these tests prove this
 * module never tries to derive it, only to read the server's answer.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_RANGE_DAYS,
  countedDatesOf,
  freeDayReason,
  rangeMismatch,
  rangeProblem,
  splitAllocationsAcrossDates,
  summariseRange,
} from "./leaveRange";
import type { CountableDate } from "./api/leave-apply.api";

function day(
  leave_date: string,
  opts: { off?: boolean; holiday?: string } = {},
): CountableDate {
  const off = opts.off ?? false;
  const holiday = opts.holiday ?? null;
  return {
    leave_date,
    is_weekly_off: off,
    is_holiday: holiday !== null,
    holiday_name: holiday,
    would_count: !off && holiday === null,
    day_value: !off && holiday === null ? 1 : 0,
    type_dependent: off || holiday !== null,
  };
}

describe("summariseRange", () => {
  it("counts only the dates the server said would count", () => {
    // The live WO-SUN-ALTSAT answer for TT0013, 1–8 Aug 2026: 8 days chosen, 6 counted.
    const summary = summariseRange([
      day("2026-08-01"),
      day("2026-08-02", { off: true }),
      day("2026-08-03"),
      day("2026-08-04"),
      day("2026-08-05"),
      day("2026-08-06"),
      day("2026-08-07"),
      day("2026-08-08", { off: true }),
    ]);
    expect(summary.countedDays).toBe(6);
    expect(summary.freeDays).toBe(2);
    expect(summary.weeklyOffs).toBe(2);
    expect(summary.holidays).toBe(0);
  });

  it("separates holidays from weekly offs", () => {
    const summary = summariseRange([
      day("2026-08-14"),
      day("2026-08-15", { holiday: "Independence Day" }),
      day("2026-08-16", { off: true }),
    ]);
    expect(summary.countedDays).toBe(1);
    expect(summary.weeklyOffs).toBe(1);
    expect(summary.holidays).toBe(1);
  });

  it("an empty range costs nothing and claims nothing", () => {
    const summary = summariseRange([]);
    expect(summary.countedDays).toBe(0);
    expect(summary.freeDays).toBe(0);
  });

  it("keeps the dates in the order the server returned them", () => {
    const dates = [day("2026-08-03"), day("2026-08-04"), day("2026-08-05")];
    expect(summariseRange(dates).dates.map((d) => d.leave_date)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
  });

  it("counts every date when nobody has a weekly-off rule assigned", () => {
    // Live behaviour for an employee with weekly_off_rule_id NULL: the engine treats them as
    // working, so the preview must too rather than inventing a Sunday off.
    const summary = summariseRange([
      day("2026-08-01"),
      day("2026-08-02"),
      day("2026-08-03"),
    ]);
    expect(summary.countedDays).toBe(3);
    expect(summary.weeklyOffs).toBe(0);
  });
});

describe("freeDayReason", () => {
  it("is null for a day that costs leave", () => {
    expect(freeDayReason(day("2026-08-03"))).toBeNull();
  });

  it("names a weekly off", () => {
    expect(freeDayReason(day("2026-08-02", { off: true }))).toBe("weekly_off");
  });

  it("names a holiday", () => {
    expect(freeDayReason(day("2026-08-15", { holiday: "Independence Day" }))).toBe("holiday");
  });

  it("reports a holiday falling on a weekly off as the weekly off", () => {
    // Both flags true. Showing "holiday" would imply a holiday was consumed; the employee was
    // not working that day either way.
    const both: CountableDate = {
      leave_date: "2026-08-02",
      is_weekly_off: true,
      is_holiday: true,
      holiday_name: "Some Feast",
      would_count: false,
      day_value: 0,
      type_dependent: true,
    };
    expect(freeDayReason(both)).toBe("weekly_off");
  });
});

describe("rangeProblem", () => {
  it("passes a normal range", () => {
    expect(rangeProblem("2026-08-01", "2026-08-05")).toBeNull();
  });

  it("passes a single day", () => {
    expect(rangeProblem("2026-08-01", "2026-08-01")).toBeNull();
  });

  it("refuses an inverted range", () => {
    expect(rangeProblem("2026-08-05", "2026-08-01")).toEqual({ kind: "inverted" });
  });

  it("refuses a missing date", () => {
    expect(rangeProblem("", "2026-08-01")).toEqual({ kind: "incomplete" });
    expect(rangeProblem("2026-08-01", "")).toEqual({ kind: "incomplete" });
  });

  it("refuses a range longer than the server will preview", () => {
    // Caught here so the employee never reads the function's own 22023.
    const problem = rangeProblem("2026-01-01", "2027-12-31");
    expect(problem?.kind).toBe("tooLong");
    expect(problem && "days" in problem ? problem.days : 0).toBeGreaterThan(MAX_RANGE_DAYS);
  });

  it("allows exactly the maximum", () => {
    // 2026-01-01 → 2026-12-31 inclusive is 365 days; 2027-01-01 makes it 366.
    expect(rangeProblem("2026-01-01", "2027-01-01")).toBeNull();
  });
});

describe("rangeMismatch", () => {
  it("is silent before anything is allocated", () => {
    expect(rangeMismatch(3, 0)).toBeNull();
  });

  it("is silent when the allocation matches the counted days", () => {
    expect(rangeMismatch(6, 6)).toBeNull();
  });

  it("allows half of a single counted day", () => {
    expect(rangeMismatch(1, 0.5)).toBeNull();
  });

  it("flags allocating more than the range costs", () => {
    // The real failure the old screen produced: 3 days asked for over a range worth 2.
    expect(rangeMismatch(2, 3)).toEqual({ kind: "allocatedMore", counted: 2, allocated: 3 });
  });

  it("flags allocating less than the range costs", () => {
    expect(rangeMismatch(6, 4)).toEqual({ kind: "allocatedLess", counted: 6, allocated: 4 });
  });

  it("does not excuse a half day across a multi-day range", () => {
    // 0.5 over a 3-day range is not the half-day case — the server would stamp 3.
    expect(rangeMismatch(3, 0.5)).toEqual({ kind: "allocatedLess", counted: 3, allocated: 0.5 });
  });
});

describe("splitAllocationsAcrossDates", () => {
  const week = ["2026-08-03", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-10"];

  it("gives disjoint dates to each type, in the order allocated", () => {
    // The point of the whole exercise: `leave_requests_no_overlap` refuses two requests whose
    // date ranges touch, so 2 days of EL + 1 of MRL must be *these* dates and *that* date.
    const { segments, problem } = splitAllocationsAcrossDates(week.slice(0, 3), [
      { typeId: "EL", days: 2 },
      { typeId: "MRL", days: 1 },
    ]);
    expect(problem).toBeNull();
    expect(segments).toEqual([
      {
        typeId: "EL",
        fromDate: "2026-08-03",
        toDate: "2026-08-05",
        portion: "full_day",
        expectedDays: 2,
      },
      {
        typeId: "MRL",
        fromDate: "2026-08-06",
        toDate: "2026-08-06",
        portion: "full_day",
        expectedDays: 1,
      },
    ]);
  });

  it("never produces overlapping ranges", () => {
    const { segments } = splitAllocationsAcrossDates(week, [
      { typeId: "EL", days: 2 },
      { typeId: "MRL", days: 2 },
      { typeId: "CO", days: 1 },
    ]);
    for (let i = 1; i < segments.length; i += 1) {
      const previous = segments[i - 1];
      const current = segments[i];
      expect(previous && current && current.fromDate > previous.toDate).toBe(true);
    }
  });

  it("spans a free day inside a segment rather than consuming it", () => {
    // 4th is a weekly off and is not in the counted list, so a 2-day EL segment reaches from
    // the 3rd to the 5th — three calendar days, two chargeable, which is what the engine
    // prices. This is the behaviour the whole feature is about.
    const { segments } = splitAllocationsAcrossDates(["2026-08-03", "2026-08-05"], [
      { typeId: "EL", days: 2 },
    ]);
    expect(segments[0]?.fromDate).toBe("2026-08-03");
    expect(segments[0]?.toDate).toBe("2026-08-05");
    expect(segments[0]?.expectedDays).toBe(2);
  });

  it("splits a half day off into its own single-date segment", () => {
    // The engine honours `portion` only when from = to, so 2.5 days of one type is a 2-day
    // full request plus a 1-day half request — not a 3-day range stamped as 3.
    const { segments } = splitAllocationsAcrossDates(week, [{ typeId: "EL", days: 2.5 }]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ portion: "full_day", expectedDays: 2 });
    expect(segments[1]).toMatchObject({
      portion: "first_half",
      fromDate: "2026-08-06",
      toDate: "2026-08-06",
      expectedDays: 0.5,
    });
    expect(segments.reduce((sum, s) => sum + s.expectedDays, 0)).toBe(2.5);
  });

  it("gives a lone half day one date", () => {
    const { segments } = splitAllocationsAcrossDates(["2026-08-03"], [{ typeId: "SL", days: 0.5 }]);
    expect(segments).toEqual([
      {
        typeId: "SL",
        fromDate: "2026-08-03",
        toDate: "2026-08-03",
        portion: "first_half",
        expectedDays: 0.5,
      },
    ]);
  });

  it("refuses two half days of different types on one counted date", () => {
    // Reachable, not defensive: 0.5 + 0.5 is one day of leave but needs TWO dates, because a
    // date cannot carry two requests past the overlap guard.
    const { segments, problem } = splitAllocationsAcrossDates(["2026-08-03"], [
      { typeId: "MRL", days: 0.5 },
      { typeId: "EL", days: 0.5 },
    ]);
    expect(segments).toEqual([]);
    expect(problem).toEqual({ kind: "notEnoughDates", datesNeeded: 2, datesAvailable: 1 });
  });

  it("refuses an allocation longer than the counted dates", () => {
    const { problem } = splitAllocationsAcrossDates(["2026-08-03", "2026-08-05"], [
      { typeId: "EL", days: 3 },
    ]);
    expect(problem).toEqual({ kind: "notEnoughDates", datesNeeded: 3, datesAvailable: 2 });
  });

  it("ignores types allocated zero days", () => {
    const { segments } = splitAllocationsAcrossDates(week, [
      { typeId: "EL", days: 1 },
      { typeId: "MRL", days: 0 },
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.typeId).toBe("EL");
  });

  it("returns nothing for no allocation at all", () => {
    expect(splitAllocationsAcrossDates(week, [])).toEqual({ segments: [], problem: null });
  });
});

describe("countedDatesOf", () => {
  it("keeps only the chargeable dates, in order", () => {
    expect(
      countedDatesOf([
        day("2026-08-03"),
        day("2026-08-04", { off: true }),
        day("2026-08-05"),
        day("2026-08-06", { holiday: "Onam" }),
      ]),
    ).toEqual(["2026-08-03", "2026-08-05"]);
  });
});
