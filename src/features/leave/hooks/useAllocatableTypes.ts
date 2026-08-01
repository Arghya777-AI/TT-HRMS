/**
 * useAllocatableTypes — the leave types this employee may draw on, each with its spendable
 * balance, in the shape the allocation form needs.
 *
 * TWO READS, JOINED IN THE BROWSER, and that is fine here: `leave_types` is the rule master
 * and `v_leave_balance_current` is the per-employee balance, and the join key is the type id.
 * No arithmetic crosses the boundary — `available_after_pending` is a GENERATED column read
 * verbatim, which is the figure the server's own balance check uses.
 *
 * WHY `available_after_pending` AND NOT `available_days`. The spendable figure already
 * subtracts days sitting in requests awaiting a decision. Offering `available_days` would let
 * somebody allocate days they have already asked for, and the submit guard would refuse it
 * with a number the screen never showed them.
 *
 * ELIGIBILITY IS REUSED, NOT REIMPLEMENTED. `isEligibleLeaveType` mirrors the structural
 * gates in `leave_requests_submit_guard` — employment type and gender restriction — and is
 * imported so the allocation list cannot offer a type the employee's own form would hide.
 * Probation is deliberately not a gate: it is shown, not silently blocked (spec §4).
 */
import { useMemo } from "react";
import type { AllocatableType } from "../leaveAllocation";
import { isEligibleLeaveType, type MyLeaveContext } from "../api/leave-apply.api";
import { useLeaveTypeRules } from "./useLeaveApply";
import { useLeaveBalances } from "./useLeave";

export interface AllocatableTypesResult {
  readonly types: readonly AllocatableType[];
  readonly isPending: boolean;
  readonly error: Error | null;
}

export function useAllocatableTypes(context: MyLeaveContext | null): AllocatableTypesResult {
  const rules = useLeaveTypeRules();
  const balances = useLeaveBalances();

  const types = useMemo<AllocatableType[]>(() => {
    const spendable = new Map<string, number>();
    for (const row of balances.data ?? []) {
      spendable.set(row.leave_type_id, row.available_after_pending);
    }

    return (rules.data ?? [])
      .filter((rule) => isEligibleLeaveType(rule, context))
      .map((rule) => ({
        id: rule.id,
        code: rule.code,
        name: rule.name,
        // No balance row means nothing accrued yet — zero, not "unknown". Unpaid leave has
        // no balance by design and `isPaid: false` is what stops it being checked.
        availableDays: spendable.get(rule.id) ?? 0,
        allowsCombination: rule.allows_combination,
        minDays: rule.min_days_per_request,
        allowHalfDay: rule.allow_half_day,
        isPaid: rule.is_paid,
      }))
      // Something to spend first, then alphabetically — an employee scanning for "what can I
      // actually use" should not have to read past nine empty types to find it.
      .sort((a, b) => {
        const aHas = a.availableDays > 0 || !a.isPaid;
        const bHas = b.availableDays > 0 || !b.isPaid;
        if (aHas !== bHas) return aHas ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [rules.data, balances.data, context]);

  return {
    types,
    isPending: rules.isPending || balances.isPending,
    error: rules.error ?? balances.error,
  };
}
