/**
 * cron-compoff-expiry — catalogue #24, auth model **C** (cron secret,
 * constant-time, or a service-role bearer for a manual run).
 *
 * The 01:30 IST comp-off job, in two halves that belong together:
 *
 *   1. EXPIRE — `public.expire_comp_off()` (migration 019 §14). For every earned
 *      credit whose `expires_on` has passed and which still has days left, it
 *      writes the mirrored pair the ledger design demands: a negative `expired`
 *      row in `public.comp_off_ledger` (idempotent through
 *      `uq_col__expired_once`, a partial unique index on `source_comp_off_id`)
 *      and a `comp_off_expiry` row in `public.leave_ledger`, then sets the credit
 *      to `status = 'expired', days_remaining = 0`. The ledger's own statement
 *      trigger recomputes `leave_balances` (019 §8).
 *
 *   2. NOTIFY — `COMP_OFF_EXPIRING` at −14 / −7 / −1 days (§8.3, §8.9). The
 *      migration's own comment says this half is the caller's job: "The −14/−7/−1
 *      day COMP_OFF_EXPIRING notifications are enqueued by the cron/edge layer …
 *      this function performs only the ledger work."
 *
 * WHY THE LEDGER ARITHMETIC IS NOT REIMPLEMENTED HERE: `expire_comp_off()` is the
 * only writer that knows how to pair a `comp_off_ledger` expiry with its
 * `leave_ledger` mirror and to find the company's single `is_comp_off` leave type.
 * `comp_off_ledger` and `leave_ledger` are both append-only (REVOKE + guard
 * trigger), so a second implementation could not correct its own mistakes.
 *
 * ORDER: notices FIRST, then the expiry sweep. A credit expiring at midnight
 * tonight is `expires_on = today`, which is −0 days and NOT in the notice windows,
 * and `expire_comp_off()` only touches `expires_on < today`. Running the notices
 * first therefore cannot notify about something this run has just expired.
 *
 * OVERLAP WITH `cron-expiry-reminders?classes=compoff` IS SAFE AND DELIBERATE:
 * both use the dedupe key `COMP_OFF_EXPIRING:<comp_off_ledger_id>:d<days>`, so
 * whichever runs first enqueues and the other adds nothing. Migration 041
 * schedules the notices at 09:15 IST via that function and the ledger sweep at
 * 01:30 IST as a SQL job; this endpoint is the one door that does both, for a
 * manual catch-up or if the schedule is consolidated later.
 *
 * ENQUEUE ONLY — `notification-dispatch` (#14) owns the email fan-out, per-user
 * preferences and quiet hours.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem, unprocessable } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { istToday } from "../_shared/datetime.ts";
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

const FN_NAME = "cron-compoff-expiry";
const DEFAULT_JOB_CODE = "comp_off_expiry";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;
const EVENT_CODE = "COMP_OFF_EXPIRING";

/** §8.3 / §8.9: notify at fourteen, seven and one day(s) before `expires_on`. */
const NOTICE_WINDOWS = [14, 7, 1] as const;
/** Employees a notice can reach. An exited employee's comp-off is a settlement line. */
const IN_SERVICE_STATUSES = [
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "on_long_leave",
  "suspended",
] as const;
const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 10_000;

const CompOffBody = z
  .object({
    /** `cron_jobs.code`, for the `job_runs` row and the overlap lock key. */
    job_code: z.string().trim().min(2).max(64).optional(),
    /**
     * IST date the −14/−7/−1 windows are measured from. Absent = today IST.
     * It does NOT move the expiry sweep: `expire_comp_off()` reads
     * `util.ist_today()` itself and can only ever act on today.
     */
    as_of: common.isoDate.optional(),
    /** Resolve and report, write nothing. */
    dry_run: z.boolean().default(false),
    /** Ledger sweep only. */
    skip_notices: z.boolean().default(false),
    /** Notices only — useful when the 01:30 SQL job already swept the ledger. */
    skip_expiry: z.boolean().default(false),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

interface NoticeRow {
  ledger_id: string;
  employee_id: string;
  company_id: string;
  employee_code: string;
  display_name: string;
  profile_id: string | null;
  expires_on: string;
  earned_on: string | null;
  days_until: unknown;
  days_left: string;
}

function asInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function asNum(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function ddMon(isoDate: string): string {
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ] as const;
  const month = MONTHS[Number(isoDate.slice(5, 7)) - 1] ?? isoDate.slice(5, 7);
  return `${isoDate.slice(8, 10)}-${month}-${isoDate.slice(0, 4)}`;
}

function whenPhrase(daysUntil: number): string {
  if (daysUntil === 1) return "tomorrow";
  return `in ${daysUntil} days`;
}

/**
 * Credits sitting exactly −14 / −7 / −1 days from expiry, with days actually left.
 *
 * `COALESCE(days_remaining, days)` is the live figure: `days_remaining` is NULL on
 * a credit nothing has been drawn against yet (`consume_comp_off`, 019 §11, sets
 * it thereafter), and `ck_col__remaining` keeps it non-negative.
 */
async function noticeCandidates(client: Sql, asOf: string, limit: number): Promise<NoticeRow[]> {
  const rows = await client`
    SELECT col.id                                       AS ledger_id,
           e.id                                         AS employee_id,
           e.company_id                                 AS company_id,
           e.employee_code                              AS employee_code,
           e.display_name                               AS display_name,
           p.id                                         AS profile_id,
           col.expires_on::text                         AS expires_on,
           col.earned_on_date::text                     AS earned_on,
           (col.expires_on - ${asOf}::date)             AS days_until,
           COALESCE(col.days_remaining, col.days)::text  AS days_left
      FROM public.comp_off_ledger col
      JOIN public.employees e ON e.id = col.employee_id AND e.deleted_at IS NULL
      LEFT JOIN public.profiles p ON p.id = e.profile_id AND p.is_active
     WHERE col.entry_type = 'earned'
       AND col.status IN ('available', 'partially_used')
       AND col.expires_on IS NOT NULL
       AND COALESCE(col.days_remaining, col.days) > 0
       AND e.employment_status = ANY (${[...IN_SERVICE_STATUSES]}::public.employment_status[])
       AND (col.expires_on - ${asOf}::date) = ANY (${[...NOTICE_WINDOWS]}::integer[])
     ORDER BY col.expires_on, e.employee_code
     LIMIT ${limit}
  `;
  return rows as unknown as NoticeRow[];
}

/**
 * One `in_app` row per credit, to the employee who earned it.
 *
 * `uq_notifications__dedupe` exists per PARTITION, not on the partitioned parent
 * (migration 027 table comment), so `ON CONFLICT` has no index to infer and the
 * guard is an explicit `NOT EXISTS`. Safe under the `app.job_begin` lock; a losing
 * race raises 23505 and aborts the batch rather than notifying twice, which is the
 * correct failure direction.
 */
async function enqueueNotices(tx: Sql, rows: readonly NoticeRow[], cap: number): Promise<number> {
  let queued = 0;
  for (const row of rows) {
    if (queued >= cap) break;
    if (row.profile_id === null) continue; // no login yet — nothing to notify into
    const daysUntil = asInt(row.days_until);
    const daysLeft = asNum(row.days_left);
    const dedupe = `${EVENT_CODE}:${row.ledger_id}:d${daysUntil}`;
    const earnedPhrase = row.earned_on === null ? "" : ` earned on ${ddMon(row.earned_on)}`;
    const inserted = await tx`
      INSERT INTO public.notifications
        (employee_id, profile_id, template_id, event_code, channel, title, body,
         deep_link, payload, priority, status, dedupe_key)
      SELECT ${row.employee_id}::uuid,
             ${row.profile_id}::uuid,
             (SELECT t.id FROM public.notification_templates t
               WHERE t.company_id = ${row.company_id}::uuid
                 AND t.code = ${EVENT_CODE}
                 AND t.channel = 'in_app'
                 AND t.is_active AND t.deleted_at IS NULL
               LIMIT 1),
             ${EVENT_CODE}::text,
             'in_app'::public.notification_channel,
             ${`${daysLeft} comp-off day(s) expire ${whenPhrase(daysUntil)}`}::text,
             ${
      `${daysLeft} comp-off day(s)${earnedPhrase} expire on ${ddMon(row.expires_on)}. ` +
      `Apply for them before that date or they lapse — expired comp-off cannot be restored.`
    }::text,
             ${"/me/leave/new?type=comp_off"}::text,
             ${
      JSON.stringify({
        comp_off_ledger_id: row.ledger_id,
        employee_id: row.employee_id,
        employee_code: row.employee_code,
        days_remaining: daysLeft,
        expires_on: row.expires_on,
        days_until: daysUntil,
      })
    }::jsonb,
             ${daysUntil <= 1 ? "high" : "normal"}::text,
             'queued'::public.notification_status,
             ${dedupe}::text
       WHERE NOT EXISTS (
         SELECT 1 FROM public.notifications n WHERE n.dedupe_key = ${dedupe}::text)
      RETURNING 1
    `;
    queued += (inserted as unknown as unknown[]).length;
  }
  return queued;
}

/** What the sweep WOULD expire — for `dry_run`, and for the run report. */
async function expiryCandidates(client: Sql): Promise<{ credits: number; days: number }> {
  const rows = await client<Record<string, unknown>[]>`
    SELECT count(*)                                                    AS credits,
           COALESCE(SUM(COALESCE(col.days_remaining, col.days)), 0)::text AS days
      FROM public.comp_off_ledger col
     WHERE col.entry_type = 'earned'
       AND col.status IN ('available', 'partially_used')
       AND col.expires_on IS NOT NULL
       AND col.expires_on < util.ist_today()
  `;
  const row = firstRow(rows);
  return { credits: asInt(row?.credits), days: asNum(row?.days) };
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
    // A scheduled job holds no capability row: the constant-time secret IS the
    // authority.

    const rawBody = await readRawBody(req, { maxBytes: 8 * 1024, requireJsonContentType: false });
    const decoded = rawBody === "" ? {} : decodeJson(rawBody);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    await enforce(RATE_LIMITS.heavyJob, limitKey(FN_NAME, "cron"), "COMPOFF_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const body = parse(CompOffBody, decoded, "comp-off expiry request");
    jobCode = body.job_code ?? DEFAULT_JOB_CODE;

    const today = istToday();
    const asOf = body.as_of ?? today;
    if (asOf > today) {
      throw unprocessable(
        [{
          pointer: "/as_of",
          code: "too_big",
          detail: "Expiry notices are measured from today IST or earlier.",
        }],
        "`as_of` must be today IST or earlier.",
        "AS_OF_IN_FUTURE",
      );
    }

    const runNotices = !body.skip_notices;
    const runExpiry = !body.skip_expiry;

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // Keyed to the date: a `pg_net` retry replays the stored answer. The real
    // guarantees are in the database — `uq_col__expired_once` for the sweep and
    // `dedupe_key` for the notices.
    if (!body.dry_run) {
      idempotencyKey = idempotencyKeyFrom(req) ??
        `${FN_NAME}:${asOf}:${runExpiry ? "x" : "-"}${runNotices ? "n" : "-"}`;
      const hash = await requestHash(FN_NAME, rawBody, asOf);
      const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: hash });
      if (claimed.state === "replay") {
        status = claimed.status;
        log.info("idempotent replay", { key: idempotencyKey });
        return replayResponse(claimed, { ...cors, "x-request-id": requestId });
      }
    }

    const pool = sql();

    // Double-run guard (§9): a concurrent run is a 200, not an error. This matters
    // more here than elsewhere — two overlapping sweeps would race on the same
    // `FOR UPDATE` rows inside `expire_comp_off()`.
    if (!body.dry_run) {
      const begun = await pool<{ id: string | null }[]>`
        SELECT app.job_begin(${jobCode}, ${`${FN_NAME}:${jobCode}`}) AS id
      `;
      jobRunId = firstRow(begun)?.id ?? null;
      if (jobRunId === null) {
        status = 200;
        responseBody = { skipped: "already_running", job_code: jobCode, as_of: asOf, requestId };
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
      reason: `${FN_NAME}: expire comp-off and notify -14/-7/-1 as of ${asOf}`,
    };

    const pending = await expiryCandidates(pool);
    const notices = runNotices ? await noticeCandidates(pool, asOf, body.limit) : [];

    let expired = 0;
    let queued = 0;

    // ── STEP 9/10 · One transaction: context, ledger + notices, audit ────────
    // `expire_comp_off()` writes `comp_off_ledger` and `leave_ledger`, both
    // audit-triggered and reason-gated, so the `app.*` context has to be live.
    if (!body.dry_run && (runNotices || runExpiry)) {
      await withContext(ctx, async (tx) => {
        // Notices first — see the header: today's expiries are not in the windows,
        // so this cannot notify about something the sweep is about to remove.
        if (runNotices) queued = await enqueueNotices(tx, notices, body.limit);
        if (runExpiry) {
          const rows = await tx<{ n: number | string | null }[]>`
            SELECT public.expire_comp_off() AS n
          `;
          expired = asInt(firstRow(rows)?.n);
        }
      });
    }

    const stats = {
      as_of: asOf,
      dry_run: body.dry_run,
      expiry: {
        ran: runExpiry && !body.dry_run,
        credits_pending: pending.credits,
        days_pending: pending.days,
        credits_expired: expired,
      },
      notices: {
        ran: runNotices && !body.dry_run,
        windows: [...NOTICE_WINDOWS],
        candidates: notices.length,
        queued,
        limit_reached: queued >= body.limit,
      },
    };

    if (jobRunId !== null) {
      await withContext(ctx, async (tx) => {
        await tx`
          SELECT app.job_end(
                   ${jobRunId}::uuid,
                   'succeeded'::public.job_run_status,
                   ${expired + queued}::integer,
                   0::integer,
                   ${JSON.stringify(stats)}::jsonb,
                   NULL)
        `;
        // The ledger rows carry their own field-level audit trail (038);
        // `notifications` carries none at all. This row is how the JOB appears on
        // the hash chain.
        await auditJobRun(tx, ctx, { jobCode, runId: jobRunId, outcome: "succeeded", stats });
      });
    }

    status = 200;
    responseBody = { job_code: jobCode, job_run_id: jobRunId, ...stats, requestId };

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
    log.info("comp-off expiry finished", {
      as_of: asOf,
      credits_expired: expired,
      notices_queued: queued,
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
      // Release the lock key, or every later run reports `already_running`.
      try {
        await sql()`
          SELECT app.job_end(${jobRunId}::uuid, 'failed'::public.job_run_status, NULL, NULL, NULL,
                             ${`${problem.code ?? "ERROR"}: ${problem.problem.title}`}::text)
        `;
      } catch (jobErr) {
        log.warn("could not close job run", { err: jobErr });
      }
    }

    if (problem.isServerFault) log.error("comp-off expiry failed", { err, code: problem.code });
    else log.warn("comp-off expiry refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey, job_run_id: jobRunId, job_code: jobCode });
  }
});

/** Exported so `supabase/tests` asserts against one schema and one window set. */
export { CompOffBody, EVENT_CODE, NOTICE_WINDOWS };
