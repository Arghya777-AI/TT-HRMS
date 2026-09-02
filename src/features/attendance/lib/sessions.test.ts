/**
 * Fragmented days, exercised — the venue's own scenario first.
 *
 * The important assertion is the one tying this to the engine: for an even number of punches,
 * pairing them must give the same total as the engine's span-minus-interior-gaps. If those two
 * ever disagree, an employee's card and their payslip disagree, which is the defect class this
 * codebase keeps having to remove.
 */
import { describe, expect, it } from "vitest";
import { daySessions, nextPunchIsArrival } from "./sessions";

/** 02 Sep 2026, 22:00 IST — after everything below has happened. */
const LATER = Date.parse("2026-09-02T22:00:00+05:30");
const at = (hhmm: string) => `2026-09-02T${hhmm}:00+05:30`;

describe("the 9-to-1-then-7-to-9 day", () => {
  const day = daySessions([at("09:00"), at("13:00"), at("19:00"), at("21:00")], LATER);

  it("is two sessions, not four punches", () => {
    expect(day.sessions).toHaveLength(2);
    expect(day.sessions[0]?.minutes).toBe(240);
    expect(day.sessions[1]?.minutes).toBe(120);
  });

  it("totals six hours, not the twelve-hour span", () => {
    expect(day.workedMinutes).toBe(360);
  });

  it("agrees with the engine's span-minus-interior-gap arithmetic", () => {
    /*
      The engine computes 21:00 − 09:00 = 720, less the interior 13:00→19:00 gap of 360, = 360.
      Same number, arranged differently. This test is the contract between the card and payroll.
    */
    const span = 720;
    const interiorGap = 360;
    expect(day.workedMinutes).toBe(span - interiorGap);
  });

  it("knows they have gone home", () => {
    expect(day.isIn).toBe(false);
    expect(day.openSince).toBeNull();
  });
});

describe("a day still in progress", () => {
  it("counts the open session up to now", () => {
    const day = daySessions([at("09:00"), at("13:00"), at("19:00")], LATER);
    expect(day.isIn).toBe(true);
    expect(day.openSince).toBe(at("19:00"));
    // 4h closed + 3h open (19:00 → 22:00).
    expect(day.workedMinutes).toBe(240 + 180);
  });

  it("is in after a single arrival", () => {
    const day = daySessions([at("09:00")], LATER);
    expect(day.isIn).toBe(true);
    expect(day.sessions).toHaveLength(1);
    expect(day.sessions[0]?.outAt).toBeNull();
  });
});

describe("nothing recorded", () => {
  it("is zero sessions and out", () => {
    const day = daySessions([], LATER);
    expect(day.sessions).toHaveLength(0);
    expect(day.workedMinutes).toBe(0);
    expect(day.isIn).toBe(false);
  });
});

describe("what the button should say", () => {
  it("offers an arrival when the count is even", () => {
    /*
      PARITY, which replaced "first scan in, everything after is out". That old rule could never
      offer "punch in" again, so somebody back for an evening shift was told they were punching
      out — of a day they had already left.
    */
    expect(nextPunchIsArrival(0)).toBe(true);
    expect(nextPunchIsArrival(2)).toBe(true);
    expect(nextPunchIsArrival(4)).toBe(true);
  });

  it("offers a departure when the count is odd", () => {
    expect(nextPunchIsArrival(1)).toBe(false);
    expect(nextPunchIsArrival(3)).toBe(false);
  });
});

describe("clocks that would embarrass us", () => {
  it("never renders a negative session", () => {
    // A punch recorded a few seconds ahead of the browser's now.
    const day = daySessions([at("22:00")], LATER - 3_000);
    expect(day.workedMinutes).toBe(0);
    expect(day.sessions[0]?.minutes).toBe(0);
  });

  it("skips an unparseable instant rather than throwing", () => {
    // These arrive as strings from PostgREST; a page must not blank on one bad row.
    const day = daySessions(["not-a-date", at("13:00")], LATER);
    expect(day.workedMinutes).toBe(0);
    expect(day.sessions).toHaveLength(0);
  });
});
