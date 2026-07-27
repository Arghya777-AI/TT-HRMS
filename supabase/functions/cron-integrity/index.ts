/**
 * cron-integrity — catalogue #26, auth model **C** (cron secret, constant time,
 * or a service-role bearer for a manual run).
 *
 * The nightly "is the database still telling the truth?" job. Migration 041
 * points THREE pg_cron entries at this one function, each with a different task
 * list, so the task selector is part of the contract, not a convenience:
 *
 *   `?tasks=seal,verify_chain`   `audit_seal`           02:15 IST daily
 *   `?tasks=balance_drift`       `balance_drift_check`  02:45 IST daily
 *   `?tasks=kiosk_health`        `kiosk_health_sweep`   every 5 minutes
 *
 * Because each entry posts its own `job_code`, the `app.job_begin` lock key
 * (`cron-integrity:<job_code>`) is distinct per entry: the five-minute kiosk
 * sweep can never be told "already_running" by the nightly seal.
 *
 * TASKS
 *   `verify_chain`    `audit.verify_chain(from, to)` over the UTC window that
 *                     CONTAINS the sealed IST day. The function is documented as
 *                     windowing on `occurred_at` in UTC, and IST day D spans
 *                     `D-1 18:30Z → D 18:30Z`, so the window passed is
 *                     `[D-1, D]` — a superset, never a subset. A superset is
 *                     safe: the walk only compares each row against the one
 *                     before it, and the first row's `prev_hash` is not checked.
 *   `seal`            one `public.audit_seals` row for the previous IST day:
 *                     first/last `seq`, `row_count`, and the `row_hash` of the
 *                     day's last row as `terminal_hash`. `seal_date` is UNIQUE
 *                     and the insert is `ON CONFLICT DO NOTHING`, so a re-run
 *                     reports `already_sealed` and rewrites nothing — the seal is
 *                     evidence, and evidence is not idempotently overwritten.
 *                     `verified_at`/`verification_result` are set in the same
 *                     INSERT: `audit_seals` has UPDATE revoked from every client
 *                     role, so one statement is the whole life of the row.
 *   `orphans`         two safe sweeps (expired kiosk nonces; `job_runs` stuck in
 *                     `running` past their timeout, which otherwise wedge a job
 *                     forever behind `uq_job_runs__running_lock`) and three
 *                     REPORT-ONLY counts over the columns the model deliberately
 *                     leaves unconstrained: `attendance_days.first_in_punch_id` /
 *                     `last_out_punch_id` ("no FK across partitions", migration
 *                     017), `attendance_regularizations.created_punch_ids`, and
 *                     `import_batches.file_document_id` (its promised deferred FK
 *                     is absent from migration 049 — see the handover note).
 *                     Business rows are counted and reported, never deleted by a
 *                     cron job.
 *   `partitions`      `public.partition_maintenance()`. A missing partition does
 *                     not degrade anything — it makes every INSERT fail — so this
 *                     runs nightly rather than only on the 25th.
 *   `backup_marker`   one `public.system_health` row carrying the audit chain
 *                     head (`audit.chain_state`), the highest `audit_log.seq` and
 *                     the seal just written. That triple is what a restore drill
 *                     asserts against: if the restored database has this row and
 *                     the same chain head, the backup is provably complete to
 *                     that instant. (DB gap: there is no `backup_markers` table;
 *                     `system_health` is the closest existing home.)
 *   `kiosk_health`    active devices silent past `kiosk.offline_alert_minutes`, or
 *                     with `clock_skew_seconds` over the 120 s HMAC tolerance.
 *                     Opens a `system_health` row + a KIOSK_OFFLINE notification,
 *                     and RESOLVES open rows for devices that have come back.
 *   `balance_drift`   re-folds `leave_ledger` and compares it with the
 *                     `leave_balances` cache. Read-only on purpose: a silent
 *                     auto-repair would erase the evidence of whatever caused the
 *                     drift. Mismatches raise `system_health` rows.
 *
 * PARTIAL FAILURE IS REPORTED, NOT HIDDEN: every task runs inside its own
 * try/catch. If one fails the response is still 200 with that task's error, and
 * `job_runs.status` is set to `failed` — which is what `cron_jobs.alert_on_failure`
 * watches. A 500 would tell the operator nothing about the four tasks that worked.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem, unprocessable } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { addDays, istInstant, istParts, istToday, nowIso, toIso } from "../_shared/datetime.ts";
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
import { auditJobRun, writeAudit } from "../_shared/audit.ts";
import {
  claim,
  idempotencyKeyFrom,
  release,
  replayResponse,
  requestHash,
  store,
} from "../_shared/idempotency.ts";

const FN_NAME = "cron-integrity";
const DEFAULT_JOB_CODE = "audit_seal";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

const TASKS = [
  "verify_chain",
  "seal",
  "orphans",
  "partitions",
  "backup_marker",
  "kiosk_health",
  "balance_drift",
] as const;
type Task = typeof TASKS[number];

/** What a bare POST (no `tasks`) runs: the nightly integrity set. */
const DEFAULT_TASKS: readonly Task[] = ["verify_chain", "seal", "orphans", "partitions", "backup_marker"];

/** `verifyDevice` tolerance (auth.ts DEVICE_MAX_SKEW_SECONDS); past it a kiosk cannot punch at all. */
const MAX_DEVICE_SKEW_SECONDS = 120;

/** Fallback when `settings['kiosk.offline_alert_minutes']` is absent. */
const DEFAULT_OFFLINE_ALERT_MINUTES = 10;

/** A `running` job_run older than this (or its `cron_jobs.timeout_seconds`) is dead, not slow. */
const STALE_JOB_RUN_FALLBACK_SECONDS = 3_600;

/** Orphan scans are bounded to recent days so a nightly run has predictable cost. */
const ORPHAN_LOOKBACK_DAYS = 45;

/** Caps on how much detail a single run writes or returns. */
const MAX_DRIFT_ROWS_REPORTED = 50;
const MAX_DEVICES_REPORTED = 50;

const IntegrityBody = z
  .object({
    /** `cron_jobs.code` — names the `job_runs` row and the overlap lock key. */
    job_code: z.string().trim().min(2).max(64).optional(),
    /** Comma-separated (as migration 041 sends it) or an array. */
    tasks: z.union([z.string().trim().min(1).max(200), z.array(z.enum(TASKS)).min(1)]).optional(),
    /** The IST date to seal/verify. Defaults to yesterday IST. */
    seal_date: common.isoDate.optional(),
    /** Compute and report; write nothing at all. */
    dry_run: z.boolean().default(false),
  })
  .strict();

/** `?tasks=seal,verify_chain` or `{"tasks":["seal"]}` → a validated, de-duplicated list. */
export function resolveTasks(raw: string | readonly string[] | undefined): Task[] {
  if (raw === undefined) return [...DEFAULT_TASKS];
  const parts = (typeof raw === "string" ? raw.split(",") : raw).map((p) => p.trim().toLowerCase());
  const chosen: Task[] = [];
  const unknown: string[] = [];
  for (const part of parts) {
    if (part === "") continue;
    if (part === "all") {
      return [...TASKS];
    }
    if ((TASKS as readonly string[]).includes(part)) {
      if (!chosen.includes(part as Task)) chosen.push(part as Task);
    } else {
      unknown.push(part);
    }
  }
  if (unknown.length > 0) {
    throw unprocessable(
      unknown.map((u) => ({ pointer: "/tasks", code: "invalid_enum_value", detail: `Unknown task "${u}".` })),
      `Known tasks: ${TASKS.join(", ")}, all.`,
      "UNKNOWN_TASK",
    );
  }
  return chosen.length > 0 ? chosen : [...DEFAULT_TASKS];
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared shapes
// ═════════════════════════════════════════════════════════════════════════════

type TaskStatus = "ok" | "attention" | "error" | "skipped";

interface TaskResult {
  task: Task;
  status: TaskStatus;
  detail: Record<string, unknown>;
  message: string;
}

/** One health row to write. Collected per task, written in the single closing txn. */
interface HealthRow {
  component: string;
  status: "ok" | "degraded" | "down";
  metricName: string;
  metricValue: number;
  threshold: number;
  detail: Record<string, unknown>;
  message: string;
}

/** One notification to enqueue. `notification-dispatch` fans these out to email. */
interface NotifyRow {
  eventCode: string;
  title: string;
  body: string;
  priority: "normal" | "high" | "critical";
  dedupeKey: string;
  payload: Record<string, unknown>;
  roles: readonly ("admin" | "super_admin")[];
  deepLink: string;
}

function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

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

// ═════════════════════════════════════════════════════════════════════════════
// verify_chain
// ═════════════════════════════════════════════════════════════════════════════

interface ChainBreak {
  bad_seq: string | number | null;
  occurred_at: Date | string | null;
  stored_hash: string | null;
  computed_hash: string | null;
  note: string | null;
}

/**
 * Returns the first break, or `null` when the chain is intact for the window.
 * `from`/`to` are UTC dates; see the header for why they bracket the IST day.
 */
async function verifyChain(client: Sql, from: string, to: string): Promise<ChainBreak | null> {
  const rows = await client<ChainBreak[]>`
    SELECT v.bad_seq, v.occurred_at, v.stored_hash, v.computed_hash, v.note
      FROM audit.verify_chain(${from}::date, ${to}::date) v
     LIMIT 1
  `;
  return firstRow(rows);
}

// ═════════════════════════════════════════════════════════════════════════════
// seal
// ═════════════════════════════════════════════════════════════════════════════

interface DayHead {
  first_seq: string | number | null;
  last_seq: string | number | null;
  row_count: string | number;
  terminal_hash: string | null;
}

/**
 * The day's extent on the chain.
 *
 * Both the `occurred_at` range (so the partition pruner can work) and the
 * generated `ist_date` column (which is the actual definition of the IST day)
 * are in the predicate; they select the same rows, and neither alone is both
 * exact and fast.
 */
async function loadDayHead(client: Sql, sealDate: string): Promise<DayHead | null> {
  const lo = toIso(istInstant(sealDate, "00:00:00"));
  const hi = toIso(istInstant(addDays(sealDate, 1), "00:00:00"));
  const rows = await client<DayHead[]>`
    WITH day_rows AS (
      SELECT a.seq, a.row_hash
        FROM public.audit_log a
       WHERE a.occurred_at >= ${lo}::timestamptz
         AND a.occurred_at <  ${hi}::timestamptz
         AND a.ist_date = ${sealDate}::date
    )
    SELECT min(seq)      AS first_seq,
           max(seq)      AS last_seq,
           count(*)      AS row_count,
           (SELECT r.row_hash FROM day_rows r ORDER BY r.seq DESC LIMIT 1) AS terminal_hash
      FROM day_rows
  `;
  return firstRow(rows);
}

interface ChainState {
  last_seq: string | number;
  last_hash: string;
  updated_at: Date | string;
}

async function loadChainState(client: Sql): Promise<ChainState | null> {
  const rows = await client<ChainState[]>`
    SELECT c.last_seq, c.last_hash, c.updated_at
      FROM audit.chain_state c
     WHERE c.chain_id = 'global'
     LIMIT 1
  `;
  return firstRow(rows);
}

// ═════════════════════════════════════════════════════════════════════════════
// orphans
// ═════════════════════════════════════════════════════════════════════════════

interface OrphanCounts {
  attendance_day_punch_refs: string | number;
  regularization_punch_refs: string | number;
  import_batch_document_refs: string | number;
  attendance_days_for_deleted_employees: string | number;
}

/**
 * Report-only counts over the four references the schema cannot enforce.
 * Bounded to `ORPHAN_LOOKBACK_DAYS` of attendance so the cost is predictable.
 *
 * The two punch columns are counted by two separate anti-joins rather than one
 * `A OR B`: an OR between two `NOT EXISTS` blocks the anti-join transformation
 * and degrades into a per-row subplan. The metric counts dangling REFERENCES, so
 * a day with both columns dangling legitimately contributes two.
 */
async function countOrphans(client: Sql, fromDate: string): Promise<OrphanCounts | null> {
  const rows = await client<OrphanCounts[]>`
    SELECT
      ((SELECT count(*)
          FROM public.attendance_days ad
         WHERE ad.ist_date >= ${fromDate}::date
           AND ad.first_in_punch_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.attendance_punches p WHERE p.id = ad.first_in_punch_id))
       +
       (SELECT count(*)
          FROM public.attendance_days ad
         WHERE ad.ist_date >= ${fromDate}::date
           AND ad.last_out_punch_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.attendance_punches p WHERE p.id = ad.last_out_punch_id))
      ) AS attendance_day_punch_refs,
      (SELECT count(*)
         FROM public.attendance_regularizations ar
        WHERE ar.ist_date >= ${fromDate}::date
          AND ar.created_punch_ids IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM unnest(ar.created_punch_ids) AS pid
             WHERE NOT EXISTS (SELECT 1 FROM public.attendance_punches p WHERE p.id = pid)
          )
      ) AS regularization_punch_refs,
      (SELECT count(*)
         FROM public.import_batches ib
        WHERE ib.file_document_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.id = ib.file_document_id)
      ) AS import_batch_document_refs,
      (SELECT count(*)
         FROM public.attendance_days ad
         JOIN public.employees e ON e.id = ad.employee_id
        WHERE ad.ist_date >= ${fromDate}::date
          AND e.deleted_at IS NOT NULL
      ) AS attendance_days_for_deleted_employees
  `;
  return firstRow(rows);
}

interface StaleRun {
  id: string;
  job_code: string;
  started_at: Date | string;
}

/**
 * Job runs still marked `running` past their own timeout. Left alone, each one
 * holds `uq_job_runs__running_lock` forever and its schedule silently stops:
 * every later invocation returns `{"skipped":"already_running"}`.
 */
async function findStaleRuns(client: Sql, excludeRunId: string | null): Promise<StaleRun[]> {
  return await client<StaleRun[]>`
    SELECT r.id, r.job_code, r.started_at
      FROM public.job_runs r
      LEFT JOIN public.cron_jobs c ON c.id = r.cron_job_id
     WHERE r.status = 'running'
       AND r.lock_key IS NOT NULL
       AND (${excludeRunId}::uuid IS NULL OR r.id <> ${excludeRunId}::uuid)
       AND r.started_at < now() - make_interval(
             secs => GREATEST(COALESCE(c.timeout_seconds, 0) * 3,
                              ${STALE_JOB_RUN_FALLBACK_SECONDS}::integer)::double precision)
     ORDER BY r.started_at
     LIMIT 200
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// kiosk_health
// ═════════════════════════════════════════════════════════════════════════════

interface DeviceRow {
  id: string;
  device_code: string;
  label: string;
  last_seen_at: Date | string | null;
  clock_skew_seconds: number | null;
  app_version: string | null;
  silent_minutes: string | number | null;
}

async function loadUnhealthyDevices(client: Sql, offlineMinutes: number): Promise<DeviceRow[]> {
  return await client<DeviceRow[]>`
    SELECT kd.id, kd.device_code, kd.label, kd.last_seen_at,
           kd.clock_skew_seconds, kd.app_version,
           CASE WHEN kd.last_seen_at IS NULL THEN NULL
                ELSE floor(EXTRACT(EPOCH FROM (now() - kd.last_seen_at)) / 60.0)
           END AS silent_minutes
      FROM public.kiosk_devices kd
     WHERE kd.is_active
       AND kd.revoked_at IS NULL
       AND kd.deleted_at IS NULL
       AND (kd.last_seen_at IS NULL
            OR kd.last_seen_at < now() - make_interval(mins => ${offlineMinutes}::integer)
            OR abs(COALESCE(kd.clock_skew_seconds, 0)) > ${MAX_DEVICE_SKEW_SECONDS}::integer)
     ORDER BY kd.last_seen_at NULLS FIRST
     LIMIT ${MAX_DEVICES_REPORTED}
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// balance_drift
// ═════════════════════════════════════════════════════════════════════════════

interface DriftRow {
  employee_code: string | null;
  display_name: string | null;
  leave_type_code: string | null;
  leave_year: number;
  cached_available: string | number | null;
  folded_available: string | number | null;
  difference: string | number | null;
  side: string;
}

/**
 * The same fold `public.recompute_leave_balance` performs (migration 019 §8),
 * evaluated read-only and compared with the cache. Entry-type groupings are
 * copied from that function verbatim — if they ever diverge, this check would be
 * measuring itself rather than the data.
 */
async function loadBalanceDrift(client: Sql): Promise<DriftRow[]> {
  return await client<DriftRow[]>`
    WITH folded AS (
      SELECT ll.employee_id, ll.leave_type_id, ll.leave_year,
             COALESCE(SUM(ll.days) FILTER (WHERE ll.entry_type = 'opening_balance'), 0)
               + COALESCE(SUM(ll.days) FILTER (WHERE ll.entry_type IN ('accrual','pro_rata_accrual','comp_off_credit')), 0)
               + COALESCE(SUM(ll.days) FILTER (WHERE ll.entry_type = 'carry_forward_in'), 0)
               + COALESCE(SUM(ll.days) FILTER (WHERE ll.entry_type IN ('credit_adjustment','debit_adjustment')), 0)
               - (ABS(COALESCE(SUM(ll.days) FILTER (WHERE ll.entry_type IN ('availed','late_deduction','comp_off_debit')), 0))
                  - COALESCE(SUM(ll.days) FILTER (WHERE ll.entry_type = 'availed_reversal'), 0))
               - ABS(COALESCE(SUM(ll.days) FILTER (WHERE ll.entry_type IN ('encashment','settlement')), 0))
               - ABS(COALESCE(SUM(ll.days) FILTER (WHERE ll.entry_type IN ('lapse','carry_forward_out','comp_off_expiry')), 0))
               AS folded_available
        FROM public.leave_ledger ll
       GROUP BY ll.employee_id, ll.leave_type_id, ll.leave_year
    )
    SELECT e.employee_code,
           e.display_name,
           lt.code                                  AS leave_type_code,
           COALESCE(lb.leave_year, f.leave_year)    AS leave_year,
           lb.available_days                        AS cached_available,
           f.folded_available,
           ROUND(COALESCE(lb.available_days, 0) - COALESCE(f.folded_available, 0), 3) AS difference,
           CASE WHEN lb.employee_id IS NULL THEN 'ledger_without_cache'
                WHEN f.employee_id  IS NULL THEN 'cache_without_ledger'
                ELSE 'value_mismatch' END           AS side
      FROM public.leave_balances lb
      FULL JOIN folded f
             ON f.employee_id = lb.employee_id
            AND f.leave_type_id = lb.leave_type_id
            AND f.leave_year = lb.leave_year
      LEFT JOIN public.employees e ON e.id = COALESCE(lb.employee_id, f.employee_id)
      LEFT JOIN public.leave_types lt ON lt.id = COALESCE(lb.leave_type_id, f.leave_type_id)
     WHERE lb.employee_id IS NULL
        OR f.employee_id IS NULL
        OR ROUND(lb.available_days, 3) <> ROUND(f.folded_available, 3)
     ORDER BY ABS(COALESCE(lb.available_days, 0) - COALESCE(f.folded_available, 0)) DESC
     LIMIT ${MAX_DRIFT_ROWS_REPORTED}
  `;
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
  const url = new URL(req.url);
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = url.pathname;

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
    // Auth model C: the constant-time secret comparison IS the authority. A
    // scheduled job has no row in `role_capabilities` to resolve.

    const rawBody = await readRawBody(req, { maxBytes: 16 * 1024, requireJsonContentType: false });
    const decoded = rawBody === "" ? {} : decodeJson(rawBody);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    // The kiosk sweep runs every 5 minutes; `heavyJob` (4 burst, 2/min) covers
    // that and still stops a runaway scheduler from re-walking the hash chain.
    await enforce(RATE_LIMITS.heavyJob, limitKey(FN_NAME, "cron"), "INTEGRITY_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const body = parse(IntegrityBody, decoded, "integrity request");
    jobCode = body.job_code ?? DEFAULT_JOB_CODE;
    // Migration 041 puts the task list in the QUERY STRING and the job code in
    // the body; a manual caller may use either.
    const tasks = resolveTasks(body.tasks ?? url.searchParams.get("tasks") ?? undefined);
    const sealDate = body.seal_date ?? addDays(istToday(), -1);
    const runs = (task: Task): boolean => tasks.includes(task);

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // Bucketed to five IST minutes, not to the day: the kiosk sweep is scheduled
    // every five minutes and must not replay a stale answer, while a pg_net
    // retry (seconds later) must.
    if (!body.dry_run) {
      const p = istParts(nowIso());
      const bucket = `${istToday()}T${String(p.hour).padStart(2, "0")}:${
        String(Math.floor(p.minute / 5) * 5).padStart(2, "0")
      }`;
      idempotencyKey = idempotencyKeyFrom(req) ??
        `${FN_NAME}:${jobCode}:${tasks.join("+")}:${bucket}`;
      const hash = await requestHash(FN_NAME, rawBody, `${jobCode}:${tasks.join("+")}`);
      const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: hash });
      if (claimed.state === "replay") {
        status = claimed.status;
        log.info("idempotent replay", { key: idempotencyKey });
        return replayResponse(claimed, { ...cors, "x-request-id": requestId });
      }
    }

    const pool = sql();

    // Double-run guard (spec-architecture §9). Lock key includes the job code so
    // the three schedules pointed at this function never block each other.
    if (!body.dry_run) {
      const begun = await pool<{ id: string | null }[]>`
        SELECT app.job_begin(${jobCode}, ${`${FN_NAME}:${jobCode}`}) AS id
      `;
      jobRunId = firstRow(begun)?.id ?? null;
      if (jobRunId === null) {
        status = 200;
        responseBody = { skipped: "already_running", job_code: jobCode, tasks, requestId };
        if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
        return ok(responseBody, { status, headers: cors, requestId });
      }
    }

    const results: TaskResult[] = [];
    const health: HealthRow[] = [];
    const notifications: NotifyRow[] = [];
    /** Writes deferred into the single closing transaction. */
    const sealPlan: {
      sealDate: string;
      firstSeq: number;
      lastSeq: number;
      rowCount: number;
      terminalHash: string;
      verification: string;
    }[] = [];
    let staleRunsToClose: StaleRun[] = [];
    let nonceSweepRequested = false;
    let healthyDeviceIds: string[] = [];
    let backupMarker: Record<string, unknown> | null = null;
    let chainOk: boolean | null = null;

    const record = (task: Task, statusOut: TaskStatus, message: string, detail: Record<string, unknown>): void => {
      results.push({ task, status: statusOut, detail, message });
    };

    const runTask = async (task: Task, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        const detail = err instanceof Error ? err.message.slice(0, 400) : "unknown error";
        record(task, "error", `Task ${task} failed: ${detail}`, {});
        health.push({
          component: `integrity.${task}`,
          status: "down",
          metricName: "task_failed",
          metricValue: 1,
          threshold: 0,
          detail: { error: detail, request_id: requestId, job_code: jobCode },
          message: `cron-integrity task ${task} failed.`,
        });
        log.error("integrity task failed", { task, err });
      }
    };

    // ── verify_chain ────────────────────────────────────────────────────────
    if (runs("verify_chain")) {
      await runTask("verify_chain", async () => {
        const from = addDays(sealDate, -1);
        const broken = await verifyChain(pool, from, sealDate);
        chainOk = broken === null;
        if (broken === null) {
          record("verify_chain", "ok", `Hash chain intact for UTC ${from}..${sealDate}.`, {
            window_from_utc: from,
            window_to_utc: sealDate,
            ist_day: sealDate,
          });
          health.push({
            component: "integrity.audit_chain",
            status: "ok",
            metricName: "chain_breaks",
            metricValue: 0,
            threshold: 0,
            detail: { window_from_utc: from, window_to_utc: sealDate, ist_day: sealDate },
            message: `Audit hash chain verified for IST ${sealDate}.`,
          });
          return;
        }
        const detail = {
          bad_seq: num(broken.bad_seq),
          occurred_at: broken.occurred_at === null ? null : toIso(broken.occurred_at),
          note: broken.note,
          window_from_utc: from,
          window_to_utc: sealDate,
        };
        record("verify_chain", "attention", `Hash chain BROKEN at seq ${num(broken.bad_seq)}: ${broken.note ?? "?"}`, detail);
        health.push({
          component: "integrity.audit_chain",
          status: "down",
          metricName: "chain_breaks",
          metricValue: 1,
          threshold: 0,
          detail,
          message: `Audit hash chain broken at seq ${num(broken.bad_seq)}: ${broken.note ?? "unknown"}.`,
        });
        notifications.push({
          eventCode: "AUDIT_CHAIN_BROKEN",
          title: "Audit chain verification FAILED",
          body:
            `The audit hash chain does not verify for ${sealDate} (IST). First divergence at seq ` +
            `${num(broken.bad_seq)}: ${broken.note ?? "unknown"}. Treat the audit log as disputed until ` +
            `this is investigated — do not run further maintenance on public.audit_log.`,
          priority: "critical",
          dedupeKey: `audit_chain_broken:${sealDate}`,
          payload: detail,
          roles: ["super_admin"],
          deepLink: "/audit",
        });
      });
    }

    // ── seal ────────────────────────────────────────────────────────────────
    if (runs("seal")) {
      await runTask("seal", async () => {
        const head = await loadDayHead(pool, sealDate);
        const rowCount = num(head?.row_count);
        if (head === null || rowCount === 0 || head.terminal_hash === null) {
          record("seal", "skipped", `No audit rows for IST ${sealDate}; nothing to seal.`, {
            seal_date: sealDate,
            row_count: 0,
          });
          return;
        }
        const existing = await pool<{ seal_date: string; terminal_hash: string }[]>`
          SELECT s.seal_date::text AS seal_date, s.terminal_hash
            FROM public.audit_seals s
           WHERE s.seal_date = ${sealDate}::date
           LIMIT 1
        `;
        const already = firstRow(existing);
        if (already !== null) {
          record("seal", "ok", `IST ${sealDate} was already sealed; the seal is evidence and is not rewritten.`, {
            seal_date: sealDate,
            already_sealed: true,
            terminal_hash: already.terminal_hash,
            row_count: rowCount,
          });
          return;
        }
        sealPlan.push({
          sealDate,
          firstSeq: num(head.first_seq),
          lastSeq: num(head.last_seq),
          rowCount,
          terminalHash: head.terminal_hash,
          verification: chainOk === null ? "not_verified" : chainOk ? "ok" : "chain_broken",
        });
        record("seal", "ok", `Sealing IST ${sealDate}: ${rowCount} row(s), seq ${num(head.first_seq)}..${num(head.last_seq)}.`, {
          seal_date: sealDate,
          first_seq: num(head.first_seq),
          last_seq: num(head.last_seq),
          row_count: rowCount,
          terminal_hash: head.terminal_hash,
        });
        notifications.push({
          eventCode: "AUDIT_SEAL",
          title: `Audit seal ${sealDate}`,
          body:
            `Audit chain sealed for ${sealDate} (IST).\n` +
            `Rows: ${rowCount} (seq ${num(head.first_seq)}–${num(head.last_seq)}).\n` +
            `Terminal hash: ${head.terminal_hash}\n\n` +
            `Keep this hash outside the system. If the audit log is ever disputed, re-running ` +
            `audit.verify_chain must reproduce exactly this value.`,
          priority: "high",
          dedupeKey: `audit_seal:${sealDate}`,
          payload: {
            seal_date: sealDate,
            row_count: rowCount,
            first_seq: num(head.first_seq),
            last_seq: num(head.last_seq),
            terminal_hash: head.terminal_hash,
          },
          roles: ["super_admin"],
          deepLink: "/audit",
        });
      });
    }

    // ── orphans ─────────────────────────────────────────────────────────────
    if (runs("orphans")) {
      await runTask("orphans", async () => {
        const fromDate = addDays(istToday(), -ORPHAN_LOOKBACK_DAYS);
        const counts = await countOrphans(pool, fromDate);
        staleRunsToClose = await findStaleRuns(pool, jobRunId);
        nonceSweepRequested = true;

        const detail = {
          lookback_from: fromDate,
          attendance_day_punch_refs: num(counts?.attendance_day_punch_refs),
          regularization_punch_refs: num(counts?.regularization_punch_refs),
          import_batch_document_refs: num(counts?.import_batch_document_refs),
          attendance_days_for_deleted_employees: num(counts?.attendance_days_for_deleted_employees),
          stale_job_runs: staleRunsToClose.length,
          stale_job_codes: staleRunsToClose.map((r) => r.job_code),
        };
        const orphanTotal = detail.attendance_day_punch_refs + detail.regularization_punch_refs +
          detail.import_batch_document_refs + detail.attendance_days_for_deleted_employees;

        record(
          "orphans",
          orphanTotal === 0 && staleRunsToClose.length === 0 ? "ok" : "attention",
          orphanTotal === 0
            ? `No dangling references in the last ${ORPHAN_LOOKBACK_DAYS} days; ${staleRunsToClose.length} stale job run(s) to close.`
            : `${orphanTotal} dangling reference(s) found (reported, not deleted).`,
          detail,
        );
        health.push({
          component: "integrity.orphans",
          status: orphanTotal === 0 ? "ok" : "degraded",
          metricName: "dangling_references",
          metricValue: orphanTotal,
          threshold: 0,
          detail,
          message: orphanTotal === 0
            ? "No dangling references over the unenforced reference columns."
            : `${orphanTotal} dangling reference(s) over columns with no FK. Reported for investigation; nothing was deleted.`,
        });
      });
    }

    // ── partitions ──────────────────────────────────────────────────────────
    // Runs on the pool, OUTSIDE the closing transaction: it issues DDL, and a
    // later task's failure must not roll back a partition the next insert needs.
    if (runs("partitions") && !body.dry_run) {
      await runTask("partitions", async () => {
        const rows = await pool<{ ensured: number }[]>`SELECT public.partition_maintenance() AS ensured`;
        const ensured = num(firstRow(rows)?.ensured);
        record("partitions", "ok", `${ensured} partition slot(s) ensured for the next 3 months.`, { ensured });
        health.push({
          component: "integrity.partitions",
          status: "ok",
          metricName: "partitions_ensured",
          metricValue: ensured,
          threshold: 0,
          detail: { ensured },
          message: `Partition headroom confirmed (${ensured} slot(s) checked).`,
        });
      });
    } else if (runs("partitions")) {
      record("partitions", "skipped", "dry_run: partition_maintenance() not called.", {});
    }

    // ── backup_marker ───────────────────────────────────────────────────────
    if (runs("backup_marker")) {
      await runTask("backup_marker", async () => {
        const state = await loadChainState(pool);
        const maxSeqRows = await pool<{ max_seq: string | number | null; rows_today: string | number }[]>`
          SELECT max(a.seq) AS max_seq,
                 count(*) FILTER (WHERE a.ist_date = ${istToday()}::date) AS rows_today
            FROM public.audit_log a
           WHERE a.occurred_at >= now() - interval '2 days'
        `;
        const seqInfo = firstRow(maxSeqRows);
        backupMarker = {
          marker_id: crypto.randomUUID(),
          marked_at: nowIso(),
          ist_date: istToday(),
          chain_head_hash: state?.last_hash ?? null,
          chain_last_seq: num(state?.last_seq),
          audit_log_max_seq_recent: num(seqInfo?.max_seq),
          audit_rows_today: num(seqInfo?.rows_today),
          sealed_date: sealPlan.length > 0 ? sealPlan[0]?.sealDate ?? null : null,
          sealed_terminal_hash: sealPlan.length > 0 ? sealPlan[0]?.terminalHash ?? null : null,
          job_run_id: jobRunId,
          request_id: requestId,
        };
        record("backup_marker", "ok", "Backup marker prepared (chain head + seal recorded).", backupMarker);
        health.push({
          component: "backup_marker",
          status: "ok",
          metricName: "chain_last_seq",
          metricValue: num(state?.last_seq),
          threshold: 0,
          detail: backupMarker,
          message:
            "Restore-drill marker: a restored database is complete to this instant only if this row " +
            "and this audit chain head are both present.",
        });
      });
    }

    // ── kiosk_health ────────────────────────────────────────────────────────
    if (runs("kiosk_health")) {
      await runTask("kiosk_health", async () => {
        const settings = await settingsMap(pool, ["kiosk.offline_alert_minutes"]);
        const configured = Number(settings.get("kiosk.offline_alert_minutes") ?? "");
        const offlineMinutes = Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_OFFLINE_ALERT_MINUTES;

        const devices = await loadUnhealthyDevices(pool, offlineMinutes);
        const unhealthyIds = devices.map((d) => d.id);
        // `id = ANY('{}'::uuid[])` is false, so an empty unhealthy list makes
        // every active device healthy — no special case needed.
        const healthyRows = await pool<{ id: string }[]>`
          SELECT kd.id
            FROM public.kiosk_devices kd
           WHERE kd.is_active AND kd.revoked_at IS NULL AND kd.deleted_at IS NULL
             AND NOT (kd.id = ANY(${unhealthyIds}::uuid[]))
        `;
        healthyDeviceIds = healthyRows.map((r) => r.id);

        for (const device of devices) {
          const silent = device.silent_minutes === null ? null : num(device.silent_minutes);
          const skew = device.clock_skew_seconds ?? 0;
          const offline = silent === null || silent >= offlineMinutes;
          const skewed = Math.abs(skew) > MAX_DEVICE_SKEW_SECONDS;
          const detail = {
            kiosk_device_id: device.id,
            device_code: device.device_code,
            label: device.label,
            last_seen_at: device.last_seen_at === null ? null : toIso(device.last_seen_at),
            silent_minutes: silent,
            clock_skew_seconds: skew,
            app_version: device.app_version,
            offline_threshold_minutes: offlineMinutes,
          };
          health.push({
            component: `kiosk.${device.device_code}`,
            status: offline ? "down" : "degraded",
            metricName: offline ? "silent_minutes" : "clock_skew_seconds",
            metricValue: offline ? (silent ?? 0) : Math.abs(skew),
            threshold: offline ? offlineMinutes : MAX_DEVICE_SKEW_SECONDS,
            detail,
            message: offline
              ? `Kiosk ${device.device_code} (${device.label}) last seen ${
                device.last_seen_at === null ? "never" : toIso(device.last_seen_at)
              }. Punches may be queuing on the tablet.`
              : `Kiosk ${device.device_code} clock is ${skew}s off; over ${MAX_DEVICE_SKEW_SECONDS}s every punch is refused.`,
          });
          if (offline) {
            const p = istParts(nowIso());
            notifications.push({
              eventCode: "KIOSK_OFFLINE",
              title: `Kiosk offline: ${device.device_code}`,
              body: `Kiosk ${device.device_code} (${device.label}) has been silent for ${
                silent === null ? "an unknown period — it has never checked in" : `${silent} minute(s)`
              }. Attendance punches may be queuing on the device.`,
              priority: "high",
              // One alert per device per IST hour: this task runs every 5 minutes.
              dedupeKey: `kiosk_offline:${device.id}:${istToday()}T${String(p.hour).padStart(2, "0")}`,
              payload: detail,
              roles: ["admin", "super_admin"],
              deepLink: "/kiosk/devices",
            });
          }
        }

        record(
          "kiosk_health",
          devices.length === 0 ? "ok" : "attention",
          devices.length === 0
            ? "All active kiosks are reporting inside their thresholds."
            : `${devices.length} kiosk device(s) offline or clock-skewed.`,
          {
            offline_threshold_minutes: offlineMinutes,
            unhealthy: devices.length,
            healthy: healthyDeviceIds.length,
            devices: devices.map((d) => ({
              device_code: d.device_code,
              silent_minutes: d.silent_minutes === null ? null : num(d.silent_minutes),
              clock_skew_seconds: d.clock_skew_seconds ?? 0,
            })),
          },
        );
      });
    }

    // ── balance_drift ───────────────────────────────────────────────────────
    if (runs("balance_drift")) {
      await runTask("balance_drift", async () => {
        const drift = await loadBalanceDrift(pool);
        const detail = {
          mismatches: drift.length,
          capped_at: MAX_DRIFT_ROWS_REPORTED,
          rows: drift.map((d) => ({
            employee_code: d.employee_code,
            leave_type_code: d.leave_type_code,
            leave_year: d.leave_year,
            cached_available: num(d.cached_available),
            folded_available: num(d.folded_available),
            difference: num(d.difference),
            side: d.side,
          })),
        };
        record(
          "balance_drift",
          drift.length === 0 ? "ok" : "attention",
          drift.length === 0
            ? "Every leave balance matches a fresh fold of the ledger."
            : `${drift.length} leave balance(s) disagree with the ledger.`,
          detail,
        );
        health.push({
          component: "integrity.leave_balance_drift",
          status: drift.length === 0 ? "ok" : "degraded",
          metricName: "drifted_balances",
          metricValue: drift.length,
          threshold: 0,
          detail,
          message: drift.length === 0
            ? "Leave balance cache agrees with the ledger."
            : `${drift.length} leave balance row(s) drifted from the ledger. Nothing was auto-corrected: ` +
              "run recompute_leave_balance once the cause is known.",
        });
        if (drift.length > 0) {
          notifications.push({
            eventCode: "LEAVE_BALANCE_DRIFT",
            title: `${drift.length} leave balance(s) drifted`,
            body:
              `A nightly re-fold of leave_ledger disagrees with leave_balances for ${drift.length} row(s). ` +
              "Balances were NOT auto-corrected, so the evidence is intact. Investigate before recomputing.",
            priority: "high",
            dedupeKey: `leave_balance_drift:${istToday()}`,
            payload: { mismatches: drift.length },
            roles: ["admin", "super_admin"],
            deepLink: "/leave",
          });
        }
      });
    }

    const failed = results.filter((r) => r.status === "error");
    const attention = results.filter((r) => r.status === "attention");

    if (body.dry_run) {
      status = 200;
      responseBody = {
        dry_run: true,
        job_code: jobCode,
        tasks,
        seal_date: sealDate,
        results,
        would_write: {
          health_rows: health.length,
          notifications: notifications.length,
          seals: sealPlan.length,
          stale_job_runs_closed: staleRunsToClose.length,
        },
        note: "nothing written",
        requestId,
      };
      log.info("integrity dry run", { tasks, attention: attention.length, failed: failed.length });
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
      reason: `${FN_NAME}: ${tasks.join(",")} for ${sealDate}`,
    };

    // ── STEPS 9 + 10 · ONE transaction: every write, plus its audit rows ─────
    let sealsWritten = 0;
    let noncesPurged = 0;
    let runsClosed = 0;
    let notified = 0;
    let resolvedHealth = 0;

    await withContext(ctx, async (tx) => {
      // 1. Seals first: the row is the evidence the rest of this run describes.
      for (const plan of sealPlan) {
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO public.audit_seals
            (seal_date, first_seq, last_seq, row_count, terminal_hash, sealed_by,
             verified_at, verification_result)
          VALUES (
            ${plan.sealDate}::date,
            ${plan.firstSeq}::bigint,
            ${plan.lastSeq}::bigint,
            ${plan.rowCount}::bigint,
            ${plan.terminalHash}::text,
            ${`cron:${jobCode}`}::text,
            ${plan.verification === "not_verified" ? null : nowIso()}::timestamptz,
            ${plan.verification}::text
          )
          ON CONFLICT (seal_date) DO NOTHING
          RETURNING id
        `;
        const sealId = firstRow(inserted as unknown as { id: string }[]);
        if (sealId !== null) {
          sealsWritten++;
          // `audit_seals` is excluded from the change triggers (migration 038),
          // so the seal is put on the chain explicitly. Its own row lands on
          // today's chain, never inside the day just sealed.
          await writeAudit(tx, ctx, {
            action: "insert",
            entityTable: "public.audit_seals",
            entityId: sealId.id,
            entityLabel: `seal ${plan.sealDate}`,
            newValue: {
              seal_date: plan.sealDate,
              first_seq: plan.firstSeq,
              last_seq: plan.lastSeq,
              row_count: plan.rowCount,
              terminal_hash: plan.terminalHash,
              verification_result: plan.verification,
            },
            reason: `daily audit seal for ${plan.sealDate} (${plan.verification})`,
          });
        }
      }

      // 2. Sweeps.
      if (nonceSweepRequested) {
        const purged = await tx<{ device_id: string }[]>`
          DELETE FROM secure.kiosk_nonces
           WHERE expires_at < now() - interval '1 hour'
          RETURNING device_id
        `;
        noncesPurged = (purged as unknown as unknown[]).length;
      }
      for (const stale of staleRunsToClose) {
        await tx`
          SELECT app.job_end(
                   ${stale.id}::uuid,
                   'timed_out'::public.job_run_status,
                   NULL, NULL, NULL,
                   ${`closed by ${FN_NAME}: still 'running' past its timeout, holding the overlap lock`}::text)
        `;
        runsClosed++;
      }

      // 3. Health rows.
      for (const row of health) {
        await tx`
          INSERT INTO public.system_health
            (component, status, metric_name, metric_value, threshold, detail, message)
          VALUES (
            ${row.component}::text,
            ${row.status}::text,
            ${row.metricName}::text,
            ${row.metricValue}::numeric,
            ${row.threshold}::numeric,
            ${JSON.stringify(row.detail)}::jsonb,
            ${row.message}::text
          )
        `;
      }

      // 4. Kiosks that came back: close their open alerts so the "open issues"
      //    index means what it says.
      if (healthyDeviceIds.length > 0) {
        const resolved = await tx<{ id: string }[]>`
          UPDATE public.system_health sh
             SET resolved_at = now()
           WHERE sh.resolved_at IS NULL
             AND sh.status <> 'ok'
             AND sh.component = ANY (
                   SELECT 'kiosk.' || kd.device_code
                     FROM public.kiosk_devices kd
                    WHERE kd.id = ANY(${healthyDeviceIds}::uuid[]))
          RETURNING sh.id
        `;
        resolvedHealth = (resolved as unknown as unknown[]).length;
      }

      // 5. Notifications — in-app rows only; `notification-dispatch` emails them
      //    under each recipient's own preferences (transactional codes ignore
      //    quiet hours, which is why the seal and the chain break get through).
      for (const note of notifications) {
        const inserted = await tx<{ profile_id: string }[]>`
          INSERT INTO public.notifications
            (profile_id, event_code, channel, title, body, deep_link, payload, priority, status, dedupe_key)
          SELECT DISTINCT ur.user_id,
                 ${note.eventCode}::text,
                 'in_app'::public.notification_channel,
                 ${note.title}::text,
                 ${note.body}::text,
                 ${note.deepLink}::text,
                 ${JSON.stringify(note.payload)}::jsonb,
                 ${note.priority}::text,
                 'queued'::public.notification_status,
                 ${`${note.dedupeKey}:`} || ur.user_id::text
            FROM public.user_roles ur
            JOIN public.profiles pr ON pr.id = ur.user_id AND pr.is_active
           WHERE ur.revoked_at IS NULL
             AND ur.role = ANY(${[...note.roles]}::public.app_role[])
             AND NOT EXISTS (
               SELECT 1 FROM public.notifications n
                WHERE n.dedupe_key = ${`${note.dedupeKey}:`} || ur.user_id::text
             )
          RETURNING profile_id
        `;
        notified += (inserted as unknown as unknown[]).length;
      }

      // 6. Close the run and put it on the chain.
      const outcome = failed.length > 0 ? "failed" : "succeeded";
      await tx`
        SELECT app.job_end(
                 ${jobRunId}::uuid,
                 ${outcome}::public.job_run_status,
                 ${results.length}::integer,
                 ${failed.length}::integer,
                 ${JSON.stringify({
        tasks,
        seal_date: sealDate,
        results: results.map((r) => ({ task: r.task, status: r.status, message: r.message })),
        seals_written: sealsWritten,
        nonces_purged: noncesPurged,
        stale_job_runs_closed: runsClosed,
        notified,
        health_rows: health.length,
        resolved_health_rows: resolvedHealth,
      })}::jsonb,
                 ${failed.length === 0 ? null : failed.map((f) => f.message).join(" | ").slice(0, 2_000)}::text)
      `;
      await auditJobRun(tx, ctx, {
        jobCode,
        runId: jobRunId,
        outcome,
        stats: {
          tasks,
          seal_date: sealDate,
          seals_written: sealsWritten,
          chain_ok: chainOk,
          attention: attention.map((a) => a.task),
          failed: failed.map((f) => f.task),
          nonces_purged: noncesPurged,
          stale_job_runs_closed: runsClosed,
        },
      });
    });

    // A failed task is reported as 200 + `job_runs.status = 'failed'` (which is
    // what `cron_jobs.alert_on_failure` watches), never as an opaque 500.
    status = 200;
    responseBody = {
      job_code: jobCode,
      job_run_id: jobRunId,
      tasks,
      seal_date: sealDate,
      completed_at: nowIso(),
      outcome: failed.length > 0 ? "failed" : attention.length > 0 ? "attention" : "ok",
      results,
      written: {
        seals: sealsWritten,
        health_rows: health.length,
        resolved_health_rows: resolvedHealth,
        notifications: notified,
        nonces_purged: noncesPurged,
        stale_job_runs_closed: runsClosed,
      },
      backup_marker: backupMarker,
      requestId,
    };

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
    log.info("integrity run complete", {
      tasks,
      seals: sealsWritten,
      chain_ok: chainOk,
      attention: attention.length,
      failed: failed.length,
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
      try {
        await sql()`
          SELECT app.job_end(${jobRunId}::uuid, 'failed'::public.job_run_status, NULL, NULL, NULL,
                             ${`${problem.code ?? "ERROR"}: ${problem.problem.title}`}::text)
        `;
      } catch (jobErr) {
        log.warn("could not close job run", { err: jobErr });
      }
    }

    if (problem.isServerFault) log.error("integrity run failed", { err, code: problem.code });
    else log.warn("integrity run refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey, job_run_id: jobRunId, job_code: jobCode });
  }
});

/** Exported for `supabase/tests`: the contract and the task parser. */
export { IntegrityBody, TASKS };
