/**
 * cron-daily-attendance-close — catalogue #21, auth model **C** (cron secret,
 * constant-time, or a service-role bearer for a manual replay).
 *
 * The 04:00 IST daily close for YESTERDAY's IST business date, in four steps that
 * are individually addressable so the two schedules in migration 041 can share
 * one door:
 *
 *   1. ABSENTS      `public.mark_absent_days()` (migration 018 §8). The engine —
 *                   not this function — decides the status: it re-runs
 *                   `compute_attendance_day` for every attendance-tracked
 *                   employee whose yesterday row is missing or still `pending`,
 *                   and the day flips to `absent` once
 *                   `absent_marking_delay_hours` has passed. Reimplementing that
 *                   decision here would be a second engine (D "correctness lives
 *                   in the DB").
 *   2. EXCEPTIONS   Read the day's `anomaly_flags` / statuses and write ONE
 *                   `public.system_health` row for the close, so "why is the
 *                   exception queue long?" is answerable from data rather than
 *                   from a log line. Nothing is recomputed here.
 *   3. NOTIFY       Enqueue `NO_SHOW_ALERT` (to the reporting manager, HR when
 *                   there is none) and `PUNCH_MISSING_OUT` (to the employee AND
 *                   the manager, with a one-tap regularize deep link) as
 *                   `channel = 'in_app'`, `status = 'queued'` rows.
 *                   `notification-dispatch` (#14) owns the email fan-out,
 *                   preferences and quiet hours — this function must not send
 *                   anything itself, or a person gets two emails.
 *   4. MATVIEWS     `analytics.refresh_matview()` per view (migration 036 §7),
 *                   CONCURRENTLY, so the manager/admin dashboards for the closed
 *                   day are correct by the time anyone looks.
 *
 * TASKS (query `?task=` or body `task`; the query is what migration 041 sends):
 *   `close`        default — all four steps. Registered as `mark_absent_days`.
 *   `missing_out`  step 3's PUNCH_MISSING_OUT sweep only, over a short lookback.
 *                  This is the 22:00 / 03:00 IST `missing_out_punch_sweep` job.
 *   `absents` / `exceptions` / `matviews`  one step each, for operator recovery.
 *
 * IDEMPOTENCE, three independent layers, because a cron POST can be retried by
 * `pg_net` and a human can fire the same job by hand a minute later:
 *   - `app.job_begin` (`uq_job_runs__running_lock`) makes a CONCURRENT run a
 *     `200 {"skipped":"already_running"}`, never an error (§9).
 *   - the idempotency key (default: fn + task + business date) replays the stored
 *     response for a retry of the same run.
 *   - every notification carries a `dedupe_key`, so even a fresh run that gets
 *     past both guards enqueues nothing twice. The unique index on `dedupe_key`
 *     is PER PARTITION (migration 027 table comment), so the guard is an explicit
 *     `NOT EXISTS`, not `ON CONFLICT`.
 *
 * NOT DONE HERE: draining `attendance_recompute_queue` (its own minute-ly job),
 * marking absents for any date other than yesterday (`mark_absent_days()` takes
 * no date — a backfill is `attendance-recompute`, which has the audit trail and
 * the lock handling for it), and sending email.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem, unprocessable } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger, type Logger } from "../_shared/log.ts";
import { addDays, daysBetween, istToday } from "../_shared/datetime.ts";
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

const FN_NAME = "cron-daily-attendance-close";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** `cron_jobs.code` defaults, per task (migration 041 §2). */
const JOB_CODE_BY_TASK: Record<Task, string> = {
  close: "mark_absent_days",
  absents: "mark_absent_days",
  exceptions: "mark_absent_days",
  matviews: "mark_absent_days",
  missing_out: "missing_out_punch_sweep",
};

/** Business dates the missing-out sweep looks back over (today + yesterday IST). */
const MISSING_OUT_LOOKBACK_DAYS = 1;
/** Notifications one class may enqueue per run. A larger backlog drains next run. */
const MAX_NOTIFY_PER_CLASS = 2_000;
/** Days-with-anomalies above which the close is reported `degraded`. */
const EXCEPTION_ALERT_THRESHOLD = 25;
/** How far back a manual re-close may be aimed. Older dates are a recompute job. */
const MAX_BACKDATE_DAYS = 62;

/** Refreshed by the daily close. Names are validated by `analytics.refresh_matview`. */
const CLOSE_MATVIEWS = ["mv_attendance_monthly", "mv_headcount_daily"] as const;

const TASKS = ["close", "absents", "exceptions", "notify", "matviews", "missing_out"] as const;
type Task = "close" | "absents" | "exceptions" | "matviews" | "missing_out";

const CloseBody = z
  .object({
    /** `cron_jobs.code`, for the `job_runs` row and the overlap lock key. */
    job_code: z.string().trim().min(2).max(64).optional(),
    task: z.enum(TASKS).optional(),
    /**
     * IST business date to close. Absent = yesterday IST, which is the only date
     * `mark_absent_days()` can act on.
     */
    business_date: common.isoDate.optional(),
    /** Resolve and count, write nothing. */
    dry_run: z.boolean().default(false),
    /** Skip the matview refresh (a separate 15-minute job also does it). */
    refresh_matviews: z.boolean().optional(),
    limit: z.number().int().min(1).max(MAX_NOTIFY_PER_CLASS).default(MAX_NOTIFY_PER_CLASS),
  })
  .strict();

/** `notify` is an alias for the notification half of `close`. */
function normaliseTask(raw: string | undefined): Task {
  if (raw === undefined || raw === "close") return "close";
  if (raw === "notify") return "missing_out";
  return raw as Task;
}

interface ExceptionSummary {
  days_total: number;
  absent: number;
  pending: number;
  half_day: number;
  no_out_punch: number;
  span_over_16h: number;
  punch_outside_shift: number;
  other_anomalies: number;
  manual_override: number;
  locked: number;
}

const EMPTY_EXCEPTIONS: ExceptionSummary = {
  days_total: 0,
  absent: 0,
  pending: 0,
  half_day: 0,
  no_out_punch: 0,
  span_over_16h: 0,
  punch_outside_shift: 0,
  other_anomalies: 0,
  manual_override: 0,
  locked: 0,
};

/** postgres.js hydrates `count(*)`/`bigint` as a string; every counter goes through here. */
function asCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * The exception picture for one business date. Read-only: the flags were written
 * by `compute_attendance_day`, and nothing here may second-guess them.
 */
async function readExceptions(client: Sql, businessDate: string): Promise<ExceptionSummary> {
  const rows = await client<Record<string, unknown>[]>`
    SELECT count(*)                                                          AS days_total,
           count(*) FILTER (WHERE ad.status = 'absent')                      AS absent,
           count(*) FILTER (WHERE ad.status = 'pending')                     AS pending,
           count(*) FILTER (WHERE ad.status = 'half_day')                    AS half_day,
           count(*) FILTER (WHERE 'no_out_punch'       = ANY (ad.anomaly_flags)) AS no_out_punch,
           count(*) FILTER (WHERE 'span_over_16h'      = ANY (ad.anomaly_flags)) AS span_over_16h,
           count(*) FILTER (WHERE 'punch_outside_shift' = ANY (ad.anomaly_flags)) AS punch_outside_shift,
           count(*) FILTER (WHERE ad.anomaly_flags <> '{}'
                              AND NOT ('no_out_punch'        = ANY (ad.anomaly_flags))
                              AND NOT ('span_over_16h'       = ANY (ad.anomaly_flags))
                              AND NOT ('punch_outside_shift' = ANY (ad.anomaly_flags))) AS other_anomalies,
           count(*) FILTER (WHERE ad.manual_override_status OR ad.manual_override_times) AS manual_override,
           count(*) FILTER (WHERE ad.is_locked)                              AS locked
      FROM public.attendance_days ad
     WHERE ad.ist_date = ${businessDate}::date
  `;
  const row = firstRow(rows);
  if (row === null) return { ...EMPTY_EXCEPTIONS };
  return {
    days_total: asCount(row.days_total),
    absent: asCount(row.absent),
    pending: asCount(row.pending),
    half_day: asCount(row.half_day),
    no_out_punch: asCount(row.no_out_punch),
    span_over_16h: asCount(row.span_over_16h),
    punch_outside_shift: asCount(row.punch_outside_shift),
    other_anomalies: asCount(row.other_anomalies),
    manual_override: asCount(row.manual_override),
    locked: asCount(row.locked),
  };
}

/**
 * `NO_SHOW_ALERT` to the reporting manager. The SMS copy seeded in migration 045
 * — "{{employee_name}} has not punched in for the {{shift_label}} shift on
 * {{date}}" — fixes the recipient: this is an alert ABOUT an employee, TO whoever
 * is accountable for the shift. `priority = 'high'` keeps it out of the digest and
 * through quiet hours (`QUIET_HOURS_EXEMPT_CODES` in #14).
 */
async function enqueueNoShow(tx: Sql, businessDate: string, limit: number): Promise<number> {
  const rows = await tx`
    WITH src AS (
      SELECT ad.id                       AS day_id,
             ad.ist_date,
             e.id                        AS subject_employee_id,
             e.company_id,
             e.employee_code,
             e.display_name,
             m.id                        AS mgr_employee_id,
             mp.id                       AS mgr_profile_id,
             sh.name                     AS shift_label
        FROM public.attendance_days ad
        JOIN public.employees e   ON e.id = ad.employee_id AND e.deleted_at IS NULL
        LEFT JOIN public.employees m  ON m.id = e.reporting_manager_id AND m.deleted_at IS NULL
        LEFT JOIN public.profiles  mp ON mp.id = m.profile_id AND mp.is_active
        LEFT JOIN public.shifts    sh ON sh.id = ad.shift_id
       WHERE ad.ist_date = ${businessDate}::date
         AND ad.status = 'absent'
         AND ad.is_working_day
         AND ad.punch_count = 0
       ORDER BY e.employee_code
       LIMIT ${limit}
    )
    INSERT INTO public.notifications
      (employee_id, profile_id, template_id, event_code, channel, title, body,
       deep_link, payload, priority, status, dedupe_key)
    SELECT src.mgr_employee_id,
           src.mgr_profile_id,
           (SELECT t.id FROM public.notification_templates t
             WHERE t.company_id = src.company_id
               AND t.code = 'NO_SHOW_ALERT'
               AND t.channel = 'in_app'
               AND t.is_active AND t.deleted_at IS NULL
             LIMIT 1),
           'NO_SHOW_ALERT',
           'in_app'::public.notification_channel,
           'No-show: ' || src.display_name,
           src.display_name || ' (' || src.employee_code || ') has not punched in for the '
             || COALESCE(src.shift_label, 'rostered') || ' shift on '
             || to_char(src.ist_date, 'DD-Mon-YYYY') || '.',
           '/team/attendance?date=' || to_char(src.ist_date, 'YYYY-MM-DD'),
           jsonb_build_object(
             'attendance_day_id', src.day_id,
             'employee_id',       src.subject_employee_id,
             'employee_code',     src.employee_code,
             'employee_name',     src.display_name,
             'date',              to_char(src.ist_date, 'YYYY-MM-DD'),
             'shift_label',       src.shift_label),
           'high',
           'queued'::public.notification_status,
           'NO_SHOW_ALERT:' || src.day_id::text || ':mgr'
      FROM src
     WHERE src.mgr_profile_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.notifications n
          WHERE n.dedupe_key = 'NO_SHOW_ALERT:' || src.day_id::text || ':mgr')
    RETURNING 1
  `;
  return (rows as unknown as unknown[]).length;
}

/**
 * The same alert to every live admin/HR profile, but ONLY for employees with no
 * reporting manager — otherwise a 60-person no-show morning becomes hundreds of
 * admin rows. The dedupe key carries the recipient, so each admin gets one.
 */
async function enqueueNoShowToHr(tx: Sql, businessDate: string, limit: number): Promise<number> {
  const rows = await tx`
    WITH src AS (
      SELECT ad.id AS day_id, ad.ist_date, e.id AS subject_employee_id, e.company_id,
             e.employee_code, e.display_name, sh.name AS shift_label
        FROM public.attendance_days ad
        JOIN public.employees e ON e.id = ad.employee_id AND e.deleted_at IS NULL
        LEFT JOIN public.shifts sh ON sh.id = ad.shift_id
       WHERE ad.ist_date = ${businessDate}::date
         AND ad.status = 'absent'
         AND ad.is_working_day
         AND ad.punch_count = 0
         AND (e.reporting_manager_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM public.employees m
                              JOIN public.profiles mp ON mp.id = m.profile_id AND mp.is_active
                             WHERE m.id = e.reporting_manager_id AND m.deleted_at IS NULL))
       ORDER BY e.employee_code
       LIMIT ${limit}
    ),
    hr AS (
      SELECT DISTINCT p.id AS profile_id, he.id AS hr_employee_id
        FROM public.user_roles ur
        JOIN public.profiles p ON p.id = ur.user_id AND p.is_active
        LEFT JOIN public.employees he ON he.profile_id = p.id AND he.deleted_at IS NULL
       WHERE ur.revoked_at IS NULL
         AND ur.role IN ('admin', 'super_admin')
    )
    INSERT INTO public.notifications
      (employee_id, profile_id, template_id, event_code, channel, title, body,
       deep_link, payload, priority, status, dedupe_key)
    SELECT hr.hr_employee_id,
           hr.profile_id,
           (SELECT t.id FROM public.notification_templates t
             WHERE t.company_id = src.company_id AND t.code = 'NO_SHOW_ALERT'
               AND t.channel = 'in_app' AND t.is_active AND t.deleted_at IS NULL
             LIMIT 1),
           'NO_SHOW_ALERT',
           'in_app'::public.notification_channel,
           'No-show (unassigned): ' || src.display_name,
           src.display_name || ' (' || src.employee_code || ') has no reporting manager and did not '
             || 'punch in for the ' || COALESCE(src.shift_label, 'rostered') || ' shift on '
             || to_char(src.ist_date, 'DD-Mon-YYYY') || '.',
           '/admin/attendance/exceptions?date=' || to_char(src.ist_date, 'YYYY-MM-DD'),
           jsonb_build_object(
             'attendance_day_id', src.day_id,
             'employee_id',       src.subject_employee_id,
             'employee_code',     src.employee_code,
             'employee_name',     src.display_name,
             'date',              to_char(src.ist_date, 'YYYY-MM-DD'),
             'shift_label',       src.shift_label,
             'reason',            'no_reporting_manager'),
           'high',
           'queued'::public.notification_status,
           'NO_SHOW_ALERT:' || src.day_id::text || ':hr:' || hr.profile_id::text
      FROM src CROSS JOIN hr
     WHERE NOT EXISTS (
       SELECT 1 FROM public.notifications n
        WHERE n.dedupe_key = 'NO_SHOW_ALERT:' || src.day_id::text || ':hr:' || hr.profile_id::text)
    RETURNING 1
  `;
  return (rows as unknown as unknown[]).length;
}

/**
 * `PUNCH_MISSING_OUT`, employee copy, with the one-tap regularize deep link §8.9
 * asks for.
 *
 * `no_out_punch` is set by the engine when a day has punches but no last punch
 * (018 step 8). The extra `shift_end_at < now()` guard is deliberate: the 22:00
 * IST run would otherwise nag every evening-shift employee who is still at work.
 * A NULL `shift_end_at` (no resolved shift) is included — there is no shift end to
 * wait for.
 */
async function enqueueMissingOut(
  tx: Sql,
  fromDate: string,
  toDate: string,
  limit: number,
): Promise<{ employee: number; manager: number }> {
  const employeeRows = await tx`
    WITH src AS (
      SELECT ad.id AS day_id, ad.ist_date, ad.first_in_at,
             e.id AS employee_id, e.company_id, e.employee_code, e.display_name,
             p.id AS profile_id
        FROM public.attendance_days ad
        JOIN public.employees e ON e.id = ad.employee_id AND e.deleted_at IS NULL
        LEFT JOIN public.profiles p ON p.id = e.profile_id AND p.is_active
       WHERE ad.ist_date BETWEEN ${fromDate}::date AND ${toDate}::date
         AND 'no_out_punch' = ANY (ad.anomaly_flags)
         AND NOT ad.is_locked
         AND (ad.shift_end_at IS NULL OR ad.shift_end_at < now())
       ORDER BY ad.ist_date DESC, e.employee_code
       LIMIT ${limit}
    )
    INSERT INTO public.notifications
      (employee_id, profile_id, template_id, event_code, channel, title, body,
       deep_link, payload, priority, status, dedupe_key)
    SELECT src.employee_id,
           src.profile_id,
           (SELECT t.id FROM public.notification_templates t
             WHERE t.company_id = src.company_id AND t.code = 'PUNCH_MISSING_OUT'
               AND t.channel = 'in_app' AND t.is_active AND t.deleted_at IS NULL
             LIMIT 1),
           'PUNCH_MISSING_OUT',
           'in_app'::public.notification_channel,
           'Missing out-punch for ' || to_char(src.ist_date, 'DD-Mon'),
           'We have no out-punch for ' || to_char(src.ist_date, 'DD-Mon-YYYY')
             || '. Regularize it so your hours and paid days are correct.',
           '/me/regularizations/new?date=' || to_char(src.ist_date, 'YYYY-MM-DD'),
           jsonb_build_object(
             'attendance_day_id', src.day_id,
             'date',              to_char(src.ist_date, 'YYYY-MM-DD'),
             'first_in_at',       src.first_in_at,
             'anomaly',           'no_out_punch'),
           'normal',
           'queued'::public.notification_status,
           'PUNCH_MISSING_OUT:' || src.day_id::text || ':emp'
      FROM src
     WHERE src.profile_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.notifications n
          WHERE n.dedupe_key = 'PUNCH_MISSING_OUT:' || src.day_id::text || ':emp')
    RETURNING 1
  `;

  const managerRows = await tx`
    WITH src AS (
      SELECT ad.id AS day_id, ad.ist_date,
             e.id AS subject_employee_id, e.company_id, e.employee_code, e.display_name,
             m.id AS mgr_employee_id, mp.id AS mgr_profile_id
        FROM public.attendance_days ad
        JOIN public.employees e ON e.id = ad.employee_id AND e.deleted_at IS NULL
        JOIN public.employees m ON m.id = e.reporting_manager_id AND m.deleted_at IS NULL
        JOIN public.profiles mp ON mp.id = m.profile_id AND mp.is_active
       WHERE ad.ist_date BETWEEN ${fromDate}::date AND ${toDate}::date
         AND 'no_out_punch' = ANY (ad.anomaly_flags)
         AND NOT ad.is_locked
         AND (ad.shift_end_at IS NULL OR ad.shift_end_at < now())
       ORDER BY ad.ist_date DESC, e.employee_code
       LIMIT ${limit}
    )
    INSERT INTO public.notifications
      (employee_id, profile_id, template_id, event_code, channel, title, body,
       deep_link, payload, priority, status, dedupe_key)
    SELECT src.mgr_employee_id,
           src.mgr_profile_id,
           (SELECT t.id FROM public.notification_templates t
             WHERE t.company_id = src.company_id AND t.code = 'PUNCH_MISSING_OUT'
               AND t.channel = 'in_app' AND t.is_active AND t.deleted_at IS NULL
             LIMIT 1),
           'PUNCH_MISSING_OUT',
           'in_app'::public.notification_channel,
           'Missing out-punch: ' || src.display_name,
           'No out-punch was recorded for ' || src.display_name || ' ('
             || src.employee_code || ') on ' || to_char(src.ist_date, 'DD-Mon-YYYY')
             || '. A regularization will come to you for approval.',
           '/team/attendance?date=' || to_char(src.ist_date, 'YYYY-MM-DD'),
           jsonb_build_object(
             'attendance_day_id', src.day_id,
             'employee_id',       src.subject_employee_id,
             'employee_code',     src.employee_code,
             'employee_name',     src.display_name,
             'date',              to_char(src.ist_date, 'YYYY-MM-DD'),
             'anomaly',           'no_out_punch'),
           'normal',
           'queued'::public.notification_status,
           'PUNCH_MISSING_OUT:' || src.day_id::text || ':mgr'
      FROM src
     WHERE NOT EXISTS (
       SELECT 1 FROM public.notifications n
        WHERE n.dedupe_key = 'PUNCH_MISSING_OUT:' || src.day_id::text || ':mgr')
    RETURNING 1
  `;

  return {
    employee: (employeeRows as unknown as unknown[]).length,
    manager: (managerRows as unknown as unknown[]).length,
  };
}

/**
 * One `system_health` row per close. `component`/`status` are free text under a
 * CHECK (`ok|degraded|down|unknown`), so the exception count is the metric and the
 * full breakdown goes in `detail`.
 */
async function writeHealth(
  tx: Sql,
  businessDate: string,
  exceptions: ExceptionSummary,
  absentsMarked: number,
): Promise<void> {
  const openExceptions = exceptions.pending + exceptions.no_out_punch +
    exceptions.span_over_16h + exceptions.punch_outside_shift + exceptions.other_anomalies;
  await tx`
    INSERT INTO public.system_health
      (component, status, metric_name, metric_value, threshold, detail, message)
    VALUES (
      'attendance_close',
      ${openExceptions > EXCEPTION_ALERT_THRESHOLD ? "degraded" : "ok"}::text,
      'exception_days',
      ${openExceptions}::numeric,
      ${EXCEPTION_ALERT_THRESHOLD}::numeric,
      ${JSON.stringify({ business_date: businessDate, absents_marked: absentsMarked, ...exceptions })}::jsonb,
      ${`Attendance close for ${businessDate}: ${openExceptions} day(s) need attention.`}::text
    )
  `;
}

interface MatviewOutcome {
  refreshed: string[];
  failed: { matview: string; message: string }[];
}

/**
 * `analytics.refresh_matview` (036 §7) refreshes CONCURRENTLY and validates the
 * name against its own allowlist. Run on the POOL, one statement each, outside the
 * business transaction: a refresh takes seconds and must not hold the notification
 * writes open, and one failing view must not roll back the close.
 */
async function refreshMatviews(
  client: Sql,
  names: readonly string[],
  log: Logger,
): Promise<MatviewOutcome> {
  const outcome: MatviewOutcome = { refreshed: [], failed: [] };
  for (const name of names) {
    try {
      await client`SELECT analytics.refresh_matview(${name}::text)`;
      outcome.refreshed.push(name);
    } catch (err) {
      // The driver's message can carry SQL and identifiers, so it goes to the log
      // (redacted there) and never into the response body.
      log.error("matview refresh failed", { matview: name, err });
      outcome.failed.push({ matview: name, message: "Refresh failed; see the job log." });
    }
  }
  return outcome;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ──────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const url = new URL(req.url);
  const instance = url.pathname;

  let status = 500;
  let idempotencyKey: string | null = null;
  let jobRunId: string | null = null;
  let jobCode = JOB_CODE_BY_TASK.close;
  let responseBody: unknown = null;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model C) ─────────────────────────────────────────────
    rejectBrowserOrigin(req);
    const cronAuth = verifyCron(req);
    log.info("cron authenticated", { via: cronAuth.via });

    // ── STEP 5 · Authority ──────────────────────────────────────────────────
    // A scheduled job holds no `role_capabilities` row: presenting the cron
    // secret (or the service-role key), compared in constant time, IS the
    // authority. There is nothing further to derive.

    const rawBody = await readRawBody(req, { maxBytes: 8 * 1024, requireJsonContentType: false });
    const decoded = rawBody === "" ? {} : decodeJson(rawBody);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    // A stuck scheduler must not turn into a notification storm.
    await enforce(RATE_LIMITS.heavyJob, limitKey(FN_NAME, "cron"), "CLOSE_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const body = parse(CloseBody, decoded, "close request");
    const task = normaliseTask(body.task ?? url.searchParams.get("task") ?? undefined);
    jobCode = body.job_code ?? JOB_CODE_BY_TASK[task];

    const today = istToday();
    const yesterday = addDays(today, -1);
    const businessDate = body.business_date ?? yesterday;
    const age = daysBetween(businessDate, today);
    if (age < 0) {
      throw unprocessable(
        [{
          pointer: "/business_date",
          code: "too_big",
          detail: "A future business date has no attendance rows to close.",
        }],
        "The business date must be today or earlier.",
        "BUSINESS_DATE_IN_FUTURE",
      );
    }
    if (age > MAX_BACKDATE_DAYS) {
      throw unprocessable(
        [{
          pointer: "/business_date",
          code: "too_small",
          detail: `Dates older than ${MAX_BACKDATE_DAYS} days are reprocessed with ` +
            `attendance-recompute, which carries the lock handling and the audit trail.`,
        }],
        "That business date is too old for the daily close.",
        "BUSINESS_DATE_TOO_OLD",
      );
    }

    const runAbsents = task === "close" || task === "absents";
    const runExceptions = task === "close" || task === "exceptions";
    const runNoShow = task === "close";
    const runMissingOut = task === "close" || task === "missing_out";
    const runMatviews = body.refresh_matviews ?? (task === "close" || task === "matviews");

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // Keyed to the task + business date: a `pg_net` retry of the same nightly run
    // replays the stored answer instead of re-walking the roll. `app.job_begin`
    // below is the concurrency guard; this one covers the retry.
    if (!body.dry_run) {
      idempotencyKey = idempotencyKeyFrom(req) ?? `${FN_NAME}:${task}:${businessDate}`;
      const hash = await requestHash(FN_NAME, rawBody, `${task}:${businessDate}`);
      const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: hash });
      if (claimed.state === "replay") {
        status = claimed.status;
        log.info("idempotent replay", { key: idempotencyKey });
        return replayResponse(claimed, { ...cors, "x-request-id": requestId });
      }
    }

    const pool = sql();

    // Double-run guard (§9): a second concurrent run is a 200, not an error.
    if (!body.dry_run) {
      const begun = await pool<{ id: string | null }[]>`
        SELECT app.job_begin(${jobCode}, ${`${FN_NAME}:${task}`}) AS id
      `;
      jobRunId = firstRow(begun)?.id ?? null;
      if (jobRunId === null) {
        status = 200;
        responseBody = { skipped: "already_running", job_code: jobCode, task, requestId };
        if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
        return ok(responseBody, { status, headers: cors, requestId });
      }
    }

    const ctx: RequestContext = {
      actorId: null, // a scheduled job is not a person
      actorRole: null,
      source: "cron",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: null,
      reason: `${FN_NAME}: ${task} for IST business date ${businessDate}`,
    };

    // `mark_absent_days()` reads `util.ist_today() - 1` itself, so it can only
    // ever close yesterday. Say so rather than silently closing the wrong day.
    const absentsSkippedReason = runAbsents && businessDate !== yesterday
      ? "mark_absent_days() only acts on yesterday IST; run attendance-recompute for other dates"
      : null;

    let absentsMarked = 0;
    let exceptions: ExceptionSummary = { ...EMPTY_EXCEPTIONS };
    let noShow = 0;
    let noShowHr = 0;
    let missingOut = { employee: 0, manager: 0 };

    // ── STEP 9/10 · One transaction: context, engine, notifications, audit ───
    // `mark_absent_days` re-runs `compute_attendance_day`, whose writes fire the
    // audit triggers — those read `app.*`, which only exists inside this txn.
    if (body.dry_run) {
      exceptions = await readExceptions(pool, businessDate);
    } else {
      await withContext(ctx, async (tx) => {
        if (runAbsents && absentsSkippedReason === null) {
          const marked = await tx<{ n: number | string | null }[]>`
            SELECT public.mark_absent_days() AS n
          `;
          absentsMarked = asCount(firstRow(marked)?.n);
        }

        // Read AFTER the engine ran, so the summary describes the closed day.
        if (runExceptions || runAbsents) exceptions = await readExceptions(tx, businessDate);

        if (runNoShow) {
          noShow = await enqueueNoShow(tx, businessDate, body.limit);
          noShowHr = await enqueueNoShowToHr(tx, businessDate, body.limit);
        }
        if (runMissingOut) {
          // The 22:00 run must also catch the shift that ended before midnight
          // yesterday, so the window is the business date and the day before it.
          const from = addDays(businessDate, -MISSING_OUT_LOOKBACK_DAYS);
          const to = task === "missing_out" ? today : businessDate;
          missingOut = await enqueueMissingOut(tx, from, to, body.limit);
        }
        if (runExceptions) await writeHealth(tx, businessDate, exceptions, absentsMarked);
      });
    }

    // Outside the transaction, on purpose (see `refreshMatviews`).
    const matviews: MatviewOutcome = runMatviews && !body.dry_run
      ? await refreshMatviews(pool, CLOSE_MATVIEWS, log)
      : { refreshed: [], failed: [] };

    const notificationsQueued = noShow + noShowHr + missingOut.employee + missingOut.manager;
    const stats = {
      task,
      business_date: businessDate,
      absents_marked: absentsMarked,
      absents_skipped: absentsSkippedReason,
      exceptions,
      notifications: {
        no_show_manager: noShow,
        no_show_hr: noShowHr,
        missing_out_employee: missingOut.employee,
        missing_out_manager: missingOut.manager,
        total: notificationsQueued,
      },
      matviews,
    };

    if (jobRunId !== null) {
      await withContext(ctx, async (tx) => {
        await tx`
          SELECT app.job_end(
                   ${jobRunId}::uuid,
                   ${matviews.failed.length === 0 ? "succeeded" : "failed"}::public.job_run_status,
                   ${absentsMarked + notificationsQueued}::integer,
                   ${matviews.failed.length}::integer,
                   ${JSON.stringify(stats)}::jsonb,
                   ${matviews.failed.length === 0 ? null : "one or more analytics matviews failed to refresh"}::text)
        `;
        // `attendance_days` field-level rows are written by its own audit trigger;
        // `notifications` is not trigger-audited at all (038). This is how the
        // close itself appears on the hash chain.
        await auditJobRun(tx, ctx, {
          jobCode,
          runId: jobRunId,
          outcome: matviews.failed.length === 0 ? "succeeded" : "partial",
          stats,
        });
      });
    }

    status = 200;
    responseBody = { job_code: jobCode, job_run_id: jobRunId, dry_run: body.dry_run, ...stats, requestId };

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
    log.info("attendance close finished", {
      task,
      business_date: businessDate,
      absents_marked: absentsMarked,
      notifications: notificationsQueued,
      matviews_refreshed: matviews.refreshed.length,
    });
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
      // Close the run or its lock key is held forever and every later run skips.
      try {
        await sql()`
          SELECT app.job_end(${jobRunId}::uuid, 'failed'::public.job_run_status, NULL, NULL, NULL,
                             ${`${problem.code ?? "ERROR"}: ${problem.problem.title}`}::text)
        `;
      } catch (jobErr) {
        log.warn("could not close job run", { err: jobErr });
      }
    }

    if (problem.isServerFault) log.error("attendance close failed", { err, code: problem.code });
    else log.warn("attendance close refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey, job_run_id: jobRunId, job_code: jobCode });
  }
});

/** Exported so `supabase/tests` asserts against one schema. */
export { CloseBody, CLOSE_MATVIEWS, normaliseTask };
