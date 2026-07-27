/**
 * attendance-recompute — catalogue #7, auth models **U+** (`attendance.recompute`,
 * which `role_capabilities` marks `requires_step_up`) **or C** (cron/service-role).
 *
 * The admin Recompute Console and the nightly/backfill jobs share this door:
 *
 *   dry_run  →  compute every (employee, business date) cell in scope inside ONE
 *               transaction that is then ROLLED BACK, and answer with the per-day
 *               diff the operator would be committing. Nothing is written — not a
 *               day row, not a comp-off credit, not an audit row.
 *   commit   →  `public.recompute_attendance_range()` (migration 018 §7) per
 *               chunk. It writes an `attendance_recompute_runs` row, skips
 *               hard-locked days and survives a per-cell failure. The before/after
 *               fingerprints are read in the same transaction, so the diff we
 *               report is exactly what this run did.
 *
 * WHY THE ENGINE IS NOT REIMPLEMENTED HERE: `compute_attendance_day` is the single
 * writer of `attendance_days` (018) and the only thing that knows the resolved
 * shift, policy, weekly-off rule, holiday calendar, leave and regularization for a
 * date. A "dry run" that predicted the answer in TypeScript would be a second
 * engine, and the two would drift. Rolling back the real engine is the only dry
 * run that cannot lie.
 *
 * Locks (spec-architecture §6):
 *   - a HARD `attendance_locks` row, or `attendance_days.is_locked` (set by
 *     `finalise_payroll_run`, 023), removes the cell from scope; it is reported as
 *     `daysSkippedLocked`.
 *   - `overrideLock: true` requires the `attendance.lock.override` capability
 *     (super_admin + step-up) and sets `app.allow_locked_recompute` for the
 *     transaction — the documented bypass, never a silent one.
 *   - a SOFT lock needs no handling here: the engine returns the existing row
 *     unchanged, which shows up as `daysUnchanged`.
 *
 * Bounded work: the range, the cell count and the wall clock are all capped. When
 * the deadline is reached the response is `partial: true` with a `resume` cursor
 * the console (or cron) passes back verbatim. Nothing is lost — each chunk is its
 * own transaction.
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
  unprocessable,
} from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { daysBetween, istToday, toIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  type RequestContext,
  requestIdFrom,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import type { Sql } from "../_shared/deps.ts";
import {
  type AuthContext,
  bearerToken,
  requireCapDb,
  requireCapWithStepUp,
  verifyCron,
  verifyUser,
} from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import {
  claim,
  idempotencyKeyFrom,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";
import { writeAudit } from "../_shared/audit.ts";

const FN_NAME = "attendance-recompute";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** Longest window one call may cover. Older corrections run as several calls. */
const MAX_RANGE_DAYS = 186;
/** Employee × day cells one call may target. */
const MAX_CELLS = 60_000;
/** Cells per transaction — the unit of both chunking and rollback. */
const MAX_CELLS_PER_TX = 1_200;
/** Wall-clock budget for the work loop; the rest of the invocation builds the response. */
const WORK_DEADLINE_MS = 45_000;
/** `attendance_days.computed_by` for this console (`ck_ad__computed_by` allows engine/batch/admin_override/import). */
const COMPUTE_SOURCE = "batch";

const RecomputeBody = z
  .object({
    mode: z.enum(["dry_run", "commit"]).default("dry_run"),
    from: common.isoDate,
    to: common.isoDate,
    /** Absent = every attendance-tracked employee in the caller's admin scope. */
    employeeIds: z.array(common.uuid).min(1).max(5_000).optional(),
    reason: common.reason,
    overrideLock: z.boolean().default(false),
    /** Echo the `resume` object from a `partial: true` response to continue. */
    resume: z.object({ employeeIndex: z.number().int().min(0) }).strict().optional(),
    maxChangedDays: z.number().int().min(0).max(500).default(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    const span = daysBetween(value.from, value.to);
    if (span < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "`to` must not precede `from`.",
      });
      return;
    }
    if (span + 1 > MAX_RANGE_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `A single recompute may cover at most ${MAX_RANGE_DAYS} days.`,
      });
    }
    if (value.from > istToday()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "Future dates hold no attendance rows; `from` must be today or earlier.",
      });
    }
  });

// ── Day fingerprint ─────────────────────────────────────────────────────────
// The fields an operator is deciding about. Deliberately not every column:
// `computed_at`/`computed_version` change on every run and would make every day
// look changed.

interface DayFingerprint {
  status: string | null;
  statusSource: string | null;
  dayFractionPaid: number | null;
  punchCount: number | null;
  grossSpanMinutes: number | null;
  breakMinutes: number | null;
  totalWorkedMinutes: number | null;
  payableWorkedMinutes: number | null;
  isLate: boolean | null;
  lateMinutes: number | null;
  earlyExitMinutes: number | null;
  overtimeMinutes: number | null;
  extraWorkMinutes: number | null;
  leaveDayFraction: number | null;
  firstInAt: string | null;
  lastOutAt: string | null;
  anomalyFlags: string[];
}

const FINGERPRINT_FIELDS: readonly (keyof DayFingerprint)[] = [
  "status",
  "statusSource",
  "dayFractionPaid",
  "punchCount",
  "grossSpanMinutes",
  "breakMinutes",
  "totalWorkedMinutes",
  "payableWorkedMinutes",
  "isLate",
  "lateMinutes",
  "earlyExitMinutes",
  "overtimeMinutes",
  "extraWorkMinutes",
  "leaveDayFraction",
  "firstInAt",
  "lastOutAt",
  "anomalyFlags",
];

/**
 * One column list, two aliases: `ad` for the stored snapshot, `r` for the row the
 * engine just returned. `numeric` is cast to text because postgres.js hydrates it
 * as a string anyway — being explicit keeps 0.500 from becoming 0.5 in one path
 * and not the other.
 */
function dayColumns(alias: string): string {
  const a = alias;
  return [
    `${a}.status::text            AS status`,
    `${a}.status_source::text     AS status_source`,
    `${a}.day_fraction_paid::text AS day_fraction_paid`,
    `${a}.punch_count             AS punch_count`,
    `${a}.gross_span_minutes      AS gross_span_minutes`,
    `${a}.break_minutes           AS break_minutes`,
    `${a}.total_worked_minutes    AS total_worked_minutes`,
    `${a}.payable_worked_minutes  AS payable_worked_minutes`,
    `${a}.is_late                 AS is_late`,
    `${a}.late_minutes            AS late_minutes`,
    `${a}.early_exit_minutes      AS early_exit_minutes`,
    `${a}.overtime_minutes        AS overtime_minutes`,
    `${a}.extra_work_minutes      AS extra_work_minutes`,
    `${a}.leave_day_fraction::text AS leave_day_fraction`,
    `${a}.first_in_at             AS first_in_at`,
    `${a}.last_out_at             AS last_out_at`,
    `${a}.anomaly_flags           AS anomaly_flags`,
  ].join(",\n            ");
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asNumeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** postgres.js hydrates `timestamptz` to `Date`; `toIso` is the only sanctioned formatter. */
function asInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return toIso(value);
  return typeof value === "string" && value !== "" ? toIso(value) : null;
}

function asFlags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function fingerprint(row: Record<string, unknown>): DayFingerprint {
  return {
    status: asText(row.status),
    statusSource: asText(row.status_source),
    dayFractionPaid: asNumeric(row.day_fraction_paid),
    punchCount: asInt(row.punch_count),
    grossSpanMinutes: asInt(row.gross_span_minutes),
    breakMinutes: asInt(row.break_minutes),
    totalWorkedMinutes: asInt(row.total_worked_minutes),
    payableWorkedMinutes: asInt(row.payable_worked_minutes),
    isLate: asBool(row.is_late),
    lateMinutes: asInt(row.late_minutes),
    earlyExitMinutes: asInt(row.early_exit_minutes),
    overtimeMinutes: asInt(row.overtime_minutes),
    extraWorkMinutes: asInt(row.extra_work_minutes),
    leaveDayFraction: asNumeric(row.leave_day_fraction),
    firstInAt: asInstant(row.first_in_at),
    lastOutAt: asInstant(row.last_out_at),
    anomalyFlags: asFlags(row.anomaly_flags),
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function changedFields(before: DayFingerprint | null, after: DayFingerprint | null): string[] {
  if (before === null && after === null) return [];
  if (before === null) return ["created"];
  if (after === null) return ["removed"];
  return FINGERPRINT_FIELDS.filter((f) => !sameValue(before[f], after[f])) as string[];
}

interface DayDiff {
  employeeId: string;
  employeeCode: string | null;
  istDate: string;
  changedFields: string[];
  before: DayFingerprint | null;
  after: DayFingerprint | null;
}

interface CellError {
  employeeId: string;
  istDate: string | null;
  message: string;
}

interface ChunkOutcome {
  cellsTargeted: number;
  daysChanged: number;
  daysUnchanged: number;
  daysNoRow: number;
  daysSkippedLocked: number;
  errorCells: number;
  diffs: DayDiff[];
  errors: CellError[];
  runIds: string[];
}

function emptyOutcome(): ChunkOutcome {
  return {
    cellsTargeted: 0,
    daysChanged: 0,
    daysUnchanged: 0,
    daysNoRow: 0,
    daysSkippedLocked: 0,
    errorCells: 0,
    diffs: [],
    errors: [],
    runIds: [],
  };
}

function mergeOutcome(a: ChunkOutcome, b: ChunkOutcome): ChunkOutcome {
  return {
    cellsTargeted: a.cellsTargeted + b.cellsTargeted,
    daysChanged: a.daysChanged + b.daysChanged,
    daysUnchanged: a.daysUnchanged + b.daysUnchanged,
    daysNoRow: a.daysNoRow + b.daysNoRow,
    daysSkippedLocked: a.daysSkippedLocked + b.daysSkippedLocked,
    errorCells: a.errorCells + b.errorCells,
    diffs: [...a.diffs, ...b.diffs],
    errors: [...a.errors, ...b.errors],
    runIds: [...a.runIds, ...b.runIds],
  };
}

/** Thrown from inside the dry-run transaction so postgres.js issues ROLLBACK. */
class DryRunRollback extends Error {
  override readonly name = "DryRunRollback";
  readonly outcome: ChunkOutcome;
  constructor(outcome: ChunkOutcome) {
    super("dry-run rollback");
    this.outcome = outcome;
  }
}

interface PgErrorish {
  code?: string;
  message?: string;
  constraint_name?: string;
}

function pgError(err: unknown): PgErrorish {
  return (err !== null && typeof err === "object" ? err : {}) as PgErrorish;
}

/**
 * One caller-safe sentence per failure class. The driver's own message can carry
 * SQL text and identifiers, so it goes to the log, never into the response.
 */
function safeCellMessage(err: unknown): string {
  switch (pgError(err).code ?? "") {
    case "55006":
      return "The date is hard-locked; recompute refused.";
    case "42501":
      return "The database refused this recompute for the caller.";
    case "23514":
      return "A database rule rejected the computed day.";
    case "57014":
      return "The computation timed out.";
    default:
      return "The engine could not compute this day. Quote the request id.";
  }
}

type EmployeeRow = { id: string; employee_code: string | null };

/**
 * Before-state for a chunk, keyed `employeeId|istDate`. Read inside the same
 * transaction as the compute, so the diff cannot straddle another writer.
 */
async function snapshot(
  tx: Sql,
  employeeIds: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, DayFingerprint>> {
  const rows = await tx.unsafe(
    `SELECT ad.employee_id           AS employee_id,
            ad.ist_date::text        AS ist_date,
            ${dayColumns("ad")}
       FROM public.attendance_days ad
      WHERE ad.employee_id = ANY($1::uuid[])
        AND ad.ist_date BETWEEN $2::date AND $3::date`,
    [[...employeeIds], from, to],
  );
  const map = new Map<string, DayFingerprint>();
  for (const row of rows as unknown as Record<string, unknown>[]) {
    map.set(`${String(row.employee_id)}|${String(row.ist_date)}`, fingerprint(row));
  }
  return map;
}

/**
 * `app.compute_source` feeds `attendance_days.computed_by`. Transaction-scoped
 * like every other `app.*` key, so it must be set inside the same transaction.
 */
async function setComputeSource(tx: Sql): Promise<void> {
  await tx`SELECT set_config('app.compute_source', ${COMPUTE_SOURCE}, true)`;
}

/**
 * Run the engine over a chunk in ONE round-trip and return the rows it produced.
 *
 * `MATERIALIZED` on the cells CTE is load-bearing: without it the planner may
 * evaluate the lateral engine call before the lock filter, and a single
 * hard-locked day would raise 55006 and abort the whole chunk.
 */
async function computeCells(
  tx: Sql,
  employeeIds: readonly string[],
  from: string,
  to: string,
  reason: string,
  overrideLock: boolean,
): Promise<Record<string, unknown>[]> {
  const rows = await tx.unsafe(
    `WITH cells AS MATERIALIZED (
       SELECT e.id AS employee_id, d::date AS ist_date
         FROM public.employees e
         JOIN unnest($1::uuid[]) AS x(id) ON x.id = e.id
         CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d
        WHERE $5::boolean
           OR (
             NOT EXISTS (
               SELECT 1 FROM public.attendance_locks l
                WHERE l.unlocked_at IS NULL
                  AND l.lock_kind = 'hard'
                  AND d::date BETWEEN l.from_date AND l.to_date
                  AND (l.scope = 'company'
                    OR (l.scope = 'location'   AND l.location_id   = e.location_id)
                    OR (l.scope = 'department' AND l.department_id = e.department_id)
                    OR (l.scope = 'employee'   AND l.employee_id   = e.id)))
             AND NOT EXISTS (
               SELECT 1 FROM public.attendance_days ad
                WHERE ad.employee_id = e.id AND ad.ist_date = d::date AND ad.is_locked)
           )
        ORDER BY e.id, d
     )
     SELECT c.employee_id        AS employee_id,
            c.ist_date::text     AS ist_date,
            r.id                 AS day_id,
            ${dayColumns("r")}
       FROM cells c
       CROSS JOIN LATERAL public.compute_attendance_day(c.employee_id, c.ist_date, $4::text, true) r`,
    [[...employeeIds], from, to, reason, overrideLock],
  );
  return rows as unknown as Record<string, unknown>[];
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

    // ── STEP 4 · Auth (U+ or C) ─────────────────────────────────────────────
    // A cron/service-role caller is identified by the header it must send; a human
    // caller by a bearer token. There is no third door.
    const isCron = req.headers.get("x-cron-secret") !== null;
    let auth: AuthContext | null = null;
    if (isCron) {
      verifyCron(req);
      log.info("cron caller authenticated");
    } else {
      // No credential of either kind: let `verifyCron` produce the 401 so the
      // response never distinguishes "wrong secret" from "no secret".
      if (bearerToken(req) === null) verifyCron(req);
      auth = await verifyUser(req);
      log.info("user authenticated", { actor_id: auth.userId, role: auth.role });
    }

    // ── STEP 5 · Authority, from the DATABASE ───────────────────────────────
    // `attendance.recompute` carries `requires_step_up` in `role_capabilities`,
    // which is what makes this function U+ without a second hard-coded list.
    // Cron holds no capabilities: its authority is the constant-time secret.
    if (auth !== null) {
      await requireCapWithStepUp(sql(), auth, "attendance.recompute");
    }

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    // The heaviest admin job in the product. Bucket is shared across isolates and
    // is spent even by a call that then fails validation.
    await enforce(
      RATE_LIMITS.heavyJob,
      limitKey(FN_NAME, auth?.userId ?? "cron"),
      "RECOMPUTE_RATE_LIMITED",
    );

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const { data: body, raw } = await parseBody(req, RecomputeBody);

    // Writing into a locked period is a distinct, super-admin capability.
    if (body.overrideLock && auth !== null) {
      await requireCapDb(sql(), auth, "attendance.lock.override");
    }

    // Future days hold no rows (018, fixture 10) — clamp rather than reject, so a
    // console asking for "this month" behaves on the 12th.
    const today = istToday();
    const from = body.from;
    const to = body.to > today ? today : body.to;
    const rangeDays = daysBetween(from, to) + 1;

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // A commit MUST carry a key: a retried recompute would re-run the engine and
    // write a second `attendance_recompute_runs` row. A dry run writes nothing, so
    // a key is welcome but not demanded.
    idempotencyKey = body.mode === "commit"
      ? requireIdempotencyKey(req)
      : idempotencyKeyFrom(req) ?? `${FN_NAME}:${requestId}`;
    const hash = await requestHash(FN_NAME, raw, auth?.userId ?? "cron");
    const claimed = await claim({
      key: idempotencyKey,
      fnName: FN_NAME,
      requestHash: hash,
      actorId: auth?.userId ?? null,
    });
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { key: idempotencyKey });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    const ctx: RequestContext = {
      actorId: auth?.userId ?? null,
      actorRole: auth?.role ?? null,
      source: isCron ? "cron" : "web_admin",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      reason: body.reason,
      flags: { allow_locked_recompute: body.overrideLock },
    };

    // ── Scope resolution ────────────────────────────────────────────────────
    // Inside a context transaction because `app.admin_scope_covers()` reads
    // `app.actor_id`. The predicate is the one `attendance_days`' admin read policy
    // uses, so this endpoint can never reach further than the console's screens.
    const employees = await withContext(ctx, async (tx) => {
      const rows = await tx`
        SELECT e.id, e.employee_code
          FROM public.employees e
         WHERE e.deleted_at IS NULL
           AND NOT e.exclude_from_attendance
           AND (${body.employeeIds ?? null}::uuid[] IS NULL
                OR e.id = ANY(${body.employeeIds ?? null}::uuid[]))
           AND (${isCron}::boolean
                OR app.is_super_admin()
                OR app.admin_scope_covers(e.id))
         ORDER BY e.employee_code NULLS LAST, e.id
      `;
      return rows as unknown as EmployeeRow[];
    });

    if (employees.length === 0) {
      if (body.employeeIds !== undefined) {
        // 404, never "exists but forbidden" (§4): out of scope and absent must be
        // indistinguishable to the caller.
        throw notFound(
          "No attendance-tracked employee in your scope matches that selection.",
          "SCOPE_EMPTY",
        );
      }
      throw forbidden(
        "Your admin role has no employee scope assigned, so there is nothing to recompute. " +
          "Ask a super admin for a scoped admin assignment.",
        "ADMIN_SCOPE_EMPTY",
      );
    }

    const resolved = new Set(employees.map((e) => e.id));
    const unresolved = (body.employeeIds ?? []).filter((id) => !resolved.has(id));

    const totalCells = employees.length * rangeDays;
    if (totalCells > MAX_CELLS) {
      throw unprocessable(
        [{
          pointer: "/employeeIds",
          code: "too_big",
          detail: `${employees.length} employees × ${rangeDays} days = ${totalCells} cells exceeds ` +
            `the ${MAX_CELLS} ceiling. Narrow the range or the employee list.`,
        }],
        "This recompute is too large for one call.",
        "RECOMPUTE_SCOPE_TOO_LARGE",
      );
    }

    const codeById = new Map<string, string | null>(
      employees.map((e): [string, string | null] => [e.id, e.employee_code]),
    );
    const employeeIds = employees.map((e) => e.id);
    const startIndex = Math.min(body.resume?.employeeIndex ?? 0, employeeIds.length);
    const chunkSize = Math.max(1, Math.floor(MAX_CELLS_PER_TX / rangeDays));

    // ── STEP 9/10 · One transaction per chunk: context, engine, audit ───────

    /** Dry run: compute, diff, then throw so postgres.js rolls the chunk back. */
    const dryRunChunk = async (ids: string[]): Promise<ChunkOutcome> => {
      const outcome = emptyOutcome();
      try {
        await withContext(ctx, async (tx) => {
          await setComputeSource(tx);
          const before = await snapshot(tx, ids, from, to);
          const rows = await computeCells(tx, ids, from, to, body.reason, body.overrideLock);
          outcome.cellsTargeted = ids.length * rangeDays;
          // Every eligible cell yields exactly one row; the difference is what the
          // lock filter removed.
          outcome.daysSkippedLocked = Math.max(0, outcome.cellsTargeted - rows.length);
          for (const row of rows) {
            const employeeId = String(row.employee_id);
            const istDate = String(row.ist_date);
            if (row.day_id === null || row.day_id === undefined) {
              // The engine declined to materialise a row (employee excluded from
              // attendance, soft-locked date with no existing row, a future date
              // with no approved leave). Neither a change nor an error.
              outcome.daysNoRow += 1;
              continue;
            }
            const after = fingerprint(row);
            const prior = before.get(`${employeeId}|${istDate}`) ?? null;
            const fields = changedFields(prior, after);
            if (fields.length === 0) {
              outcome.daysUnchanged += 1;
              continue;
            }
            outcome.daysChanged += 1;
            if (outcome.diffs.length < body.maxChangedDays) {
              outcome.diffs.push({
                employeeId,
                employeeCode: codeById.get(employeeId) ?? null,
                istDate,
                changedFields: fields,
                before: prior,
                after,
              });
            }
          }
          // Nothing is committed: not the day rows, not the comp-off credits, not
          // the audit rows the triggers just wrote. That is the whole point.
          throw new DryRunRollback(outcome);
        });
        // The sentinel did not travel, which means the transaction COMMITTED. Fail
        // loudly rather than report a "dry run" that wrote.
        throw conflict("Dry run did not roll back; nothing is reported.", "DRY_RUN_UNSAFE");
      } catch (err) {
        if (err instanceof DryRunRollback) return err.outcome;
        throw err;
      }
    };

    /**
     * Optimistic batch, pessimistic retry. An un-handled engine failure aborts its
     * transaction, so the batch is halved until the offending employee is alone and
     * can be reported without losing its neighbours.
     */
    const dryRunResilient = async (ids: string[]): Promise<ChunkOutcome> => {
      try {
        return await dryRunChunk(ids);
      } catch (err) {
        if (isProblem(err)) throw err;
        if (ids.length === 1) {
          const employeeId = ids[0] as string;
          log.warn("dry-run cell failed", { employee_id: employeeId, err });
          const outcome = emptyOutcome();
          outcome.cellsTargeted = rangeDays;
          outcome.errorCells = rangeDays;
          outcome.errors.push({ employeeId, istDate: null, message: safeCellMessage(err) });
          return outcome;
        }
        const mid = Math.ceil(ids.length / 2);
        const left = await dryRunResilient(ids.slice(0, mid));
        const right = await dryRunResilient(ids.slice(mid));
        return mergeOutcome(left, right);
      }
    };

    /** Commit: the DB's own range recompute, which is per-cell fault tolerant. */
    const commitChunk = (ids: string[]): Promise<ChunkOutcome> =>
      withContext(ctx, async (tx) => {
        const outcome = emptyOutcome();
        outcome.cellsTargeted = ids.length * rangeDays;
        await setComputeSource(tx);
        const before = await snapshot(tx, ids, from, to);

        const runRows = await tx`
          SELECT public.recompute_attendance_range(
                   ${from}::date, ${to}::date, ${ids}::uuid[], ${body.reason}::text
                 ) AS run_id
        `;
        const runId = (runRows as unknown as { run_id: string | null }[])[0]?.run_id ?? null;
        if (runId !== null) outcome.runIds.push(runId);

        const after = await snapshot(tx, ids, from, to);
        for (const [key, next] of after) {
          const prior = before.get(key) ?? null;
          const fields = changedFields(prior, next);
          if (fields.length === 0) continue;
          outcome.daysChanged += 1;
          if (outcome.diffs.length < body.maxChangedDays) {
            const [employeeId = "", istDate = ""] = key.split("|");
            outcome.diffs.push({
              employeeId,
              employeeCode: codeById.get(employeeId) ?? null,
              istDate,
              changedFields: fields,
              before: prior,
              after: next,
            });
          }
        }

        if (runId !== null) {
          const stats = await tx`
            SELECT days_targeted, days_written, days_skipped_locked, errors, error_detail
              FROM public.attendance_recompute_runs
             WHERE id = ${runId}::uuid
          `;
          const row = (stats as unknown as Record<string, unknown>[])[0];
          if (row !== undefined) {
            outcome.daysSkippedLocked = asInt(row.days_skipped_locked) ?? 0;
            outcome.errorCells = asInt(row.errors) ?? 0;
            const written = asInt(row.days_written) ?? 0;
            // `days_written` counts cells the engine accepted; the ones that wrote
            // no row (future/excluded) are the remainder.
            outcome.daysUnchanged = Math.max(0, written - outcome.daysChanged);
            outcome.daysNoRow = Math.max(
              0,
              (asInt(row.days_targeted) ?? 0) - written - outcome.errorCells,
            );
            const detail = row.error_detail;
            if (Array.isArray(detail)) {
              for (const entry of detail.slice(0, 20)) {
                const e = (entry ?? {}) as Record<string, unknown>;
                outcome.errors.push({
                  employeeId: String(e.employee_id ?? ""),
                  istDate: e.ist_date === undefined || e.ist_date === null
                    ? null
                    : String(e.ist_date),
                  // The engine's `SQLERRM` is already in
                  // `attendance_recompute_runs.error_detail` for the console to
                  // read under RLS; on the wire it stays generic.
                  message: "The engine could not compute this day.",
                });
              }
            }
          }

          // ── STEP 10 · Audit, in the SAME transaction ──────────────────────
          // The per-field rows on `attendance_days` are already written by
          // `trg_attendance_days__audit`. What no trigger can see is that a HUMAN
          // asked for this range, with this reason, and got this run id.
          await writeAudit(tx, ctx, {
            action: "recompute",
            entityTable: "public.attendance_recompute_runs",
            entityId: runId,
            entityLabel: `range_backfill ${from}..${to}`,
            newValue: {
              from,
              to,
              employee_count: ids.length,
              days_changed: outcome.daysChanged,
              days_skipped_locked: outcome.daysSkippedLocked,
              override_lock: body.overrideLock,
            },
          });
        }
        return outcome;
      });

    let total = emptyOutcome();
    let nextIndex = startIndex;
    let deadlineHit = false;
    for (let i = startIndex; i < employeeIds.length; i += chunkSize) {
      if (log.elapsedMs() > WORK_DEADLINE_MS) {
        deadlineHit = true;
        break;
      }
      const ids = employeeIds.slice(i, i + chunkSize);
      const outcome = body.mode === "commit" ? await commitChunk(ids) : await dryRunResilient(ids);
      total = mergeOutcome(total, outcome);
      nextIndex = i + ids.length;
    }
    const partial = deadlineHit || nextIndex < employeeIds.length;

    const responseBody = {
      mode: body.mode,
      committed: body.mode === "commit",
      scope: {
        from,
        to,
        requestedTo: body.to,
        days: rangeDays,
        employeeCount: employeeIds.length,
        employeesProcessed: Math.max(0, nextIndex - startIndex),
        overrideLock: body.overrideLock,
        unresolvedEmployeeIds: unresolved,
      },
      totals: {
        cellsTargeted: total.cellsTargeted,
        // Dry run: "would change". Commit: "did change".
        daysChanged: total.daysChanged,
        daysUnchanged: total.daysUnchanged,
        daysNoRow: total.daysNoRow,
        daysSkippedLocked: total.daysSkippedLocked,
        errors: total.errorCells,
      },
      changedDays: total.diffs,
      changedDaysTruncated: total.daysChanged > total.diffs.length,
      errors: total.errors.slice(0, 50),
      runIds: total.runIds,
      partial,
      resume: partial ? { employeeIndex: nextIndex } : null,
      reason: body.reason,
      requestId,
    };
    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ─────────────
    await store(idempotencyKey, status, responseBody);

    log.info("recompute finished", {
      mode: body.mode,
      employees: employeeIds.length,
      days: rangeDays,
      changed: total.daysChanged,
      skipped_locked: total.daysSkippedLocked,
      errors: total.errorCells,
      partial,
    });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    // A hard lock that reached us despite the cell filter (a lock taken mid-run)
    // is a 423, not a 500 — the operator can act on it.
    const mapped = pgError(err).code === "55006"
      ? locked(
        "An attendance lock covers part of that range. Unlock it, or recompute with the override capability.",
        "PERIOD_LOCKED",
        { cause: err },
      )
      : err;
    const problem = toProblem(mapped, requestId).withContext({ requestId, instance });
    status = problem.status;

    if (idempotencyKey !== null) {
      try {
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

/** Exported so `supabase/tests` and the admin console assert against one schema. */
export { RecomputeBody };
