/**
 * The precedence is the whole point of these tests.
 *
 * A day can carry BOTH a hand override and a regularisation link, and which one the
 * calendar shows decides whether the employee sees "corrected on your request" — a
 * thing they asked for — or "set by HR" — a thing done to their record. Getting that
 * backwards would misattribute the change while looking entirely plausible on screen.
 */
import { describe, expect, it } from "vitest";
import { dayRecordedBy, type DayProvenance } from "./dayRecordedBy";

const day = (over: Partial<DayProvenance> = {}): DayProvenance => ({
  manual_override_status: false,
  manual_override_times: false,
  is_regularized: false,
  punch_count: 0,
  ...over,
});

describe("dayRecordedBy", () => {
  it("attributes a scanned day to the employee", () => {
    expect(dayRecordedBy(day({ punch_count: 2 }))).toBe("self");
  });

  it("attributes a hand-set status to HR", () => {
    expect(dayRecordedBy(day({ manual_override_status: true }))).toBe("hr_override");
  });

  it("treats overridden TIMES as a hand too, not just an overridden status", () => {
    // Editing the in/out times rewrites the hours the day pays on, so it is every
    // bit as much a human decision as changing the status word.
    expect(dayRecordedBy(day({ manual_override_times: true, punch_count: 2 }))).toBe(
      "hr_override",
    );
  });

  it("marks an approved regularisation as corrected, not as a plain punch", () => {
    // The approval created system_regularization punches, so punch_count is > 0 and
    // a naive check would call this the employee's own scan.
    expect(dayRecordedBy(day({ is_regularized: true, punch_count: 2 }))).toBe("corrected");
  });

  it("ranks a hand override above a correction when a day carries both", () => {
    expect(
      dayRecordedBy(day({ is_regularized: true, manual_override_status: true, punch_count: 2 })),
    ).toBe("hr_override");
  });

  it("claims no author for a day nobody recorded", () => {
    // A weekly off, a holiday, or an absence that is simply the absence of punches.
    expect(dayRecordedBy(day())).toBe("none");
    expect(dayRecordedBy(null)).toBe("none");
  });

  it("does not read a null override column as an override", () => {
    // Both columns are nullable in the row schema; null means "not overridden".
    expect(
      dayRecordedBy(day({ manual_override_status: null, manual_override_times: null, punch_count: 1 })),
    ).toBe("self");
  });
});
