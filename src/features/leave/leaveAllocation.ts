/**
 * leaveAllocation.ts — splitting one leave application across several leave types.
 *
 * THE FLOW THIS SERVES, in the order the employee experiences it: how many days do you
 * want, then which dates, then where the days come from. Asking for the total FIRST is the
 * change — the old form asked for dates and derived a length, which is backwards for
 * somebody who knows they want three days and has to work out which balances cover them.
 *
 * WHY THE RULES LIVE HERE AND NOT IN THE FORM. Every one of them is also enforced by the
 * database — the per-type balance check in `leave_requests_submit_guard`, the
 * `allows_combination` rule in `leave_requests_combination_guard`, the per-type minimum. The
 * server remains the only thing that decides. This module exists so the form can say "you
 * have 0.5 left of Week-off" while the employee is still typing, instead of letting them fill
 * in a whole application and be refused on submit for a reason they cannot see.
 *
 * IT NEVER DECIDES WHICH DATES COUNT. A weekly off or a holiday inside the range is the
 * server's arithmetic (`calc_leave_days`), and a browser copy of it would disagree the first
 * time somebody's rota changed. The employee states a NUMBER of days; the preview tells them
 * what the server made of the dates.
 *
 * SICK LEAVE IS EXCLUSIVE, AND THAT IS A PROPERTY OF THE TYPE. `allowsCombination` comes from
 * `leave_types.allows_combination`, so this file contains no mention of 'SL' — the next type
 * that needs the rule is a data change.
 */

/** What the employee may draw from, with the balance the server will check against. */
export interface AllocatableType {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** `leave_balances.available_after_pending` — what is spendable right now. */
  readonly availableDays: number;
  /** `leave_types.allows_combination`. False = must be taken alone. */
  readonly allowsCombination: boolean;
  /** `leave_types.min_days_per_request`. */
  readonly minDays: number;
  readonly allowHalfDay: boolean;
  /** Unpaid leave has no balance to run out of. */
  readonly isPaid: boolean;
  /**
   * `leave_types.requires_reason` — true for Sick Leave, false for the rest.
   *
   * The form asks for a reason when ANY chosen type requires one, and
   * `trg_leave_requests__submit_rules` refuses the request if it is missing.
   */
  readonly requiresReason: boolean;
  /**
   * `leave_types.max_days_per_month` — the ceiling for one calendar month
   * across every request of this type. Null means no ceiling.
   *
   * Shown, not enforced here: knowing how much of it is already spent takes a
   * server read the form does not make, and a half-enforced ceiling is worse
   * than a stated one. The trigger refuses with its own sentence, naming the
   * month and the days already booked.
   */
  readonly maxDaysPerMonth: number | null;
}

/** One line of the split: this many days from this type. */
export interface Allocation {
  readonly typeId: string;
  readonly days: number;
}

/**
 * Does this application need a reason typed?
 *
 * ANY chosen type asking for one is enough — a combined Sick + Week-off
 * application carries ONE reason field, and Sick Leave is what makes it
 * mandatory. Allocations of zero days do not count: a type sitting at 0 is one
 * the employee looked at and did not use.
 */
export function reasonRequired(
  allocations: readonly Allocation[],
  types: readonly AllocatableType[],
): boolean {
  return allocations.some(
    (a) => a.days > 0 && types.find((t) => t.id === a.typeId)?.requiresReason === true,
  );
}

export type AllocationProblem =
  | { readonly kind: "no_total" }
  | { readonly kind: "nothing_allocated" }
  | { readonly kind: "under_allocated"; readonly remaining: number }
  | { readonly kind: "over_allocated"; readonly excess: number }
  | { readonly kind: "not_half_day"; readonly typeName: string }
  | { readonly kind: "half_not_allowed"; readonly typeName: string }
  | { readonly kind: "insufficient"; readonly typeName: string; readonly available: number }
  | { readonly kind: "below_minimum"; readonly typeName: string; readonly minimum: number }
  | { readonly kind: "exclusive"; readonly typeName: string };

/** Days still to place. Negative means over-allocated. */
export function remainingDays(totalDays: number, allocations: readonly Allocation[]): number {
  const placed = allocations.reduce((sum, a) => sum + a.days, 0);
  // Half-day arithmetic in binary floating point: 0.1+0.2 problems do not arise at .5
  // granularity, but rounding to 3dp keeps a long list from drifting into 2.9999999996.
  return Math.round((totalDays - placed) * 1000) / 1000;
}

/**
 * Everything wrong with this application, in the order an employee should fix it.
 *
 * A LIST, not the first failure. Somebody who has over-allocated AND picked a type they have
 * no balance for should see both, or they fix one, resubmit, and are told about the other.
 */
export function allocationProblems(
  totalDays: number,
  allocations: readonly Allocation[],
  types: readonly AllocatableType[],
): AllocationProblem[] {
  const problems: AllocationProblem[] = [];
  const byId = new Map(types.map((t) => [t.id, t]));
  const used = allocations.filter((a) => a.days > 0);

  if (totalDays <= 0) {
    problems.push({ kind: "no_total" });
    return problems;
  }
  if (used.length === 0) {
    problems.push({ kind: "nothing_allocated" });
    return problems;
  }

  // ── The split must add up ────────────────────────────────────────────────
  const remaining = remainingDays(totalDays, used);
  if (remaining > 0) problems.push({ kind: "under_allocated", remaining });
  if (remaining < 0) problems.push({ kind: "over_allocated", excess: -remaining });

  // ── Exclusivity: a non-combinable type may be the ONLY one ───────────────
  if (used.length > 1) {
    for (const alloc of used) {
      const type = byId.get(alloc.typeId);
      if (type !== undefined && !type.allowsCombination) {
        problems.push({ kind: "exclusive", typeName: type.name });
      }
    }
  }

  // ── Per type ─────────────────────────────────────────────────────────────
  for (const alloc of used) {
    const type = byId.get(alloc.typeId);
    if (type === undefined) continue;

    // Half-day granularity: the engine works in 0.5 steps.
    if ((alloc.days * 2) % 1 !== 0) {
      problems.push({ kind: "not_half_day", typeName: type.name });
      continue;
    }
    // A half day of a type that forbids them.
    if (!type.allowHalfDay && (alloc.days * 2) % 2 !== 0) {
      problems.push({ kind: "half_not_allowed", typeName: type.name });
    }
    // Balance. Unpaid leave has none to exhaust.
    if (type.isPaid && alloc.days > type.availableDays) {
      problems.push({
        kind: "insufficient",
        typeName: type.name,
        available: type.availableDays,
      });
    }
    // The type's own minimum, which the server also enforces.
    if (alloc.days < type.minDays) {
      problems.push({ kind: "below_minimum", typeName: type.name, minimum: type.minDays });
    }
  }

  return problems;
}

/** Ready to submit? */
export function canSubmitAllocation(
  totalDays: number,
  allocations: readonly Allocation[],
  types: readonly AllocatableType[],
): boolean {
  return allocationProblems(totalDays, allocations, types).length === 0;
}

/**
 * A starting split: take as much as possible from the types with the most balance.
 *
 * ONLY A SUGGESTION, and the employee can change every line. It exists because the common
 * case is "three days, I do not care where from", and making somebody allocate by hand to
 * express that is the friction this whole feature is meant to remove.
 *
 * NEVER auto-selects a non-combinable type. Suggesting Sick Leave as part of a split would
 * produce an application the server refuses, from a button labelled "suggest".
 */
export function suggestAllocation(
  totalDays: number,
  types: readonly AllocatableType[],
): Allocation[] {
  const out: Allocation[] = [];
  let left = totalDays;
  const candidates = types
    .filter((t) => t.allowsCombination && t.isPaid && t.availableDays > 0)
    .sort((a, b) => b.availableDays - a.availableDays);

  for (const type of candidates) {
    if (left <= 0) break;
    // Whole/half days only, and never more than the balance holds.
    const take = Math.min(Math.floor(Math.min(left, type.availableDays) * 2) / 2, left);
    if (take <= 0) continue;
    out.push({ typeId: type.id, days: take });
    left = Math.round((left - take) * 1000) / 1000;
  }
  return out;
}
