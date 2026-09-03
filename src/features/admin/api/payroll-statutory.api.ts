/**
 * payroll-statutory.api.ts — the reads behind the six §8 tail screens: overtime,
 * reimbursements, statutory, Form 16, bank advice and arrears/reversals.
 *
 * What recon found, and therefore what this module refuses to invent:
 *
 *  * `overtime_preapprovals` DOES NOT EXIST. It is named in
 *    `workflow.request_types.entity_table` (migration 029) and seeded as the
 *    `OT_PREAPPROVAL` request type (migration 045), but no migration ever creates
 *    the table. So overtime is read from what IS deployed and IS authoritative:
 *    `attendance_days.overtime_minutes` (computed by the engine) vs
 *    `approved_overtime_minutes` (paid only when approved), aggregated per
 *    employee per pay period by `analytics.mv_attendance_monthly` and exposed as
 *    `v_attendance_monthly_summary`. The two figures are SERVER SUMS; the client
 *    prints them side by side and never subtracts one from the other.
 *  * There is NO `v_statutory` view and no statutory-summary table. PF/ESI/PT/
 *    LWF/TDS live as `payslip_lines` rows carrying the component code and
 *    `calc_basis` (the proof). This module therefore reads the statutory register
 *    at LINE grain from `v_payslip_detail` — one row per employee per head — and
 *    the pinned `statutory_settings` row for the rates that produced them. No
 *    run-level statutory total is fabricated here.
 *  * `payslips` grants SELECT only (migration 022): no bank-advice generation, no
 *    payslip reversal and no Form 16 issue path exists for a browser client. Those
 *    screens are registers, not consoles, and say so.
 *
 * Money is integer paise on every column named `_paise`. Nothing in this file
 * sums, averages or re-derives a business number.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumeric,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gt,
  gte,
  lte,
  inList,
  isNotNull,
  isNull,
  isTrue,
  lt,
  neq,
  rpcAudited,
  selectCount,
  selectMany,
  selectOne,
  SENSITIVE_REASON_LENGTH,
  type Filter,
} from "@/shared/api/query";
import {
  V_PAYSLIP_DETAIL,
  payslipLineSchema,
  payrollRunSchema,
  type PayrollRun,
  type PayslipLine,
} from "./payroll.api";
import {
  APPROVAL_INBOX_VIEW,
  approvalInboxSchema,
  type ApprovalInboxRow,
} from "@/features/approvals/api/approvals.api";
import { V_ADMIN_EMPLOYEE } from "./employees.api";
import { istDayUtcBounds, nowInstantIso } from "@/lib/datetime";

export const V_ATTENDANCE_MONTHLY_SUMMARY = "v_attendance_monthly_summary";
export const REIMBURSEMENT_CLAIMS_TABLE = "reimbursement_claims";
export const STATUTORY_SETTINGS_TABLE = "statutory_settings";
export const FORM16_DOCUMENTS_TABLE = "form16_documents";
export const BANK_ADVICE_BATCHES_TABLE = "bank_advice_batches";
export const PAYSLIPS_TABLE = "payslips";
export const PAYROLL_RUNS_TABLE = "payroll_runs";

/** Row cap on every register here. The screens print it rather than hide it. */
export const REGISTER_ROW_CAP = 500;
/** Line-grain reads (statutory / arrear lines) are one row per component. */
export const LINE_ROW_CAP = 2000;

// =============================================================================
// 1. Overtime — `/admin/payroll/overtime`
// =============================================================================

/**
 * `v_attendance_monthly_summary` (over `analytics.mv_attendance_monthly`): one
 * row per employee per pay period, every figure already summed by Postgres.
 * `refreshed_at` is the matview's own stamp and is printed as "as of", because a
 * matview-backed number that pretends to be live is a lie by omission.
 */
export const overtimeMonthSchema = z.object({
  employee_id: dbUuid,
  pay_period_id: dbUuid,
  pay_period_code: z.string(),
  days_recorded: dbInt,
  working_days: dbInt,
  present_days: dbInt,
  /** Engine-computed OT for the period — NOT necessarily payable. */
  overtime_minutes: dbInt,
  /** The subset that carries an approval; this is what payroll pays. */
  approved_overtime_minutes: dbInt,
  extra_work_minutes: dbInt,
  total_worked_minutes: dbInt,
  refreshed_at: dbTimestamp,
});
export type OvertimeMonthRow = z.infer<typeof overtimeMonthSchema>;

const OVERTIME_COLUMNS =
  "employee_id, pay_period_id, pay_period_code, days_recorded, working_days, present_days, " +
  "overtime_minutes, approved_overtime_minutes, extra_work_minutes, total_worked_minutes, " +
  "refreshed_at";

/**
 * The three slices a payroll admin actually asks for, as PREDICATES — so the
 * tile count and the grid it opens use the identical filter array.
 *
 * There is deliberately no "computed > approved" slice: PostgREST cannot compare
 * two columns to each other, and doing it in the browser would be exactly the
 * client-side payroll arithmetic this codebase forbids. The grid shows both
 * columns instead and lets the operator read the difference.
 */
export const OVERTIME_SLICE_FILTERS = {
  any: [gt("overtime_minutes", 0)] as readonly Filter[],
  approved: [gt("approved_overtime_minutes", 0)] as readonly Filter[],
  extraWork: [gt("extra_work_minutes", 0)] as readonly Filter[],
} as const;

export type OvertimeSlice = keyof typeof OVERTIME_SLICE_FILTERS;

export function isOvertimeSlice(value: string | null): value is OvertimeSlice {
  return value === "any" || value === "approved" || value === "extraWork";
}

function overtimeFilters(payPeriodId: string, slice: OvertimeSlice | null): Filter[] {
  const filters: Filter[] = [eq("pay_period_id", payPeriodId)];
  if (slice !== null) filters.push(...OVERTIME_SLICE_FILTERS[slice]);
  return filters;
}

export function fetchOvertimeRegister(
  payPeriodId: string,
  slice: OvertimeSlice | null,
  signal?: AbortSignal,
): Promise<OvertimeMonthRow[]> {
  return selectMany(V_ATTENDANCE_MONTHLY_SUMMARY, overtimeMonthSchema, {
    columns: OVERTIME_COLUMNS,
    filters: overtimeFilters(payPeriodId, slice),
    order: [{ column: "overtime_minutes", ascending: false }],
    limit: REGISTER_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countOvertimeRows(
  payPeriodId: string,
  slice: OvertimeSlice | null,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_ATTENDANCE_MONTHLY_SUMMARY, overtimeFilters(payPeriodId, slice), {
    ...(signal ? { signal } : {}),
  });
}

/**
 * OT pre-approval requests routed to the current approver.
 *
 * `v_approval_inbox` is deployed and the `OT_PREAPPROVAL` request type is seeded,
 * so this read is honest — but nothing can currently CREATE such a request,
 * because `request_types.entity_table` points at a table (`overtime_preapprovals`)
 * that no migration creates. An empty list here is the gap, not a quiet day.
 */
export function fetchApprovalInboxByType(
  requestTypeCode: string,
  signal?: AbortSignal,
): Promise<ApprovalInboxRow[]> {
  return selectMany(APPROVAL_INBOX_VIEW, approvalInboxSchema, {
    columns:
      "approval_request_id, request_number, request_type_code, request_type_name, title, amount, " +
      "days, priority, status, current_level, total_levels, subject_employee_id, " +
      "subject_employee_code, subject_display_name, subject_department_name, submitted_at, " +
      "sla_due_at, sla_remaining_hours, is_overdue, age_hours, escalated_at",
    filters: [eq("request_type_code", requestTypeCode)],
    order: [{ column: "sla_due_at", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The premium codes `compute_payslip` writes for worked overtime and night duty
 * (migration 023: `OT` at `overtime_multiplier_statutory`, `NIGHT_ALLOW` per
 * night-shift day). These are what payroll actually PAID, as opposed to what
 * attendance recorded — the two belong on the same screen.
 */
export const PREMIUM_COMPONENT_CODES = ["OT", "NIGHT_ALLOW"] as const;

export function premiumLineFilters(payPeriodId: string): Filter[] {
  return [
    eq("pay_period_id", payPeriodId),
    inList("component_code", PREMIUM_COMPONENT_CODES),
  ];
}

export function fetchPremiumLines(
  payPeriodId: string,
  signal?: AbortSignal,
): Promise<PayslipLine[]> {
  return selectMany(V_PAYSLIP_DETAIL, payslipLineSchema, {
    filters: premiumLineFilters(payPeriodId),
    order: [
      { column: "employee_code", ascending: true },
      { column: "sequence", ascending: true },
    ],
    limit: LINE_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countPremiumLines(payPeriodId: string, signal?: AbortSignal): Promise<number> {
  return selectCount(V_PAYSLIP_DETAIL, premiumLineFilters(payPeriodId), {
    ...(signal ? { signal } : {}),
  });
}

// =============================================================================
// 2. Reimbursements — `/admin/payroll/reimbursements`
// =============================================================================

/**
 * `reimbursement_claims` (migration 024). `total_approved_paise` is what payroll
 * pays: `compute_payslip` picks up claims with `status = 'approved'` AND
 * `paid_via_payroll_run_id = <this run>` and writes them as a `reimbursement`
 * payslip line. Both halves of that predicate are columns, so "cleared for
 * payment with payroll" is a filter here, never a judgement.
 */
export const reimbursementClaimSchema = z.object({
  id: dbUuid,
  claim_number: z.string(),
  employee_id: dbUuid,
  claim_type: z.string(),
  claim_kind: z.string(),
  period_from: dbDateNullable,
  period_to: dbDateNullable,
  total_claimed_paise: dbInt,
  total_approved_paise: dbIntNullable,
  advance_adjusted_paise: dbInt,
  currency: z.string(),
  status: z.string(),
  approval_request_id: dbUuidNullable,
  decided_at: dbTimestampNullable,
  decided_comment: z.string().nullable(),
  payment_mode: z.string().nullable(),
  paid_via_payroll_run_id: dbUuidNullable,
  paid_via_payslip_id: dbUuidNullable,
  paid_on: dbDateNullable,
  payment_reference: z.string().nullable(),
  event_reference: z.string().nullable(),
  created_at: dbTimestamp,
});
export type ReimbursementClaim = z.infer<typeof reimbursementClaimSchema>;

const CLAIM_COLUMNS =
  "id, claim_number, employee_id, claim_type, claim_kind, period_from, period_to, " +
  "total_claimed_paise, total_approved_paise, advance_adjusted_paise, currency, status, " +
  "approval_request_id, decided_at, decided_comment, payment_mode, paid_via_payroll_run_id, " +
  "paid_via_payslip_id, paid_on, payment_reference, event_reference, created_at";

/** `ck_rc__claim_type` — the nine deployed claim types, in the DB's own order. */
export const CLAIM_TYPES = [
  "local_conveyance",
  "travel",
  "food",
  "medical",
  "telephone",
  "uniform",
  "fuel",
  "guest_hospitality",
  "misc",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export function isClaimType(value: string): value is ClaimType {
  return (CLAIM_TYPES as readonly string[]).includes(value);
}

/**
 * The payment-routing slices. `routed` is the set `compute_payslip` will pick up;
 * `unrouted` is the set that is approved but attached to no run — the one an
 * admin must act on before the run is computed, and the reason this screen exists
 * next to the runs list.
 */
export const CLAIM_SLICE_FILTERS = {
  awaiting: [inList("status", ["pending", "in_progress", "escalated"])] as readonly Filter[],
  routed: [
    eq("status", "approved"),
    isNotNull("paid_via_payroll_run_id"),
  ] as readonly Filter[],
  unrouted: [eq("status", "approved"), isNull("paid_via_payroll_run_id")] as readonly Filter[],
  paid: [isNotNull("paid_on")] as readonly Filter[],
} as const;

export type ClaimSlice = keyof typeof CLAIM_SLICE_FILTERS;

export function isClaimSlice(value: string | null): value is ClaimSlice {
  return value === "awaiting" || value === "routed" || value === "unrouted" || value === "paid";
}

/**
 * Which of a claim's three dates places it in a month.
 *
 * "This month" is three different numbers and the venue's own claims prove it:
 * CLM-2026-000003 covers 26-30 AUGUST and was filed on 2 SEPTEMBER. So for September the
 * total is 6,148 by expense period, 12,118 by filing date and 0 by payment date — all three
 * correct answers to different questions. The basis is therefore chosen, never assumed.
 *
 * Mirrors `public.claim_period_basis`, so the table's filter and the summary's total cannot
 * disagree about which rows are in the period.
 */
export const CLAIM_PERIOD_BASES = ["period", "filed", "paid"] as const;
export type ClaimPeriodBasis = (typeof CLAIM_PERIOD_BASES)[number];

export function isClaimPeriodBasis(value: string | null): value is ClaimPeriodBasis {
  return value === "period" || value === "filed" || value === "paid";
}

export interface ClaimFilters {
  readonly slice?: ClaimSlice | null;
  readonly claimType?: ClaimType | null;
  readonly runId?: string | null;
  /** Inclusive period. Omit both to read every claim ever filed. */
  readonly from?: string | null;
  readonly to?: string | null;
  readonly basis?: ClaimPeriodBasis | null;
  readonly employeeId?: string | null;
  /**
   * Read the whole queue, whatever period is on screen.
   *
   * Set when the Pending band is selected. A claim awaiting a decision belongs to no month —
   * its expense period can sit in August while it was filed in September — and a date filter
   * over an approval queue hides work rather than narrowing a report.
   */
  readonly ignorePeriod?: boolean;
}

/**
 * ONE predicate builder feeds the rows AND the count (DR-29), and now the summary reads the
 * same period on the same basis — so a tile can never describe a different row set from the
 * table beneath it.
 *
 * `period_to` is nullable on older claims, which is why the `period` basis cannot simply
 * filter that column: a row with no period would vanish from the table while still counting
 * in the summary, and a total that disagrees with its own list is worse than no total. The
 * summary falls back to the filing date for exactly the same rows; PostgREST cannot express
 * that COALESCE, so the table falls back by asking for either.
 */
export function claimFilters(f: ClaimFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.slice != null) filters.push(...CLAIM_SLICE_FILTERS[f.slice]);
  if (f.claimType != null) filters.push(eq("claim_type", f.claimType));
  if (f.runId != null && f.runId !== "") filters.push(eq("paid_via_payroll_run_id", f.runId));
  if (f.employeeId != null && f.employeeId !== "") filters.push(eq("employee_id", f.employeeId));

  const basis: ClaimPeriodBasis = f.basis ?? "period";
  const from = f.from ?? null;
  const to = f.to ?? null;
  if (from !== null && to !== null && f.ignorePeriod !== true) {
    if (basis === "filed") {
      /*
        ── AN IST CIVIL DATE AGAINST A TIMESTAMPTZ NEEDS IST BOUNDS ───────────
        `created_at` is a timestamptz. Comparing it to the bare string '2026-09-01' makes
        Postgres read UTC midnight — so a claim filed at 02:00 IST on 1 September, which is
        20:30 UTC on 31 August, would fall OUTSIDE the month. Five and a half hours of every
        boundary day would be attributed to the wrong month, silently.

        `istDayUtcBounds` converts the civil date to the real instants: 00:00 IST to 00:00 IST
        the next day. The upper bound is exclusive, which is why `lt` and not `lte`.

        The ESLint rule that forbids deriving dates from `toISOString()` is what found this —
        the first version built the bound with UTC date arithmetic and was wrong by those hours.
      */
      /*
        `nowInstantIso` rather than `.toISOString()`: the repo bans the latter because it is
        how a BUSINESS date gets derived from a UTC instant. These are genuine instants — the
        two ends of an IST day — and the helper is the sanctioned way to render one, so an
        exception here would only become the next person's precedent for a real bug.
      */
      filters.push(
        gte("created_at", nowInstantIso(istDayUtcBounds(from).startUtc)),
        lt("created_at", nowInstantIso(istDayUtcBounds(to).endUtc)),
      );
    } else if (basis === "paid") {
      // An unpaid claim has no payment date and belongs in no month on this basis.
      filters.push(isNotNull("paid_on"), gte("paid_on", from), lte("paid_on", to));
    } else {
      /*
        The expense period, filtered STRICTLY on `period_to`.

        A first version tried a PostgREST `or` so a claim with no `period_to` could fall back
        to its filing date. `Filter` has no `or` — the union is eq/neq/gt/gte/lt/lte, like,
        is, not_is, in, contains — so that took a `as unknown as Filter` cast and would have
        shipped a filter the query builder silently ignored. Casting past the type to reach an
        operator that does not exist is how a screen ends up showing every claim ever filed
        while claiming to show one month.

        So both sides are strict instead, and the summary counts what strictness excludes:
        `undated_count` is claims with no expense period, surfaced on the page rather than
        quietly missing from the total. Zero of the live claims are undated; the count exists
        so that if one ever is, it says so.
      */
      filters.push(gte("period_to", from), lte("period_to", to));
    }
  }
  return filters;
}

export function fetchReimbursementClaims(
  f: ClaimFilters,
  signal?: AbortSignal,
): Promise<ReimbursementClaim[]> {
  return selectMany(REIMBURSEMENT_CLAIMS_TABLE, reimbursementClaimSchema, {
    columns: CLAIM_COLUMNS,
    filters: claimFilters(f),
    order: [{ column: "created_at", ascending: false }],
    limit: REGISTER_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countReimbursementClaims(
  f: ClaimFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(REIMBURSEMENT_CLAIMS_TABLE, claimFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// =============================================================================
// 3. Statutory — `/admin/payroll/statutory`
// =============================================================================

/**
 * The rate set a run PINNED (`payroll_runs.statutory_settings_id`), so a reprint
 * of an old run shows the ceilings that were in force then, not today's.
 * Percentages are printed exactly as stored; not one of them is applied here.
 */
export const statutorySettingsSchema = z.object({
  id: dbUuid,
  effective_from: dbDate,
  effective_to: dbDateNullable,
  pf_employee_pct: dbNumeric,
  pf_employer_pct: dbNumeric,
  pf_wage_ceiling_paise: dbInt,
  pf_admin_charges_pct: dbNumeric,
  eps_pct: dbNumeric,
  edli_pct: dbNumeric,
  esi_employee_pct: dbNumeric,
  esi_employer_pct: dbNumeric,
  esi_wage_ceiling_paise: dbInt,
  pt_state: z.string(),
  pt_slabs: z.unknown(),
  lwf_employee_amount_paise: dbInt,
  lwf_employer_amount_paise: dbInt,
  lwf_frequency: z.string(),
  overtime_multiplier_statutory: dbNumeric,
  notes: z.string().nullable(),
});
export type StatutorySettings = z.infer<typeof statutorySettingsSchema>;

const STATUTORY_SETTINGS_COLUMNS =
  "id, effective_from, effective_to, pf_employee_pct, pf_employer_pct, pf_wage_ceiling_paise, " +
  "pf_admin_charges_pct, eps_pct, edli_pct, esi_employee_pct, esi_employer_pct, " +
  "esi_wage_ceiling_paise, pt_state, pt_slabs, lwf_employee_amount_paise, " +
  "lwf_employer_amount_paise, lwf_frequency, overtime_multiplier_statutory, notes";

export function fetchStatutorySettings(
  settingsId: string,
  signal?: AbortSignal,
): Promise<StatutorySettings | null> {
  return selectOne(STATUTORY_SETTINGS_TABLE, statutorySettingsSchema, [eq("id", settingsId)], {
    columns: STATUTORY_SETTINGS_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `statutory_settings.pt_slabs` is documented as
 * `[{"from":0,"to":2499999,"amount":0},…]` in integer paise. This DECODES it and
 * returns null when the shape does not match, so a schema drift shows as "the
 * slab table could not be read" rather than as a plausible wrong slab.
 */
const ptSlabSchema = z.object({
  from: dbInt,
  to: dbIntNullable,
  amount: dbInt,
});
export type PtSlab = z.infer<typeof ptSlabSchema>;

export function readPtSlabs(value: unknown): PtSlab[] | null {
  const parsed = z.array(ptSlabSchema).safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The statutory heads, each as the set of `salary_components.code` values
 * `compute_payslip` writes for it (migration 023 §PF/ESI/PT/LWF/TDS). Codes, not
 * guesses: `EPS_ER` and `EDLI_ER` are separate employer lines inside PF, and
 * `GRATUITY_PROV` is a provision rather than a remittance, so it is its own head.
 */
export const STATUTORY_HEADS = {
  pf: ["PF_EE", "PF_ER", "EPS_ER", "EDLI_ER"],
  esi: ["ESI_EE", "ESI_ER"],
  pt: ["PT"],
  lwf: ["LWF_EE", "LWF_ER"],
  tds: ["TDS"],
  gratuity: ["GRATUITY_PROV"],
} as const satisfies Record<string, readonly string[]>;

export type StatutoryHead = keyof typeof STATUTORY_HEADS;

export const STATUTORY_HEAD_KEYS = ["pf", "esi", "pt", "lwf", "tds", "gratuity"] as const;

export function isStatutoryHead(value: string | null): value is StatutoryHead {
  return value !== null && (STATUTORY_HEAD_KEYS as readonly string[]).includes(value);
}

/** Every statutory code, for the "all heads" register. */
export const ALL_STATUTORY_CODES: readonly string[] = STATUTORY_HEAD_KEYS.flatMap(
  (head) => STATUTORY_HEADS[head],
);

export function statutoryLineFilters(runId: string, head: StatutoryHead | null): Filter[] {
  const codes = head === null ? ALL_STATUTORY_CODES : STATUTORY_HEADS[head];
  return [eq("payroll_run_id", runId), inList("component_code", codes)];
}

/**
 * The statutory register at LINE grain — one row per employee per head, with the
 * amount, the YTD figure and `calc_basis` (the wage the rate was applied to),
 * all straight off `v_payslip_detail`.
 *
 * This is not pivoted into one row per employee on purpose: an employee can carry
 * two lines for the same code in a run (a regular line plus an arrear line), and
 * collapsing them would require adding them up in the browser.
 */
export function fetchStatutoryLines(
  runId: string,
  head: StatutoryHead | null,
  signal?: AbortSignal,
): Promise<PayslipLine[]> {
  return selectMany(V_PAYSLIP_DETAIL, payslipLineSchema, {
    filters: statutoryLineFilters(runId, head),
    order: [
      { column: "employee_code", ascending: true },
      { column: "sequence", ascending: true },
    ],
    limit: LINE_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countStatutoryLines(
  runId: string,
  head: StatutoryHead | null,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_PAYSLIP_DETAIL, statutoryLineFilters(runId, head), {
    ...(signal ? { signal } : {}),
  });
}

// =============================================================================
// 4. Form 16 — `/admin/payroll/form16`
// =============================================================================

/**
 * `form16_documents` (migration 022 §7): one row per employee per financial year
 * per part, unique on all three. `distributed_at` and `acknowledged_at` are the
 * delivery evidence — a Form 16 is not "issued" because a button was pressed.
 */
export const form16DocumentSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  financial_year: z.string(),
  part: z.string(),
  document_id: dbUuidNullable,
  tan: z.string().nullable(),
  certificate_number: z.string().nullable(),
  total_income_paise: dbIntNullable,
  total_tds_paise: dbIntNullable,
  issued_on: dbDateNullable,
  distributed_at: dbTimestampNullable,
  acknowledged_at: dbTimestampNullable,
  traces_reference: z.string().nullable(),
  created_at: dbTimestamp,
});
export type Form16Document = z.infer<typeof form16DocumentSchema>;

const FORM16_COLUMNS =
  "id, employee_id, financial_year, part, document_id, tan, certificate_number, " +
  "total_income_paise, total_tds_paise, issued_on, distributed_at, acknowledged_at, " +
  "traces_reference, created_at";

export interface Form16Filters {
  readonly financialYear?: string | null;
  readonly part?: string | null;
}

export function form16Filters(f: Form16Filters): Filter[] {
  const filters: Filter[] = [];
  if (f.financialYear != null && f.financialYear !== "")
    filters.push(eq("financial_year", f.financialYear));
  if (f.part != null && f.part !== "") filters.push(eq("part", f.part));
  return filters;
}

export function fetchForm16Documents(
  f: Form16Filters,
  signal?: AbortSignal,
): Promise<Form16Document[]> {
  return selectMany(FORM16_DOCUMENTS_TABLE, form16DocumentSchema, {
    columns: FORM16_COLUMNS,
    filters: form16Filters(f),
    order: [
      { column: "financial_year", ascending: false },
      { column: "created_at", ascending: false },
    ],
    limit: REGISTER_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countForm16Documents(f: Form16Filters, signal?: AbortSignal): Promise<number> {
  return selectCount(FORM16_DOCUMENTS_TABLE, form16Filters(f), { ...(signal ? { signal } : {}) });
}

// =============================================================================
// 5. Bank advice — `/admin/payroll/bank-advice`
// =============================================================================

/**
 * `bank_advice_batches` (migration 022 §6). `total_amount_paise`, `record_count`
 * and `checksum` are written by the exporting job; the browser prints them so an
 * operator can tie the file to the run before it goes to the bank.
 */
export const bankAdviceBatchSchema = z.object({
  id: dbUuid,
  payroll_run_id: dbUuid,
  batch_number: z.string(),
  bank_name: z.string().nullable(),
  format: z.string(),
  value_date: dbDateNullable,
  total_amount_paise: dbInt,
  record_count: dbInt,
  file_document_id: dbUuidNullable,
  checksum: z.string().nullable(),
  status: z.string(),
  downloaded_by: dbUuidNullable,
  downloaded_at: dbTimestampNullable,
  bank_reference: z.string().nullable(),
  created_at: dbTimestamp,
});
export type BankAdviceBatch = z.infer<typeof bankAdviceBatchSchema>;

const BATCH_COLUMNS =
  "id, payroll_run_id, batch_number, bank_name, format, value_date, total_amount_paise, " +
  "record_count, file_document_id, checksum, status, downloaded_by, downloaded_at, " +
  "bank_reference, created_at";

export function bankAdviceFilters(runId: string | null): Filter[] {
  return runId != null && runId !== "" ? [eq("payroll_run_id", runId)] : [];
}

export function fetchBankAdviceBatches(
  runId: string | null,
  signal?: AbortSignal,
): Promise<BankAdviceBatch[]> {
  return selectMany(BANK_ADVICE_BATCHES_TABLE, bankAdviceBatchSchema, {
    columns: BATCH_COLUMNS,
    filters: bankAdviceFilters(runId),
    order: [{ column: "created_at", ascending: false }],
    limit: REGISTER_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countBankAdviceBatches(
  runId: string | null,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(BANK_ADVICE_BATCHES_TABLE, bankAdviceFilters(runId), {
    ...(signal ? { signal } : {}),
  });
}

/**
 * The payment side of a payslip — the columns a bank advice is built from.
 * `payslips` grants SELECT only, so this is the whole story the browser gets.
 */
export const payslipPaymentSchema = z.object({
  id: dbUuid,
  payslip_number: z.string(),
  employee_id: dbUuid,
  payroll_run_id: dbUuid,
  net_pay_paise: dbInt,
  payment_mode: z.string(),
  payment_status: z.string(),
  payment_reference: z.string().nullable(),
  paid_on: dbDateNullable,
  bank_advice_batch_id: dbUuidNullable,
  bank_account_id: dbUuidNullable,
  is_reversed: z.boolean(),
  reversed_by_payslip_id: dbUuidNullable,
  pay_date: dbDate,
});
export type PayslipPayment = z.infer<typeof payslipPaymentSchema>;

const PAYSLIP_PAYMENT_COLUMNS =
  "id, payslip_number, employee_id, payroll_run_id, net_pay_paise, payment_mode, " +
  "payment_status, payment_reference, paid_on, bank_advice_batch_id, bank_account_id, " +
  "is_reversed, reversed_by_payslip_id, pay_date";

/** `ck_payslips__payment_status` — the six deployed payment states. */
export const PAYMENT_STATUSES = [
  "pending",
  "in_batch",
  "paid",
  "failed",
  "held",
  "reversed",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(value: string | null): value is PaymentStatus {
  return value !== null && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export interface PayslipPaymentFilters {
  readonly runId?: string | null;
  readonly batchId?: string | null;
  readonly paymentStatus?: PaymentStatus | null;
  /** True → only payslips attached to no batch yet. */
  readonly unbatched?: boolean;
}

export function payslipPaymentFilters(f: PayslipPaymentFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.runId != null && f.runId !== "") filters.push(eq("payroll_run_id", f.runId));
  if (f.batchId != null && f.batchId !== "")
    filters.push(eq("bank_advice_batch_id", f.batchId));
  if (f.paymentStatus != null) filters.push(eq("payment_status", f.paymentStatus));
  if (f.unbatched === true) filters.push(isNull("bank_advice_batch_id"));
  return filters;
}

export function fetchPayslipPayments(
  f: PayslipPaymentFilters,
  signal?: AbortSignal,
): Promise<PayslipPayment[]> {
  return selectMany(PAYSLIPS_TABLE, payslipPaymentSchema, {
    columns: PAYSLIP_PAYMENT_COLUMNS,
    filters: payslipPaymentFilters(f),
    order: [{ column: "payslip_number", ascending: true }],
    limit: REGISTER_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countPayslipPayments(
  f: PayslipPaymentFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(PAYSLIPS_TABLE, payslipPaymentFilters(f), { ...(signal ? { signal } : {}) });
}

// =============================================================================
// 6. Arrears & reversals — `/admin/payroll/arrears`
// =============================================================================

/**
 * `payroll_runs.run_kind` (ck constraint, migration 022): regular | off_cycle |
 * arrears | bonus | full_and_final | correction. A closed run is immutable —
 * `trg_payroll_runs__immutable` raises "corrections require an arrears run" — so
 * these two kinds ARE the correction mechanism, and that is why this screen lists
 * them rather than offering an edit.
 */
export const ARREARS_RUN_KINDS = ["arrears", "correction"] as const;

export function fetchArrearsRuns(
  kinds: readonly string[],
  signal?: AbortSignal,
): Promise<PayrollRun[]> {
  return selectMany(PAYROLL_RUNS_TABLE, payrollRunSchema, {
    filters: [inList("run_kind", kinds)],
    order: [{ column: "created_at", ascending: false }],
    limit: REGISTER_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function arrearLineFilters(runId: string | null): Filter[] {
  const filters: Filter[] = [isTrue("is_arrear")];
  if (runId != null && runId !== "") filters.push(eq("payroll_run_id", runId));
  return filters;
}

/**
 * Every arrear LINE — `payslip_lines.is_arrear` with `arrear_for_period_id`
 * naming the period being corrected, plus `calc_basis` as the proof. This is the
 * trace the manifest asks for; nothing is recomputed to produce it.
 */
export function fetchArrearLines(
  runId: string | null,
  signal?: AbortSignal,
): Promise<PayslipLine[]> {
  return selectMany(V_PAYSLIP_DETAIL, payslipLineSchema, {
    filters: arrearLineFilters(runId),
    order: [
      { column: "employee_code", ascending: true },
      { column: "sequence", ascending: true },
    ],
    limit: LINE_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countArrearLines(runId: string | null, signal?: AbortSignal): Promise<number> {
  return selectCount(V_PAYSLIP_DETAIL, arrearLineFilters(runId), {
    ...(signal ? { signal } : {}),
  });
}

export function reversedPayslipFilters(runId: string | null): Filter[] {
  const filters: Filter[] = [isTrue("is_reversed")];
  if (runId != null && runId !== "") filters.push(eq("payroll_run_id", runId));
  return filters;
}

/** Reversed payslips: the run never edits a published slip, it reverses and reissues. */
export function fetchReversedPayslips(
  runId: string | null,
  signal?: AbortSignal,
): Promise<PayslipPayment[]> {
  return selectMany(PAYSLIPS_TABLE, payslipPaymentSchema, {
    columns: PAYSLIP_PAYMENT_COLUMNS,
    filters: reversedPayslipFilters(runId),
    order: [{ column: "pay_date", ascending: false }],
    limit: REGISTER_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countReversedPayslips(
  runId: string | null,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(PAYSLIPS_TABLE, reversedPayslipFilters(runId), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Recording that a claim was paid (migration 040700)
// -----------------------------------------------------------------------------

export const RECORD_CLAIM_PAYMENT_FN = "record_claim_payment";

/** `public.payment_mode`, the enum the RPC takes. */
export const claimPaymentModeValues = ["bank_transfer", "cash", "cheque", "upi"] as const;
export type ClaimPaymentMode = (typeof claimPaymentModeValues)[number];

const claimPaymentResultSchema = z.object({
  id: dbUuid,
  claim_number: z.string(),
  payment_mode: z.string(),
  paid_on: z.string(),
  payment_reference: z.string().nullable(),
});
export type ClaimPaymentResult = z.infer<typeof claimPaymentResultSchema>;

export interface RecordClaimPaymentInput {
  readonly claimId: string;
  readonly mode: ClaimPaymentMode;
  /** Civil date, 'YYYY-MM-DD'. The RPC refuses a future one. */
  readonly paidOn: string;
  /** Required for everything but cash — the RPC refuses a non-cash payment without it. */
  readonly reference: string | null;
}

/**
 * Record how and when an approved claim was paid.
 *
 * Through the definer RPC rather than an UPDATE, because the rules are about the
 * row's CURRENT STATE — approved, not already paid, not future-dated, and
 * traceable if it was not cash — and RLS can express who may write, not which
 * transitions are legal.
 *
 * `rpcAudited`, so the operator's own sentence rides the `x-reason` header into
 * `app.reason` and the audit row for a payment says why it was made.
 */
export async function recordClaimPayment(
  input: RecordClaimPaymentInput,
  reason: string,
  signal?: AbortSignal,
): Promise<ClaimPaymentResult | null> {
  const rows = await rpcAudited(
    RECORD_CLAIM_PAYMENT_FN,
    {
      p_claim_id: input.claimId,
      p_mode: input.mode,
      p_paid_on: input.paidOn,
      p_reference: input.reference,
    },
    claimPaymentResultSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, ...(signal ? { signal } : {}) },
  );
  return rows[0] ?? null;
}

// -----------------------------------------------------------------------------
// Who has no reporting manager
// -----------------------------------------------------------------------------

/**
 * Employees with no `reporting_manager_id`.
 *
 * Not a curiosity: level 1 of the claim chain is `reporting_manager`, and
 * `resolve_approvers` falls back to hr_admin when it cannot resolve one. So
 * every person in this list has their claims land on an administrator instead of
 * on the person who knows whether the expense was justified. The count belongs
 * on the screen that receives those claims, because that is who feels it.
 */
export function countEmployeesWithoutManager(signal?: AbortSignal): Promise<number> {
  return selectCount(V_ADMIN_EMPLOYEE, [
    isNull("reporting_manager_id"),
    isNull("deleted_at"),
    inList("employment_status", ["active", "probation", "notice", "pre_joining"]),
  ], { ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// Overdue claims an administrator may take over
// -----------------------------------------------------------------------------

export const APPROVAL_REQUESTS_TABLE_NAME = "approval_requests";

export const overdueClaimApprovalSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  detail_id: dbUuid,
  subject_employee_id: dbUuid,
  sla_due_at: dbTimestamp,
  current_level: dbInt,
});
export type OverdueClaimApproval = z.infer<typeof overdueClaimApprovalSchema>;

/**
 * Claim approvals whose SLA has run out, for an administrator to take over.
 *
 * REPORTED: "even super-admin is not able to approve until manager has not
 * approved… if manager has not approved within 72 hours then admin can also
 * approve it."
 *
 * THE SERVER ALWAYS ALLOWED IT. `act_on_approval` checks
 * `IF NOT (v_is_approver OR v_is_admin)` — an administrator has been able to act
 * at any level since the engine was written, and `ar__admin_read` lets them see
 * every request. What refused was the SCREEN: its buttons come from
 * `v_approval_inbox`, which ends `app.current_employee_id() = ANY
 * (ar.current_approver_ids)`, so an admin who was not the CURRENT approver had
 * nothing to click.
 *
 * THE DEADLINE APPLIES TO ONE ROLE, WHICH IS WHY IT IS A PARAMETER.
 *
 * "72 hours restriction was for admin — if manager has not approved within 72
 * hours then admin can approve. super-admin has no restriction."
 *
 *   super_admin  →  `requireOverdue = false`. Every open claim, immediately.
 *   admin        →  `requireOverdue = true`. Only once the request has run past
 *                   `sla_due_at`, i.e. the manager has had their 72 hours.
 *
 * `sla_due_at` is set by `create_approval_request` as
 * `submitted_at + request_types.sla_hours`, and LOCAL_CLAIM is seeded at 72 —
 * so the 72 hours is the SLA the employee was already shown, not a number
 * invented here.
 *
 * THE CALLER MUST PASS THE ROLE, NOT A CAPABILITY. `capsForRoles` grants
 * `admin.super` to the `admin` role as well (a deliberate product decision), so
 * capabilities cannot tell the two apart — only `user_roles` can. Getting that
 * wrong would silently give every admin the unrestricted power.
 *
 * Either way `subject_employee_id <> me`: an admin is exempt from
 * `act_on_approval`'s self-approval refusal, so nothing else would stop them
 * approving their own claim.
 *
 * `subject_employee_id <> me` because an admin IS exempt from the self-approval
 * refusal (`act_on_approval` excuses `v_is_admin`), so nothing else would stop
 * an administrator approving their own overdue claim. A deadline should hand the
 * decision to someone else, never to the claimant.
 */
export function fetchOverdueClaimApprovals(
  myEmployeeId: string,
  requireOverdue: boolean,
  signal?: AbortSignal,
): Promise<OverdueClaimApproval[]> {
  return selectMany(APPROVAL_REQUESTS_TABLE_NAME, overdueClaimApprovalSchema, {
    columns: "id, request_number, detail_id, subject_employee_id, sla_due_at, current_level",
    filters: [
      eq("detail_table", "reimbursement_claims"),
      inList("status", ["pending", "in_progress", "escalated"]),
      ...(requireOverdue ? [lt("sla_due_at", nowInstantIso())] : []),
      neq("subject_employee_id", myEmployeeId),
    ],
    order: [{ column: "sla_due_at", ascending: true }],
    limit: REGISTER_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}
