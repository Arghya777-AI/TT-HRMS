/**
 * pay.api.ts — payslip, current-salary and revision reads.
 *
 * Schemas mirror the DEPLOYED views in
 * `supabase/migrations/20260801003500_views_leave_payroll.sql` (§5–§7).
 *
 * MONEY IS INTEGER PAISE, always. Nothing here divides by 100 — render through
 * `<Money paise={…}>` / `lib/money`, masked by default (spec E-08: every money
 * value on this screen is masked until the session reveal).
 *
 * NO ARITHMETIC. Gross, deductions, net, YTD, CTC, bucket totals and
 * `increment_pct` are all stored or view-computed columns. In particular the
 * payslip's attendance block must read the SAME
 * `f_attendance_period_summary` row the attendance screen reads (see
 * features/attendance/api) — if they disagree the payslip is not published.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumeric,
  dbNumericNullable,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  isTrue,
  QueryError,
  selectMany,
  selectOne,
  type Filter,
} from "@/shared/api/query";
// The api layer is the ONLY layer allowed to touch the client (architecture
// D-01). Needed here for Storage, which is not a view and has no query.ts path.
import { supabase } from "@/lib/supabase";

export const PAYSLIP_DETAIL_VIEW = "v_payslip_detail";
export const CURRENT_SALARY_VIEW = "v_employee_current_salary";
export const SALARY_REVISIONS_VIEW = "v_salary_revisions";
export const PAYSLIPS_TABLE = "payslips";

export const payslipLineKindSchema = z.enum([
  "earning",
  "deduction",
  "employer_contribution",
  "reimbursement",
  "informational",
  "arrear",
  "recovery",
]);

export type PayslipLineKind = z.infer<typeof payslipLineKindSchema>;

export const ctcBucketSchema = z.enum(["A", "B", "C"]);

// -----------------------------------------------------------------------------
// 1. v_payslip_detail — ONE ROW PER LINE, header columns repeated
// -----------------------------------------------------------------------------

/**
 * Mirrors v_payslip_detail (035 §5). Note the grain: the view LEFT JOINs
 * `payslip_lines`, so a payslip with N lines yields N rows with identical header
 * columns (and one row with null line columns if it has no lines yet).
 *
 * The view's own predicate is `self AND run released` OR scoped admin, so a
 * draft payroll run is invisible here by construction — there is no client-side
 * "published" filter to forget.
 */
export const payslipLineRowSchema = z.object({
  // --- header (repeated on every line) ---
  payslip_id: dbUuid,
  payslip_number: z.string(),
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  department_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  payroll_run_id: dbUuid,
  run_number: z.string().nullable(),
  run_status: z.string().nullable(),
  pay_period_id: dbUuid,
  pay_period_code: z.string().nullable(),
  pay_period_name: z.string().nullable(),
  period_start: dbDate,
  period_end: dbDate,
  pay_date: dbDateNullable,
  period_days: dbInt,
  /** THE Paid Days definition: SUM(day_fraction_paid). */
  paid_days: dbNumeric,
  lop_days: dbNumeric,
  present_days: dbNumericNullable,
  weekly_off_days: dbNumericNullable,
  holiday_days: dbNumericNullable,
  leave_days_paid: dbNumericNullable,
  leave_days_unpaid: dbNumericNullable,
  overtime_minutes: dbIntNullable,
  extra_work_minutes: dbIntNullable,
  late_deduction_days: dbNumericNullable,
  gross_earnings_paise: dbInt,
  total_deductions_paise: dbInt,
  net_pay_paise: dbInt,
  /** Server-generated words form. Never generate this on the client. */
  net_pay_words: z.string().nullable(),
  /** Outside net arithmetic — display separately (spec E-08). */
  employer_contributions_paise: dbIntNullable,
  total_ctc_for_period_paise: dbIntNullable,
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
  // --- line (null when the payslip has no lines) ---
  line_id: dbUuidNullable,
  salary_component_id: dbUuidNullable,
  component_code: z.string().nullable(),
  label: z.string().nullable(),
  line_kind: payslipLineKindSchema.nullable(),
  sequence: dbIntNullable,
  full_month_amount_paise: dbIntNullable,
  amount_paise: dbIntNullable,
  calc_kind: z.string().nullable(),
  /** THE proof string — how this amount was derived. Render it verbatim. */
  calc_basis: z.string().nullable(),
  ytd_amount_paise: dbIntNullable,
  is_prorated: z.boolean().nullable(),
  is_arrear: z.boolean().nullable(),
  arrear_for_period_id: dbUuidNullable,
});

export type PayslipLineRow = z.infer<typeof payslipLineRowSchema>;

/**
 * All rows of one payslip, ordered by line sequence.
 *
 * Returned AS ROWS, deliberately un-grouped: grouping by `line_kind` is a
 * presentation concern for the viewer component, and any total it needs is
 * already a header column (`gross_earnings_paise`, `total_deductions_paise`,
 * `net_pay_paise`) — never a sum of these lines.
 */
export async function fetchPayslipLines(
  payslipId: string,
  signal?: AbortSignal,
): Promise<PayslipLineRow[]> {
  return selectMany(PAYSLIP_DETAIL_VIEW, payslipLineRowSchema, {
    filters: [eq("payslip_id", payslipId)],
    order: [
      { column: "line_kind", ascending: true },
      { column: "sequence", ascending: true },
    ],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/** Same, keyed by pay-period code — the `/me/payslips/:period` route param. */
export async function fetchPayslipLinesByPeriod(
  employeeId: string,
  payPeriodCode: string,
  signal?: AbortSignal,
): Promise<PayslipLineRow[]> {
  return selectMany(PAYSLIP_DETAIL_VIEW, payslipLineRowSchema, {
    filters: [eq("employee_id", employeeId), eq("pay_period_code", payPeriodCode)],
    order: [
      { column: "line_kind", ascending: true },
      { column: "sequence", ascending: true },
    ],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. payslips — the list (header grain)
// -----------------------------------------------------------------------------

/**
 * Header-only rows for the E-08 list, read from `payslips`. The base table's own
 * RLS (`payslips__self__select`, migration 022) is `self AND run released`, so
 * drafts are invisible here exactly as in the view; reading the table avoids
 * de-duplicating the line-grain view on the client.
 */
export const payslipSummarySchema = z.object({
  id: dbUuid,
  payslip_number: z.string(),
  employee_id: dbUuid,
  payroll_run_id: dbUuid,
  pay_period_id: dbUuid,
  period_start: dbDate,
  period_end: dbDate,
  pay_date: dbDateNullable,
  period_days: dbInt,
  paid_days: dbNumeric,
  lop_days: dbNumeric,
  gross_earnings_paise: dbInt,
  total_deductions_paise: dbInt,
  net_pay_paise: dbInt,
  ytd_gross_paise: dbIntNullable,
  ytd_deductions_paise: dbIntNullable,
  ytd_net_paise: dbIntNullable,
  ytd_tds_paise: dbIntNullable,
  payment_status: z.string(),
  payment_mode: z.string().nullable(),
  paid_on: dbDateNullable,
  is_reversed: z.boolean(),
  pdf_document_id: dbUuidNullable,
  /**
   * `financial_year` is what labels the FY tiles. The FY is NOT derived on the
   * client from today's date — the period row states which FY it belongs to.
   */
  pay_period: z
    .object({ code: z.string(), name: z.string(), financial_year: z.string() })
    .nullable(),
});

export type PayslipSummary = z.infer<typeof payslipSummarySchema>;

const PAYSLIP_SUMMARY_COLUMNS =
  "id, payslip_number, employee_id, payroll_run_id, pay_period_id, period_start, period_end, " +
  "pay_date, period_days, paid_days, lop_days, gross_earnings_paise, total_deductions_paise, " +
  "net_pay_paise, ytd_gross_paise, ytd_deductions_paise, ytd_net_paise, ytd_tds_paise, " +
  "payment_status, payment_mode, paid_on, is_reversed, pdf_document_id, " +
  "pay_period:pay_periods(code, name, financial_year)";

/** Released payslips, newest period first. */
export async function fetchPayslips(
  employeeId: string,
  limit = 36,
  signal?: AbortSignal,
): Promise<PayslipSummary[]> {
  return selectMany(PAYSLIPS_TABLE, payslipSummarySchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "period_start", ascending: false }],
    limit,
    columns: PAYSLIP_SUMMARY_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/** The most recent released payslip — the E-02 home tile (net masked). */
export async function fetchLatestPayslip(
  employeeId: string,
  signal?: AbortSignal,
): Promise<PayslipSummary | null> {
  return selectOne(PAYSLIPS_TABLE, payslipSummarySchema, [eq("employee_id", employeeId)], {
    order: [{ column: "period_start", ascending: false }],
    columns: PAYSLIP_SUMMARY_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. v_employee_current_salary — the revision in force today, line grain
// -----------------------------------------------------------------------------

/**
 * Mirrors v_employee_current_salary (035 §6). Grain: one row per component line
 * of the current approved revision; the revision header and the A/B/C bucket
 * totals (window functions) repeat on every row.
 *
 * `bucket_a/b/c_monthly_paise` are computed IN THE VIEW. CTC = A + C is defined
 * in data (`monthly_ctc_paise`); do not re-add the buckets on the client.
 */
export const currentSalaryLineSchema = z.object({
  employee_id: dbUuid,
  revision_id: dbUuid,
  revision_number: dbInt,
  revision_kind: z.string().nullable(),
  effective_from: dbDate,
  salary_structure_id: dbUuidNullable,
  salary_structure_code: z.string().nullable(),
  monthly_gross_paise: dbInt,
  monthly_employer_contribution_paise: dbIntNullable,
  monthly_ctc_paise: dbInt,
  annual_ctc_paise: dbIntNullable,
  ctc_at_join_paise: dbIntNullable,
  line_id: dbUuidNullable,
  salary_component_id: dbUuidNullable,
  component_code: z.string().nullable(),
  component_name: z.string().nullable(),
  line_kind: z.string().nullable(),
  ctc_bucket: ctcBucketSchema.nullable(),
  monthly_amount_paise: dbIntNullable,
  annual_amount_paise: dbIntNullable,
  sequence: dbIntNullable,
  bucket_a_monthly_paise: dbIntNullable,
  bucket_b_monthly_paise: dbIntNullable,
  bucket_c_monthly_paise: dbIntNullable,
});

export type CurrentSalaryLine = z.infer<typeof currentSalaryLineSchema>;

/**
 * The current structure, all lines. Spec E-08 Card A renders it whole with no
 * pagination, so there is no paginated variant.
 */
export async function fetchCurrentSalary(
  employeeId: string,
  signal?: AbortSignal,
): Promise<CurrentSalaryLine[]> {
  return selectMany(CURRENT_SALARY_VIEW, currentSalaryLineSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "sequence", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. v_salary_revisions — the history / CTC timeline
// -----------------------------------------------------------------------------

/**
 * Mirrors v_salary_revisions (035 §7). `increment_pct` and
 * `months_since_previous` are stored generated/trigger-set columns of migration
 * 021; `months_since_last_revision` is view-computed and NON-NULL only on the
 * revision currently in force. A "Duration between revisions" label reads the
 * column — it never subtracts two dates in the browser.
 */
export const salaryRevisionSchema = z.object({
  revision_id: dbUuid,
  employee_id: dbUuid,
  revision_number: dbInt,
  revision_kind: z.string().nullable(),
  status: z.string(),
  effective_from: dbDate,
  /** NULL = "Current" — never a year-3000 sentinel. */
  effective_to: dbDateNullable,
  is_current: z.boolean(),
  monthly_gross_paise: dbInt,
  monthly_employer_contribution_paise: dbIntNullable,
  monthly_ctc_paise: dbInt,
  annual_ctc_paise: dbIntNullable,
  previous_monthly_ctc_paise: dbIntNullable,
  increment_amount_paise: dbIntNullable,
  /** Already a percentage. NULL on the first revision — omit the row, don't show 0%. */
  increment_pct: dbNumericNullable,
  months_since_previous: dbIntNullable,
  months_since_last_revision: dbIntNullable,
  ctc_at_join_paise: dbIntNullable,
  salary_structure_id: dbUuidNullable,
  approved_by: dbUuidNullable,
  approved_at: dbTimestampNullable,
  notes: z.string().nullable(),
});

export type SalaryRevision = z.infer<typeof salaryRevisionSchema>;

/** Revision history, oldest first — the order the timeline chart plots. */
export async function fetchSalaryRevisions(
  employeeId: string,
  signal?: AbortSignal,
): Promise<SalaryRevision[]> {
  const filters: readonly Filter[] = [eq("employee_id", employeeId)];
  return selectMany(SALARY_REVISIONS_VIEW, salaryRevisionSchema, {
    filters,
    order: [
      { column: "effective_from", ascending: true },
      { column: "revision_number", ascending: true },
    ],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

/** The revision in force today — Card B's summary. */
export async function fetchCurrentSalaryRevision(
  employeeId: string,
  signal?: AbortSignal,
): Promise<SalaryRevision | null> {
  return selectOne(
    SALARY_REVISIONS_VIEW,
    salaryRevisionSchema,
    [eq("employee_id", employeeId), eq("is_current", true)],
    signal ? { signal } : {},
  );
}

// -----------------------------------------------------------------------------
// 5. Payslip masthead — issuer, work location, statutory + bank (all masked)
// -----------------------------------------------------------------------------

export const COMPANIES_TABLE = "companies";
export const EMPLOYEE_REF_VIEW = "v_employee_ref";
export const STATUTORY_MASKED_VIEW = "v_employee_statutory_masked";
export const BANK_MASKED_VIEW = "v_employee_bank_masked";
export const DOCUMENTS_TABLE = "documents";

/**
 * The issuing legal entity, for the payslip masthead. `companies` carries
 * `companies__all_read__select` (active rows) for every authenticated user, so
 * this is a legitimate self-service read — and the legal name is DATA, never a
 * literal in the string catalogue.
 */
export const payslipIssuerSchema = z.object({
  legal_name: z.string(),
  trade_name: z.string(),
  entity_type: z.string(),
});

export type PayslipIssuer = z.infer<typeof payslipIssuerSchema>;

export async function fetchPayslipIssuer(signal?: AbortSignal): Promise<PayslipIssuer | null> {
  return selectOne(COMPANIES_TABLE, payslipIssuerSchema, [isTrue("is_default")], {
    columns: "legal_name, trade_name, entity_type",
    order: [{ column: "sort_order", ascending: true }],
    ...(signal ? { signal } : {}),
  });
}

/**
 * Work location / designation / department for the masthead. `v_payslip_detail`
 * carries department and designation but not `location_name`, which the spec's
 * identity block names — so it is read from `v_employee_ref` (the same helper
 * view the payslip view itself joins for those labels).
 */
export const employeeRefSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  department_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  location_name: z.string().nullable(),
  date_of_join: dbDateNullable,
});

export type EmployeeRef = z.infer<typeof employeeRefSchema>;

export async function fetchMyEmployeeRef(
  employeeId: string,
  signal?: AbortSignal,
): Promise<EmployeeRef | null> {
  return selectOne(EMPLOYEE_REF_VIEW, employeeRefSchema, [eq("id", employeeId)], {
    columns:
      "id, employee_code, display_name, department_name, designation_name, location_name, date_of_join",
    ...(signal ? { signal } : {}),
  });
}

/**
 * Statutory identifiers, ALREADY masked by the view (`util.mask_tail`). The full
 * numbers are not selectable by any client role — `reveal_employee_statutory()`
 * is admin-only — so these strings are the most this screen can ever show, and
 * they are rendered as monospace text, never as numbers (DR-16).
 */
export const statutoryMaskedSchema = z.object({
  employee_id: dbUuid,
  pan_masked: z.string().nullable(),
  aadhaar_masked: z.string().nullable(),
  uan_masked: z.string().nullable(),
  pf_number_masked: z.string().nullable(),
  esi_number_masked: z.string().nullable(),
  pf_applicable: z.boolean(),
  esi_applicable: z.boolean(),
  professional_tax_applicable: z.boolean(),
  professional_tax_state: z.string().nullable(),
  tax_regime: z.string().nullable(),
});

export type StatutoryMasked = z.infer<typeof statutoryMaskedSchema>;

export async function fetchMyStatutoryMasked(
  employeeId: string,
  signal?: AbortSignal,
): Promise<StatutoryMasked | null> {
  return selectOne(
    STATUTORY_MASKED_VIEW,
    statutoryMaskedSchema,
    [eq("employee_id", employeeId)],
    {
      columns:
        "employee_id, pan_masked, aadhaar_masked, uan_masked, pf_number_masked, " +
        "esi_number_masked, pf_applicable, esi_applicable, professional_tax_applicable, " +
        "professional_tax_state, tax_regime",
      ...(signal ? { signal } : {}),
    },
  );
}

/** The salary payout account, last-4 only (the full number has no read path). */
export const bankMaskedSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  beneficiary_name: z.string().nullable(),
  bank_name: z.string().nullable(),
  branch: z.string().nullable(),
  ifsc: z.string().nullable(),
  account_number_last4: z.string().nullable(),
  account_type: z.string().nullable(),
  is_verified: z.boolean(),
  is_active: z.boolean(),
});

export type BankMasked = z.infer<typeof bankMaskedSchema>;

export async function fetchMyPayoutAccount(
  employeeId: string,
  signal?: AbortSignal,
): Promise<BankMasked | null> {
  return selectOne(
    BANK_MASKED_VIEW,
    bankMaskedSchema,
    [eq("employee_id", employeeId), isTrue("is_active")],
    {
      columns:
        "id, employee_id, beneficiary_name, bank_name, branch, ifsc, account_number_last4, " +
        "account_type, is_verified, is_active",
      order: [{ column: "effective_from", ascending: false }],
      ...(signal ? { signal } : {}),
    },
  );
}

// -----------------------------------------------------------------------------
// 6. The published PDF — a stored object, not a client-generated one
// -----------------------------------------------------------------------------

const payslipDocumentSchema = z.object({
  id: dbUuid,
  title: z.string(),
  file_name: z.string(),
  storage_bucket: z.string(),
  storage_path: z.string(),
});

export interface PayslipPdf {
  readonly url: string;
  readonly fileName: string;
}

/**
 * A short-lived signed URL for the payslip PDF that payroll published.
 *
 * The PDF is produced server-side at publish time (`payslip-publish` →
 * `payslips` bucket, path `<company>/<fy>/<employee_code>/<number>.pdf`, read by
 * `payslips__own_read` once the run is approved). The browser therefore
 * DOWNLOADS the authoritative document; it does not render a second, possibly
 * divergent one with jsPDF.
 */
export async function fetchPayslipPdf(
  documentId: string,
  signal?: AbortSignal,
): Promise<PayslipPdf | null> {
  const doc = await selectOne(DOCUMENTS_TABLE, payslipDocumentSchema, [eq("id", documentId)], {
    columns: "id, title, file_name, storage_bucket, storage_path",
    ...(signal ? { signal } : {}),
  });
  if (doc === null) return null;
  const { data, error } = await supabase.storage
    .from(doc.storage_bucket)
    .createSignedUrl(doc.storage_path, 120);
  if (error !== null) {
    throw new QueryError(
      `storage/${doc.storage_bucket}`,
      "no_permission",
      error.message,
      { cause: error },
    );
  }
  return { url: data.signedUrl, fileName: doc.file_name };
}
