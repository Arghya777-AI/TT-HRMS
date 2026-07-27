/**
 * kiosk-heartbeat — catalogue #4, auth model **D** (device HMAC).
 *
 * REFERENCE IMPLEMENTATION. This file exists to be copied: it walks the 12-step
 * request lifecycle of spec-architecture §4 in order, with each step labelled.
 * Every other function in the catalogue should read top-to-bottom like this one.
 *
 * What it does (the smallest useful mutation in the system):
 *   verify the device signature → record liveness, clock skew and app version on
 *   `public.kiosk_devices` → answer with server time, the acknowledged queue
 *   depth and the config the tablet needs.
 *
 * Kiosk hard rule (§6, test T-09): the tablet is not a user and has no DB
 * credential. The response body below is an explicit allowlist — no descriptor,
 * no salary, no phone, no address, no leave, no employee list. Adding a field
 * here is a security decision.
 *
 * DELIBERATELY NOT IMPLEMENTED HERE: the signed offline roster of
 * `{employee_code, display_name}` that spec-kiosk §5.2/§9 refreshes on each
 * heartbeat. It is the one part of the response that ships employee data to a
 * tablet, and it needs a decision this function should not make alone: the
 * signing key and canonical form of `roster_signature`, and whether an unasked
 * 60-second heartbeat should carry the whole venue's roster. Handed to the
 * kiosk-punch/offline work with `roster_version` as the natural request field.
 */

import { handlePreflight, assertOriginAllowed, corsHeaders } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem, unauthorized, unprocessable } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { istDate, nowIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  type RequestContext,
  requestIdFrom,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { sha256Hex, verifyDevice } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { claim, idempotencyKeyFrom, release, replayResponse, requestHash, store } from "../_shared/idempotency.ts";

const FN_NAME = "kiosk-heartbeat";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/**
 * `.strict()` on purpose: an unexpected key is a 422, not a silent ignore. The
 * kiosk and this schema are one contract, and a typo in the tablet build should
 * fail loudly in QA rather than quietly stop reporting battery level.
 *
 * INV-1: every timestamp the device sends is METADATA. Server `now()` is truth.
 */
const HeartbeatBody = z
  .object({
    device_id: common.uuid,
    queue_depth: z.number().int().min(0).max(100_000),
    oldest_queued_at: common.instant.nullish(),
    app_version: common.appVersion.optional(),
    device_now: common.instant.optional(),
    battery_pct: z.number().int().min(0).max(100).nullish(),
    charging: z.boolean().nullish(),
    camera_ok: z.boolean().nullish(),
    last_scan_at: common.instant.nullish(),
    network: z
      .object({
        type: z.string().max(24).optional(),
        /** Already hashed on the device — a raw BSSID is location data we do not want. */
        bssid_hash: z.string().max(128).optional(),
        downlink_mbps: z.number().nonnegative().max(10_000).optional(),
      })
      .strict()
      .nullish(),
    operator_session_id: common.uuid.nullish(),
  })
  .strict();

/** |skew| beyond this and the tablet must stop queueing offline (spec-kiosk KS-1..4: 60 000 ms). */
const OFFLINE_FORBIDDEN_SKEW_SECONDS = 60;

/** Settings the tablet is allowed to know, seeded in migration 046. */
const CONFIG_KEYS = [
  "kiosk.heartbeat_interval_seconds",
  "kiosk.offline_queue_max",
  "kiosk.min_confidence",
  "kiosk.min_margin",
  "kiosk.debounce_seconds",
  "kiosk.punch_photo_url_ttl_seconds",
  "kiosk.require_liveness",
] as const;

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
  let responseBody: unknown = null;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model D: device HMAC) ────────────────────────────────
    // The raw body is read BEFORE parsing because the signature covers the exact
    // bytes sent. Decode and re-serialise and the HMAC will not match.
    const rawBody = await readRawBody(req, { maxBytes: 8 * 1024 });
    const decoded = decodeJson(rawBody);
    const deviceAuth = await verifyDevice(req, rawBody);
    const device = deviceAuth.device;
    log.info("device authenticated", {
      device_id: device.id,
      device_code: device.deviceCode,
      clock_skew_seconds: deviceAuth.clockSkewSeconds,
    });

    // ── STEP 5 · Authority ─────────────────────────────────────────────────
    // A device has no capability row: its authority IS its pairing, and
    // `verifyDevice` has already refused an unpaired, suspended or off-network
    // tablet. What remains is that the body must describe the SAME device that
    // signed the request — a signed envelope addressed to another device is a bug
    // or an attack, never a retry.
    const claimedDeviceId = typeof decoded === "object" && decoded !== null
      ? (decoded as Record<string, unknown>).device_id
      : undefined;
    if (typeof claimedDeviceId === "string" && claimedDeviceId !== device.id) {
      throw unprocessable(
        [{ pointer: "/device_id", code: "mismatch", detail: "device_id does not match the signing device." }],
        "The body and the signature disagree about which device this is.",
        "KIOSK_DEVICE_MISMATCH",
      );
    }

    // ── STEP 6 · Rate limit ────────────────────────────────────────────────
    // Shared Postgres token bucket, keyed by device, taken OUTSIDE the business
    // transaction so a throttled or failed call still spends its token.
    await enforce(RATE_LIMITS.kioskHeartbeat, limitKey(FN_NAME, device.id), "KIOSK_RATE_LIMITED");

    // ── STEP 7 · Validate ──────────────────────────────────────────────────
    const body = parse(HeartbeatBody, decoded, "heartbeat body");

    // ── STEP 8 · Idempotency claim ─────────────────────────────────────────
    // The tablet may retry a heartbeat after a network stall. The HMAC nonce is
    // already single-use per device, which makes it the natural key when the
    // client does not supply one.
    idempotencyKey = idempotencyKeyFrom(req) ?? `${FN_NAME}:${device.id}:${deviceAuth.nonce}`;
    const hash = await requestHash(FN_NAME, rawBody, device.id);
    const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: hash });
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { device_id: device.id, key: idempotencyKey });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    // ── STEP 9 · app.set_context + ONE transaction ─────────────────────────
    // No `reason` — deliberately. `public.kiosk_devices` IS in
    // `audit.reason_required_tables`, but migration 050 §6 narrowed
    // `trg_kiosk_devices__audit` to `UPDATE OF <config columns>`. The three
    // columns written below are telemetry and are not in that list, so the
    // statement never reaches `audit.log_changes()` and never demands a reason.
    // A config change (label, require_operator, revoked_at, …) still audits, and
    // still needs one.
    //
    // The context is set anyway: `util.touch_row()` stamps `updated_by` from
    // `app.ctx_actor_id()`, and if a future statement here does touch a config
    // column the actor/source/device/request_id are already in place rather than
    // the write landing as "nobody".
    const ctx: RequestContext = {
      actorId: null, // a kiosk is not a person
      actorRole: null,
      source: "kiosk",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: device.id,
    };

    const result = await withContext(ctx, async (tx) => {
      // Telemetry only. `app_version` is COALESCEd so a heartbeat that omits it
      // cannot erase a known version.
      const updated = await tx`
        UPDATE public.kiosk_devices d
           SET last_seen_at       = now(),
               app_version        = COALESCE(${body.app_version ?? null}::text, d.app_version),
               clock_skew_seconds = ${deviceAuth.clockSkewSeconds}::integer
         WHERE d.id = ${device.id}::uuid
           AND d.deleted_at IS NULL
        RETURNING d.last_seen_at, d.app_version, d.clock_skew_seconds, d.max_offline_queue,
                  d.require_operator, d.min_match_confidence
      `;
      if ((updated as unknown as unknown[]).length === 0) {
        // Soft-deleted between step 4 and here. The tablet must re-pair; it is
        // told nothing about why the row is gone.
        throw unauthorized("This device is not paired.", "KIOSK_DEVICE_UNKNOWN");
      }

      const settings = await tx`
        SELECT s.key, s.value #>> '{}' AS value
          FROM public.settings s
         WHERE s.key = ANY(${[...CONFIG_KEYS]}::text[])
         ORDER BY (s.scope = 'global') DESC
      `;

      // ── STEP 10 · Audit, in the SAME transaction ─────────────────────────
      // Nothing to write, and nothing written: after migration 050 §6 a
      // heartbeat produces ZERO audit rows by design. At 60-second intervals a
      // per-field chain row per device would be ~1,400 rows/device/day of pure
      // jitter, burying the config changes that matter. Do not add a
      // `writeAudit` call here.
      //
      // For a function that DOES mutate business data, this is where the audit
      // row goes — inside this transaction, so a rollback loses the change and
      // its audit row together. Row changes on audited tables need nothing
      // (`audit.log_changes()` fires); events no trigger can see (login, export,
      // reveal, AI query) call `_shared/audit.ts`.

      // First row per key wins, and the ORDER BY above put `scope = 'global'`
      // first — the same precedence `app.setting()` uses.
      const config = new Map<string, string | null>();
      for (const s of settings as unknown as { key: string; value: string | null }[]) {
        if (!config.has(s.key)) config.set(s.key, s.value);
      }

      return {
        row: (updated as unknown as Record<string, unknown>[])[0] as Record<string, unknown>,
        settings: config,
      };
    });

    const serverTime = nowIso();
    const skew = deviceAuth.clockSkewSeconds;
    const maxQueue = Number(result.row.max_offline_queue ?? device.maxOfflineQueue);
    const num = (key: typeof CONFIG_KEYS[number], fallback: number): number => {
      const raw = result.settings.get(key);
      const parsed = raw === null || raw === undefined ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const bool = (key: typeof CONFIG_KEYS[number], fallback: boolean): boolean => {
      const raw = result.settings.get(key);
      if (raw === null || raw === undefined) return fallback;
      return raw === "true" || raw === "t" || raw === "1";
    };

    const config = {
      heartbeatIntervalSeconds: num("kiosk.heartbeat_interval_seconds", 60),
      offlineQueueMax: maxQueue,
      minMatchConfidence: Number(result.row.min_match_confidence ?? device.minMatchConfidence),
      debounceSeconds: num("kiosk.debounce_seconds", 120),
      punchPhotoUrlTtlSeconds: num("kiosk.punch_photo_url_ttl_seconds", 60),
      requireLiveness: bool("kiosk.require_liveness", true),
      minMargin: num("kiosk.min_margin", 0.06),
    };

    // Content-addressed, so the tablet re-applies config only when it changed.
    // Derived from the values themselves — there is no config_version column to
    // read, and inventing a counter nobody increments would be worse than none.
    const configVersion = (await sha256Hex(JSON.stringify(config))).slice(0, 16);

    // Response allowlist — kiosk hard rule (§6, test T-09). Nothing about any
    // employee: no descriptor, no salary, no phone, no address, no leave.
    //
    // Both namings are emitted on purpose. spec-kiosk §5.2 specifies snake_case
    // (`server_time`, `skew_ms`, `offline_allowed`, `device_status`,
    // `config_version`, `commands`); the edge-layer convention for new fields is
    // camelCase. They are the same values, so the tablet build can settle on
    // either without a server change. Do not let them drift apart.
    responseBody = {
      // spec-kiosk §5.2
      server_time: serverTime,
      skew_ms: skew * 1000,
      offline_allowed: Math.abs(skew) <= OFFLINE_FORBIDDEN_SKEW_SECONDS,
      device_status: "active" as const,
      config_version: configVersion,
      // Remote commands (wipe_queue_after_sync / force_selftest /
      // end_operator_session / suspend) need a device-command queue table that
      // migrations 001–050 do not create. Always empty until it exists — an
      // invented command channel is worse than an honest empty one.
      commands: [] as string[],
      // camelCase mirror + the fields the kiosk needs that §5.2 omits
      serverTime,
      serverBusinessDate: istDate(serverTime),
      queueDepthAck: body.queue_depth,
      queueOverLimit: body.queue_depth > maxQueue,
      clockSkewSeconds: skew,
      offlineAllowed: Math.abs(skew) <= OFFLINE_FORBIDDEN_SKEW_SECONDS,
      deviceStatus: "active" as const,
      requireOperator: result.row.require_operator === true,
      config,
      configVersion,
      requestId,
    };
    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ─────────────
    await store(idempotencyKey, status, responseBody);

    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    // A 5xx is not a deterministic answer: drop the claim so the tablet's retry
    // is processed for real instead of replaying our failure.
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

/**
 * Not used by the handler — exported so `supabase/tests` and the kiosk SDK can
 * assert against the same schema the function enforces.
 */
export { HeartbeatBody };

/** Kept out of the request path: proves the pool is reachable from a smoke test. */
export async function pingDatabase(): Promise<boolean> {
  const rows = await sql()`SELECT 1 AS ok`;
  return (rows as unknown as { ok: number }[])[0]?.ok === 1;
}
