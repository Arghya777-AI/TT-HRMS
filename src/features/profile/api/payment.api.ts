/**
 * payment.api.ts — E-07 Tab 3: statutory identifiers and salary bank account.
 *
 * The masking here is NOT cosmetic. Migration 033 revokes table SELECT on
 * `employee_statutory` and `employee_bank_accounts` from `authenticated` and
 * re-grants a narrow column list that EXCLUDES `pan`, `aadhaar_number`, `uan`,
 * `pf_number`, `esi_number` and `account_number`. The full values therefore
 * never travel to any browser, including an admin's: they exist only inside the
 * migration-032 `reveal_*` functions, which log to `data_access_log` before
 * returning. This module reads the masked views and calls those functions; it
 * cannot construct a full number and neither can the pages.
 *
 * `v_employee_statutory_masked` returns `pan_masked = 'XXXXXX594B'` (util.mask_tail)
 * and `aadhaar_masked = 'XXXX-XXXX-0484'`. That string is the ceiling of what
 * the wire carries for a plain employee, which is exactly the DR-52 fix.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbTimestampNullable,
  dbUuid,
  eq,
  rpcMany,
  selectMany,
  selectOne,
} from "@/shared/api/query";

export const STATUTORY_MASKED_VIEW = "v_employee_statutory_masked";
export const BANK_MASKED_VIEW = "v_employee_bank_masked";
export const REVEAL_STATUTORY_FN = "reveal_employee_statutory";
export const REVEAL_BANK_FN = "reveal_employee_bank_account";

/** The server contract: `assert_reveal_allowed` rejects a shorter reason. */
export const REVEAL_REASON_MIN_LENGTH = 10;

// -----------------------------------------------------------------------------
// 1. Statutory identifiers (masked)
// -----------------------------------------------------------------------------

export const statutoryMaskedSchema = z.object({
  employee_id: dbUuid,
  pan_masked: z.string().nullable(),
  aadhaar_masked: z.string().nullable(),
  uan_masked: z.string().nullable(),
  pf_number_masked: z.string().nullable(),
  esi_number_masked: z.string().nullable(),
  pf_applicable: z.boolean(),
  eps_applicable: z.boolean(),
  esi_applicable: z.boolean(),
  pf_joining_date: dbDateNullable,
  esi_dispensary: z.string().nullable(),
  aadhaar_linked_to_uan: z.boolean(),
  professional_tax_applicable: z.boolean(),
  professional_tax_state: z.string(),
  lwf_applicable: z.boolean(),
  gratuity_eligible_from: dbDateNullable,
  tax_regime: z.enum(["old", "new"]),
  is_director_or_partner: z.boolean(),
});

export type StatutoryMasked = z.infer<typeof statutoryMaskedSchema>;

/**
 * `null` is a real state: an employee whose statutory row has not been created
 * yet. The tab says so and points at Help Desk — it does not render a card of
 * em dashes that looks like missing data the employee should fix.
 */
export async function fetchStatutoryMasked(
  employeeId: string,
  signal?: AbortSignal,
): Promise<StatutoryMasked | null> {
  return selectOne(STATUTORY_MASKED_VIEW, statutoryMaskedSchema, [eq("employee_id", employeeId)], {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Bank accounts (masked)
// -----------------------------------------------------------------------------

export const bankAccountMaskedSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  beneficiary_name: z.string(),
  bank_name: z.string(),
  branch: z.string().nullable(),
  ifsc: z.string(),
  account_number_last4: z.string().nullable(),
  account_type: z.string().nullable(),
  upi_id_masked: z.string().nullable(),
  is_verified: z.boolean(),
  verification_method: z.string().nullable(),
  verified_at: dbTimestampNullable,
  is_active: z.boolean(),
  effective_from: dbDate,
  effective_to: dbDateNullable,
});

export type BankAccountMasked = z.infer<typeof bankAccountMaskedSchema>;

/** Active account first, then newest — the primary payout account leads. */
export async function fetchBankAccounts(
  employeeId: string,
  signal?: AbortSignal,
): Promise<BankAccountMasked[]> {
  return selectMany(BANK_MASKED_VIEW, bankAccountMaskedSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [
      { column: "is_active", ascending: false },
      { column: "effective_from", ascending: false },
    ],
    limit: 25,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. The audited reveals
// -----------------------------------------------------------------------------

export const revealedStatutorySchema = z.object({
  pan: z.string().nullable(),
  aadhaar_number: z.string().nullable(),
  uan: z.string().nullable(),
  pf_number: z.string().nullable(),
  esi_number: z.string().nullable(),
});

export type RevealedStatutory = z.infer<typeof revealedStatutorySchema>;

/**
 * Ask the server for the full statutory numbers.
 *
 * The function writes a `data_access_log` row (actor, fields, written purpose,
 * ip, user agent) BEFORE it returns any value, so a reveal that happened is a
 * reveal that is recorded — the audit cannot be skipped by a client that
 * forgets to call a second endpoint. The same log is what the employee reads
 * back on the History tab under "Who looked at my details".
 *
 * `reason` must be at least 10 characters; the server raises `22023` otherwise.
 * A caller without `app.is_admin()` gets `42501`, which `query.ts` maps to
 * `QueryError{ kind: 'no_permission' }` — the honest answer for an employee, who
 * is never sent the full number.
 */
export async function revealStatutory(
  employeeId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<RevealedStatutory | null> {
  const rows = await rpcMany(
    REVEAL_STATUTORY_FN,
    { p_employee_id: employeeId, p_reason: reason },
    revealedStatutorySchema,
    { ...(signal ? { signal } : {}) },
  );
  return rows[0] ?? null;
}

export const revealedBankAccountSchema = z.object({
  id: dbUuid,
  beneficiary_name: z.string(),
  bank_name: z.string(),
  branch: z.string().nullable(),
  ifsc: z.string(),
  account_number: z.string(),
  account_type: z.string().nullable(),
  upi_id: z.string().nullable(),
  is_verified: z.boolean(),
  is_active: z.boolean(),
  effective_from: dbDate,
  effective_to: dbDateNullable,
});

export type RevealedBankAccount = z.infer<typeof revealedBankAccountSchema>;

/** Full account numbers for every account, logged. Same authority rules. */
export async function revealBankAccounts(
  employeeId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<RevealedBankAccount[]> {
  return rpcMany(
    REVEAL_BANK_FN,
    { p_employee_id: employeeId, p_reason: reason },
    revealedBankAccountSchema,
    { ...(signal ? { signal } : {}) },
  );
}
