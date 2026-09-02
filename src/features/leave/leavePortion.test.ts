/**
 * Half day or full day — the distinction four calendars were not making.
 *
 * The interesting case is the one that makes this a module instead of a ternary: on a rostered
 * weekly off, `portion` and `day_value` disagree. A half-day request there is stored as
 * `first_half` with `day_value = 0.000`, because `count_weekly_off_as_leave` is false for the
 * type — the SHAPE is half a day, the COST is nothing. Two screens reading two different fields
 * would show two different answers for one row.
 */
import { describe, expect, it } from "vitest";
import { isHalfDay, portionShort, portionText } from "./leavePortion";

describe("isHalfDay", () => {
  it("is true for either half", () => {
    expect(isHalfDay("first_half")).toBe(true);
    expect(isHalfDay("second_half")).toBe(true);
  });

  it("is false for a full day", () => {
    expect(isHalfDay("full_day")).toBe(false);
  });

  it("treats an unknown portion as a full day rather than throwing", () => {
    /*
      `portion` arrives as a plain string from `v_leave_calendar`. A calendar must render
      whatever the database holds — an unrecognised value is a display problem, never a crash on a
      page an admin is reading.
    */
    expect(isHalfDay("")).toBe(false);
    expect(portionText("something_new")).toBe("Full day");
  });
});

describe("what the reader sees", () => {
  it("names which half, because that decides whether they are in this afternoon", () => {
    expect(portionText("first_half")).toContain("first half");
    expect(portionText("second_half")).toContain("second half");
    expect(portionText("full_day")).toBe("Full day");
  });

  it("has a short form for a dense grid", () => {
    expect(portionShort("first_half")).toBe("Half day");
    expect(portionShort("second_half")).toBe("Half day");
    expect(portionShort("full_day")).toBe("Full day");
  });
});

describe("it reads `portion`, never `day_value`", () => {
  it("still calls a zero-cost half day a half day", () => {
    /*
      THE WEEKLY-OFF CASE. day_value is 0.000 and the person is still only away for half the
      day. Reading day_value would report "Full day" — the exact opposite of the truth — so the
      helper takes portion alone and this test pins that choice.
    */
    expect(isHalfDay("first_half")).toBe(true);
    expect(portionShort("first_half")).toBe("Half day");
  });
});
