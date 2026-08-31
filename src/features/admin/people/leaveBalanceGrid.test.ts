/**
 * leaveBalanceGrid.test.ts — the pivot must not invent, lose or misplace a number.
 *
 * A pivot is where balances get attached to the wrong person or the wrong type,
 * and neither shows up as an error — the grid just quietly says somebody has 6 days
 * of sick leave when they have 6 days of earned. These pin the cases that would.
 */
import { describe, expect, it } from "vitest";

import { columnTypes, pivotBalances } from "./leaveBalanceGrid";
import type { LeaveBalance, LeaveType } from "../api/leave.api";

function type(id: string, code: string, sort: number, active = true): LeaveType {
  return { id, code, name: `${code} Leave`, sort_order: sort, is_active: active } as LeaveType;
}

function bal(
  employeeId: string,
  leaveTypeId: string,
  available: number,
  used = 0,
  recomputed: string | null = null,
): LeaveBalance {
  return {
    employee_id: employeeId,
    leave_type_id: leaveTypeId,
    leave_year: 2026,
    available_days: available,
    availed_days: used,
    last_recomputed_at: recomputed,
  } as LeaveBalance;
}

const EL = type("t-el", "EL", 10);
const SL = type("t-sl", "SL", 20);
const ML = type("t-ml", "ML", 30);
const BL = type("t-bl", "BL", 40, false); // retired

describe("columnTypes", () => {
  it("keeps offered types in the venue's own order", () => {
    expect(columnTypes([SL, EL, ML]).map((t) => t.code)).toEqual(["EL", "SL", "ML"]);
  });

  it("drops retired types, so no column is dead furniture", () => {
    expect(columnTypes([EL, BL, SL]).map((t) => t.code)).toEqual(["EL", "SL"]);
  });

  it("breaks a sort_order tie by code rather than leaving it to chance", () => {
    const a = type("t-a", "AAA", 10);
    const b = type("t-b", "BBB", 10);
    expect(columnTypes([b, a]).map((t) => t.code)).toEqual(["AAA", "BBB"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [SL, EL];
    columnTypes(input);
    expect(input.map((t) => t.code)).toEqual(["SL", "EL"]);
  });
});

describe("pivotBalances", () => {
  const columns = columnTypes([EL, SL, ML]);

  it("collapses one row per type into one row per employee", () => {
    const out = pivotBalances(
      [bal("e1", "t-el", 31), bal("e1", "t-sl", 6), bal("e2", "t-el", 29.5)],
      columns,
    );
    expect(out).toHaveLength(2);
  });

  it("puts each number under its own type — the mistake that would be silent", () => {
    // Ranjeeth Pai: 31 earned, 6 sick. Swapping these is invisible on screen.
    const [row] = pivotBalances([bal("e1", "t-el", 31), bal("e1", "t-sl", 6)], columns);
    expect(row?.byTypeId.get("t-el")?.available).toBe(31);
    expect(row?.byTypeId.get("t-sl")?.available).toBe(6);
  });

  it("carries USED beside available, and does not confuse the two", () => {
    /* The pair is the whole point of the column split: 24 available with 6 taken is
       a different situation from 6 available with 24 taken, and a single number
       cannot tell them apart. */
    const [row] = pivotBalances([bal("e1", "t-el", 24, 6)], columns);
    expect(row?.byTypeId.get("t-el")).toEqual({ available: 24, used: 6 });
  });

  it("gives every offered type a cell, so the grid shape is identical for everybody", () => {
    const [row] = pivotBalances([bal("e1", "t-el", 31)], columns);
    expect([...(row?.byTypeId.keys() ?? [])]).toEqual(["t-el", "t-sl", "t-ml"]);
  });

  it("reads a type with no balance row as zero in BOTH columns, not blank", () => {
    /* Maternity is granted per case, so most people have no row. Zero is the
       truth; an empty cell reads as a failed load. */
    const [row] = pivotBalances([bal("e1", "t-el", 31)], columns);
    expect(row?.byTypeId.get("t-ml")).toEqual({ available: 0, used: 0 });
  });

  it("ignores a balance in a type that is not a column", () => {
    // Days held in a retired type must not leak into another type's cell.
    const [row] = pivotBalances([bal("e1", "t-el", 10), bal("e1", "t-bl", 4)], columns);
    expect(row?.byTypeId.get("t-el")?.available).toBe(10);
    expect(row?.byTypeId.has("t-bl")).toBe(false);
  });

  it("takes the LATEST recompute across the employee's types", () => {
    /* Each type recomputes independently, so the first row's timestamp would
       report the page as staler than it is. */
    const [row] = pivotBalances(
      [
        bal("e1", "t-el", 31, 0, "2026-08-31T10:00:00Z"),
        bal("e1", "t-sl", 6, 0, "2026-08-31T17:30:00Z"),
      ],
      columns,
    );
    expect(row?.lastRecomputedAt).toBe("2026-08-31T17:30:00Z");
  });

  it("reports null when nothing has ever been recomputed", () => {
    const [row] = pivotBalances([bal("e1", "t-el", 0)], columns);
    expect(row?.lastRecomputedAt).toBeNull();
  });

  it("carries the leave year through", () => {
    const [row] = pivotBalances([bal("e1", "t-el", 31)], columns);
    expect(row?.leaveYear).toBe(2026);
  });

  it("returns nothing for no rows, rather than a phantom employee", () => {
    expect(pivotBalances([], columns)).toEqual([]);
  });

  it("gives an employee with NO balances a line of zeros", () => {
    /*
      Reported: Management showed 14 of its 19 people. Trisha K had never been
      credited anything, so deriving rows from the balances dropped her from a
      screen headed "Leave Balances" — absence reading as "not an employee".
    */
    const out = pivotBalances([bal("e1", "t-el", 31)], columns, ["e1", "e-trisha"]);
    expect(out).toHaveLength(2);
    const trisha = out.find((r) => r.employeeId === "e-trisha");
    expect(trisha?.byTypeId.get("t-el")).toEqual({ available: 0, used: 0 });
    expect(trisha?.byTypeId.get("t-sl")).toEqual({ available: 0, used: 0 });
    expect(trisha?.lastRecomputedAt).toBeNull();
  });

  it("does not duplicate somebody who is both in scope and has balances", () => {
    const out = pivotBalances([bal("e1", "t-el", 31)], columns, ["e1"]);
    expect(out).toHaveLength(1);
    expect(out[0]?.byTypeId.get("t-el")?.available).toBe(31);
  });

  it("stamps the fallback leave year on a row that had none to read", () => {
    const out = pivotBalances([], columns, ["e-trisha"], 2026);
    expect(out[0]?.leaveYear).toBe(2026);
  });

  it("still works with no scope given — only those holding leave", () => {
    /* The old behaviour, kept so a caller without an employee list is not forced to
       invent one. */
    const out = pivotBalances([bal("e1", "t-el", 31)], columns);
    expect(out.map((r) => r.employeeId)).toEqual(["e1"]);
  });

  it("keeps employees apart", () => {
    const out = pivotBalances(
      [bal("e1", "t-el", 31), bal("e2", "t-el", 3.5), bal("e2", "t-sl", 4)],
      columns,
    );
    const byId = new Map(out.map((r) => [r.employeeId, r]));
    expect(byId.get("e1")?.byTypeId.get("t-el")?.available).toBe(31);
    expect(byId.get("e1")?.byTypeId.get("t-sl")?.available).toBe(0);
    expect(byId.get("e2")?.byTypeId.get("t-el")?.available).toBe(3.5);
    expect(byId.get("e2")?.byTypeId.get("t-sl")?.available).toBe(4);
  });
});
