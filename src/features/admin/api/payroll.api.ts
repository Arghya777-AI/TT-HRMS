/**
 * payroll.api.ts — Payroll administration (§8) reads and writes.
 *
 * The run lifecycle is NOT a status dropdown. `payroll-run` (compute + input
 * lock) and `payslip-publish` (gate 4/5, four-eyes, typed net total) are edge
 * functions holding the service role, and they take `reason` in the body because
 * `payroll_runs`, `pay_periods` and `attendance_locks` are all in
 * `audit.reason_required_tables`. This module calls them; it does not reimplement
 * a gate in the browser.
 *
 * What IS a PostgREST write here:
 *   * `payroll_runs` — admin INSERT/UPDATE policies exist (migration 022), so
 *     creating a draft run and annotating one are audited `updateRow` calls.
 *   * `employee_salary_revisions` — admin INSERT/UPDATE, and both policies carry
 *     `AND app.has_reason()` in their WITH CHECK, so a missing reason here is a
 *     42501 rather than a 22023. Either way the helper refuses it first.
 *
 * Money is integer paise everywhere and is rendered by `Money`/lib/money. No
 * total on any screen is summed on the client: `total_gross_paise`,
 * `total_net_paise` and `variance_paise` are server columns.
 */
import { z } from "zod";
import {
  SENSITIVE_REASON_LENGTH,
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumeric,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  insertRow,
  isNull,
  lte,
  paginate,
  selectMany,
  selectOne,
  updateRow,
  type Cursor,
  type Filter,
  type Page,
} from "@/shared/api/query";
import { invokeEdgeFn, newIdempotencyKey } from "@/shared/api/invoke";
import { t } from "@/shared/i18n/en";

export const PAYROLL_RUNS_TABLE = "payroll_runs";
export const SALARY_COMPONENTS_TABLE = "salary_components";
export const SALARY_REVISIONS_TABLE = "employee_salary_revisions";
export const PAY_PERIODS_TABLE = "pay_periods";
export const V_PAYSLIP_DETAIL = "v_payslip_detail";
export const V_PAYROLL_VARIANCE = "v_payroll_variance";

/** `public.payroll_run_status` (migration 003) — the deployed states. */
export const payrollRunStatusValues = [
  "draft",
  "inputs_locked",
  "computed",
  "in_review",
  "approved",
  "disbursement_pending",
  "paid",
  "closed",
  "cancelled",
  "failed",
] as const;
export const payrollRunStatusSchema = z.enum(payrollRunStatusValues);
export type PayrollRunStatus = z.infer<typeof payrollRunStatusSchema>;

export const PAYROLL_STATUS_LABELS: Readonly<Record<PayrollRunStatus, string>> = {
  draft: t("admin.payroll.status.draft"),
  inputs_locked: t("admin.payroll.status.inputs_locked"),
  computed: t("admin.payroll.status.computed"),
  in_review: t("admin.payroll.status.in_review"),
  approved: t("admin.payroll.status.approved"),
  disbursement_pending: t("admin.payroll.status.disbursement_pending"),
  paid: t("admin.payroll.status.paid"),
  closed: t("admin.payroll.status.closed"),
  cancelled: t("admin.payroll.status.cancelled"),
  failed: t("admin.payroll.status.failed"),
};

// -----------------------------------------------------------------------------
// 1. Runs (`/admin/payroll/runs`, `/admin/payroll/runs/:id`)
// -----------------------------------------------------------------------------

export const payrollRunSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  pay_period_id: dbUuid,
  run_number: z.string(),
  run_kind: z.string(),
  status: payrollRunStatusSchema,
  statutory_settings_id: dbUuidNullable,
  engine_version: dbIntNullable,
  inputs_locked_at: dbTimestampNullable,
  attendance_lock_id: dbUuidNullable,
  computed_at: dbTimestampNullable,
  computed_by: dbUuidNullable,
  reviewed_at: dbTimestampNullable,
  reviewed_by: dbUuidNullable,
  approved_at: dbTimestampNullable,
  approved_by: dbUuidNullable,
  paid_at: dbTimestampNullable,
  paid_by: dbUuidNullable,
  closed_at: dbTimestampNullable,
  cancelled_at: dbTimestampNullable,
  cancelled_by: dbUuidNullable,
  cancellation_reason: z.string().nullable(),
  employee_count: dbInt,
  total_gross_paise: dbInt,
  total_deductions_paise: dbInt,
  total_net_paise: dbInt,
  total_employer_cost_paise: dbInt,
  /** Server-computed; can legitimately exceed 100 on a first run. */
  variance_vs_previous_pct: dbNumericNullable,
  exception_count: dbInt,
  notes: z.string().nullable(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});
export type PayrollRun = z.infer<typeof payrollRunSchema>;

export function fetchPayrollRuns(
  f: { statuses?: readonly PayrollRunStatus[]; payPeriodIds?: readonly string[] },
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<PayrollRun>> {
  const filters: Filter[] = [];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.payPeriodIds && f.payPeriodIds.length > 0) filters.push(inList("pay_period_id", f.payPeriodIds));
  return paginate(PAYROLL_RUNS_TABLE, payrollRunSchema, {
    orderBy: "created_at",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters,
    ...(signal ? { signal } : {}),
  });
}

export function fetchPayrollRun(runId: string, signal?: AbortSignal): Promise<PayrollRun | null> {
  return selectOne(PAYROLL_RUNS_TABLE, payrollRunSchema, [eq("id", runId)], {
    ...(signal ? { signal } : {}),
  });
}

/** Create a draft run for a pay period. Audited. */
export function createPayrollRun(
  input: { companyId: string; payPeriodId: string; runNumber: string; runKind?: string },
  reason: string,
  signal?: AbortSignal,
): Promise<PayrollRun> {
  return insertRow(
    PAYROLL_RUNS_TABLE,
    {
      company_id: input.companyId,
      pay_period_id: input.payPeriodId,
      run_number: input.runNumber,
      run_kind: input.runKind ?? "regular",
      status: "draft",
    },
    payrollRunSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
}

/**
 * Annotate a run (reviewer notes, out-of-band explanation for gate 3). Status
 * transitions are NOT done here — they belong to `payroll-run` /
 * `payslip-publish`, which enforce the gates and the four-eyes rule.
 */
export function annotatePayrollRun(
  runId: string,
  notes: string,
  reason: string,
  signal?: AbortSignal,
): Promise<PayrollRun> {
  return updateRow(PAYROLL_RUNS_TABLE, [eq("id", runId)], { notes }, payrollRunSchema, {
    reason,
    ...(signal ? { signal } : {}),
  });
}

/** Cancel/discard a run. Audited and always prompted. */
export function cancelPayrollRun(
  runId: string,
  cancelledBy: string,
  reason: string,
  signal?: AbortSignal,
): Promise<PayrollRun> {
  return updateRow(
    PAYROLL_RUNS_TABLE,
    [eq("id", runId), inList("status", ["draft", "inputs_locked", "computed", "in_review", "failed"])],
    { status: "cancelled", cancelled_by: cancelledBy, cancellation_reason: reason.trim() },
    payrollRunSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 2. Compute + publish — edge functions, four-eyes, typed totals
// -----------------------------------------------------------------------------

const runResultSchema = z
  .object({
    payroll_run_id: dbUuid.optional(),
    status: z.string().optional(),
    done: z.boolean().optional(),
    employee_count: z.number().nullable().optional(),
    exception_count: z.number().nullable().optional(),
  })
  .passthrough();

/**
 * Compute (gates 1–2). Call again while `done` is false — the function chunks by
 * employee. `chunk_size` lowers the per-invocation load if it times out.
 */
export function computePayrollRun(
  input: { payrollRunId: string; chunkSize?: number },
  reason: string,
  idempotencyKey?: string,
): Promise<z.infer<typeof runResultSchema>> {
  return invokeEdgeFn(
    "payroll-run",
    {
      payroll_run_id: input.payrollRunId,
      reason: reason.trim(),
      ...(input.chunkSize !== undefined ? { chunk_size: input.chunkSize } : {}),
    },
    runResultSchema,
    { idempotencyKey: idempotencyKey ?? newIdempotencyKey() },
  );
}

/**
 * Publish (gates 4–5). `confirmNetTotalPaise` is the approver TYPING the run's
 * net total; the function compares it to `payroll_runs.total_net_paise` exactly,
 * in integer paise, with no tolerance. Approver ≠ computer is enforced server-side.
 */
export function publishPayslips(
  input: {
    payrollRunId: string;
    confirmNetTotalPaise: number;
    batchSize?: number;
    notify?: boolean;
  },
  reason: string,
  idempotencyKey?: string,
): Promise<z.infer<typeof runResultSchema>> {
  return invokeEdgeFn(
    "payslip-publish",
    {
      payroll_run_id: input.payrollRunId,
      confirm_net_total_paise: input.confirmNetTotalPaise,
      reason: reason.trim(),
      ...(input.batchSize !== undefined ? { batch_size: input.batchSize } : {}),
      ...(input.notify !== undefined ? { notify: input.notify } : {}),
    },
    runResultSchema,
    { idempotencyKey: idempotencyKey ?? newIdempotencyKey() },
  );
}

// -----------------------------------------------------------------------------
// 3. Variance (`/admin/payroll/variance`)
// -----------------------------------------------------------------------------

export const varianceRowSchema = z.object({
  payroll_run_id: dbUuid,
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  /** 'component' or 'net_pay' — one NET_PAY row per employee. */
  variance_grain: z.enum(["component", "net_pay"]),
  salary_component_id: dbUuidNullable,
  component_code: z.string().nullable(),
  label: z.string().nullable(),
  line_kind: z.string().nullable(),
  current_amount_paise: dbInt,
  previous_amount_paise: dbIntNullable,
  variance_paise: dbInt,
  /** NULL when there is no previous amount — never 0, never Infinity. */
  variance_pct: dbNumericNullable,
});
export type VarianceRow = z.infer<typeof varianceRowSchema>;

export function fetchPayrollVariance(
  runId: string,
  opts: { grain?: "component" | "net_pay" } = {},
  signal?: AbortSignal,
): Promise<VarianceRow[]> {
  const filters: Filter[] = [eq("payroll_run_id", runId)];
  if (opts.grain !== undefined) filters.push(eq("variance_grain", opts.grain));
  return selectMany(V_PAYROLL_VARIANCE, varianceRowSchema, {
    filters,
    order: [{ column: "employee_code", ascending: true }],
    limit: 2000,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Payslips (`/admin/payroll/payslips`, register)
// -----------------------------------------------------------------------------

export const payslipLineSchema = z.object({
  payslip_id: dbUuid,
  payslip_number: z.string(),
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  department_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  payroll_run_id: dbUuid,
  run_number: z.string(),
  run_status: payrollRunStatusSchema,
  pay_period_id: dbUuid,
  pay_period_code: z.string(),
  pay_period_name: z.string(),
  period_start: dbDate,
  period_end: dbDate,
  pay_date: dbDateNullable,
  period_days: dbInt,
  /** THE definition (§9.2): SUM(day_fraction_paid). Must equal the engine's. */
  paid_days: dbNumeric,
  lop_days: dbNumeric,
  present_days: dbNumeric,
  weekly_off_days: dbNumeric,
  holiday_days: dbNumeric,
  leave_days_paid: dbNumeric,
  leave_days_unpaid: dbNumeric,
  overtime_minutes: dbInt,
  extra_work_minutes: dbInt,
  late_deduction_days: dbNumeric,
  gross_earnings_paise: dbInt,
  total_deductions_paise: dbInt,
  net_pay_paise: dbInt,
  net_pay_words: z.string().nullable(),
  employer_contributions_paise: dbInt,
  total_ctc_for_period_paise: dbInt,
  ytd_gross_paise: dbIntNullable,
  ytd_deductions_paise: dbIntNullable,
  ytd_net_paise: dbIntNullable,
  ytd_tds_paise: dbIntNullable,
  payment_mode: z.string().nullable(),
  payment_status: z.string().nullable(),
  payment_reference: z.string().nullable(),
  paid_on: dbDateNullable,
  is_reversed: z.boolean(),
  reversed_by_payslip_id: dbUuidNullable,
  pdf_document_id: dbUuidNullable,
  viewed_at: dbTimestampNullable,
  line_id: dbUuidNullable,
  salary_component_id: dbUuidNullable,
  component_code: z.string().nullable(),
  label: z.string().nullable(),
  line_kind: z.string().nullable(),
  sequence: dbIntNullable,
  full_month_amount_paise: dbIntNullable,
  amount_paise: dbIntNullable,
  calc_kind: z.string().nullable(),
  /** THE proof (§8.11 "Show working") — inputs and formula, server-produced. */
  calc_basis: z.unknown().nullable(),
  ytd_amount_paise: dbIntNullable,
  is_prorated: z.boolean().nullable(),
  is_arrear: z.boolean().nullable(),
  arrear_for_period_id: dbUuidNullable,
});
export type PayslipLine = z.infer<typeof payslipLineSchema>;

/** Every line of every payslip in a run — the Register tab. */
export function fetchPayslipLines(
  f: { runId?: string; employeeId?: string; payPeriodId?: string },
  limit = 2000,
  signal?: AbortSignal,
): Promise<PayslipLine[]> {
  const filters: Filter[] = [];
  if (f.runId !== undefined) filters.push(eq("payroll_run_id", f.runId));
  if (f.employeeId !== undefined) filters.push(eq("employee_id", f.employeeId));
  if (f.payPeriodId !== undefined) filters.push(eq("pay_period_id", f.payPeriodId));
  return selectMany(V_PAYSLIP_DETAIL, payslipLineSchema, {
    filters,
    order: [
      { column: "employee_code", ascending: true },
      { column: "sequence", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. Salary components (`/admin/payroll/components`)
// -----------------------------------------------------------------------------

export const salaryComponentSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: dbInt,
  is_active: z.boolean(),
  line_kind: z.string(),
  calc_kind: z.string(),
  base_component_id: dbUuidNullable,
  percentage: dbNumericNullable,
  fixed_amount_paise: dbIntNullable,
  formula: z.string().nullable(),
  slab_config: z.unknown().nullable(),
  is_taxable: z.boolean(),
  is_pf_wage: z.boolean(),
  is_esi_wage: z.boolean(),
  is_pt_wage: z.boolean(),
  is_lwf_wage: z.boolean(),
  is_gratuity_wage: z.boolean(),
  prorate_on_paid_days: z.boolean(),
  affects_gross: z.boolean(),
  affects_net: z.boolean(),
  affects_ctc: z.boolean(),
  ctc_bucket: z.string().nullable(),
  statutory_reference: z.string().nullable(),
  gl_code: z.string().nullable(),
  show_on_payslip: z.boolean(),
  show_if_zero: z.boolean(),
  is_system_managed: z.boolean(),
  deleted_at: dbTimestampNullable,
  updated_at: dbTimestamp,
});
export type SalaryComponent = z.infer<typeof salaryComponentSchema>;

export function fetchSalaryComponents(
  opts: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<SalaryComponent[]> {
  const filters: Filter[] = [isNull("deleted_at")];
  if (opts.includeInactive !== true) filters.push({ op: "is", column: "is_active", value: true });
  return selectMany(SALARY_COMPONENTS_TABLE, salaryComponentSchema, {
    filters,
    order: [{ column: "sort_order", ascending: true }],
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 6. Revisions (`/admin/payroll/revisions`) — reason-gated by RLS itself
// -----------------------------------------------------------------------------

export const revisionRowSchema = z.object({
  revision_id: dbUuid,
  employee_id: dbUuid,
  revision_number: dbInt,
  revision_kind: z.string(),
  status: z.string(),
  effective_from: dbDate,
  effective_to: dbDateNullable,
  is_current: z.boolean(),
  monthly_gross_paise: dbInt,
  monthly_employer_contribution_paise: dbInt,
  monthly_ctc_paise: dbInt,
  annual_ctc_paise: dbInt,
  previous_monthly_ctc_paise: dbIntNullable,
  increment_amount_paise: dbIntNullable,
  increment_pct: dbNumericNullable,
  months_since_previous: dbIntNullable,
  months_since_last_revision: dbIntNullable,
  ctc_at_join_paise: dbIntNullable,
  salary_structure_id: dbUuidNullable,
  approved_by: dbUuidNullable,
  approved_at: dbTimestampNullable,
  notes: z.string().nullable(),
});
export type RevisionRow = z.infer<typeof revisionRowSchema>;

export function fetchSalaryRevisions(
  f: { employeeIds?: readonly string[]; statuses?: readonly string[]; from?: string; to?: string },
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<RevisionRow>> {
  const filters: Filter[] = [];
  if (f.employeeIds && f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.from !== undefined) filters.push(gte("effective_from", f.from));
  if (f.to !== undefined) filters.push(lte("effective_from", f.to));
  return paginate("v_salary_revisions", revisionRowSchema, {
    orderBy: "effective_from",
    ascending: false,
    tiebreak: "revision_id",
    pageSize,
    cursor,
    filters,
    ...(signal ? { signal } : {}),
  });
}

export interface NewRevisionInput {
  readonly employeeId: string;
  readonly effectiveFrom: string;
  readonly monthlyGrossPaise: number;
  readonly monthlyEmployerContributionPaise?: number;
  readonly salaryStructureId?: string;
  readonly revisionKind?: string;
  readonly notes?: string;
}

/**
 * Propose a salary revision. `monthly_ctc_paise`, `annual_ctc_paise`,
 * `increment_amount_paise` and `increment_pct` are GENERATED columns — passing
 * them would be rejected, and computing them here would be client arithmetic on
 * payroll. Status starts `pending`; approval is the workflow's job.
 *
 * Always prompts: `esr__admin__insert` WITH CHECK includes `app.has_reason()`.
 */
export function proposeSalaryRevision(
  input: NewRevisionInput,
  reason: string,
  signal?: AbortSignal,
): Promise<{ id: string; revision_number: number }> {
  return insertRow(
    SALARY_REVISIONS_TABLE,
    {
      employee_id: input.employeeId,
      effective_from: input.effectiveFrom,
      monthly_gross_paise: input.monthlyGrossPaise,
      monthly_employer_contribution_paise: input.monthlyEmployerContributionPaise ?? 0,
      revision_kind: input.revisionKind ?? "annual_increment",
      status: "pending",
      ...(input.salaryStructureId !== undefined ? { salary_structure_id: input.salaryStructureId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
    z.object({ id: dbUuid, revision_number: dbInt }),
    {
      reason,
      minReasonLength: SENSITIVE_REASON_LENGTH,
      columns: "id,revision_number",
      ...(signal ? { signal } : {}),
    },
  );
}

// -----------------------------------------------------------------------------
// 7. Pay periods (`/admin/time/pay-periods`) — read here, edited in system.api
// -----------------------------------------------------------------------------

export const payPeriodSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  code: z.string(),
  name: z.string(),
  period_kind: z.string(),
  start_date: dbDate,
  end_date: dbDate,
  attendance_cutoff_date: dbDateNullable,
  pay_date: dbDateNullable,
  financial_year: z.string().nullable(),
  month_days_basis: z.string().nullable(),
  is_open: z.boolean(),
  attendance_locked_at: dbTimestampNullable,
  payroll_finalised_at: dbTimestampNullable,
});
export type PayPeriod = z.infer<typeof payPeriodSchema>;

export function fetchPayPeriods(
  f: { financialYear?: string; onlyOpen?: boolean } = {},
  signal?: AbortSignal,
): Promise<PayPeriod[]> {
  const filters: Filter[] = [];
  if (f.financialYear !== undefined) filters.push(eq("financial_year", f.financialYear));
  if (f.onlyOpen === true) filters.push({ op: "is", column: "is_open", value: true });
  return selectMany(PAY_PERIODS_TABLE, payPeriodSchema, {
    filters,
    order: [{ column: "start_date", ascending: false }],
    limit: 60,
    ...(signal ? { signal } : {}),
  });
}
