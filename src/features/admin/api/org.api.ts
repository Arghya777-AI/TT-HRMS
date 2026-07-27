/**
 * org.api.ts — Organisation config (§3) and time-policy masters (§6).
 *
 * Ten tables with the same shape and the same lifecycle (code, name,
 * sort_order, is_active, soft delete), so they share ONE registry rather than
 * ten near-identical modules. The registry is what makes the generic list /
 * insert / update / archive functions safe: a screen names an entity, and the
 * table name, the zod schema and the reason floor all come from one place.
 *
 * Reason handling differs per table and is not guessed:
 *   * `holidays` and `pay_periods` ARE in `audit.reason_required_tables` — a
 *     reasonless UPDATE is refused with 22023.
 *   * `departments`, `sections`, `designations`, `grades`, `locations`,
 *     `cost_centres`, `shifts`, `weekly_off_rules`, `holiday_calendars` are NOT
 *     in that list, but they are audited (triggers attached in migration 038)
 *     and a config change that silently re-prices attendance for a whole
 *     department deserves the same sentence. Every write here carries one.
 *
 * All of these are versioned + soft-deletable (§4): retiring a department keeps
 * historical attendance rows resolvable, which is why nothing here deletes.
 */
import { z } from "zod";
import {
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
  gte,
  ilike,
  insertRow,
  isNotNull,
  isNull,
  lte,
  selectMany,
  selectOne,
  softDelete,
  updateRow,
  type Filter,
} from "@/shared/api/query";
import { t } from "@/shared/i18n/en";

export const REASON_ORG_MASTER = t("admin.reason.default.orgMaster");

/** Columns every org master shares (`public.*` reference-table convention). */
const referenceBase = {
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: dbInt,
  is_active: z.boolean(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
};

const softDeletable = {
  deleted_at: dbTimestampNullable,
  deletion_reason: z.string().nullable(),
};

export const departmentSchema = z.object({
  ...referenceBase,
  ...softDeletable,
  company_id: dbUuid,
  head_employee_id: dbUuidNullable,
  cost_centre_id: dbUuidNullable,
  is_operational: z.boolean(),
});
export type Department = z.infer<typeof departmentSchema>;

export const sectionSchema = z.object({
  ...referenceBase,
  ...softDeletable,
  department_id: dbUuid,
  head_employee_id: dbUuidNullable,
});
export type Section = z.infer<typeof sectionSchema>;

export const designationSchema = z.object({
  ...referenceBase,
  ...softDeletable,
  company_id: dbUuid,
  grade_id: dbUuidNullable,
  is_managerial: z.boolean(),
  is_executive: z.boolean(),
  default_shift_id: dbUuidNullable,
  ot_eligible: z.boolean(),
});
export type Designation = z.infer<typeof designationSchema>;

export const gradeSchema = z.object({
  ...referenceBase,
  ...softDeletable,
  company_id: dbUuid,
  level: dbInt,
  min_ctc_monthly_paise: dbIntNullable,
  max_ctc_monthly_paise: dbIntNullable,
  leave_policy_id: dbUuidNullable,
  notice_period_days: dbIntNullable,
  probation_months: dbIntNullable,
});
export type Grade = z.infer<typeof gradeSchema>;

export const locationSchema = z.object({
  ...referenceBase,
  ...softDeletable,
  company_id: dbUuid,
  address: z.unknown().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  pincode: z.string().nullable(),
  lat: dbNumericNullable,
  lng: dbNumericNullable,
  geofence_radius_m: dbIntNullable,
  /** Locked to Asia/Kolkata by the schema — displayed, never offered as a choice. */
  timezone: z.string(),
  default_holiday_calendar_id: dbUuidNullable,
  is_primary: z.boolean(),
});
export type Location = z.infer<typeof locationSchema>;

export const costCentreSchema = z.object({
  ...referenceBase,
  ...softDeletable,
  company_id: dbUuid,
  parent_cost_centre_id: dbUuidNullable,
  budget_monthly_paise: dbIntNullable,
  owner_employee_id: dbUuidNullable,
});
export type CostCentre = z.infer<typeof costCentreSchema>;

export const shiftSchema = z.object({
  ...referenceBase,
  ...softDeletable,
  company_id: dbUuid,
  start_time: z.string(),
  end_time: z.string(),
  crosses_midnight: z.boolean(),
  duration_minutes: dbInt,
  unpaid_break_minutes: dbInt,
  paid_break_minutes: dbInt,
  grace_in_minutes: dbInt,
  grace_out_minutes: dbInt,
  half_day_minutes: dbInt,
  absent_below_minutes: dbInt,
  full_day_minutes: dbInt,
  min_minutes_for_present: dbInt,
  ot_threshold_minutes: dbInt,
  night_shift: z.boolean(),
  night_allowance_component_id: dbUuidNullable,
  day_cutover_time: z.string(),
  colour_hex: z.string().nullable(),
  /** Server-rendered label, e.g. 'G — 09:30 AM to 06:30 PM'. Never rebuilt here. */
  display_label: z.string().nullable(),
});
export type Shift = z.infer<typeof shiftSchema>;

export const weeklyOffRuleSchema = z.object({
  ...referenceBase,
  company_id: dbUuid,
  rule_kind: z.string(),
  first_off_dow: dbIntNullable,
  first_off_weeks: z.array(dbInt).nullable(),
  second_off_dow: dbIntNullable,
  second_off_weeks: z.array(dbInt).nullable(),
  third_off_dow: dbIntNullable,
  third_off_weeks: z.array(dbInt).nullable(),
  offs_per_week: dbNumericNullable,
  week_of_month_basis: z.string().nullable(),
  half_day_dow: dbIntNullable,
  is_rotational: z.boolean(),
  rotation_pattern: z.unknown().nullable(),
  rotation_anchor_date: dbDateNullable,
});
export type WeeklyOffRule = z.infer<typeof weeklyOffRuleSchema>;

export const holidayCalendarSchema = z.object({
  ...referenceBase,
  ...softDeletable,
  company_id: dbUuid,
  year: dbInt,
  state: z.string().nullable(),
  is_default: z.boolean(),
  total_holiday_quota: dbIntNullable,
  optional_holiday_quota: dbIntNullable,
});
export type HolidayCalendar = z.infer<typeof holidayCalendarSchema>;

/** `holidays` has no `code`/`sort_order` — it is a child, not a master. */
export const holidaySchema = z.object({
  id: dbUuid,
  holiday_calendar_id: dbUuid,
  holiday_date: dbDate,
  name: z.string(),
  local_name: z.string().nullable(),
  holiday_type: z.string(),
  is_paid: z.boolean(),
  is_optional: z.boolean(),
  applies_to_department_ids: z.array(dbUuid).nullable(),
  applies_to_location_ids: z.array(dbUuid).nullable(),
  working_if_event_booked: z.boolean(),
  compensatory_off_if_worked: z.boolean(),
  pay_multiplier_if_worked: dbNumericNullable,
  description: z.string().nullable(),
  is_active: z.boolean(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});
export type Holiday = z.infer<typeof holidaySchema>;

/**
 * `attendance_policies` — the rulebook every attendance number is judged against
 * (§6.4). Columns are the deployed ones; `half_day_minutes` and
 * `absent_below_minutes` are nullable because a policy may defer to the shift.
 */
export const attendancePolicySchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  grace_in_minutes: dbInt,
  grace_out_minutes: dbInt,
  late_after_grace_counts_full: z.boolean(),
  max_late_days_before_deduction: dbIntNullable,
  late_deduction_leave_days: dbNumericNullable,
  late_deduction_leave_type_id: dbUuidNullable,
  late_deduction_reset_period: z.string().nullable(),
  early_exit_deduction_enabled: z.boolean(),
  auto_deduct_break: z.boolean(),
  min_break_minutes_to_count: dbIntNullable,
  max_break_minutes_paid: dbIntNullable,
  overtime_enabled: z.boolean(),
  overtime_requires_approval: z.boolean(),
  overtime_multiplier: dbNumericNullable,
  overtime_min_minutes: dbIntNullable,
  overtime_rounding_minutes: dbIntNullable,
  max_overtime_minutes_per_day: dbIntNullable,
  max_overtime_minutes_per_week: dbIntNullable,
  max_payable_minutes_per_day: dbIntNullable,
  extra_work_compensation: z.string().nullable(),
  comp_off_min_minutes: dbIntNullable,
  comp_off_full_day_minutes: dbIntNullable,
  comp_off_expiry_days: dbIntNullable,
  half_day_minutes: dbIntNullable,
  absent_below_minutes: dbIntNullable,
  single_punch_treatment: z.string().nullable(),
  missing_out_grace_minutes: dbIntNullable,
  regularization_window_days: dbIntNullable,
  max_regularizations_per_month: dbIntNullable,
  regularization_requires_manager: z.boolean(),
  absent_marking_delay_hours: dbIntNullable,
  allow_web_punch: z.boolean(),
  allow_mobile_punch: z.boolean(),
  punch_debounce_seconds: dbIntNullable,
  min_confidence_for_auto_accept: dbNumericNullable,
  min_margin_for_auto_accept: dbNumericNullable,
  require_liveness: z.boolean(),
  week_start_dow: dbIntNullable,
  deleted_at: dbTimestampNullable,
  deletion_reason: z.string().nullable(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});
export type AttendancePolicy = z.infer<typeof attendancePolicySchema>;

export const companySchema = z.object({
  ...referenceBase,
  legal_name: z.string(),
  trade_name: z.string().nullable(),
  entity_type: z.string().nullable(),
  registration_number: z.string().nullable(),
  incorporation_date: dbDateNullable,
  pan: z.string().nullable(),
  tan: z.string().nullable(),
  gstin: z.string().nullable(),
  pf_establishment_code: z.string().nullable(),
  esi_establishment_code: z.string().nullable(),
  lwf_registration: z.string().nullable(),
  shops_establishment_reg: z.string().nullable(),
});
export type Company = z.infer<typeof companySchema>;

// -----------------------------------------------------------------------------
// The registry — one row per editable org entity
// -----------------------------------------------------------------------------

export interface OrgEntitySpec {
  readonly table: string;
  readonly schema: z.ZodTypeAny;
  /** Default ordering for the grid. */
  readonly orderBy: string;
  /** True when the table carries `deleted_at` (so Archive + softDelete work). */
  readonly softDeletable: boolean;
  /** True when the table is in `audit.reason_required_tables`. */
  readonly reasonEnforcedByDb: boolean;
}

export const ORG_ENTITIES = {
  departments: {
    table: "departments",
    schema: departmentSchema,
    orderBy: "sort_order",
    softDeletable: true,
    reasonEnforcedByDb: false,
  },
  sections: {
    table: "sections",
    schema: sectionSchema,
    orderBy: "sort_order",
    softDeletable: true,
    reasonEnforcedByDb: false,
  },
  designations: {
    table: "designations",
    schema: designationSchema,
    orderBy: "sort_order",
    softDeletable: true,
    reasonEnforcedByDb: false,
  },
  grades: {
    table: "grades",
    schema: gradeSchema,
    orderBy: "level",
    softDeletable: true,
    reasonEnforcedByDb: false,
  },
  locations: {
    table: "locations",
    schema: locationSchema,
    orderBy: "sort_order",
    softDeletable: true,
    reasonEnforcedByDb: false,
  },
  costCentres: {
    table: "cost_centres",
    schema: costCentreSchema,
    orderBy: "sort_order",
    softDeletable: true,
    reasonEnforcedByDb: false,
  },
  shifts: {
    table: "shifts",
    schema: shiftSchema,
    orderBy: "sort_order",
    softDeletable: true,
    reasonEnforcedByDb: false,
  },
  weeklyOffRules: {
    table: "weekly_off_rules",
    schema: weeklyOffRuleSchema,
    orderBy: "sort_order",
    softDeletable: false,
    reasonEnforcedByDb: false,
  },
  holidayCalendars: {
    table: "holiday_calendars",
    schema: holidayCalendarSchema,
    orderBy: "year",
    softDeletable: true,
    reasonEnforcedByDb: false,
  },
  attendancePolicies: {
    table: "attendance_policies",
    schema: attendancePolicySchema,
    orderBy: "code",
    softDeletable: true,
    // `attendance_policies` IS in audit.reason_required_tables (migration 006).
    reasonEnforcedByDb: true,
  },
} as const satisfies Record<string, OrgEntitySpec>;

export type OrgEntityKey = keyof typeof ORG_ENTITIES;

export interface OrgListFilters {
  readonly includeInactive?: boolean;
  readonly archived?: boolean;
  readonly nameLike?: string;
  /** e.g. `{ department_id: '…' }` for sections, `{ grade_id: '…' }`. */
  readonly parent?: Readonly<Record<string, string>>;
}

function orgFilters(spec: OrgEntitySpec, f: OrgListFilters): Filter[] {
  const filters: Filter[] = [];
  if (spec.softDeletable) filters.push(f.archived === true ? isNotNull("deleted_at") : isNull("deleted_at"));
  if (f.includeInactive !== true) filters.push({ op: "is", column: "is_active", value: true });
  if (f.nameLike !== undefined && f.nameLike.trim() !== "")
    filters.push(ilike("name", `%${f.nameLike.trim()}%`));
  for (const [column, value] of Object.entries(f.parent ?? {})) filters.push(eq(column, value));
  return filters;
}

/**
 * List one org entity. The return type is inferred from the registry, so
 * `fetchOrgList("departments", …)` yields `Department[]` with no cast.
 */
export function fetchOrgList<K extends OrgEntityKey>(
  entity: K,
  f: OrgListFilters = {},
  signal?: AbortSignal,
): Promise<z.infer<(typeof ORG_ENTITIES)[K]["schema"]>[]> {
  const spec: OrgEntitySpec = ORG_ENTITIES[entity];
  return selectMany(spec.table, spec.schema, {
    filters: orgFilters(spec, f),
    order: [{ column: spec.orderBy, ascending: true }],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

export function fetchOrgRow<K extends OrgEntityKey>(
  entity: K,
  id: string,
  signal?: AbortSignal,
): Promise<z.infer<(typeof ORG_ENTITIES)[K]["schema"]> | null> {
  const spec: OrgEntitySpec = ORG_ENTITIES[entity];
  return selectOne(spec.table, spec.schema, [eq("id", id)], { ...(signal ? { signal } : {}) });
}

/** Create an org master row. Audited; a default reason is acceptable. */
export function insertOrgRow<K extends OrgEntityKey>(
  entity: K,
  values: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<z.infer<(typeof ORG_ENTITIES)[K]["schema"]>> {
  const spec: OrgEntitySpec = ORG_ENTITIES[entity];
  return insertRow(spec.table, values, spec.schema, { reason, ...(signal ? { signal } : {}) });
}

/**
 * Edit an org master row. `code` is deliberately editable only where the schema
 * allows it; the caller decides. The reason is required either way.
 */
export function updateOrgRow<K extends OrgEntityKey>(
  entity: K,
  id: string,
  patch: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<z.infer<(typeof ORG_ENTITIES)[K]["schema"]>> {
  const spec: OrgEntitySpec = ORG_ENTITIES[entity];
  return updateRow(spec.table, [eq("id", id)], patch, spec.schema, {
    reason,
    ...(signal ? { signal } : {}),
  });
}

/** Retire an org master row (soft delete). Always prompts. */
export function archiveOrgRow<K extends OrgEntityKey>(
  entity: K,
  id: string,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  const spec: OrgEntitySpec = ORG_ENTITIES[entity];
  if (!spec.softDeletable) {
    return Promise.reject(
      new Error(`${spec.table} has no deleted_at column — deactivate it with is_active instead.`),
    );
  }
  return softDelete(spec.table, id, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Holidays (`/admin/time/holidays`) — a child table, reason enforced by the DB
// -----------------------------------------------------------------------------

export const HOLIDAYS_TABLE = "holidays";

export function fetchHolidays(
  calendarId: string,
  opts: { from?: string; to?: string } = {},
  signal?: AbortSignal,
): Promise<Holiday[]> {
  const filters: Filter[] = [eq("holiday_calendar_id", calendarId)];
  if (opts.from !== undefined) filters.push(gte("holiday_date", opts.from));
  if (opts.to !== undefined) filters.push(lte("holiday_date", opts.to));
  return selectMany(HOLIDAYS_TABLE, holidaySchema, {
    filters,
    order: [{ column: "holiday_date", ascending: true }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

export interface HolidayInput {
  readonly holidayCalendarId: string;
  readonly holidayDate: string;
  readonly name: string;
  readonly holidayType: string;
  readonly isPaid?: boolean;
  readonly isOptional?: boolean;
  readonly localName?: string;
  readonly appliesToDepartmentIds?: readonly string[];
  readonly compensatoryOffIfWorked?: boolean;
  readonly payMultiplierIfWorked?: number;
  /** A booked event turns this holiday into a working day for the departments involved. */
  readonly workingIfEventBooked?: boolean;
  readonly description?: string;
}

/**
 * Add a holiday. `holidays` is in `audit.reason_required_tables`, so this is one
 * of the writes where a missing reason is a hard 22023 from the database.
 */
export function insertHoliday(
  input: HolidayInput,
  reason: string,
  signal?: AbortSignal,
): Promise<Holiday> {
  return insertRow(
    HOLIDAYS_TABLE,
    {
      holiday_calendar_id: input.holidayCalendarId,
      holiday_date: input.holidayDate,
      name: input.name,
      holiday_type: input.holidayType,
      is_paid: input.isPaid ?? true,
      is_optional: input.isOptional ?? false,
      ...(input.localName !== undefined ? { local_name: input.localName } : {}),
      ...(input.appliesToDepartmentIds !== undefined
        ? { applies_to_department_ids: [...input.appliesToDepartmentIds] }
        : {}),
      ...(input.compensatoryOffIfWorked !== undefined
        ? { compensatory_off_if_worked: input.compensatoryOffIfWorked }
        : {}),
      ...(input.payMultiplierIfWorked !== undefined
        ? { pay_multiplier_if_worked: input.payMultiplierIfWorked }
        : {}),
      ...(input.workingIfEventBooked !== undefined
        ? { working_if_event_booked: input.workingIfEventBooked }
        : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
    holidaySchema,
    { reason, ...(signal ? { signal } : {}) },
  );
}

export function updateHoliday(
  id: string,
  patch: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<Holiday> {
  return updateRow(HOLIDAYS_TABLE, [eq("id", id)], patch, holidaySchema, {
    reason,
    ...(signal ? { signal } : {}),
  });
}

/** Holidays have no soft delete; withdrawing one is `is_active = false`. */
export function deactivateHoliday(id: string, reason: string, signal?: AbortSignal): Promise<Holiday> {
  return updateRow(HOLIDAYS_TABLE, [eq("id", id)], { is_active: false }, holidaySchema, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Company / legal entity (`/admin/org/entities`) — super-admin edit only
// -----------------------------------------------------------------------------

export const COMPANIES_TABLE = "companies";

export function fetchCompanies(signal?: AbortSignal): Promise<Company[]> {
  return selectMany(COMPANIES_TABLE, companySchema, {
    order: [{ column: "sort_order", ascending: true }],
    limit: 20,
    ...(signal ? { signal } : {}),
  });
}

export function updateCompany(
  id: string,
  patch: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<Company> {
  return updateRow(COMPANIES_TABLE, [eq("id", id)], patch, companySchema, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

/** Departments/designations for a filter chip row, resolved to id + name only. */
export function fetchOrgRefs(
  entity: Extract<OrgEntityKey, "departments" | "designations" | "locations" | "grades" | "costCentres">,
  signal?: AbortSignal,
): Promise<{ id: string; code: string; name: string }[]> {
  const spec: OrgEntitySpec = ORG_ENTITIES[entity];
  return selectMany(spec.table, z.object({ id: dbUuid, code: z.string(), name: z.string() }), {
    filters: [isNull("deleted_at"), { op: "is", column: "is_active", value: true }],
    order: [{ column: "name", ascending: true }],
    columns: "id,code,name",
    limit: 300,
    ...(signal ? { signal } : {}),
  });
}

/** Section list scoped to one department — the dependent picker. */
export function fetchSectionsOfDepartment(
  departmentId: string,
  signal?: AbortSignal,
): Promise<Section[]> {
  return fetchOrgList("sections", { parent: { department_id: departmentId } }, signal);
}

