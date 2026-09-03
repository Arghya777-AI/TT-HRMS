/**
 * overtime-claim.api.ts — claim a month of credited overtime.
 *
 * ── THE FIGURE IS THE SERVER'S ───────────────────────────────────────────────
 * `submit_overtime_claim` takes a month, a compensation mode and a reason. It does NOT take a
 * number of minutes, and this module cannot send one. The claimable figure is summed from
 * `attendance_days` inside the function, so a claim can never assert hours the engine did not
 * credit — which is the whole reason an approver would otherwise have to check by hand, the
 * thing HR said explicitly they did not want to do: "I don't want to keep on verifying all
 * that."
 *
 * `overtime_claimable` is the same computation the form reads, so the number on screen and the
 * number filed are the same number by construction rather than by two implementations agreeing.
 *
 * ── WHY A DAY CAN BE EXCLUDED ────────────────────────────────────────────────
 * `overtime_minutes` derives from `payable_worked_minutes`, which includes minutes still
 * awaiting a punch decision. Letting those into a claim would ask an administrator to approve
 * payment for hours they have not yet accepted as worked. Those days are reported separately as
 * `withheld_minutes` so the employee can see the hours exist and why they are not claimable
 * yet, rather than wondering where they went.
 */
import { z } from "zod";
import { dbDate, dbInt, dbUuid, rpcMany, rpcOne, selectMany } from "@/shared/api/query";

export const CLAIMABLE_FN = "overtime_claimable";
export const SUBMIT_FN = "submit_overtime_claim";
export const OVERTIME_CLAIMS_TABLE = "overtime_claims";

/** "Either you can be compensated, or we can give it as a compensatory off." */
export const COMPENSATION_MODES = ["paid", "comp_off"] as const;
export type CompensationMode = (typeof COMPENSATION_MODES)[number];

export const overtimeClaimableSchema = z.object({
  period_month: dbDate,
  claimable_minutes: dbInt,
  /** Credited overtime on days that still hold an unapproved punch. */
  withheld_minutes: dbInt,
  days_with_overtime: dbInt,
  days_withheld: dbInt,
  already_claimed: z.boolean(),
});
export type OvertimeClaimable = z.infer<typeof overtimeClaimableSchema>;

export function fetchOvertimeClaimable(
  employeeId: string,
  month: string,
  signal?: AbortSignal,
): Promise<OvertimeClaimable | null> {
  return rpcOne(
    CLAIMABLE_FN,
    { p_employee_id: employeeId, p_month: month },
    overtimeClaimableSchema,
    signal ? { signal } : {},
  );
}

export const overtimeClaimSchema = z.object({
  id: dbUuid,
  period_month: dbDate,
  claimed_minutes: dbInt,
  withheld_minutes: dbInt,
  compensation: z.string(),
  reason: z.string(),
  status: z.string(),
  decided_at: z.string().nullable(),
  decided_comment: z.string().nullable(),
  applied_at: z.string().nullable(),
  created_at: z.string(),
});
export type OvertimeClaim = z.infer<typeof overtimeClaimSchema>;

/** The employee's own claims. RLS scopes it; there is no employee filter to get wrong. */
export function fetchMyOvertimeClaims(signal?: AbortSignal): Promise<OvertimeClaim[]> {
  return selectMany(OVERTIME_CLAIMS_TABLE, overtimeClaimSchema, {
    columns:
      "id, period_month, claimed_minutes, withheld_minutes, compensation, reason, " +
      "status, decided_at, decided_comment, applied_at, created_at",
    order: [{ column: "period_month", ascending: false }],
    limit: 36,
    ...(signal ? { signal } : {}),
  });
}

/**
 * File the claim. Returns the new claim's id.
 *
 * Deliberately sends no minute count — see the module header. Every refusal comes back as the
 * server's own sentence: the month has not finished, there is no credited overtime, the
 * overtime is still waiting on punch approvals, a live claim already exists, or a comp-off
 * claim would round to nothing.
 */
export async function submitOvertimeClaim(
  month: string,
  compensation: CompensationMode,
  reason: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const rows = await rpcMany(
    SUBMIT_FN,
    { p_month: month, p_compensation: compensation, p_reason: reason.trim() },
    z.string().uuid(),
    signal ? { signal } : {},
  );
  return rows[0] ?? null;
}
