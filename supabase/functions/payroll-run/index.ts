/**
 * payroll-run — catalogue #9, auth model **U+** (`payroll.run.execute`, step-up).
 *
 * Lock inputs → compute → draft → flag per-employee variance. Chunked and
 * resumable, so a 400-employee run cannot die of an edge timeout half way and
 * leave nobody knowing which employees were done.
 *
 * WHO OWNS WHAT
 *   The DATABASE owns the arithmetic. `public.compute_payslip` (023) computes one
 *   payslip; `public.compute_payroll_run` (023) computes the whole run AND stamps
 *   the run header (totals, variance vs the previous released regular run,
 *   exception_count, status). This function owns only the things a plpgsql
 *   function cannot do: the 12-step request lifecycle, the input lock, chunk
 *   scheduling with a durable cursor, and the per-employee variance review flags.
 *
 * TWO MODES, one reason
 *   - `single_shot`: the whole eligible list fits in one chunk → ONE call to
 *     `public.compute_payroll_run`, exactly as the catalogue specifies. Nothing
 *     is re-derived here.
 *   - `chunked`: the list is larger than `chunk_size` → per-employee
 *     `public.compute_payslip` inside a SAVEPOINT (so one employee's failure is
 *     recorded, not fatal), cursor persisted in `public.job_runs.result`, and the
 *     run header stamped on the final chunk.
 *     The stamp SQL is a deliberate MIRROR of the tail of `compute_payroll_run`
 *     (023 §2, lines 860–898). It is duplicated because that function is
 *     monolithic — computing every employee again just to stamp totals would
 *     defeat the point of chunking. See the DB-gap note in the handover.
 *
 * VARIANCE (spec-architecture §6, threat T-07 "variance flag >25%")
 *   Two different thresholds exist and must not be confused:
 *     run level      `payroll_runs.variance_vs_previous_pct`, >±10% blocks
 *                    approval unless acknowledged with a reason — enforced by
 *                    `trg_payroll_runs__two_person` (022), not here.
 *     employee level >±25% net pay vs that employee's previous released payslip
 *                    → a REVIEW exception, recorded as
 *                    `payroll_run_employees.status = 'held'` with a
 *                    `hold_reason`, which is what `exception_count` counts and
 *                    what the admin Exceptions tab lists. Held rows do not block
 *                    approval; `error` rows do.
 *   `variance_pct` is a signed DELTA, not a proportion: it is legitimately
 *   outside [0,100] (a doubled net pay is +100%), so it is NOT validated with
 *   `common.percent`.
 *
 * IDEMPOTENCY
 *   One key per CALL, not per run: each chunk is a distinct request with a
 *   distinct outcome. Replaying a chunk's key replays that chunk's response and
 *   advances nothing. The run itself is idempotent by construction —
 *   `compute_payslip` upserts one payslip per (run, employee).
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  conflict,
  forbidden,
  isProblem,
  locked,
  methodNotAllowed,
  notFound,
  ok,
  toProblem,
} from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { nowIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { requireCapWithStepUp, verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { auditJobRun } from "../_shared/audit.ts";
import {
  claim,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";
import type { Sql } from "../_shared/deps.ts";

const FN_NAME = "payroll-run";
const CAP = "payroll.run.execute";
/** `job_runs.job_code`. No `cron_jobs` row exists for it, so `cron_job_id` stays NULL — permitted. */
const JOB_CODE = "payroll_run";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** `public.payroll_run_status` values from which compute is legal (023 §1/§2). */
const COMPUTABLE_STATUSES = ["draft", "inputs_locked", "computed", "in_review", "failed"] as const;
/** Fallback when `payroll.employee_variance_flag_pct` is not configured (T-07). */
const DEFAULT_VARIANCE_FLAG_PCT = 25;
const DEFAULT_CHUNK_SIZE = 40;

const RunBody = z
  .object({
    payroll_run_id: common.uuid,
    /**
     * Mandatory: `public.payroll_runs`, `public.pay_periods` and
     * `public.attendance_locks` are all in `audit.reason_required_tables` (006),
     * so every statement below reaches `audit.log_changes()` and a missing
     * `app.reason` aborts the transaction. Better a 422 than a 500.
     */
    reason: common.reason,
    /** Employees per invocation. Lower it if the run is timing out. */
    chunk_size: z.number().int().min(1).max(200).optional(),
  })
  .strict();

// ── Row shapes (postgres.js hydration) ──────────────────────────────────────
// `int8`/`numeric` arrive as STRINGS from postgres.js — never assume `number`.

interface RunRow {
  id: string;
  company_id: string;
  run_number: string;
  run_kind: string;
  status: string;
  pay_period_id: string;
  inputs_locked_at: Date | null;
  attendance_lock_id: string | null;
  computed_by: string | null;
  period_code: string;
  period_name: string;
  start_date: string;
  end_date: string;
  financial_year: string;
}

interface EligibleRow {
  id: string;
  employee_code: string;
}

interface JobProgress {
  cursor: number;
  computed: number;
  errors: number;
  total: number;
  chunks: number;
}

interface VarianceFlag {
  employee_id: string;
  employee_code: string;
  current_net_paise: number;
  previous_net_paise: number;
  variance_pct: number;
}

/** postgres.js gives `int8`/`numeric` as text; `null` stays `null`. */
function asNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asNumOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** SQLSTATE of a postgres.js error, when there is one. */
function pgCode(err: unknown): string | null {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/**
 * Turn the SQLSTATEs the payroll layer raises into the documented statuses,
 * without ever putting a driver message on the wire (errors.ts rule 2).
 */
function mapPgError(err: unknown): never {
  if (isProblem(err)) throw err;
  switch (pgCode(err)) {
    case "55P03": // lock_not_available — another chunk holds this run
      throw conflict(
        "This payroll run is already being processed. Wait for the current step to finish.",
        "PAYROLL_RUN_IN_PROGRESS",
        { cause: err },
      );
    case "0A000": // feature_not_supported — guard refused the state transition
      throw conflict(
        "This payroll run is closed, cancelled or past approval; it can no longer be computed.",
        "PAYROLL_RUN_NOT_MUTABLE",
        { cause: err },
      );
    case "23514": // check_violation — a payroll guard rejected the write
      throw conflict(
        "The payroll engine refused this change. Resolve the run's exceptions and retry.",
        "PAYROLL_GUARD_REFUSED",
        { cause: err },
      );
    case "42501":
      throw forbidden("You do not have permission to compute this payroll run.", "CAP_REQUIRED", {
        cause: err,
      });
    default:
      throw err;
  }
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

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model U) ─────────────────────────────────────────────
    const auth = await verifyUser(req);
    const pool = sql();

    // ── STEP 5 · Authority: capability + step-up, both from the DB ──────────
    // `role_capabilities.requires_step_up` is `true` for this capability
    // (migration 050 §2), so this is the U+ enforcement point.
    await requireCapWithStepUp(pool, auth, CAP);

    // ── STEP 6 · Rate limit (outside the business transaction) ──────────────
    //
    // TWO TIERS, because this endpoint is called in a loop by design.
    // `heavyJob` is 4 burst + 2/min — correct for STARTING a payroll run, and
    // fatal for a chunked one: a 400-employee run is ten calls and would spend
    // four minutes sitting in 429s. So the per-call limit is the ordinary
    // `mutation` bucket, and the `heavyJob` token is taken further down, only
    // when a NEW job is begun (see 9c). Concurrency is not what protects this
    // endpoint anyway — the `FOR UPDATE NOWAIT` on the run row is.
    await enforce(RATE_LIMITS.mutation, limitKey(FN_NAME, auth.userId), "PAYROLL_RATE_LIMITED", pool);

    // ── STEP 7 · Validate ──────────────────────────────────────────────────
    const { data: body, raw } = await parseBody(req, RunBody, { maxBytes: 8 * 1024 });
    const chunkSize = body.chunk_size ?? DEFAULT_CHUNK_SIZE;

    // ── STEP 8 · Idempotency claim ─────────────────────────────────────────
    idempotencyKey = requireIdempotencyKey(req);
    const hash = await requestHash(FN_NAME, raw, auth.userId);
    const claimed = await claim(
      { key: idempotencyKey, fnName: FN_NAME, requestHash: hash, actorId: auth.userId },
      pool,
    );
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { key: idempotencyKey, payroll_run_id: body.payroll_run_id });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    // ── STEP 9 · app.set_context + ONE transaction ─────────────────────────
    const ctx: RequestContext = {
      actorId: auth.userId,
      actorRole: auth.role,
      source: "web_admin",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      reason: body.reason,
    };

    const outcome = await withContext(ctx, async (tx) => {
      // 9a · Take the run row. NOWAIT, so a second chunk arriving while this one
      // is still working gets an immediate 409 instead of piling up connections.
      // `compute_payslip`/`compute_payroll_run` also `SELECT … FOR UPDATE` this
      // row; holding it here first makes those re-locks free.
      const runRows = await tx<RunRow[]>`
        SELECT r.id,
               r.company_id,
               r.run_number,
               r.run_kind,
               r.status::text          AS status,
               r.pay_period_id,
               r.inputs_locked_at,
               r.attendance_lock_id,
               r.computed_by,
               pp.code                 AS period_code,
               pp.name                 AS period_name,
               -- ::text deliberately: postgres.js hydrates a date column to a JS
               -- Date, and these values are both echoed in the response and
               -- passed back as $n::date parameters. A YYYY-MM-DD string does
               -- both correctly; a Date object does neither predictably.
               -- (No backticks in SQL comments: this is a template literal.)
               pp.start_date::text     AS start_date,
               pp.end_date::text       AS end_date,
               pp.financial_year
          FROM public.payroll_runs r
          JOIN public.pay_periods  pp ON pp.id = r.pay_period_id
         WHERE r.id = ${body.payroll_run_id}::uuid
         FOR UPDATE OF r NOWAIT
      `;
      const run = firstRow(runRows);
      // 404, not 403: §4 "never exists-but-forbidden".
      if (run === null) throw notFound(undefined, "PAYROLL_RUN_NOT_FOUND");

      if (run.status === "cancelled" || run.status === "closed") {
        throw conflict(
          `Run ${run.run_number} is ${run.status}; corrections require an arrears run.`,
          "PAYROLL_RUN_NOT_MUTABLE",
        );
      }
      if (!(COMPUTABLE_STATUSES as readonly string[]).includes(run.status)) {
        // approved / disbursement_pending / paid — past the point of recompute.
        throw locked(
          `Run ${run.run_number} is ${run.status}; compute is only allowed before approval.`,
          "PAYROLL_RUN_APPROVED",
        );
      }

      // 9b · Lock the inputs. Idempotent: an existing live company-scope lock
      // covering the period is REUSED rather than duplicated, because a second
      // overlapping lock would have to be unlocked twice.
      let attendanceLockId = run.attendance_lock_id;
      let lockCreated = false;
      if (run.inputs_locked_at === null || attendanceLockId === null) {
        if (attendanceLockId === null) {
          const existing = await tx<{ id: string }[]>`
            SELECT al.id
              FROM public.attendance_locks al
             WHERE al.company_id = ${run.company_id}::uuid
               AND al.unlocked_at IS NULL
               AND al.scope = 'company'
               AND al.from_date <= ${run.start_date}::date
               AND al.to_date   >= ${run.end_date}::date
             ORDER BY al.locked_at DESC
             LIMIT 1
          `;
          const found = firstRow(existing);
          if (found !== null) {
            attendanceLockId = found.id;
          } else {
            const inserted = await tx<{ id: string }[]>`
              INSERT INTO public.attendance_locks
                (company_id, scope, pay_period_id, from_date, to_date, lock_kind, reason, locked_by)
              VALUES (
                ${run.company_id}::uuid,
                'company',
                ${run.pay_period_id}::uuid,
                ${run.start_date}::date,
                ${run.end_date}::date,
                'soft',
                ${`Payroll inputs locked for run ${run.run_number}: ${body.reason}`},
                ${auth.userId}::uuid
              )
              RETURNING id
            `;
            attendanceLockId = (firstRow(inserted) as { id: string }).id;
            lockCreated = true;
          }
        }

        await tx`
          UPDATE public.pay_periods
             SET attendance_locked_at = COALESCE(attendance_locked_at, now())
           WHERE id = ${run.pay_period_id}::uuid
        `;

        // `status` only moves forward out of draft/failed: a run already
        // `computed` must not be walked backwards by a resumed chunk.
        await tx`
          UPDATE public.payroll_runs
             SET inputs_locked_at   = COALESCE(inputs_locked_at, now()),
                 attendance_lock_id = COALESCE(attendance_lock_id, ${attendanceLockId}::uuid),
                 status = CASE WHEN status IN ('draft','failed')
                               THEN 'inputs_locked'::public.payroll_run_status
                               ELSE status END
           WHERE id = ${run.id}::uuid
        `;
      }

      // 9c · Claim or RESUME the job. `app.job_begin` returns NULL when the
      // partial unique index `uq_job_runs__running_lock` already holds this
      // lock_key — which for us is not "someone else is running", it is "this is
      // my next chunk". The running row carries the cursor in `result`.
      const lockKey = `payroll_run:${run.id}`;
      const begun = await tx<{ id: string | null }[]>`
        SELECT app.job_begin(${JOB_CODE}, ${lockKey}) AS id
      `;
      let jobRunId = firstRow(begun)?.id ?? null;
      const progress: JobProgress = { cursor: 0, computed: 0, errors: 0, total: 0, chunks: 0 };
      let resumed = false;

      if (jobRunId === null) {
        const running = await tx<{ id: string; result: unknown }[]>`
          SELECT id, result
            FROM public.job_runs
           WHERE lock_key = ${lockKey}
             AND status = 'running'
           ORDER BY started_at DESC
           LIMIT 1
        `;
        const row = firstRow(running);
        if (row === null) {
          throw conflict(
            "Another payroll job just claimed this run. Retry in a moment.",
            "PAYROLL_RUN_IN_PROGRESS",
          );
        }
        jobRunId = row.id;
        resumed = true;
        const stored = (row.result ?? {}) as Partial<JobProgress>;
        progress.cursor = asNum(stored.cursor);
        progress.computed = asNum(stored.computed);
        progress.errors = asNum(stored.errors);
        progress.chunks = asNum(stored.chunks);
      } else {
        // A NEW job: this is the expensive one. Spend a `heavyJob` token now,
        // on the POOL rather than on `tx` — ratelimit.ts is explicit that a
        // token must not be refunded by a rollback, and `tx` would refund it.
        await enforce(
          RATE_LIMITS.heavyJob,
          limitKey(FN_NAME, auth.userId, run.id),
          "PAYROLL_RATE_LIMITED",
          pool,
        );
        await tx`
          UPDATE public.job_runs
             SET run_kind = 'manual', triggered_by = ${auth.userId}::uuid
           WHERE id = ${jobRunId}::uuid
        `;
      }

      // 9d · The eligible population.
      //
      // MIRROR of `compute_payroll_run` (023 §2, lines 827–842). Chunking needs
      // the list BEFORE any payslip exists, and no DB object exposes it — see
      // the DB-gap note. Keep the predicate byte-for-byte in step with 023: if
      // the two ever disagree, an employee is silently paid or silently skipped.
      const eligible = await tx<EligibleRow[]>`
        WITH run AS (
          SELECT r.company_id, r.employee_filter, pp.start_date, pp.end_date
            FROM public.payroll_runs r
            JOIN public.pay_periods  pp ON pp.id = r.pay_period_id
           WHERE r.id = ${run.id}::uuid
        )
        SELECT e.id, e.employee_code
          FROM public.employees e
          CROSS JOIN run
         WHERE e.company_id = run.company_id
           AND e.deleted_at IS NULL
           AND NOT e.exclude_from_payroll
           AND e.employment_status <> 'pre_joining'
           AND e.date_of_join IS NOT NULL
           AND e.date_of_join <= run.end_date
           AND (e.last_working_day IS NULL OR e.last_working_day >= run.start_date)
           AND (run.employee_filter IS NULL
                OR ((NOT run.employee_filter ? 'employee_ids'
                     OR e.id::text IN (SELECT jsonb_array_elements_text(run.employee_filter -> 'employee_ids')))
                AND (NOT run.employee_filter ? 'department_ids'
                     OR e.department_id::text IN (SELECT jsonb_array_elements_text(run.employee_filter -> 'department_ids')))))
         ORDER BY e.employee_code
      `;
      progress.total = eligible.length;

      if (progress.total === 0) {
        // Nothing to compute is a real answer, not a failure: the filter matched
        // no one. Close the job so the lock_key is released.
        await tx`
          SELECT app.job_end(${jobRunId}::uuid, 'succeeded'::public.job_run_status,
                             0::integer, 0::integer,
                             ${JSON.stringify({ ...progress, done: true })}::jsonb, NULL)
        `;
        await auditJobRun(tx, ctx, {
          jobCode: JOB_CODE,
          runId: jobRunId,
          outcome: "succeeded",
          stats: { payroll_run_id: run.id, eligible: 0 },
        });
        return {
          run,
          jobRunId,
          mode: "single_shot" as const,
          resumed,
          progress,
          done: true,
          failures: [] as { employee_id: string; employee_code: string; detail: string }[],
          flags: [] as VarianceFlag[],
          thresholdPct: DEFAULT_VARIANCE_FLAG_PCT,
          attendanceLockId,
          lockCreated,
        };
      }

      // 9e · Compute.
      const singleShot = progress.cursor === 0 && progress.total <= chunkSize;
      const failures: { employee_id: string; employee_code: string; detail: string }[] = [];

      if (singleShot) {
        // The catalogue's path: one call, DB-side per-employee error handling,
        // DB-side totals + variance + status stamp. Nothing mirrored.
        const summary = await tx<{ summary: Record<string, unknown> }[]>`
          SELECT public.compute_payroll_run(${run.id}::uuid) AS summary
        `;
        const s = (firstRow(summary)?.summary ?? {}) as Record<string, unknown>;
        progress.computed = asNum(s.computed);
        progress.errors = asNum(s.errors);
        progress.cursor = progress.total;
      } else {
        const slice = eligible.slice(progress.cursor, progress.cursor + chunkSize);
        for (const emp of slice) {
          // One SAVEPOINT per employee: `compute_payslip` raises for a missing
          // salary revision, a below-minimum-wage grade and so on, and one bad
          // employee must not abort the other 39. This is the edge equivalent of
          // the `BEGIN … EXCEPTION WHEN OTHERS` block in 023 §2.
          await tx.unsafe("SAVEPOINT payroll_emp");
          try {
            await tx`SELECT public.compute_payslip(${emp.id}::uuid, ${run.id}::uuid)`;
            await tx.unsafe("RELEASE SAVEPOINT payroll_emp");
            progress.computed += 1;
          } catch (err) {
            await tx.unsafe("ROLLBACK TO SAVEPOINT payroll_emp");
            await tx.unsafe("RELEASE SAVEPOINT payroll_emp");
            progress.errors += 1;
            const detail = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
            await tx`
              INSERT INTO public.payroll_run_employees AS pre
                     (payroll_run_id, employee_id, status, error_detail, retry_count)
              VALUES (${run.id}::uuid, ${emp.id}::uuid, 'error', ${detail}, 1)
              ON CONFLICT (payroll_run_id, employee_id) DO UPDATE
                SET status      = 'error',
                    error_detail = EXCLUDED.error_detail,
                    retry_count  = pre.retry_count + 1,
                    payslip_id   = NULL,
                    computed_at  = NULL,
                    hold_reason  = NULL
            `;
            failures.push({ employee_id: emp.id, employee_code: emp.employee_code, detail });
          }
        }
        progress.cursor += slice.length;
      }
      progress.chunks += 1;
      const done = progress.cursor >= progress.total;

      // 9f · On the final chunk of a CHUNKED run, stamp the run header.
      // MIRROR of 023 §2 lines 860–898 (`compute_payroll_run` already did this
      // for the single-shot path, so it is skipped there).
      if (done && !singleShot) {
        await tx`
          WITH t AS (
            SELECT COALESCE(SUM(p.gross_earnings_paise), 0)   AS gross,
                   COALESCE(SUM(p.total_deductions_paise), 0) AS ded,
                   COALESCE(SUM(p.net_pay_paise), 0)          AS net,
                   COALESCE(SUM(p.gross_earnings_paise + p.employer_contributions_paise), 0) AS er_cost,
                   COUNT(*)                                  AS n
              FROM public.payslips p
              JOIN public.payroll_run_employees pre
                ON pre.payroll_run_id = p.payroll_run_id AND pre.payslip_id = p.id
             WHERE p.payroll_run_id = ${run.id}::uuid
               AND pre.status IN ('computed','held')
          ),
          prev AS (
            SELECT r.total_net_paise
              FROM public.payroll_runs r
              JOIN public.pay_periods  pp ON pp.id = r.pay_period_id
             WHERE r.company_id = ${run.company_id}::uuid
               AND r.id <> ${run.id}::uuid
               AND r.run_kind = 'regular'
               AND r.status IN ('approved','disbursement_pending','paid','closed')
               AND pp.start_date < ${run.start_date}::date
             ORDER BY pp.start_date DESC
             LIMIT 1
          )
          UPDATE public.payroll_runs r
             SET status                    = 'computed',
                 computed_at               = now(),
                 computed_by               = COALESCE(app.ctx_actor_id(), r.computed_by),
                 employee_count            = t.n,
                 total_gross_paise         = t.gross,
                 total_deductions_paise    = t.ded,
                 total_net_paise           = t.net,
                 total_employer_cost_paise = t.er_cost,
                 variance_vs_previous_pct  = CASE
                   WHEN prev.total_net_paise IS NULL OR prev.total_net_paise = 0 THEN NULL
                   ELSE round((t.net - prev.total_net_paise) * 100.0 / prev.total_net_paise, 4)
                 END,
                 exception_count = (SELECT COUNT(*) FROM public.payroll_run_employees pre
                                     WHERE pre.payroll_run_id = ${run.id}::uuid
                                       AND pre.status IN ('error','held'))
            FROM t LEFT JOIN prev ON true
           WHERE r.id = ${run.id}::uuid
        `;
      }

      // 9g · Per-employee variance review flags (>±25% net vs the employee's own
      // previous RELEASED payslip). Only once the run is complete — flagging a
      // half-computed run would flag everyone who has not been computed yet.
      let flags: VarianceFlag[] = [];
      const thresholdRows = await tx<{ pct: string }[]>`
        SELECT COALESCE(
                 (public.setting_value('payroll.employee_variance_flag_pct',
                                       ${run.company_id}::uuid) #>> '{}')::numeric,
                 ${DEFAULT_VARIANCE_FLAG_PCT}::numeric
               ) AS pct
      `;
      const thresholdPct = asNumOrNull(firstRow(thresholdRows)?.pct) ?? DEFAULT_VARIANCE_FLAG_PCT;

      if (done) {
        const flagRows = await tx<
          {
            employee_id: string;
            employee_code: string;
            cur_net_paise: string;
            prev_net_paise: string;
            variance_pct: string;
          }[]
        >`
          WITH cur AS (
            SELECT p.id, p.employee_id, p.net_pay_paise, pp.start_date
              FROM public.payslips p
              JOIN public.pay_periods pp ON pp.id = p.pay_period_id
             WHERE p.payroll_run_id = ${run.id}::uuid
               AND NOT p.is_reversed
          )
          SELECT c.employee_id,
                 e.employee_code,
                 c.net_pay_paise  AS cur_net_paise,
                 pv.net_pay_paise AS prev_net_paise,
                 round((c.net_pay_paise - pv.net_pay_paise) * 100.0 / pv.net_pay_paise, 2) AS variance_pct
            FROM cur c
            JOIN public.employees e ON e.id = c.employee_id
            CROSS JOIN LATERAL (
              SELECT p2.net_pay_paise
                FROM public.payslips p2
                JOIN public.pay_periods pp2 ON pp2.id = p2.pay_period_id
               WHERE p2.employee_id = c.employee_id
                 AND p2.id <> c.id
                 AND NOT p2.is_reversed
                 AND pp2.start_date < c.start_date
                 AND public.payroll_run_is_released(p2.payroll_run_id)
               ORDER BY pp2.start_date DESC
               LIMIT 1
            ) pv
           WHERE pv.net_pay_paise <> 0
             AND abs((c.net_pay_paise - pv.net_pay_paise) * 100.0 / pv.net_pay_paise) > ${thresholdPct}::numeric
           ORDER BY abs((c.net_pay_paise - pv.net_pay_paise) * 100.0 / pv.net_pay_paise) DESC
        `;

        flags = flagRows.map((r) => ({
          employee_id: r.employee_id,
          employee_code: r.employee_code,
          current_net_paise: asNum(r.cur_net_paise),
          previous_net_paise: asNum(r.prev_net_paise),
          variance_pct: asNum(r.variance_pct),
        }));

        for (const flag of flags) {
          const sign = flag.variance_pct > 0 ? "+" : "";
          const note = `VARIANCE_HIGH: net pay ${sign}${flag.variance_pct}% vs previous period ` +
            `(threshold ${thresholdPct}%)`;
          // `held`, not `error`: a variance is a REVIEW exception. It counts in
          // exception_count and must be annotated before gate 3, but it does not
          // block approval the way an `error` row does (022 guard).
          // Existing hold reasons (zero paid days, missing bank account) are
          // preserved — the flag is appended, never overwritten, and re-running
          // the flag pass does not duplicate the note.
          await tx`
            UPDATE public.payroll_run_employees pre
               SET status = CASE WHEN pre.status = 'computed' THEN 'held' ELSE pre.status END,
                   hold_reason = CASE
                     WHEN pre.hold_reason IS NULL THEN ${note}
                     WHEN position(${"VARIANCE_HIGH"} in pre.hold_reason) > 0 THEN pre.hold_reason
                     ELSE pre.hold_reason || '; ' || ${note}
                   END
             WHERE pre.payroll_run_id = ${run.id}::uuid
               AND pre.employee_id    = ${flag.employee_id}::uuid
               AND pre.status IN ('computed','held')
          `;
        }

        if (flags.length > 0) {
          await tx`
            UPDATE public.payroll_runs
               SET exception_count = (SELECT COUNT(*) FROM public.payroll_run_employees pre
                                       WHERE pre.payroll_run_id = ${run.id}::uuid
                                         AND pre.status IN ('error','held'))
             WHERE id = ${run.id}::uuid
          `;
        }
      }

      // 9h · Persist the cursor (resume point) or close the job.
      const jobResult = {
        ...progress,
        done,
        payroll_run_id: run.id,
        run_number: run.run_number,
        variance_flags: flags.length,
        variance_threshold_pct: thresholdPct,
      };
      if (done) {
        await tx`
          SELECT app.job_end(${jobRunId}::uuid,
                             ${progress.errors > 0 ? "failed" : "succeeded"}::public.job_run_status,
                             ${progress.computed}::integer,
                             ${progress.errors}::integer,
                             ${JSON.stringify(jobResult)}::jsonb,
                             ${progress.errors > 0
            ? `${progress.errors} employee(s) failed to compute`
            : null}::text)
        `;
        // ── STEP 10 · Audit, same transaction ─────────────────────────────
        // `public.job_runs` is deliberately NOT trigger-audited, so this is the
        // only way a payroll compute appears on the hash chain as an event.
        // The row changes themselves (payroll_runs, payroll_run_employees,
        // payslips, attendance_locks, pay_periods) are already audited by
        // `audit.log_changes()` — not repeated here.
        await auditJobRun(tx, ctx, {
          jobCode: JOB_CODE,
          runId: jobRunId,
          outcome: progress.errors > 0 ? "failed" : "succeeded",
          stats: jobResult,
        });
      } else {
        await tx`
          UPDATE public.job_runs
             SET result            = ${JSON.stringify(jobResult)}::jsonb,
                 records_processed = ${progress.computed}::integer,
                 records_failed    = ${progress.errors}::integer
           WHERE id = ${jobRunId}::uuid
        `;
      }

      return {
        run,
        jobRunId,
        mode: singleShot ? ("single_shot" as const) : ("chunked" as const),
        resumed,
        progress,
        done,
        failures,
        flags,
        thresholdPct,
        attendanceLockId,
        lockCreated,
      };
    }).catch(mapPgError);

    // Run header AFTER the transaction committed — the response quotes what is
    // durable, not what was in flight.
    const totalsRows = await pool<
      {
        status: string;
        employee_count: number;
        total_gross_paise: string;
        total_deductions_paise: string;
        total_net_paise: string;
        total_employer_cost_paise: string;
        variance_vs_previous_pct: string | null;
        exception_count: number;
        computed_at: Date | null;
      }[]
    >`
      SELECT status::text AS status,
             employee_count,
             total_gross_paise,
             total_deductions_paise,
             total_net_paise,
             total_employer_cost_paise,
             variance_vs_previous_pct,
             exception_count,
             computed_at
        FROM public.payroll_runs
       WHERE id = ${body.payroll_run_id}::uuid
    `;
    const totals = firstRow(totalsRows);

    const responseBody = {
      payroll_run_id: outcome.run.id,
      run_number: outcome.run.run_number,
      run_kind: outcome.run.run_kind,
      pay_period: {
        id: outcome.run.pay_period_id,
        code: outcome.run.period_code,
        name: outcome.run.period_name,
        start_date: outcome.run.start_date,
        end_date: outcome.run.end_date,
        financial_year: outcome.run.financial_year,
      },
      status: totals?.status ?? outcome.run.status,
      phase: outcome.done ? ("computed" as const) : ("computing" as const),
      done: outcome.done,
      mode: outcome.mode,
      resumed: outcome.resumed,
      inputs: {
        attendance_lock_id: outcome.attendanceLockId,
        lock_created: outcome.lockCreated,
      },
      job_run_id: outcome.jobRunId,
      progress: {
        total: outcome.progress.total,
        processed: outcome.progress.cursor,
        remaining: Math.max(0, outcome.progress.total - outcome.progress.cursor),
        computed: outcome.progress.computed,
        errors: outcome.progress.errors,
        chunks: outcome.progress.chunks,
        chunk_size: chunkSize,
        /** Send the SAME body with a NEW idempotency key to continue. */
        next_cursor: outcome.done ? null : outcome.progress.cursor,
      },
      totals: totals === null ? null : {
        employee_count: totals.employee_count,
        gross_paise: asNum(totals.total_gross_paise),
        deductions_paise: asNum(totals.total_deductions_paise),
        net_paise: asNum(totals.total_net_paise),
        employer_cost_paise: asNum(totals.total_employer_cost_paise),
        /** Signed delta, not a proportion: legitimately outside [0,100]. */
        variance_vs_previous_pct: asNumOrNull(totals.variance_vs_previous_pct),
        exception_count: totals.exception_count,
        computed_at: totals.computed_at === null ? null : totals.computed_at,
      },
      variance: {
        threshold_pct: outcome.thresholdPct,
        flagged_count: outcome.flags.length,
        flags: outcome.flags,
      },
      failures: outcome.failures,
      server_time: nowIso(),
      requestId,
    };
    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ─────────────
    await store(idempotencyKey, status, responseBody, pool);

    log.info("payroll compute chunk complete", {
      payroll_run_id: outcome.run.id,
      job_run_id: outcome.jobRunId,
      mode: outcome.mode,
      done: outcome.done,
      processed: outcome.progress.cursor,
      total: outcome.progress.total,
      errors: outcome.progress.errors,
      variance_flags: outcome.flags.length,
    });

    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    if (idempotencyKey !== null) {
      try {
        // 5xx is not a deterministic answer: free the key so the retry does real
        // work. A 4xx is deterministic and worth replaying.
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, problem.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }

    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported for `supabase/tests` and the admin client — one schema, one contract. */
export { RunBody };

/**
 * The eligible population for a run, without computing anything. Not used by the
 * handler; exported so a pgTAP/integration test can assert that this predicate
 * and `public.compute_payroll_run` (023 §2) select the SAME employees.
 */
export async function eligibleEmployeeCodes(
  client: Sql,
  payrollRunId: string,
): Promise<string[]> {
  const rows = await client<{ employee_code: string }[]>`
    WITH run AS (
      SELECT r.company_id, r.employee_filter, pp.start_date, pp.end_date
        FROM public.payroll_runs r
        JOIN public.pay_periods  pp ON pp.id = r.pay_period_id
       WHERE r.id = ${payrollRunId}::uuid
    )
    SELECT e.employee_code
      FROM public.employees e
      CROSS JOIN run
     WHERE e.company_id = run.company_id
       AND e.deleted_at IS NULL
       AND NOT e.exclude_from_payroll
       AND e.employment_status <> 'pre_joining'
       AND e.date_of_join IS NOT NULL
       AND e.date_of_join <= run.end_date
       AND (e.last_working_day IS NULL OR e.last_working_day >= run.start_date)
     ORDER BY e.employee_code
  `;
  return rows.map((r) => r.employee_code);
}
