/**
 * cron-payroll-prechecks — catalogue #25, auth model **C** (cron secret, constant
 * time, or a service-role bearer for a manual run).
 *
 * The cutoff−2 readiness scorecard. Two days before `pay_periods.
 * attendance_cutoff_date` the attendance data still belongs to the humans who
 * can fix it; after the lock it belongs to payroll, and every unfixed item turns
 * into a wrong payslip. This job answers one question — *is the period fit to
 * lock?* — and says exactly whose days are in the way.
 *
 * FIVE CHECKS (spec-architecture §4 #25; the first four are the named set):
 *   1. `missing_punch_days`        working days with punches but no OUT scan, or
 *                                 flagged `no_out_punch` / `single_punch_only`,
 *                                 and NOT already resolved by an approved or
 *                                 applied regularization. "Unresolved" is the
 *                                 whole point: a day someone has already fixed
 *                                 is not a blocker.
 *   2. `pending_regularizations`   `status IN ('draft','pending')` inside the
 *                                 period — an approval queue nobody drained.
 *   3. `unapproved_ot_days`        `overtime_minutes > approved_overtime_minutes`
 *                                 on an unlocked day. Unapproved OT is computed
 *                                 but unpaid (migration 017), so this is money
 *                                 the employee expects and will not receive.
 *   4. `bank_missing` / `bank_unverified`
 *                                 payable employees on `payment_mode =
 *                                 'bank_transfer'` with no active
 *                                 `employee_bank_accounts` row, or one that has
 *                                 never been verified (penny drop / cheque /
 *                                 passbook). A bank advice built on these fails
 *                                 at the bank, after the run is closed.
 *   5. `unprocessed_days`          `status = 'pending'` on a working day: the
 *                                 engine has no verdict, so Paid Days is not yet
 *                                 a number at all. Included because it blocks the
 *                                 lock harder than anything above it.
 *
 * READINESS, honestly computed (spec-architecture §8 CI invariants):
 *   `ready_pct` = clean payable employees × 100 / payable employees, and it is
 *   `null` — never 0, never 100 — when there are no payable employees. The
 *   denominator is the exact series the scorecard lists, so the UI's percentage
 *   and this number cannot disagree. No weighted "score" is invented: a made-up
 *   index is exactly the class of defect the invariants exist to stop.
 *
 * WHAT IT WRITES
 *   - one `public.system_health` row per check (`component = 'payroll_precheck.*'`)
 *     so the admin console and the alerting path both see the same numbers;
 *   - one queued in-app `public.notifications` row per active admin /
 *     super_admin, which `notification-dispatch` fans out to email under the
 *     recipient's own preferences — this function never touches Resend;
 *   - `public.job_runs` via `app.job_begin` / `app.job_end`, plus one `job_run`
 *     row on the audit hash chain (`auditJobRun`).
 *
 * SCHEDULING (DB gap, see the handover note): migration 041 registers
 * `payroll_reminder` — which posts to `communication-send`, not here — and has no
 * `cron_jobs` row or `pg_cron` entry for `cron-payroll-prechecks`. Until one
 * exists this runs manually or from an external scheduler; daily at 09:00 IST is
 * the intended cadence, and the cutoff−2 guard below makes any other day a
 * no-op 200 rather than noise.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { addDays, istToday, nowIso } from "../_shared/datetime.ts";
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

const FN_NAME = "cron-payroll-prechecks";
const DEFAULT_JOB_CODE = "payroll_prechecks";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** How many days before `attendance_cutoff_date` this scorecard is due. */
const CUTOFF_LEAD_DAYS = 2;

/** A regularization older than this and still undecided is called out separately. */
const STALE_REGULARIZATION_HOURS = 48;

/** Employees whose pay this period is being prepared. Mirrors `v_exception_queue` §9.4. */
const PAYABLE_STATUSES = ["active", "confirmed", "on_probation", "on_notice"] as const;

/** Named in the notification and the response; the UI route that fixes these items. */
const DEEP_LINK = "/payroll";

/** Cap on the per-employee blocker list carried in the response and the payload. */
const MAX_BLOCKERS_REPORTED = 25;

const PrecheckBody = z
  .object({
    /** `cron_jobs.code`, for the `job_runs` row and the overlap lock key. */
    job_code: z.string().trim().min(2).max(64).optional(),
    /** Treat this IST date as "today". For a backfill or a rehearsal. */
    for_date: common.isoDate.optional(),
    /** Score this exact period regardless of the cutoff−2 guard. */
    pay_period_id: common.uuid.optional(),
    company_id: common.uuid.optional(),
    /** Score the period covering `for_date` even when today is not cutoff−2. */
    force: z.boolean().default(false),
    /** Set false to compute and return the scorecard without notifying anyone. */
    notify: z.boolean().default(true),
    /** Compute and return; write no health rows, no notifications, no job_run. */
    dry_run: z.boolean().default(false),
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

interface PeriodRow {
  id: string;
  code: string;
  name: string;
  company_id: string;
  start_date: string;
  end_date: string;
  attendance_cutoff_date: string;
  pay_date: string;
  is_open: boolean;
  attendance_locked_at: Date | string | null;
  payroll_finalised_at: Date | string | null;
}

interface EmployeeScoreRow {
  employee_id: string;
  employee_code: string;
  display_name: string;
  department_name: string | null;
  missing_punch_days: string | number;
  unprocessed_days: string | number;
  unapproved_ot_days: string | number;
  unapproved_ot_minutes: string | number;
  locked_days: string | number;
  days_in_period: string | number;
  pending_regularizations: string | number;
  stale_regularizations: string | number;
  bank_missing: boolean;
  bank_unverified: boolean;
}

/** postgres.js hydrates `count(*)`/`sum()` as strings (bigint/numeric). */
function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface CheckTotal {
  /** Rows/items found. */
  items: number;
  /** Distinct payable employees affected. */
  employees: number;
}

interface Scorecard {
  payable_employees: number;
  clean_employees: number;
  /** `[0,100]` or `null` when there is no denominator. Never a fabricated 0. */
  ready_pct: number | null;
  checks: {
    missing_punch_days: CheckTotal;
    unprocessed_days: CheckTotal;
    pending_regularizations: CheckTotal & { stale: number };
    unapproved_overtime: CheckTotal & { minutes: number };
    bank_missing: CheckTotal;
    bank_unverified: CheckTotal;
  };
  blocking_items: number;
  locked_days: number;
  days_in_period: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Pure scoring — exported for `supabase/tests`
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Percentage, clamped into `[0,100]`, `null` when the denominator is empty.
 * CI invariant (1): "no percentage anywhere outside [0,100]".
 */
export function safePct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  const pct = (part * 100) / whole;
  return Math.min(100, Math.max(0, Math.round(pct * 100) / 100));
}

/** Aggregate the per-employee rows into the scorecard. No I/O, no clock. */
export function score(rows: readonly EmployeeScoreRow[]): Scorecard {
  const zero: CheckTotal = { items: 0, employees: 0 };
  const card: Scorecard = {
    payable_employees: rows.length,
    clean_employees: 0,
    ready_pct: null,
    checks: {
      missing_punch_days: { ...zero },
      unprocessed_days: { ...zero },
      pending_regularizations: { ...zero, stale: 0 },
      unapproved_overtime: { ...zero, minutes: 0 },
      bank_missing: { ...zero },
      bank_unverified: { ...zero },
    },
    blocking_items: 0,
    locked_days: 0,
    days_in_period: 0,
  };

  for (const row of rows) {
    const missing = num(row.missing_punch_days);
    const unprocessed = num(row.unprocessed_days);
    const otDays = num(row.unapproved_ot_days);
    const otMinutes = num(row.unapproved_ot_minutes);
    const regs = num(row.pending_regularizations);
    const staleRegs = num(row.stale_regularizations);

    card.days_in_period += num(row.days_in_period);
    card.locked_days += num(row.locked_days);

    if (missing > 0) {
      card.checks.missing_punch_days.items += missing;
      card.checks.missing_punch_days.employees += 1;
    }
    if (unprocessed > 0) {
      card.checks.unprocessed_days.items += unprocessed;
      card.checks.unprocessed_days.employees += 1;
    }
    if (regs > 0) {
      card.checks.pending_regularizations.items += regs;
      card.checks.pending_regularizations.employees += 1;
      card.checks.pending_regularizations.stale += staleRegs;
    }
    if (otDays > 0) {
      card.checks.unapproved_overtime.items += otDays;
      card.checks.unapproved_overtime.employees += 1;
      card.checks.unapproved_overtime.minutes += otMinutes;
    }
    if (row.bank_missing) {
      card.checks.bank_missing.items += 1;
      card.checks.bank_missing.employees += 1;
    }
    if (row.bank_unverified) {
      card.checks.bank_unverified.items += 1;
      card.checks.bank_unverified.employees += 1;
    }

    const open = missing + unprocessed + otDays + regs +
      (row.bank_missing ? 1 : 0) + (row.bank_unverified ? 1 : 0);
    card.blocking_items += open;
    if (open === 0) card.clean_employees += 1;
  }

  card.ready_pct = safePct(card.clean_employees, card.payable_employees);
  return card;
}

/** One line per check, in the order a payroll officer should work them. */
interface HealthCheck {
  component: string;
  metric: string;
  value: number;
  /** `down` = payroll will be WRONG; `degraded` = payroll will be INCOMPLETE. */
  status: "ok" | "degraded" | "down";
  message: string;
}

export function healthChecks(card: Scorecard): HealthCheck[] {
  const c = card.checks;
  const grade = (n: number, bad: "down" | "degraded"): HealthCheck["status"] => n === 0 ? "ok" : bad;
  return [
    {
      component: "payroll_precheck.unprocessed_days",
      metric: "unprocessed_working_days",
      value: c.unprocessed_days.items,
      status: grade(c.unprocessed_days.items, "down"),
      message: `${c.unprocessed_days.items} working day(s) still pending for ${c.unprocessed_days.employees} employee(s) — Paid Days cannot be computed.`,
    },
    {
      component: "payroll_precheck.missing_punches",
      metric: "unresolved_missing_punch_days",
      value: c.missing_punch_days.items,
      status: grade(c.missing_punch_days.items, "degraded"),
      message: `${c.missing_punch_days.items} day(s) with a missing punch and no approved regularization, across ${c.missing_punch_days.employees} employee(s).`,
    },
    {
      component: "payroll_precheck.pending_regularizations",
      metric: "pending_regularizations",
      value: c.pending_regularizations.items,
      status: grade(c.pending_regularizations.items, "degraded"),
      message: `${c.pending_regularizations.items} regularization(s) awaiting a decision (${c.pending_regularizations.stale} older than ${STALE_REGULARIZATION_HOURS} h).`,
    },
    {
      component: "payroll_precheck.unapproved_overtime",
      metric: "unapproved_overtime_minutes",
      value: c.unapproved_overtime.minutes,
      status: grade(c.unapproved_overtime.items, "degraded"),
      message: `${c.unapproved_overtime.minutes} minute(s) of overtime recorded but not approved on ${c.unapproved_overtime.items} day(s) — unapproved overtime is not paid.`,
    },
    {
      component: "payroll_precheck.bank_accounts",
      metric: "bank_accounts_not_payable",
      value: c.bank_missing.items + c.bank_unverified.items,
      status: c.bank_missing.items > 0 ? "down" : grade(c.bank_unverified.items, "degraded"),
      message: `${c.bank_missing.items} employee(s) with no active bank account and ${c.bank_unverified.items} with an unverified one.`,
    },
    {
      component: "payroll_precheck.readiness",
      metric: "ready_pct",
      value: card.ready_pct ?? 0,
      status: card.blocking_items === 0 ? "ok" : card.ready_pct !== null && card.ready_pct >= 95 ? "degraded" : "down",
      message: card.ready_pct === null
        ? "No payable employees in this period."
        : `${card.clean_employees} of ${card.payable_employees} payable employees are clean (${card.ready_pct}%).`,
    },
  ];
}

/** Notification body. Plain sentences: `notification-dispatch` turns them into email. */
export function digestText(period: { code: string; name: string; cutoff: string }, card: Scorecard): string {
  const c = card.checks;
  const lines = [
    `Payroll readiness for ${period.name} (${period.code}). Attendance locks on ${period.cutoff}.`,
    "",
    card.ready_pct === null
      ? "Payable employees: none."
      : `Ready: ${card.clean_employees} of ${card.payable_employees} payable employees (${card.ready_pct}%).`,
    `Unprocessed working days: ${c.unprocessed_days.items}`,
    `Unresolved missing punches: ${c.missing_punch_days.items} day(s)`,
    `Regularizations awaiting a decision: ${c.pending_regularizations.items}`,
    `Unapproved overtime: ${c.unapproved_overtime.minutes} minute(s) on ${c.unapproved_overtime.items} day(s)`,
    `Bank accounts: ${c.bank_missing.items} missing, ${c.bank_unverified.items} unverified`,
  ];
  if (card.blocking_items === 0) {
    lines.push("", "Nothing is blocking the lock.");
  } else {
    lines.push("", `${card.blocking_items} item(s) to clear before the cutoff.`);
  }
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The period this scorecard is for.
 *
 * Explicit id wins. Otherwise the cutoff−2 rule decides — the same guard
 * migration 041 puts in the `payroll_reminder` command
 * (`attendance_cutoff_date - 2 = util.ist_today()`), evaluated here so a manual
 * run can override it. With `force`, the open period containing `forDate`.
 */
async function resolvePeriod(
  client: Sql,
  input: { forDate: string; periodId: string | null; companyId: string | null; force: boolean },
): Promise<{ period: PeriodRow | null; matchedCutoffRule: boolean }> {
  if (input.periodId !== null) {
    const rows = await client<PeriodRow[]>`
      SELECT pp.id, pp.code, pp.name, pp.company_id,
             pp.start_date::text             AS start_date,
             pp.end_date::text               AS end_date,
             pp.attendance_cutoff_date::text AS attendance_cutoff_date,
             pp.pay_date::text               AS pay_date,
             pp.is_open, pp.attendance_locked_at, pp.payroll_finalised_at
        FROM public.pay_periods pp
       WHERE pp.id = ${input.periodId}::uuid
       LIMIT 1
    `;
    const period = firstRow(rows);
    return {
      period,
      matchedCutoffRule: period !== null &&
        period.attendance_cutoff_date === addDays(input.forDate, CUTOFF_LEAD_DAYS),
    };
  }

  const dueRows = await client<PeriodRow[]>`
    SELECT pp.id, pp.code, pp.name, pp.company_id,
           pp.start_date::text             AS start_date,
           pp.end_date::text               AS end_date,
           pp.attendance_cutoff_date::text AS attendance_cutoff_date,
           pp.pay_date::text               AS pay_date,
           pp.is_open, pp.attendance_locked_at, pp.payroll_finalised_at
      FROM public.pay_periods pp
     WHERE pp.attendance_cutoff_date - ${CUTOFF_LEAD_DAYS}::integer = ${input.forDate}::date
       AND (${input.companyId}::uuid IS NULL OR pp.company_id = ${input.companyId}::uuid)
     ORDER BY pp.start_date
     LIMIT 1
  `;
  const due = firstRow(dueRows);
  if (due !== null) return { period: due, matchedCutoffRule: true };
  if (!input.force) return { period: null, matchedCutoffRule: false };

  const coveringRows = await client<PeriodRow[]>`
    SELECT pp.id, pp.code, pp.name, pp.company_id,
           pp.start_date::text             AS start_date,
           pp.end_date::text               AS end_date,
           pp.attendance_cutoff_date::text AS attendance_cutoff_date,
           pp.pay_date::text               AS pay_date,
           pp.is_open, pp.attendance_locked_at, pp.payroll_finalised_at
      FROM public.pay_periods pp
     WHERE ${input.forDate}::date BETWEEN pp.start_date AND pp.end_date
       AND (${input.companyId}::uuid IS NULL OR pp.company_id = ${input.companyId}::uuid)
     ORDER BY pp.is_open DESC, pp.start_date DESC
     LIMIT 1
  `;
  return { period: firstRow(coveringRows), matchedCutoffRule: false };
}

/**
 * ONE scan per period: every payable employee with their open items.
 *
 * Per-employee rather than five COUNT queries, because the readiness percentage
 * needs the exact series it is a percentage OF (CI invariant 2), and because
 * "who do I chase" is the only actionable output.
 *
 * `reg_resolved` is computed per day inside the CTE rather than in an aggregate
 * `FILTER` clause: a day with an approved or applied regularization has been
 * fixed by a human and must not be counted as a missing punch.
 */
async function loadEmployeeScores(
  client: Sql,
  period: { id: string; company_id: string; start_date: string; end_date: string },
): Promise<EmployeeScoreRow[]> {
  return await client<EmployeeScoreRow[]>`
    WITH payable AS (
      SELECT e.id, e.employee_code, e.display_name, e.department_id, e.payment_mode
        FROM public.employees e
       WHERE e.deleted_at IS NULL
         AND NOT e.exclude_from_payroll
         AND e.company_id = ${period.company_id}::uuid
         AND e.employment_status = ANY (${[...PAYABLE_STATUSES]}::public.employment_status[])
    ),
    day_rows AS (
      SELECT ad.employee_id,
             ad.is_locked,
             (ad.status = 'pending' AND ad.is_working_day)                  AS is_unprocessed,
             (ad.overtime_minutes > ad.approved_overtime_minutes
              AND NOT ad.is_locked)                                         AS ot_open,
             GREATEST(ad.overtime_minutes - ad.approved_overtime_minutes, 0) AS ot_minutes,
             (NOT ad.is_locked
              AND ad.is_working_day
              AND (ad.anomaly_flags && ARRAY['no_out_punch','single_punch_only']::text[]
                   OR (ad.punch_count > 0 AND ad.last_out_at IS NULL)))     AS punch_gap,
             EXISTS (
               SELECT 1
                 FROM public.attendance_regularizations ar
                WHERE ar.employee_id = ad.employee_id
                  AND ar.ist_date = ad.ist_date
                  AND ar.status IN ('approved', 'applied')
             )                                                              AS reg_resolved
        FROM public.attendance_days ad
        JOIN payable p ON p.id = ad.employee_id
       WHERE ad.ist_date BETWEEN ${period.start_date}::date AND ${period.end_date}::date
    ),
    day_agg AS (
      SELECT employee_id,
             count(*)                                                      AS days_in_period,
             count(*) FILTER (WHERE is_locked)                              AS locked_days,
             count(*) FILTER (WHERE is_unprocessed)                         AS unprocessed_days,
             count(*) FILTER (WHERE punch_gap AND NOT reg_resolved)          AS missing_punch_days,
             count(*) FILTER (WHERE ot_open)                                AS unapproved_ot_days,
             COALESCE(sum(ot_minutes) FILTER (WHERE ot_open), 0)            AS unapproved_ot_minutes
        FROM day_rows
       GROUP BY employee_id
    ),
    reg_agg AS (
      SELECT ar.employee_id,
             count(*)                                                      AS pending_regularizations,
             count(*) FILTER (
               WHERE ar.created_at < now() - make_interval(hours => ${STALE_REGULARIZATION_HOURS}::integer)
             )                                                             AS stale_regularizations
        FROM public.attendance_regularizations ar
        JOIN payable p ON p.id = ar.employee_id
       WHERE ar.ist_date BETWEEN ${period.start_date}::date AND ${period.end_date}::date
         AND ar.status IN ('draft', 'pending')
       GROUP BY ar.employee_id
    )
    SELECT p.id                                    AS employee_id,
           p.employee_code,
           p.display_name,
           d.name                                  AS department_name,
           COALESCE(da.missing_punch_days, 0)      AS missing_punch_days,
           COALESCE(da.unprocessed_days, 0)        AS unprocessed_days,
           COALESCE(da.unapproved_ot_days, 0)      AS unapproved_ot_days,
           COALESCE(da.unapproved_ot_minutes, 0)   AS unapproved_ot_minutes,
           COALESCE(da.locked_days, 0)             AS locked_days,
           COALESCE(da.days_in_period, 0)          AS days_in_period,
           COALESCE(ra.pending_regularizations, 0) AS pending_regularizations,
           COALESCE(ra.stale_regularizations, 0)   AS stale_regularizations,
           (p.payment_mode = 'bank_transfer' AND b.id IS NULL)                        AS bank_missing,
           (p.payment_mode = 'bank_transfer' AND b.id IS NOT NULL AND NOT b.is_verified) AS bank_unverified
      FROM payable p
      LEFT JOIN public.departments d ON d.id = p.department_id
      LEFT JOIN day_agg da ON da.employee_id = p.id
      LEFT JOIN reg_agg ra ON ra.employee_id = p.id
      LEFT JOIN public.employee_bank_accounts b ON b.employee_id = p.id AND b.is_active
     ORDER BY p.employee_code
  `;
}

/** The chase list: worst first, capped, no salary or bank numbers in it. */
function blockers(rows: readonly EmployeeScoreRow[]): {
  employee_code: string;
  display_name: string;
  department_name: string | null;
  open_items: number;
  missing_punch_days: number;
  unprocessed_days: number;
  pending_regularizations: number;
  unapproved_ot_minutes: number;
  bank: "ok" | "missing" | "unverified";
}[] {
  return rows
    .map((row) => {
      const missing = num(row.missing_punch_days);
      const unprocessed = num(row.unprocessed_days);
      const regs = num(row.pending_regularizations);
      const otDays = num(row.unapproved_ot_days);
      return {
        employee_code: row.employee_code,
        display_name: row.display_name,
        department_name: row.department_name,
        open_items: missing + unprocessed + regs + otDays +
          (row.bank_missing ? 1 : 0) + (row.bank_unverified ? 1 : 0),
        missing_punch_days: missing,
        unprocessed_days: unprocessed,
        pending_regularizations: regs,
        unapproved_ot_minutes: num(row.unapproved_ot_minutes),
        bank: row.bank_missing ? ("missing" as const) : row.bank_unverified ? ("unverified" as const) : ("ok" as const),
      };
    })
    .filter((row) => row.open_items > 0)
    .sort((a, b) => b.open_items - a.open_items || a.employee_code.localeCompare(b.employee_code))
    .slice(0, MAX_BLOCKERS_REPORTED);
}

// ═════════════════════════════════════════════════════════════════════════════
// Handler
// ═════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ───────────────────────────────────────────────
  // Symmetry only: step 4 refuses anything that carries an Origin.
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
    // Presenting the cron secret (compared in constant time) or the service-role
    // key IS the authority for auth model C: a scheduled job holds no capability
    // row in `role_capabilities`, so there is nothing further to resolve.

    const rawBody = await readRawBody(req, { maxBytes: 16 * 1024, requireJsonContentType: false });
    const decoded = rawBody === "" ? {} : decodeJson(rawBody);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    await enforce(RATE_LIMITS.heavyJob, limitKey(FN_NAME, "cron"), "PRECHECK_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const body = parse(PrecheckBody, decoded, "precheck request");
    jobCode = body.job_code ?? DEFAULT_JOB_CODE;
    const forDate = body.for_date ?? istToday();

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // Keyed to the IST day: a pg_net retry replays the stored scorecard instead
    // of re-notifying every admin. `app.job_begin` is the concurrency guard.
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

    // Double-run guard (spec-architecture §9): `uq_job_runs__running_lock` makes
    // a second concurrent run impossible, and the answer is a 200, not an error.
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

    // ── The cutoff−2 guard ──────────────────────────────────────────────────
    const { period, matchedCutoffRule } = await resolvePeriod(pool, {
      forDate,
      periodId: body.pay_period_id ?? null,
      companyId: body.company_id ?? null,
      force: body.force,
    });

    if (period === null) {
      status = 200;
      responseBody = {
        skipped: body.pay_period_id === undefined ? "no_period_at_cutoff_minus_2" : "pay_period_not_found",
        job_code: jobCode,
        for_date: forDate,
        pay_period_id: body.pay_period_id ?? null,
        detail: body.pay_period_id === undefined
          ? `No pay period has attendance_cutoff_date = ${addDays(forDate, CUTOFF_LEAD_DAYS)}.`
          : "No pay period with that id.",
        requestId,
      };
      if (jobRunId !== null) {
        await pool`
          SELECT app.job_end(${jobRunId}::uuid, 'skipped'::public.job_run_status, 0, 0,
                             ${JSON.stringify({ skipped: "no_period_resolved", for_date: forDate })}::jsonb,
                             NULL)
        `;
      }
      if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
      log.info("nothing due", { for_date: forDate });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    const periodInfo = {
      id: period.id,
      code: period.code,
      name: period.name,
      company_id: period.company_id,
      start_date: period.start_date,
      end_date: period.end_date,
      attendance_cutoff_date: period.attendance_cutoff_date,
      pay_date: period.pay_date,
      is_open: period.is_open,
      attendance_already_locked: period.attendance_locked_at !== null,
      matched_cutoff_rule: matchedCutoffRule,
    };

    // ── The scan ────────────────────────────────────────────────────────────
    const rows = await loadEmployeeScores(pool, {
      id: period.id,
      company_id: period.company_id,
      start_date: periodInfo.start_date,
      end_date: periodInfo.end_date,
    });
    const card = score(rows);
    const checks = healthChecks(card);
    const chaseList = blockers(rows);
    const worst = checks.some((c) => c.status === "down")
      ? "down"
      : checks.some((c) => c.status === "degraded")
      ? "degraded"
      : "ok";

    if (body.dry_run) {
      status = 200;
      responseBody = {
        dry_run: true,
        job_code: jobCode,
        for_date: forDate,
        period: periodInfo,
        scorecard: card,
        checks,
        blockers: chaseList,
        overall: worst,
        note: "nothing written",
        requestId,
      };
      log.info("scorecard computed (dry run)", { ready_pct: card.ready_pct, blocking: card.blocking_items });
      return ok(responseBody, { status, headers: cors, requestId });
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
      reason: `${FN_NAME}: cutoff-2 readiness for pay period ${period.code}`,
    };

    const title = card.blocking_items === 0
      ? `Payroll ready: ${period.name}`
      : `Payroll readiness ${card.ready_pct ?? 0}%: ${card.blocking_items} item(s) before ${periodInfo.attendance_cutoff_date}`;
    const bodyText = digestText(
      { code: period.code, name: period.name, cutoff: periodInfo.attendance_cutoff_date },
      card,
    );

    // ── STEPS 9 + 10 · one transaction: health rows, notifications, audit ────
    let notified = 0;
    await withContext(ctx, async (tx) => {
      for (const check of checks) {
        await tx`
          INSERT INTO public.system_health
            (component, status, metric_name, metric_value, threshold, detail, message)
          VALUES (
            ${check.component}::text,
            ${check.status}::text,
            ${check.metric}::text,
            ${check.value}::numeric,
            0::numeric,
            ${JSON.stringify({
          pay_period_id: period.id,
          pay_period_code: period.code,
          attendance_cutoff_date: periodInfo.attendance_cutoff_date,
          for_date: forDate,
          payable_employees: card.payable_employees,
          job_run_id: jobRunId,
          request_id: requestId,
        })}::jsonb,
            ${check.message}::text
          )
        `;
      }

      if (body.notify) {
        // One in-app row per active admin / super_admin; the email fan-out is
        // `notification-dispatch`'s job, under each recipient's preferences.
        // No ON CONFLICT: `uq_notifications__dedupe` exists per PARTITION, so an
        // inference clause on the partitioned parent would not resolve. The
        // NOT EXISTS guard is safe under the `app.job_begin` lock.
        const inserted = await tx<{ profile_id: string }[]>`
          INSERT INTO public.notifications
            (profile_id, event_code, channel, title, body, deep_link, payload, priority, status, dedupe_key)
          SELECT DISTINCT ur.user_id,
                 'PAYROLL_PRECHECK'::text,
                 'in_app'::public.notification_channel,
                 ${title}::text,
                 ${bodyText}::text,
                 ${DEEP_LINK}::text,
                 ${JSON.stringify({
          pay_period_code: period.code,
          period_name: period.name,
          attendance_cutoff_date: periodInfo.attendance_cutoff_date,
          ready_pct: card.ready_pct,
          blocking_items: card.blocking_items,
          unprocessed_days: card.checks.unprocessed_days.items,
          missing_punch_days: card.checks.missing_punch_days.items,
          pending_regularizations: card.checks.pending_regularizations.items,
          unapproved_ot_minutes: card.checks.unapproved_overtime.minutes,
          bank_missing: card.checks.bank_missing.items,
          bank_unverified: card.checks.bank_unverified.items,
        })}::jsonb,
                 ${card.blocking_items === 0 ? "normal" : "high"}::text,
                 'queued'::public.notification_status,
                 ${`payroll_precheck:${period.code}:${forDate}:`} || ur.user_id::text
            FROM public.user_roles ur
            JOIN public.profiles pr ON pr.id = ur.user_id AND pr.is_active
           WHERE ur.revoked_at IS NULL
             AND ur.role IN ('admin', 'super_admin')
             AND NOT EXISTS (
               SELECT 1 FROM public.notifications n
                WHERE n.dedupe_key = ${`payroll_precheck:${period.code}:${forDate}:`} || ur.user_id::text
             )
          RETURNING profile_id
        `;
        notified = (inserted as unknown as unknown[]).length;
      }

      await tx`
        SELECT app.job_end(
                 ${jobRunId}::uuid,
                 'succeeded'::public.job_run_status,
                 ${card.payable_employees}::integer,
                 ${card.blocking_items}::integer,
                 ${JSON.stringify({ period: periodInfo, scorecard: card, overall: worst, notified })}::jsonb,
                 NULL)
      `;
      // `job_runs`, `system_health` and `notifications` are not trigger-audited
      // (migration 038), so this is how the run appears on the hash chain.
      await auditJobRun(tx, ctx, {
        jobCode,
        runId: jobRunId,
        outcome: "succeeded",
        stats: {
          pay_period_code: period.code,
          ready_pct: card.ready_pct,
          blocking_items: card.blocking_items,
          overall: worst,
          notified,
        },
      });
    });

    status = 200;
    responseBody = {
      job_code: jobCode,
      job_run_id: jobRunId,
      for_date: forDate,
      generated_at: nowIso(),
      period: periodInfo,
      scorecard: card,
      checks,
      blockers: chaseList,
      overall: worst,
      notified,
      requestId,
    };

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
    log.info("scorecard written", {
      pay_period_code: period.code,
      ready_pct: card.ready_pct,
      blocking_items: card.blocking_items,
      notified,
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
      // Close the run so its lock key is released; otherwise every later run
      // sees "already_running" forever.
      try {
        await sql()`
          SELECT app.job_end(${jobRunId}::uuid, 'failed'::public.job_run_status, NULL, NULL, NULL,
                             ${`${problem.code ?? "ERROR"}: ${problem.problem.title}`}::text)
        `;
      } catch (jobErr) {
        log.warn("could not close job run", { err: jobErr });
      }
    }

    if (problem.isServerFault) log.error("precheck failed", { err, code: problem.code });
    else log.warn("precheck refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey, job_run_id: jobRunId, job_code: jobCode });
  }
});

/** Exported for `supabase/tests`: the contract and the pure scoring. */
export { PrecheckBody };
