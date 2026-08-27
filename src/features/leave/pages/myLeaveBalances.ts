/**
 * myLeaveBalances.ts — which balance cards /me/leave draws.
 *
 * A sibling module rather than page-local, following the repo's rule that anything
 * a screen COMPUTES lives beside it with tests. It also earns its keep: the drift
 * this repairs was invisible on screen for anybody whose balances happened to cover
 * every offered type, so it needed a test more than it needed to be inline.
 */
import type { LeaveBalance } from "../api/leave.api";
import type { LeaveTypeRule } from "../api/leave-apply.api";

/**
 * A type the employee is offered but has no `leave_balances` row for yet.
 *
 * Every figure is zero and `last_recomputed_at` is null, which is the truth: no
 * ledger entry has ever touched this type for this person. Deliberately NOT
 * fabricated from the type's annual quota — a quota is what the policy allows, not
 * what somebody holds, and drawing "18 available" for days that were never accrued
 * would be a number the apply form would then refuse.
 *
 * `leaveYear` is PASSED IN, taken from a real balance row, because the leave year
 * is April-based and this codebase resolves it in Postgres (`leave_year_of`) rather
 * than from a browser calendar — a second definition here could disagree with the
 * ledger every March.
 */
function zeroBalance(rule: LeaveTypeRule, leaveYear: number): LeaveBalance {
  return {
    employee_id: "",
    leave_type_id: rule.id,
    leave_type_code: rule.code,
    leave_type_name: rule.name,
    colour_hex: null,
    is_paid: rule.is_paid,
    is_comp_off: rule.is_comp_off,
    allow_half_day: rule.allow_half_day,
    leave_year: leaveYear,
    opening_days: 0,
    accrued_days: 0,
    carried_forward_days: 0,
    adjusted_days: 0,
    entitlement_days: 0,
    availed_days: 0,
    pending_days: 0,
    encashed_days: 0,
    lapsed_days: 0,
    available_days: 0,
    available_after_pending: 0,
    expiring_soon_days: 0,
    nearest_expiry: null,
    last_recomputed_at: null,
    leave_type_active: true,
  };
}

/**
 * One card per OFFERED type, plus anything retired that still holds days.
 *
 * ── WHY THE OFFERED TYPES LEAD ────────────────────────────────────────────────
 *
 * This used to iterate the BALANCES, so a type appeared only once the employee had
 * a `leave_balances` row — and a row exists only after something credits or debits
 * days. Across the venue that meant Maternity, Paternity and Week-off had rows for
 * two employees and nobody else, so this screen drew two cards while
 * /me/leave/apply drew five: the apply form reads the TYPES and joins balances,
 * this one read the balances and inferred the types. Two screens, two answers to
 * "what leave do I have", and the missing cards read as the entitlement not
 * existing.
 *
 * A retired type is still shown when it holds days or has a request pending:
 * switching a type off does not settle what somebody is already owed, and this
 * would be the only place those days appear. Retired AND empty is dropped — that
 * is neither an entitlement nor a debt.
 *
 * Hour-unit types (PERM short permission) go to a chip strip rather than a card;
 * "2 of 2 remaining" is not a day balance (spec E-05).
 *
 * Exported for its own test: the drift this repairs was invisible on screen for
 * anybody whose balances happened to cover every type.
 */
export function splitBalances(
  rules: readonly LeaveTypeRule[],
  balances: readonly LeaveBalance[],
  leaveYear: number,
): { cardBalances: LeaveBalance[]; chipBalances: LeaveBalance[] } {
  const byType = new Map<string, LeaveBalance>();
  for (const balance of balances) byType.set(balance.leave_type_id, balance);
  const offered = new Set(rules.map((r) => r.id));

  const cardBalances: LeaveBalance[] = [];
  const chipBalances: LeaveBalance[] = [];

  for (const rule of rules) {
    const balance = byType.get(rule.id) ?? zeroBalance(rule, leaveYear);
    if (rule.unit === "hour") chipBalances.push(balance);
    else cardBalances.push(balance);
  }

  for (const balance of balances) {
    if (offered.has(balance.leave_type_id)) continue;
    if (balance.available_days === 0 && balance.pending_days === 0) continue;
    cardBalances.push(balance);
  }

  return { cardBalances, chipBalances };
}
