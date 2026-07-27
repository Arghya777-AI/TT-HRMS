/**
 * apply-forms.api.ts — the reads behind the three remaining E-10 request
 * screens (travel requisition, resignation, income tax), and the ONE of the
 * three that the deployed backend can actually accept.
 *
 * Every name below was checked against the migrations first, because two of the
 * three request types name a detail table that no migration creates. The recon,
 * in full:
 *
 *  * `request_types` (029 §1, seeded 045 §2) HAS all three codes —
 *    `TRAVEL_REQUISITION` (`detail_table = 'travel_requisitions'`, SLA 48h),
 *    `RESIGNATION` (`'resignations'`, 72h) and `IT_DECLARATION`
 *    (`'income_tax_declarations'`, 48h). All three tables are MISSING: each name
 *    appears only as a string, in `ck_request_types__detail_table` (029) and in
 *    that seed row. 024's own header says it outright — "no travel_requisitions
 *    table exists anywhere in the §13 plan". `approval_requests.detail_id` is
 *    `NOT NULL`, so a request needs a detail row that has nowhere to live.
 *  * 045 §3 seeds approval chains for ELEVEN of the eighteen types. None of
 *    these three is among them and none has a
 *    `request_types.default_approval_chain_id`, so `create_approval_request`
 *    raises `no approval chain matches request type %`. Each screen proves that
 *    by READING `approval_chains` through `fetchRequestRouting`, not by claiming
 *    it in prose.
 *  * The exception is the tax screen's regime election, which has a complete
 *    server path and therefore really submits — see `submitRegimeElection`.
 *
 * What the two blocked screens show instead is real and self-scoped: the money
 * route that travel expense DOES take today (`reimbursement_claims`), and the
 * notice-period, gratuity and lifecycle facts an employee thinking about
 * resigning actually needs (`v_my_employee`, `grades`, `contracts`,
 * `employee_statutory`, `employee_lifecycle_events`).
 *
 * Nothing here mints a reference, computes a total, or converts a unit.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumeric,
  dbTimestamp,
  dbUuid,
  dbUuidNullable,
  eq,
  lte,
  rpcOne,
  selectMany,
  selectOne,
} from "@/shared/api/query";
import { insertOne } from "@/shared/api/write";
import { nowIstDate } from "@/lib/datetime";
/**
 * The enum vocabularies for `employment_status`, `employment_type`,
 * `employees.exit_type` and `lifecycle_event_type` are IMPORTED rather than
 * restated, for the reason `RequestRoutingCard` imports `admin/workflow-vocab`:
 * an employee and an administrator must not be able to read a different sentence
 * off the same row. `features/assets/api/my-assets.api.ts` already reaches into
 * `admin/api/assets.api.ts` the same way.
 */
import { employmentStatusSchema, employmentTypeSchema } from "@/features/admin/api/employees.api";
import { exitTypeValues, lifecycleEventTypeSchema } from "@/features/admin/api/lifecycle.api";
import { approvalStatusSchema, APPROVAL_REQUESTS_TABLE } from "./apply.api";
import { CREATE_APPROVAL_REQUEST_FN, MY_EMPLOYEE_VIEW } from "./apply-requests.api";

export const REIMBURSEMENT_CLAIMS_TABLE = "reimbursement_claims";
export const GRADES_TABLE = "grades";
export const CONTRACTS_TABLE = "contracts";
export const EMPLOYEE_LIFECYCLE_EVENTS_TABLE = "employee_lifecycle_events";
export const EMPLOYEE_CHANGE_REQUESTS_TABLE = "employee_change_requests";
export const STATUTORY_MASKED_VIEW = "v_employee_statutory_masked";
export const STATUTORY_SETTINGS_TABLE = "statutory_settings";

/** `request_types.code` values these three screens ask for, by name. */
export const REQUEST_CODE_TRAVEL = "TRAVEL_REQUISITION";
export const REQUEST_CODE_RESIGNATION = "RESIGNATION";
export const REQUEST_CODE_IT_DECLARATION = "IT_DECLARATION";
/**
 * The type that carries a statutory FIELD change through maker-checker. Its
 * `detail_table` IS `employee_change_requests` and 045 §3 gives it the
 * `AC-PROFILE` chain (one level, HR admin), which is why the regime election can
 * be raised while `IT_DECLARATION` cannot.
 */
export const REQUEST_CODE_PROFILE_CHANGE = "PROFILE_CHANGE";

/**
 * `employee_change_requests.entity_table` for a statutory field.
 * `ck_ecr__entity_table` (011 §2) whitelists exactly nine tables and
 * `'employee_statutory'` is one of them — the database's own statement that
 * statutory fields travel this way.
 */
export const ECR_ENTITY_STATUTORY = "employee_statutory";
/** `employee_statutory.tax_regime` — the column the election changes. */
export const ECR_FIELD_TAX_REGIME = "tax_regime";

// =============================================================================
// 1. Travel (E-10.4) — the money route that IS live
// =============================================================================

/**
 * `public.approval_status` as it applies to a CLAIM row rather than to the
 * request. Kept separate from the request's status for the reason
 * `claim-submit.api.ts` records: `act_on_approval` never writes back to a detail
 * table, so an approved claim's own `status` stays `pending` until Finance edits
 * the row.
 */
export const travelClaimSchema = z.object({
  id: dbUuid,
  /** Server-minted by `generate_claim_number()` (024). Never built here. */
  claim_number: z.string(),
  claim_kind: z.string(),
  period_from: dbDateNullable,
  period_to: dbDateNullable,
  /** Integer paise. */
  total_claimed_paise: dbIntNullable,
  /** Integer paise; NULL until Finance settles. */
  total_approved_paise: dbIntNullable,
  status: approvalStatusSchema,
  event_reference: z.string().nullable(),
  /**
   * `reimbursement_claims.travel_requisition_id` — a uuid with NO foreign key,
   * because the table it would point at does not exist (024 header note). It is
   * read, and rendered, precisely to show that it is always NULL.
   */
  travel_requisition_id: dbUuidNullable,
  paid_on: dbDateNullable,
  created_at: dbTimestamp,
});
export type TravelClaim = z.infer<typeof travelClaimSchema>;

const TRAVEL_CLAIM_COLUMNS =
  "id, claim_number, claim_kind, period_from, period_to, total_claimed_paise, " +
  "total_approved_paise, status, event_reference, travel_requisition_id, paid_on, created_at";

/** `ck_rc__claim_type`'s travel head — the one this screen's spend rides on. */
export const CLAIM_TYPE_TRAVEL = "travel";

const MY_CLAIMS_CAP = 50;

/**
 * My own travel-head claims, newest first. `rc__self__select` is the boundary;
 * the `claim_type` filter is the venue's own vocabulary from `ck_rc__claim_type`.
 */
export function fetchMyTravelClaims(
  employeeId: string,
  signal?: AbortSignal,
): Promise<TravelClaim[]> {
  return selectMany(REIMBURSEMENT_CLAIMS_TABLE, travelClaimSchema, {
    columns: TRAVEL_CLAIM_COLUMNS,
    filters: [eq("employee_id", employeeId), eq("claim_type", CLAIM_TYPE_TRAVEL)],
    order: [{ column: "created_at", ascending: false }],
    limit: MY_CLAIMS_CAP,
    ...(signal ? { signal } : {}),
  });
}

// =============================================================================
// 2. Resignation (E-10.3) — the notice period, and where the exit already stands
// =============================================================================

/**
 * The `v_my_employee` columns the resignation screen renders, and only those.
 * The view is `SELECT e.* FROM employees WHERE id = app.current_employee_id()`
 * (033), so no filter is needed and none is passed.
 *
 * `notice_period_days` is `NOT NULL DEFAULT 30` on `employees` (008 line 56) —
 * there is always a figure, so the screen never has to fall back to a constant.
 */
export const myNoticeEmployeeSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  employment_status: employmentStatusSchema,
  employment_type: employmentTypeSchema,
  date_of_join: dbDateNullable,
  confirmed_on: dbDateNullable,
  confirmation_due_date: dbDateNullable,
  contract_end_date: dbDateNullable,
  notice_period_days: dbInt,
  grade_id: dbUuidNullable,
  /** Exit block (008 lines 102–107) — set by HR, never by this screen. */
  resignation_date: dbDateNullable,
  last_working_day: dbDateNullable,
  /** `ck_employees__exit_type` — six values, closed vocabulary. */
  exit_type: z.enum(exitTypeValues).nullable(),
  exit_reason: z.string().nullable(),
  exit_interview_done: z.boolean(),
  full_and_final_settled_on: dbDateNullable,
});
export type MyNoticeEmployee = z.infer<typeof myNoticeEmployeeSchema>;

const MY_NOTICE_EMPLOYEE_COLUMNS =
  "id, employee_code, display_name, employment_status, employment_type, date_of_join, " +
  "confirmed_on, confirmation_due_date, contract_end_date, notice_period_days, grade_id, " +
  "resignation_date, last_working_day, exit_type, exit_reason, exit_interview_done, " +
  "full_and_final_settled_on";

/** `grades.notice_period_days` — the grade's own figure (007 line 462). */
export const gradeNoticeSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  notice_period_days: dbInt,
  probation_months: dbInt,
});
export type GradeNotice = z.infer<typeof gradeNoticeSchema>;

/**
 * The signed contract's notice period. `contracts__self__select` (026) hands an
 * employee their OWN contract only while `status = 'signed'`, so an unsigned
 * draft is invisible here by design — and a missing row is a real state, not an
 * error.
 */
export const signedContractSchema = z.object({
  id: dbUuid,
  contract_number: z.string(),
  contract_kind: z.string(),
  notice_period_days: dbIntNullable,
  probation_months: dbIntNullable,
  start_date: dbDateNullable,
  end_date: dbDateNullable,
  signed_at: z.string().nullable(),
});
export type SignedContract = z.infer<typeof signedContractSchema>;

export interface NoticeFacts {
  readonly employee: MyNoticeEmployee;
  /** The grade row, or null when no grade is assigned to me. */
  readonly grade: GradeNotice | null;
  /** My signed contract, or null when none has been signed. */
  readonly contract: SignedContract | null;
  /** `employee_statutory.gratuity_eligible_from`, or null when unset. */
  readonly gratuityEligibleFrom: string | null;
}

/**
 * Every server-owned figure the resignation screen quotes, in one read chain.
 *
 * THREE sources, deliberately shown side by side rather than collapsed: the
 * employee's own `notice_period_days`, the grade's, and the signed contract's.
 * spec-employee §5 describes a fallback (employee → grade → default); in THIS
 * schema both of the first two are `NOT NULL`, so there is nothing to fall back
 * to and picking one silently would hide a disagreement the employee is entitled
 * to see. The screen names which one binds.
 */
export async function fetchNoticeFacts(signal?: AbortSignal): Promise<NoticeFacts | null> {
  const employee = await selectOne(MY_EMPLOYEE_VIEW, myNoticeEmployeeSchema, [], {
    columns: MY_NOTICE_EMPLOYEE_COLUMNS,
    ...(signal ? { signal } : {}),
  });
  if (employee === null) return null;

  const grade =
    employee.grade_id === null
      ? null
      : await selectOne(GRADES_TABLE, gradeNoticeSchema, [eq("id", employee.grade_id)], {
          columns: "id, code, name, notice_period_days, probation_months",
          ...(signal ? { signal } : {}),
        });

  const contracts = await selectMany(CONTRACTS_TABLE, signedContractSchema, {
    columns:
      "id, contract_number, contract_kind, notice_period_days, probation_months, " +
      "start_date, end_date, signed_at",
    filters: [eq("employee_id", employee.id), eq("status", "signed")],
    order: [{ column: "signed_at", ascending: false }],
    limit: 1,
    ...(signal ? { signal } : {}),
  });

  const statutory = await selectOne(
    STATUTORY_MASKED_VIEW,
    z.object({ employee_id: dbUuid, gratuity_eligible_from: dbDateNullable }),
    [eq("employee_id", employee.id)],
    { columns: "employee_id, gratuity_eligible_from", ...(signal ? { signal } : {}) },
  );

  return {
    employee,
    grade,
    contract: contracts[0] ?? null,
    gratuityEligibleFrom: statutory?.gratuity_eligible_from ?? null,
  };
}

/**
 * `employee_lifecycle_events` — the append-only stream `employees
 * .employment_status` is a PROJECTION of (011 §1). A resignation appears here as
 * an `event_type = 'resigned'` row, and only HR can write one:
 * `ele__admin_insert` is `app.is_admin() AND app.admin_scope_covers(...)`.
 * Reading it is self-scoped through `ele__scope_read` → `app.can_see_employee`,
 * which returns true for the caller's own id (005).
 */
export const lifecycleEventSchema = z.object({
  id: dbUuid,
  event_type: lifecycleEventTypeSchema,
  effective_date: dbDate,
  recorded_at: dbTimestamp,
  reason: z.string(),
  is_reversed: z.boolean(),
  approval_request_id: dbUuidNullable,
});
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

const LIFECYCLE_EVENTS_CAP = 50;

/** My own lifecycle record, most recent effective date first. */
export function fetchMyLifecycleEvents(
  employeeId: string,
  signal?: AbortSignal,
): Promise<LifecycleEvent[]> {
  return selectMany(EMPLOYEE_LIFECYCLE_EVENTS_TABLE, lifecycleEventSchema, {
    columns: "id, event_type, effective_date, recorded_at, reason, is_reversed, approval_request_id",
    filters: [eq("employee_id", employeeId)],
    order: [
      { column: "effective_date", ascending: false },
      { column: "recorded_at", ascending: false },
    ],
    limit: LIFECYCLE_EVENTS_CAP,
    ...(signal ? { signal } : {}),
  });
}

// =============================================================================
// 3. Income tax (E-10.6) — the regime on file, the rate set, and the election
// =============================================================================

/** `ck_es__regime` (009 §6) — the closed vocabulary. Two values, no third. */
export const taxRegimeValues = ["old", "new"] as const;
export const taxRegimeSchema = z.enum(taxRegimeValues);
export type TaxRegime = z.infer<typeof taxRegimeSchema>;

/**
 * My statutory row through the MASKED view. `employee_statutory` itself has had
 * table SELECT revoked from `authenticated` (033 §0); the view is the only door,
 * and `tax_regime` / `tax_regime_locked_fy` are inside its column grant.
 */
export const myTaxProfileSchema = z.object({
  employee_id: dbUuid,
  tax_regime: taxRegimeSchema,
  /** Set once the FY's election is closed. NULL means still changeable. */
  tax_regime_locked_fy: z.string().nullable(),
  pf_applicable: z.boolean(),
  esi_applicable: z.boolean(),
  professional_tax_applicable: z.boolean(),
  professional_tax_state: z.string(),
  lwf_applicable: z.boolean(),
  is_director_or_partner: z.boolean(),
});
export type MyTaxProfile = z.infer<typeof myTaxProfileSchema>;

/**
 * `null` is a real state: an employee whose statutory row HR has not created
 * yet. The screen says so instead of rendering a card of em dashes.
 */
export function fetchMyTaxProfile(
  employeeId: string,
  signal?: AbortSignal,
): Promise<MyTaxProfile | null> {
  return selectOne(STATUTORY_MASKED_VIEW, myTaxProfileSchema, [eq("employee_id", employeeId)], {
    columns:
      "employee_id, tax_regime, tax_regime_locked_fy, pf_applicable, esi_applicable, " +
      "professional_tax_applicable, professional_tax_state, lwf_applicable, is_director_or_partner",
    ...(signal ? { signal } : {}),
  });
}

/**
 * The rate set in force today. `statutory_settings__authenticated__select` is
 * `USING (true)` — 020's own comment says why: "statutory rates are law, not
 * secrets" — so an employee may read the slabs their TDS is computed from.
 *
 * "In force" is expressed as the newest row that has already started, rather
 * than as an `effective_to` range: `effective_to` is NULL for the current row
 * and the filter DSL has no OR. Ordering by `effective_from` descending and
 * taking one row gives the same answer for an effective-dated set.
 */
export const taxRateSetSchema = z.object({
  id: dbUuid,
  effective_from: dbDate,
  effective_to: dbDateNullable,
  /** `[{from,to,amount}]` in integer paise — decoded, never assumed. */
  pt_slabs: z.unknown(),
  pt_state: z.string(),
  /** Per-regime config, money in integer paise. Decoded by `readTdsRegime`. */
  tds_config: z.unknown(),
  lwf_employee_amount_paise: dbInt,
  notes: z.string().nullable(),
});
export type TaxRateSet = z.infer<typeof taxRateSetSchema>;

export async function fetchCurrentTaxRateSet(signal?: AbortSignal): Promise<TaxRateSet | null> {
  const rows = await selectMany(STATUTORY_SETTINGS_TABLE, taxRateSetSchema, {
    columns:
      "id, effective_from, effective_to, pt_slabs, pt_state, tds_config, " +
      "lwf_employee_amount_paise, notes",
    filters: [lte("effective_from", nowIstDate())],
    order: [{ column: "effective_from", ascending: false }],
    limit: 1,
    ...(signal ? { signal } : {}),
  });
  return rows[0] ?? null;
}

/**
 * One slab of a regime's TDS ladder. `from`/`to` are ANNUAL integer paise and
 * `pct` is a percentage — the shape `statutory_settings.tds_config` is
 * documented with (020 COMMENT) and seeded with (044 §5).
 */
const tdsSlabSchema = z.object({
  from: dbInt,
  to: dbIntNullable,
  pct: dbNumeric,
});
export type TdsSlab = z.infer<typeof tdsSlabSchema>;

const tdsRegimeSchema = z.object({
  standard_deduction: dbInt,
  slabs: z.array(tdsSlabSchema),
  rebate_87a_threshold: dbIntNullable,
  rebate_87a_amount: dbIntNullable,
  cess_pct: dbNumeric,
});
export type TdsRegime = z.infer<typeof tdsRegimeSchema>;

/**
 * DECODE one regime out of `tds_config`, returning null when the shape does not
 * match — the same contract as `readPtSlabs` in the payroll console. A schema
 * drift then shows as "the rate ladder could not be read" rather than as a
 * plausible wrong slab.
 */
export function readTdsRegime(config: unknown, regime: TaxRegime): TdsRegime | null {
  if (config === null || typeof config !== "object") return null;
  const parsed = tdsRegimeSchema.safeParse((config as Record<string, unknown>)[regime]);
  return parsed.success ? parsed.data : null;
}

/** `tds_config.financial_year`, e.g. '2026-27'. Read, never derived from today. */
export function readTdsFinancialYear(config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)["financial_year"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// -----------------------------------------------------------------------------
// 3b. The elections already on file
// -----------------------------------------------------------------------------

/**
 * A regime election as it lives in `employee_change_requests` (011 §2).
 *
 * `ecr__self_read` gives the employee their own rows. `status` is server-owned:
 * `ecr_insert_guard` forces `'pending'` on insert, and only HR's decision moves
 * it. `applied_at` / `apply_error` are what `apply_change_request` writes.
 */
export const regimeElectionSchema = z.object({
  id: dbUuid,
  field_label: z.string(),
  old_value: z.unknown(),
  new_value: z.unknown(),
  status: approvalStatusSchema,
  requested_at: dbTimestamp,
  decided_at: z.string().nullable(),
  applied_at: z.string().nullable(),
  apply_error: z.string().nullable(),
  approval_request_id: dbUuidNullable,
  effective_from: dbDateNullable,
});
export type RegimeElection = z.infer<typeof regimeElectionSchema>;

const ELECTIONS_CAP = 25;

/** Only tax-regime rows: my other change requests belong to E-07, not here. */
export function fetchMyRegimeElections(
  employeeId: string,
  signal?: AbortSignal,
): Promise<RegimeElection[]> {
  return selectMany(EMPLOYEE_CHANGE_REQUESTS_TABLE, regimeElectionSchema, {
    columns:
      "id, field_label, old_value, new_value, status, requested_at, decided_at, applied_at, " +
      "apply_error, approval_request_id, effective_from",
    filters: [
      eq("employee_id", employeeId),
      eq("entity_table", ECR_ENTITY_STATUTORY),
      eq("field_name", ECR_FIELD_TAX_REGIME),
    ],
    order: [{ column: "requested_at", ascending: false }],
    limit: ELECTIONS_CAP,
    ...(signal ? { signal } : {}),
  });
}

/** `old_value`/`new_value` are jsonb strings; anything else is not a regime. */
export function readElectionRegime(value: unknown): TaxRegime | null {
  const parsed = taxRegimeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// -----------------------------------------------------------------------------
// 3c. Submit — the one request of these three the backend accepts
// -----------------------------------------------------------------------------

export interface SubmitRegimeElectionInput {
  readonly employeeId: string;
  /** `employee_change_requests.requested_by` references PROFILES, not employees. */
  readonly profileId: string;
  readonly regime: TaxRegime;
  readonly currentRegime: TaxRegime;
  /** Why — carried into `approval_requests.summary` for the approver to read. */
  readonly note: string;
  /** `tds_config.financial_year` when it could be read, else null. */
  readonly financialYear: string | null;
}

export interface SubmittedRegimeElection {
  readonly changeRequestId: string;
  readonly requestId: string;
  /** `approval_requests.request_number`, e.g. `PROFILE_CHANGE-000042`. */
  readonly requestNumber: string | null;
}

const requestRefSchema = z.object({ id: dbUuid, request_number: z.string() });

const electionIdentitySchema = z.object({
  id: dbUuid,
  status: approvalStatusSchema,
  requested_at: dbTimestamp,
});

/**
 * change request → `create_approval_request` → the server-minted reference.
 *
 * WHY THIS ONE WORKS while travel and resignation do not, every clause checked
 * in the migrations:
 *
 *  1. THE DETAIL ROW EXISTS. `employee_change_requests` is a real table with a
 *     real self-insert policy: `ecr__self_insert` is `employee_id =
 *     app.current_employee_id() AND requested_by = app.ctx_actor_id()`, and
 *     `GRANT SELECT, INSERT … TO authenticated` backs it (011 §4).
 *  2. THE FIELD IS PERMITTED. `ecr_insert_guard` restricts field names only for
 *     `entity_table = 'employees'` and `'employee_custom_field_values'`;
 *     `'employee_statutory'` is whitelisted by `ck_ecr__entity_table` with no
 *     per-field list, and `tax_regime` is one of its columns (009 §6).
 *  3. A CHAIN RESOLVES. `PROFILE_CHANGE`'s `detail_table` IS
 *     `employee_change_requests`, and 045 §3 gives it `AC-PROFILE` → one level,
 *     HR admin. `create_approval_request` therefore mints `request_number` from
 *     `seq_approval_request_number` instead of raising.
 *  4. NO REASON HEADER IS NEEDED. `employee_change_requests` is not one of the
 *     seventeen tables in `audit.reason_required_tables` (006 §1), so the plain
 *     `insertOne` path applies. The submission is still recorded: the workflow
 *     engine writes its own `approval_actions` row.
 *
 * TWO THINGS THE SERVER DOES NOT DO, WHICH THE SCREEN THEREFORE SAYS:
 *   * NO BACK-LINK. `employee_change_requests.approval_request_id` stays NULL —
 *     `authenticated` holds INSERT but no UPDATE on this table, so a client
 *     cannot write it. The link that matters runs the other way, through
 *     `approval_requests.detail_id`, which is set here.
 *   * NO AUTO-APPLY. `apply_change_request` (011 §3) updates a satellite with
 *     `WHERE id = $2 AND employee_id = $3`, and `employee_statutory` is keyed on
 *     `employee_id` with NO `id` column — so `entity_id` is left NULL and HR
 *     sets the regime on approval. The approval request is the record of the
 *     employee's election, which is exactly what it is presented as.
 */
export async function submitRegimeElection(
  input: SubmitRegimeElectionInput,
  signal?: AbortSignal,
): Promise<SubmittedRegimeElection> {
  const note = input.note.trim();

  // 1. The detail row. `status` is omitted: `ecr_insert_guard` forces 'pending'
  //    and nulls every decision column, so sending one would be theatre.
  //    `entity_id` stays NULL for the reason in the header note.
  const election = await insertOne(
    EMPLOYEE_CHANGE_REQUESTS_TABLE,
    electionIdentitySchema,
    {
      employee_id: input.employeeId,
      requested_by: input.profileId,
      entity_table: ECR_ENTITY_STATUTORY,
      field_name: ECR_FIELD_TAX_REGIME,
      field_label: "Income-tax regime",
      old_value: input.currentRegime,
      new_value: input.regime,
    },
    { columns: "id, status, requested_at", ...(signal ? { signal } : {}) },
  );

  // 2. Into the workflow engine. No amount and no days: `AC-PROFILE` has NULL
  //    bands on both, so NULL selectors match it (029 §10 chain predicate).
  const requestId = await rpcOne(
    CREATE_APPROVAL_REQUEST_FN,
    {
      p_request_type_code: REQUEST_CODE_PROFILE_CHANGE,
      p_subject_employee_id: input.employeeId,
      p_detail_id: election.id,
      p_title: `Income-tax regime · ${input.currentRegime} → ${input.regime}`,
      p_summary: {
        summary: note,
        entity_table: ECR_ENTITY_STATUTORY,
        field_name: ECR_FIELD_TAX_REGIME,
        from_regime: input.currentRegime,
        to_regime: input.regime,
        financial_year: input.financialYear,
      },
      p_amount: null,
      p_days: null,
      p_priority: "normal",
      p_on_behalf_of: null,
    },
    dbUuid,
    signal ? { signal } : {},
  );
  if (requestId === null) {
    throw new Error("The election was saved but the approval request was not created.");
  }

  const ref = await selectOne(APPROVAL_REQUESTS_TABLE, requestRefSchema, [eq("id", requestId)], {
    columns: "id, request_number",
    ...(signal ? { signal } : {}),
  });

  return {
    changeRequestId: election.id,
    requestId,
    requestNumber: ref?.request_number ?? null,
  };
}
