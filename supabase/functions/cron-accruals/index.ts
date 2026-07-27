/**
 * cron-accruals — catalogue #22, auth model **C** (cron secret, constant-time, or
 * a service-role bearer for a manual/backfill run).
 *
 * Two jobs that must happen in ONE order on one morning of the year, which is why
 * they share a function:
 *
 *   1. FY ROLLOVER — only on 01-Apr IST. Closes the outgoing financial year for
 *      every (company × leave type × employee): carries the closing balance
 *      forward up to `leave_types.max_carry_forward_days`, LAPSES the excess
 *      loudly (a `lapse` ledger row, never a silent truncation), and records the
 *      run in `public.leave_year_rollovers`.
 *   2. MONTHLY ACCRUAL — `public.accrue_leave(p_as_of, p_dry_run)` (migration 019
 *      §13), which also does the pro-rata-on-join arithmetic (Karnataka S&E
 *      earned leave = 1 day per 20 days worked, and a joiner mid-month gets
 *      `days × paid_days / days_in_month` as `pro_rata_accrual`).
 *
 * ORDER IS LOAD-BEARING. `accrue_leave` files April's credit under
 * `leave_year_of(01-Apr) = the NEW year`. If the accrual ran first, the rollover's
 * "closing balance of the old year" would be read after a credit had already
 * landed in the new one — harmless in the arithmetic, misleading in the
 * `leave_year_rollovers` report. Rollover first, then accrue.
 *
 * WHY THE ACCRUAL FORMULA IS NOT HERE: `accrue_leave` owns eligibility (gender
 * restriction, employment type, `accrual_start_after_months`), the working-days
 * basis, the pro-rata fraction and the `max_balance_days` cap, and it is
 * idempotent through `uq_leave_ledger__accrual_once`. A second implementation in
 * TypeScript would drift from it. This function decides only WHEN it runs and
 * reports WHAT it did.
 *
 * WHY THE ROLLOVER *IS* HERE: migrations 001–050 contain no rollover function —
 * `leave_year_rollovers` is a table with no writer. The arithmetic below is
 * therefore new code, kept strictly ledger-first: every day carried, lapsed or
 * moved is a `leave_ledger` row, and `leave_balances` is recomputed by the
 * ledger's own statement trigger (019 §8). Nothing writes a balance directly.
 *
 * DATE GUARDS: `pg_cron` fires this daily at 19:30 UTC (= 01:00 IST the next day)
 * and the SQL command in migration 041 carries its own `extract(day …) = 1`
 * guard. An edge function has no such WHERE clause, so the guard lives here:
 * accrual runs on IST day-of-month 1, rollover on 01-Apr, and `force_*` is the
 * documented override for a re-run.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem, unprocessable } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { addDays, financialYear, istToday } from "../_shared/datetime.ts";
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

const FN_NAME = "cron-accruals";
const DEFAULT_JOB_CODE = "leave_accrual";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** `source_table` on every ledger row this function's rollover writes. */
const ROLLOVER_SOURCE = "leave_year_rollover";
/** Employees whose balance is carried. An exit is settled by payroll, not carried. */
const IN_SERVICE_STATUSES = [
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "on_long_leave",
  "suspended",
] as const;
/** How far back a manual `as_of` may be aimed, in days. */
const MAX_BACKDATE_DAYS = 400;

const AccrualsBody = z
  .object({
    /** `cron_jobs.code`, for the `job_runs` row and the overlap lock key. */
    job_code: z.string().trim().min(2).max(64).optional(),
    /**
     * IST date the run is "as of". Absent = today IST. `accrue_leave` derives the
     * month it accrues FOR (the previous one) from this.
     */
    as_of: common.isoDate.optional(),
    /** Compute and report, write nothing (passes `p_dry_run` through). */
    dry_run: z.boolean().default(false),
    /** Run the accrual even when `as_of` is not the 1st of an IST month. */
    force_accrual: z.boolean().default(false),
    /** Run the FY rollover even when `as_of` is not 01-Apr IST. */
    force_rollover: z.boolean().default(false),
    /** Accrual only; never touch the financial year. */
    skip_rollover: z.boolean().default(false),
    /** Rollover only. */
    skip_accrual: z.boolean().default(false),
  })
  .strict();

// ── FY rollover ─────────────────────────────────────────────────────────────

interface RolloverTypeResult {
  leave_type_id: string;
  leave_type_code: string;
  company_id: string;
  rollover_id: string | null;
  employees_processed: number;
  days_carried: number;
  days_lapsed: number;
  carry_forward_allowed: boolean;
  max_carry_forward_days: number | null;
  /** Months after which carried days expire — recorded, not yet enforced (see notes). */
  carry_forward_expiry_months: number | null;
  skipped: string | null;
}

interface RolloverResult {
  ran: boolean;
  from_leave_year: number | null;
  to_leave_year: number | null;
  financial_year_closed: string | null;
  types: RolloverTypeResult[];
  totals: { employees: number; carried: number; lapsed: number };
  skipped: string | null;
}

function asNum(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function asCount(value: unknown): number {
  return Math.trunc(asNum(value));
}

interface LeaveTypeRow {
  id: string;
  company_id: string;
  code: string;
  carry_forward_allowed: boolean;
  max_carry_forward_days: string | null;
  carry_forward_expiry_months: number | null;
}

/**
 * Every non-comp-off leave type that could hold a balance.
 *
 * `is_comp_off` is EXCLUDED on purpose: a comp-off day is backed by a row in
 * `public.comp_off_ledger` with its own `expires_on`, and `expire_comp_off()`
 * (019 §14) is the only thing allowed to end its life. Carrying the mirrored
 * `leave_ledger` days into a new financial year would create leave that no
 * comp-off credit backs.
 */
async function rolloverTypes(client: Sql): Promise<LeaveTypeRow[]> {
  const rows = await client<LeaveTypeRow[]>`
    SELECT lt.id,
           lt.company_id,
           lt.code,
           lt.carry_forward_allowed,
           lt.max_carry_forward_days::text AS max_carry_forward_days,
           lt.carry_forward_expiry_months
      FROM public.leave_types lt
      JOIN public.companies c ON c.id = lt.company_id AND c.deleted_at IS NULL
     WHERE lt.deleted_at IS NULL
       AND lt.is_active
       AND NOT lt.is_comp_off
     ORDER BY lt.company_id, lt.sort_order, lt.code
  `;
  return rows as unknown as LeaveTypeRow[];
}

/**
 * Roll one leave type from `fromYear` to `toYear`.
 *
 * THREE ledger writes, each individually guarded by a `NOT EXISTS` on
 * (employee, type, year, entry_type) so a re-run adds nothing:
 *   `carry_forward_out`  −carried, dated the last day of the closing year
 *   `carry_forward_in`   +carried, dated the first day of the opening year
 *   `lapse`              −lapsed,  dated the last day of the closing year
 *
 * The `lapse` guard is additionally scoped to `source_table = 'leave_year_rollover'`
 * because `accrue_leave` also writes `lapse` rows (its `max_balance_days` cap) and
 * those must not make a rollover think it has already run.
 *
 * `ck_ll__days_nonzero` forbids a zero-day row, hence the `> 0` predicates rather
 * than writing zeros for the tidy symmetry.
 *
 * The balance read is `available_days`, NOT `available_after_pending`: a leave
 * request still pending on 31-Mar has not consumed anything, and forfeiting the
 * days because an approver was slow would be the system stealing leave.
 */
async function rolloverOneType(
  tx: Sql,
  type: LeaveTypeRow,
  fromYear: number,
  toYear: number,
  closingDate: string,
  openingDate: string,
  dryRun: boolean,
): Promise<RolloverTypeResult> {
  const cap = type.max_carry_forward_days === null ? null : Number(type.max_carry_forward_days);
  const base: RolloverTypeResult = {
    leave_type_id: type.id,
    leave_type_code: type.code,
    company_id: type.company_id,
    rollover_id: null,
    employees_processed: 0,
    days_carried: 0,
    days_lapsed: 0,
    carry_forward_allowed: type.carry_forward_allowed,
    max_carry_forward_days: cap,
    carry_forward_expiry_months: type.carry_forward_expiry_months,
    skipped: null,
  };

  // Already rolled, for real, by an earlier run: report and touch nothing.
  const existing = await tx<{ id: string }[]>`
    SELECT r.id
      FROM public.leave_year_rollovers r
     WHERE r.company_id = ${type.company_id}::uuid
       AND r.leave_type_id = ${type.id}::uuid
       AND r.from_leave_year = ${fromYear}::integer
       AND r.to_leave_year = ${toYear}::integer
       AND r.status = 'succeeded'
       AND NOT r.dry_run
     LIMIT 1
  `;
  if (firstRow(existing) !== null) {
    return { ...base, skipped: "already_rolled_over", rollover_id: firstRow(existing)?.id ?? null };
  }

  // What WOULD move, computed by the database from the balance cache (which is a
  // pure fold of the ledger, 019 §8) so the preview and the write agree exactly.
  const preview = await tx<Record<string, unknown>[]>`
    SELECT count(*)                          AS employees,
           COALESCE(SUM(x.carried), 0)::text AS carried,
           COALESCE(SUM(x.lapsed), 0)::text  AS lapsed
      FROM (
        SELECT CASE WHEN ${type.carry_forward_allowed}::boolean
                    THEN LEAST(lb.available_days,
                               COALESCE(${cap}::numeric, lb.available_days))
                    ELSE 0 END                                    AS carried,
               lb.available_days
                 - CASE WHEN ${type.carry_forward_allowed}::boolean
                        THEN LEAST(lb.available_days,
                                   COALESCE(${cap}::numeric, lb.available_days))
                        ELSE 0 END                                AS lapsed
          FROM public.leave_balances lb
          JOIN public.employees e ON e.id = lb.employee_id AND e.deleted_at IS NULL
         WHERE lb.leave_type_id = ${type.id}::uuid
           AND lb.leave_year = ${fromYear}::integer
           AND lb.available_days > 0
           AND e.employment_status = ANY (${[...IN_SERVICE_STATUSES]}::public.employment_status[])
      ) x
  `;
  const previewRow = firstRow(preview);
  const employees = asCount(previewRow?.employees);
  const carriedTotal = asNum(previewRow?.carried);
  const lapsedTotal = asNum(previewRow?.lapsed);

  if (dryRun) {
    return {
      ...base,
      employees_processed: employees,
      days_carried: carriedTotal,
      days_lapsed: lapsedTotal,
      skipped: "dry_run",
    };
  }

  const created = await tx<{ id: string }[]>`
    INSERT INTO public.leave_year_rollovers
      (company_id, leave_type_id, from_leave_year, to_leave_year, status, dry_run)
    VALUES (${type.company_id}::uuid, ${type.id}::uuid,
            ${fromYear}::integer, ${toYear}::integer, 'running', false)
    RETURNING id
  `;
  const rolloverId = firstRow(created)?.id ?? null;
  if (rolloverId === null) {
    return { ...base, skipped: "rollover_row_not_created" };
  }

  // Movers, resolved once and reused by all three writes so a concurrent balance
  // change cannot make the three rows disagree (they share this transaction).
  const movers = `
    WITH movers AS (
      SELECT lb.employee_id,
             lb.available_days                                              AS closing,
             CASE WHEN $1::boolean
                  THEN LEAST(lb.available_days, COALESCE($2::numeric, lb.available_days))
                  ELSE 0 END                                                AS carried
        FROM public.leave_balances lb
        JOIN public.employees e ON e.id = lb.employee_id AND e.deleted_at IS NULL
       WHERE lb.leave_type_id = $3::uuid
         AND lb.leave_year = $4::integer
         AND lb.available_days > 0
         AND e.employment_status = ANY ($5::public.employment_status[])
    )`;
  const moverParams = [
    type.carry_forward_allowed,
    cap,
    type.id,
    fromYear,
    [...IN_SERVICE_STATUSES],
  ];

  const outRows = await tx.unsafe(
    `${movers}
     INSERT INTO public.leave_ledger
       (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
        description, source_table, source_id)
     SELECT m.employee_id, $3::uuid, $4::integer, 'carry_forward_out', -m.carried, $6::date,
            'Carried forward to FY ' || $7::text, $8::text, $9::uuid
       FROM movers m
      WHERE m.carried > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.leave_ledger ll
           WHERE ll.employee_id = m.employee_id
             AND ll.leave_type_id = $3::uuid
             AND ll.leave_year = $4::integer
             AND ll.entry_type = 'carry_forward_out')
     RETURNING 1`,
    [...moverParams, closingDate, `${toYear}-${String((toYear + 1) % 100).padStart(2, "0")}`, ROLLOVER_SOURCE, rolloverId],
  );

  const inRows = await tx.unsafe(
    `${movers}
     INSERT INTO public.leave_ledger
       (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
        description, source_table, source_id)
     SELECT m.employee_id, $3::uuid, $6::integer, 'carry_forward_in', m.carried, $7::date,
            'Carried forward from FY ' || $8::text, $9::text, $10::uuid
       FROM movers m
      WHERE m.carried > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.leave_ledger ll
           WHERE ll.employee_id = m.employee_id
             AND ll.leave_type_id = $3::uuid
             AND ll.leave_year = $6::integer
             AND ll.entry_type = 'carry_forward_in')
     RETURNING 1`,
    [
      ...moverParams,
      toYear,
      openingDate,
      `${fromYear}-${String((fromYear + 1) % 100).padStart(2, "0")}`,
      ROLLOVER_SOURCE,
      rolloverId,
    ],
  );

  const lapseRows = await tx.unsafe(
    `${movers}
     INSERT INTO public.leave_ledger
       (employee_id, leave_type_id, leave_year, entry_type, days, effective_date,
        description, source_table, source_id)
     SELECT m.employee_id, $3::uuid, $4::integer, 'lapse', -(m.closing - m.carried), $6::date,
            CASE WHEN $1::boolean
                 THEN 'Lapsed at financial year end above the carry-forward cap'
                 ELSE 'Lapsed at financial year end (carry forward not allowed for this type)'
            END,
            $7::text, $8::uuid
       FROM movers m
      WHERE (m.closing - m.carried) > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.leave_ledger ll
           WHERE ll.employee_id = m.employee_id
             AND ll.leave_type_id = $3::uuid
             AND ll.leave_year = $4::integer
             AND ll.entry_type = 'lapse'
             AND ll.source_table = $7::text)
     RETURNING 1`,
    [...moverParams, closingDate, ROLLOVER_SOURCE, rolloverId],
  );

  const carriedRows = (outRows as unknown as unknown[]).length;
  const lapsedRows = (lapseRows as unknown as unknown[]).length;
  const movedIn = (inRows as unknown as unknown[]).length;

  // Actuals, read back from the ledger rows this run wrote. Reporting the preview
  // would over-report whenever a guard suppressed a row.
  const actual = await tx<Record<string, unknown>[]>`
    SELECT COALESCE(ABS(SUM(ll.days) FILTER (WHERE ll.entry_type = 'carry_forward_out')), 0)::text AS carried,
           COALESCE(ABS(SUM(ll.days) FILTER (WHERE ll.entry_type = 'lapse')), 0)::text             AS lapsed,
           count(DISTINCT ll.employee_id)                                                          AS employees
      FROM public.leave_ledger ll
     WHERE ll.source_table = ${ROLLOVER_SOURCE}
       AND ll.source_id = ${rolloverId}::uuid
       AND ll.leave_year = ${fromYear}::integer
  `;
  const actualRow = firstRow(actual);
  const daysCarried = asNum(actualRow?.carried);
  const daysLapsed = asNum(actualRow?.lapsed);
  const processed = asCount(actualRow?.employees);

  await tx`
    UPDATE public.leave_year_rollovers
       SET status = 'succeeded',
           employees_processed = ${processed}::integer,
           days_carried = ${daysCarried}::numeric,
           days_lapsed = ${daysLapsed}::numeric,
           days_encashed = 0,
           report = ${JSON.stringify({
    leave_type_code: type.code,
    carry_forward_allowed: type.carry_forward_allowed,
    max_carry_forward_days: cap,
    carry_forward_expiry_months: type.carry_forward_expiry_months,
    eligible_employees: employees,
    preview_carried: carriedTotal,
    preview_lapsed: lapsedTotal,
    rows_written: { carry_forward_out: carriedRows, carry_forward_in: movedIn, lapse: lapsedRows },
    closing_date: closingDate,
    opening_date: openingDate,
  })}::jsonb
     WHERE id = ${rolloverId}::uuid
  `;

  return {
    ...base,
    rollover_id: rolloverId,
    employees_processed: processed,
    days_carried: daysCarried,
    days_lapsed: daysLapsed,
  };
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
    // authority. Nothing further to derive.

    const rawBody = await readRawBody(req, { maxBytes: 8 * 1024, requireJsonContentType: false });
    const decoded = rawBody === "" ? {} : decodeJson(rawBody);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    await enforce(RATE_LIMITS.heavyJob, limitKey(FN_NAME, "cron"), "ACCRUAL_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const body = parse(AccrualsBody, decoded, "accrual request");
    jobCode = body.job_code ?? DEFAULT_JOB_CODE;

    const today = istToday();
    const asOf = body.as_of ?? today;
    if (asOf > today) {
      throw unprocessable(
        [{ pointer: "/as_of", code: "too_big", detail: "Leave cannot be accrued for a future date." }],
        "`as_of` must be today IST or earlier.",
        "AS_OF_IN_FUTURE",
      );
    }
    if (asOf < addDays(today, -MAX_BACKDATE_DAYS)) {
      throw unprocessable(
        [{
          pointer: "/as_of",
          code: "too_small",
          detail: `\`as_of\` may not be more than ${MAX_BACKDATE_DAYS} days old.`,
        }],
        "That accrual date is too far in the past.",
        "AS_OF_TOO_OLD",
      );
    }

    const month = Number(asOf.slice(5, 7));
    const dayOfMonth = Number(asOf.slice(8, 10));
    const isFirstOfMonth = dayOfMonth === 1;
    const isFirstOfApril = isFirstOfMonth && month === 4;

    const wantAccrual = !body.skip_accrual && (isFirstOfMonth || body.force_accrual);
    const wantRollover = !body.skip_rollover && (isFirstOfApril || body.force_rollover);

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // Keyed to the accrual date: a `pg_net` retry replays the stored answer. The
    // DB guards (`uq_leave_ledger__accrual_once` and the rollover `NOT EXISTS`
    // predicates) are the real protection; this only saves the work.
    if (!body.dry_run) {
      idempotencyKey = idempotencyKeyFrom(req) ??
        `${FN_NAME}:${asOf}:${wantAccrual ? "a" : "-"}${wantRollover ? "r" : "-"}`;
      const hash = await requestHash(FN_NAME, rawBody, asOf);
      const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: hash });
      if (claimed.state === "replay") {
        status = claimed.status;
        log.info("idempotent replay", { key: idempotencyKey });
        return replayResponse(claimed, { ...cors, "x-request-id": requestId });
      }
    }

    const pool = sql();

    // Double-run guard (§9): a concurrent run is a 200, not an error.
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
      reason: `${FN_NAME}: leave accrual and FY rollover as of ${asOf}`,
    };

    // Financial year boundaries. `financialYear()` mirrors `util.financial_year`
    // and `public.leave_year_of`: April basis, so FY 2026-27 has leave_year 2026.
    // The year `as_of` falls IN is the year being OPENED; the one before it is
    // closed. On 01-Apr-2027 that is 2026 → 2027; a forced catch-up run in
    // July 2026 closes 2025 → 2026, which is the last boundary that has passed.
    const toYear = Number(financialYear(asOf).slice(0, 4));
    const fromYear = toYear - 1;
    const closingDate = `${toYear}-03-31`;
    const openingDate = `${toYear}-04-01`;

    const rollover: RolloverResult = {
      ran: false,
      from_leave_year: null,
      to_leave_year: null,
      financial_year_closed: null,
      types: [],
      totals: { employees: 0, carried: 0, lapsed: 0 },
      skipped: wantRollover ? null : (body.skip_rollover ? "skip_rollover" : "not_01_apr_ist"),
    };
    let accrual: unknown = { skipped: wantAccrual ? null : (body.skip_accrual ? "skip_accrual" : "not_first_of_month") };

    // ── STEP 9/10 · One transaction: context, ledger writes, audit ───────────
    // Both halves write `leave_ledger`, whose statement trigger recomputes
    // `leave_balances`; those writes are reason-gated and audit-triggered, so they
    // only work inside the `app.*` context this transaction sets.
    if (wantRollover || wantAccrual) {
      await withContext(ctx, async (tx) => {
        if (wantRollover) {
          rollover.ran = true;
          rollover.from_leave_year = fromYear;
          rollover.to_leave_year = toYear;
          rollover.financial_year_closed = `${fromYear}-${String((fromYear + 1) % 100).padStart(2, "0")}`;
          for (const type of await rolloverTypes(tx)) {
            const result = await rolloverOneType(
              tx,
              type,
              fromYear,
              toYear,
              closingDate,
              openingDate,
              body.dry_run,
            );
            rollover.types.push(result);
            rollover.totals.employees += result.employees_processed;
            rollover.totals.carried += result.days_carried;
            rollover.totals.lapsed += result.days_lapsed;
          }
        }

        if (wantAccrual) {
          // The engine, not a reimplementation of it. `p_dry_run` returns the
          // per-employee `details` array and writes nothing.
          const rows = await tx<{ result: unknown }[]>`
            SELECT public.accrue_leave(${asOf}::date, ${body.dry_run}::boolean) AS result
          `;
          accrual = firstRow(rows)?.result ?? { entries: 0, skipped: 0 };
        }
      });
    }

    const stats = {
      as_of: asOf,
      dry_run: body.dry_run,
      accrual,
      rollover,
    };

    if (jobRunId !== null) {
      await withContext(ctx, async (tx) => {
        const processed = (typeof accrual === "object" && accrual !== null
          ? asCount((accrual as Record<string, unknown>).entries)
          : 0) + rollover.totals.employees;
        await tx`
          SELECT app.job_end(
                   ${jobRunId}::uuid,
                   'succeeded'::public.job_run_status,
                   ${processed}::integer,
                   0::integer,
                   ${JSON.stringify(stats)}::jsonb,
                   NULL)
        `;
        // `leave_ledger` rows carry their own audit trail via 038's triggers; this
        // row is how the JOB — the decision to accrue and to close the FY on this
        // date — appears on the hash chain.
        await auditJobRun(tx, ctx, {
          jobCode,
          runId: jobRunId,
          outcome: "succeeded",
          stats,
        });
      });
    }

    status = 200;
    responseBody = { job_code: jobCode, job_run_id: jobRunId, ...stats, requestId };

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
    log.info("accruals finished", {
      as_of: asOf,
      accrual_ran: wantAccrual,
      rollover_ran: rollover.ran,
      carried: rollover.totals.carried,
      lapsed: rollover.totals.lapsed,
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

    if (problem.isServerFault) log.error("accruals failed", { err, code: problem.code });
    else log.warn("accruals refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey, job_run_id: jobRunId, job_code: jobCode });
  }
});

/** Exported so `supabase/tests` asserts against one schema. */
export { AccrualsBody, IN_SERVICE_STATUSES, ROLLOVER_SOURCE };
