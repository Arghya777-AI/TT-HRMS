/**
 * analytics-ops.api.ts — reads for the FIVE operational analytics screens
 * (§14): payroll cost, kiosk health, compliance coverage, the metric dictionary
 * and the export catalogue.
 *
 * Everything here is a SELECT. There is no write path on any analytics screen,
 * and there is no arithmetic in this file: every figure a screen prints is a
 * column a Postgres view computed, or a `count=exact` Postgres returned.
 *
 * The four relations these screens read, and what each one's GRAIN is — the
 * grain is the whole story, because it decides what can honestly be shown:
 *
 *  1. `v_payroll_cost_monthly` — one row per (pay period × department × cost
 *     centre) over `analytics.mv_payroll_cost_monthly`, admin-gated. It carries
 *     `total_cost_paise` (§9.2 gross + employer contributions),
 *     `cost_per_employee_paise` and `overtime_share_pct` AT THAT GRAIN. There is
 *     no org-total row in it, so the org-level trend is read from
 *     `payroll_runs.total_gross_paise` / `total_employer_cost_paise` instead —
 *     the run header totals, filtered to the SAME statuses the matview uses
 *     (RELEASED_RUN_STATUSES), so the two cannot disagree.
 *  2. `v_kiosk_health` — one row per (device × IST day) that saw an attempt.
 *     `match_success_pct` and the p50/p95 latencies exist ONLY at that grain;
 *     there is no org-wide match rate anywhere in the database, and this file
 *     does not invent one (a ratio cannot be summed).
 *  3. `v_document_compliance` — one row per (employee × required document type),
 *     with the server's `compliance_status` verdict and its own 60-day
 *     `expiring_soon` window. Counted, never grouped in the client.
 *  4. `v_enrolment_coverage` — GAP ROWS ONLY. Employees who are fully enrolled
 *     are not in it, so it can answer "how many gaps" but never "what share of
 *     the workforce is covered". The screen says so rather than dividing by a
 *     headcount from a different relation.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  lte,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { V_ENROLMENT_COVERAGE, V_KIOSK_HEALTH } from "./system.api";
import { V_DOCUMENT_COMPLIANCE } from "./audit.api";
import { V_FACE_MATCH_AUDIT } from "./kiosk.api";

export const V_PAYROLL_COST_MONTHLY = "v_payroll_cost_monthly";

/** Hard row cap on every analytics read — an unbounded matview is not a page. */
export const ANALYTICS_ROW_CAP = 500;

// -----------------------------------------------------------------------------
// 1. Payroll cost — v_payroll_cost_monthly (period × department × cost centre)
// -----------------------------------------------------------------------------

export const payrollCostRowSchema = z.object({
  year: dbInt,
  month: dbInt,
  pay_period_id: dbUuid,
  pay_period_code: z.string(),
  department_id: dbUuidNullable,
  /** COALESCEd department id — the matview's unique-index key, never a label. */
  department_key: dbUuid,
  department_name: z.string().nullable(),
  cost_centre_id: dbUuidNullable,
  cost_centre_key: dbUuid,
  cost_centre_name: z.string().nullable(),
  employee_count: dbInt,
  gross_paise: dbInt,
  deductions_paise: dbInt,
  net_paise: dbInt,
  employer_cost_paise: dbInt,
  /** §9.2 Payroll Cost = gross earnings + employer contributions. */
  total_cost_paise: dbInt,
  /** §9.2 Cost per Employee, at THIS row's grain. Null when nobody was paid. */
  cost_per_employee_paise: dbIntNullable,
  overtime_cost_paise: dbInt,
  /** Already a percentage, already clamped by the view. */
  overtime_share_pct: dbNumericNullable,
  /** When the matview was last refreshed — printed as "as of" on the screen. */
  refreshed_at: dbTimestamp,
});
export type PayrollCostRow = z.infer<typeof payrollCostRowSchema>;

export interface PayrollCostFilters {
  readonly payPeriodIds?: readonly string[];
  readonly departmentIds?: readonly string[];
  readonly costCentreIds?: readonly string[];
  readonly year?: number;
}

function payrollCostFilters(f: PayrollCostFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.payPeriodIds !== undefined && f.payPeriodIds.length > 0) {
    filters.push(inList("pay_period_id", f.payPeriodIds));
  }
  if (f.departmentIds !== undefined && f.departmentIds.length > 0) {
    filters.push(inList("department_id", f.departmentIds));
  }
  if (f.costCentreIds !== undefined && f.costCentreIds.length > 0) {
    filters.push(inList("cost_centre_id", f.costCentreIds));
  }
  if (f.year !== undefined) filters.push(eq("year", f.year));
  return filters;
}

/**
 * Cost rows at the matview's own grain, newest period first and the biggest
 * cost first inside a period — the order the "where does the money go" question
 * is actually asked in.
 */
export function fetchPayrollCost(
  f: PayrollCostFilters = {},
  limit = ANALYTICS_ROW_CAP,
  signal?: AbortSignal,
): Promise<PayrollCostRow[]> {
  return selectMany(V_PAYROLL_COST_MONTHLY, payrollCostRowSchema, {
    filters: payrollCostFilters(f),
    order: [
      { column: "year", ascending: false },
      { column: "month", ascending: false },
      { column: "total_cost_paise", ascending: false },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/** The same predicate, counted by Postgres — the grid's "N rows" figure. */
export function countPayrollCost(
  f: PayrollCostFilters = {},
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_PAYROLL_COST_MONTHLY, payrollCostFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Kiosk — outcome counts from v_face_match_audit (the per-attempt log)
// -----------------------------------------------------------------------------

/**
 * The outcome buckets `v_kiosk_health` publishes as its own columns, in the
 * order the funnel reads. `capture_failures` folds no_face + multiple_faces +
 * low_quality IN SQL; the client never adds those three up itself.
 */
export const KIOSK_OUTCOME_COLUMNS = [
  "matched",
  "no_match",
  "ambiguous",
  "liveness_failures",
  "capture_failures",
  "errors",
  "duplicates_suppressed",
] as const;
export type KioskOutcomeColumn = (typeof KIOSK_OUTCOME_COLUMNS)[number];

export interface MatchAttemptFilters {
  /** Inclusive IST business-date window. */
  readonly from: string;
  readonly to: string;
  readonly deviceIds?: readonly string[];
  /** `secure.face_match_log.outcome` values — the log's vocabulary, not ours. */
  readonly outcomes?: readonly string[];
}

function matchAttemptFilters(f: MatchAttemptFilters): Filter[] {
  const filters: Filter[] = [gte("ist_date", f.from), lte("ist_date", f.to)];
  if (f.deviceIds !== undefined && f.deviceIds.length > 0) {
    filters.push(inList("kiosk_device_id", f.deviceIds));
  }
  if (f.outcomes !== undefined && f.outcomes.length > 0) {
    filters.push(inList("outcome", f.outcomes));
  }
  return filters;
}

/**
 * How many identification attempts landed in a given outcome over a window.
 *
 * This is a COUNT, not a rate. The rate lives in `v_kiosk_health` per device per
 * day; dividing two counts from this function would be exactly the client-side
 * ratio the contract bans, and it would silently disagree with the view.
 */
export function countMatchAttempts(
  f: MatchAttemptFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_FACE_MATCH_AUDIT, matchAttemptFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Compliance — document expiry counts + the enrolment/consent gap list
// -----------------------------------------------------------------------------

/** `v_document_compliance.compliance_status`, the view's own CASE arms. */
export const COMPLIANCE_STATUSES = ["missing", "expired", "expiring_soon", "valid"] as const;
export type ComplianceStatusValue = (typeof COMPLIANCE_STATUSES)[number];

export interface DocumentComplianceFilters {
  readonly statuses?: readonly string[];
  readonly departmentIds?: readonly string[];
}

function documentComplianceFilters(f: DocumentComplianceFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.statuses !== undefined && f.statuses.length > 0) {
    filters.push(inList("compliance_status", f.statuses));
  }
  if (f.departmentIds !== undefined && f.departmentIds.length > 0) {
    filters.push(inList("department_id", f.departmentIds));
  }
  return filters;
}

/**
 * One tile = one `count=exact` with the SAME filters the grid below uses, so a
 * tile and its drill-through cannot disagree (the "7 vs 8" defect).
 */
export function countDocumentCompliance(
  f: DocumentComplianceFilters = {},
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_DOCUMENT_COMPLIANCE, documentComplianceFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

/** `v_enrolment_coverage.gap_kind` — the three ways the gate can be unusable. */
export const ENROLMENT_GAP_KINDS = [
  "no_consent",
  "consented_not_enrolled",
  "consent_withdrawn",
] as const;
export type EnrolmentGapKind = (typeof ENROLMENT_GAP_KINDS)[number];

export const enrolmentCoverageRowSchema = z.object({
  employee_id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  /*
    NULLABLE, because `employees.date_of_join` is (migration 008 declares it
    `date_of_join date` with no NOT NULL). A joiner recorded before their start
    date is agreed genuinely has none, and the bulk load of the venue's roster
    brought in 32 such records. Declaring it required turned that into a parse
    error that replaced the whole screen with "Something went wrong".
  */
  date_of_join: dbDateNullable,
  has_active_consent: z.boolean(),
  consent_granted_at: dbTimestampNullable,
  consent_withdrawn: z.boolean(),
  has_active_template: z.boolean(),
  face_enrolled_at: dbTimestampNullable,
  gap_kind: z.string().nullable(),
});
export type EnrolmentCoverageRow = z.infer<typeof enrolmentCoverageRowSchema>;

export interface EnrolmentCoverageFilters {
  readonly gapKinds?: readonly string[];
  readonly departmentIds?: readonly string[];
}

function enrolmentCoverageFilters(f: EnrolmentCoverageFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.gapKinds !== undefined && f.gapKinds.length > 0) {
    filters.push(inList("gap_kind", f.gapKinds));
  }
  if (f.departmentIds !== undefined && f.departmentIds.length > 0) {
    filters.push(inList("department_id", f.departmentIds));
  }
  return filters;
}

/**
 * The gap list, by department. `system.api.fetchEnrolmentGaps` reads the same
 * view for the enrolment QUEUE; this one exists because the analytics screen
 * needs the department and gap-kind predicates to match its tiles exactly.
 */
export function fetchEnrolmentCoverage(
  f: EnrolmentCoverageFilters = {},
  limit = ANALYTICS_ROW_CAP,
  signal?: AbortSignal,
): Promise<EnrolmentCoverageRow[]> {
  return selectMany(V_ENROLMENT_COVERAGE, enrolmentCoverageRowSchema, {
    filters: enrolmentCoverageFilters(f),
    order: [
      { column: "department_name", ascending: true },
      { column: "employee_code", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export function countEnrolmentCoverage(
  f: EnrolmentCoverageFilters = {},
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_ENROLMENT_COVERAGE, enrolmentCoverageFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Document rows for the compliance grid (department-filtered)
// -----------------------------------------------------------------------------

export const documentExpiryRowSchema = z.object({
  employee_id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  document_type_id: dbUuid,
  document_type_code: z.string(),
  document_type_name: z.string(),
  requires_expiry: z.boolean(),
  document_id: dbUuidNullable,
  document_status: z.string().nullable(),
  expiry_date: dbDateNullable,
  compliance_status: z.string(),
});
export type DocumentExpiryRow = z.infer<typeof documentExpiryRowSchema>;

/**
 * Expiry-first ordering: `expiry_date` ASC puts the document that lapses next at
 * the top, which is the order the action is taken in. NULLs (a MISSING document
 * has no expiry) sort last so they do not squat above live expiries.
 */
export function fetchDocumentExpiry(
  f: DocumentComplianceFilters = {},
  limit = ANALYTICS_ROW_CAP,
  signal?: AbortSignal,
): Promise<DocumentExpiryRow[]> {
  return selectMany(V_DOCUMENT_COMPLIANCE, documentExpiryRowSchema, {
    filters: documentComplianceFilters(f),
    order: [
      { column: "expiry_date", ascending: true, nullsFirst: false },
      { column: "employee_code", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. Kiosk health passthrough — the relation name, for the screen's honesty line
// -----------------------------------------------------------------------------

/** Re-exported so the kiosk screen can name its source without a second import. */
export const KIOSK_HEALTH_RELATION = V_KIOSK_HEALTH;
export const ENROLMENT_COVERAGE_RELATION = V_ENROLMENT_COVERAGE;
export const DOCUMENT_COMPLIANCE_RELATION = V_DOCUMENT_COMPLIANCE;
export const FACE_MATCH_AUDIT_RELATION = V_FACE_MATCH_AUDIT;
