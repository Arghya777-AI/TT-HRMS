/**
 * bulkAdjust.test.ts — a bulk balance edit is where one wrong sign hits 40 people.
 *
 * The cases that matter are the ones where a plausible reading gives the wrong
 * number: a blank row read as zero, "set to 30" applied as "+30", a debit typed with
 * a minus sign, a figure that would take somebody below zero.
 */
import { describe, expect, it } from "vitest";

import { planBulkAdjust, preferredTypeOrder, type BulkRowInput } from "./bulkAdjust";

function row(code: string, current: number, typed: string): BulkRowInput {
  return { employeeId: `emp-${code}`, employeeCode: code, employeeName: `Name ${code}`, current, typed };
}

describe("planBulkAdjust", () => {
  it("credits by the amount typed", () => {
    const plan = planBulkAdjust([row("092", 31, "1")], "credit", null);
    expect(plan.changes[0]).toMatchObject({ current: 31, target: 32, delta: 1 });
  });

  it("debits by the amount typed", () => {
    const plan = planBulkAdjust([row("092", 31, "1")], "debit", null);
    expect(plan.changes[0]).toMatchObject({ current: 31, target: 30, delta: -1 });
  });

  it("SETS to the amount typed — not a credit of it", () => {
    /*
      The mistake this exists to prevent: 34 asked to become 30 must post -4, not
      +30. Folding "set" into "credit" would leave the employee on 64.
    */
    const plan = planBulkAdjust([row("092", 34, "30")], "set", null);
    expect(plan.changes[0]).toMatchObject({ current: 34, target: 30, delta: -4 });
  });

  it("treats a BLANK row as leave-them-alone, never as zero", () => {
    const plan = planBulkAdjust([row("092", 31, ""), row("117", 5, "  ")], "set", null);
    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toBe(2);
  });

  it("writes nothing when the figure typed is what they already have", () => {
    const plan = planBulkAdjust([row("092", 30, "30")], "set", null);
    expect(plan.changes).toEqual([]);
    expect(plan.noChange).toBe(1);
  });

  it("writes nothing for a credit of zero", () => {
    const plan = planBulkAdjust([row("092", 30, "0")], "credit", null);
    expect(plan.changes).toEqual([]);
    expect(plan.noChange).toBe(1);
  });

  it("accepts half days", () => {
    const plan = planBulkAdjust([row("092", 1, "0.5")], "credit", null);
    expect(plan.changes[0]?.target).toBe(1.5);
  });

  it("refuses a finer fraction", () => {
    const plan = planBulkAdjust([row("092", 1, "0.25")], "credit", null);
    expect(plan.changes).toEqual([]);
    expect(plan.problems[0]?.message).toMatch(/half days/);
  });

  it("refuses text, quoting it back", () => {
    const plan = planBulkAdjust([row("092", 1, "one")], "credit", null);
    expect(plan.problems[0]?.message).toMatch(/"one"/);
  });

  it("refuses a minus sign and points at the Debit option", () => {
    /* Typing -2 with direction Credit is ambiguous: it could mean debit 2, or it
       could be a typo. Refusing says which control to use instead. */
    const plan = planBulkAdjust([row("092", 5, "-2")], "credit", null);
    expect(plan.problems[0]?.message).toMatch(/use Debit/i);
  });

  it("refuses a debit that would go below zero, and says where it would land", () => {
    const plan = planBulkAdjust([row("092", 2, "5")], "debit", null);
    expect(plan.changes).toEqual([]);
    expect(plan.problems[0]?.message).toMatch(/-3 days/);
  });

  it("refuses a figure above the type's ceiling when it has one", () => {
    /* Otherwise the sheet accepts a number the accrual lapses the same night. */
    const plan = planBulkAdjust([row("092", 28, "5")], "credit", 30);
    expect(plan.changes).toEqual([]);
    expect(plan.problems[0]?.message).toMatch(/ceiling of 30/);
  });

  it("allows any figure when the type has no ceiling", () => {
    // Earned leave has none during the year: the 30-day limit binds at the year end.
    const plan = planBulkAdjust([row("092", 28, "20")], "credit", null);
    expect(plan.changes[0]?.target).toBe(48);
  });

  it("collects every problem instead of stopping at the first", () => {
    const plan = planBulkAdjust(
      [row("A", 1, "one"), row("B", 1, "0.25"), row("C", 1, "2")],
      "credit",
      null,
    );
    expect(plan.problems).toHaveLength(2);
    expect(plan.changes).toHaveLength(1);
  });

  it("counts skipped, unchanged and changed separately", () => {
    const plan = planBulkAdjust(
      [row("A", 5, ""), row("B", 5, "5"), row("C", 5, "6")],
      "set",
      null,
    );
    expect({ skipped: plan.skipped, noChange: plan.noChange, changed: plan.changes.length }).toEqual({
      skipped: 1,
      noChange: 1,
      changed: 1,
    });
  });

  it("carries the name through, so the confirmation names people not ids", () => {
    const plan = planBulkAdjust([row("092", 1, "1")], "credit", null);
    expect(plan.changes[0]?.employeeName).toBe("Name 092");
  });
});

describe("preferredTypeOrder", () => {
  const types = [
    { id: "1", code: "EL", name: "Earned Leave" },
    { id: "2", code: "MRL", name: "Week-off" },
    { id: "3", code: "SL", name: "Sick Leave" },
    { id: "4", code: "PL", name: "Paternity Leave" },
    { id: "5", code: "ML", name: "Maternity Leave" },
  ];

  it("puts the hand-granted types first", () => {
    /* Week-off, maternity and paternity are granted by hand; sick and earned accrue
       on a schedule, so a bulk edit of them is the unusual case. */
    expect(preferredTypeOrder(types).slice(0, 3).map((t) => t.code).sort()).toEqual([
      "ML",
      "MRL",
      "PL",
    ]);
  });

  it("keeps the scheduled types available, just not first", () => {
    expect(preferredTypeOrder(types).slice(3).map((t) => t.code).sort()).toEqual(["EL", "SL"]);
  });

  it("does not mutate its input", () => {
    const input = [...types];
    preferredTypeOrder(input);
    expect(input[0]?.code).toBe("EL");
  });
});
