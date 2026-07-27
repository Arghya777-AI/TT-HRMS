/**
 * profile.api.ts — the E-07 core reads: THE one employee row, plus the org
 * labels, reporting line, skills and hobbies that hang off it.
 *
 * Every E-07 tab reads the SAME `v_my_employee` row through
 * `fetchMyEmployeeProfile` under the SAME query key (`qk.profile.me()`), which
 * is the structural reason the Basic tab and the Employment tab can never
 * disagree about a shared field (the "7 vs 8" defect class, DR-29).
 *
 * `v_my_employee` is `SELECT e.* FROM employees WHERE id = app.current_employee_id()`
 * (migration 033) — pinned to the caller, so no filter is needed and none is
 * passed. The projection is still narrowed by hand: a `SELECT *` on that view
 * would drag `search_tsv` and the exit columns across the wire for a screen
 * that does not render them.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbInt,
  dbNumeric,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  selectMany,
  selectOne,
} from "@/shared/api/query";
import { updateOne } from "@/shared/api/write";
import { nowInstantIso } from "@/lib/datetime";

export const MY_EMPLOYEE_VIEW = "v_my_employee";
export const PROFILES_TABLE = "profiles";
export const TEAM_EMPLOYEE_BASIC_VIEW = "v_team_employee_basic";
export const EMPLOYEE_DIRECTORY_VIEW = "v_employee_directory";
export const COMPANIES_TABLE = "companies";
export const COST_CENTRES_TABLE = "cost_centres";
export const EMPLOYEE_SKILLS_TABLE = "employee_skills";
export const EMPLOYEE_HOBBIES_TABLE = "employee_hobbies";

// -----------------------------------------------------------------------------
// Enum vocabularies — parsed as unions so a new server value surfaces as a
// `parse` error here rather than as a raw code on screen (DR-53).
// -----------------------------------------------------------------------------

export const genderSchema = z.enum(["male", "female", "transgender", "prefer_not_to_say"]);
export type Gender = z.infer<typeof genderSchema>;

export const bloodGroupSchema = z.enum([
  "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown",
]);
export type BloodGroup = z.infer<typeof bloodGroupSchema>;

export const maritalStatusSchema = z.enum([
  "single", "married", "divorced", "widowed", "separated",
]);
export type MaritalStatus = z.infer<typeof maritalStatusSchema>;

export const employmentTypeSchema = z.enum([
  "permanent", "probation", "contract", "intern", "consultant", "casual",
  "apprentice", "retainer",
]);
export type EmploymentType = z.infer<typeof employmentTypeSchema>;

export const employmentStatusSchema = z.enum([
  "pre_joining", "active", "on_probation", "confirmed", "on_notice", "suspended",
  "on_long_leave", "absconding", "exited", "retired", "rehired",
]);
export type EmploymentStatus = z.infer<typeof employmentStatusSchema>;

export const paymentModeSchema = z.enum(["bank_transfer", "cash", "cheque", "upi"]);
export type PaymentMode = z.infer<typeof paymentModeSchema>;

// -----------------------------------------------------------------------------
// 1. THE employee row
// -----------------------------------------------------------------------------

/**
 * The columns E-07 renders, and only those. `date_of_birth_actual` is
 * deliberately absent: DR-51 rejects the reference product's shadow "Original
 * DOB" field, so this build reads exactly one DOB.
 */
export const myEmployeeProfileSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  title: z.string().nullable(),
  first_name: z.string(),
  middle_name: z.string().nullable(),
  last_name: z.string(),
  display_name: z.string(),
  preferred_name: z.string().nullable(),
  /**
   * Whitelisted by `public.employee_changeable_fields()` and therefore READ, so
   * the self-service editor can show the current value before proposing a new
   * one. `v_my_employee` is `SELECT e.*`, so this needs no view change.
   */
  name_in_local_script: z.string().nullable(),
  work_email: z.string().nullable(),
  personal_email: z.string().nullable(),
  mobile: z.string().nullable(),
  date_of_birth: dbDateNullable,
  gender: genderSchema.nullable(),
  blood_group: bloodGroupSchema,
  photo_path: z.string().nullable(),
  cover_photo_path: z.string().nullable(),
  about: z.string().nullable(),

  // Employment — all admin-only for the employee (spec-employee §6).
  employment_type: employmentTypeSchema,
  employment_status: employmentStatusSchema,
  date_of_join: dbDateNullable,
  probation_months: dbInt,
  confirmation_due_date: dbDateNullable,
  confirmed_on: dbDateNullable,
  contract_start_date: dbDateNullable,
  contract_end_date: dbDateNullable,
  notice_period_days: dbInt,
  company_id: dbUuid,
  department_id: dbUuidNullable,
  section_id: dbUuidNullable,
  designation_id: dbUuidNullable,
  grade_id: dbUuidNullable,
  location_id: dbUuidNullable,
  cost_centre_id: dbUuidNullable,
  reporting_manager_id: dbUuidNullable,
  dotted_line_manager_id: dbUuidNullable,
  work_order_number: z.string().nullable(),
  is_ot_eligible: z.boolean(),
  is_shift_worker: z.boolean(),
  attendance_policy_id: dbUuidNullable,
  weekly_off_rule_id: dbUuidNullable,
  holiday_calendar_id: dbUuidNullable,
  shift_id: dbUuidNullable,
  pay_period_id: dbUuidNullable,
  attendance_regularize_from: dbDateNullable,
  allow_web_punch: z.boolean(),
  exclude_from_attendance: z.boolean(),

  // Payment
  payment_mode: paymentModeSchema,
  primary_bank_account_id: dbUuidNullable,

  // Personal
  marital_status: maritalStatusSchema.nullable(),
  marriage_anniversary: dbDateNullable,
  father_or_spouse_name: z.string().nullable(),
  father_or_spouse_relation: z.enum(["father", "spouse"]).nullable(),
  mother_name: z.string().nullable(),
  nationality: z.string(),
  religion: z.string().nullable(),
  category: z.string().nullable(),
  is_differently_abled: z.boolean(),
  disability_type: z.string().nullable(),
  physical_address_same_as_permanent: z.boolean(),
  /**
   * The three venue-operations columns on `employees` — NOT custom fields. All
   * three are in `public.employee_changeable_fields()`, and `food_preference` is
   * one of the four the employee may write directly
   * (`GRANT UPDATE (about, photo_path, cover_photo_path, food_preference)`).
   * `ck_employees__food_preference` bounds the last one to
   * veg / non_veg / jain / eggetarian.
   */
  mode_of_transport: z.string().nullable(),
  uniform_size: z.string().nullable(),
  food_preference: z.string().nullable(),

  // Derived
  profile_completeness_pct: dbNumeric,
  face_enrolled_at: dbTimestampNullable,
});

export type MyEmployeeProfile = z.infer<typeof myEmployeeProfileSchema>;

const MY_EMPLOYEE_COLUMNS = [
  "id", "employee_code", "title", "first_name", "middle_name", "last_name",
  "display_name", "preferred_name", "name_in_local_script", "work_email",
  "personal_email", "mobile",
  "date_of_birth", "gender", "blood_group", "photo_path", "cover_photo_path",
  "about", "employment_type", "employment_status", "date_of_join",
  "probation_months", "confirmation_due_date", "confirmed_on",
  "contract_start_date", "contract_end_date", "notice_period_days", "company_id",
  "department_id", "section_id", "designation_id", "grade_id", "location_id",
  "cost_centre_id", "reporting_manager_id", "dotted_line_manager_id",
  "work_order_number", "is_ot_eligible", "is_shift_worker",
  "attendance_policy_id", "weekly_off_rule_id", "holiday_calendar_id",
  "shift_id", "pay_period_id", "attendance_regularize_from", "allow_web_punch",
  "exclude_from_attendance", "payment_mode", "primary_bank_account_id",
  "marital_status", "marriage_anniversary", "father_or_spouse_name",
  "father_or_spouse_relation", "mother_name", "nationality", "religion",
  "category", "is_differently_abled", "disability_type",
  "physical_address_same_as_permanent", "mode_of_transport", "uniform_size",
  "food_preference", "profile_completeness_pct",
  "face_enrolled_at",
].join(", ");

/**
 * The caller's own employee record. `null` means no employee row is visible —
 * a kiosk-only account, which the screen renders as no-permission, never as an
 * empty profile.
 */
export async function fetchMyEmployeeProfile(
  signal?: AbortSignal,
): Promise<MyEmployeeProfile | null> {
  return selectOne(MY_EMPLOYEE_VIEW, myEmployeeProfileSchema, [], {
    columns: MY_EMPLOYEE_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Stamp first-run completion (`must_change_password=false`,
 * `profile_confirmed_at=now()`) on the caller's own `profiles` row.
 *
 * KNOWN SERVER GAP — this cannot succeed from the browser today, and the caller
 * must handle the rejection rather than assume success. Migration 006b §6 does
 * `REVOKE UPDATE ON public.profiles FROM authenticated` and re-grants only
 * `(full_name, avatar_url, phone, locale, timezone)`, with the stated reason
 * that "the password/confirmation flags are HR/system-owned". Both columns this
 * writes are therefore outside the grant, so Postgres refuses with `42501`
 * (→ `kind: "no_permission"`) even though `profiles__self_update` allows the
 * ROW. Nothing in `supabase/functions/` or any RPC clears these flags either, so
 * the completion stamp has no server-side owner yet.
 *
 * It is written through `updateOne` regardless, because that is the contract for
 * a client write and because the refusal must be a thrown `QueryError` the UI
 * can tell the user about. The previous implementation issued the same UPDATE
 * inline from the page and discarded the `{ error }` PostgREST returns, so the
 * wizard reported success, the flags never cleared, and `FirstRunGate` — gated
 * on `must_change_password OR profile_confirmed_at IS NULL` — put the user back
 * into the wizard on the next sign-in. Closing this needs a
 * `SECURITY DEFINER` RPC (or an edge function) that owns the two columns.
 */
export async function markFirstRunComplete(
  profileId: string,
  signal?: AbortSignal,
): Promise<void> {
  await updateOne(
    PROFILES_TABLE,
    z.object({ id: dbUuid }),
    { must_change_password: false, profile_confirmed_at: nowInstantIso() },
    { id: profileId },
    { columns: "id", ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 2. Org labels — the resolved names behind the id columns
// -----------------------------------------------------------------------------

/**
 * `v_team_employee_basic` includes the caller's own row (migration 033: the
 * predicate is `id = current_employee_id() OR is_manager_of(...) OR admin`), so
 * one read gives every org NAME the Employment tab needs. Reading the lookup
 * tables individually would be five round trips for the same strings.
 */
export const orgLabelsSchema = z.object({
  id: dbUuid,
  department_name: z.string().nullable(),
  section_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  grade_name: z.string().nullable(),
  location_name: z.string().nullable(),
  is_on_probation: z.boolean(),
});

export type OrgLabels = z.infer<typeof orgLabelsSchema>;

const ORG_LABEL_COLUMNS =
  "id, department_name, section_name, designation_name, grade_name, location_name, is_on_probation";

export async function fetchOrgLabels(
  employeeId: string,
  signal?: AbortSignal,
): Promise<OrgLabels | null> {
  return selectOne(TEAM_EMPLOYEE_BASIC_VIEW, orgLabelsSchema, [eq("id", employeeId)], {
    columns: ORG_LABEL_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/** The legal entity behind the employment (DR-54: one entity, named in full). */
export const companySchema = z.object({
  id: dbUuid,
  legal_name: z.string(),
  trade_name: z.string(),
});

export type Company = z.infer<typeof companySchema>;

export async function fetchCompany(
  companyId: string,
  signal?: AbortSignal,
): Promise<Company | null> {
  return selectOne(COMPANIES_TABLE, companySchema, [eq("id", companyId)], {
    columns: "id, legal_name, trade_name",
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Reporting line — resolved through the directory view, not by id
// -----------------------------------------------------------------------------

/**
 * A person, rendered as a person: name + code + designation, never the
 * `Mrunalini Neelamraju-MIDCC001` mashup the reference product printed (DR-23).
 * `v_employee_directory` is the org-wide minimal view — no salary, no DOB, no
 * personal contact.
 */
export const personRefSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  photo_path: z.string().nullable(),
  work_email: z.string().nullable(),
  designation_name: z.string().nullable(),
  department_name: z.string().nullable(),
});

export type PersonRef = z.infer<typeof personRefSchema>;

const PERSON_REF_COLUMNS =
  "id, employee_code, display_name, photo_path, work_email, designation_name, department_name";

/**
 * Resolve the reporting and dotted-line managers in one round trip.
 *
 * A manager who has left the company is not in `v_employee_directory` (its
 * predicate excludes exited rows), so the caller may get back fewer people than
 * ids it asked for. That is rendered as "No longer with the company", not as a
 * blank — an absent row is information, not an error.
 */
export async function fetchPeople(
  employeeIds: readonly string[],
  signal?: AbortSignal,
): Promise<PersonRef[]> {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return [];
  return selectMany(EMPLOYEE_DIRECTORY_VIEW, personRefSchema, {
    filters: [{ op: "in", column: "id", values: ids }],
    columns: PERSON_REF_COLUMNS,
    limit: ids.length,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Skills + hobbies (self-edit, immediate)
// -----------------------------------------------------------------------------

export const skillSchema = z.object({
  id: dbUuid,
  name: z.string(),
  proficiency: z.enum(["beginner", "intermediate", "advanced", "expert"]).nullable(),
  years_experience: z.union([z.number(), z.string().transform(Number), z.null()]),
  is_verified: z.boolean(),
  sort_order: dbInt,
});

export type Skill = z.infer<typeof skillSchema>;

/** Max 20 per spec; the limit is asserted server-side, the cap here is a guard. */
export async function fetchSkills(employeeId: string, signal?: AbortSignal): Promise<Skill[]> {
  return selectMany(EMPLOYEE_SKILLS_TABLE, skillSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "sort_order" }, { column: "name" }],
    columns: "id, name, proficiency, years_experience, is_verified, sort_order",
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

export const hobbySchema = z.object({
  id: dbUuid,
  name: z.string(),
  sort_order: dbInt,
});

export type Hobby = z.infer<typeof hobbySchema>;

export async function fetchHobbies(employeeId: string, signal?: AbortSignal): Promise<Hobby[]> {
  return selectMany(EMPLOYEE_HOBBIES_TABLE, hobbySchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "sort_order" }, { column: "name" }],
    columns: "id, name, sort_order",
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}
