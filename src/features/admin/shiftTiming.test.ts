/**
 * Shift window arithmetic, pinned against `shifts_before_write()`.
 *
 * `shifts.duration_minutes` is NOT NULL with no default, so a screen that creates a shift
 * MUST compute the same number the trigger would. The edge case worth a test is the one a
 * second implementation always gets wrong: a window whose end equals its start is a FULL
 * DAY, not zero minutes.
 */
import { describe, expect, it } from "vitest";
import {
  minutesOfTime,
  paidDurationMinutes,
  shiftWindowProblem,
  wallSpanMinutes,
} from "./shiftTiming";

describe("minutesOfTime", () => {
  it("reads HH:MM", () => {
    expect(minutesOfTime("09:30")).toBe(570);
  });

  it("reads the HH:MM:SS Postgres hands back", () => {
    expect(minutesOfTime("09:30:00")).toBe(570);
  });

  it("reads a single-digit hour", () => {
    expect(minutesOfTime("9:05")).toBe(545);
  });

  it("refuses nonsense rather than guessing", () => {
    expect(minutesOfTime("half nine")).toBeNull();
    expect(minutesOfTime("")).toBeNull();
    expect(minutesOfTime(undefined)).toBeNull();
    expect(minutesOfTime("25:00")).toBeNull();
    expect(minutesOfTime("09:60")).toBeNull();
  });
});

describe("wallSpanMinutes", () => {
  it("measures an ordinary day", () => {
    // The venue's General shift.
    expect(wallSpanMinutes("09:30", "18:30")).toBe(540);
  });

  it("measures an overnight window without needing to be told it crosses midnight", () => {
    // The Security night post.
    expect(wallSpanMinutes("19:00", "07:00")).toBe(720);
  });

  it("treats an identical start and end as a FULL DAY, not zero", () => {
    expect(wallSpanMinutes("06:00", "06:00")).toBe(1440);
  });

  it("is null when either end will not parse", () => {
    expect(wallSpanMinutes("09:30", "nope")).toBeNull();
    expect(wallSpanMinutes("", "18:30")).toBeNull();
  });
});

describe("paidDurationMinutes", () => {
  it("subtracts the unpaid break — this is the column the trigger writes", () => {
    // 09:30–18:30 is 540 wall minutes; an hour unpaid leaves the 480 the venue uses.
    expect(paidDurationMinutes("09:30", "18:30", 60)).toBe(480);
  });

  it("equals the span when nothing is unpaid", () => {
    expect(paidDurationMinutes("09:30", "18:30", 0)).toBe(540);
  });

  it("carries the full-day rule through", () => {
    expect(paidDurationMinutes("06:00", "06:00", 60)).toBe(1380);
  });

  it("is null rather than a fabricated number when the window is unusable", () => {
    expect(paidDurationMinutes("x", "y", 0)).toBeNull();
  });
});

describe("shiftWindowProblem", () => {
  it("passes a real window", () => {
    expect(shiftWindowProblem("09:30", "18:30", 60)).toBeNull();
  });

  it("names an unparseable window", () => {
    expect(shiftWindowProblem("nope", "18:30", 0)).toBe("unparseable");
  });

  it("refuses a break that swallows the shift", () => {
    // 2-hour window, 3-hour break: arithmetic, not a shift. ck_shifts__duration would
    // refuse it at the database; this turns a constraint name into a sentence.
    expect(shiftWindowProblem("09:00", "11:00", 180)).toBe("non_positive");
  });

  it("refuses a break exactly as long as the window", () => {
    expect(shiftWindowProblem("09:00", "11:00", 120)).toBe("non_positive");
  });
});
