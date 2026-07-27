/**
 * kiosk-operator-auth — catalogue #3, auth model **D** (device HMAC).
 *
 * Guard sign-in, handover and session refresh for the kiosk (screens K1/K2/K10).
 * Three ops, one endpoint:
 *
 *   op=open       6-digit PIN → Argon2id verify → a 10-minute session token
 *   op=heartbeat  live token → a fresh 10-minute token (no PIN, no audit row)
 *   op=close      live token → shift-end handover, audited
 *
 * WHAT A "SESSION" IS HERE (read before changing anything)
 * spec-kiosk §5.3 names a `kiosk_operator_session` table; migrations 001–050 do
 * not create one, and this function does not invent it. `_shared/auth.ts` had
 * already resolved that gap the only way it can be resolved without a table: the
 * session is a STATELESS token, `v1.<payload>.<hmac>`, signed with the DEVICE
 * secret by `mintOperatorSession()` and verified by `requireOperatorSession()`.
 * Consequences, all deliberate:
 *   - device-bound by construction: it dies when the device secret rotates or
 *     the device is suspended, because the verifier reads the secret from Vault;
 *   - re-read, not cached: every use re-reads `public.kiosk_operators`, so
 *     deactivating a guard takes effect on the next request;
 *   - TTL is the revocation mechanism, and that is why it is TEN MINUTES rather
 *     than the shift-long 90 minutes of §5.3. spec-kiosk §5.3 puts a 10-minute
 *     life on the device credential and refreshes it silently on heartbeat; with
 *     no session table to revoke against, that ceiling is the whole defence for
 *     a stolen tablet (threat T-11) and it belongs on the only credential the
 *     punch path accepts. A closed or handed-over session is therefore unusable
 *     within 10 minutes, not instantly.
 * The 90-minute idle rule survives as `kiosk.operator_idle_timeout_minutes`,
 * enforced at refresh time against the tablet's reported `last_scan_at` — see
 * the note there for why that is advisory rather than authoritative.
 *
 * PIN handling: Argon2id against `secure.kiosk_operator_secrets.pin_hash` (and
 * `previous_pin_hash` while a rotation grace window is open), with
 * `failed_attempts`/`locked_until` in the same row giving the 5-attempts-per-
 * 15-minutes lockout of spec-kiosk §8.1 on top of the shared token bucket. A
 * wrong PIN and an unknown guard return the SAME 401 with the same prose: the
 * kiosk must not become an employee-code oracle.
 *
 * Kiosk allowlist (§7.1, test T-09): the response carries the operator's own
 * name, code, shift window and permissions, plus device/session state. Nothing
 * about any other employee, ever.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  forbidden,
  methodNotAllowed,
  ok,
  toProblem,
  tooMany,
  unauthorized,
} from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { istDate, minutesBetween, nowIso, secondsBetween, toIso } from "../_shared/datetime.ts";
import type { Sql } from "../_shared/deps.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import {
  type AuthContext,
  hasCapDb,
  mintOperatorSession,
  requireOperatorSession,
  verifyDevice,
} from "../_shared/auth.ts";
import { verifyAgainst } from "../_shared/argon2.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import {
  claim,
  idempotencyKeyFrom,
  release,
  replayResponse,
  requestHash,
  store,
} from "../_shared/idempotency.ts";
import { auditSession, writeAudit } from "../_shared/audit.ts";

const FN_NAME = "kiosk-operator-auth";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/**
 * spec-kiosk §5.3: the device credential lives ten minutes and is re-minted
 * silently. Every op that returns a token returns one with this TTL.
 */
const SESSION_TTL_SECONDS = 600;

/** Defaults for settings migration 046 does not seed yet (see the return notes). */
const DEFAULT_MAX_PIN_ATTEMPTS = 5;
const DEFAULT_PIN_LOCK_MINUTES = 15;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 90;

const SETTING_KEYS = [
  "kiosk.max_pin_attempts",
  "kiosk.pin_lock_minutes",
  "kiosk.operator_idle_timeout_minutes",
] as const;

/**
 * The capability a guard needs to open a session. `kiosk.operate` is the name the
 * frontend contract §2 already uses for this tier.
 *
 * Migration 050 seeds no row for it, and `app.has_cap()` would therefore deny
 * every guard — so the gate is DATA-DRIVEN: if no role grants `kiosk.operate`,
 * authority is the `public.kiosk_operators` row itself (which is what
 * `requireOperatorSession` has always assumed). Seed the capability and this
 * check starts enforcing on the next request, with no redeploy. That is the
 * "authorisation is DB-resident" rule honoured in both directions.
 */
const OPERATOR_CAP = "kiosk.operate";

/**
 * `public.employment_status` values that may not open a session, whatever the
 * `kiosk_operators` row says. `on_notice` and `on_probation` are deliberately
 * absent — a guard working out their notice period still works the gate.
 */
const BLOCKED_EMPLOYMENT_STATUSES: ReadonlySet<string> = new Set([
  "pre_joining",
  "suspended",
  "absconding",
  "exited",
  "retired",
]);

const OpenBody = z
  .object({
    op: z.literal("open"),
    device_id: common.uuid,
    /** The guard's own employee code (K1 keypad). Either this or `operator_id`. */
    employee_code: common.employeeCode.optional(),
    operator_id: common.uuid.optional(),
    pin: z.string().regex(/^\d{4,10}$/, "The PIN is 4–10 digits."),
    app_version: common.appVersion.optional(),
  })
  .strict();

const HeartbeatBody = z
  .object({
    op: z.literal("heartbeat"),
    device_id: common.uuid,
    /** Footer counter from K3. Echoed back, never trusted for anything else. */
    scans_this_session: z.number().int().min(0).max(100_000).optional(),
    /** Drives the idle-timeout check. Device time, so advisory (INV-1). */
    last_scan_at: common.instant.nullish(),
    app_version: common.appVersion.optional(),
  })
  .strict();

const CloseBody = z
  .object({
    op: z.literal("close"),
    device_id: common.uuid,
    scans_this_session: z.number().int().min(0).max(100_000).optional(),
    /** K10 reconciliation: does the guard's count match the server's? */
    reconciliation_ok: z.boolean().optional(),
    handover_note: z.string().trim().max(500).optional(),
    app_version: common.appVersion.optional(),
  })
  .strict();

const OperatorAuthBody = z
  .discriminatedUnion("op", [OpenBody, HeartbeatBody, CloseBody])
  .superRefine((value, ctx) => {
    if (value.op === "open" && value.employee_code === undefined && value.operator_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["employee_code"],
        message: "Send employee_code or operator_id to identify the guard.",
      });
    }
  });

/** postgres.js hydrates `timestamptz` → `Date` and `numeric` → `string`. */
interface OperatorRow {
  id: string;
  profile_id: string;
  employee_id: string | null;
  can_enrol_faces: boolean;
  can_manual_punch: boolean;
  shift_window: string | null;
  display_name: string | null;
  employee_code: string | null;
  employment_status: string | null;
  profile_active: boolean;
  pin_hash: string | null;
  previous_pin_hash: string | null;
  rotation_grace_until: Date | string | null;
  failed_attempts: number | null;
  locked_until: Date | string | null;
}

/**
 * One 401 for "no such guard", "no PIN set", "account disabled" and "wrong PIN".
 * Returned rather than thrown so the call sites read `throw pinRefused()` and
 * control-flow narrowing is unambiguous.
 */
function pinRefused() {
  return unauthorized(
    "That code and PIN do not match. Try again, or ask a supervisor.",
    "KIOSK_OPERATOR_PIN_INVALID",
  );
}

/**
 * `app.has_cap()` for a guard who has no JWT: the only field `hasCapDb` reads is
 * `userId`, so the guard's `profiles.id` is the whole context it needs. The cast
 * is narrow and deliberate — building a fake `AuthContext` with invented roles
 * would be worse, because the DB, not this object, decides the answer.
 */
async function guardHoldsOperatorCap(tx: Sql, profileId: string): Promise<boolean> {
  const declared = await tx<{ declared: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM public.role_capabilities rc
       WHERE rc.capability = ${OPERATOR_CAP}
          OR rc.capability LIKE ${`${OPERATOR_CAP}.%`}
    ) AS declared
  `;
  if (declared[0]?.declared !== true) return true; // not declared → row-based authority
  return await hasCapDb(tx, { userId: profileId } as unknown as AuthContext, OPERATOR_CAP);
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ──────────────────────────────────────────────
  if (req.method !== "POST") {
    return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);
  }

  // ── STEP 3 · request_id + timer ────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model D: device HMAC) ────────────────────────────────
    // Raw bytes first: the signature covers exactly what was sent.
    const rawBody = await readRawBody(req, { maxBytes: 8 * 1024 });
    const decoded = decodeJson(rawBody);
    const deviceAuth = await verifyDevice(req, rawBody);
    const device = deviceAuth.device;

    // ── STEP 5 · Authority ─────────────────────────────────────────────────
    // The device's authority is its pairing, already checked. The body must name
    // the same device that signed — a signed envelope addressed elsewhere is a
    // bug or an attack, never a retry.
    const claimedDeviceId = typeof decoded === "object" && decoded !== null
      ? (decoded as Record<string, unknown>).device_id
      : undefined;
    if (typeof claimedDeviceId === "string" && claimedDeviceId !== device.id) {
      throw forbidden(
        "The body and the signature disagree about which device this is.",
        "KIOSK_DEVICE_MISMATCH",
      );
    }

    // ── STEP 6 · Rate limit (device level) ─────────────────────────────────
    // Outside any transaction, so a refused request still spends its token. The
    // per-guard PIN bucket is taken separately, just before the Argon2 pass.
    await enforce(RATE_LIMITS.kioskHeartbeat, limitKey(FN_NAME, device.id), "KIOSK_RATE_LIMITED");

    // ── STEP 7 · Validate ──────────────────────────────────────────────────
    const body = parse(OperatorAuthBody, decoded, "operator auth body");

    // ── STEP 8 · Idempotency claim ─────────────────────────────────────────
    // The default key is the HMAC nonce, which is single-use per device, so a
    // true wire replay is already refused at step 4 with 409 KIOSK_NONCE_REPLAY.
    // The claim earns its keep when the tablet supplies its own key across a
    // reconnect.
    idempotencyKey = idempotencyKeyFrom(req) ?? `${FN_NAME}:${device.id}:${deviceAuth.nonce}`;
    const bodyHash = await requestHash(FN_NAME, rawBody, device.id);
    const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: bodyHash });
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { device_id: device.id, op: body.op });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    const pool = sql();
    const settingsRows = await pool`
      SELECT s.key, s.value #>> '{}' AS value
        FROM public.settings s
       WHERE s.key = ANY(${[...SETTING_KEYS]}::text[])
       ORDER BY (s.scope = 'global') DESC
    `;
    const settings = new Map<string, string | null>();
    for (const s of settingsRows as unknown as { key: string; value: string | null }[]) {
      if (!settings.has(s.key)) settings.set(s.key, s.value);
    }
    const setting = (key: typeof SETTING_KEYS[number], fallback: number): number => {
      const raw = settings.get(key);
      const parsed = raw === null || raw === undefined ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    const maxPinAttempts = Math.trunc(setting("kiosk.max_pin_attempts", DEFAULT_MAX_PIN_ATTEMPTS));
    const pinLockMinutes = Math.trunc(setting("kiosk.pin_lock_minutes", DEFAULT_PIN_LOCK_MINUTES));
    const idleTimeoutMinutes = Math.trunc(
      setting("kiosk.operator_idle_timeout_minutes", DEFAULT_IDLE_TIMEOUT_MINUTES),
    );

    const baseCtx: RequestContext = {
      // Not the guard: identity is unproven until the PIN verifies. The success
      // path re-builds this with `actorId` set.
      actorId: null,
      actorRole: null,
      source: "kiosk",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: device.id,
    };

    const serverTime = nowIso();
    const deviceBlock = {
      device_id: device.id,
      device_code: device.deviceCode,
      device_name: device.label,
      require_operator: device.requireOperator,
    };

    let responseBody: Record<string, unknown>;
    /** What gets stored under the idempotency key: the token is stripped out. */
    let storedBody: Record<string, unknown>;

    if (body.op === "open") {
      // ── op=open · PIN sign-in ────────────────────────────────────────────
      // Per-guard bucket: 5 attempts / 15 minutes (spec-kiosk §8.1), keyed by
      // the identifier the keypad sent so one guard's fat fingers cannot lock
      // the whole device out.
      const identifier = body.operator_id ?? body.employee_code ?? "unknown";
      await enforce(
        RATE_LIMITS.kioskOperatorAuth,
        limitKey(FN_NAME, device.id, identifier),
        "KIOSK_OPERATOR_PIN_RATE_LIMITED",
      );

      const rows = await pool<OperatorRow[]>`
        SELECT o.id,
               o.profile_id,
               o.employee_id,
               o.can_enrol_faces,
               o.can_manual_punch,
               o.shift_window,
               e.display_name,
               e.employee_code,
               e.employment_status::text AS employment_status,
               p.is_active               AS profile_active,
               s.pin_hash,
               s.previous_pin_hash,
               s.rotation_grace_until,
               s.failed_attempts,
               s.locked_until
          FROM public.kiosk_operators o
          JOIN public.profiles p ON p.id = o.profile_id
          LEFT JOIN public.employees e ON e.id = o.employee_id AND e.deleted_at IS NULL
          LEFT JOIN secure.kiosk_operator_secrets s ON s.operator_id = o.id
         WHERE o.is_active
           -- NULL kiosk_device_id = authorised on every device (migration 013).
           AND (o.kiosk_device_id IS NULL OR o.kiosk_device_id = ${device.id}::uuid)
           AND (
             (${body.operator_id ?? null}::uuid IS NOT NULL AND o.id = ${body.operator_id ?? null}::uuid)
             OR (${body.employee_code ?? null}::text IS NOT NULL AND e.employee_code = ${body.employee_code ?? null}::text)
           )
         ORDER BY (o.kiosk_device_id IS NOT NULL) DESC
         LIMIT 1
      `;
      const operator = firstRow(rows);

      // Lockout is checked before the Argon2 pass, and it is the ONE case that
      // gets its own status: a guard who has locked themselves out needs to know
      // to wait rather than keep guessing.
      if (operator !== null && operator.locked_until !== null) {
        const remaining = secondsBetween(serverTime, operator.locked_until);
        if (remaining > 0) {
          log.warn("operator PIN locked out", { operator_id: operator.id, remaining_seconds: remaining });
          throw tooMany(
            remaining * 1000,
            `Too many wrong PINs. Try again in ${Math.ceil(remaining / 60)} minute(s), or ask a supervisor.`,
            "KIOSK_OPERATOR_PIN_LOCKED",
          );
        }
      }

      const graceOpen = operator !== null && operator.rotation_grace_until !== null &&
        secondsBetween(serverTime, operator.rotation_grace_until) > 0;
      const matchedSlot = operator === null ? -1 : await verifyAgainst(
        [operator.pin_hash, graceOpen ? operator.previous_pin_hash : null],
        body.pin,
      );

      /*
        BEFORE refusing with the generic message, find out whether this is actually
        "you are not allowed on THIS gate" — because that answer is unreachable by
        retyping and the generic sentence sends people in circles.

        This cost the client real time. They set a PIN for TT0002, paired a new
        device, typed both correctly, and got "That code and PIN do not match"
        forever: both operators carried `kiosk_device_id = TT-GATE-01`, so on the new
        device the lookup above matched nothing and fell into the wrong-PIN branch.
        Migration 074 makes active operators device-agnostic, so this is now rare —
        but "rare" is not "impossible", and a diagnostic that lies is worse than no
        diagnostic.

        THE TRADE: this confirms the typed code belongs to an active operator
        somewhere. That is a small disclosure — the caller already holds a paired
        device secret and a valid HMAC signature to get this far, the attempt is
        rate-limited, and PIN attempts still lock out after five. Weighed against a
        guard and an admin unable to tell a misconfiguration from a typo at a gate
        with a queue in front of it, the trade is worth making. It is deliberately
        NOT extended to "no such employee" or "no PIN set", which stay generic.
      */
      if (operator === null && body.employee_code !== undefined) {
        const elsewhere = firstRow(
          await pool<{ device_code: string | null }[]>`
            SELECT d.device_code
              FROM public.kiosk_operators o
              JOIN public.profiles p ON p.id = o.profile_id AND p.is_active
              JOIN public.employees e
                ON e.id = o.employee_id AND e.deleted_at IS NULL
              LEFT JOIN public.kiosk_devices d ON d.id = o.kiosk_device_id
             WHERE o.is_active
               AND e.employee_code = ${body.employee_code}::text
               AND o.kiosk_device_id IS NOT NULL
               AND o.kiosk_device_id <> ${device.id}::uuid
             LIMIT 1
          `,
        );
        if (elsewhere !== null) {
          log.warn("operator not authorised on this device", {
            device_id: device.id,
            bound_to: elsewhere.device_code,
          });
          throw forbidden(
            "This guard is set up for a different gate device, so their PIN will not work here. An administrator can allow them on this gate.",
            "KIOSK_OPERATOR_WRONG_DEVICE",
          );
        }
      }

      if (operator === null || matchedSlot < 0) {
        // Record the refusal in its OWN transaction, then refuse: a throw inside
        // `withContext` would roll the counter and the audit row back, and a
        // lockout that forgets its attempts is not a lockout.
        await withContext(baseCtx, async (tx) => {
          if (operator !== null) {
            await tx`
              UPDATE secure.kiosk_operator_secrets
                 SET failed_attempts = failed_attempts + 1,
                     locked_until    = CASE
                       WHEN failed_attempts + 1 >= ${maxPinAttempts}::integer
                         THEN now() + make_interval(mins => ${pinLockMinutes}::integer)
                       ELSE locked_until
                     END
               WHERE operator_id = ${operator.id}::uuid
            `;
          }
          await auditSession(tx, baseCtx, {
            event: "login_failed",
            profileId: operator?.profile_id ?? null,
            authMethod: "kiosk_pin",
            failureReason: operator === null
              ? "kiosk_operator_unknown"
              : "kiosk_operator_pin_invalid",
          });
        });
        log.warn("operator sign-in refused", {
          device_id: device.id,
          known_operator: operator !== null,
        });
        throw pinRefused();
      }

      // The account is disabled, or the guard is no longer on the payroll in a
      // state that may stand at the gate. Same opaque answer either way: a kiosk
      // keypad is not the place to learn about someone's employment status.
      // `employment_status` is NULL for an operator with no employee record
      // (a contracted security agency login) — the profile gate governs those.
      if (
        operator.profile_active !== true ||
        (operator.employment_status !== null &&
          BLOCKED_EMPLOYMENT_STATUSES.has(operator.employment_status))
      ) {
        log.warn("operator sign-in refused: account not eligible", {
          operator_id: operator.id,
          profile_active: operator.profile_active,
          employment_status: operator.employment_status,
        });
        throw pinRefused();
      }

      const successCtx: RequestContext = {
        ...baseCtx,
        actorId: operator.profile_id,
        reason: `kiosk guard session opened on ${device.deviceCode} by PIN`,
      };

      const opened = await withContext(successCtx, async (tx) => {
        if (!(await guardHoldsOperatorCap(tx, operator.profile_id))) {
          throw forbidden(
            "This account is not authorised to operate a kiosk.",
            "KIOSK_OPERATOR_NOT_AUTHORISED",
          );
        }

        // Clear the lockout counters and stamp the sign-in. The stamp fires
        // `trg_kiosk_operators__audit`, which is the audit trail for "who was on
        // the gate"; `kiosk_operators` is not in `audit.reason_required_tables`,
        // but a reason is set anyway because it is genuinely useful here.
        await tx`
          UPDATE secure.kiosk_operator_secrets
             SET failed_attempts = 0,
                 locked_until    = NULL
           WHERE operator_id = ${operator.id}::uuid
        `;
        const stamped = await tx`
          UPDATE public.kiosk_operators
             SET last_signed_in_at = now()
           WHERE id = ${operator.id}::uuid
             AND is_active
          RETURNING id, last_signed_in_at
        `;
        if ((stamped as unknown as unknown[]).length === 0) {
          // Deactivated between the read and the write.
          throw forbidden(
            "This account is not authorised to operate a kiosk.",
            "KIOSK_OPERATOR_NOT_AUTHORISED",
          );
        }

        // ── STEP 10 · Audit, same transaction ──────────────────────────────
        await auditSession(tx, successCtx, {
          event: "login_success",
          profileId: operator.profile_id,
          authMethod: "kiosk_pin",
        });

        return (stamped as unknown as Record<string, unknown>[])[0] as Record<string, unknown>;
      });

      // The token is minted AFTER the transaction commits: a rolled-back
      // sign-in must never leave a usable credential in the guard's hands.
      const session = await mintOperatorSession(deviceAuth.secret, {
        deviceId: device.id,
        operatorId: operator.id,
        ttlSeconds: SESSION_TTL_SECONDS,
      });

      if (matchedSlot === 1) {
        log.warn("operator signed in with the previous PIN during a rotation grace window", {
          operator_id: operator.id,
        });
      }
      log.info("operator session opened", {
        device_id: device.id,
        operator_id: operator.id,
        employee_code: operator.employee_code,
      });

      const operatorBlock = {
        operator_id: operator.id,
        display_name: operator.display_name,
        employee_code: operator.employee_code,
        can_enrol_faces: operator.can_enrol_faces === true,
        can_manual_punch: operator.can_manual_punch === true,
        shift_window: operator.shift_window,
        /** True when the guard's PIN is on its way out — K1 shows a "change PIN" nudge. */
        pin_rotation_pending: matchedSlot === 1,
        signed_in_at: toIso(opened.last_signed_in_at as string | Date),
      };
      const shared = {
        op: "open" as const,
        device: deviceBlock,
        operator: operatorBlock,
        idle_timeout_minutes: idleTimeoutMinutes,
        scans_this_session: 0,
        server_time: serverTime,
        server_business_date: istDate(serverTime),
        clock_skew_seconds: deviceAuth.clockSkewSeconds,
        replayed: false,
        request_id: requestId,
      };
      responseBody = {
        ...shared,
        session: {
          token: session.token,
          session_id: session.sessionId,
          expires_at: session.expiresAt,
          expires_in_seconds: SESSION_TTL_SECONDS,
          /** Refresh well before expiry: `op=heartbeat`, no PIN. */
          refresh_after_seconds: Math.floor(SESSION_TTL_SECONDS / 2),
          header: "x-operator-session",
        },
      };
      storedBody = {
        ...shared,
        session: { session_id: session.sessionId, expires_at: session.expiresAt, token: null },
        token_omitted_from_replay: true,
      };
    } else if (body.op === "heartbeat") {
      // ── op=heartbeat · silent refresh ────────────────────────────────────
      // Verifies the live token (which re-reads the operator row, so a guard
      // deactivated mid-shift stops here) and issues a fresh 10-minute one.
      const current = await requireOperatorSession(req, deviceAuth, pool);

      // Idle timeout. ADVISORY, and knowingly so: `last_scan_at` is device time
      // and there is no session table holding a server-side "last activity".
      // Refusing on it still ends an abandoned session in the normal case (the
      // tablet reports honestly), and a tampered value buys at most the 10-minute
      // token life — which is the same bound as everything else here.
      if (body.last_scan_at !== null && body.last_scan_at !== undefined) {
        const idleMinutes = minutesBetween(body.last_scan_at, serverTime);
        if (idleMinutes > idleTimeoutMinutes) {
          log.info("operator session ended on idle timeout", {
            operator_id: current.operatorId,
            idle_minutes: idleMinutes,
          });
          throw forbidden(
            `No scans for ${idleMinutes} minutes. Sign in again to continue.`,
            "KIOSK_OPERATOR_SESSION_IDLE",
          );
        }
      }

      const session = await mintOperatorSession(deviceAuth.secret, {
        deviceId: device.id,
        operatorId: current.operatorId,
        ttlSeconds: SESSION_TTL_SECONDS,
      });

      // No audit row, and no `withContext`: a refresh changes nothing. Auditing
      // it would add ~150 hash-chained rows per device per day of pure jitter,
      // for the same reason migration 050 §6 took the heartbeat off the trigger.
      const shared = {
        op: "heartbeat" as const,
        device: deviceBlock,
        operator: {
          operator_id: current.operatorId,
          display_name: current.displayName,
          employee_code: current.employeeCode,
          can_enrol_faces: current.canEnrolFaces,
          can_manual_punch: current.canManualPunch,
          // `shift_window` is deliberately absent rather than null: the tablet
          // already has it from `op=open`, and a null would let a blind merge
          // erase it.
        },
        idle_timeout_minutes: idleTimeoutMinutes,
        scans_this_session: body.scans_this_session ?? null,
        server_time: serverTime,
        server_business_date: istDate(serverTime),
        clock_skew_seconds: deviceAuth.clockSkewSeconds,
        replayed: false,
        request_id: requestId,
      };
      responseBody = {
        ...shared,
        session: {
          token: session.token,
          session_id: session.sessionId,
          expires_at: session.expiresAt,
          expires_in_seconds: SESSION_TTL_SECONDS,
          refresh_after_seconds: Math.floor(SESSION_TTL_SECONDS / 2),
          header: "x-operator-session",
          /** The previous session id, so the tablet can log the continuity. */
          replaced_session_id: current.sessionId,
        },
      };
      storedBody = {
        ...shared,
        session: { session_id: session.sessionId, expires_at: session.expiresAt, token: null },
        token_omitted_from_replay: true,
      };
    } else {
      // ── op=close · end of shift / handover (K10) ─────────────────────────
      const current = await requireOperatorSession(req, deviceAuth, pool);
      const closeCtx: RequestContext = {
        ...baseCtx,
        actorId: current.profileId,
        reason: `kiosk guard session closed on ${device.deviceCode}` +
          (body.reconciliation_ok === false ? " with a count mismatch reported by the guard" : ""),
      };

      await withContext(closeCtx, async (tx) => {
        // ── STEP 10 · Audit, same transaction ──────────────────────────────
        // `sessions_audit` + a hash-chained `logout` row, then one row carrying
        // the handover facts a column diff cannot show.
        await auditSession(tx, closeCtx, {
          event: "logout",
          profileId: current.profileId,
          authMethod: "kiosk_pin",
        });
        await writeAudit(tx, closeCtx, {
          action: "logout",
          entityTable: "public.kiosk_operators",
          entityId: current.operatorId,
          entityLabel: current.employeeCode ?? current.displayName ?? "kiosk operator",
          subjectEmployeeId: current.employeeId,
          fieldName: "operator_session",
          newValue: {
            session_id: current.sessionId,
            device_code: device.deviceCode,
            scans_this_session: body.scans_this_session ?? null,
            reconciliation_ok: body.reconciliation_ok ?? null,
            handover_note: body.handover_note ?? null,
          },
        });
      });

      if (body.reconciliation_ok === false) {
        // EXC-HANDOVER-MISMATCH (spec-kiosk §7 K10) needs the attendance
        // exception contract, which is `kiosk-punch`'s to own. Until then the
        // mismatch is on the audit chain and in the logs, not silently dropped.
        log.warn("handover count mismatch reported", {
          operator_id: current.operatorId,
          scans_this_session: body.scans_this_session ?? null,
        });
      }
      log.info("operator session closed", {
        device_id: device.id,
        operator_id: current.operatorId,
      });

      responseBody = {
        op: "close" as const,
        device: deviceBlock,
        operator: {
          operator_id: current.operatorId,
          display_name: current.displayName,
          employee_code: current.employeeCode,
        },
        session: {
          session_id: current.sessionId,
          closed: true,
          /**
           * Honest about the stateless model: the token stops being ACCEPTED at
           * its own expiry. Wipe it from the tablet now — that is what makes the
           * close effective in practice.
           */
          token_valid_until: current.expiresAt,
          discard_token_now: true,
        },
        scans_this_session: body.scans_this_session ?? null,
        reconciliation_ok: body.reconciliation_ok ?? null,
        server_time: serverTime,
        server_business_date: istDate(serverTime),
        replayed: false,
        request_id: requestId,
      };
      storedBody = responseBody;
    }

    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ─────────────
    // Session tokens are stripped: `public.idempotency_keys` is a 24-hour cache,
    // and a credential that unlocks the punch path has no business living in one.
    await store(idempotencyKey, status, storedBody);

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

    if (problem.isServerFault) {
      log.error("unhandled failure", { err, code: problem.code });
    } else {
      log.warn("request refused", { code: problem.code, status });
    }
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported for `supabase/tests` and the tablet SDK — one schema, both sides. */
export { CloseBody, HeartbeatBody, OpenBody, OPERATOR_CAP, OperatorAuthBody, SESSION_TTL_SECONDS };

/** Kept out of the request path: proves the pool is reachable from a smoke test. */
export async function pingDatabase(): Promise<boolean> {
  const rows = await sql()`SELECT 1 AS ok`;
  return (rows as unknown as { ok: number }[])[0]?.ok === 1;
}
