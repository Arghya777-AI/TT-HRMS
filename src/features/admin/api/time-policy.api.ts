/**
 * time-policy.api.ts — the effective-dated policy BINDINGS (§6.6) and the
 * SERVER's own resolution of them (§6.7).
 *
 * One table does all the binding: `public.policy_assignments` (migration 014 §6).
 * Its columns were read out of that migration, not assumed — in particular:
 *   * `assignment_kind` is CHECKed against six values
 *     ('attendance_policy','weekly_off_rule','holiday_calendar','leave_policy',
 *      'pay_period','shift') and `policy_id` is POLYMORPHIC per kind: there is no
 *     foreign key, so the id must be looked up in the table that kind belongs to.
 *   * `scope` is CHECKed against eight values and `ck_pa__scope_target` demands
 *     exactly the matching target column, which is why a create sends ONE target
 *     column and never a defensive spread of all eight.
 *   * there is NO `is_current` and no `is_active`: a binding is live when the
 *     date falls inside `[effective_from, effective_to]`, with `effective_to IS
 *     NULL` meaning open-ended (§1.6 bans sentinel dates).
 *   * the table is soft-deletable (`deleted_at`), and `policy_assignments__ref_read`
 *     lets an admin see archived rows — an archived binding is history, not noise.
 *
 * RESOLUTION IS NEVER RE-IMPLEMENTED HERE. `public.resolve_policy(kind, employee,
 * date)`, `public.resolve_shift_for_date(employee, date)` and
 * `public.is_weekly_off(rule, date, employee)` are the deployed functions the
 * attendance engine itself calls (migration 018 lines 240, 243, 283, 297), and
 * they are called over PostgREST rather than reproduced in TypeScript. The only
 * thing this module transcribes is the ORDER BY that decides WHICH candidate
 * wins — `SCOPE_RANK` below is that CASE expression, verbatim, so the debugging
 * screen can show the ranking the server used without inventing one.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  insertRow,
  isNotNull,
  isNull,
  isTrue,
  lte,
  restoreRow,
  rpcOne,
  selectCount,
  selectMany,
  selectOne,
  softDelete,
  updateRow,
  type Filter,
} from "@/shared/api/query";

export const POLICY_ASSIGNMENTS_TABLE = "policy_assignments";
export const SHIFT_ASSIGNMENTS_TABLE = "shift_assignments";
export const ROSTER_SLOTS_TABLE = "roster_slots";
export const DESIGNATIONS_TABLE = "designations";
export const SHIFTS_TABLE = "shifts";
export const EMPLOYEES_TABLE = "employees";

/** The three deployed resolver functions (migration 014 §8). */
export const RESOLVE_POLICY_FN = "resolve_policy";
export const RESOLVE_SHIFT_FN = "resolve_shift_for_date";
export const IS_WEEKLY_OFF_FN = "is_weekly_off";

// -----------------------------------------------------------------------------
// 1. The deployed vocabularies, verbatim from the CHECK constraints
// -----------------------------------------------------------------------------

/** `ck_pa__kind` — the six kinds the table accepts, in migration order. */
export const assignmentKindValues = [
  "attendance_policy",
  "weekly_off_rule",
  "holiday_calendar",
  "leave_policy",
  "pay_period",
  "shift",
] as const;
export type AssignmentKind = (typeof assignmentKindValues)[number];

/** `ck_pa__scope` — the eight scopes, narrowest first (see SCOPE_RANK). */
export const assignmentScopeValues = [
  "employee",
  "designation",
  "grade",
  "section",
  "department",
  "employment_type",
  "location",
  "company",
] as const;
export type AssignmentScope = (typeof assignmentScopeValues)[number];

/**
 * The specificity ladder, transcribed from `resolve_policy`'s ORDER BY CASE
 * (migration 014 lines 556–565). LOWER wins. Nothing on screen re-derives it,
 * and nothing here re-orders it: if the migration changes, this constant is the
 * one place that has to follow.
 */
export const SCOPE_RANK: Readonly<Record<AssignmentScope, number>> = {
  employee: 10,
  designation: 20,
  grade: 30,
  section: 40,
  department: 50,
  employment_type: 60,
  location: 70,
  company: 80,
};

/** The target column `ck_pa__scope_target` demands for each scope. */
export const SCOPE_TARGET_COLUMN: Readonly<Record<AssignmentScope, string>> = {
  employee: "employee_id",
  designation: "designation_id",
  grade: "grade_id",
  section: "section_id",
  department: "department_id",
  employment_type: "employment_type",
  location: "location_id",
  company: "company_id",
};

/**
 * Which table a `policy_id` points at, per kind. `leave_policy` is absent on
 * purpose: the CHECK accepts the kind but NO `leave_policies` table is deployed
 * (migration 019 creates leave_types, leave_requests, leave_ledger, …), so a
 * leave_policy binding's id cannot be resolved to a name and the screens say so
 * instead of printing a bare uuid as if it were a policy.
 */
export const KIND_POLICY_TABLE: Readonly<Partial<Record<AssignmentKind, string>>> = {
  attendance_policy: "attendance_policies",
  weekly_off_rule: "weekly_off_rules",
  holiday_calendar: "holiday_calendars",
  pay_period: "pay_periods",
  shift: "shifts",
};

// -----------------------------------------------------------------------------
// 2. policy_assignments — read
// -----------------------------------------------------------------------------

export const policyAssignmentSchema = z.object({
  id: dbUuid,
  assignment_kind: z.string(),
  policy_id: dbUuid,
  scope: z.string(),
  company_id: dbUuidNullable,
  location_id: dbUuidNullable,
  department_id: dbUuidNullable,
  section_id: dbUuidNullable,
  grade_id: dbUuidNullable,
  designation_id: dbUuidNullable,
  employment_type: z.string().nullable(),
  employee_id: dbUuidNullable,
  effective_from: dbDate,
  effective_to: dbDateNullable,
  priority: dbInt,
  reason: z.string().nullable(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
  deleted_at: dbTimestampNullable,
  deletion_reason: z.string().nullable(),
});
export type PolicyAssignment = z.infer<typeof policyAssignmentSchema>;

export interface AssignmentFilters {
  readonly kinds?: readonly string[];
  readonly scopes?: readonly string[];
  /** True → only archived rows; false/absent → only live rows. */
  readonly archived?: boolean;
  /**
   * Only bindings that have STARTED by this civil date. The other half of the
   * window (`effective_to IS NULL OR effective_to >= date`) is an OR and the
   * filter vocabulary is AND-only, so it is applied by `coversDate` below — the
   * same predicate `resolve_policy` uses, spelled once.
   */
  readonly startedBy?: string;
}

function assignmentFilters(f: AssignmentFilters): Filter[] {
  const filters: Filter[] = [
    f.archived === true ? isNotNull("deleted_at") : isNull("deleted_at"),
  ];
  if (f.kinds && f.kinds.length > 0) filters.push(inList("assignment_kind", f.kinds));
  if (f.scopes && f.scopes.length > 0) filters.push(inList("scope", f.scopes));
  if (f.startedBy !== undefined) filters.push(lte("effective_from", f.startedBy));
  return filters;
}

/**
 * `[effective_from, effective_to]` contains `isoDate` — the second half of
 * `resolve_policy`'s date predicate, with NULL meaning open-ended. Civil-date
 * string comparison is exact for 'YYYY-MM-DD' and matches Postgres's own
 * ordering; no Date object is constructed and no timezone is involved.
 */
export function coversDate(
  row: { readonly effective_from: string; readonly effective_to: string | null },
  isoDate: string,
): boolean {
  if (row.effective_from > isoDate) return false;
  return row.effective_to === null || row.effective_to >= isoDate;
}

/**
 * The binding register. `policy_assignments` is a CONFIG table — 18 rows on the
 * live project — so a bounded whole-table read is correct here and the cap is
 * explicit rather than hopeful.
 */
export function fetchPolicyAssignments(
  f: AssignmentFilters = {},
  limit = 500,
  signal?: AbortSignal,
): Promise<PolicyAssignment[]> {
  return selectMany(POLICY_ASSIGNMENTS_TABLE, policyAssignmentSchema, {
    filters: assignmentFilters(f),
    order: [
      { column: "assignment_kind", ascending: true },
      { column: "effective_from", ascending: false },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/** Postgres counts the register, over the SAME filter object as the grid. */
export function countPolicyAssignments(
  f: AssignmentFilters = {},
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(POLICY_ASSIGNMENTS_TABLE, assignmentFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Labels — a `policy_id` and a scope target resolved to a NAME
// -----------------------------------------------------------------------------

/**
 * Every table a `policy_id` or an org scope target can point at exposes
 * `id`/`code`/`name` (the §1.7 lookup shape), so one schema covers all of them.
 * `employees` is the exception and has its own reader below.
 */
export const policyRefSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
});
export type PolicyRef = z.infer<typeof policyRefSchema>;

export const employeeRefSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
});
export type EmployeeRef = z.infer<typeof employeeRefSchema>;

/** id → {code,name} for one lookup table. Empty input never hits the network. */
export async function fetchRefsByIds(
  table: string,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, PolicyRef>> {
  if (ids.length === 0) return new Map();
  const rows = await selectMany(table, policyRefSchema, {
    filters: [inList("id", ids)],
    columns: "id,code,name",
    limit: ids.length,
    ...(signal ? { signal } : {}),
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Employee names for `scope = 'employee'` bindings. `public.employees` grants
 * `SELECT (id, employee_code, display_name, …)` to `authenticated` (migration 033
 * re-issues that column grant verbatim), and `employees__admin_read` (051) is the
 * row gate — so this narrow projection is readable without `v_admin_employee`.
 */
export async function fetchEmployeeRefsByIds(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, EmployeeRef>> {
  if (ids.length === 0) return new Map();
  const rows = await selectMany(EMPLOYEES_TABLE, employeeRefSchema, {
    filters: [inList("id", ids)],
    columns: "id,employee_code,display_name",
    limit: ids.length,
    ...(signal ? { signal } : {}),
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/** The lookup table behind each ORG scope. `employment_type` is an enum value. */
export const SCOPE_REF_TABLE: Readonly<Partial<Record<AssignmentScope, string>>> = {
  company: "companies",
  location: "locations",
  department: "departments",
  section: "sections",
  grade: "grades",
  designation: "designations",
};

// -----------------------------------------------------------------------------
// 4. policy_assignments — writes (every one audited, none of them a DELETE)
// -----------------------------------------------------------------------------

export interface AssignmentCreateInput {
  readonly kind: AssignmentKind;
  readonly policyId: string;
  readonly scope: AssignmentScope;
  /** The ONE target `ck_pa__scope_target` demands: a uuid, or the enum value. */
  readonly target: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly priority: number;
}

/**
 * Create a binding. The reason is written to `policy_assignments.reason` AND
 * carried in `x-reason` for the audit trigger (attached in migration 038), so the
 * register itself says why a group of people changed policy — not only the log.
 */
export function insertPolicyAssignment(
  input: AssignmentCreateInput,
  reason: string,
  signal?: AbortSignal,
): Promise<PolicyAssignment> {
  const values: Record<string, unknown> = {
    assignment_kind: input.kind,
    policy_id: input.policyId,
    scope: input.scope,
    [SCOPE_TARGET_COLUMN[input.scope]]: input.target,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo,
    priority: input.priority,
    reason,
  };
  return insertRow(POLICY_ASSIGNMENTS_TABLE, values, policyAssignmentSchema, {
    reason,
    ...(signal ? { signal } : {}),
  });
}

export interface AssignmentEndDateInput {
  readonly id: string;
  /** Last date the binding applies. Must be >= effective_from (`ck_pa__range`). */
  readonly effectiveTo: string;
}

/**
 * END-DATE a binding instead of deleting it. This is what "changing a policy"
 * means on an effective-dated table: the old row keeps answering for the dates it
 * governed, so a recompute of last month still reproduces last month's figures.
 */
export function endDatePolicyAssignment(
  input: AssignmentEndDateInput,
  reason: string,
  signal?: AbortSignal,
): Promise<PolicyAssignment> {
  return updateRow(
    POLICY_ASSIGNMENTS_TABLE,
    [eq("id", input.id)],
    { effective_to: input.effectiveTo },
    policyAssignmentSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
}

/**
 * Archive a binding (D-23 soft delete). Used for a row created in error —
 * `ck_pa__deletion_reason` needs a reason of at least 10 characters, and the
 * screens ask for 15.
 */
export function archivePolicyAssignment(
  id: string,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  return softDelete(POLICY_ASSIGNMENTS_TABLE, id, { reason, ...(signal ? { signal } : {}) });
}

/** Restore an archived binding — the audit trigger records it as `restore`. */
export function restorePolicyAssignment(
  id: string,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  return restoreRow(POLICY_ASSIGNMENTS_TABLE, id, { reason, ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// 5. The resolver functions — the SERVER answers, always
// -----------------------------------------------------------------------------

/**
 * `public.resolve_policy(kind, employee, date)` → the winning `policy_id`, or
 * null when no binding covers the date. Identical call to the one the attendance
 * engine makes, so this screen cannot disagree with the engine.
 */
export function resolvePolicyId(
  kind: AssignmentKind,
  employeeId: string,
  isoDate: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return rpcOne(
    RESOLVE_POLICY_FN,
    { p_kind: kind, p_employee_id: employeeId, p_date: isoDate },
    dbUuid,
    signal ? { signal } : {},
  );
}

/**
 * `public.resolve_shift_for_date(employee, date)` → the shift the engine will
 * use. Its precedence is roster slot → shift_assignments → employees.shift_id →
 * designations.default_shift_id → the company's 'G' shift; the screen shows which
 * of those five answered by comparing this id against each step's own row.
 */
export function resolveShiftId(
  employeeId: string,
  isoDate: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return rpcOne(
    RESOLVE_SHIFT_FN,
    { p_employee_id: employeeId, p_date: isoDate },
    dbUuid,
    signal ? { signal } : {},
  );
}

/** `public.is_weekly_off(rule, date, employee)` — the single weekly-off decision. */
export async function resolveIsWeeklyOff(
  ruleId: string,
  isoDate: string,
  employeeId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const answer = await rpcOne(
    IS_WEEKLY_OFF_FN,
    { p_rule_id: ruleId, p_date: isoDate, p_employee_id: employeeId },
    z.boolean(),
    signal ? { signal } : {},
  );
  return answer ?? false;
}

// -----------------------------------------------------------------------------
// 6. The five steps of resolve_shift_for_date, as rows
// -----------------------------------------------------------------------------

export const rosterSlotRefSchema = z.object({
  id: dbUuid,
  roster_id: dbUuid,
  shift_id: dbUuidNullable,
  is_weekly_off: z.boolean(),
  is_published: z.boolean(),
  role_label: z.string().nullable(),
  planned_start_at: dbTimestampNullable,
  planned_end_at: dbTimestampNullable,
});
export type RosterSlotRef = z.infer<typeof rosterSlotRefSchema>;

/** Step 1: the PUBLISHED roster slot for that employee and date, if any. */
export function fetchPublishedRosterSlot(
  employeeId: string,
  isoDate: string,
  signal?: AbortSignal,
): Promise<RosterSlotRef | null> {
  return selectOne(
    ROSTER_SLOTS_TABLE,
    rosterSlotRefSchema,
    [eq("employee_id", employeeId), eq("slot_date", isoDate), isTrue("is_published"), isNull("deleted_at")],
    {
      columns: "id,roster_id,shift_id,is_weekly_off,is_published,role_label,planned_start_at,planned_end_at",
      ...(signal ? { signal } : {}),
    },
  );
}

export const shiftAssignmentSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  shift_id: dbUuid,
  effective_from: dbDate,
  effective_to: dbDateNullable,
  reason: z.string().nullable(),
  created_at: dbTimestamp,
});
export type ShiftAssignment = z.infer<typeof shiftAssignmentSchema>;

/**
 * Step 2: the employee's dated shift assignments that have STARTED by the date,
 * newest first — the same ORDER BY the function uses. `ex_shift_assignments__no_overlap`
 * makes at most one of them live, which is why "newest started" is unambiguous.
 */
export function fetchShiftAssignments(
  employeeId: string,
  isoDate: string,
  signal?: AbortSignal,
): Promise<ShiftAssignment[]> {
  return selectMany(SHIFT_ASSIGNMENTS_TABLE, shiftAssignmentSchema, {
    filters: [eq("employee_id", employeeId), isNull("deleted_at"), lte("effective_from", isoDate)],
    order: [{ column: "effective_from", ascending: false }],
    columns: "id,employee_id,shift_id,effective_from,effective_to,reason,created_at",
    limit: 20,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Give ONE employee a different shift from a date.
 *
 * WHY THIS WRITE DID NOT EXIST. `shift_assignments` has been in the schema since
 * migration 014, `resolve_shift_for_date` has read it as step 2 of five all along, and
 * `fetchShiftAssignments` above has displayed it — but nothing in the product could
 * create a row, so the table held zero of them. Changing one person's hours meant
 * changing their designation's default shift, which moves everybody on that designation,
 * or editing the shift master itself, which moves the whole venue.
 *
 * PRECEDENCE, so the caller knows what this does and does not beat: roster slot →
 * **shift_assignments** → `employees.shift_id` → `designations.default_shift_id` → the
 * company's 'G' shift. A published roster slot still wins, which is correct — a slot is a
 * decision about a named day and this is a standing arrangement.
 *
 * `effective_to` is optional and open-ended by design: "from Monday, Asha works the
 * evening shift" is the common case and has no end date. `ex_shift_assignments__no_overlap`
 * refuses a second overlapping row for the same employee, so a mistake surfaces as a
 * constraint violation rather than two live answers — which is why this does not close the
 * previous assignment for the caller. Ending one is a separate, deliberate act.
 */
export function insertShiftAssignment(
  input: {
    readonly employeeId: string;
    readonly shiftId: string;
    readonly effectiveFrom: string;
    readonly effectiveTo?: string | null;
  },
  reason: string,
  signal?: AbortSignal,
): Promise<ShiftAssignment> {
  return insertRow(
    SHIFT_ASSIGNMENTS_TABLE,
    {
      employee_id: input.employeeId,
      shift_id: input.shiftId,
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo ?? null,
      reason,
    },
    shiftAssignmentSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
}

/**
 * Create a shift with these exact timings AND put one employee on it, in one act.
 *
 * WHY BOTH IN ONE FUNCTION. `shift_assignments` carries `shift_id` and no times of its
 * own, so "this employee works 10:00–19:00" is not directly expressible: the timings have
 * to exist as a shift first. Before this, an administrator had to leave the employee they
 * were looking at, go to Time · Shifts, invent a code, create the shift, come back and
 * assign it. That is the same friction the "Other" option removed from the org lookups,
 * and the same fix applies.
 *
 * THE SHIFT IS REAL AND SHARED, NOT PRIVATE TO THIS PERSON. It appears in Time · Shifts
 * like any other and can be assigned to somebody else later — because a shift IS a
 * shared object here and pretending otherwise would need a per-employee times column
 * the schema does not have. The naming convention the caller passes should therefore say
 * who it was made for, or the shift list fills with anonymous windows.
 *
 * ORDER AND FAILURE. The shift is created first; if that fails nothing is assigned and
 * the message belongs to the shift. If the ASSIGNMENT then fails — an overlapping
 * standing assignment is the likely cause — the shift survives, which is deliberate: it
 * is a valid shift the admin can assign by hand, and deleting it would throw away work
 * to tidy up after a constraint that has already done its job.
 */
export async function createShiftAndAssign(
  input: {
    readonly companyId: string;
    readonly employeeId: string;
    readonly name: string;
    readonly code: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly durationMinutes: number;
    readonly unpaidBreakMinutes: number;
    readonly graceInMinutes: number;
    readonly graceOutMinutes: number;
    readonly effectiveFrom: string;
    readonly effectiveTo?: string | null;
  },
  reason: string,
  signal?: AbortSignal,
): Promise<{ shiftId: string; assignment: ShiftAssignment }> {
  const shift = await insertRow(
    SHIFTS_TABLE,
    {
      company_id: input.companyId,
      code: input.code,
      name: input.name,
      start_time: input.startTime,
      end_time: input.endTime,
      // NOT NULL with no default; `shifts_before_write()` computes the same number, and
      // `paidDurationMinutes` mirrors it. `crosses_midnight` is GENERATED — never sent.
      duration_minutes: input.durationMinutes,
      unpaid_break_minutes: input.unpaidBreakMinutes,
      grace_in_minutes: input.graceInMinutes,
      grace_out_minutes: input.graceOutMinutes,
      is_active: true,
    },
    z.object({ id: dbUuid }),
    { reason, ...(signal ? { signal } : {}) },
  );

  const assignment = await insertShiftAssignment(
    {
      employeeId: input.employeeId,
      shiftId: shift.id,
      effectiveFrom: input.effectiveFrom,
      ...(input.effectiveTo == null ? {} : { effectiveTo: input.effectiveTo }),
    },
    reason,
    signal,
  );

  return { shiftId: shift.id, assignment };
}

/** End a standing assignment on a date, leaving the row and its history intact. */
export function endShiftAssignment(
  id: string,
  effectiveTo: string,
  reason: string,
  signal?: AbortSignal,
): Promise<ShiftAssignment> {
  return updateRow(
    SHIFT_ASSIGNMENTS_TABLE,
    [eq("id", id)],
    { effective_to: effectiveTo },
    shiftAssignmentSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
}

export const designationShiftSchema = z.object({
  id: dbUuid,
  name: z.string(),
  default_shift_id: dbUuidNullable,
});
export type DesignationShift = z.infer<typeof designationShiftSchema>;

/** Step 4: the designation's default shift. */
export function fetchDesignationDefaultShift(
  designationId: string,
  signal?: AbortSignal,
): Promise<DesignationShift | null> {
  return selectOne(DESIGNATIONS_TABLE, designationShiftSchema, [eq("id", designationId)], {
    columns: "id,name,default_shift_id",
    ...(signal ? { signal } : {}),
  });
}

export const shiftDetailSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  /** Server-rendered, e.g. 'G — 09:30 AM to 06:30 PM'. Never rebuilt here. */
  display_label: z.string().nullable(),
  start_time: z.string(),
  end_time: z.string(),
  crosses_midnight: z.boolean(),
  duration_minutes: dbInt,
  grace_in_minutes: dbInt,
  night_shift: z.boolean(),
});
export type ShiftDetail = z.infer<typeof shiftDetailSchema>;

const SHIFT_DETAIL_COLUMNS =
  "id,code,name,display_label,start_time,end_time,crosses_midnight,duration_minutes,grace_in_minutes,night_shift";

/** One shift, for the resolved-shift card. */
export function fetchShiftDetail(
  shiftId: string,
  signal?: AbortSignal,
): Promise<ShiftDetail | null> {
  return selectOne(SHIFTS_TABLE, shiftDetailSchema, [eq("id", shiftId)], {
    columns: SHIFT_DETAIL_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/** Step 5: the company's `G` shift — the function's last resort. */
export function fetchCompanyDefaultShift(
  companyId: string,
  signal?: AbortSignal,
): Promise<ShiftDetail | null> {
  return selectOne(
    SHIFTS_TABLE,
    shiftDetailSchema,
    [eq("company_id", companyId), eq("code", "G"), isNull("deleted_at")],
    { columns: SHIFT_DETAIL_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 7. What the resolved calendar actually says for that date
// -----------------------------------------------------------------------------

export const holidayOnDateSchema = z.object({
  id: dbUuid,
  holiday_date: dbDate,
  name: z.string(),
  local_name: z.string().nullable(),
  holiday_type: z.string(),
  is_paid: z.boolean(),
  is_optional: z.boolean(),
  applies_to_department_ids: z.array(dbUuid).nullable(),
  applies_to_location_ids: z.array(dbUuid).nullable(),
});
export type HolidayOnDate = z.infer<typeof holidayOnDateSchema>;

/**
 * The holidays the RESOLVED calendar carries for that date. The engine adds
 * `applies_to_department_ids` filtering on top (migration 018 line 285), so the
 * screen shows the row AND whether the department filter would keep it — it never
 * hides a row the database returned.
 */
export function fetchHolidaysOnDate(
  calendarId: string,
  isoDate: string,
  signal?: AbortSignal,
): Promise<HolidayOnDate[]> {
  return selectMany("holidays", holidayOnDateSchema, {
    filters: [eq("holiday_calendar_id", calendarId), eq("holiday_date", isoDate), isTrue("is_active")],
    columns:
      "id,holiday_date,name,local_name,holiday_type,is_paid,is_optional,applies_to_department_ids,applies_to_location_ids",
    limit: 10,
    ...(signal ? { signal } : {}),
  });
}

export const payPeriodOnDateSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  start_date: dbDate,
  end_date: dbDate,
  attendance_cutoff_date: dbDate,
  pay_date: dbDate,
  financial_year: z.string(),
  is_open: z.boolean(),
  attendance_locked_at: dbTimestampNullable,
  payroll_finalised_at: dbTimestampNullable,
});
export type PayPeriodOnDate = z.infer<typeof payPeriodOnDateSchema>;

/**
 * The pay period whose window CONTAINS the date. `pay_periods` is not resolved
 * through `policy_assignments` by any deployed code path — the period is found by
 * its own date range (`idx_pay_periods__range`) — and the resolver screen states
 * that difference rather than implying an assignment decides it.
 */
export function fetchPayPeriodForDate(
  isoDate: string,
  signal?: AbortSignal,
): Promise<PayPeriodOnDate | null> {
  return selectOne(
    "pay_periods",
    payPeriodOnDateSchema,
    [lte("start_date", isoDate), gte("end_date", isoDate)],
    {
      columns:
        "id,code,name,start_date,end_date,attendance_cutoff_date,pay_date,financial_year,is_open,attendance_locked_at,payroll_finalised_at",
      order: [{ column: "start_date", ascending: false }],
      ...(signal ? { signal } : {}),
    },
  );
}
