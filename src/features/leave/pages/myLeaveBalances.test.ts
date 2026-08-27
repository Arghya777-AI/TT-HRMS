/**
 * myLeaveBalances.test.ts — the leave page must show every leave type on offer.
 *
 * WHAT WENT WRONG
 * ---------------
 * /me/leave built its cards from `leave_balances` rows. A row only exists once
 * something has credited or debited days, so Maternity, Paternity and Week-off —
 * offered, but never accrued for most people — drew no card at all. Meanwhile
 * /me/leave/apply builds its list from the TYPES and joins balances, so it showed
 * five entitlements while the balances page showed two.
 *
 * Reported as "show at leave page also... for all type of leave". The absence was
 * being read as the entitlement not existing, which is the worst possible reading
 * of a screen whose job is to say what you have.
 *
 * These pin the contract: offered leads, zero is a real answer, and a retired type
 * is not silently dropped while it still owes somebody days.
 */
import { describe, expect, it } from "vitest";

import { splitBalances } from "./myLeaveBalances";
import type { LeaveBalance } from "../api/leave.api";
import type { LeaveTypeRule } from "../api/leave-apply.api";

const YEAR = 2026;

function rule(id: string, code: string, unit = "day"): LeaveTypeRule {
  return {
    id,
    code,
    name: `${code} Leave`,
    description: null,
    sort_order: 1,
    is_paid: true,
    is_comp_off: false,
    unit,
    allow_half_day: true,
    min_days_per_request: 0,
    max_days_per_request: null,
    max_consecutive_days: null,
  } as unknown as LeaveTypeRule;
}

function balance(typeId: string, code: string, available: number, pending = 0): LeaveBalance {
  return {
    employee_id: "emp",
    leave_type_id: typeId,
    leave_type_code: code,
    leave_type_name: `${code} Leave`,
    colour_hex: null,
    is_paid: true,
    is_comp_off: false,
    allow_half_day: true,
    leave_year: YEAR,
    opening_days: available,
    accrued_days: 0,
    carried_forward_days: 0,
    adjusted_days: 0,
    entitlement_days: available,
    availed_days: 0,
    pending_days: pending,
    encashed_days: 0,
    lapsed_days: 0,
    available_days: available,
    available_after_pending: available - pending,
    expiring_soon_days: 0,
    nearest_expiry: null,
    last_recomputed_at: null,
    leave_type_active: true,
  } as unknown as LeaveBalance;
}

/** The venue's five: sick, earned, paternity, maternity, week-off. */
const OFFERED = [
  rule("t-sl", "SL"),
  rule("t-el", "EL"),
  rule("t-pl", "PL"),
  rule("t-ml", "ML"),
  rule("t-mrl", "MRL"),
];

const codes = (rows: readonly LeaveBalance[]): string[] => rows.map((r) => r.leave_type_code);

describe("splitBalances", () => {
  it("draws a card for every offered type, even with no balance row", () => {
    // The exact venue case: only sick and earned have ledger history.
    const { cardBalances } = splitBalances(
      OFFERED,
      [balance("t-el", "EL", 30), balance("t-sl", "SL", 2)],
      YEAR,
    );
    expect(codes(cardBalances).sort()).toEqual(["EL", "ML", "MRL", "PL", "SL"]);
  });

  it("shows a type with no history as a real zero, not a fabricated quota", () => {
    const { cardBalances } = splitBalances(OFFERED, [balance("t-el", "EL", 30)], YEAR);
    const maternity = cardBalances.find((b) => b.leave_type_code === "ML");
    expect(maternity?.available_days).toBe(0);
    expect(maternity?.entitlement_days).toBe(0);
    // Never recomputed, because nothing has ever touched it — said, not guessed.
    expect(maternity?.last_recomputed_at).toBeNull();
    expect(maternity?.leave_year).toBe(YEAR);
  });

  it("keeps the real balance when there is one, rather than zeroing it", () => {
    const { cardBalances } = splitBalances(OFFERED, [balance("t-ml", "ML", 26)], YEAR);
    expect(cardBalances.find((b) => b.leave_type_code === "ML")?.available_days).toBe(26);
  });

  it("still shows a retired type that owes somebody days", () => {
    /*
      Switching a type off does not settle what an employee already holds. If this
      card vanished, those days would exist nowhere the employee can see.
    */
    const { cardBalances } = splitBalances(OFFERED, [balance("t-bl", "BL", 4)], YEAR);
    expect(codes(cardBalances)).toContain("BL");
  });

  it("still shows a retired type with a request pending against it", () => {
    const { cardBalances } = splitBalances(OFFERED, [balance("t-bl", "BL", 0, 2)], YEAR);
    expect(codes(cardBalances)).toContain("BL");
  });

  it("drops a retired type that is empty — the Casual Leave ghost card", () => {
    const { cardBalances } = splitBalances(OFFERED, [balance("t-cl", "CL", 0)], YEAR);
    expect(codes(cardBalances)).not.toContain("CL");
  });

  it("sends hour-unit types to the chip strip, not the cards", () => {
    const withPerm = [...OFFERED, rule("t-perm", "PERM", "hour")];
    const { cardBalances, chipBalances } = splitBalances(withPerm, [], YEAR);
    expect(codes(chipBalances)).toEqual(["PERM"]);
    expect(codes(cardBalances)).not.toContain("PERM");
  });

  it("renders nothing at all when nothing is offered and nothing is held", () => {
    const { cardBalances, chipBalances } = splitBalances([], [], YEAR);
    expect(cardBalances).toEqual([]);
    expect(chipBalances).toEqual([]);
  });

  it("never lists the same type twice", () => {
    // A type both offered AND holding days must not appear once per pass.
    const { cardBalances } = splitBalances(OFFERED, [balance("t-el", "EL", 30)], YEAR);
    expect(new Set(codes(cardBalances)).size).toBe(cardBalances.length);
  });
});
