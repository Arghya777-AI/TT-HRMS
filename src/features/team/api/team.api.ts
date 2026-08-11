/**
 * team.api.ts — the ONLY read path for the manager surface.
 *
 * A MANAGER IS DERIVED, NEVER GRANTED. There is no "manager" row anywhere: the
 * capability comes from reporting lines, and the database enforces the scope, so
 * every read here goes through a view whose own WHERE clause already answers
 * "may this caller see this person?" — `app.is_manager_of()`,
 * `app.can_see_employee()` or `current_approver_ids @> me`. This module never
 * queries a base employee/attendance table, and it never adds a
 * "reporting_manager_id = me" predicate as a security measure, because a client
 * predicate is not a security boundary (frontend-contract §2).
 *
 * The views this module reads, and what each one is FOR:
 *
 *  - `v_team_employee_basic` — the manager COLUMN ALLOW-LIST. Rows: self +
 *    recursive reportees (+ scoped admins). Columns: identity, org placement,
 *    employment dates, shift pointers, contact, and `birthday_display` which the
 *    view deliberately renders as day+month with NO year. There is no salary, no
 *    PAN/Aadhaar, no bank, no home address, no dependents in it — a manager
 *    screen therefore cannot leak them by accident, and there is nothing to
 *    "reveal".
 *  - `v_team_hierarchy` — the recursive reporting closure with `depth` and
 *    `is_direct`, so an indirect report is visibly indirect. MATVIEW-BACKED:
 *    `refreshed_at` is a real fact and the screen must print it (§9.4).
 *  - `v_attendance_today_board` — one row per in-scope employee for TODAY, with
 *    every presence flag and the IST wall-clock first/last scan already
 *    computed. Scope is `app.can_see_employee`, i.e. exactly the team.
 *  - `v_approval_inbox` — requests where the caller is a current approver.
 *
 * TWO VIEWS MIGRATIONS 010/016/034 PROMISED IN COMMENTS AND NEVER CREATED now
 * exist — migration 055 (`team_views_gap`) built both, with the same posture as
 * `v_team_employee_basic` (`security_barrier`, predicate = self OR
 * `app.is_manager_of` OR scoped admin). Sections 7.1 and 7.2 below read them,
 * and nothing in this module ever touches the base tables they front:
 *  - `v_team_punches` — a manager's window on their team's RAW scans. It
 *    deliberately omits `photo_path` (the gate capture), `lat`/`lng`/`ip`/
 *    `user_agent` and the face-match distances: a manager needs to know WHEN
 *    their reportee scanned, not to hold their biometric telemetry. Voided
 *    scans are INCLUDED and flagged, because the log is evidence and hiding a
 *    voided row would make a correction look like it never happened.
 *  - `v_team_custom_fields` — the venue-specific fields, joined to their
 *    definition for the label and kind. A manager sees a reportee's NON-PII
 *    fields only (the view's predicate is on the DEFINITION as well as the row),
 *    and inactive definitions are hidden. So an empty result means "nothing
 *    non-PII is recorded", which the screen has to say in those words.
 *
 * `v_exception_queue` is likewise NOT read here: its final predicate is
 * `WHERE app.is_admin() AND …`, so a manager gets zero rows from it. Wiring it
 * to a manager screen would render "no exceptions" — a confident lie — instead
 * of "not yours".
 *
 * NO ARITHMETIC. Every presence flag, every minute figure and every count in
 * this module is a server column or a `count=exact`. Nothing is summed,
 * averaged, or re-derived from loaded rows.
 */
import { z } from "zod";
import {
  MutationError,
  SENSITIVE_REASON_LENGTH,
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumeric,
  dbNumericNullable,
  dbPercentNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  isNotNull,
  isTrue,
  lt,
  lte,
  mutationUserMessage,
  rpcAudited,
  rpcMany,
  selectCount,
  selectMany,
  selectOne,
  selectOneOrThrow,
  type Filter,
} from "@/shared/api/query";
import { t } from "@/shared/i18n/en";
import type { StatusChipEntry } from "@/shared/ui/StatusChip";
import { decideLeaveRequest } from "@/features/admin/api/leave.api";
import { punchSourceSchema } from "@/features/attendance/api/attendance.api";
import { customFieldTypeSchema } from "@/features/profile/api/custom-fields.api";
import {
  approvalInboxSchema,
  fetchApprovalInbox,
  type ApprovalInboxRow,
} from "@/features/approvals/api/approvals.api";

/**
 * The inbox READER is the employee surface's, re-exported rather than forked.
 * `/me/approvals` and `/team/approvals` list the same rows out of the same view
 * with the same zod schema; a second copy of a 21-field shape is a second thing
 * to forget to update.
 */
export { approvalInboxSchema, fetchApprovalInbox };
export type { ApprovalInboxRow };

// -----------------------------------------------------------------------------
// Relations — named once, never inlined at a call site
// -----------------------------------------------------------------------------

export const V_TEAM_BASIC = "v_team_employee_basic";
export const V_TEAM_HIERARCHY = "v_team_hierarchy";
export const V_TEAM_TODAY_BOARD = "v_attendance_today_board";
export const V_APPROVAL_INBOX = "v_approval_inbox";
/** Reference master: RLS gives `authenticated` every active shift (migration 014). */
export const SHIFTS_TABLE = "shifts";

/**
 * Hard row caps. A manager's recursive team is small by construction (the
 * closure is capped at 8 levels in `analytics.mv_team_hierarchy`), but an
 * unbounded read is still a bug waiting for one reorganisation.
 */
export const TEAM_ROW_CAP = 500;

// -----------------------------------------------------------------------------
// Shared vocabulary — employment lifecycle labels
// -----------------------------------------------------------------------------

/**
 * `public.employment_status` (migration 003). An employment state must read
 * IDENTICALLY on every surface — the admin directory and this manager list are
 * looking at the same column — so these reuse the one existing catalogue entry
 * per value rather than forking a second wording for the same fact
 * (frontend-contract §10: one format, app-wide; DR-53: never the raw enum).
 */
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

export const EMPLOYMENT_STATUS_CHIP: Readonly<Record<EmploymentStatus, StatusChipEntry>> = {
  pre_joining: { label: t("admin.employee.status.pre_joining"), tone: "info" },
  active: { label: t("admin.employee.status.active"), tone: "success" },
  on_probation: { label: t("admin.employee.status.on_probation"), tone: "warn" },
  confirmed: { label: t("admin.employee.status.confirmed"), tone: "success" },
  on_notice: { label: t("admin.employee.status.on_notice"), tone: "warn" },
  suspended: { label: t("admin.employee.status.suspended"), tone: "danger" },
  on_long_leave: { label: t("admin.employee.status.on_long_leave"), tone: "info" },
  absconding: { label: t("admin.employee.status.absconding"), tone: "danger" },
  exited: { label: t("admin.employee.status.exited"), tone: "neutral" },
  retired: { label: t("admin.employee.status.retired"), tone: "neutral" },
  rehired: { label: t("admin.employee.status.rehired"), tone: "info" },
};

/** `public.employment_type` (migration 003), same reuse rationale as above. */
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

/**
 * `public.attendance_status`, chipped for the team board. The board view
 * COALESCEs a missing `attendance_days` row to 'pending', which honestly means
 * "the engine has not written today's row yet", not "absent".
 */
export const DAY_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pending: { label: t("team.dayStatus.pending"), tone: "info" },
  present: { label: t("team.dayStatus.present"), tone: "success" },
  absent: { label: t("team.dayStatus.absent"), tone: "danger" },
  half_day: { label: t("team.dayStatus.half_day"), tone: "warn" },
  weekly_off: { label: t("team.dayStatus.weekly_off"), tone: "neutral" },
  weekly_off_worked: { label: t("team.dayStatus.weekly_off_worked"), tone: "success" },
  holiday: { label: t("team.dayStatus.holiday"), tone: "neutral" },
  holiday_worked: { label: t("team.dayStatus.holiday_worked"), tone: "success" },
  on_leave: { label: t("team.dayStatus.on_leave"), tone: "info" },
  on_leave_half: { label: t("team.dayStatus.on_leave_half"), tone: "info" },
  comp_off_availed: { label: t("team.dayStatus.comp_off_availed"), tone: "info" },
  on_duty: { label: t("team.dayStatus.on_duty"), tone: "success" },
  work_from_home: { label: t("team.dayStatus.work_from_home"), tone: "success" },
  suspended: { label: t("team.dayStatus.suspended"), tone: "danger" },
  not_yet: { label: t("team.dayStatus.not_yet"), tone: "neutral" },
};

// -----------------------------------------------------------------------------
// 1. Team Today — `v_attendance_today_board`, scoped by app.can_see_employee
// -----------------------------------------------------------------------------

/**
 * The board columns this surface prints. `shift_display_label` is deliberately
 * NOT selected: the database builds it as "G — 09:30 AM to 06:30 PM" and a
 * 12-hour clock is banned app-wide (DR-53). A column that must never reach the
 * screen should not reach the browser either.
 */
export const teamTodayRowSchema = z.object({
  employee_id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  department_name: z.string().nullable(),
  ist_date: z.string(),
  status: z.string(),
  shift_code: z.string().nullable(),
  /** timestamptz: shift start + the policy/shift grace the SERVER chose. */
  expected_by: dbTimestampNullable,
  /** IST wall clock 'HH:MM', pre-rendered by the view. The FIRST scan = arrival. */
  first_in_hm: z.string().nullable(),
  /** IST wall clock 'HH:MM', pre-rendered by the view. The LAST scan = departure. */
  last_out_hm: z.string().nullable(),
  punch_count: dbInt,
  worked_minutes: dbInt,
  /** The view's own 'H:MM' rendering of worked_minutes. */
  worked_hm: z.string().nullable(),
  is_late: z.boolean(),
  late_minutes: dbInt,
  attended: z.boolean(),
  off_today: z.boolean(),
  yet_to_reach: z.boolean(),
  late_in: z.boolean(),
  on_time: z.boolean(),
  overdue: z.boolean(),
});
export type TeamTodayRow = z.infer<typeof teamTodayRowSchema>;

const TEAM_TODAY_COLUMNS =
  "employee_id, employee_code, display_name, department_name, ist_date, status, " +
  "shift_code, expected_by, first_in_hm, last_out_hm, punch_count, worked_minutes, " +
  "worked_hm, is_late, late_minutes, attended, off_today, yet_to_reach, late_in, " +
  "on_time, overdue";

/** The presence slices the tiles count and the grid filters to. */
export const teamPresenceSlices = [
  "in",
  "yet_to_reach",
  "overdue",
  "late",
  "on_leave",
  "off",
] as const;
export type TeamPresenceSlice = (typeof teamPresenceSlices)[number];

export function isTeamPresenceSlice(value: string | null): value is TeamPresenceSlice {
  return value !== null && (teamPresenceSlices as readonly string[]).includes(value);
}

/**
 * ONE predicate per slice, used by BOTH the tile count and the row list.
 *
 * This shared function is the whole reason a tile and the grid it opens cannot
 * disagree (the "7 vs 8" defect, DR-29): the same `Filter[]` goes to
 * `selectCount` and to `selectMany`, so the number is by construction the
 * cardinality of the rows shown.
 *
 * Note `on_leave` is a filter on the SERVER's day status, not on `off_today` —
 * `off_today` also covers weekly offs and holidays, and calling a weekly off
 * "on leave" would be a wrong number with a confident label.
 */
export function teamPresenceFilters(slice: TeamPresenceSlice | null): Filter[] {
  switch (slice) {
    case "in":
      return [isTrue("attended")];
    case "yet_to_reach":
      return [isTrue("yet_to_reach")];
    case "overdue":
      return [isTrue("overdue")];
    case "late":
      return [isTrue("late_in")];
    case "on_leave":
      return [inList("status", ["on_leave", "on_leave_half"])];
    case "off":
      return [isTrue("off_today")];
    case null:
      return [];
  }
}

/** Today's board for MY team. RLS decides "my"; this function does not. */
export function fetchTeamToday(
  slice: TeamPresenceSlice | null,
  signal?: AbortSignal,
): Promise<TeamTodayRow[]> {
  return selectMany(V_TEAM_TODAY_BOARD, teamTodayRowSchema, {
    filters: teamPresenceFilters(slice),
    columns: TEAM_TODAY_COLUMNS,
    order: [{ column: "display_name", ascending: true }],
    limit: TEAM_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

/** A tile's number: counted by Postgres over the tile's own predicate. */
export function countTeamPresence(
  slice: TeamPresenceSlice | null,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_TEAM_TODAY_BOARD, teamPresenceFilters(slice), {
    ...(signal ? { signal } : {}),
  });
}

/** Today's board row for ONE reportee — the "today at the gate" card. */
export function fetchTeamTodayForEmployee(
  employeeId: string,
  signal?: AbortSignal,
): Promise<TeamTodayRow | null> {
  return selectOne(V_TEAM_TODAY_BOARD, teamTodayRowSchema, [eq("employee_id", employeeId)], {
    columns: TEAM_TODAY_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/** Requests waiting on THIS caller's decision. A count only — the queue is /team/approvals. */
export function countMyApprovalInbox(signal?: AbortSignal): Promise<number> {
  return selectCount(V_APPROVAL_INBOX, [], { ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// 2. My Team — `v_team_hierarchy` × `v_team_employee_basic`
// -----------------------------------------------------------------------------

export const teamEdgeSchema = z.object({
  manager_employee_id: dbUuidNullable,
  employee_id: dbUuid,
  /** 1 = direct report, 2 = reports to a direct report, … capped at 8 by the matview. */
  depth: dbInt,
  is_direct: z.boolean(),
  /** Constant per matview refresh — the screen prints it as "as of …". */
  refreshed_at: dbTimestamp,
});
export type TeamEdge = z.infer<typeof teamEdgeSchema>;

/**
 * Why `managerEmployeeId` is a parameter and not a security claim.
 *
 * `v_team_hierarchy` admits three row sets: edges where the caller is the
 * MANAGER, edges where the caller is the REPORTEE (their own upward chain), and
 * everything for an admin. Reading it unfiltered would therefore list the
 * caller as a member of their own team and mix in edges owned by their boss.
 * The `manager_employee_id` predicate is a CORRECTNESS filter that selects the
 * downward half of a view that legitimately serves both directions. The
 * security boundary is still entirely the view's — passing somebody else's id
 * here returns nothing.
 */
function edgeFilters(managerEmployeeId: string, directOnly: boolean): Filter[] {
  const filters: Filter[] = [eq("manager_employee_id", managerEmployeeId)];
  if (directOnly) filters.push(isTrue("is_direct"));
  return filters;
}

export function fetchTeamEdges(
  managerEmployeeId: string,
  directOnly: boolean,
  signal?: AbortSignal,
): Promise<TeamEdge[]> {
  return selectMany(V_TEAM_HIERARCHY, teamEdgeSchema, {
    filters: edgeFilters(managerEmployeeId, directOnly),
    columns: "manager_employee_id, employee_id, depth, is_direct, refreshed_at",
    order: [
      { column: "depth", ascending: true },
      { column: "employee_id", ascending: true },
    ],
    limit: TEAM_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

/** The header total — Postgres's count over the same predicate as the list. */
export function countTeamEdges(
  managerEmployeeId: string,
  directOnly: boolean,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_TEAM_HIERARCHY, edgeFilters(managerEmployeeId, directOnly), {
    ...(signal ? { signal } : {}),
  });
}

/** The one edge that says HOW a given reportee reports to the caller. */
export function fetchTeamEdge(
  managerEmployeeId: string,
  employeeId: string,
  signal?: AbortSignal,
): Promise<TeamEdge | null> {
  return selectOne(
    V_TEAM_HIERARCHY,
    teamEdgeSchema,
    [eq("manager_employee_id", managerEmployeeId), eq("employee_id", employeeId)],
    {
      columns: "manager_employee_id, employee_id, depth, is_direct, refreshed_at",
      ...(signal ? { signal } : {}),
    },
  );
}

/**
 * The manager column allow-list, in full. Everything a manager may know about a
 * reportee is in this schema; anything absent from it is absent by DESIGN, and
 * there is nothing here to unmask, so this surface has no reveal control at all.
 */
export const teamMemberSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  photo_path: z.string().nullable(),
  work_email: z.string().nullable(),
  mobile: z.string().nullable(),
  department_name: z.string().nullable(),
  section_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  grade_name: z.string().nullable(),
  location_name: z.string().nullable(),
  employment_type: employmentTypeSchema,
  employment_status: employmentStatusSchema,
  date_of_join: dbDateNullable,
  confirmation_due_date: dbDateNullable,
  is_on_probation: z.boolean(),
  reporting_manager_id: dbUuidNullable,
  dotted_line_manager_id: dbUuidNullable,
  shift_id: dbUuidNullable,
  is_shift_worker: z.boolean(),
  is_ot_eligible: z.boolean(),
  is_face_enrolled: z.boolean(),
  /** Day + month, no year — the view renders it that way on purpose. */
  birthday_display: z.string().nullable(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

/** Key facts for a known set of reportees. Empty set → no request at all. */
export async function fetchTeamMembersByIds(
  employeeIds: readonly string[],
  signal?: AbortSignal,
): Promise<TeamMember[]> {
  if (employeeIds.length === 0) return [];
  return selectMany(V_TEAM_BASIC, teamMemberSchema, {
    filters: [inList("id", employeeIds)],
    order: [{ column: "display_name", ascending: true }],
    limit: TEAM_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

/**
 * One reportee by the code the URL carries. Absence THROWS
 * `QueryError{kind:"not_found"}` rather than returning null, because on this
 * route absence means the view withheld the row — the honest render is
 * "not yours", not an empty profile.
 */
export function fetchTeamMemberByCode(
  employeeCode: string,
  signal?: AbortSignal,
): Promise<TeamMember> {
  return selectOneOrThrow(V_TEAM_BASIC, teamMemberSchema, [eq("employee_code", employeeCode)], {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Reference labels — shift master
// -----------------------------------------------------------------------------

/**
 * `display_label` is NOT selected. The DB stores it as
 * "G — 09:30 AM to 06:30 PM"; the screen renders `code` and, where it needs the
 * window, `fmtCivilTime(start_time)`–`fmtCivilTime(end_time)` in 24h.
 */
export const shiftRefSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  /** Postgres `time` — a civil wall clock, no timezone. Format with fmtCivilTime. */
  start_time: z.string(),
  end_time: z.string(),
  crosses_midnight: z.boolean(),
});
export type ShiftRef = z.infer<typeof shiftRefSchema>;

export async function fetchShiftRefsByIds(
  shiftIds: readonly string[],
  signal?: AbortSignal,
): Promise<ShiftRef[]> {
  if (shiftIds.length === 0) return [];
  return selectMany(SHIFTS_TABLE, shiftRefSchema, {
    filters: [inList("id", shiftIds)],
    columns: "id, code, name, start_time, end_time, crosses_midnight",
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// =============================================================================
// 4. DECISIONS — /team/approvals
// =============================================================================

export const APPROVAL_REQUESTS_TABLE = "approval_requests";
export const APPROVAL_ACTIONS_TABLE = "approval_actions";
export const LEAVE_REQUESTS_TABLE = "leave_requests";
/** Directory-safe label helper; the only way to put a name on a `profiles.id`. */
export const V_EMPLOYEE_REF = "v_employee_ref";
/** The single client-facing action RPC (migration 029 §11). */
export const ACT_ON_APPROVAL_FN = "act_on_approval";

/** `v_approval_inbox` is capped at 100 rows by `fetchApprovalInbox`. */
export const APPROVAL_ROW_CAP = 100;

/**
 * The inbox tiles. Each key is a PREDICATE and the same array goes to
 * `selectCount` and to the grid's own filter, so a tile is by construction the
 * cardinality of the rows it opens.
 *
 * `overdue` and `escalated` are read off the COLUMNS `is_overdue` and
 * `escalated_at`. The clock is never compared in the browser: `is_overdue` is
 * `now() > sla_due_at` evaluated inside Postgres, on the server's clock, in the
 * same statement that produced the row.
 */
export const APPROVAL_SLICE_FILTERS = {
  all: [] as readonly Filter[],
  overdue: [isTrue("is_overdue")] as readonly Filter[],
  escalated: [isNotNull("escalated_at")] as readonly Filter[],
} as const;

export type ApprovalSlice = keyof typeof APPROVAL_SLICE_FILTERS;

export function isApprovalSlice(value: string | null): value is ApprovalSlice {
  return value === "all" || value === "overdue" || value === "escalated";
}

/** How many decisions are waiting on this approver, in one slice. */
export function countApprovalInboxSlice(
  slice: ApprovalSlice,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_APPROVAL_INBOX, APPROVAL_SLICE_FILTERS[slice], {
    ...(signal ? { signal } : {}),
  });
}

/**
 * The polymorphic pointer plus the submitted payload of an approval request.
 *
 * `v_approval_inbox` exposes neither `detail_table`/`detail_id` nor `summary`,
 * and those are what turn "LV-2026-000041" into "3 days, 14-Aug to 16-Aug".
 * `approval_requests` is readable by the current approver (policy
 * `ar__approver_read`), so this is a narrow second read keyed by the ids already
 * on screen — never a second source of truth for the queue itself.
 */
export const approvalDetailRefSchema = z.object({
  id: dbUuid,
  detail_table: z.string(),
  detail_id: dbUuid,
  title: z.string(),
  summary: z.record(z.unknown()).nullable(),
  first_action_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
});
export type ApprovalDetailRef = z.infer<typeof approvalDetailRefSchema>;

export async function fetchApprovalDetailRefs(
  approvalRequestIds: readonly string[],
  signal?: AbortSignal,
): Promise<ApprovalDetailRef[]> {
  if (approvalRequestIds.length === 0) return [];
  return selectMany(APPROVAL_REQUESTS_TABLE, approvalDetailRefSchema, {
    columns: "id, detail_table, detail_id, title, summary, first_action_at, decision_comment",
    filters: [inList("id", approvalRequestIds)],
    limit: approvalRequestIds.length,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The dates the requester submitted, decoded out of the `summary` jsonb.
 *
 * `create_approval_request` is called for LEAVE with
 * `{request_number, from_date, to_date, total_days}` (migration 054); other
 * request types carry other keys, so every field is independently optional and an
 * absent one comes back null rather than as a guess.
 *
 * This is a DECODE, not a derivation: no date is constructed, no span is
 * measured, and `days` on the inbox row stays the authoritative day figure.
 */
const approvalSummaryFactsSchema = z.object({
  from_date: dbDate.optional(),
  to_date: dbDate.optional(),
  total_days: dbNumeric.optional(),
  request_number: z.string().optional(),
});

export interface ApprovalSummaryFacts {
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly days: number | null;
  readonly requestNumber: string | null;
}

const NO_SUMMARY_FACTS: ApprovalSummaryFacts = {
  fromDate: null,
  toDate: null,
  days: null,
  requestNumber: null,
};

export function readSummaryFacts(
  summary: Record<string, unknown> | null | undefined,
): ApprovalSummaryFacts {
  if (summary === null || summary === undefined) return NO_SUMMARY_FACTS;
  const parsed = approvalSummaryFactsSchema.safeParse(summary);
  if (!parsed.success) return NO_SUMMARY_FACTS;
  return {
    fromDate: parsed.data.from_date ?? null,
    toDate: parsed.data.to_date ?? null,
    days: parsed.data.total_days ?? null,
    requestNumber: parsed.data.request_number ?? null,
  };
}

/**
 * The leave rows behind the LEAVE entries in the queue — for the one fact no
 * workflow table carries: the sentence the employee typed. Policy
 * `leave_requests__scope_read` is `app.can_see_employee`, so a manager reads
 * their reportees' requests and nobody else's.
 */
export const teamLeaveRequestSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  employee_id: dbUuid,
  from_date: dbDate,
  to_date: dbDate,
  total_days: dbNumeric,
  portion: z.string(),
  reason: z.string(),
  status: z.string(),
  handover_notes: z.string().nullable(),
  contact_during_leave: z.string().nullable(),
  is_backdated: z.boolean(),
});
export type TeamLeaveRequest = z.infer<typeof teamLeaveRequestSchema>;

export async function fetchTeamLeaveRequestsByIds(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<TeamLeaveRequest[]> {
  if (ids.length === 0) return [];
  return selectMany(LEAVE_REQUESTS_TABLE, teamLeaveRequestSchema, {
    columns:
      "id, request_number, employee_id, from_date, to_date, total_days, portion, reason, " +
      "status, handover_notes, contact_during_leave, is_backdated",
    filters: [inList("id", ids)],
    limit: ids.length,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The append-only decision trail of ONE approval request.
 *
 * `approval_actions` has no UPDATE and no DELETE policy for anyone, and a trigger
 * (`audit.refuse_mutation`) refuses both regardless — so this list is evidence:
 * it only ever grows. Actor names resolve through `v_employee_ref` on
 * `profile_id`, because `profiles` itself is self-only and a decision has to be
 * attributed by name and role, never by a uuid.
 */
export const approvalActionSchema = z.object({
  id: dbUuid,
  approval_request_id: dbUuid,
  level: dbInt,
  actor_id: dbUuidNullable,
  actor_role: z.string().nullable(),
  acted_as: z.string().nullable(),
  action: z.string(),
  comment: z.string().nullable(),
  acted_at: dbTimestamp,
  time_to_action_seconds: dbIntNullable,
});
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

export const actorRefSchema = z.object({
  id: dbUuid,
  profile_id: dbUuidNullable,
  employee_code: z.string(),
  display_name: z.string(),
  designation_name: z.string().nullable(),
});
export type ActorRef = z.infer<typeof actorRefSchema>;

export interface ApprovalTrail {
  readonly actions: readonly ApprovalAction[];
  /** `profiles.id` → the person who acted. */
  readonly actors: ReadonlyMap<string, ActorRef>;
}

export async function fetchApprovalTrail(
  approvalRequestId: string,
  signal?: AbortSignal,
): Promise<ApprovalTrail> {
  const actions = await selectMany(APPROVAL_ACTIONS_TABLE, approvalActionSchema, {
    columns:
      "id, approval_request_id, level, actor_id, actor_role, acted_as, action, comment, " +
      "acted_at, time_to_action_seconds",
    filters: [eq("approval_request_id", approvalRequestId)],
    order: [
      { column: "level", ascending: true },
      { column: "acted_at", ascending: true },
    ],
    limit: 100,
    ...(signal ? { signal } : {}),
  });

  const profileIds = [
    ...new Set(actions.map((a) => a.actor_id).filter((v): v is string => v !== null)),
  ];
  const actors = new Map<string, ActorRef>();
  if (profileIds.length > 0) {
    const refs = await selectMany(V_EMPLOYEE_REF, actorRefSchema, {
      columns: "id, profile_id, employee_code, display_name, designation_name",
      filters: [inList("profile_id", profileIds)],
      limit: profileIds.length,
      ...(signal ? { signal } : {}),
    });
    for (const ref of refs) if (ref.profile_id !== null) actors.set(ref.profile_id, ref);
  }
  return { actions, actors };
}

// -----------------------------------------------------------------------------
// 4.4 The decision — act_on_approval, then apply the settled outcome
// -----------------------------------------------------------------------------

/** What `public.act_on_approval(...)` hands back: one jsonb object. */
export const actOnApprovalResultSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  status: z.string(),
  current_level: dbInt,
});
export type ActOnApprovalResult = z.infer<typeof actOnApprovalResultSchema>;

export type ApprovalDecision = "approve" | "reject";

export interface ApprovalDecisionInput {
  readonly approvalRequestId: string;
  readonly requestNumber: string;
  readonly decision: ApprovalDecision;
  /** From `approval_requests` — which table holds the thing being decided. */
  readonly detailTable: string | null;
  readonly detailId: string | null;
  /** `profiles.id` of the manager: `leave_requests.decided_by` references it. */
  readonly decidedByProfileId: string | null;
}

/**
 * Detail tables a database trigger settles, so this function has nothing to do
 * but report success. Adding a table here without the trigger would be a lie the
 * screens then repeat.
 */
const SERVER_APPLIED_DETAIL_TABLES: readonly string[] = ["reimbursement_claims"];

export interface ApprovalDecisionResult {
  readonly approval: ActOnApprovalResult;
  /** True when the leave request itself was moved to approved/rejected. */
  readonly appliedToDetail: boolean;
  /**
   * Why nothing beyond the approval moved. NOT a failure — the decision is
   * recorded either way, and the screen says which of the two happened.
   */
  readonly notAppliedReason: "chain_continues" | "no_apply_path" | null;
  /** Plain English, set only when the apply step was attempted and refused. */
  readonly applyError: string | null;
}

/** The chain has finished and the outcome is settled. */
function isTerminalApprovalStatus(status: string): boolean {
  return status === "approved" || status === "rejected";
}

/**
 * Approve or reject one request as the manager, with a typed reason.
 *
 * TWO STEPS, the second because of a real gap rather than a preference.
 *
 * STEP 1 — `public.act_on_approval(...)`, "the single client-facing action RPC".
 * It is the ONLY path: `approval_requests` has no INSERT/UPDATE/DELETE policy for
 * `authenticated` at all, so status, level and `current_approver_ids` move only
 * inside that SECURITY DEFINER function. It appends the `approval_actions` row
 * (with the actor's role, whether they acted as approver / delegate /
 * admin_override, and the server-measured time to action), refuses self-approval,
 * refuses a second approval of the same level by the same actor, refuses a
 * rejection with no comment, and then calls `advance_approval` to either hand the
 * request to the next level or settle it. The reason travels BOTH as `p_comment`
 * — it becomes the decision comment on the trail — and as the `x-reason` header
 * via `rpcAudited`, because `leave_balances` is in
 * `audit.reason_required_tables` and the ledger/balance writes this transaction
 * triggers would be refused with SQLSTATE 22023 if the reason were absent.
 *
 * STEP 2 — apply the settled outcome to the LEAVE REQUEST. Nothing deployed does
 * this: `approval_requests.applied_at` exists but no trigger, function or job
 * ever fills it, and migration 029 touches `leave_requests` in exactly zero
 * places. Without step 2 the manager would approve, the queue row would vanish,
 * and the employee's own screen would still read "Pending" with the ledger and
 * the balance untouched — because those are written by
 * `leave_requests_apply_ledger` / `leave_requests_recompute_balance` when
 * `leave_requests.status` changes, and by nothing else. So the settled outcome
 * goes through `decideLeaveRequest`, the SAME audited function
 * `/admin/leave/requests` uses, under policy `leave_requests__manager_decide`
 * (`app.is_manager_of(employee_id)` AND the row still pending) — so the manager
 * path and the admin path cannot diverge.
 *
 * Step 2 runs ONLY when the chain actually settled: `AC-LEAVE-STD` engages HR at
 * level 2 above 5 days, so on a 6-day request a manager's approval leaves the
 * request in flight and the leave row must stay pending. Step 2 also never
 * invents a write for a detail table a manager has no policy on
 * (`attendance_regularizations`, `comp_off_ledger`, `reimbursement_claims` are
 * manager-READ only — migration 017: "decisions go through the approval RPC, not
 * direct UPDATE"). In both cases the decision is recorded and the caller is told
 * why nothing else moved, instead of being shown a success that is half true.
 *
 * A step-2 refusal is RETURNED, not thrown: step 1 has already committed and
 * cannot be rolled back from here, so "decision recorded, the leave row did not
 * move, here is why" is the only honest outcome.
 */
export async function decideApproval(
  input: ApprovalDecisionInput,
  reason: string,
  signal?: AbortSignal,
): Promise<ApprovalDecisionResult> {
  const rows = await rpcAudited(
    ACT_ON_APPROVAL_FN,
    {
      p_request_id: input.approvalRequestId,
      p_action: input.decision,
      p_comment: reason,
      p_payload: {},
    },
    actOnApprovalResultSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, ...(signal ? { signal } : {}) },
  );

  const approval = rows[0];
  if (approval === undefined) {
    throw new MutationError(
      ACT_ON_APPROVAL_FN,
      "not_found",
      `${ACT_ON_APPROVAL_FN} returned no row for ${input.requestNumber}, so the decision was not recorded.`,
    );
  }

  if (!isTerminalApprovalStatus(approval.status)) {
    return {
      approval,
      appliedToDetail: false,
      notAppliedReason: "chain_continues",
      applyError: null,
    };
  }

  /*
    SOME DETAIL TABLES ARE APPLIED BY THE SERVER, NOT FROM HERE.

    `reimbursement_claims` used to fall through to `no_apply_path` — correctly,
    because nothing anywhere projected a settled approval onto the claim, and the
    three screens said so rather than implying the money was moving.

    Migration 040500 added `trg_ar__apply_claim`: the moment `act_on_approval`
    settles a request whose `detail_table` is `reimbursement_claims`, the claim's
    own status, `total_approved_paise` and `decided_*` columns are written inside
    the same transaction. By the time the RPC above returns, it is already done.

    A trigger rather than a call from here on purpose — a decision can be taken
    from three inboxes, an admin override, an SLA escalation or `advance_approval`
    finishing a chain on its own, and a client-side apply step would silently not
    run for most of them. So the honest answer here is "applied", not "no path".
  */
  if (input.detailTable !== null && SERVER_APPLIED_DETAIL_TABLES.includes(input.detailTable)) {
    return { approval, appliedToDetail: true, notAppliedReason: null, applyError: null };
  }

  if (
    input.detailTable !== LEAVE_REQUESTS_TABLE ||
    input.detailId === null ||
    input.decidedByProfileId === null
  ) {
    return {
      approval,
      appliedToDetail: false,
      notAppliedReason: "no_apply_path",
      applyError: null,
    };
  }

  try {
    await decideLeaveRequest(
      {
        requestId: input.detailId,
        decision: approval.status === "approved" ? "approved" : "rejected",
        decidedBy: input.decidedByProfileId,
        comment: reason,
      },
      reason,
      signal,
    );
    return { approval, appliedToDetail: true, notAppliedReason: null, applyError: null };
  } catch (error) {
    return {
      approval,
      appliedToDetail: false,
      notAppliedReason: null,
      applyError: mutationUserMessage(error),
    };
  }
}

// =============================================================================
// 5. TEAM ATTENDANCE — /team/attendance
// =============================================================================

/**
 * `v_attendance_day_enriched`. `security_invoker`, so RLS policy
 * `attendance_days__manager_read` (`app.is_manager_of(employee_id)`) is the whole
 * scope — and `app.is_manager_of` walks the reporting closure, so indirect
 * reportees are included without this module asking for them.
 */
export const V_TEAM_DAY = "v_attendance_day_enriched";
/** `f_attendance_period_summary(from, to, employee_id)` — §9.2, one row/employee. */
export const F_PERIOD_SUMMARY_FN = "f_attendance_period_summary";

/** A month of a team is bounded; the cap plus an honest banner beats truncation. */
export const TEAM_DAY_ROW_CAP = 1200;

export const teamDaySchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  ist_date: dbDate,
  status: z.string().nullable(),
  status_source: z.string().nullable(),
  department_name: z.string().nullable(),
  shift_code: z.string().nullable(),
  /** IST wall clock 'HH:MM', pre-rendered by the view. FIRST scan = arrival. */
  first_in_hm: z.string().nullable(),
  /** IST wall clock 'HH:MM', pre-rendered by the view. LAST scan = departure. */
  last_out_hm: z.string().nullable(),
  punch_count: dbIntNullable,
  total_worked_minutes: dbIntNullable,
  /** The view's own 'H:MM' rendering, after the unpaid break and the day status. */
  worked_hm: z.string().nullable(),
  is_late: z.boolean().nullable(),
  late_minutes: dbIntNullable,
  late_hm: z.string().nullable(),
  is_early_exit: z.boolean().nullable(),
  early_exit_minutes: dbIntNullable,
  overtime_minutes: dbIntNullable,
  approved_overtime_minutes: dbIntNullable,
  is_weekly_off: z.boolean().nullable(),
  is_holiday: z.boolean().nullable(),
  is_working_day: z.boolean().nullable(),
  holiday_name: z.string().nullable(),
  leave_type_name: z.string().nullable(),
  anomaly_flags: z.array(z.string()).nullable(),
  has_anomalies: z.boolean().nullable(),
  is_regularized: z.boolean().nullable(),
  /*
    BOOLEAN, not string. `attendance_days.manual_override_status` is
    `boolean NOT NULL DEFAULT false` (017) and the view passes it through
    untouched; the two other readers of this view — features/attendance and
    features/admin — both declare `z.boolean()`. This one said `z.string()` and
    took the whole Team Attendance grid down with
    "Expected string, received boolean" the first day a team had any rows in it.
    It was invisible until then because zod never sees a row that does not exist.
  */
  manual_override_status: z.boolean().nullable(),
  is_locked: z.boolean().nullable(),
});
export type TeamDay = z.infer<typeof teamDaySchema>;

const TEAM_DAY_COLUMNS =
  "id, employee_id, employee_code, display_name, ist_date, status, status_source, " +
  "department_name, shift_code, first_in_hm, last_out_hm, punch_count, " +
  "total_worked_minutes, worked_hm, is_late, late_minutes, late_hm, is_early_exit, " +
  "early_exit_minutes, overtime_minutes, approved_overtime_minutes, is_weekly_off, " +
  "is_holiday, is_working_day, holiday_name, leave_type_name, anomaly_flags, " +
  "has_anomalies, is_regularized, manual_override_status, is_locked";

/**
 * The exception slices. Each key is a predicate; the same array goes to
 * `selectCount` and to `selectMany`.
 *
 * `unapproved_overtime` is deliberately ABSENT. It is the column-to-column
 * comparison `overtime_minutes > approved_overtime_minutes`, which the sanctioned
 * filter vocabulary cannot express and which must not be re-derived in the
 * browser. Both OT columns are printed per row instead, side by side, so the gap
 * is visible without anyone subtracting anything.
 */
export const TEAM_DAY_SLICE_FILTERS = {
  all: [] as readonly Filter[],
  exceptions: [isTrue("has_anomalies")] as readonly Filter[],
  late: [isTrue("is_late")] as readonly Filter[],
  early_exit: [isTrue("is_early_exit")] as readonly Filter[],
  absent: [eq("status", "absent")] as readonly Filter[],
  on_leave: [eq("status", "on_leave")] as readonly Filter[],
  regularized: [isTrue("is_regularized")] as readonly Filter[],
} as const;

export type TeamDaySlice = keyof typeof TEAM_DAY_SLICE_FILTERS;

export function isTeamDaySlice(value: string | null): value is TeamDaySlice {
  return value !== null && Object.prototype.hasOwnProperty.call(TEAM_DAY_SLICE_FILTERS, value);
}

export interface TeamDayFilters {
  /*
    An inclusive IST civil-date WINDOW, not a month.
    It was `month: 'YYYY-MM'`, expanded here by `istMonthRange`. Nothing about
    `v_team_attendance_days` is month-grained — the rows are per employee-day — so
    the month was a needless narrowing that left the team screens unable to answer
    "this week" or "this quarter" while the admin screens could. The callers now pass
    the shared analytics period straight through.
  */
  readonly from: string;
  readonly to: string;
  /** Reportee ids in scope. Empty means "this manager has no reportees". */
  readonly employeeIds: readonly string[];
  readonly slice?: TeamDaySlice;
}

/** The one place team-day predicates are built, so counts and rows agree. */
export function teamDayFilters(f: TeamDayFilters): readonly Filter[] {
  const filters: Filter[] = [gte("ist_date", f.from), lte("ist_date", f.to)];
  if (f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  for (const extra of TEAM_DAY_SLICE_FILTERS[f.slice ?? "all"]) filters.push(extra);
  return filters;
}

export function fetchTeamDays(f: TeamDayFilters, signal?: AbortSignal): Promise<TeamDay[]> {
  return selectMany(V_TEAM_DAY, teamDaySchema, {
    columns: TEAM_DAY_COLUMNS,
    filters: teamDayFilters(f),
    order: [
      { column: "ist_date", ascending: false },
      { column: "display_name", ascending: true },
    ],
    limit: TEAM_DAY_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countTeamDays(f: TeamDayFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_TEAM_DAY, teamDayFilters(f), { ...(signal ? { signal } : {}) });
}

/**
 * The per-employee month roll-up — every §9.2 metric, computed by Postgres.
 *
 * `f_attendance_period_summary(p_from, p_to, p_employee_id)` is the ONE
 * implementation of the metric dictionary; `v_attendance_period_summary` is just
 * a month-to-date wrapper over it, so an arbitrary month has to go through the
 * function. It is `SECURITY INVOKER` and `GROUP BY employee_id`, so calling it
 * with a NULL employee returns one row per employee the caller's RLS admits —
 * i.e. the team — and the aggregation happens in the database.
 *
 * This is what makes a "trend" column on a manager screen legitimate:
 * `late_days`, `late_pct` (already a percentage, already clamped to [0,100] by
 * `fn_late_pct`), `working_days`, `present_days`, `absent_days`, `paid_days` and
 * `avg_worked_minutes_per_working_day` are SELECTED, not summed here.
 */
export const teamPeriodSummarySchema = z.object({
  employee_id: dbUuid,
  from_date: dbDate,
  to_date: dbDate,
  total_days: dbInt,
  present_days: dbInt,
  half_days: dbInt,
  absent_days: dbInt,
  pending_days: dbInt,
  weekly_off_days: dbInt,
  holiday_days: dbInt,
  leave_days: dbNumeric,
  paid_days: dbNumeric,
  working_days: dbInt,
  late_days: dbInt,
  late_minutes: dbInt,
  early_exit_days: dbInt,
  overtime_minutes: dbInt,
  approved_overtime_minutes: dbInt,
  total_worked_minutes: dbInt,
  avg_worked_minutes_per_working_day: dbNumericNullable,
  /** Already ×100 and clamped by `fn_late_pct`; NULL when working_days = 0. */
  late_pct: dbPercentNullable,
  attendance_pct: dbPercentNullable,
  break_minutes: dbInt,
});
export type TeamPeriodSummary = z.infer<typeof teamPeriodSummarySchema>;

/**
 * One roll-up row per in-scope employee for a month.
 *
 * The function's row set includes the caller's OWN summary (self RLS on
 * `attendance_days`). Narrowing to the reportee ids is a CORRECTNESS filter — a
 * manager's own month belongs on `/me/attendance`, not in their team's exception
 * counts — and never a security measure: the view's predicate already decided
 * which rows exist at all.
 */
export async function fetchTeamPeriodSummaries(
  from: string,
  to: string,
  employeeIds: readonly string[],
  signal?: AbortSignal,
): Promise<TeamPeriodSummary[]> {
  if (employeeIds.length === 0) return [];
  const rows = await rpcMany(
    F_PERIOD_SUMMARY_FN,
    { p_from: from, p_to: to, p_employee_id: null },
    teamPeriodSummarySchema,
    { ...(signal ? { signal } : {}) },
  );
  const scope = new Set(employeeIds);
  return rows.filter((r) => scope.has(r.employee_id));
}

// =============================================================================
// 6. TEAM LEAVE — /team/leave
// =============================================================================

export const V_LEAVE_CALENDAR = "v_leave_calendar";
export const V_LEAVE_BALANCE = "v_leave_balance_current";

export const TEAM_LEAVE_ROW_CAP = 800;

/**
 * `v_leave_calendar` is one row PER EMPLOYEE PER DATE, and the view already
 * excludes rejected/withdrawn requests and un-counted days (`lrd.is_counted`).
 * `day_value` is the server's own value for that date (1, or 0.5 for a half day)
 * — printed per row, never added up here.
 */
export const teamLeaveDaySchema = z.object({
  leave_request_day_id: dbUuid,
  leave_request_id: dbUuid,
  request_number: z.string(),
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  department_name: z.string().nullable(),
  leave_date: dbDate,
  portion: z.string(),
  day_value: dbNumeric,
  leave_type_code: z.string(),
  leave_type_name: z.string(),
  status: z.string(),
});
export type TeamLeaveDay = z.infer<typeof teamLeaveDaySchema>;

const TEAM_LEAVE_DAY_COLUMNS =
  "leave_request_day_id, leave_request_id, request_number, employee_id, employee_code, " +
  "display_name, department_name, leave_date, portion, day_value, leave_type_code, " +
  "leave_type_name, status";

export const TEAM_LEAVE_SLICE_FILTERS = {
  all: [] as readonly Filter[],
  approved: [inList("status", ["approved", "partially_approved"])] as readonly Filter[],
  pending: [eq("status", "pending")] as readonly Filter[],
  cancellation_pending: [eq("status", "cancellation_pending")] as readonly Filter[],
} as const;

export type TeamLeaveSlice = keyof typeof TEAM_LEAVE_SLICE_FILTERS;

export function isTeamLeaveSlice(value: string | null): value is TeamLeaveSlice {
  return value !== null && Object.prototype.hasOwnProperty.call(TEAM_LEAVE_SLICE_FILTERS, value);
}

export interface TeamLeaveFilters {
  /** Inclusive IST civil-date window — see `TeamDayFilters` for why not a month. */
  readonly from: string;
  readonly to: string;
  readonly employeeIds: readonly string[];
  readonly slice?: TeamLeaveSlice;
}

export function teamLeaveFilters(f: TeamLeaveFilters): readonly Filter[] {
  const filters: Filter[] = [gte("leave_date", f.from), lte("leave_date", f.to)];
  if (f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  for (const extra of TEAM_LEAVE_SLICE_FILTERS[f.slice ?? "all"]) filters.push(extra);
  return filters;
}

export function fetchTeamLeaveDays(
  f: TeamLeaveFilters,
  signal?: AbortSignal,
): Promise<TeamLeaveDay[]> {
  return selectMany(V_LEAVE_CALENDAR, teamLeaveDaySchema, {
    columns: TEAM_LEAVE_DAY_COLUMNS,
    filters: teamLeaveFilters(f),
    order: [
      { column: "leave_date", ascending: true },
      { column: "display_name", ascending: true },
    ],
    limit: TEAM_LEAVE_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countTeamLeaveDays(
  f: TeamLeaveFilters,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_LEAVE_CALENDAR, teamLeaveFilters(f), { ...(signal ? { signal } : {}) });
}

/**
 * The balance context the team views expose. `available_days` and
 * `available_after_pending` are GENERATED columns on `leave_balances` — the
 * spendable figure is the database's, never re-derived from the ledger in a
 * widget. Scope is `leave_balances__scope_read` (`app.can_see_employee`).
 */
export const teamLeaveBalanceSchema = z.object({
  employee_id: dbUuid,
  leave_type_id: dbUuid,
  leave_type_code: z.string(),
  leave_type_name: z.string(),
  is_paid: z.boolean(),
  is_comp_off: z.boolean(),
  leave_year: dbInt,
  entitlement_days: dbNumeric,
  availed_days: dbNumeric,
  pending_days: dbNumeric,
  available_days: dbNumeric,
  available_after_pending: dbNumeric,
  expiring_soon_days: dbNumericNullable,
  nearest_expiry: dbDateNullable,
});
export type TeamLeaveBalance = z.infer<typeof teamLeaveBalanceSchema>;

export async function fetchTeamLeaveBalances(
  employeeIds: readonly string[],
  signal?: AbortSignal,
): Promise<TeamLeaveBalance[]> {
  if (employeeIds.length === 0) return [];
  return selectMany(V_LEAVE_BALANCE, teamLeaveBalanceSchema, {
    columns:
      "employee_id, leave_type_id, leave_type_code, leave_type_name, is_paid, is_comp_off, " +
      "leave_year, entitlement_days, availed_days, pending_days, available_days, " +
      "available_after_pending, expiring_soon_days, nearest_expiry",
    filters: [inList("employee_id", employeeIds)],
    order: [{ column: "leave_type_code", ascending: true }],
    limit: 600,
    ...(signal ? { signal } : {}),
  });
}

// =============================================================================
// 7. THE REPORTEE PROFILE'S TWO EXTRA VIEWS — /team/people/:employeeCode
// =============================================================================

/** Migration 055. Both are allow-lists, not filters applied after the fact. */
export const V_TEAM_PUNCHES = "v_team_punches";
export const V_TEAM_CUSTOM_FIELDS = "v_team_custom_fields";

/**
 * A week of one person's scans is a dozen rows. The cap is a bug-stopper for a
 * gate that starts double-tapping, not a page size, and the screen prints the
 * server's own count beside the list so a clipped read is visible.
 */
export const TEAM_PUNCH_ROW_CAP = 200;

// -----------------------------------------------------------------------------
// 7.1 v_team_punches — the raw scan log, minus the forensics
// -----------------------------------------------------------------------------

/**
 * `public.punch_direction` (migration 003). The kiosk writes 'undetermined' and
 * the day engine derives arrival from the FIRST scan and departure from the
 * LAST — so this column is PROVENANCE ("the guard said he was leaving"), never
 * the thing that decided the day, and the screen labels it as such.
 *
 * Labels reuse the admin punch console's existing catalogue entries rather than
 * forking a second wording for the same enum (the reasoning that applies to
 * `EMPLOYMENT_STATUS_CHIP` above applies identically here).
 */
export const punchDirectionValues = [
  "in",
  "out",
  "break_start",
  "break_end",
  "undetermined",
] as const;
export const punchDirectionSchema = z.enum(punchDirectionValues);
export type PunchDirection = z.infer<typeof punchDirectionSchema>;

export const PUNCH_DIRECTION_LABELS: Readonly<Record<PunchDirection, string>> = {
  in: t("admin.punch.direction.in"),
  out: t("admin.punch.direction.out"),
  break_start: t("admin.punch.direction.breakStart"),
  break_end: t("admin.punch.direction.breakEnd"),
  undetermined: t("admin.punch.direction.undetermined"),
};

/** `public.punch_source`, reused from the employee surface's own schema. */
export type PunchSource = z.infer<typeof punchSourceSchema>;

export const PUNCH_SOURCE_LABELS: Readonly<Record<PunchSource, string>> = {
  kiosk_face: t("admin.punch.source.kioskFace"),
  kiosk_fingerprint: t("admin.punch.source.kioskFingerprint"),
  kiosk_card: t("admin.punch.source.kioskCard"),
  kiosk_manual: t("admin.punch.source.kioskManual"),
  web: t("admin.punch.source.web"),
  mobile: t("admin.punch.source.mobile"),
  biometric_device: t("admin.punch.source.biometric"),
  manual_admin: t("admin.punch.source.manualAdmin"),
  import: t("admin.punch.source.import"),
  system_regularization: t("admin.punch.source.regularization"),
};

/**
 * One scan. `ist_time_hm` is pre-rendered 'HH24:MI' BY THE VIEW, which is why
 * no caller here formats an instant: `punched_at` is selected only so the list
 * can be ordered by the moment the gate recorded, to the second.
 *
 * `photo_path` and the MATCH DISTANCES are still not here, and that remains the
 * stronger guarantee: no value in the browser to leak, no payload to inspect. A
 * face-match score is a number a manager cannot act on and an employee cannot
 * contest, so it stays out.
 *
 * LOCATION IS NOW HERE, AND THAT IS A DELIBERATE REVERSAL. This comment used to
 * list `lat` and `lng` alongside them. The client asked for the place a punch was
 * taken to be visible wherever punches are shown, and a manager was the one reader
 * who could not answer the question their own reportee is most likely to ask them
 * ("was my punch recorded from the right place?") — while an admin, reading a
 * different view over the identical rows, could.
 *
 * What makes it defensible rather than a widening: `v_team_punches` scopes rows to
 * self OR manager-of OR admin-within-scope in the database (migration 077 left that
 * predicate untouched), so this exposes a manager to coordinates for the people
 * they already see every other attendance fact about. It is not a new audience.
 *
 * `location_accuracy_m` is not optional here. It is selected with the coordinate
 * every time, because a coordinate shown without it invites a manager to read a
 * network estimate as a precise position.
 */
export const teamPunchSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  punched_at: dbTimestamp,
  /** The IST calendar date of the scan itself. */
  ist_date: dbDate,
  /** The BUSINESS date it is filed under — a night-shift scan differs. */
  effective_date: dbDate,
  ist_time_hm: z.string(),
  direction: punchDirectionSchema,
  source: punchSourceSchema,
  device_label: z.string().nullable(),
  needs_review: z.boolean(),
  is_voided: z.boolean(),
  void_reason: z.string().nullable(),
  voided_at: dbTimestampNullable,
  /** See the header: projected by migration 077, scoped by the view's own predicate. */
  lat: dbNumericNullable,
  lng: dbNumericNullable,
  /** NULL = the device reported no accuracy, which is NOT "accurate". */
  location_accuracy_m: dbNumericNullable,
});
export type TeamPunch = z.infer<typeof teamPunchSchema>;

const TEAM_PUNCH_COLUMNS =
  "id, employee_id, employee_code, display_name, punched_at, ist_date, effective_date, " +
  "ist_time_hm, direction, source, device_label, needs_review, is_voided, void_reason, " +
  // Accuracy is listed with the coordinates and must stay with them: selecting
  // lat/lng alone would satisfy PostgREST and then fail to compile against
  // `PunchLocationColumns`, which requires the accuracy field precisely so that a
  // coordinate can never be rendered without saying how much to believe it.
  "voided_at, lat, lng, location_accuracy_m";

/**
 * ONE predicate, used by the list and by its count — so "14 scans" is by
 * construction the cardinality of the rows below it (DR-29).
 *
 * The window is on `effective_date`, NOT `ist_date`: a scan at 01:10 after a
 * night shift belongs to the previous business day, and filing it under its own
 * calendar date would move somebody's departure to the wrong day.
 */
export function teamPunchFilters(employeeId: string, from: string, to: string): readonly Filter[] {
  return [eq("employee_id", employeeId), gte("effective_date", from), lte("effective_date", to)];
}

export function fetchTeamPunches(
  employeeId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<TeamPunch[]> {
  return selectMany(V_TEAM_PUNCHES, teamPunchSchema, {
    columns: TEAM_PUNCH_COLUMNS,
    filters: teamPunchFilters(employeeId, from, to),
    order: [
      { column: "effective_date", ascending: false },
      { column: "punched_at", ascending: false },
    ],
    limit: TEAM_PUNCH_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export function countTeamPunches(
  employeeId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(V_TEAM_PUNCHES, teamPunchFilters(employeeId, from, to), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 7.2 v_team_custom_fields — the venue's own fields, PII excluded by the server
// -----------------------------------------------------------------------------

/**
 * One custom field VALUE already joined to its DEFINITION by the view, so a
 * manager screen needs no second read of `employee_custom_field_defs` and can
 * never render a value whose label it failed to resolve.
 *
 * The view carries `value_text`, `value_number`, `value_date` and
 * `value_boolean` and deliberately NOT `value_json` / `value_document_id`. A
 * `multi_select`, an `employee_ref` or a `file` field therefore arrives with
 * every value column null, which is not "empty" — the screen says the value is
 * held in a shape this view does not carry, rather than printing an em dash that
 * would read as "nothing recorded".
 */
export const teamCustomFieldSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  field_def_id: dbUuid,
  field_code: z.string(),
  field_label: z.string(),
  field_type: customFieldTypeSchema,
  section: z.string(),
  value_text: z.string().nullable(),
  value_number: dbNumericNullable,
  value_date: dbDateNullable,
  value_boolean: z.boolean().nullable(),
  updated_at: dbTimestamp,
});
export type TeamCustomField = z.infer<typeof teamCustomFieldSchema>;

/** Field types whose value lives in a column this view does not expose. */
export function isCarriedCustomFieldType(type: TeamCustomField["field_type"]): boolean {
  return type !== "multi_select" && type !== "employee_ref" && type !== "file";
}

export function fetchTeamCustomFields(
  employeeId: string,
  signal?: AbortSignal,
): Promise<TeamCustomField[]> {
  return selectMany(V_TEAM_CUSTOM_FIELDS, teamCustomFieldSchema, {
    columns:
      "id, employee_id, field_def_id, field_code, field_label, field_type, section, " +
      "value_text, value_number, value_date, value_boolean, updated_at",
    filters: [eq("employee_id", employeeId)],
    // The view has no sort_order column; section then label is the stable order
    // a reader expects, and it is the DATABASE doing the ordering.
    order: [
      { column: "section", ascending: true },
      { column: "field_label", ascending: true },
    ],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

// =============================================================================
// 8. PERFORMANCE — /team/performance
// =============================================================================

/**
 * An inclusive IST civil-date window. The screen calls it a REVIEW PERIOD; the
 * database only ever sees `p_from` and `p_to`.
 */
export interface TeamReviewRange {
  readonly from: string;
  readonly to: string;
}

/**
 * The whole §9.2 metric dictionary for one arbitrary window, per employee.
 *
 * `f_attendance_period_summary(p_from, p_to, p_employee_id)` takes ANY inclusive
 * range — that is the only reason a review period longer than a month is
 * legitimate here. `/team/analytics` reads the same function one month at a time
 * for its charts; this screen asks it once for the whole period, so a quarter is
 * aggregated BY POSTGRES and never by adding three monthly rows together in the
 * browser (which is how two screens start disagreeing).
 *
 * `teamPeriodSummarySchema` already covers the figures the month views print;
 * the extension adds the seven the function also returns and a review record
 * needs — comp-off availed, the early-exit and extra-work minutes, the
 * per-present-day average, the late-deduction days, and the break counts.
 */
export const teamReviewSummarySchema = teamPeriodSummarySchema.extend({
  comp_off_days: dbInt,
  early_exit_minutes: dbInt,
  extra_work_minutes: dbInt,
  avg_worked_minutes_per_present_day: dbNumericNullable,
  late_deduction_leave_days: dbNumeric,
  break_count: dbInt,
  avg_breaks_per_present_day: dbNumericNullable,
});
export type TeamReviewSummary = z.infer<typeof teamReviewSummarySchema>;

/**
 * One row per in-scope reportee for the review period.
 *
 * Same shape as `fetchTeamPeriodSummaries`: the function is `SECURITY INVOKER`
 * and `GROUP BY employee_id`, so a NULL employee returns one row per employee
 * the caller's RLS on `attendance_days` admits — self included. Narrowing to the
 * reportee ids is a CORRECTNESS filter (a manager's own record belongs on
 * `/me/attendance`, and D-02-06 keeps their row out of team aggregates), never a
 * security measure: the function already decided which rows exist at all.
 */
export async function fetchTeamReviewSummaries(
  range: TeamReviewRange,
  employeeIds: readonly string[],
  signal?: AbortSignal,
): Promise<TeamReviewSummary[]> {
  if (employeeIds.length === 0) return [];
  const rows = await rpcMany(
    F_PERIOD_SUMMARY_FN,
    { p_from: range.from, p_to: range.to, p_employee_id: null },
    teamReviewSummarySchema,
    { ...(signal ? { signal } : {}) },
  );
  const scope = new Set(employeeIds);
  return rows.filter((r) => scope.has(r.employee_id));
}

/**
 * The exception slices over a RANGE rather than a month.
 *
 * The slice predicates are `TEAM_DAY_SLICE_FILTERS` — the very same array
 * `/team/attendance` counts and lists with — so a "late days" figure here and a
 * late-day row there are the same rows by construction. Only the date bound
 * differs: a review period is not a calendar month.
 */
export interface TeamRangeDayFilters {
  readonly range: TeamReviewRange;
  readonly employeeIds: readonly string[];
  readonly slice?: TeamDaySlice;
}

export function teamRangeDayFilters(f: TeamRangeDayFilters): readonly Filter[] {
  const filters: Filter[] = [gte("ist_date", f.range.from), lte("ist_date", f.range.to)];
  if (f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  for (const extra of TEAM_DAY_SLICE_FILTERS[f.slice ?? "all"]) filters.push(extra);
  return filters;
}

export function countTeamRangeDays(f: TeamRangeDayFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_TEAM_DAY, teamRangeDayFilters(f), { ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// 8.2 Confirmation duties — the one performance decision a manager owns in P1
// -----------------------------------------------------------------------------

/**
 * `employment_status = 'on_probation'` plus `confirmation_due_date` are both
 * columns of the manager allow-list view, so "whose confirmation is due" needs
 * no new relation and no client-side date comparison beyond the bound passed in.
 *
 * The horizon and "today" are PARAMETERS rather than `CURRENT_DATE` in a
 * predicate: PostgREST cannot compare a column to a server function in a filter,
 * and the IST business date is a thing this app already knows exactly once
 * (`nowIstDate`). The comparison itself is still Postgres's.
 */
export const confirmationSlices = ["on_probation", "due_soon", "overdue"] as const;
export type ConfirmationSlice = (typeof confirmationSlices)[number];

export interface TeamConfirmationFilters {
  readonly employeeIds: readonly string[];
  readonly slice: ConfirmationSlice;
  /** The IST business date, 'YYYY-MM-DD'. */
  readonly today: string;
  /** The far edge of "due soon", inclusive — 'YYYY-MM-DD'. */
  readonly horizon: string;
}

export function teamConfirmationFilters(f: TeamConfirmationFilters): readonly Filter[] {
  const filters: Filter[] = [
    inList("id", f.employeeIds),
    eq("employment_status", "on_probation"),
  ];
  if (f.slice === "due_soon") {
    filters.push(gte("confirmation_due_date", f.today), lte("confirmation_due_date", f.horizon));
  }
  if (f.slice === "overdue") filters.push(lt("confirmation_due_date", f.today));
  return filters;
}

export async function fetchTeamConfirmations(
  f: TeamConfirmationFilters,
  signal?: AbortSignal,
): Promise<TeamMember[]> {
  if (f.employeeIds.length === 0) return [];
  return selectMany(V_TEAM_BASIC, teamMemberSchema, {
    filters: teamConfirmationFilters(f),
    // Nulls last: a probation with no due date recorded is a real state and it
    // belongs at the bottom of the list, not silently first.
    order: [
      { column: "confirmation_due_date", ascending: true, nullsFirst: false },
      { column: "display_name", ascending: true },
    ],
    limit: TEAM_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

export async function countTeamConfirmations(
  f: TeamConfirmationFilters,
  signal?: AbortSignal,
): Promise<number> {
  if (f.employeeIds.length === 0) return 0;
  return selectCount(V_TEAM_BASIC, teamConfirmationFilters(f), { ...(signal ? { signal } : {}) });
}
