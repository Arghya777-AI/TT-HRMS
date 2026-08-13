/**
 * The window walk, tested where it is cheapest to get wrong.
 *
 * `fillWindow` is what makes a gap mean one thing. If it skips a date, that day
 * silently vanishes from the chart; if it invents one, a bar appears for a day
 * nobody recorded. Both are the misinformation the day-run chart was declined
 * over in the first place, so the walk is worth pinning down — month ends, leap
 * years and the turn of the year included.
 *
 * It walks civil date STRINGS on purpose. Dates here are 'YYYY-MM-DD' business
 * dates in IST, and the moment one goes through a UTC `Date` a window can gain
 * or lose its first day depending on the hour the browser happens to run.
 */
import { describe, expect, it } from "vitest";
import { byEmployee, fillWindow, type TeamDayPoint } from "./day-series.api";

function point(employee: string, date: string, minutes = 480): TeamDayPoint {
  return {
    employee_id: employee,
    ist_date: date,
    status: "present",
    day_fraction_paid: 1,
    worked_minutes: minutes,
  };
}

describe("fillWindow", () => {
  it("returns one entry per day of the window, inclusive of both ends", () => {
    const filled = fillWindow([], "2026-08-01", "2026-08-05");
    expect(filled.map((f) => f.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
  });

  it("marks a day with no record as null, not as zero", () => {
    /*
      THE WHOLE REASON THIS FUNCTION EXISTS. A day nobody recorded must be
      distinguishable from a day worked to nothing, and only an explicit null
      can carry that.
    */
    const filled = fillWindow([point("e1", "2026-08-02")], "2026-08-01", "2026-08-03");
    expect(filled[0]?.point).toBeNull();
    expect(filled[1]?.point?.worked_minutes).toBe(480);
    expect(filled[2]?.point).toBeNull();
  });

  it("crosses a month end", () => {
    const dates = fillWindow([], "2026-01-30", "2026-02-02").map((f) => f.date);
    expect(dates).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });

  it("knows February in a common year", () => {
    const dates = fillWindow([], "2026-02-27", "2026-03-01").map((f) => f.date);
    expect(dates).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });

  it("knows February in a leap year", () => {
    const dates = fillWindow([], "2028-02-27", "2028-03-01").map((f) => f.date);
    expect(dates).toEqual(["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"]);
  });

  it("knows 1900 was not a leap year and 2000 was", () => {
    expect(fillWindow([], "1900-02-28", "1900-03-01").map((f) => f.date)).toEqual([
      "1900-02-28",
      "1900-03-01",
    ]);
    expect(fillWindow([], "2000-02-28", "2000-03-01").map((f) => f.date)).toEqual([
      "2000-02-28",
      "2000-02-29",
      "2000-03-01",
    ]);
  });

  it("crosses a year end", () => {
    const dates = fillWindow([], "2026-12-30", "2027-01-02").map((f) => f.date);
    expect(dates).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });

  it("returns a single day when the window is one day", () => {
    expect(fillWindow([], "2026-08-13", "2026-08-13").map((f) => f.date)).toEqual(["2026-08-13"]);
  });

  it("returns nothing when the range is inverted rather than looping", () => {
    expect(fillWindow([], "2026-08-13", "2026-08-01")).toEqual([]);
  });

  it("is bounded, so a wild range cannot spin", () => {
    // The guard caps the walk; what matters is that it terminates.
    expect(fillWindow([], "2026-01-01", "2099-01-01").length).toBeLessThanOrEqual(400);
  });
});

describe("byEmployee", () => {
  it("groups without aggregating", () => {
    const grouped = byEmployee([
      point("e1", "2026-08-01"),
      point("e2", "2026-08-01"),
      point("e1", "2026-08-02", 300),
    ]);
    expect(grouped.get("e1")?.length).toBe(2);
    expect(grouped.get("e2")?.length).toBe(1);
    // The points are the server's; nothing is summed or averaged on the way.
    expect(grouped.get("e1")?.[1]?.worked_minutes).toBe(300);
  });

  it("has no entry for an employee with no records", () => {
    expect(byEmployee([point("e1", "2026-08-01")]).get("e2")).toBeUndefined();
  });
});
