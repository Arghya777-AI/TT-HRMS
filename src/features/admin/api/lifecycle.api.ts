/**
 * lifecycle.api.ts — the People §2 lifecycle reads: the stage board, the
 * onboarding/probation register, the movement register and the exit register.
 *
 * What the database actually deploys, established by reading the migrations
 * rather than the spec:
 *
 *  1. `employees.employment_status` is a PROJECTION of the append-only
 *     `employee_lifecycle_events` stream (migration 011 §1,
 *     `trg_ele__status_projection`). The trigger runs on INSERT INTO
 *     employee_lifecycle_events and writes employment_status / confirmed_on /
 *     resignation_date / last_working_day / exit_type onto `employees`. It does
 *     NOT run the other way: changing a department or a designation on
 *     `employees` appends NO event. There is no deployed function that records a
 *     transfer or a promotion as an event, so the movement register lists the
 *     events that exist and the Transfers screen says so in as many words.
 *  2. `confirmation_due_date` is a GENERATED STORED column
 *     (`date_of_join + probation_months`, migration 008). It is never computed
 *     here, and it cannot be written.
 *  3. Every register reads `v_admin_employee` (admin-scoped, `deleted_at IS
 *     NULL` inside the view is NOT guaranteed — migration 051 keeps soft-deleted
 *     rows visible to admins, so each predicate here excludes them explicitly).
 *
 * Registers are CAPPED lists plus an independent `count=exact`, not keyset
 * pages: the useful order for onboarding is `confirmation_due_date` and for
 * exits `last_working_day`, and both are NULLABLE — a keyset cursor cannot be
 * built off a null sort key. The screen therefore states "showing the first N of
 * M" instead of implying the list is complete.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbTimestamp,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  ilike,
  inList,
  isFalse,
  isNotNull,
  isNull,
  isTrue,
  lte,
  selectCount,
  selectMany,
  type Filter,
  type OrderSpec,
} from "@/shared/api/query";
import { t } from "@/shared/i18n/en";
import {
  V_ADMIN_EMPLOYEE,
  employmentStatusSchema,
  employmentTypeSchema,
  type EmploymentStatus,
} from "./employees.api";
import {
  V_DOCUMENT_COMPLIANCE,
  complianceRowSchema,
  type ComplianceRow,
} from "./documents.api";

export const LIFECYCLE_EVENTS_TABLE = "employee_lifecycle_events";

/** Hard cap on one register read. Every screen prints it when it bites. */
export const LIFECYCLE_LIST_LIMIT = 200;

// -----------------------------------------------------------------------------
// 1. The employee side of the lifecycle — one row shape for all four registers
// -----------------------------------------------------------------------------

export const LIFECYCLE_COLUMNS = [
  "id",
  "employee_code",
  "display_name",
  "employment_status",
  "employment_type",
  "date_of_join",
  "probation_months",
  "confirmation_due_date",
  "confirmed_on",
  "notice_period_days",
  "resignation_date",
  "last_working_day",
  "exit_type",
  "exit_reason",
  "exit_interview_done",
  "is_rehire_eligible",
  "full_and_final_settled_on",
  "department_id",
  "department_name",
  "section_name",
  "designation_id",
  "designation_name",
  "grade_name",
  "location_name",
  "reporting_manager_name",
  "work_email",
  "mobile",
  "updated_at",
].join(",");

/**
 * `date_of_join` is deliberately NULLABLE here even though the directory's own
 * schema demands it: a `pre_joining` row created outside the wizard legitimately
 * has no joining date yet, and a register whose whole purpose is joiners must not
 * fail to parse the very rows it exists to show.
 */
export const lifecycleEmployeeSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  employment_status: employmentStatusSchema,
  employment_type: employmentTypeSchema,
  date_of_join: dbDateNullable,
  probation_months: dbInt,
  /** GENERATED column: date_of_join + probation_months. Never derived client-side. */
  confirmation_due_date: dbDateNullable,
  confirmed_on: dbDateNullable,
  notice_period_days: dbInt,
  resignation_date: dbDateNullable,
  last_working_day: dbDateNullable,
  exit_type: z.string().nullable(),
  exit_reason: z.string().nullable(),
  exit_interview_done: z.boolean(),
  is_rehire_eligible: z.boolean().nullable(),
  full_and_final_settled_on: dbDateNullable,
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  section_name: z.string().nullable(),
  designation_id: dbUuidNullable,
  designation_name: z.string().nullable(),
  grade_name: z.string().nullable(),
  location_name: z.string().nullable(),
  reporting_manager_name: z.string().nullable(),
  work_email: z.string().nullable(),
  mobile: z.string().nullable(),
  updated_at: dbTimestamp,
});
export type LifecycleEmployee = z.infer<typeof lifecycleEmployeeSchema>;

export interface LifecycleFilters {
  readonly statuses?: readonly EmploymentStatus[];
  readonly departmentIds?: readonly string[];
  readonly locationIds?: readonly string[];
  readonly nameLike?: string;
  /** `confirmation_due_date <= this` — the "due by" window of the probation register. */
  readonly dueOnOrBefore?: string;
  /** `confirmation_due_date >= this`. */
  readonly dueOnOrAfter?: string;
  /** Only rows that HAVE a confirmation due date (i.e. a joining date exists). */
  readonly hasConfirmationDue?: boolean;
  readonly lastWorkingDayFrom?: string;
  readonly lastWorkingDayTo?: string;
  readonly exitTypes?: readonly string[];
  /** true → full-and-final NOT yet recorded; false → recorded. */
  readonly settlementPending?: boolean;
  /** true → exit interview not done; false → done. */
  readonly interviewPending?: boolean;
  readonly rehireEligible?: boolean;
  /**
   * Whether a rehire decision EXISTS at all. `is_rehire_eligible` is a nullable
   * boolean, so "not decided" is a third state (NULL) that `rehireEligible`
   * cannot express — and on a rehire register the undecided pile is the work.
   * true → decided either way; false → NULL, nobody has ruled.
   */
  readonly rehireDecided?: boolean;
}

/**
 * ONE predicate builder for the count and the list, so a tile can never
 * disagree with the register underneath it (DR-29, the `7 vs 8` defect).
 */
function lifecycleFilters(f: LifecycleFilters): Filter[] {
  const filters: Filter[] = [isNull("deleted_at")];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("employment_status", f.statuses));
  if (f.departmentIds && f.departmentIds.length > 0)
    filters.push(inList("department_id", f.departmentIds));
  if (f.locationIds && f.locationIds.length > 0) filters.push(inList("location_id", f.locationIds));
  if (f.nameLike && f.nameLike.trim() !== "")
    filters.push(ilike("display_name", `%${f.nameLike.trim()}%`));
  if (f.hasConfirmationDue === true) filters.push(isNotNull("confirmation_due_date"));
  if (f.dueOnOrBefore !== undefined) filters.push(lte("confirmation_due_date", f.dueOnOrBefore));
  if (f.dueOnOrAfter !== undefined) filters.push(gte("confirmation_due_date", f.dueOnOrAfter));
  if (f.lastWorkingDayFrom !== undefined) filters.push(gte("last_working_day", f.lastWorkingDayFrom));
  if (f.lastWorkingDayTo !== undefined) filters.push(lte("last_working_day", f.lastWorkingDayTo));
  if (f.exitTypes && f.exitTypes.length > 0) filters.push(inList("exit_type", f.exitTypes));
  if (f.settlementPending === true) filters.push(isNull("full_and_final_settled_on"));
  if (f.settlementPending === false) filters.push(isNotNull("full_and_final_settled_on"));
  if (f.interviewPending === true) filters.push(isFalse("exit_interview_done"));
  if (f.interviewPending === false) filters.push(isTrue("exit_interview_done"));
  if (f.rehireEligible === true) filters.push(isTrue("is_rehire_eligible"));
  if (f.rehireEligible === false) filters.push(isFalse("is_rehire_eligible"));
  if (f.rehireDecided === true) filters.push(isNotNull("is_rehire_eligible"));
  if (f.rehireDecided === false) filters.push(isNull("is_rehire_eligible"));
  return filters;
}

/** How the register is sorted. The api owns the column names, not the page. */
export type LifecycleOrder = "code" | "confirmationDue" | "lastWorkingDay" | "joinDate";

const ORDERS: Readonly<Record<LifecycleOrder, readonly OrderSpec[]>> = {
  code: [{ column: "employee_code", ascending: true }],
  // Nulls last: a row with no joining date has no due date either, and it must
  // not sit above the person whose confirmation is overdue today.
  confirmationDue: [
    { column: "confirmation_due_date", ascending: true, nullsFirst: false },
    { column: "employee_code", ascending: true },
  ],
  lastWorkingDay: [
    { column: "last_working_day", ascending: false, nullsFirst: false },
    { column: "employee_code", ascending: true },
  ],
  joinDate: [
    { column: "date_of_join", ascending: false, nullsFirst: false },
    { column: "employee_code", ascending: true },
  ],
};

/** Counted by Postgres, over the same predicate as `fetchLifecycleRegister`. */
export function countLifecycle(f: LifecycleFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_ADMIN_EMPLOYEE, lifecycleFilters(f), { ...(signal ? { signal } : {}) });
}

export function fetchLifecycleRegister(
  f: LifecycleFilters,
  order: LifecycleOrder,
  limit = LIFECYCLE_LIST_LIMIT,
  signal?: AbortSignal,
): Promise<LifecycleEmployee[]> {
  return selectMany(V_ADMIN_EMPLOYEE, lifecycleEmployeeSchema, {
    filters: lifecycleFilters(f),
    order: ORDERS[order],
    limit,
    columns: LIFECYCLE_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `employees.exit_type` is TEXT with a CHECK constraint, not an enum
 * (`ck_employees__exit_type`, migration 008) — these six values and NULL are the
 * whole vocabulary. Two neighbouring constraints matter to the exit register:
 *   - `ck_employees__exit_fields`: employment_status = 'exited' REQUIRES both
 *     `last_working_day` and `exit_type`, so an exited row can never show a blank
 *     leaving date — a blank one means the row is not `exited` yet;
 *   - `ck_employees__join_before_lwd`: last_working_day >= date_of_join.
 */
export const exitTypeValues = [
  "resignation",
  "termination",
  "end_of_contract",
  "retirement",
  "absconding",
  "death",
] as const;
export type ExitType = (typeof exitTypeValues)[number];

/** Human labels — the raw constraint value never reaches a screen (D-10). */
export const EXIT_TYPE_LABELS: Readonly<Record<ExitType, string>> = {
  resignation: t("admin.exits.type.resignation"),
  termination: t("admin.exits.type.termination"),
  end_of_contract: t("admin.exits.type.endOfContract"),
  retirement: t("admin.exits.type.retirement"),
  absconding: t("admin.exits.type.absconding"),
  death: t("admin.exits.type.death"),
};

export function isExitType(value: string | null): value is ExitType {
  return value !== null && exitTypeValues.some((v) => v === value);
}

// -----------------------------------------------------------------------------
// 2. The event stream — `employee_lifecycle_events` (append-only, migration 011)
// -----------------------------------------------------------------------------

/** `public.lifecycle_event_type` (migration 003) — the deployed enum, in order. */
export const lifecycleEventTypeValues = [
  "offer_accepted",
  "joined",
  "probation_started",
  "confirmed",
  "probation_extended",
  "promoted",
  "transferred",
  "department_changed",
  "manager_changed",
  "salary_revised",
  "suspended",
  "reinstated",
  "notice_started",
  "resigned",
  "terminated",
  "absconded",
  "retired",
  "contract_ended",
  "rehired",
  "deceased",
] as const;
export const lifecycleEventTypeSchema = z.enum(lifecycleEventTypeValues);
export type LifecycleEventType = z.infer<typeof lifecycleEventTypeSchema>;

/** Human labels — the raw enum never reaches a screen (D-10). */
export const LIFECYCLE_EVENT_LABELS: Readonly<Record<LifecycleEventType, string>> = {
  offer_accepted: t("admin.lifecycle.event.offer_accepted"),
  joined: t("admin.lifecycle.event.joined"),
  probation_started: t("admin.lifecycle.event.probation_started"),
  confirmed: t("admin.lifecycle.event.confirmed"),
  probation_extended: t("admin.lifecycle.event.probation_extended"),
  promoted: t("admin.lifecycle.event.promoted"),
  transferred: t("admin.lifecycle.event.transferred"),
  department_changed: t("admin.lifecycle.event.department_changed"),
  manager_changed: t("admin.lifecycle.event.manager_changed"),
  salary_revised: t("admin.lifecycle.event.salary_revised"),
  suspended: t("admin.lifecycle.event.suspended"),
  reinstated: t("admin.lifecycle.event.reinstated"),
  notice_started: t("admin.lifecycle.event.notice_started"),
  resigned: t("admin.lifecycle.event.resigned"),
  terminated: t("admin.lifecycle.event.terminated"),
  absconded: t("admin.lifecycle.event.absconded"),
  retired: t("admin.lifecycle.event.retired"),
  contract_ended: t("admin.lifecycle.event.contract_ended"),
  rehired: t("admin.lifecycle.event.rehired"),
  deceased: t("admin.lifecycle.event.deceased"),
};

/**
 * The four event types that are a MOVEMENT rather than a status change. The
 * status-projection trigger maps every one of them to NULL, i.e. an employee's
 * `employment_status` is untouched by a promotion or a transfer — which is why
 * these four are the register on /admin/people/transfers.
 */
export const MOVEMENT_EVENT_TYPES: readonly LifecycleEventType[] = [
  "promoted",
  "transferred",
  "department_changed",
  "manager_changed",
];

const jsonObject = z.record(z.string(), z.unknown());

export const lifecycleEventSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  event_type: lifecycleEventTypeSchema,
  effective_date: dbDate,
  recorded_at: dbTimestamp,
  recorded_by: dbUuid,
  /** NOT NULL with a ≥10-character check constraint — always a real sentence. */
  reason: z.string(),
  from_values: jsonObject.nullable(),
  to_values: jsonObject.nullable(),
  approval_request_id: dbUuidNullable,
  document_id: dbUuidNullable,
  is_reversed: z.boolean(),
  reversed_by_event_id: dbUuidNullable,
});
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

export interface LifecycleEventFilters {
  readonly eventTypes?: readonly LifecycleEventType[];
  readonly employeeIds?: readonly string[];
  /** `effective_date >= from` / `<= to`. */
  readonly from?: string;
  readonly to?: string;
  /** Default false: a reversed event is history, and history is shown on request. */
  readonly includeReversed?: boolean;
}

function eventFilters(f: LifecycleEventFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.eventTypes && f.eventTypes.length > 0) filters.push(inList("event_type", f.eventTypes));
  if (f.employeeIds && f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  if (f.from !== undefined) filters.push(gte("effective_date", f.from));
  if (f.to !== undefined) filters.push(lte("effective_date", f.to));
  if (f.includeReversed !== true) filters.push(isFalse("is_reversed"));
  return filters;
}

/**
 * The event register, newest effective date first.
 *
 * Read straight off the table: there is NO view over
 * `employee_lifecycle_events` in the deployed schema, and its RLS policy
 * (`ele__scope_read`) already restricts rows to employees the caller may see.
 * The table carries `employee_id` and no name, so the screen joins labels
 * through `useEmployeeLabels` — an id-to-label lookup, not a computation.
 */
export function fetchLifecycleEvents(
  f: LifecycleEventFilters,
  limit = LIFECYCLE_LIST_LIMIT,
  signal?: AbortSignal,
): Promise<LifecycleEvent[]> {
  return selectMany(LIFECYCLE_EVENTS_TABLE, lifecycleEventSchema, {
    filters: eventFilters(f),
    order: [
      { column: "effective_date", ascending: false },
      { column: "recorded_at", ascending: false },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export function countLifecycleEvents(
  f: LifecycleEventFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(LIFECYCLE_EVENTS_TABLE, eventFilters(f), { ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// 3. The nearest thing to an onboarding checklist that is actually deployed
// -----------------------------------------------------------------------------

/**
 * One joiner's required-document checklist, from `v_document_compliance`.
 *
 * There is NO onboarding-task table in the deployed schema: `document_types`
 * carries `is_required_for_onboarding`, and this view expands it into one row per
 * (employee × required document type) with a server-decided
 * `compliance_status` of missing / expired / expiring_soon / valid. That is the
 * checklist, and it is the whole checklist.
 *
 * Two boundaries the screen states rather than papers over:
 *   - the view's own WHERE clause restricts it to employment_status IN
 *     (active, confirmed, on_probation, on_notice), so a `pre_joining` joiner has
 *     NO rows here — their paperwork cannot be tracked until they join;
 *   - it lists document types only, not induction/asset/IT tasks, because no
 *     such table exists to read.
 */
export function fetchOnboardingChecklist(
  employeeId: string,
  signal?: AbortSignal,
): Promise<ComplianceRow[]> {
  return selectMany(V_DOCUMENT_COMPLIANCE, complianceRowSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [
      { column: "compliance_status", ascending: true },
      { column: "document_type_name", ascending: true },
    ],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. The movement patch — an audited UPDATE of the employee master
// -----------------------------------------------------------------------------

/**
 * The columns a transfer or promotion actually moves. All five are inside the
 * admin's granted UPDATE set on `employees` (migration 051 §2), so the write is
 * the ordinary audited `updateEmployee` — one row per changed field in
 * `audit_log`, carrying the typed reason.
 *
 * `employment_status` is NOT here: it is the projection of the event stream and
 * a movement does not change it.
 */
export interface MovementInput {
  readonly departmentId?: string;
  readonly sectionId?: string;
  readonly designationId?: string;
  readonly gradeId?: string;
  readonly reportingManagerId?: string;
}

/** Only the fields the admin actually filled — the patch is a diff, not a form dump. */
export function movementPatch(input: MovementInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.departmentId !== undefined) patch["department_id"] = input.departmentId;
  if (input.sectionId !== undefined) patch["section_id"] = input.sectionId;
  if (input.designationId !== undefined) patch["designation_id"] = input.designationId;
  if (input.gradeId !== undefined) patch["grade_id"] = input.gradeId;
  if (input.reportingManagerId !== undefined)
    patch["reporting_manager_id"] = input.reportingManagerId;
  return patch;
}
