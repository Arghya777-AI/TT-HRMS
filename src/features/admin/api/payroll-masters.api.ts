/**
 * payroll-masters.api.ts — reads for the payroll master registers and the
 * org-wide payslip/wage registers (§8/§9):
 *
 *   * `salary_structures` + `salary_structure_components` — the structure
 *     templates screen. Admin-only RLS (migration 020 §2/§3).
 *   * `payslips` at HEADER grain — the org-wide payslip register and the wage
 *     register. `v_payslip_detail` is LINE grain (one row per payslip line), so
 *     a register over it would repeat every header figure once per line and a
 *     count over it would count lines, not payslips. The base table is
 *     admin-selectable (022 §3) and carries every register column.
 *   * counts for the revisions register (`v_salary_revisions`) and the variance
 *     report (`v_payroll_variance`) — `HEAD count=exact` over the SAME filter
 *     array the list uses, so the subtitle and the grid agree by construction.
 *
 * No write path exists here on purpose: payslips are written only by the
 * compute engine (RLS revokes INSERT/UPDATE from authenticated), and the two
 * master tables are edited so rarely that this release ships them as read
 * registers rather than invent an unaudited editor.
 *
 * Money is integer paise; every total rendered from this module is a server
 * column, never a client sum.
 */
import { z } from "zod";
import {
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
  isNull,
  lte,
  paginate,
  selectCount,
  selectMany,
  type Cursor,
  type Filter,
  type Page,
} from "@/shared/api/query";
import { V_PAYROLL_VARIANCE } from "./payroll.api";

export const SALARY_STRUCTURES_TABLE = "salary_structures";
export const STRUCTURE_LINES_TABLE = "salary_structure_components";
export const PAYSLIPS_TABLE = "payslips";
export const V_SALARY_REVISIONS = "v_salary_revisions";

// -----------------------------------------------------------------------------
// 1. Salary structures (`/admin/payroll/structures`)
// -----------------------------------------------------------------------------

export const salaryStructureSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: dbInt,
  is_active: z.boolean(),
  /** 'ctc_based' | 'gross_based' | 'wage_based' (check constraint, 020). */
  structure_kind: z.string(),
  applies_to_grade_ids: z.array(dbUuid).nullable(),
  applies_to_employment_types: z.array(z.string()).nullable(),
  effective_from: dbDate,
  effective_to: dbDateNullable,
  version: dbInt,
  is_template: z.boolean(),
  updated_at: dbTimestamp,
  deleted_at: dbTimestampNullable,
});
export type SalaryStructure = z.infer<typeof salaryStructureSchema>;

export function fetchSalaryStructures(
  opts: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<SalaryStructure[]> {
  const filters: Filter[] = [isNull("deleted_at")];
  if (opts.includeInactive !== true) filters.push({ op: "is", column: "is_active", value: true });
  return selectMany(SALARY_STRUCTURES_TABLE, salaryStructureSchema, {
    filters,
    order: [
      { column: "sort_order", ascending: true },
      { column: "code", ascending: true },
      { column: "version", ascending: false },
    ],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

export const structureLineSchema = z.object({
  id: dbUuid,
  salary_structure_id: dbUuid,
  salary_component_id: dbUuid,
  /** Evaluation order — balance components must evaluate last (020). */
  sequence: dbInt,
  calc_kind_override: z.string().nullable(),
  percentage_override: dbNumericNullable,
  fixed_amount_override_paise: dbIntNullable,
  min_amount_paise: dbIntNullable,
  max_amount_paise: dbIntNullable,
  is_mandatory: z.boolean(),
});
export type StructureLine = z.infer<typeof structureLineSchema>;

/** The component lines of one structure, in evaluation order. */
export function fetchStructureLines(
  structureId: string,
  signal?: AbortSignal,
): Promise<StructureLine[]> {
  return selectMany(STRUCTURE_LINES_TABLE, structureLineSchema, {
    filters: [eq("salary_structure_id", structureId)],
    order: [{ column: "sequence", ascending: true }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Payslip register (`/admin/payroll/payslips`, `/admin/payroll/register`)
// -----------------------------------------------------------------------------

/** `payslips.payment_status` check constraint (022 §3). */
export const payslipPaymentStatusValues = [
  "pending",
  "in_batch",
  "paid",
  "failed",
  "held",
  "reversed",
] as const;
export type PayslipPaymentStatus = (typeof payslipPaymentStatusValues)[number];

export function isPayslipPaymentStatus(value: string): value is PayslipPaymentStatus {
  return (payslipPaymentStatusValues as readonly string[]).includes(value);
}

/** HEADER grain — one row per payslip, straight off the base table. */
export const payslipHeaderSchema = z.object({
  id: dbUuid,
  payslip_number: z.string(),
  payroll_run_id: dbUuid,
  employee_id: dbUuid,
  pay_period_id: dbUuid,
  period_start: dbDate,
  period_end: dbDate,
  pay_date: dbDate,
  period_days: dbInt,
  /** §9.2: SUM(day_fraction_paid) — the one definition of Paid Days. */
  paid_days: dbNumeric,
  lop_days: dbNumeric,
  present_days: dbNumeric,
  gross_earnings_paise: dbInt,
  total_deductions_paise: dbInt,
  net_pay_paise: dbInt,
  employer_contributions_paise: dbInt,
  total_ctc_for_period_paise: dbInt,
  payment_mode: z.string(),
  payment_status: z.string(),
  payment_reference: z.string().nullable(),
  paid_on: dbDateNullable,
  pdf_document_id: dbUuidNullable,
  pdf_generated_at: dbTimestampNullable,
  emailed_at: dbTimestampNullable,
  viewed_at: dbTimestampNullable,
  is_reversed: z.boolean(),
});
export type PayslipHeader = z.infer<typeof payslipHeaderSchema>;

export interface PayslipRegisterFilters {
  readonly payPeriodId?: string;
  readonly runId?: string;
  readonly employeeId?: string;
  readonly paymentStatuses?: readonly PayslipPaymentStatus[];
}

/** ONE predicate builder feeds both the page read and the count. */
function payslipFilters(f: PayslipRegisterFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.payPeriodId !== undefined) filters.push(eq("pay_period_id", f.payPeriodId));
  if (f.runId !== undefined) filters.push(eq("payroll_run_id", f.runId));
  if (f.employeeId !== undefined) filters.push(eq("employee_id", f.employeeId));
  if (f.paymentStatuses && f.paymentStatuses.length > 0)
    filters.push(inList("payment_status", f.paymentStatuses));
  return filters;
}

/**
 * Keyset page of the register, newest pay date first. The cursor rides on
 * (`pay_date`, `id`) because `created_at` timestamps contain characters the
 * cursor predicate refuses.
 */
export function fetchPayslipRegister(
  f: PayslipRegisterFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<PayslipHeader>> {
  return paginate(PAYSLIPS_TABLE, payslipHeaderSchema, {
    orderBy: "pay_date",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: payslipFilters(f),
    ...(signal ? { signal } : {}),
  });
}

/** Postgres counts the register; the client never counts loaded rows. */
export function countPayslipRegister(
  f: PayslipRegisterFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(PAYSLIPS_TABLE, payslipFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

/**
 * Every payslip of one pay period, for the wage register. Capped; the register
 * screen says so if the cap is hit. Order is `payslip_number`, which starts
 * with the employee code — the traditional register order.
 */
export const REGISTER_ROW_CAP = 600;

export function fetchPeriodPayslips(
  payPeriodId: string,
  signal?: AbortSignal,
): Promise<PayslipHeader[]> {
  return selectMany(PAYSLIPS_TABLE, payslipHeaderSchema, {
    filters: [eq("pay_period_id", payPeriodId)],
    order: [{ column: "payslip_number", ascending: true }],
    limit: REGISTER_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Counts for the revisions register and the variance report
// -----------------------------------------------------------------------------

export interface RevisionRegisterFilters {
  readonly employeeIds?: readonly string[];
  readonly statuses?: readonly string[];
  readonly from?: string;
  readonly to?: string;
}

/**
 * Mirrors the predicate `fetchSalaryRevisions` (payroll.api.ts) builds, column
 * for column, so the header total and the paged rows describe one row set.
 */
export function revisionFilters(f: RevisionRegisterFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.employeeIds && f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.from !== undefined) filters.push(gte("effective_from", f.from));
  if (f.to !== undefined) filters.push(lte("effective_from", f.to));
  return filters;
}

export function countSalaryRevisions(
  f: RevisionRegisterFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_SALARY_REVISIONS, revisionFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

export function countVarianceRows(
  runId: string,
  grain: "net_pay" | "component",
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(
    V_PAYROLL_VARIANCE,
    [eq("payroll_run_id", runId), eq("variance_grain", grain)],
    { ...(signal ? { signal } : {}) },
  );
}

/** `public.approval_status` (migration 003) — what a revision can be. */
export const revisionStatusValues = [
  "draft",
  "pending",
  "in_progress",
  "approved",
  "rejected",
  "cancelled",
  "withdrawn",
  "expired",
  "auto_approved",
  "escalated",
  "applied",
  "failed",
] as const;
export type RevisionStatus = (typeof revisionStatusValues)[number];

export function isRevisionStatus(value: string): value is RevisionStatus {
  return (revisionStatusValues as readonly string[]).includes(value);
}
