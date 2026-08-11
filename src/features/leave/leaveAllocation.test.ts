/**
 * Splitting one application across leave types.
 *
 * These mirror rules the DATABASE also enforces — the per-type balance check, the
 * `allows_combination` exclusivity, the per-type minimum. The point of testing them here is
 * that the form must reach the same verdict the server will, or an employee fills in a whole
 * application and is refused for a reason the screen could have told them about.
 *
 * Verified against the live project alongside these: a Week-off + Earned Leave group is
 * ALLOWED, and adding Sick Leave to it is REFUSED with "Sick Leave must be taken on its own".
 */
import { describe, expect, it } from "vitest";
import {
  allocationProblems,
  canSubmitAllocation,
  remainingDays,
  reasonRequired,
  suggestAllocation,
  type AllocatableType,
} from "./leaveAllocation";

const WEEK_OFF: AllocatableType = {
  id: "mrl",
  code: "MRL",
  name: "Week-off",
  availableDays: 0.5,
  allowsCombination: true,
  minDays: 0.5,
  allowHalfDay: true,
  isPaid: true,
  requiresReason: false,
  maxDaysPerMonth: 3,
};

const EARNED: AllocatableType = {
  id: "el",
  code: "EL",
  name: "Earned Leave",
  availableDays: 10,
  allowsCombination: true,
  minDays: 0.5,
  allowHalfDay: true,
  isPaid: true,
  requiresReason: false,
  maxDaysPerMonth: 3,
};

/** Non-combinable, mirroring `allows_combination = false` on SL. */
const SICK: AllocatableType = {
  id: "sl",
  code: "SL",
  name: "Sick Leave",
  availableDays: 5,
  allowsCombination: false,
  minDays: 0.5,
  allowHalfDay: true,
  isPaid: true,
  /* `requires_reason = true` — 041600 sets it on SL and nothing else. */
  requiresReason: true,
  maxDaysPerMonth: 3,
};

const UNPAID: AllocatableType = {
  id: "lwp",
  code: "LWP",
  name: "Leave Without Pay",
  availableDays: 0,
  allowsCombination: true,
  minDays: 0.5,
  allowHalfDay: true,
  isPaid: false,
  requiresReason: false,
  maxDaysPerMonth: 3,
};

const NO_HALVES: AllocatableType = {
  id: "bl",
  code: "BL",
  name: "Bereavement Leave",
  availableDays: 3,
  allowsCombination: true,
  minDays: 0.5,
  allowHalfDay: false,
  isPaid: true,
  requiresReason: false,
  maxDaysPerMonth: 3,
};

const ALL = [WEEK_OFF, EARNED, SICK, UNPAID, NO_HALVES];

describe("remainingDays", () => {
  it("reports what is still to place", () => {
    expect(remainingDays(3, [{ typeId: "el", days: 1 }])).toBe(2);
  });

  it("goes negative when over-allocated", () => {
    expect(remainingDays(2, [{ typeId: "el", days: 3 }])).toBe(-1);
  });

  it("does not drift on a long list of halves", () => {
    const halves = Array.from({ length: 7 }, () => ({ typeId: "el", days: 0.5 }));
    expect(remainingDays(3.5, halves)).toBe(0);
  });
});

describe("the case from the brief: 0.5 week-off + the rest earned leave", () => {
  it("accepts 0.5 Week-off and 1.5 Earned Leave for a 2-day application", () => {
    const allocations = [
      { typeId: "mrl", days: 0.5 },
      { typeId: "el", days: 1.5 },
    ];
    expect(allocationProblems(2, allocations, ALL)).toEqual([]);
    expect(canSubmitAllocation(2, allocations, ALL)).toBe(true);
  });

  it("refuses to draw more Week-off than the 0.5 available", () => {
    const problems = allocationProblems(2, [{ typeId: "mrl", days: 1.5 }, { typeId: "el", days: 0.5 }], ALL);
    expect(problems).toContainEqual({ kind: "insufficient", typeName: "Week-off", available: 0.5 });
  });
});

describe("sick leave exclusivity", () => {
  it("allows sick leave on its own", () => {
    expect(allocationProblems(2, [{ typeId: "sl", days: 2 }], ALL)).toEqual([]);
  });

  it("allows HALF a day of sick leave on its own — the restriction is mixing, not duration", () => {
    expect(allocationProblems(0.5, [{ typeId: "sl", days: 0.5 }], ALL)).toEqual([]);
  });

  it("refuses sick leave combined with anything", () => {
    const problems = allocationProblems(
      2,
      [{ typeId: "sl", days: 1 }, { typeId: "el", days: 1 }],
      ALL,
    );
    expect(problems).toContainEqual({ kind: "exclusive", typeName: "Sick Leave" });
  });

  it("refuses even a half-day of sick leave beside another type", () => {
    const problems = allocationProblems(
      1,
      [{ typeId: "sl", days: 0.5 }, { typeId: "mrl", days: 0.5 }],
      ALL,
    );
    expect(problems).toContainEqual({ kind: "exclusive", typeName: "Sick Leave" });
  });
});

describe("the split must add up", () => {
  it("names how much is left to place", () => {
    expect(allocationProblems(3, [{ typeId: "el", days: 1 }], ALL)).toContainEqual({
      kind: "under_allocated",
      remaining: 2,
    });
  });

  it("names the excess", () => {
    expect(allocationProblems(1, [{ typeId: "el", days: 2 }], ALL)).toContainEqual({
      kind: "over_allocated",
      excess: 1,
    });
  });

  it("requires a total before anything else", () => {
    expect(allocationProblems(0, [{ typeId: "el", days: 1 }], ALL)).toEqual([{ kind: "no_total" }]);
  });

  it("asks for an allocation when none is made", () => {
    expect(allocationProblems(2, [], ALL)).toEqual([{ kind: "nothing_allocated" }]);
  });
});

describe("per-type rules", () => {
  it("refuses a quarter day", () => {
    expect(allocationProblems(0.25, [{ typeId: "el", days: 0.25 }], ALL)).toContainEqual({
      kind: "not_half_day",
      typeName: "Earned Leave",
    });
  });

  it("refuses a half day for a type that forbids them", () => {
    expect(allocationProblems(0.5, [{ typeId: "bl", days: 0.5 }], ALL)).toContainEqual({
      kind: "half_not_allowed",
      typeName: "Bereavement Leave",
    });
  });

  it("does not check a balance on unpaid leave — there is none to exhaust", () => {
    expect(allocationProblems(5, [{ typeId: "lwp", days: 5 }], ALL)).toEqual([]);
  });

  it("reports every problem, not just the first", () => {
    // Over-allocated AND drawing more Week-off than exists.
    const problems = allocationProblems(1, [{ typeId: "mrl", days: 2 }], ALL);
    expect(problems.map((p) => p.kind).sort()).toEqual(["insufficient", "over_allocated"]);
  });
});

describe("suggestAllocation", () => {
  it("fills from the largest balance first", () => {
    expect(suggestAllocation(3, ALL)).toEqual([{ typeId: "el", days: 3 }]);
  });

  it("spills into a second type when the first runs out", () => {
    const suggestion = suggestAllocation(11, ALL);
    expect(suggestion[0]).toEqual({ typeId: "el", days: 10 });
    expect(suggestion.map((a) => a.typeId)).toContain("bl");
  });

  it("NEVER suggests a non-combinable type — that would build an application the server refuses", () => {
    expect(suggestAllocation(20, ALL).map((a) => a.typeId)).not.toContain("sl");
  });

  it("never suggests unpaid leave, which would silently cost the employee pay", () => {
    expect(suggestAllocation(50, ALL).map((a) => a.typeId)).not.toContain("lwp");
  });

  it("produces a submittable split for a normal request", () => {
    const suggestion = suggestAllocation(2, ALL);
    expect(canSubmitAllocation(2, suggestion, ALL)).toBe(true);
  });

  it("returns what it can when no balance covers the total, rather than nothing", () => {
    const suggestion = suggestAllocation(100, ALL);
    expect(suggestion.length).toBeGreaterThan(0);
    // And the form will then report the shortfall rather than pretending it is complete.
    expect(canSubmitAllocation(100, suggestion, ALL)).toBe(false);
  });
});

describe("reasonRequired", () => {
  const ALL = [WEEK_OFF, EARNED, SICK, UNPAID, NO_HALVES];

  it("is false when nothing chosen requires one", () => {
    expect(reasonRequired([{ typeId: "el", days: 2 }], ALL)).toBe(false);
  });

  it("is true as soon as a type that requires one is used", () => {
    expect(reasonRequired([{ typeId: "sl", days: 1 }], ALL)).toBe(true);
  });

  it("is true for a mixed application containing that type", () => {
    // The form carries ONE reason field, so any member demanding it makes the
    // whole application demand it.
    expect(
      reasonRequired([{ typeId: "el", days: 1 }, { typeId: "sl", days: 1 }], ALL),
    ).toBe(true);
  });

  it("ignores a type allocated zero days", () => {
    // A row the employee opened and left at 0 is not part of the application,
    // and demanding a reason for it would be a form that cannot be submitted.
    expect(reasonRequired([{ typeId: "sl", days: 0 }], ALL)).toBe(false);
  });

  it("ignores an allocation naming a type that is not offered", () => {
    expect(reasonRequired([{ typeId: "ghost", days: 3 }], ALL)).toBe(false);
  });
});
