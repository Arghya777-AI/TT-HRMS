/**
 * weekOffSuggestion.test.ts — the 15th rule, and a suggestion that never over-grants.
 *
 * The venue gave the reference-month rule by example, including the awkward one
 * ("if I'm doing in August thirty first also, then it will suggest the current
 * month"), so those examples are the tests.
 */
import { describe, expect, it } from "vitest";

import {
  REFERENCE_CUTOVER_DAY,
  STANDARD_DAY_MINUTES,
  referenceMonth,
  suggestWeekOffs,
  suggestionsByEmployee,
} from "./weekOffSuggestion";

describe("referenceMonth", () => {
  it("before the 15th, reads the month that just ended", () => {
    // The venue's own example: filling in September suggests August.
    expect(referenceMonth("2026-09-01")).toMatchObject({ year: 2026, month: 8, label: "August 2026" });
    expect(referenceMonth("2026-09-14")).toMatchObject({ year: 2026, month: 8 });
  });

  it("from the 15th, reads the month you are in", () => {
    expect(referenceMonth("2026-09-15")).toMatchObject({ year: 2026, month: 9, label: "September 2026" });
    expect(referenceMonth("2026-09-30")).toMatchObject({ year: 2026, month: 9 });
  });

  it("on 31 August suggests August, not July", () => {
    /* Stated explicitly by the venue, and the case a naive "always previous month"
       rule would get wrong. */
    expect(referenceMonth("2026-08-31")).toMatchObject({ year: 2026, month: 8, isCurrentMonth: true });
  });

  it("rolls the year back in early January", () => {
    expect(referenceMonth("2027-01-05")).toMatchObject({ year: 2026, month: 12, label: "December 2026" });
  });

  it("stays in January from the 15th", () => {
    expect(referenceMonth("2027-01-20")).toMatchObject({ year: 2027, month: 1, label: "January 2027" });
  });

  it("says whether the month is the current one, so the sheet can explain itself", () => {
    expect(referenceMonth("2026-09-02").isCurrentMonth).toBe(false);
    expect(referenceMonth("2026-09-20").isCurrentMonth).toBe(true);
  });

  it("switches exactly on the cutover day and not a day either side", () => {
    const before = referenceMonth(`2026-09-${String(REFERENCE_CUTOVER_DAY - 1).padStart(2, "0")}`);
    const on = referenceMonth(`2026-09-${String(REFERENCE_CUTOVER_DAY).padStart(2, "0")}`);
    expect(before.month).toBe(8);
    expect(on.month).toBe(9);
  });
});

describe("suggestWeekOffs", () => {
  it("suggests one day for one day of rest-day work", () => {
    expect(suggestWeekOffs(STANDARD_DAY_MINUTES)).toBe(1);
  });

  it("suggests a half day for half a day", () => {
    expect(suggestWeekOffs(240)).toBe(0.5);
  });

  it("FLOORS to the half day rather than rounding up", () => {
    /*
      An over-grant is worse than an under-grant: an administrator can raise a
      number by hand, but nobody agreed to a rounding rule that hands out days.

      The values, worked out rather than guessed — I got two of these wrong by
      eye before checking:
        910 min = 1.896 days -> 1.5
        719 min = 1.498 days -> 1.0   (just under the 1.5 step)
        479 min = 0.998 days -> 0.5   (just under a full day, but over a half)
        239 min = 0.498 days -> 0
    */
    expect(suggestWeekOffs(910)).toBe(1.5);
    expect(suggestWeekOffs(719)).toBe(1);
    expect(suggestWeekOffs(479)).toBe(0.5);
    expect(suggestWeekOffs(239)).toBe(0);
  });

  it("suggests nothing for no extra work", () => {
    expect(suggestWeekOffs(0)).toBe(0);
  });

  it("suggests nothing for a negative figure rather than a negative day", () => {
    expect(suggestWeekOffs(-480)).toBe(0);
  });

  it("copes with a nonsense day length instead of dividing by zero", () => {
    expect(suggestWeekOffs(480, 0)).toBe(0);
    expect(suggestWeekOffs(480, Number.NaN)).toBe(0);
  });

  it("follows a venue with a different day length", () => {
    // A 9-hour day: 540 minutes earns one day, 480 earns a half.
    expect(suggestWeekOffs(540, 540)).toBe(1);
    expect(suggestWeekOffs(480, 540)).toBe(0.5);
  });

  it("scales past a single day", () => {
    expect(suggestWeekOffs(STANDARD_DAY_MINUTES * 3)).toBe(3);
  });
});

describe("suggestionsByEmployee", () => {
  it("keys suggestions by employee", () => {
    const out = suggestionsByEmployee([
      { employeeId: "a", extraWorkMinutes: 480, overtimeMinutes: 0 },
      { employeeId: "b", extraWorkMinutes: 240, overtimeMinutes: 600 },
    ]);
    expect(out.get("a")).toBe(1);
    // 240 + 600 = 840 minutes = 1.75 days -> floors to 1.5
    expect(out.get("b")).toBe(1.5);
  });

  it("ADDS overtime to rest-day work", () => {
    /*
      This assertion used to say the opposite, on the argument that the two could
      describe the same hours. Checked against the venue instead of reasoned about:
      across August, 93 days carry overtime, 0 carry rest-day work, and 0 carry
      both. Excluding overtime made the column read 0 for all 83 employees while 258
      hours of it sat in the data.
    */
    const out = suggestionsByEmployee([
      { employeeId: "a", extraWorkMinutes: 480, overtimeMinutes: 480 },
    ]);
    expect(out.get("a")).toBe(2);
  });

  it("suggests from overtime alone, which is where this venue's extra work lives", () => {
    const out = suggestionsByEmployee([
      { employeeId: "a", extraWorkMinutes: 0, overtimeMinutes: 720 },
    ]);
    expect(out.get("a")).toBe(1.5);
  });

  it("ignores a negative figure in either column rather than subtracting it", () => {
    const out = suggestionsByEmployee([
      { employeeId: "a", extraWorkMinutes: -480, overtimeMinutes: 480 },
    ]);
    expect(out.get("a")).toBe(1);
  });

  it("leaves an employee with no row absent, not zero", () => {
    /* "No attendance recorded" and "recorded, nothing extra" are different facts. */
    const out = suggestionsByEmployee([{ employeeId: "a", extraWorkMinutes: 0, overtimeMinutes: 0 }]);
    expect(out.has("a")).toBe(true);
    expect(out.has("b")).toBe(false);
  });
});
