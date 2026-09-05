/**
 * command.api.ts — the reads behind §1 of the admin console: Command Centre
 * (`/admin`), Alert Feed (`/admin/alerts`) and My Admin Tasks (`/admin/tasks`).
 *
 * Two rules shape this whole file.
 *
 * 1. EVERY TILE NUMBER IS COUNTED BY POSTGRES. Each `count*` function below is
 *    `selectCount(view, filters)` — a `HEAD` request with `count=exact`, no rows
 *    on the wire — and the `filters` array it passes is the SAME array the
 *    matching list read uses. A tile therefore cannot disagree with the screen it
 *    drills into (spec-screens DR-29, the `7 vs 8` defect): it is the same
 *    predicate evaluated by the same database, not a `rows.length` that depends
 *    on whatever `limit` the caller happened to pass.
 *
 * 2. NOTHING IS DERIVED HERE. No sums, no averages, no ratios, no thresholds.
 *    "Is this person late?", "is this gate silent?", "is this document expiring?"
 *    and "how much comp-off lapses inside 30 days" are all already columns:
 *    `v_attendance_today_board.late_in`, the `kiosk_offline` branch of
 *    `v_exception_queue` (the 15-minute rule lives in the view),
 *    `v_document_compliance.compliance_status`,
 *    `v_comp_off_balance.expiring_within_30_days`. The client counts rows and
 *    orders lists; that is all.
 *
 * Deliberately NOT built, because the server does not offer it:
 *   * `alerts` (spec-admin §2.3: severity/assignee/ack/snooze/resolution) is not
 *     a deployed table. The alert feed is therefore `v_exception_queue` — the
 *     admin's morning list — which is self-clearing: a row disappears when the
 *     underlying problem is fixed. There is no acknowledge/snooze write to make.
 *   * An enrolment COVERAGE RATIO. `v_enrolment_coverage` returns only the gap
 *     rows, so a percentage would need a client-side division against headcount.
 *     The tile shows the gap count and says so.
 *   * An org-wide kiosk match-success figure. `v_kiosk_health` is per device per
 *     day; averaging those percentages on the client is exactly the arithmetic
 *     this file refuses, so rates are shown per device.
 *
 * Person names are NOT read here: `useEmployeeLabels` already holds the one
 * shared id → name/code map for the whole admin console, and a second directory
 * read would be a second source of truth for the same fact.
 */
import { z } from "zod";
import {
  dbInt,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gt,
  inList,
  isFalse,
  isNull,
  isTrue,
  selectCount,
  selectMany,
  selectOne,
  type Filter,
} from "@/shared/api/query";
import {
  V_EXCEPTION_QUEUE,
  V_PUNCH_DETAIL,
  V_TODAY_BOARD,
  exceptionRowSchema,
  punchRowSchema,
  type ExceptionRow,
  type PunchRow,
} from "./attendance.api";
import { ACTIVE_EMPLOYMENT_STATUSES, V_ADMIN_EMPLOYEE } from "./employees.api";
import { V_DOCUMENT_COMPLIANCE } from "./audit.api";
import { V_COMP_OFF_BALANCE } from "./leave.api";
import { KIOSK_DEVICES_TABLE, V_ENROLMENT_COVERAGE } from "./system.api";
import { PAYROLL_RUNS_TABLE, payrollRunSchema, type PayrollRun } from "./payroll.api";

export const V_APPROVAL_INBOX = "v_approval_inbox";

// -----------------------------------------------------------------------------
// 1. KPI strip — one server COUNT per tile
// -----------------------------------------------------------------------------

/** Tile 1 · Headcount. Same predicate as `/admin/people?status=active`. */
export const HEADCOUNT_FILTERS: readonly Filter[] = [
  isNull("deleted_at"),
  inList("employment_status", ACTIVE_EMPLOYMENT_STATUSES),
];

export function countHeadcount(signal?: AbortSignal): Promise<number> {
  return selectCount(V_ADMIN_EMPLOYEE, HEADCOUNT_FILTERS, { ...(signal ? { signal } : {}) });
}

/**
 * The live-board slices. Every one of these is a BOOLEAN COLUMN of
 * `v_attendance_today_board` (or, for `absent`, the engine's own status) — the
 * client never decides who is late.
 *
 * `absent` is the engine's verdict only. A day still in progress is `pending`
 * and belongs to no slice, which is what stops the reference product's phantom
 * absents (DR-30). `overdue` is the honest live version: shift start plus grace
 * has passed and no scan has arrived.
 */
export type BoardSlice =
  | "present"
  | "on_time"
  | "late"
  | "absent"
  | "off"
  | "yet_to_reach"
  | "overdue"
  /**
   * ON LEAVE, AND ONLY ON LEAVE. `off` is not this number and never was: it is
   * `off_today`, which the view defines as `weekly_off | holiday | on_leave |
   * on_leave_half | comp_off_availed`. A venue with a rota has people on a weekly
   * off every single day, so "who is on leave today" read as a much larger figure
   * than the truth and moved when nobody's leave had changed. Counted from `status`
   * directly, so it means what the word means.
   */
  | "on_leave"
  /**
   * Working, but not at the venue. The complement an administrator asks for
   * immediately after the present count: of the people working today, who is on
   * site and who is not.
   */
  | "work_from_home";

export function boardSliceFilters(slice: BoardSlice): readonly Filter[] {
  switch (slice) {
    case "present":
      return [isTrue("attended")];
    case "on_time":
      return [isTrue("on_time")];
    case "late":
      return [isTrue("late_in")];
    case "absent":
      return [eq("status", "absent")];
    case "off":
      return [isTrue("off_today")];
    case "yet_to_reach":
      return [isTrue("yet_to_reach")];
    case "overdue":
      return [isTrue("overdue")];
    case "on_leave":
      // Both halves of a leave day count as on leave — a half-day's absence is
      // still that person not being at their post for part of it.
      return [inList("status", ["on_leave", "on_leave_half"])];
    case "work_from_home":
      return [eq("status", "work_from_home")];
  }
}

/** Tiles 2–4 and every chip in the live ops band. */
export function countBoardSlice(slice: BoardSlice, signal?: AbortSignal): Promise<number> {
  return selectCount(V_TODAY_BOARD, boardSliceFilters(slice), { ...(signal ? { signal } : {}) });
}

/** Everyone the board covers today — the denominator the band names out loud. */
export function countBoardTotal(signal?: AbortSignal): Promise<number> {
  return selectCount(V_TODAY_BOARD, [], { ...(signal ? { signal } : {}) });
}

/** Tile 7 · scans the kiosk flagged for a human to look at. */
export const PUNCH_REVIEW_FILTERS: readonly Filter[] = [
  isTrue("needs_review"),
  isFalse("is_voided"),
];

export function countPunchesNeedingReview(signal?: AbortSignal): Promise<number> {
  return selectCount(V_PUNCH_DETAIL, PUNCH_REVIEW_FILTERS, { ...(signal ? { signal } : {}) });
}

/**
 * Tile 8 · required documents that have expired or are inside the server's
 * expiry window. The window is the VIEW's, not ours: `v_document_compliance`
 * flags `expiring_soon` at 60 days, so the tile says 60 days rather than
 * repeating the spec's 30 and quietly counting something else.
 */
export const DOCUMENT_EXPIRY_STATUSES = ["expired", "expiring_soon"] as const;
export const DOCUMENT_EXPIRY_WINDOW_DAYS = 60;

export const DOCUMENT_EXPIRY_FILTERS: readonly Filter[] = [
  inList("compliance_status", DOCUMENT_EXPIRY_STATUSES),
];

export function countExpiringDocuments(signal?: AbortSignal): Promise<number> {
  return selectCount(V_DOCUMENT_COMPLIANCE, DOCUMENT_EXPIRY_FILTERS, {
    ...(signal ? { signal } : {}),
  });
}

/**
 * Tile 9 · comp-off. `v_comp_off_balance.expiring_within_30_days` is a server SUM
 * of days per employee; summing those across employees would be client
 * arithmetic on comp-off, which is banned. So the tile counts PEOPLE with
 * something lapsing — a count, not a total — and the label says people.
 */
export const COMP_OFF_EXPIRING_WINDOW_DAYS = 30;

export const COMP_OFF_EXPIRING_FILTERS: readonly Filter[] = [gt("expiring_within_30_days", 0)];

export function countCompOffExpiring(signal?: AbortSignal): Promise<number> {
  return selectCount(V_COMP_OFF_BALANCE, COMP_OFF_EXPIRING_FILTERS, {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// The queues that WAIT ON A PERSON — what "needs your attention" is counted from
// -----------------------------------------------------------------------------

/*
  These three are separate from the tiles above because they answer a different
  question. A tile says what is TRUE of the venue ("39 people are in"); these say
  what is UNDONE and has somebody's name against it.

  They are counted the same way as everything else on this console — a `HEAD` with
  `count=exact` over the same predicate the destination screen uses — so the
  banner and the screen it opens cannot disagree.
*/

export const FACE_ENROLMENT_REQUESTS_TABLE = "face_enrolment_requests";
export const HELPDESK_TICKETS_TABLE = "helpdesk_tickets";

/**
 * HR has asked this person to present their face and it has not happened yet.
 *
 * `draft` is the ask itself; `pending` below is a capture waiting on an approver.
 * They are deliberately two lines in the banner: the first is chased, the second
 * is decided, and rolling them together would hide which of the two an
 * administrator is actually being asked to do.
 */
export const FACE_ASK_OPEN_STATUS = "draft";
export const FACE_CAPTURE_PENDING_STATUS = "pending";

export function countFaceAsksAwaitingEmployee(signal?: AbortSignal): Promise<number> {
  return selectCount(FACE_ENROLMENT_REQUESTS_TABLE, [eq("status", FACE_ASK_OPEN_STATUS)], {
    ...(signal ? { signal } : {}),
  });
}

export function countFaceCapturesAwaitingApproval(signal?: AbortSignal): Promise<number> {
  return selectCount(FACE_ENROLMENT_REQUESTS_TABLE, [eq("status", FACE_CAPTURE_PENDING_STATUS)], {
    ...(signal ? { signal } : {}),
  });
}

/** Tickets nobody has closed. RLS narrows this to the admin's own scope. */
export const HELPDESK_OPEN_STATUS = "open";

export function countOpenHelpdeskTickets(signal?: AbortSignal): Promise<number> {
  return selectCount(HELPDESK_TICKETS_TABLE, [eq("status", HELPDESK_OPEN_STATUS)], {
    ...(signal ? { signal } : {}),
  });
}

/** Tile 12 · employees who cannot use the gate yet (no template, or no consent). */
export function countEnrolmentGaps(signal?: AbortSignal): Promise<number> {
  return selectCount(V_ENROLMENT_COVERAGE, [], { ...(signal ? { signal } : {}) });
}

/** Tile 11 · gates registered and live, for the "n of m reporting" line. */
export function countActiveKioskDevices(signal?: AbortSignal): Promise<number> {
  return selectCount(KIOSK_DEVICES_TABLE, [isNull("deleted_at"), isTrue("is_active")], {
    ...(signal ? { signal } : {}),
  });
}

/**
 * Tile 10 · payroll. The tile prints the server's own `status` through
 * `PAYROLL_RUN_CHIP`, so no raw enum reaches the screen. `null` means no run has
 * ever been created — an honest "—", never a zero.
 */
export function fetchLatestPayrollRun(signal?: AbortSignal): Promise<PayrollRun | null> {
  return selectOne(PAYROLL_RUNS_TABLE, payrollRunSchema, [], {
    order: [{ column: "created_at", ascending: false }],
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Alert feed — v_exception_queue, the admin's morning list
// -----------------------------------------------------------------------------

/** The eight branches of `v_exception_queue`, in the order the view unions them. */
export const EXCEPTION_KINDS = [
  "punch_needs_review",
  "attendance_anomaly",
  "unapproved_overtime",
  "missing_bank_account",
  "document_expired",
  "sla_breach",
  "kiosk_offline",
  "negative_net_pay",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_SEVERITIES = ["critical", "warning", "info"] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

/** Presentation order only. The severities themselves are the view's column. */
const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 0, warning: 1, info: 2 };

export interface AlertFilters {
  readonly severities?: readonly string[];
  readonly kinds?: readonly string[];
}

export function alertFilters(f: AlertFilters): readonly Filter[] {
  const filters: Filter[] = [];
  if (f.severities && f.severities.length > 0) filters.push(inList("severity", f.severities));
  if (f.kinds && f.kinds.length > 0) filters.push(inList("exception_kind", f.kinds));
  return filters;
}

/**
 * Stable row identity. One entity id can legitimately appear under two kinds —
 * a day carrying both an anomaly flag and unapproved overtime — so the kind is
 * part of the key.
 */
export function alertRowKey(row: ExceptionRow): string {
  return `${row.exception_kind}:${row.entity_id}`;
}

/**
 * The feed: severity first, then newest. That is a display ORDERING, not a
 * derivation — `severity` and `occurred_at` are both the view's own columns, and
 * PostgREST cannot express "critical, warning, info" as a text sort.
 */
export async function fetchAlertFeed(
  f: AlertFilters,
  limit: number,
  signal?: AbortSignal,
): Promise<ExceptionRow[]> {
  const rows = await selectMany(V_EXCEPTION_QUEUE, exceptionRowSchema, {
    filters: alertFilters(f),
    order: [{ column: "occurred_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
  return [...rows].sort((a, b) => {
    const rank = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (rank !== 0) return rank;
    return a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0;
  });
}

/** Tile 5, and the header count on `/admin/alerts` — the feed's own predicate. */
export function countAlerts(f: AlertFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_EXCEPTION_QUEUE, alertFilters(f), { ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// 3. Live ops band — the gate feed
// -----------------------------------------------------------------------------

/**
 * The last scans of the IST business day (spec-admin §2.2). Read straight off
 * `v_attendance_punch_detail`, which carries the server's own IN/OUT derivation,
 * confidence BAND, device label and operator — the client classifies nothing.
 */
export function fetchGateFeed(
  istDate: string,
  limit: number,
  signal?: AbortSignal,
): Promise<PunchRow[]> {
  return selectMany(V_PUNCH_DETAIL, punchRowSchema, {
    filters: [eq("effective_date", istDate), isFalse("is_voided")],
    order: [{ column: "punched_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. My Admin Tasks — what THIS administrator personally owes
// -----------------------------------------------------------------------------

/**
 * `v_approval_inbox` is already scoped to `app.current_employee_id() = ANY
 * (current_approver_ids)`, so this read carries no scope filter: it is the
 * caller's own queue by construction, and an admin who is on nobody's approval
 * chain legitimately sees zero rows (an empty state, not an error).
 *
 * Narrower projection than the employee-facing one on purpose: this screen shows
 * what is waiting and how late it is, then links out for the decision itself.
 */
export const adminTaskSchema = z.object({
  approval_request_id: dbUuid,
  request_number: z.string(),
  request_type_code: z.string(),
  request_type_name: z.string(),
  title: z.string(),
  /*
    `approval_requests.summary` is `jsonb NOT NULL DEFAULT '{}'` (workflow.sql:263)
    — the per-request facts, not a sentence. Declared here as a string, so EVERY
    row failed to parse and the screen showed "Row from v_approval_inbox does not
    match its schema" instead of the administrator's own queue.

    Matches `workflow-admin.api.ts:292`, which had it right; the two read the same
    view and disagreed about one column.
  */
  summary: z.record(z.unknown()).nullable(),
  priority: z.string(),
  status: z.string(),
  current_level: dbInt,
  total_levels: dbInt,
  subject_employee_id: dbUuidNullable,
  subject_employee_code: z.string().nullable(),
  subject_display_name: z.string().nullable(),
  subject_department_name: z.string().nullable(),
  submitted_at: dbTimestamp,
  sla_due_at: dbTimestamp,
  /** Server-computed countdown and verdict. Never recomputed on the client. */
  sla_remaining_hours: dbNumericNullable,
  is_overdue: z.boolean().nullable(),
  age_hours: dbNumericNullable,
  escalated_at: dbTimestampNullable,
});
export type AdminTask = z.infer<typeof adminTaskSchema>;

const ADMIN_TASK_COLUMNS =
  "approval_request_id, request_number, request_type_code, request_type_name, title, summary, " +
  "priority, status, current_level, total_levels, subject_employee_id, subject_employee_code, " +
  "subject_display_name, subject_department_name, submitted_at, sla_due_at, sla_remaining_hours, " +
  "is_overdue, age_hours, escalated_at";

export function fetchMyAdminTasks(limit = 100, signal?: AbortSignal): Promise<AdminTask[]> {
  return selectMany(V_APPROVAL_INBOX, adminTaskSchema, {
    columns: ADMIN_TASK_COLUMNS,
    order: [{ column: "sla_due_at", ascending: true }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/** Tile 6 · the badge on "Awaiting your decision". */
export function countMyAdminTasks(signal?: AbortSignal): Promise<number> {
  return selectCount(V_APPROVAL_INBOX, [], { ...(signal ? { signal } : {}) });
}

/**
 * The service-level breaches recorded against ME. In `v_exception_queue` the
 * `sla_breach` branch puts the APPROVER in `employee_id`, so filtering on my own
 * employee id is what makes this list personal rather than organisational.
 */
export const SLA_BREACH_KIND = "sla_breach";

export function fetchMySlaBreaches(
  employeeId: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<ExceptionRow[]> {
  return selectMany(V_EXCEPTION_QUEUE, exceptionRowSchema, {
    filters: [eq("exception_kind", SLA_BREACH_KIND), eq("employee_id", employeeId)],
    order: [{ column: "occurred_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export type { ExceptionRow, PunchRow };

/**
 * Re-exported so a PAGE can mint ONE idempotency key per admin action and reuse
 * it across retries without importing the shared invoke plumbing directly. A
 * fresh key per retry would let a double-tap void two different punches; a `409`
 * replay of the same key is success (frontend-contract §5).
 */
export { newIdempotencyKey } from "@/shared/api/invoke";
