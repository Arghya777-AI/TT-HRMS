/**
 * cron-ai-digest — catalogue #27, auth model **C** (cron secret, constant time,
 * or a service-role bearer for a manual run).
 *
 * The Monday 08:00 IST digest for managers, admins and super-admins: last week's
 * attendance, what is waiting for their decision, and what will bite them this
 * week. One email per recipient, each one carrying only what THAT person is
 * allowed to see.
 *
 * SCOPE IS THE DATABASE'S DECISION, NOT THIS FILE'S ─────────────────────────
 * Every read for a recipient runs inside a transaction whose `app.actor_id` is
 * that recipient's `profiles.id` (`withContext`, migration 005/006). That makes
 * `app.can_see_employee()`, `app.is_manager_of()`, `app.is_admin()` and
 * `app.admin_scope_covers()` resolve FOR THEM, so:
 *   - the `v_*` views with explicit predicates (`v_ai_context_org`,
 *     `v_exception_queue`, `v_approval_inbox`) return their slice and nothing
 *     more — an admin scoped to one location cannot receive another's numbers;
 *   - the one aggregate this function writes itself carries
 *     `app.can_see_employee(e.id)` in its WHERE clause, for the same reason.
 *
 * This matters because the edge connection is `postgres`, which BYPASSES RLS.
 * A `security_invoker` view therefore returns EVERY row to this function, so
 * scoping a digest by "just query the view" would leak across managers. Only
 * views whose body carries an `app.*` predicate are safe here, and they are the
 * only ones used.
 *
 * Nothing is written inside those transactions — they are read-only, so no audit
 * row is ever attributed to the recipient. The job's own rows (`job_runs`, the
 * `job_run` chain entry) are written in a separate transaction with a NULL
 * actor, because a scheduled job is not a person.
 *
 * NO MODEL CALL. The catalogue calls this an "infographic" email and the
 * function name says AI, but every number here is rendered deterministically
 * from SQL. spec-architecture §6 requires every numeric claim from the AI agent
 * to cite `sources[]`, and §8's CI invariants require any displayed average to be
 * the arithmetic mean of the exact series shown (or `—` when the series is
 * empty). A generated paragraph cannot honour either. So: `ANTHROPIC_API_KEY` is
 * not read, no prose is invented, and averages appear as `—` rather than as a
 * confident 0. When a charted version is wanted, `ai-agent`'s validated
 * ChartSpec is the way in — not free text bolted on here.
 *
 * DELIVERY goes through `communication-send` (catalogue #13), which owns Resend,
 * the sending domain, the `communications`/`communication_recipients` register
 * and the bounce webhook. This function POSTs to it with the cron secret and a
 * PER-RECIPIENT idempotency key: `communication-send`'s own cron fallback key is
 * `job_code:template:istToday()`, which would collide across recipients on the
 * same morning, so the key is always supplied explicitly here.
 *
 * SCHEDULING (DB gap, see the handover note): migration 041 has no `cron_jobs`
 * row and no `pg_cron` entry for this function. The intended entry is
 * `30 2 * * 1` UTC (= Monday 08:00 IST); until it exists this runs manually, and
 * the Monday guard below makes any other weekday a no-op 200.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem, unavailable } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { addDays, istParts, istToday, nowIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import type { Sql } from "../_shared/deps.ts";
import { rejectBrowserOrigin, verifyCron } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { auditJobRun } from "../_shared/audit.ts";
import {
  claim,
  idempotencyKeyFrom,
  release,
  replayResponse,
  requestHash,
  store,
} from "../_shared/idempotency.ts";

const FN_NAME = "cron-ai-digest";
const DEFAULT_JOB_CODE = "ai_weekly_digest";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** 1 = Monday, in IST (`istParts().weekday`, 0 = Sunday). */
const DIGEST_WEEKDAY = 1;

/** Ceiling on recipients per run — a runaway role grant must not become a mail storm. */
const MAX_RECIPIENTS = 200;

/** Rows in each "top offenders" list inside the email. */
const TOP_N = 5;

/** Employees counted in a team/scope aggregate. */
const ACTIVE_STATUSES = ["active", "confirmed", "on_probation", "on_notice"] as const;

/** Em dash. The honest rendering of "no data", per the `Avg: 0 Hrs` defect. */
const EMPTY = "—";

const DigestBody = z
  .object({
    /** `cron_jobs.code` — names the `job_runs` row and the overlap lock key. */
    job_code: z.string().trim().min(2).max(64).optional(),
    /** Treat this IST date as "today" (a Monday, normally). */
    for_date: common.isoDate.optional(),
    /** Send even when today is not Monday IST. */
    force: z.boolean().default(false),
    /** Restrict the run to these recipients. For a rehearsal or a resend. */
    recipient_profile_ids: z.array(common.uuid).min(1).max(MAX_RECIPIENTS).optional(),
    /** Render everything, send nothing, write no job_run. */
    dry_run: z.boolean().default(false),
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// Recipients
// ═════════════════════════════════════════════════════════════════════════════

interface Recipient {
  profile_id: string;
  email: string;
  full_name: string;
  employee_id: string | null;
  display_name: string | null;
  highest_role: "manager" | "admin" | "super_admin";
  direct_reportees: string | number;
}

/**
 * Every active profile that holds `manager`, `admin` or `super_admin`, with the
 * size of their direct team. `user_roles` is the authority — a manager is
 * whoever the DB says holds the role, not whoever has reportees.
 */
async function loadRecipients(client: Sql, only: readonly string[] | null): Promise<Recipient[]> {
  return await client<Recipient[]>`
    SELECT pr.id                     AS profile_id,
           pr.email,
           pr.full_name,
           e.id                      AS employee_id,
           e.display_name,
           (CASE
              WHEN bool_or(ur.role = 'super_admin') THEN 'super_admin'
              WHEN bool_or(ur.role = 'admin')       THEN 'admin'
              ELSE 'manager'
            END)                     AS highest_role,
           COALESCE((SELECT count(*) FROM public.employees r
                      WHERE r.reporting_manager_id = e.id AND r.deleted_at IS NULL), 0)
                                     AS direct_reportees
      FROM public.user_roles ur
      JOIN public.profiles pr ON pr.id = ur.user_id AND pr.is_active
      LEFT JOIN public.employees e ON e.profile_id = pr.id AND e.deleted_at IS NULL
     WHERE ur.revoked_at IS NULL
       AND ur.role IN ('manager', 'admin', 'super_admin')
       AND (${only === null ? null : [...only]}::uuid[] IS NULL
            OR pr.id = ANY(${only === null ? null : [...only]}::uuid[]))
     GROUP BY pr.id, pr.email, pr.full_name, e.id, e.display_name
     ORDER BY pr.email
     LIMIT ${MAX_RECIPIENTS}
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// Per-recipient reads (all inside the recipient's own actor context)
// ═════════════════════════════════════════════════════════════════════════════

interface WeekAggregate {
  team_size: string | number;
  rows: string | number;
  working_days: string | number;
  present_days: string | number;
  half_days: string | number;
  absent_days: string | number;
  pending_days: string | number;
  leave_days: string | number;
  late_days: string | number;
  late_minutes_total: string | number;
  ot_minutes: string | number;
  ot_approved_minutes: string | number;
  paid_days: string | number;
  anomaly_days: string | number;
}

interface PersonRow {
  employee_code: string;
  display_name: string;
  department_name: string | null;
  late_days: string | number;
  late_minutes: string | number;
  absent_days: string | number;
  pending_days: string | number;
  unapproved_ot_minutes: string | number;
}

interface InboxRow {
  total: string | number;
  overdue: string | number;
  oldest_submitted_at: Date | string | null;
}

interface ExceptionRow {
  exception_kind: string;
  severity: string;
  count: string | number;
}

interface OrgRow {
  department_name: string | null;
  headcount: string | number | null;
  open_approvals: string | number | null;
  last_period_cost_paise: string | number | null;
  last_period_code: string | null;
}

interface DigestData {
  week: WeekAggregate;
  people: PersonRow[];
  inbox: InboxRow | null;
  exceptions: ExceptionRow[];
  org: OrgRow[];
  pending_regularizations: number;
  upcoming_leave_days: number;
}

function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The whole digest payload for one recipient, read with their own scope.
 *
 * The attendance aggregate is written here rather than taken from a view because
 * no view aggregates an arbitrary week; the scope predicate is still the
 * database's (`app.can_see_employee`), so the authorisation decision is not
 * duplicated in TypeScript.
 */
async function loadDigestData(
  tx: Sql,
  window: { from: string; to: string; upcomingTo: string },
): Promise<DigestData> {
  const weekRows = await tx<WeekAggregate[]>`
    WITH scope AS (
      SELECT e.id
        FROM public.employees e
       WHERE e.deleted_at IS NULL
         AND NOT e.exclude_from_attendance
         AND e.employment_status = ANY (${[...ACTIVE_STATUSES]}::public.employment_status[])
         AND app.can_see_employee(e.id)
         AND (app.current_employee_id() IS NULL OR e.id <> app.current_employee_id())
    ),
    days AS (
      SELECT ad.*
        FROM public.attendance_days ad
        JOIN scope s ON s.id = ad.employee_id
       WHERE ad.ist_date BETWEEN ${window.from}::date AND ${window.to}::date
    )
    SELECT (SELECT count(*) FROM scope)                                        AS team_size,
           (SELECT count(*) FROM days)                                         AS rows,
           count(*) FILTER (WHERE d.is_working_day)                            AS working_days,
           count(*) FILTER (WHERE d.status IN
             ('present','weekly_off_worked','holiday_worked','on_duty','work_from_home')) AS present_days,
           count(*) FILTER (WHERE d.status = 'half_day')                       AS half_days,
           count(*) FILTER (WHERE d.status = 'absent')                         AS absent_days,
           count(*) FILTER (WHERE d.status = 'pending' AND d.is_working_day)    AS pending_days,
           count(*) FILTER (WHERE d.status IN ('on_leave','on_leave_half','comp_off_availed')) AS leave_days,
           count(*) FILTER (WHERE d.is_late)                                   AS late_days,
           COALESCE(sum(d.late_minutes) FILTER (WHERE d.is_late), 0)           AS late_minutes_total,
           COALESCE(sum(d.overtime_minutes), 0)                                AS ot_minutes,
           COALESCE(sum(d.approved_overtime_minutes), 0)                       AS ot_approved_minutes,
           COALESCE(sum(d.day_fraction_paid), 0)                               AS paid_days,
           count(*) FILTER (WHERE cardinality(d.anomaly_flags) > 0)            AS anomaly_days
      FROM days d
  `;

  const people = await tx<PersonRow[]>`
    WITH scope AS (
      SELECT e.id, e.employee_code, e.display_name, e.department_id
        FROM public.employees e
       WHERE e.deleted_at IS NULL
         AND NOT e.exclude_from_attendance
         AND e.employment_status = ANY (${[...ACTIVE_STATUSES]}::public.employment_status[])
         AND app.can_see_employee(e.id)
         AND (app.current_employee_id() IS NULL OR e.id <> app.current_employee_id())
    )
    SELECT s.employee_code,
           s.display_name,
           dep.name                                                        AS department_name,
           count(*) FILTER (WHERE ad.is_late)                              AS late_days,
           COALESCE(sum(ad.late_minutes) FILTER (WHERE ad.is_late), 0)     AS late_minutes,
           count(*) FILTER (WHERE ad.status = 'absent')                    AS absent_days,
           count(*) FILTER (WHERE ad.status = 'pending' AND ad.is_working_day) AS pending_days,
           COALESCE(sum(GREATEST(ad.overtime_minutes - ad.approved_overtime_minutes, 0)), 0)
                                                                           AS unapproved_ot_minutes
      FROM scope s
      JOIN public.attendance_days ad
        ON ad.employee_id = s.id
       AND ad.ist_date BETWEEN ${window.from}::date AND ${window.to}::date
      LEFT JOIN public.departments dep ON dep.id = s.department_id
     GROUP BY s.employee_code, s.display_name, dep.name
    HAVING count(*) FILTER (WHERE ad.is_late) > 0
        OR count(*) FILTER (WHERE ad.status = 'absent') > 0
        OR count(*) FILTER (WHERE ad.status = 'pending' AND ad.is_working_day) > 0
        OR COALESCE(sum(GREATEST(ad.overtime_minutes - ad.approved_overtime_minutes, 0)), 0) > 0
     ORDER BY count(*) FILTER (WHERE ad.status = 'absent') DESC,
              count(*) FILTER (WHERE ad.is_late) DESC,
              s.employee_code
     LIMIT ${TOP_N}
  `;

  // `v_approval_inbox` filters on `current_approver_ids @> current_employee_id()`,
  // so this is already the recipient's own queue.
  const inboxRows = await tx<InboxRow[]>`
    SELECT count(*)                                   AS total,
           count(*) FILTER (WHERE i.is_overdue)       AS overdue,
           min(i.submitted_at)                        AS oldest_submitted_at
      FROM public.v_approval_inbox i
  `;

  // `v_exception_queue` is gated on `app.is_admin()`, so a plain manager gets
  // zero rows here without this file having to know the rule.
  const exceptions = await tx<ExceptionRow[]>`
    SELECT q.exception_kind, q.severity, count(*) AS count
      FROM public.v_exception_queue q
     GROUP BY q.exception_kind, q.severity
     ORDER BY count(*) DESC, q.exception_kind
     LIMIT 8
  `;

  // `v_ai_context_org` is gated on `app.is_admin()` too. Only the columns that
  // are meaningful at 08:00 on a Monday are read: the view's "today" counters
  // would be near-empty before the first shift starts.
  const org = await tx<OrgRow[]>`
    SELECT o.department_name, o.headcount, o.open_approvals,
           o.last_period_cost_paise, o.last_period_code
      FROM public.v_ai_context_org o
     WHERE COALESCE(o.headcount, 0) > 0
     ORDER BY o.headcount DESC NULLS LAST, o.department_name
     LIMIT 12
  `;

  const regRows = await tx<{ pending: string | number }[]>`
    SELECT count(*) AS pending
      FROM public.attendance_regularizations ar
      JOIN public.employees e ON e.id = ar.employee_id
     WHERE ar.status IN ('draft', 'pending')
       AND e.deleted_at IS NULL
       AND app.can_see_employee(e.id)
  `;

  const leaveRows = await tx<{ days: string | number }[]>`
    SELECT COALESCE(sum(lr.total_days), 0) AS days
      FROM public.leave_requests lr
      JOIN public.employees e ON e.id = lr.employee_id
     WHERE lr.status IN ('approved', 'partially_approved')
       AND lr.from_date <= ${window.upcomingTo}::date
       AND lr.to_date   >= ${addDays(window.to, 1)}::date
       AND e.deleted_at IS NULL
       AND app.can_see_employee(e.id)
  `;

  const week = firstRow(weekRows) ?? {
    team_size: 0,
    rows: 0,
    working_days: 0,
    present_days: 0,
    half_days: 0,
    absent_days: 0,
    pending_days: 0,
    leave_days: 0,
    late_days: 0,
    late_minutes_total: 0,
    ot_minutes: 0,
    ot_approved_minutes: 0,
    paid_days: 0,
    anomaly_days: 0,
  };

  return {
    week,
    people,
    inbox: firstRow(inboxRows),
    exceptions,
    org,
    pending_regularizations: num(firstRow(regRows)?.pending),
    upcoming_leave_days: num(firstRow(leaveRows)?.days),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Rendering — pure, exported for `supabase/tests`
// ═════════════════════════════════════════════════════════════════════════════

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Percentage, clamped to `[0,100]`, `null` when the denominator is empty.
 * CI invariant (1): no percentage anywhere outside `[0,100]`.
 */
export function safePct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(((part * 100) / whole) * 10) / 10));
}

/**
 * Arithmetic mean of the exact series, or `null` when the series is empty.
 * CI invariant (2): never a fabricated 0 — that is the `Avg: 0 Hrs` defect.
 */
export function safeMean(total: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.round((total / count) * 10) / 10;
}

/** `95` → `1h 35m`; `0` → `0m`. Duration formatting only, never a business date. */
export function minutesToHm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h === 0 ? `${m}m` : `${h}h ${m % 60}m`;
}

function fmtNum(value: number | null, suffix = ""): string {
  return value === null ? EMPTY : `${value}${suffix}`;
}

function paiseToInr(paise: number): string {
  // D-04: money is integer paise end to end; this is the only place it becomes
  // a display string, and it is a display string — never an input to arithmetic.
  const rupees = Math.round(paise / 100);
  return `₹${rupees.toLocaleString("en-IN")}`;
}

interface DigestView {
  recipientName: string;
  role: Recipient["highest_role"];
  weekFrom: string;
  weekTo: string;
  weekAheadTo: string;
  appBaseUrl: string;
  data: DigestData;
}

/** The numbers, computed once, shared by the HTML and the plain-text bodies. */
export interface DigestMetrics {
  teamSize: number;
  workingDays: number;
  presentDays: number;
  absentDays: number;
  pendingDays: number;
  leaveDays: number;
  lateDays: number;
  paidDays: number;
  anomalyDays: number;
  otMinutes: number;
  otUnapprovedMinutes: number;
  attendancePct: number | null;
  latePct: number | null;
  avgLateMinutes: number | null;
  approvalsTotal: number;
  approvalsOverdue: number;
  pendingRegularizations: number;
  upcomingLeaveDays: number;
}

export function metricsOf(data: DigestData): DigestMetrics {
  const w = data.week;
  const workingDays = num(w.working_days);
  const presentDays = num(w.present_days) + num(w.half_days);
  const lateDays = num(w.late_days);
  const otMinutes = num(w.ot_minutes);
  const otApproved = num(w.ot_approved_minutes);
  return {
    teamSize: num(w.team_size),
    workingDays,
    presentDays,
    absentDays: num(w.absent_days),
    pendingDays: num(w.pending_days),
    leaveDays: num(w.leave_days),
    lateDays,
    paidDays: Math.round(num(w.paid_days) * 100) / 100,
    anomalyDays: num(w.anomaly_days),
    otMinutes,
    otUnapprovedMinutes: Math.max(0, otMinutes - otApproved),
    // Denominators are the exact series listed above them, so the email cannot
    // disagree with itself.
    attendancePct: safePct(presentDays, workingDays),
    latePct: safePct(lateDays, workingDays),
    avgLateMinutes: safeMean(num(w.late_minutes_total), lateDays),
    approvalsTotal: num(data.inbox?.total),
    approvalsOverdue: num(data.inbox?.overdue),
    pendingRegularizations: data.pending_regularizations,
    upcomingLeaveDays: Math.round(data.upcoming_leave_days * 100) / 100,
  };
}

/** Brand palette (settings `branding.*`, seeded in migration 046). Inline only: email has no CSS files. */
const BRAND = {
  primary: "#CE8F6F",
  plum: "#564147",
  navy: "#121F38",
  paper: "#FFFFFF",
  ink: "#1F2933",
  muted: "#6B7280",
  line: "#E5E7EB",
} as const;

function statTile(label: string, value: string, note: string): string {
  return `
      <td style="padding:10px 12px;background:#FAF7F5;border:1px solid ${BRAND.line};border-radius:8px;vertical-align:top">
        <div style="font:600 11px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${BRAND.muted}">${
    escapeHtml(label)
  }</div>
        <div style="font:700 22px/1.25 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.navy};margin-top:4px">${
    escapeHtml(value)
  }</div>
        <div style="font:400 12px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.muted};margin-top:2px">${
    escapeHtml(note)
  }</div>
      </td>`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = headers
    .map((h, i) =>
      `<th align="${
        i === 0 ? "left" : "right"
      }" style="padding:6px 8px;border-bottom:2px solid ${BRAND.line};font:600 12px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.muted}">${
        escapeHtml(h)
      }</th>`
    )
    .join("");
  const body = rows
    .map((row) =>
      `<tr>${
        row
          .map((cell, i) =>
            `<td align="${
              i === 0 ? "left" : "right"
            }" style="padding:6px 8px;border-bottom:1px solid ${BRAND.line};font:400 13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink}">${
              escapeHtml(cell)
            }</td>`
          )
          .join("")
      }</tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 2px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Table-based, inline-styled, no external assets: the only HTML email clients agree on. */
export function renderHtml(view: DigestView): string {
  const m = metricsOf(view.data);
  const period = `${view.weekFrom} to ${view.weekTo}`;

  const tiles = [
    statTile("Attendance", fmtNum(m.attendancePct, "%"), `${m.presentDays} of ${m.workingDays} working days`),
    statTile("Late", String(m.lateDays), m.avgLateMinutes === null ? "no late arrivals" : `avg ${m.avgLateMinutes} min late`),
    statTile("Absent", String(m.absentDays), `${m.leaveDays} on leave`),
    statTile("Unprocessed", String(m.pendingDays), m.pendingDays === 0 ? "all days computed" : "days with no verdict yet"),
  ];

  const peopleRows = view.data.people.map((p) => [
    `${p.display_name} (${p.employee_code})`,
    String(num(p.absent_days)),
    String(num(p.late_days)),
    String(num(p.pending_days)),
    minutesToHm(num(p.unapproved_ot_minutes)),
  ]);

  const exceptionRows = view.data.exceptions.map((e) => [
    e.exception_kind.replace(/_/g, " "),
    e.severity,
    String(num(e.count)),
  ]);

  const orgRows = view.data.org.map((o) => [
    o.department_name ?? EMPTY,
    String(num(o.headcount)),
    String(num(o.open_approvals)),
    o.last_period_cost_paise === null ? EMPTY : paiseToInr(num(o.last_period_cost_paise)),
  ]);

  const sections: string[] = [];

  sections.push(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate">
      <tr>${tiles.slice(0, 2).join("")}</tr>
      <tr>${tiles.slice(2).join("")}</tr>
    </table>`);

  sections.push(`
    <p style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink};margin:14px 0 4px">
      <strong>Waiting on you:</strong> ${m.approvalsTotal} approval(s)${
    m.approvalsOverdue > 0 ? `, <strong style="color:#B42318">${m.approvalsOverdue} past SLA</strong>` : ""
  }; ${m.pendingRegularizations} regularization(s) in scope.
    </p>
    <p style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink};margin:0 0 4px">
      <strong>Overtime:</strong> ${minutesToHm(m.otMinutes)} recorded, ${
    minutesToHm(m.otUnapprovedMinutes)
  } still unapproved (unapproved overtime is not paid).
    </p>
    <p style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink};margin:0">
      <strong>Week ahead (to ${escapeHtml(view.weekAheadTo)}):</strong> ${m.upcomingLeaveDays} approved leave day(s) in your scope.
    </p>`);

  if (peopleRows.length > 0) {
    sections.push(
      `<h3 style="font:600 14px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.plum};margin:18px 0 0">Needs a conversation</h3>` +
        table(["Employee", "Absent", "Late", "Unprocessed", "OT unapproved"], peopleRows),
    );
  }
  if (exceptionRows.length > 0) {
    sections.push(
      `<h3 style="font:600 14px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.plum};margin:18px 0 0">Open exceptions</h3>` +
        table(["Exception", "Severity", "Count"], exceptionRows),
    );
  }
  if (orgRows.length > 0) {
    sections.push(
      `<h3 style="font:600 14px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.plum};margin:18px 0 0">Departments</h3>` +
        table(["Department", "Headcount", "Open approvals", "Last period cost"], orgRows),
    );
  }

  return `<div style="margin:0;padding:0;background:#F3F0EE">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F0EE">
    <tr><td align="center" style="padding:20px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${BRAND.paper};border:1px solid ${BRAND.line};border-radius:12px">
        <tr><td style="padding:18px 20px;background:${BRAND.navy};border-radius:12px 12px 0 0">
          <div style="font:700 16px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#FFFFFF">The Tamarind Tree — weekly digest</div>
          <div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.primary};margin-top:2px">${
    escapeHtml(period)
  } · ${escapeHtml(view.role.replace(/_/g, " "))} view</div>
        </td></tr>
        <tr><td style="padding:18px 20px">
          <p style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink};margin:0 0 10px">
            ${escapeHtml(view.recipientName)}, here is last week for the ${m.teamSize} people in your scope.
          </p>
          ${sections.join("\n")}
          <p style="margin:20px 0 0">
            <a href="${escapeHtml(view.appBaseUrl)}/dashboard" style="display:inline-block;padding:10px 16px;background:${BRAND.primary};color:#FFFFFF;text-decoration:none;border-radius:8px;font:600 14px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">Open the dashboard</a>
          </p>
        </td></tr>
        <tr><td style="padding:12px 20px 18px;border-top:1px solid ${BRAND.line}">
          <div style="font:400 12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.muted}">
            Every figure is computed from your own access scope — you are seeing exactly what you are permitted to see, and nothing else.
            A dash (${EMPTY}) means there was no data to average, not zero.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</div>`;
}

/** Plain-text alternative. Same numbers, same dashes. */
export function renderText(view: DigestView): string {
  const m = metricsOf(view.data);
  const lines = [
    `The Tamarind Tree — weekly digest (${view.weekFrom} to ${view.weekTo})`,
    "",
    `${view.recipientName}, last week for the ${m.teamSize} people in your scope:`,
    `- Attendance: ${fmtNum(m.attendancePct, "%")} (${m.presentDays} of ${m.workingDays} working days)`,
    `- Late arrivals: ${m.lateDays}${m.avgLateMinutes === null ? "" : ` (avg ${m.avgLateMinutes} min)`}`,
    `- Absent: ${m.absentDays} | On leave: ${m.leaveDays} | Unprocessed: ${m.pendingDays}`,
    `- Paid days recorded: ${m.paidDays}`,
    `- Overtime: ${minutesToHm(m.otMinutes)} recorded, ${minutesToHm(m.otUnapprovedMinutes)} unapproved`,
    `- Waiting on you: ${m.approvalsTotal} approval(s), ${m.approvalsOverdue} past SLA`,
    `- Regularizations pending in scope: ${m.pendingRegularizations}`,
    `- Approved leave in the week ahead (to ${view.weekAheadTo}): ${m.upcomingLeaveDays} day(s)`,
  ];
  if (view.data.people.length > 0) {
    lines.push("", "Needs a conversation:");
    for (const p of view.data.people) {
      lines.push(
        `- ${p.display_name} (${p.employee_code}): ${num(p.absent_days)} absent, ${num(p.late_days)} late, ` +
          `${num(p.pending_days)} unprocessed, ${minutesToHm(num(p.unapproved_ot_minutes))} OT unapproved`,
      );
    }
  }
  if (view.data.exceptions.length > 0) {
    lines.push("", "Open exceptions:");
    for (const e of view.data.exceptions) {
      lines.push(`- ${e.exception_kind.replace(/_/g, " ")} (${e.severity}): ${num(e.count)}`);
    }
  }
  if (view.data.org.length > 0) {
    lines.push("", "Departments:");
    for (const o of view.data.org) {
      lines.push(
        `- ${o.department_name ?? EMPTY}: ${num(o.headcount)} people, ${num(o.open_approvals)} open approvals` +
          (o.last_period_cost_paise === null ? "" : `, last period ${paiseToInr(num(o.last_period_cost_paise))}`),
      );
    }
  }
  lines.push(
    "",
    `Open the dashboard: ${view.appBaseUrl}/dashboard`,
    "",
    `A dash (${EMPTY}) means there was no data to average, not zero.`,
  );
  return lines.join("\n");
}

export function subjectFor(view: DigestView): string {
  const m = metricsOf(view.data);
  const head = m.attendancePct === null ? "no attendance data" : `${m.attendancePct}% attendance`;
  const tail = m.approvalsTotal > 0 ? `, ${m.approvalsTotal} awaiting you` : "";
  return `Weekly digest ${view.weekFrom}–${view.weekTo}: ${head}${tail}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Delivery via communication-send
// ═════════════════════════════════════════════════════════════════════════════

async function settingsMap(client: Sql, keys: readonly string[]): Promise<Map<string, string | null>> {
  const rows = await client<{ key: string; value: string | null }[]>`
    SELECT s.key, s.value #>> '{}' AS value
      FROM public.settings s
     WHERE s.key = ANY(${[...keys]}::text[])
     ORDER BY (s.scope = 'global') DESC
  `;
  const out = new Map<string, string | null>();
  for (const row of rows) if (!out.has(row.key)) out.set(row.key, row.value);
  return out;
}

/**
 * Where `communication-send` lives. `SUPABASE_URL` is injected by the runtime, so
 * the default needs no new secret and no settings row; `edge_base_url` (the key
 * migration 041's cron commands read) or `EDGE_BASE_URL` override it.
 */
function edgeBaseUrl(settings: Map<string, string | null>): string {
  const configured = settings.get("edge_base_url");
  const env = Deno.env.get("EDGE_BASE_URL");
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const chosen = configured ?? env ?? (projectUrl === undefined ? null : `${projectUrl}/functions/v1`);
  if (chosen === null || chosen.trim() === "") {
    throw unavailable(
      "No edge base URL is configured. Set the `edge_base_url` setting or the EDGE_BASE_URL secret.",
      "EDGE_BASE_URL_UNCONFIGURED",
    );
  }
  return chosen.trim().replace(/\/+$/, "");
}

function appBaseUrl(settings: Map<string, string | null>): string {
  const configured = settings.get("app_base_url") ?? settings.get("comms.app_base_url");
  const env = Deno.env.get("APP_BASE_URL");
  return (configured ?? env ?? "https://hr.thetamarindtree.in").trim().replace(/\/+$/, "");
}

type SendOutcome =
  | { kind: "sent"; detail: string }
  | { kind: "replayed"; detail: string }
  | { kind: "failed"; detail: string };

/**
 * One personalised send. The idempotency key is explicit and per recipient:
 * `communication-send`'s cron fallback key (`job_code:template:day`) is shared
 * across a whole run, and re-using it here would make the second recipient's
 * body look like a changed retry of the first (409 IDEMPOTENCY_KEY_REUSED).
 */
async function sendDigest(
  base: string,
  cronSecret: string,
  requestId: string,
  input: { profileId: string; subject: string; html: string; text: string; idempotencyKey: string },
): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetch(`${base}/communication-send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": cronSecret,
        "x-idempotency-key": input.idempotencyKey,
        "x-request-id": requestId,
        "x-reason": "weekly manager/admin digest, scheduled",
      },
      body: JSON.stringify({
        mode: "transactional",
        communication_kind: "reminder",
        audience: { profile_ids: [input.profileId] },
        message: { subject: input.subject, body_html: input.html, body_text: input.text },
        max_recipients: 1,
      }),
    });
  } catch (err) {
    return { kind: "failed", detail: `transport: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}` };
  }

  if (response.headers.get("x-idempotent-replay") === "true") {
    await response.body?.cancel();
    return { kind: "replayed", detail: "already sent under this key" };
  }
  if (response.ok) {
    await response.body?.cancel();
    return { kind: "sent", detail: `${response.status}` };
  }
  const text = (await response.text().catch(() => "")).slice(0, 300);
  return { kind: "failed", detail: `${response.status}: ${text}` };
}

// ═════════════════════════════════════════════════════════════════════════════
// Handler
// ═════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ───────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ─────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ───────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;
  let jobRunId: string | null = null;
  let jobCode = DEFAULT_JOB_CODE;
  let responseBody: unknown = null;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model C) ─────────────────────────────────────────────
    rejectBrowserOrigin(req);
    const cronAuth = verifyCron(req);
    log.info("cron authenticated", { via: cronAuth.via });

    // ── STEP 5 · Authority ──────────────────────────────────────────────────
    // Auth model C: the constant-time secret comparison IS the authority. The
    // per-recipient reads below then run under each RECIPIENT's scope, which is
    // where authorisation actually bites for this function.

    const rawBody = await readRawBody(req, { maxBytes: 16 * 1024, requireJsonContentType: false });
    const decoded = rawBody === "" ? {} : decodeJson(rawBody);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    await enforce(RATE_LIMITS.heavyJob, limitKey(FN_NAME, "cron"), "DIGEST_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const body = parse(DigestBody, decoded, "digest request");
    jobCode = body.job_code ?? DEFAULT_JOB_CODE;
    const forDate = body.for_date ?? istToday();
    const weekday = istParts(`${forDate}T00:00:00+05:30`).weekday;

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // Keyed to the IST day: a pg_net retry replays the summary instead of mailing
    // every manager twice. Per-recipient keys guard the individual sends.
    if (!body.dry_run) {
      idempotencyKey = idempotencyKeyFrom(req) ?? `${FN_NAME}:${jobCode}:${forDate}`;
      const hash = await requestHash(FN_NAME, rawBody, jobCode);
      const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: hash });
      if (claimed.state === "replay") {
        status = claimed.status;
        log.info("idempotent replay", { key: idempotencyKey });
        return replayResponse(claimed, { ...cors, "x-request-id": requestId });
      }
    }

    const pool = sql();

    // Double-run guard (spec-architecture §9): a 200, not an error.
    if (!body.dry_run) {
      const begun = await pool<{ id: string | null }[]>`
        SELECT app.job_begin(${jobCode}, ${`${FN_NAME}:${jobCode}`}) AS id
      `;
      jobRunId = firstRow(begun)?.id ?? null;
      if (jobRunId === null) {
        status = 200;
        responseBody = { skipped: "already_running", job_code: jobCode, requestId };
        if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
        return ok(responseBody, { status, headers: cors, requestId });
      }
    }

    // ── The Monday guard ────────────────────────────────────────────────────
    if (weekday !== DIGEST_WEEKDAY && !body.force) {
      status = 200;
      responseBody = {
        skipped: "not_digest_weekday",
        job_code: jobCode,
        for_date: forDate,
        detail: "The weekly digest is sent on Mondays (IST). Pass force: true to send anyway.",
        requestId,
      };
      if (jobRunId !== null) {
        await pool`
          SELECT app.job_end(${jobRunId}::uuid, 'skipped'::public.job_run_status, 0, 0,
                             ${JSON.stringify({ skipped: "not_digest_weekday", for_date: forDate })}::jsonb, NULL)
        `;
      }
      if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
      log.info("not monday", { for_date: forDate, weekday });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    // Last full week: the seven days ending yesterday.
    const weekTo = addDays(forDate, -1);
    const weekFrom = addDays(forDate, -7);
    const weekAheadTo = addDays(forDate, 6);

    const settings = await settingsMap(pool, ["edge_base_url", "app_base_url", "comms.app_base_url"]);
    const appUrl = appBaseUrl(settings);
    const edgeUrl = body.dry_run ? "" : edgeBaseUrl(settings);
    const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
    if (!body.dry_run && cronSecret === "") {
      // `verifyCron` already proved it exists; this keeps the type honest.
      throw unavailable("CRON_SECRET is not available to forward.", "ENV_MISSING");
    }

    const recipients = await loadRecipients(pool, body.recipient_profile_ids ?? null);

    interface PerRecipient {
      profile_id: string;
      email: string;
      role: Recipient["highest_role"];
      team_size: number;
      outcome: "sent" | "replayed" | "failed" | "skipped_no_scope" | "skipped_no_email" | "rendered";
      detail: string;
      subject?: string;
    }
    const outcomes: PerRecipient[] = [];
    const previews: { profile_id: string; subject: string; html: string; text: string }[] = [];

    for (const recipient of recipients) {
      if (recipient.email.trim() === "") {
        outcomes.push({
          profile_id: recipient.profile_id,
          email: "",
          role: recipient.highest_role,
          team_size: 0,
          outcome: "skipped_no_email",
          detail: "profile has no email address",
        });
        continue;
      }

      // ── STEP 9 · the recipient's own context, ONE read-only transaction ───
      const ctxRead: RequestContext = {
        actorId: recipient.profile_id,
        actorRole: recipient.highest_role,
        source: "cron",
        sourceRoute: FN_NAME,
        requestId,
        ip: clientIpFrom(req),
        ua: userAgentFrom(req),
        deviceId: null,
        reason: `${FN_NAME}: read digest data within this recipient's own scope`,
      };
      const data = await withContext(
        ctxRead,
        (tx) => loadDigestData(tx, { from: weekFrom, to: weekTo, upcomingTo: weekAheadTo }),
      );

      const teamSize = num(data.week.team_size);
      const hasOrgView = data.org.length > 0 || data.exceptions.length > 0;
      if (teamSize === 0 && !hasOrgView && num(data.inbox?.total) === 0) {
        outcomes.push({
          profile_id: recipient.profile_id,
          email: recipient.email,
          role: recipient.highest_role,
          team_size: 0,
          outcome: "skipped_no_scope",
          detail: "nothing in scope: no visible employees, no org view, empty approval inbox",
        });
        continue;
      }

      const view: DigestView = {
        recipientName: recipient.display_name ?? recipient.full_name,
        role: recipient.highest_role,
        weekFrom,
        weekTo,
        weekAheadTo,
        appBaseUrl: appUrl,
        data,
      };
      const subject = subjectFor(view);
      const html = renderHtml(view);
      const text = renderText(view);

      if (body.dry_run) {
        previews.push({ profile_id: recipient.profile_id, subject, html, text });
        outcomes.push({
          profile_id: recipient.profile_id,
          email: recipient.email,
          role: recipient.highest_role,
          team_size: teamSize,
          outcome: "rendered",
          detail: `${html.length} bytes of HTML`,
          subject,
        });
        continue;
      }

      const sent = await sendDigest(edgeUrl, cronSecret, requestId, {
        profileId: recipient.profile_id,
        subject,
        html,
        text,
        idempotencyKey: `${FN_NAME}:${weekFrom}:${recipient.profile_id}`,
      });
      outcomes.push({
        profile_id: recipient.profile_id,
        email: recipient.email,
        role: recipient.highest_role,
        team_size: teamSize,
        outcome: sent.kind === "sent" ? "sent" : sent.kind === "replayed" ? "replayed" : "failed",
        detail: sent.detail,
        subject,
      });
      if (sent.kind === "failed") log.warn("digest send failed", { profile_id: recipient.profile_id, detail: sent.detail });
    }

    const sentCount = outcomes.filter((o) => o.outcome === "sent").length;
    const replayed = outcomes.filter((o) => o.outcome === "replayed").length;
    const failedCount = outcomes.filter((o) => o.outcome === "failed").length;
    const skipped = outcomes.filter((o) => o.outcome.startsWith("skipped")).length;

    if (body.dry_run) {
      status = 200;
      responseBody = {
        dry_run: true,
        job_code: jobCode,
        for_date: forDate,
        week: { from: weekFrom, to: weekTo, ahead_to: weekAheadTo },
        recipients: recipients.length,
        outcomes,
        previews: previews.slice(0, 3),
        note: "nothing sent, nothing written",
        requestId,
      };
      log.info("digest dry run", { recipients: recipients.length, rendered: previews.length });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    // ── STEP 10 · Close the run and put it on the chain (NULL actor) ─────────
    const ctxJob: RequestContext = {
      actorId: null, // a scheduled job is not a person
      actorRole: null,
      source: "cron",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: null,
      reason: `${FN_NAME}: weekly digest for ${weekFrom}..${weekTo}`,
    };
    const outcome = failedCount > 0 && sentCount === 0 ? "failed" : "succeeded";
    await withContext(ctxJob, async (tx) => {
      await tx`
        SELECT app.job_end(
                 ${jobRunId}::uuid,
                 ${outcome}::public.job_run_status,
                 ${outcomes.length}::integer,
                 ${failedCount}::integer,
                 ${JSON.stringify({
        week: { from: weekFrom, to: weekTo },
        recipients: recipients.length,
        sent: sentCount,
        replayed,
        failed: failedCount,
        skipped,
      })}::jsonb,
                 ${
        failedCount === 0 ? null : outcomes
          .filter((o) => o.outcome === "failed")
          .map((o) => `${o.email}: ${o.detail}`)
          .join(" | ")
          .slice(0, 2_000)
      }::text)
      `;
      await auditJobRun(tx, ctxJob, {
        jobCode,
        runId: jobRunId,
        outcome,
        stats: {
          week_from: weekFrom,
          week_to: weekTo,
          recipients: recipients.length,
          sent: sentCount,
          replayed,
          failed: failedCount,
          skipped,
        },
      });
    });

    status = 200;
    responseBody = {
      job_code: jobCode,
      job_run_id: jobRunId,
      for_date: forDate,
      generated_at: nowIso(),
      week: { from: weekFrom, to: weekTo, ahead_to: weekAheadTo },
      recipients: recipients.length,
      sent: sentCount,
      replayed,
      failed: failedCount,
      skipped,
      outcomes: outcomes.map((o) => ({
        profile_id: o.profile_id,
        role: o.role,
        team_size: o.team_size,
        outcome: o.outcome,
        detail: o.detail,
      })),
      requestId,
    };

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
    log.info("digest run complete", { recipients: recipients.length, sent: sentCount, failed: failedCount, skipped });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, problem.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }
    if (jobRunId !== null) {
      try {
        await sql()`
          SELECT app.job_end(${jobRunId}::uuid, 'failed'::public.job_run_status, NULL, NULL, NULL,
                             ${`${problem.code ?? "ERROR"}: ${problem.problem.title}`}::text)
        `;
      } catch (jobErr) {
        log.warn("could not close job run", { err: jobErr });
      }
    }

    if (problem.isServerFault) log.error("digest failed", { err, code: problem.code });
    else log.warn("digest refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey, job_run_id: jobRunId, job_code: jobCode });
  }
});

/** Exported for `supabase/tests`: the contract and the pure renderers. */
export { DigestBody };
