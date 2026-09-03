/**
 * reimbursementAdmin.api.ts — what a month of reimbursement adds up to.
 *
 * ── WHY THE TOTALS COME FROM POSTGRES ───────────────────────────────────────
 * House rule, and it earns its keep here: a tile must be the count and total of exactly the
 * row set its table shows. Summing paise in JavaScript over a capped page would make the total
 * depend on the page size — which is how a tile and its own detail list start disagreeing, and
 * this is money somebody will be asked to explain.
 *
 * `reimbursement_period_summary` and `claimFilters` read the SAME period on the SAME basis, so
 * the header figure and the table beneath it cannot describe different rows.
 *
 * ── "THIS MONTH" IS THREE NUMBERS ───────────────────────────────────────────
 * The venue's own claims prove it: CLM-2026-000003 covers 26-30 AUGUST and was filed on
 * 2 SEPTEMBER. September is therefore 6,148 by expense period, 12,118 by filing date, and 0 by
 * payment date. All three are right; the basis is chosen on screen rather than assumed here.
 */
import { z } from "zod";
import { dbInt, rpcMany, rpcOne } from "@/shared/api/query";
import { istMonthRange } from "@/lib/datetime";
import type { ClaimPeriodBasis } from "./payroll-statutory.api";

export const SUMMARY_FN = "reimbursement_period_summary";
export const BY_TYPE_FN = "reimbursement_period_by_type";

/**
 * `bigint` arrives from PostgREST as a NUMBER for these magnitudes and as a string beyond
 * 2^53. Paise totals for one venue-month are nowhere near that, but `dbInt` already accepts
 * both, so using it costs nothing and removes the question.
 */
export const reimbursementSummarySchema = z.object({
  claims: dbInt,
  employees: dbInt,
  claimed_paise: dbInt,
  approved_paise: dbInt,
  paid_paise: dbInt,
  /** Approved and not yet paid — what the venue still owes. */
  outstanding_paise: dbInt,
  advance_paise: dbInt,
  pending_count: dbInt,
  approved_count: dbInt,
  paid_count: dbInt,
  rejected_count: dbInt,
  /** Approved, unpaid, attached to no payroll run: money nothing will pay until someone acts. */
  unrouted_count: dbInt,
  /**
   * Claims with no expense period, which the `period` basis cannot place in a month.
   *
   * Surfaced rather than silently excluded. `period_to` is nullable and nothing forces it, so
   * this is 0 today and exists so that a total can never quietly omit a row.
   */
  undated_count: dbInt,
});
export type ReimbursementSummary = z.infer<typeof reimbursementSummarySchema>;

export function fetchReimbursementSummary(
  from: string,
  to: string,
  basis: ClaimPeriodBasis,
  signal?: AbortSignal,
): Promise<ReimbursementSummary | null> {
  return rpcOne(
    SUMMARY_FN,
    { p_from: from, p_to: to, p_basis: basis },
    reimbursementSummarySchema,
    signal ? { signal } : {},
  );
}

export const reimbursementByTypeSchema = z.object({
  claim_type: z.string(),
  claims: dbInt,
  claimed_paise: dbInt,
  approved_paise: dbInt,
});
export type ReimbursementByType = z.infer<typeof reimbursementByTypeSchema>;

/** The shape of the month — "for what purpose", at the level a total can answer it. */
export function fetchReimbursementByType(
  from: string,
  to: string,
  basis: ClaimPeriodBasis,
  signal?: AbortSignal,
): Promise<ReimbursementByType[]> {
  return rpcMany(
    BY_TYPE_FN,
    { p_from: from, p_to: to, p_basis: basis },
    reimbursementByTypeSchema,
    signal ? { signal } : {},
  );
}

// -----------------------------------------------------------------------------
// Periods
// -----------------------------------------------------------------------------

export interface Period {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

/**
 * One month, from `istMonthRange` rather than hand-rolled UTC arithmetic.
 *
 * The first version computed the last day with `setUTCMonth`/`toISOString`, which ESLint
 * forbids in this codebase — and rightly: deriving a business date from a UTC instant is the
 * documented source of the reference product's attendance bug. `istMonthRange` is the one
 * implementation of "which days are in this month", already used by payroll.
 */
export function monthPeriod(monthIso: string): Period {
  const month = monthIso.slice(0, 7);
  const { from, to } = istMonthRange(month);
  return { from, to, label: month };
}

/**
 * The Indian financial year containing `iso`: 1 April to 31 March.
 *
 * Not a calendar year, because this is the year payroll, tax and every statutory return in
 * this product already work in — a calendar-year total would not reconcile against any of them.
 */
export function financialYearPeriod(iso: string): Period {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31`, label: `${start}-${String((start + 1) % 100).padStart(2, "0")}` };
}

/** The last `count` months, newest first, as selectable periods. */
export function recentMonths(today: string, count = 15): string[] {
  const out: string[] = [];
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  for (let back = 0; back < count; back += 1) {
    const d = new Date(Date.UTC(y, m - 1 - back, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
