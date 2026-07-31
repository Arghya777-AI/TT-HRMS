/**
 * employees.api.ts — every People (§2) read and write for the admin console.
 *
 * Reads come from `v_admin_employee`, whose column list was taken from the LIVE
 * project, not from a spec table: the view really does expose
 * `employment_status` (enum `public.employment_status`), `date_of_join`,
 * `is_ot_eligible`, `punch_mode`, resolved `*_name` labels, and the masked
 * `pan_masked` / `aadhaar_masked` / `primary_account_last4` tails. Sensitive
 * numbers are NOT on `employees`; they live in `employee_statutory`,
 * `employee_bank_accounts` and `employee_salary_revisions`, which a client may
 * only see masked (`v_employee_statutory_masked`, `v_employee_bank_masked`) —
 * the full value comes from a reveal RPC that writes a `data_access` audit row.
 *
 * Writes go through the audited helpers in `@/shared/api/query`, so every one of
 * them carries `X-Reason`. `employees` is in `audit.reason_required_tables`, so
 * a reasonless UPDATE is refused by the database with SQLSTATE 22023 — the
 * helpers refuse it earlier and more kindly.
 *
 * Reason policy (spec-admin §3.5):
 *   - routine field edits may use a specific default sentence, exported here;
 *   - date-of-join, employment status, compensation, bank, statutory ID, role
 *     and archive changes MUST prompt (ReasonDialog) — those functions take a
 *     `reason` with no default and demand SENSITIVE_REASON_LENGTH.
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
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  ilike,
  inList,
  insertRow,
  isNotNull,
  isNull,
  paginate,
  rpcMany,
  selectCount,
  selectMany,
  selectOne,
  selectOneOrThrow,
  softDelete,
  updateRow,
  type Cursor,
  type Filter,
  type Page,
} from "@/shared/api/query";
import { t } from "@/shared/i18n/en";

export const V_ADMIN_EMPLOYEE = "v_admin_employee";
export const V_STATUTORY_MASKED = "v_employee_statutory_masked";
export const V_BANK_MASKED = "v_employee_bank_masked";
export const EMPLOYEES_TABLE = "employees";

/** `public.employment_status` (migration 003) — the real enum, in order. */
export const employmentStatusValues = [
  "pre_joining",
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "suspended",
  "on_long_leave",
  "absconding",
  "exited",
  "retired",
  "rehired",
] as const;
export const employmentStatusSchema = z.enum(employmentStatusValues);
export type EmploymentStatus = z.infer<typeof employmentStatusSchema>;

/** Human labels for StatusChip — never render the enum (D-10). */
export const EMPLOYMENT_STATUS_LABELS: Readonly<Record<EmploymentStatus, string>> = {
  pre_joining: t("admin.employee.status.pre_joining"),
  active: t("admin.employee.status.active"),
  on_probation: t("admin.employee.status.on_probation"),
  confirmed: t("admin.employee.status.confirmed"),
  on_notice: t("admin.employee.status.on_notice"),
  suspended: t("admin.employee.status.suspended"),
  on_long_leave: t("admin.employee.status.on_long_leave"),
  absconding: t("admin.employee.status.absconding"),
  exited: t("admin.employee.status.exited"),
  retired: t("admin.employee.status.retired"),
  rehired: t("admin.employee.status.rehired"),
};

/** `public.employment_type` (migration 003) — the real enum, in order. */
export const employmentTypeValues = [
  "permanent",
  "probation",
  "contract",
  "intern",
  "consultant",
  "casual",
  "apprentice",
  "retainer",
] as const;
export const employmentTypeSchema = z.enum(employmentTypeValues);
export type EmploymentType = z.infer<typeof employmentTypeSchema>;

/** Human labels for the type column and its filter — never render the enum (D-10). */
export const EMPLOYMENT_TYPE_LABELS: Readonly<Record<EmploymentType, string>> = {
  permanent: t("admin.employee.type.permanent"),
  probation: t("admin.employee.type.probation"),
  contract: t("admin.employee.type.contract"),
  intern: t("admin.employee.type.intern"),
  consultant: t("admin.employee.type.consultant"),
  casual: t("admin.employee.type.casual"),
  apprentice: t("admin.employee.type.apprentice"),
  retainer: t("admin.employee.type.retainer"),
};

/** Statuses the directory treats as "currently employed". */
export const ACTIVE_EMPLOYMENT_STATUSES: readonly EmploymentStatus[] = [
  "pre_joining",
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "suspended",
  "on_long_leave",
  "rehired",
];

/** Default reason for a routine, non-sensitive field edit (spec-admin §3.5). */
export const REASON_EMPLOYMENT_DETAILS = t("admin.reason.default.employmentDetails");
export const REASON_PERSONAL_DETAILS = t("admin.reason.default.personalDetails");

// -----------------------------------------------------------------------------
// 1. Directory (`/admin/people`)
// -----------------------------------------------------------------------------

/** The projection the grid needs — narrow, because the view is 100+ columns. */
export const DIRECTORY_COLUMNS = [
  "id",
  "employee_code",
  "display_name",
  "photo_path",
  "work_email",
  "mobile",
  "employment_status",
  "employment_type",
  "date_of_join",
  "confirmation_due_date",
  "department_id",
  "department_name",
  "section_name",
  "designation_name",
  "grade_name",
  "location_name",
  "cost_centre_name",
  "reporting_manager_name",
  "shift_code",
  "punch_mode",
  "is_ot_eligible",
  "profile_completeness_pct",
  "deleted_at",
  "updated_at",
].join(",");

export const directoryRowSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  photo_path: z.string().nullable(),
  work_email: z.string().nullable(),
  mobile: z.string().nullable(),
  employment_status: employmentStatusSchema,
  employment_type: employmentTypeSchema,
  /*
    NULLABLE, because `employees.date_of_join` is (migration 008 declares it
    `date_of_join date` with no NOT NULL). A joiner recorded before their start
    date is agreed genuinely has none, and the bulk load of the venue's roster
    brought in 32 such records. Declaring it required turned that into a parse
    error that replaced the whole screen with "Something went wrong".
  */
  date_of_join: dbDateNullable,
  confirmation_due_date: dbDateNullable,
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  section_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  grade_name: z.string().nullable(),
  location_name: z.string().nullable(),
  cost_centre_name: z.string().nullable(),
  reporting_manager_name: z.string().nullable(),
  shift_code: z.string().nullable(),
  punch_mode: z.string().nullable(),
  is_ot_eligible: z.boolean(),
  /** Server-computed, already a percentage. */
  profile_completeness_pct: dbIntNullable,
  deleted_at: dbTimestampNullable,
  updated_at: dbTimestamp,
});
export type DirectoryRow = z.infer<typeof directoryRowSchema>;

export interface DirectoryFilters {
  readonly statuses?: readonly EmploymentStatus[];
  readonly employmentTypes?: readonly EmploymentType[];
  readonly departmentIds?: readonly string[];
  readonly locationIds?: readonly string[];
  readonly designationIds?: readonly string[];
  /** Substring of the display name. `employee_code` has its own filter. */
  readonly nameLike?: string;
  readonly employeeCode?: string;
  /**
   * Substring of `mobile`. Separate from `nameLike` because the filter
   * vocabulary is AND-only by design — an OR across name, code and mobile would
   * need raw PostgREST syntax, which `Filter` refuses on purpose. The directory
   * therefore asks the admin WHICH column they are searching.
   */
  readonly mobileLike?: string;
  /** Archive console: only soft-deleted rows. Default excludes them. */
  readonly archived?: boolean;
}

function directoryFilters(f: DirectoryFilters): Filter[] {
  // v_admin_employee deliberately shows soft-deleted rows to admins (the Archive
  // console needs them, migration 051 §1), so the directory has to exclude them.
  const filters: Filter[] = [f.archived === true ? isNotNull("deleted_at") : isNull("deleted_at")];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("employment_status", f.statuses));
  if (f.employmentTypes && f.employmentTypes.length > 0)
    filters.push(inList("employment_type", f.employmentTypes));
  if (f.departmentIds && f.departmentIds.length > 0) filters.push(inList("department_id", f.departmentIds));
  if (f.locationIds && f.locationIds.length > 0) filters.push(inList("location_id", f.locationIds));
  if (f.designationIds && f.designationIds.length > 0)
    filters.push(inList("designation_id", f.designationIds));
  if (f.nameLike && f.nameLike.trim() !== "") filters.push(ilike("display_name", `%${f.nameLike.trim()}%`));
  if (f.employeeCode && f.employeeCode.trim() !== "")
    filters.push(ilike("employee_code", `%${f.employeeCode.trim()}%`));
  if (f.mobileLike && f.mobileLike.trim() !== "")
    filters.push(ilike("mobile", `%${f.mobileLike.trim()}%`));
  return filters;
}

/**
 * How many employees match these filters, counted by POSTGRES.
 *
 * Deliberately built from the SAME `directoryFilters(f)` array the paged read
 * uses, so the total on the header and the rows in the grid agree by
 * construction. Reading `.length` off a loaded page would make the total depend
 * on the page size — the `7 vs 8` defect (spec-screens DR-29).
 */
export function countEmployeeDirectory(
  filters: DirectoryFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_ADMIN_EMPLOYEE, directoryFilters(filters), {
    ...(signal ? { signal } : {}),
  });
}

/**
 * One keyset page of the directory, ordered by employee_code (which is
 * monotonic and unique, so it is both the sort key and the tiebreak-safe key —
 * `id` is still passed as the tiebreak because the contract requires a unique
 * column and a future legacy import could repeat a code).
 */
export function fetchEmployeeDirectory(
  filters: DirectoryFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<DirectoryRow>> {
  return paginate(V_ADMIN_EMPLOYEE, directoryRowSchema, {
    orderBy: "employee_code",
    ascending: true,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: directoryFilters(filters),
    columns: DIRECTORY_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/** Unpaginated list for a picker (manager, reportee, bulk-action scope). */
export function fetchEmployeeOptions(
  filters: DirectoryFilters,
  limit = 200,
  signal?: AbortSignal,
): Promise<DirectoryRow[]> {
  return selectMany(V_ADMIN_EMPLOYEE, directoryRowSchema, {
    filters: directoryFilters(filters),
    order: [{ column: "display_name", ascending: true }],
    limit,
    columns: DIRECTORY_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Employee 360 header + Overview / Employment tabs
// -----------------------------------------------------------------------------

export const adminEmployeeSchema = directoryRowSchema.extend({
  profile_id: dbUuidNullable,
  company_id: dbUuid,
  title: z.string().nullable(),
  first_name: z.string(),
  middle_name: z.string().nullable(),
  last_name: z.string().nullable(),
  preferred_name: z.string().nullable(),
  name_in_local_script: z.string().nullable(),
  personal_email: z.string().nullable(),
  date_of_birth: dbDateNullable,
  gender: z.string().nullable(),
  blood_group: z.string().nullable(),
  about: z.string().nullable(),
  probation_months: dbIntNullable,
  confirmed_on: dbDateNullable,
  contract_start_date: dbDateNullable,
  contract_end_date: dbDateNullable,
  notice_period_days: dbIntNullable,
  section_id: dbUuidNullable,
  designation_id: dbUuidNullable,
  grade_id: dbUuidNullable,
  location_id: dbUuidNullable,
  cost_centre_id: dbUuidNullable,
  reporting_manager_id: dbUuidNullable,
  dotted_line_manager_id: dbUuidNullable,
  dotted_line_manager_name: z.string().nullable(),
  work_order_number: z.string().nullable(),
  is_shift_worker: z.boolean(),
  attendance_policy_id: dbUuidNullable,
  attendance_policy_code: z.string().nullable(),
  weekly_off_rule_id: dbUuidNullable,
  holiday_calendar_id: dbUuidNullable,
  shift_id: dbUuidNullable,
  pay_period_id: dbUuidNullable,
  attendance_regularize_from: dbDateNullable,
  allow_web_punch: z.boolean(),
  allow_mobile_selfie_punch: z.boolean(),
  restrict_punch_to_venue_ip: z.boolean(),
  exclude_from_attendance: z.boolean(),
  exclude_from_payroll: z.boolean(),
  payment_mode: z.string().nullable(),
  primary_bank_account_id: dbUuidNullable,
  marital_status: z.string().nullable(),
  father_or_spouse_name: z.string().nullable(),
  mother_name: z.string().nullable(),
  nationality: z.string().nullable(),
  resignation_date: dbDateNullable,
  last_working_day: dbDateNullable,
  exit_type: z.string().nullable(),
  exit_reason: z.string().nullable(),
  is_rehire_eligible: z.boolean().nullable(),
  full_and_final_settled_on: dbDateNullable,
  face_enrolled_at: dbTimestampNullable,
  company_name: z.string().nullable(),
  /** Masked tails the view already computed — never unmask on the client. */
  pan_masked: z.string().nullable(),
  aadhaar_masked: z.string().nullable(),
  uan_masked: z.string().nullable(),
  primary_bank_name: z.string().nullable(),
  primary_bank_ifsc: z.string().nullable(),
  primary_account_last4: z.string().nullable(),
  primary_bank_verified: z.boolean().nullable(),
  deletion_reason: z.string().nullable(),
});
export type AdminEmployee = z.infer<typeof adminEmployeeSchema>;

/** The 360 header. Absence means "not yours to see" (RLS), not "no such code". */
export function fetchAdminEmployeeByCode(
  employeeCode: string,
  signal?: AbortSignal,
): Promise<AdminEmployee> {
  return selectOneOrThrow(V_ADMIN_EMPLOYEE, adminEmployeeSchema, [eq("employee_code", employeeCode)], {
    ...(signal ? { signal } : {}),
  });
}

export function fetchAdminEmployeeById(
  employeeId: string,
  signal?: AbortSignal,
): Promise<AdminEmployee | null> {
  return selectOne(V_ADMIN_EMPLOYEE, adminEmployeeSchema, [eq("id", employeeId)], {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Statutory & bank — masked by default for EVERY role including admin (D-19)
// -----------------------------------------------------------------------------

export const statutoryMaskedSchema = z.object({
  employee_id: dbUuid,
  pan_masked: z.string().nullable(),
  aadhaar_masked: z.string().nullable(),
  uan_masked: z.string().nullable(),
  pf_number_masked: z.string().nullable(),
  esi_number_masked: z.string().nullable(),
  pf_applicable: z.boolean().nullable(),
  eps_applicable: z.boolean().nullable(),
  esi_applicable: z.boolean().nullable(),
  pf_joining_date: dbDateNullable,
  pf_wage_ceiling_applied: z.boolean().nullable(),
  esi_dispensary: z.string().nullable(),
  aadhaar_linked_to_uan: z.boolean().nullable(),
  professional_tax_applicable: z.boolean().nullable(),
  professional_tax_state: z.string().nullable(),
  lwf_applicable: z.boolean().nullable(),
  gratuity_eligible_from: dbDateNullable,
  tax_regime: z.string().nullable(),
  tax_regime_locked_fy: z.string().nullable(),
  is_director_or_partner: z.boolean().nullable(),
});
export type StatutoryMasked = z.infer<typeof statutoryMaskedSchema>;

export function fetchStatutoryMasked(
  employeeId: string,
  signal?: AbortSignal,
): Promise<StatutoryMasked | null> {
  return selectOne(V_STATUTORY_MASKED, statutoryMaskedSchema, [eq("employee_id", employeeId)], {
    ...(signal ? { signal } : {}),
  });
}

export const bankMaskedSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  beneficiary_name: z.string().nullable(),
  bank_name: z.string().nullable(),
  branch: z.string().nullable(),
  ifsc: z.string().nullable(),
  account_number_last4: z.string().nullable(),
  account_type: z.string().nullable(),
  upi_id_masked: z.string().nullable(),
  is_verified: z.boolean(),
  verification_method: z.string().nullable(),
  verified_at: dbTimestampNullable,
  is_active: z.boolean(),
  effective_from: dbDateNullable,
  effective_to: dbDateNullable,
});
export type BankMasked = z.infer<typeof bankMaskedSchema>;

export function fetchBankAccountsMasked(
  employeeId: string,
  signal?: AbortSignal,
): Promise<BankMasked[]> {
  return selectMany(V_BANK_MASKED, bankMaskedSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "is_active", ascending: false }, { column: "effective_from", ascending: false }],
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Reveal — an audited READ, not a write (migration 032)
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
 * `reveal_employee_statutory(p_employee_id, p_reason)` — the function asserts
 * the reason itself (22023 when too short) and writes a `data_access` row before
 * returning anything. The reason is a mandatory ARGUMENT here, not a header, so
 * this path cannot be used without one.
 */
export async function revealStatutory(
  employeeId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<RevealedStatutory> {
  const trimmed = reason.trim();
  if (trimmed.length < SENSITIVE_REASON_LENGTH) {
    throw new MutationError(
      "reveal_employee_statutory",
      "reason_required",
      `Revealing statutory identifiers is a logged data access; give at least ${SENSITIVE_REASON_LENGTH} characters.`,
      { minReasonLength: SENSITIVE_REASON_LENGTH },
    );
  }
  const rows = await rpcMany(
    "reveal_employee_statutory",
    { p_employee_id: employeeId, p_reason: trimmed },
    revealedStatutorySchema,
    { ...(signal ? { signal } : {}) },
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MutationError(
      "reveal_employee_statutory",
      "not_found",
      "No statutory record for this employee.",
    );
  }
  return row;
}

export const revealedBankSchema = z.object({
  id: dbUuid,
  beneficiary_name: z.string().nullable(),
  bank_name: z.string().nullable(),
  branch: z.string().nullable(),
  ifsc: z.string().nullable(),
  account_number: z.string().nullable(),
  account_type: z.string().nullable(),
  upi_id: z.string().nullable(),
  is_verified: z.boolean(),
  is_active: z.boolean(),
  effective_from: dbDateNullable,
  effective_to: dbDateNullable,
});
export type RevealedBank = z.infer<typeof revealedBankSchema>;

export async function revealBankAccounts(
  employeeId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<RevealedBank[]> {
  const trimmed = reason.trim();
  if (trimmed.length < SENSITIVE_REASON_LENGTH) {
    throw new MutationError(
      "reveal_employee_bank_account",
      "reason_required",
      `Revealing a bank account is a logged data access; give at least ${SENSITIVE_REASON_LENGTH} characters.`,
      { minReasonLength: SENSITIVE_REASON_LENGTH },
    );
  }
  return rpcMany(
    "reveal_employee_bank_account",
    { p_employee_id: employeeId, p_reason: trimmed },
    revealedBankSchema,
    { ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 5. Writes
// -----------------------------------------------------------------------------

/**
 * Columns an admin is granted UPDATE on (migration 051). Anything outside this
 * set is refused by Postgres column privilege, so the set is asserted here and
 * a mistake surfaces as a clear client error rather than a 42501 an admin has
 * to decode.
 */
export const EDITABLE_PERSONAL_COLUMNS = [
  "title",
  "first_name",
  "middle_name",
  "last_name",
  "display_name",
  "preferred_name",
  "name_in_local_script",
  "work_email",
  "personal_email",
  "mobile",
  "date_of_birth",
  "date_of_birth_actual",
  "gender",
  "blood_group",
  "marital_status",
  "marriage_anniversary",
  "father_or_spouse_name",
  "father_or_spouse_relation",
  "mother_name",
  "nationality",
  "religion",
  "category",
  "is_differently_abled",
  "disability_type",
  "mode_of_transport",
  "uniform_size",
  "food_preference",
  "about",
  "photo_path",
  "cover_photo_path",
  "physical_address_same_as_permanent",
] as const;

export const EDITABLE_EMPLOYMENT_COLUMNS = [
  "employment_type",
  "employment_status",
  "date_of_join",
  "probation_months",
  "confirmed_on",
  "contract_start_date",
  "contract_end_date",
  "notice_period_days",
  "department_id",
  "section_id",
  "designation_id",
  "grade_id",
  "location_id",
  "cost_centre_id",
  "reporting_manager_id",
  "dotted_line_manager_id",
  "work_order_number",
] as const;

export const EDITABLE_TIME_POLICY_COLUMNS = [
  "is_ot_eligible",
  "is_shift_worker",
  "punch_mode",
  "attendance_policy_id",
  "weekly_off_rule_id",
  "holiday_calendar_id",
  "shift_id",
  "pay_period_id",
  "attendance_regularize_from",
  "allow_web_punch",
  "allow_mobile_selfie_punch",
  "restrict_punch_to_venue_ip",
  "exclude_from_attendance",
  "exclude_from_payroll",
  "payment_mode",
  "primary_bank_account_id",
] as const;

export const EDITABLE_EXIT_COLUMNS = [
  "resignation_date",
  "last_working_day",
  "exit_type",
  "exit_reason",
  "exit_interview_done",
  "is_rehire_eligible",
  "full_and_final_settled_on",
] as const;

const ALL_EDITABLE = new Set<string>([
  ...EDITABLE_PERSONAL_COLUMNS,
  ...EDITABLE_EMPLOYMENT_COLUMNS,
  ...EDITABLE_TIME_POLICY_COLUMNS,
  ...EDITABLE_EXIT_COLUMNS,
]);

/** Fields whose change always prompts for a typed reason (spec-admin §3.5). */
export const REASON_PROMPTING_COLUMNS: ReadonlySet<string> = new Set([
  "date_of_join",
  "employment_status",
  "employment_type",
  "confirmed_on",
  "resignation_date",
  "last_working_day",
  "exit_type",
  "exit_reason",
  "primary_bank_account_id",
  "exclude_from_payroll",
  "payment_mode",
]);

/** True when this patch touches a field that must not use a default reason. */
export function patchNeedsTypedReason(patch: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(patch).some((k) => REASON_PROMPTING_COLUMNS.has(k));
}

export interface UpdateEmployeeInput {
  readonly employeeId: string;
  /** Only CHANGED fields — the server diffs and audits one row per field. */
  readonly patch: Readonly<Record<string, unknown>>;
  /**
   * Optimistic lock (spec-admin §3.5). When supplied, the UPDATE also filters on
   * `updated_at`, so a stale form saves nothing and reports `not_found` instead
   * of overwriting someone else's edit.
   */
  readonly expectedUpdatedAt?: string;
}

/**
 * Update the employee master. Every call is audited; the reason is a required
 * argument. Pass `REASON_EMPLOYMENT_DETAILS` for a routine edit, and a typed
 * sentence (via ReasonDialog) whenever `patchNeedsTypedReason` is true.
 */
export async function updateEmployee(
  input: UpdateEmployeeInput,
  reason: string,
  signal?: AbortSignal,
): Promise<AdminEmployee> {
  const unknownColumns = Object.keys(input.patch).filter((k) => !ALL_EDITABLE.has(k));
  if (unknownColumns.length > 0) {
    throw new MutationError(
      EMPLOYEES_TABLE,
      "permission_denied",
      `An admin has no column privilege on: ${unknownColumns.join(", ")}. Salary, PAN, Aadhaar and bank numbers are not on this table.`,
    );
  }
  const filters: Filter[] = [eq("id", input.employeeId)];
  if (input.expectedUpdatedAt !== undefined) filters.push(eq("updated_at", input.expectedUpdatedAt));

  const updated = await updateRow(
    EMPLOYEES_TABLE,
    filters,
    input.patch,
    z.object({ id: dbUuid, employee_code: z.string(), updated_at: dbTimestamp }),
    {
      reason,
      columns: "id,employee_code,updated_at",
      ...(patchNeedsTypedReason(input.patch) ? { minReasonLength: SENSITIVE_REASON_LENGTH } : {}),
      ...(signal ? { signal } : {}),
    },
  );
  // Read the row back through the VIEW: `employees` exposes no resolved labels,
  // and the 360 header must not hold a different shape from the grid.
  return fetchAdminEmployeeByCode(updated.employee_code, signal);
}

/**
 * Add Employee (§3.3 step 7). `employee_code` is NOT passed — it is allocated by
 * trigger from `employee_code_seq` and is immutable (D-02). The auth account is
 * created afterwards by the `employee-account-create` edge function, which holds
 * the service role; this only writes the master row.
 */
export const NEW_EMPLOYEE_REQUIRED = ["company_id", "first_name", "display_name", "date_of_join"] as const;

export async function insertEmployee(
  values: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<{ id: string; employee_code: string }> {
  for (const key of NEW_EMPLOYEE_REQUIRED) {
    if (values[key] === undefined || values[key] === null || values[key] === "") {
      throw new MutationError(EMPLOYEES_TABLE, "invalid_request", `${key} is required to create an employee.`);
    }
  }
  if ("employee_code" in values) {
    throw new MutationError(
      EMPLOYEES_TABLE,
      "invalid_request",
      "employee_code is allocated by the database and can never be supplied or reused (D-02).",
    );
  }
  return insertRow(
    EMPLOYEES_TABLE,
    values,
    z.object({ id: dbUuid, employee_code: z.string() }),
    { reason, columns: "id,employee_code", ...(signal ? { signal } : {}) },
  );
}

/**
 * Archive (soft delete, D-23). Always prompts: the reason lands in
 * `deletion_reason` AND in the audit row, and the Archive console renders it.
 */
export function archiveEmployee(
  employeeId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  return softDelete(EMPLOYEES_TABLE, employeeId, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 6. Compensation (masked, read-only here) — §2 Employee 360 tab 3
// -----------------------------------------------------------------------------

export const currentSalarySchema = z.object({
  employee_id: dbUuid,
  revision_id: dbUuid,
  revision_number: dbInt,
  revision_kind: z.string(),
  effective_from: dbDate,
  salary_structure_id: dbUuidNullable,
  salary_structure_code: z.string().nullable(),
  monthly_gross_paise: dbInt,
  monthly_employer_contribution_paise: dbInt,
  monthly_ctc_paise: dbInt,
  annual_ctc_paise: dbInt,
  ctc_at_join_paise: dbIntNullable,
  component_code: z.string().nullable(),
  component_name: z.string().nullable(),
  line_kind: z.string().nullable(),
  ctc_bucket: z.string().nullable(),
  monthly_amount_paise: dbIntNullable,
  annual_amount_paise: dbIntNullable,
  sequence: dbIntNullable,
  bucket_a_monthly_paise: dbIntNullable,
  bucket_b_monthly_paise: dbIntNullable,
  bucket_c_monthly_paise: dbIntNullable,
});
export type CurrentSalaryLine = z.infer<typeof currentSalarySchema>;

/**
 * The component grid of the CURRENT revision. One row per component line, plus
 * the header totals repeated on each line — the view is a join, so the caller
 * reads totals off `rows[0]` and never sums the lines itself (no client
 * arithmetic on payroll).
 */
export function fetchCurrentSalary(
  employeeId: string,
  signal?: AbortSignal,
): Promise<CurrentSalaryLine[]> {
  return selectMany("v_employee_current_salary", currentSalarySchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "sequence", ascending: true }],
    ...(signal ? { signal } : {}),
  });
}

export const salaryRevisionSchema = z.object({
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
  /** Server-computed percentage; may exceed 100 for a genuine doubling. */
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

export function fetchSalaryRevisions(
  employeeId: string,
  signal?: AbortSignal,
): Promise<SalaryRevision[]> {
  return selectMany("v_salary_revisions", salaryRevisionSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "effective_from", ascending: false }],
    ...(signal ? { signal } : {}),
  });
}
