/**
 * void-punch — the correction half of the attendance system of record.
 * Auth model **U+** (user JWT + capability, step-up decided by the database).
 *
 * `public.attendance_punches` is append-only: a mistaken punch is never edited
 * and never deleted. Migration 016 encodes that in a BEFORE UPDATE/DELETE
 * trigger which refuses EVERY write unless
 *
 *     SELECT set_config('app.allow_punch_void', 'on', true)
 *
 * has run in the SAME transaction, and then still refuses any change outside the
 * four void columns (`is_voided`, `voided_by`, `voided_at`, `void_reason`).
 * `_shared/db.ts` exposes that switch as `ctx.flags.allow_punch_void`, and
 * because `set_config(..., true)` is transaction-scoped, the flag and the UPDATE
 * are physically the same transaction — see `withContext`.
 *
 * AUDIT: `attendance_punches` is deliberately NOT audit-trigger-attached
 * (migration 038 header: "its insert IS the audit record; voids are audited by
 * the void-punch path"). So THIS function is the only writer of the `void`
 * hash-chain row, and it writes it inside the same transaction as the UPDATE —
 * a rollback loses both or neither.
 *
 * Downstream: `trg_attendance_punches__enqueue` fires on `UPDATE OF is_voided`
 * and queues `compute_attendance_day`, so the derived day metrics fix themselves.
 * This function computes NO attendance numbers (spec-kiosk §10: the engine is the
 * only writer of derived metrics).
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  conflict,
  locked,
  methodNotAllowed,
  notFound,
  ok,
  toProblem,
} from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { toIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql as sqlHandle,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { hasCapDb, requireCapWithStepUp, requireStepUp, verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import {
  claim,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";
import { writeAudit } from "../_shared/audit.ts";

const FN_NAME = "void-punch";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** Migration 050 seeds this on the `admin` role. */
const CAP_VOID = "attendance.punch.void";
/** super_admin + step-up. Only this lets a void land inside a locked period. */
const CAP_LOCK_OVERRIDE = "attendance.lock.override";

/**
 * `public.punch_void_reason` (spec-kiosk §9). The DB column is free text with a
 * ≥10-character CHECK rather than an enum, so the code is a machine-readable
 * PREFIX on the human reason — greppable in the audit trail, and no migration is
 * needed to add one.
 */
const VOID_REASON_CODES = [
  "debounce",
  "rate_limit_day",
  "admin_void",
  "spoof_rejected",
  "reassigned",
  "import_correction",
] as const;

const VoidBody = z
  .object({
    punchId: common.uuid,
    /**
     * Optional but wanted: `attendance_punches` is RANGE-partitioned on
     * `punched_at` with PK `(id, punched_at)`, so supplying the instant prunes
     * the UPDATE to one partition instead of scanning every month.
     */
    punchedAt: common.instant.optional(),
    /** `ck_ap__void_fields` requires ≥10 characters after trimming. */
    reason: common.reason,
    voidReasonCode: z.enum(VOID_REASON_CODES).default("admin_void"),
  })
  .strict();

interface PunchRow {
  id: string;
  employee_id: string;
  punched_at: Date | string;
  effective_date: string;
  is_voided: boolean;
  source: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ─────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ───────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ─────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;

  try {
    assertOriginAllowed(req);
    const client = sqlHandle();

    // ── STEP 4 · Auth (model U) ───────────────────────────────────────────────
    const auth = await verifyUser(req);

    // ── STEP 5 · Authority, from the DATABASE ─────────────────────────────────
    // `requireCapWithStepUp` resolves the capability through
    // `public.role_capabilities` + `app.has_cap()` AND reads
    // `role_capabilities.requires_step_up` for the aal2 decision. The catalogue
    // calls this endpoint U+; making that true is a one-row data change
    // (`UPDATE role_capabilities SET requires_step_up = true WHERE capability =
    // 'attendance.punch.void'`) with no redeploy — which is the point of moving
    // authorisation into the DB. Nothing here hard-codes either answer.
    await requireCapWithStepUp(client, auth, CAP_VOID);

    // ── STEP 6 · Rate limit ───────────────────────────────────────────────────
    await enforce(RATE_LIMITS.mutation, limitKey(FN_NAME, auth.userId), "RATE_LIMITED", client);

    // ── STEP 7 · Validate ─────────────────────────────────────────────────────
    const { data: body, raw } = await parseBody(req, VoidBody, { maxBytes: 8 * 1024 });

    // ── STEP 8 · Idempotency claim ────────────────────────────────────────────
    // Required, not optional: a double-submitted void must not produce two audit
    // rows claiming two different people voided the same punch.
    idempotencyKey = requireIdempotencyKey(req);
    const hash = await requestHash(FN_NAME, raw, auth.userId);
    const claimed = await claim(
      { key: idempotencyKey, fnName: FN_NAME, requestHash: hash, actorId: auth.userId },
      client,
    );
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { key: idempotencyKey });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    // Read the target before deciding anything. 404 covers both "no such punch"
    // and "not yours to see" (§4: never exists-but-forbidden).
    const punchRows = await client`
      SELECT p.id,
             p.employee_id,
             p.punched_at,
             p.effective_date::text AS effective_date,
             p.is_voided,
             p.source::text         AS source
        FROM public.attendance_punches p
       WHERE p.id = ${body.punchId}::uuid
         AND (${body.punchedAt ?? null}::timestamptz IS NULL
              OR p.punched_at = ${body.punchedAt ?? null}::timestamptz)
       LIMIT 1
    `;
    const punch = firstRow(punchRows as unknown as PunchRow[]);
    if (punch === null) throw notFound(undefined, "PUNCH_NOT_FOUND");
    if (punch.is_voided) {
      // Already void. A 409 rather than a silent success: the caller's mental
      // model of the row is wrong, and a second void_reason would be lost.
      throw conflict("This punch has already been voided.", "PUNCH_ALREADY_VOIDED");
    }

    // Period lock. `attendance_locks` freezes a date range under finalised
    // payroll; `trg_attendance_days__lock_guard` (017) refuses the recompute even
    // for `service_role` unless `app.override_lock` is set, so voiding inside a
    // locked period without the override would leave the punch void and the day
    // stale — a worse state than refusing.
    const lockRows = await client`
      SELECT l.id, l.lock_kind
        FROM public.attendance_locks l
        JOIN public.employees e ON e.id = ${punch.employee_id}::uuid
       WHERE l.unlocked_at IS NULL
         AND l.company_id = e.company_id
         AND ${punch.effective_date}::date BETWEEN l.from_date AND l.to_date
         AND (l.scope = 'company'
              OR (l.scope = 'location'   AND l.location_id   = e.location_id)
              OR (l.scope = 'department' AND l.department_id = e.department_id)
              OR (l.scope = 'employee'   AND l.employee_id   = e.id))
       ORDER BY (l.lock_kind = 'hard') DESC
       LIMIT 1
    `;
    const lock = firstRow(lockRows as unknown as { id: string; lock_kind: string }[]);
    let overrideLock = false;
    if (lock !== null) {
      if (!(await hasCapDb(client, auth, CAP_LOCK_OVERRIDE))) {
        throw locked(
          `This date is locked under a finalised payroll period. Unlock it, or ask a super admin (${CAP_LOCK_OVERRIDE}).`,
          "ATTENDANCE_PERIOD_LOCKED",
        );
      }
      // The capability exists AND is `requires_step_up = true` in migration 050.
      requireStepUp(auth);
      overrideLock = true;
    }

    const voidReason = `${body.voidReasonCode}: ${body.reason.trim()}`;

    // ── STEPS 9 + 10 · set_context + ONE transaction, audit inside it ─────────
    const ctx: RequestContext = {
      actorId: auth.userId,
      actorRole: auth.role,
      source: "web_admin",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      reason: voidReason,
      flags: {
        // THE switch that migration 016's append-only trigger looks for.
        allow_punch_void: true,
        // Only when the caller proved the super-admin override above.
        override_lock: overrideLock,
      },
    };

    const result = await withContext(ctx, async (tx) => {
      // Scope, checked with the actor in the session (`app.admin_scope_covers`
      // reads `app.ctx_actor_id()`), so a location-scoped admin cannot void a
      // punch outside their scope. 404, not 403 — the row's existence is not
      // theirs to learn.
      const scopeRows = await tx`
        SELECT app.admin_scope_covers(${punch.employee_id}::uuid) AS covered
      `;
      if (firstRow(scopeRows as unknown as { covered: boolean }[])?.covered !== true) {
        throw notFound(undefined, "PUNCH_NOT_FOUND");
      }

      // Void columns ONLY. The trigger diffs `to_jsonb(NEW) - void_cols` against
      // OLD and aborts on any other change, and `attendance_punches` carries no
      // `touch_row` trigger, so this statement is exactly what it looks like.
      const updated = await tx`
        UPDATE public.attendance_punches p
           SET is_voided   = true,
               voided_by   = ${auth.userId}::uuid,
               voided_at   = now(),
               void_reason = ${voidReason}::text
         WHERE p.id = ${punch.id}::uuid
           AND p.punched_at = ${punch.punched_at}::timestamptz
           AND p.is_voided = false
        RETURNING p.id, p.employee_id, p.effective_date::text AS effective_date, p.voided_at
      `;
      const row = firstRow(
        updated as unknown as {
          id: string;
          employee_id: string;
          effective_date: string;
          voided_at: Date | string;
        }[],
      );
      if (row === null) {
        // Lost the race to a concurrent void between the read and here.
        throw conflict("This punch has already been voided.", "PUNCH_ALREADY_VOIDED");
      }

      // The audit row this path exists to write. `action = 'void'` is the
      // documented correction record (§6: "Corrections = new action='void' rows").
      await writeAudit(tx, ctx, {
        action: "void",
        entityTable: "public.attendance_punches",
        entityId: row.id,
        entityLabel: `${punch.source} punch on ${row.effective_date}`,
        subjectEmployeeId: row.employee_id,
        fieldName: "is_voided",
        oldValue: false,
        newValue: true,
        reason: voidReason,
      });

      return row;
    });

    const responseBody = {
      voided: true,
      punchId: result.id,
      employeeId: result.employee_id,
      effectiveDate: result.effective_date,
      voidedAt: toIso(result.voided_at),
      voidReasonCode: body.voidReasonCode,
      lockOverridden: overrideLock,
      /**
       * The day metrics are recomputed asynchronously: the punch UPDATE fired
       * `trg_attendance_punches__enqueue`, and `drain_attendance_recompute_queue`
       * runs `compute_attendance_day`. Nothing here computes attendance numbers.
       */
      recomputeQueued: true,
      requestId,
    };
    status = 200;

    log.info("punch voided", {
      punch_id: result.id,
      employee_id: result.employee_id,
      effective_date: result.effective_date,
      void_reason_code: body.voidReasonCode,
      lock_overridden: overrideLock,
    });

    // ── STEP 11 · Store the response under the idempotency key ────────────────
    await store(idempotencyKey, status, responseBody, client);
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

    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ──────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported for `supabase/tests` — the function and the tests share one schema. */
export { VOID_REASON_CODES, VoidBody };
