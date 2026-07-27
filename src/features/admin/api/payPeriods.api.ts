/**
 * payPeriods.api.ts — the WRITE side of `/admin/time/pay-periods`.
 *
 * The read side already exists (`fetchPayPeriods` in payroll.api.ts, which owns
 * the table constant and the row schema); both are imported rather than
 * re-declared, so a column added there cannot drift from what this module
 * writes.
 *
 * Why the writes live here and not in payroll.api.ts: pay periods are a TIME
 * master (spec-admin §6.5) edited on a time screen, and payroll.api.ts is the
 * payroll-run agent's module. One file, one owner.
 *
 * Reason handling is not guessed: `pay_periods` IS listed in
 * `audit.reason_required_tables` (migration 006 §2), so a reasonless UPDATE
 * comes back as SQLSTATE 22023. Beyond that, moving a period window moves what
 * payroll counts — a D-21 action — so the client floor is raised to
 * SENSITIVE_REASON_LENGTH and the UI always prompts.
 */
import {
  SENSITIVE_REASON_LENGTH,
  eq,
  insertRow,
  updateRow,
} from "@/shared/api/query";
import { PAY_PERIODS_TABLE, payPeriodSchema, type PayPeriod } from "./payroll.api";

/** `ck_pp__kind` — the only frequencies the table accepts. */
export const PAY_PERIOD_KINDS = ["monthly", "fortnightly", "weekly"] as const;

/** `ck_pp__basis` — the divisor payroll uses for a per-day rate. */
export const MONTH_DAYS_BASES = ["actual", "fixed_30", "fixed_26"] as const;

/**
 * Create a pay period. Every column of `ck_pp__range` / `ck_pp__basis` is
 * validated in the form first, so a CHECK violation is a bug here, not a
 * user's problem.
 */
export function insertPayPeriod(
  values: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<PayPeriod> {
  return insertRow(PAY_PERIODS_TABLE, values, payPeriodSchema, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Edit a pay period. The screen refuses to open the form for a period whose
 * payroll is finalised; this is the second line of defence, not the first.
 */
export function updatePayPeriod(
  id: string,
  patch: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<PayPeriod> {
  return updateRow(PAY_PERIODS_TABLE, [eq("id", id)], patch, payPeriodSchema, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}
