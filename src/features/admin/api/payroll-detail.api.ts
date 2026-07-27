/**
 * payroll-detail.api.ts — the four reads `payroll.api.ts` does not carry, all of
 * them needed by `/admin/payroll/runs/:id` and `/admin/payroll/compensation`.
 *
 * Nothing here talks to supabase directly: every call goes through the sanctioned
 * helpers in `@/shared/api/query`, so the zod boundary, the error taxonomy and
 * (for the reveal) the reason floor are the same ones the rest of the console
 * uses. Schemas were taken from the deployed migrations, not guessed:
 *
 *   * `payroll_run_employees` (022 §2) — admin SELECT/UPDATE policies exist;
 *     rows are written only by the compute engine, so this module reads them.
 *     `status` is a CHECK-constrained text: pending|computed|excluded|error|held.
 *   * `v_admin_employee` (033) — carries `profile_id`, which is what
 *     `payroll_runs.computed_by` / `approved_by` reference (both FK to
 *     `profiles(id)`, 022 §1). Resolving profile → person is what lets the run
 *     detail say "prepared by Sunitha R" instead of printing a uuid.
 *   * `v_salary_revisions` (035) — `is_current` is a view column, so "current pay
 *     for every employee" is a server-side filter, not a client scan.
 *   * `reveal_employee_salary(p_employee_id, p_reason)` (032 §4) — asserts the
 *     reason itself and writes `data_access_log` BEFORE returning a figure. The
 *     reason is an ARGUMENT, so this path cannot be used without one.
 */
import { z } from "zod";
import {
  MutationError,
  SENSITIVE_REASON_LENGTH,
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumericNullable,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  isNull,
  isTrue,
  rpcMany,
  selectMany,
} from "@/shared/api/query";
import { V_ADMIN_EMPLOYEE } from "./employees.api";
import { revisionRowSchema, type RevisionRow } from "./payroll.api";

export const PAYROLL_RUN_EMPLOYEES_TABLE = "payroll_run_employees";
export const V_SALARY_REVISIONS = "v_salary_revisions";

// -----------------------------------------------------------------------------
// 1. Run scope — one row per employee in a run (`/admin/payroll/runs/:id`)
// -----------------------------------------------------------------------------

/** `ck_pre__status` (022 §2). Never rendered raw — see RUN_EMPLOYEE_CHIP. */
export const runEmployeeStatusSchema = z.enum([
  "pending",
  "computed",
  "excluded",
  "error",
  "held",
]);
export type RunEmployeeStatus = z.infer<typeof runEmployeeStatusSchema>;

export const runEmployeeSchema = z.object({
  id: dbUuid,
  payroll_run_id: dbUuid,
  employee_id: dbUuid,
  status: runEmployeeStatusSchema,
  exclusion_reason: z.string().nullable(),
  hold_reason: z.string().nullable(),
  error_detail: z.string().nullable(),
  computed_at: dbTimestampNullable,
  payslip_id: dbUuidNullable,
  retry_count: dbInt,
});
export type RunEmployee = z.infer<typeof runEmployeeSchema>;

/**
 * Every employee in the run's scope, with why each one is where it is.
 *
 * Ordered by `status` (alphabetically: computed, error, excluded, held, pending)
 * and then newest-computed first, so the grid is stable between reads. The screen
 * counts the blocking states itself and says so above the grid — it does not rely
 * on them being at the top.
 */
export function fetchPayrollRunEmployees(
  runId: string,
  limit = 500,
  signal?: AbortSignal,
): Promise<RunEmployee[]> {
  return selectMany(PAYROLL_RUN_EMPLOYEES_TABLE, runEmployeeSchema, {
    filters: [eq("payroll_run_id", runId)],
    order: [
      { column: "status", ascending: true },
      { column: "computed_at", ascending: false },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. profile_id → person, for the two-person approval panel
// -----------------------------------------------------------------------------

export const profilePersonSchema = z.object({
  id: dbUuid,
  profile_id: dbUuidNullable,
  employee_code: z.string(),
  display_name: z.string(),
});
export type ProfilePerson = z.infer<typeof profilePersonSchema>;

/**
 * The people who can appear as a preparer/approver, keyed by `profile_id`.
 *
 * A run computed by the service role (cron, migration) has a `computed_by` that
 * matches nobody here; the caller renders that as "not a named person", which is
 * exactly what the two-person rule needs to refuse.
 */
export async function fetchProfilePeople(
  limit = 500,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, ProfilePerson>> {
  const rows = await selectMany(V_ADMIN_EMPLOYEE, profilePersonSchema, {
    filters: [isNull("deleted_at")],
    order: [{ column: "display_name", ascending: true }],
    columns: "id,profile_id,employee_code,display_name",
    limit,
    ...(signal ? { signal } : {}),
  });
  const byProfile = new Map<string, ProfilePerson>();
  for (const row of rows) {
    if (row.profile_id !== null) byProfile.set(row.profile_id, row);
  }
  return byProfile;
}

// -----------------------------------------------------------------------------
// 3. Current compensation for the whole organisation
// -----------------------------------------------------------------------------

/**
 * The revision in force TODAY for every employee in admin scope.
 *
 * `is_current` is computed inside `v_salary_revisions` (approved + effective
 * window covers `util.ist_today()`), so "current" is the server's definition and
 * the same one the payslip engine reads.
 */
export function fetchCurrentCompensation(
  limit = 500,
  signal?: AbortSignal,
): Promise<RevisionRow[]> {
  return selectMany(V_SALARY_REVISIONS, revisionRowSchema, {
    filters: [isTrue("is_current")],
    order: [{ column: "effective_from", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Audited salary reveal (a logged READ, not a write)
// -----------------------------------------------------------------------------

export const revealedSalarySchema = z.object({
  revision_id: dbUuid,
  revision_number: dbInt,
  revision_kind: z.string(),
  effective_from: dbDate,
  effective_to: dbDateNullable,
  status: z.string(),
  monthly_gross_paise: dbInt,
  monthly_employer_contribution_paise: dbInt,
  monthly_ctc_paise: dbInt,
  annual_ctc_paise: dbInt,
  previous_monthly_ctc_paise: dbIntNullable,
  increment_amount_paise: dbIntNullable,
  increment_pct: dbNumericNullable,
  months_since_previous: dbIntNullable,
  component_code: z.string().nullable(),
  component_name: z.string().nullable(),
  line_kind: z.string().nullable(),
  ctc_bucket: z.string().nullable(),
  monthly_amount_paise: dbIntNullable,
  annual_amount_paise: dbIntNullable,
  line_sequence: dbIntNullable,
});
export type RevealedSalaryLine = z.infer<typeof revealedSalarySchema>;

/**
 * Unmask one employee's compensation. The database floor is 10 characters
 * (`app.assert_reveal_allowed`); D-21 asks for 15 on a reveal, so that is what is
 * enforced here — before the request, so a short sentence is a form error rather
 * than a SQLSTATE 22023.
 *
 * Returns EVERY revision line the function emits. The caller matches on
 * `revision_id` and never re-derives a total from the lines.
 */
export function revealSalary(
  employeeId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<RevealedSalaryLine[]> {
  const trimmed = reason.trim();
  if (trimmed.length < SENSITIVE_REASON_LENGTH) {
    return Promise.reject(
      new MutationError(
        "reveal_employee_salary",
        "reason_required",
        `Revealing compensation is a logged data access; give at least ${SENSITIVE_REASON_LENGTH} characters.`,
        { minReasonLength: SENSITIVE_REASON_LENGTH },
      ),
    );
  }
  return rpcMany(
    "reveal_employee_salary",
    { p_employee_id: employeeId, p_reason: trimmed },
    revealedSalarySchema,
    { ...(signal ? { signal } : {}) },
  );
}
