/**
 * kiosk-device-activate — catalogue #2 (aka `kiosk-pair`), auth model
 * **none + one-time activation code**.
 *
 * One-time tablet pairing. An admin pre-provisions the device row (it carries a
 * `location_id`, a `device_code` and a label that a tablet cannot invent) and
 * issues a short-lived activation code. This function trades that code, exactly
 * once, for the device's HMAC shared secret:
 *
 *   1. verify the 6-digit code against its Argon2id hash (single use, ≤15 min)
 *   2. mint a 256-bit secret, `kdt_…`
 *   3. write the RAW secret to Vault under `kiosk_devices.vault_secret_name`
 *      — this is what `auth.verifyDevice()` reads via `app.secret()`
 *   4. write the Argon2id hash to `secure.kiosk_device_secrets` — the
 *      presence/rotation record; a one-way hash cannot compute an HMAC
 *   5. activate the device row, seeding `allowed_ip_cidrs` from the request IP
 *   6. return the secret ONCE, with the signing recipe and tablet config
 *
 * SECURITY NOTES THAT ARE LOAD-BEARING
 * - The secret is returned in this response and never again. It is redacted from
 *   the stored idempotency response (step 11) on purpose: `public.idempotency_keys`
 *   is a 24-hour cache and a device credential has no business sitting in it. A
 *   replay therefore says "already issued" and the installer re-pairs with a new
 *   code. Storage-of-secret and return-of-secret are different decisions.
 * - `kdt_` prefix is not decoration: log.ts redacts `\bkdt_[A-Za-z0-9_-]{16,}`,
 *   so the secret is unloggable by construction even by a careless future edit.
 * - Vault is REQUIRED. If `vault.secrets` is unreachable the pairing fails whole:
 *   a hash without a Vault entry is a device that can never sign a request
 *   (`verifyDevice` → `KIOSK_DEVICE_SECRET_UNAVAILABLE`), and silently handing a
 *   tablet a dead secret is worse than an honest 503.
 *
 * DB SUBSTITUTION (no migration invented): migrations 001–050 create no
 * activation-code table. `secure.api_keys` is the existing "machine credentials
 * for the kiosk … full key displayed exactly once" table, with `key_hash`
 * (Argon2id), `kiosk_device_id`, `expires_at` and `revoked_at` — exactly the
 * shape a pairing code needs. A row with scope `kiosk.activate` IS an activation
 * code. See the return notes for the admin-side contract.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  conflict,
  gone,
  methodNotAllowed,
  ok,
  toProblem,
  unauthorized,
  unavailable,
} from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { istDate, nowIso, toIso } from "../_shared/datetime.ts";
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
  DEVICE_MAX_SKEW_SECONDS,
  deviceCanonicalString,
  sha256Hex,
  VAULT_SECRET_PREVIOUS_SUFFIX,
} from "../_shared/auth.ts";
import { hashSecret, verifySecret } from "../_shared/argon2.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import {
  claim,
  idempotencyKeyFrom,
  release,
  replayResponse,
  requestHash,
  store,
} from "../_shared/idempotency.ts";
import { writeAudit, writeAuditOnPool } from "../_shared/audit.ts";

const FN_NAME = "kiosk-device-activate";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** `secure.api_keys.scopes` entry that makes a row an activation code and nothing else. */
const ACTIVATION_SCOPE = "kiosk.activate";

/** Most live codes to Argon2-verify against in one attempt. In practice 1–2 exist. */
const MAX_CODE_CANDIDATES = 20;

/** 256 bits of secret, `kdt_`-prefixed so log.ts redacts it wherever it lands. */
const SECRET_BYTES = 32;
const SECRET_PREFIX = "kdt_";

/** The operator-session TTL `kiosk-operator-auth` mints (spec-kiosk §5.3: 10 min). */
const DEVICE_SESSION_TTL_SECONDS = 600;

/** Settings the tablet is allowed to know (migration 046), same allowlist as `kiosk-heartbeat`. */
const CONFIG_KEYS = [
  "kiosk.heartbeat_interval_seconds",
  "kiosk.offline_queue_max",
  "kiosk.min_confidence",
  "kiosk.min_margin",
  "kiosk.debounce_seconds",
  "kiosk.punch_photo_url_ttl_seconds",
  "kiosk.require_liveness",
  "kiosk.retain_punch_photos_days",
] as const;

/**
 * `.strict()`: an unexpected key is a 422.
 *
 * `public_key_jwk` is accepted because spec-kiosk §5.1 has the tablet send it, and
 * is DELIBERATELY UNUSED — the device auth model in `_shared/auth.ts` is a shared
 * HMAC secret rather than a device-held EC key pair. It is echoed back in
 * `ignored_fields` so a tablet build can see it had no effect instead of assuming
 * it did.
 *
 * `proposed_name` USED TO BE IGNORED TOO, on the reasoning that "the device label
 * is the admin's to set, not the installer's". The client has overruled that, and
 * was right to:
 *
 *   "The device name shouldn't matter; they can put anything for the device name.
 *    Only the pairing code should match, then it should be automatically
 *    registered."
 *
 * The label is a human handle for a phone somebody is holding at a gate. The person
 * holding it knows what it is ("Rahul's phone", "back gate iPad"); an admin issuing
 * a code minutes earlier does not. So the name now lands on
 * `kiosk_devices.label`, and `device_code` — the internal handle, generated by
 * `kiosk-provision` — stays out of the guard's hands entirely.
 *
 * The pairing code remains the ONLY secret, which is safe because it is
 * Argon2id-hashed, single-use, expires in 15 minutes, and `RATE_LIMITS.kioskPair`
 * allows 10 attempts per hour per IP — roughly three guesses against 900,000
 * possibilities inside a code's lifetime.
 */
const ActivateBody = z
  .object({
    activation_code: z
      .string()
      .trim()
      .regex(/^\d{4,12}$/, "The activation code is 4–12 digits."),
    /** Narrows the candidate set to one device slot, e.g. `TTK-01`. Optional. */
    device_code: z.string().trim().min(1).max(64).optional(),
    device: z
      .object({
        model: z.string().trim().max(80).optional(),
        os: z.string().trim().max(80).optional(),
        platform: z.string().trim().max(80).optional(),
        app_version: common.appVersion,
        screen: z
          .object({
            width: z.number().int().positive().max(20_000),
            height: z.number().int().positive().max(20_000),
            dpr: z.number().positive().max(10).optional(),
          })
          .strict()
          .optional(),
        proposed_name: z.string().trim().max(120).optional(),
        public_key_jwk: z
          .object({
            kty: z.string().max(16),
            crv: z.string().max(24),
            x: z.string().max(256),
            y: z.string().max(256),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

interface CandidateRow {
  id: string;
  name: string;
  key_hash: string;
  kiosk_device_id: string;
  created_by: string | null;
  device_code: string;
  label: string;
  location_id: string;
  vault_secret_name: string | null;
}

/** `kdt_` + 32 random bytes, base64url. The exact string the tablet signs with. */
function generateDeviceSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${SECRET_PREFIX}${b64}`;
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
  const ip = clientIpFrom(req);

  let status = 500;
  let idempotencyKey: string | null = null;
  /** Set once a code has been matched, so the catch can audit a genuine failure. */
  let auditFailureFor: { deviceId: string | null; deviceCode: string | null } | null = null;

  try {
    assertOriginAllowed(req);

    const rawBody = await readRawBody(req, { maxBytes: 16 * 1024 });
    const decoded = decodeJson(rawBody);

    // ── STEP 4/5 · Auth + authority ─────────────────────────────────────────
    // There is no credential yet — that is the point of pairing. The activation
    // code IS the credential and it is verified below, AFTER the rate limit:
    // steps 4–6 are deliberately reordered here because verification costs an
    // Argon2id pass per live code and the caller is unauthenticated. An
    // unthrottled attacker must never be able to spend our CPU at will.
    //
    // Authority beyond the code: none is possible or needed. The code names the
    // device row (`secure.api_keys.kiosk_device_id`), so this function can only
    // ever activate a slot an admin already created.

    // ── STEP 6 · Rate limit (before the expensive verification) ─────────────
    await enforce(RATE_LIMITS.kioskPair, limitKey(FN_NAME, ip), "KIOSK_PAIR_RATE_LIMITED");

    // ── STEP 7 · Validate ──────────────────────────────────────────────────
    const body = parse(ActivateBody, decoded, "activation body");
    const ignoredFields: string[] = [];
    if (body.device.public_key_jwk !== undefined) ignoredFields.push("device.public_key_jwk");
    // `proposed_name` is NO LONGER ignored — it becomes the device's label. It must
    // therefore not be listed here, or the kiosk would be told its name was
    // discarded at the same moment the server applied it.

    // ── STEP 8 · Idempotency claim ─────────────────────────────────────────
    // Keyed by the body when the installer sends no header: a double-tap on
    // "Pair" then replays instead of burning a second code.
    const bodyHash = await requestHash(FN_NAME, rawBody);
    idempotencyKey = idempotencyKeyFrom(req) ?? `${FN_NAME}:${bodyHash.slice(0, 48)}`;
    const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: bodyHash });
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay of a pairing attempt", { key: idempotencyKey });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    // ── Verify the activation code (on the pool, before the write txn) ──────
    // Argon2id takes ~50 ms per candidate; holding a transaction open across it
    // would pin a connection and, if the code turns out to be wrong, roll back
    // the failure audit we want to keep.
    const pool = sql();
    const candidates = await pool<CandidateRow[]>`
      SELECT k.id,
             k.name,
             k.key_hash,
             k.kiosk_device_id,
             k.created_by,
             d.device_code,
             d.label,
             d.location_id,
             d.vault_secret_name
        FROM secure.api_keys k
        JOIN public.kiosk_devices d
          ON d.id = k.kiosk_device_id
         AND d.deleted_at IS NULL
       WHERE k.revoked_at IS NULL
         -- An activation code is short-lived by definition (spec-kiosk §5.1:
         -- 15 minutes). A never-expiring API key must not double as one.
         AND k.expires_at IS NOT NULL
         AND k.expires_at > now()
         AND k.scopes && ARRAY[${ACTIVATION_SCOPE}]::text[]
         AND (${body.device_code ?? null}::text IS NULL OR d.device_code = ${body.device_code ?? null}::text)
       ORDER BY k.created_at DESC
       LIMIT ${MAX_CODE_CANDIDATES}
    `;

    let matched: CandidateRow | null = null;
    for (const candidate of candidates) {
      if (await verifySecret(candidate.key_hash, body.activation_code)) {
        matched = candidate;
        break;
      }
    }
    if (matched === null) {
      // One code for both "no such code" and "expired/spent": an installer
      // holding a real code learns nothing less, and an attacker learns nothing.
      log.warn("activation code rejected", {
        device_code: body.device_code ?? null,
        live_candidates: candidates.length,
      });
      auditFailureFor = { deviceId: null, deviceCode: body.device_code ?? null };
      throw unauthorized(
        "That activation code is not valid. Ask an administrator for a new one.",
        "KIOSK_ACTIVATION_CODE_INVALID",
      );
    }

    const device = matched;
    const vaultName = device.vault_secret_name ?? `kiosk_device_secret:${device.kiosk_device_id}`;
    auditFailureFor = { deviceId: device.kiosk_device_id, deviceCode: device.device_code };
    log.info("activation code accepted", {
      device_id: device.kiosk_device_id,
      device_code: device.device_code,
      api_key_id: device.id,
    });

    // Mint and hash OUTSIDE the transaction: another ~50 ms of Argon2 that has
    // no reason to hold a database transaction open.
    const deviceSecret = generateDeviceSecret();
    const secretHash = await hashSecret(deviceSecret);

    // ── STEP 9 · app.set_context + ONE transaction ─────────────────────────
    // `public.kiosk_devices` is in `audit.reason_required_tables` and the
    // columns written below (is_active, allowed_ip_cidrs, vault_secret_name) are
    // in the narrowed audit trigger from migration 050 §6 — so a reason is
    // MANDATORY here, unlike the heartbeat path.
    //
    // The actor is the admin who issued the code, not the tablet: a kiosk is not
    // a person, but a human did authorise this pairing and `created_by`/
    // `updated_by`/the audit row should say who. `source` stays `kiosk`.
    const ctx: RequestContext = {
      actorId: device.created_by,
      actorRole: null,
      source: "kiosk",
      sourceRoute: FN_NAME,
      requestId,
      ip,
      ua: userAgentFrom(req),
      deviceId: device.kiosk_device_id,
      reason:
        `kiosk device pairing: activation code "${device.name}" redeemed for ${device.device_code} from ${ip ?? "an unknown address"}`,
    };

    const result = await withContext(ctx, async (tx) => {
      // (a) Spend the code. Atomic single-use: a second concurrent attempt with
      // the same code updates zero rows and is told the code is gone.
      const spent = await tx`
        UPDATE secure.api_keys
           SET revoked_at   = now(),
               last_used_at = now()
         WHERE id = ${device.id}::uuid
           AND revoked_at IS NULL
           AND expires_at > now()
        RETURNING id
      `;
      if ((spent as unknown as unknown[]).length === 0) {
        throw gone(
          "That activation code has already been used. Ask an administrator for a new one.",
          "KIOSK_ACTIVATION_CODE_CONSUMED",
        );
      }

      // (b) The raw secret goes to Vault, under the name the device row carries.
      // `app.secret()` swallows its own errors and returns NULL, so its absence
      // would surface later as an unpairable device — check explicitly instead.
      const vaultReady = await tx<{ present: boolean }[]>`
        SELECT to_regclass('vault.secrets') IS NOT NULL AS present
      `;
      if (vaultReady[0]?.present !== true) {
        throw unavailable(
          "Device pairing is unavailable: the server secret store is not provisioned.",
          "KIOSK_SECRET_STORE_UNAVAILABLE",
        );
      }

      const existing = await tx<{ id: string }[]>`
        SELECT id FROM vault.secrets WHERE name = ${vaultName} LIMIT 1
      `;
      const vaultDescription =
        `HMAC shared secret for kiosk device ${device.device_code} (${device.kiosk_device_id})`;
      const existingId = existing[0]?.id;
      if (existingId === undefined) {
        await tx`SELECT vault.create_secret(${deviceSecret}, ${vaultName}, ${vaultDescription})`;
      } else {
        // Re-pair of a device that had a secret: overwrite in place.
        await tx`
          SELECT vault.update_secret(${existingId}::uuid, ${deviceSecret}, ${vaultName}, ${vaultDescription})
        `;
      }
      // A predecessor secret left behind by an earlier rotation must not survive
      // a re-pair: `verifyDevice` accepts `<name>_prev` whenever a future
      // rotation grace window is open, and a stale entry would then be a live
      // credential for an install that no longer exists.
      await tx`
        DELETE FROM vault.secrets WHERE name = ${`${vaultName}${VAULT_SECRET_PREVIOUS_SUFFIX}`}
      `;

      // (c) The hash is the presence/rotation record (migration 050 §5). No
      // grace window on a pairing: there is no older install to keep alive.
      await tx`
        INSERT INTO secure.kiosk_device_secrets
          (device_id, secret_hash, secret_rotated_at, previous_secret_hash, rotation_grace_until)
        VALUES (${device.kiosk_device_id}::uuid, ${secretHash}, now(), NULL, NULL)
        ON CONFLICT (device_id) DO UPDATE
          SET secret_hash          = EXCLUDED.secret_hash,
              secret_rotated_at    = now(),
              previous_secret_hash = NULL,
              rotation_grace_until = NULL
      `;

      // (d) Activate the device row.
      //
      // THE LABEL is whatever the person pairing typed, falling back to what the
      // admin put in. See the note on `proposed_name` in the request schema: the
      // installer is holding the phone and knows what it is.
      //
      // `allowed_ip_cidrs` IS NO LONGER SEEDED FROM THE PAIRING IP.
      //
      // It used to be: NULL meant "any network", so writing the pairing IP as a
      // /32 tightened the device, and that read as free security. In practice it
      // is a scheduled outage. TT-GATE-01 paired from a mobile connection, got
      // pinned to 49.207.57.255/32, and by the next morning answered
      //
      //     403 KIOSK_DEVICE_NETWORK  "This device is calling from an unapproved network."
      //
      // to every guard sign-in. Migration 073 cleared it — and this line would
      // have silently re-pinned the device the next time anybody paired, which is
      // the worst kind of fix-then-regress. A gate link opened on a phone has no
      // stable address by design.
      //
      // An admin who wants a network fence can still set `allowed_ip_cidrs`
      // deliberately, and `verifyDevice` enforces it exactly as before; it is no
      // longer inferred from one moment in one device's life.
      const updated = await tx`
        UPDATE public.kiosk_devices d
           SET is_active          = true,
               revoked_at         = NULL,
               vault_secret_name  = ${vaultName},
               label              = COALESCE(${body.device.proposed_name ?? null}::text, d.label),
               platform           = COALESCE(${body.device.platform ?? body.device.os ?? null}::text, d.platform),
               app_version        = ${body.device.app_version}::text,
               enrolled_at        = now(),
               last_seen_at       = now(),
               clock_skew_seconds = 0
         WHERE d.id = ${device.kiosk_device_id}::uuid
           AND d.deleted_at IS NULL
        RETURNING d.id, d.device_code, d.label, d.location_id, d.require_operator,
                  d.min_match_confidence, d.max_offline_queue, d.allowed_ip_cidrs,
                  d.enrolled_at
      `;
      const deviceRow = firstRow(updated as unknown as Record<string, unknown>[]);
      if (deviceRow === null) {
        // Soft-deleted between the candidate read and here.
        throw conflict("This device slot is no longer available.", "KIOSK_DEVICE_UNKNOWN");
      }

      const venue = await tx<
        { id: string; code: string; name: string; city: string; timezone: string }[]
      >`
        SELECT l.id, l.code, l.name, l.city, l.timezone
          FROM public.locations l
         WHERE l.id = ${device.location_id}::uuid
         LIMIT 1
      `;

      const settings = await tx`
        SELECT s.key, s.value #>> '{}' AS value
          FROM public.settings s
         WHERE s.key = ANY(${[...CONFIG_KEYS]}::text[])
         ORDER BY (s.scope = 'global') DESC
      `;

      // ── STEP 10 · Audit, in the SAME transaction ─────────────────────────
      // The UPDATE above already produced per-field chain rows via
      // `trg_kiosk_devices__audit`. This adds the one fact no column diff
      // records: WHICH code was redeemed, and that a secret was issued. The
      // secret itself is never an audit value — only that it changed.
      await writeAudit(tx, ctx, {
        action: "config_change",
        entityTable: "public.kiosk_devices",
        entityId: device.kiosk_device_id,
        entityLabel: `${device.device_code} activated`,
        fieldName: "device_secret",
        newValue: {
          activated: true,
          api_key_id: device.id,
          activation_code_name: device.name,
          vault_secret_name: vaultName,
          secret_issued: true,
          app_version: body.device.app_version,
          device_model: body.device.model ?? null,
          egress_ip: ip,
          ignored_fields: ignoredFields,
        },
        isRedacted: true,
      });

      const config = new Map<string, string | null>();
      for (const s of settings as unknown as { key: string; value: string | null }[]) {
        if (!config.has(s.key)) config.set(s.key, s.value);
      }

      return { deviceRow, venue: venue[0] ?? null, settings: config };
    });

    // ── Response assembly (kiosk allowlist, §7.1 / test T-09) ──────────────
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
      offlineQueueMax: Number(result.deviceRow.max_offline_queue ?? num("kiosk.offline_queue_max", 500)),
      minMatchConfidence: Number(result.deviceRow.min_match_confidence ?? num("kiosk.min_confidence", 0.62)),
      minMargin: num("kiosk.min_margin", 0.06),
      debounceSeconds: num("kiosk.debounce_seconds", 120),
      punchPhotoUrlTtlSeconds: num("kiosk.punch_photo_url_ttl_seconds", 60),
      requireLiveness: bool("kiosk.require_liveness", true),
      retainPunchPhotosDays: num("kiosk.retain_punch_photos_days", 180),
      requireOperator: result.deviceRow.require_operator === true,
    };
    const configVersion = (await sha256Hex(JSON.stringify(config))).slice(0, 16);
    const serverTime = nowIso();

    /**
     * Everything the tablet needs to sign a request, single-sourced from
     * `_shared/auth.ts` rather than restated: `deviceCanonicalString` builds the
     * template so the recipe here cannot drift from the verifier.
     */
    const auth = {
      scheme: "hmac-sha256" as const,
      headers: {
        device_id: "x-device-id",
        signature: "x-signature",
        timestamp: "x-timestamp",
        nonce: "x-nonce",
        operator_session: "x-operator-session",
        idempotency_key: "x-idempotency-key",
      },
      /** `HMAC-SHA256(device_secret, "<timestamp>.<nonce>.<raw body>")`, lowercase hex. */
      canonical_string: deviceCanonicalString("{timestamp}", "{nonce}", "{raw_body}"),
      signature_encoding: "hex-lowercase" as const,
      max_clock_skew_seconds: DEVICE_MAX_SKEW_SECONDS,
      nonce_single_use: true,
      nonce_ttl_seconds: 600,
    };

    const responseBody = {
      // The secret, exactly once. Store it in the OS keystore (wrapper) or as a
      // non-extractable WebCrypto key (PWA) before leaving this screen.
      device_secret: deviceSecret,
      device_secret_returned_once: true,

      device_id: result.deviceRow.id as string,
      device_code: result.deviceRow.device_code as string,
      device_name: result.deviceRow.label as string,
      device_status: "active" as const,
      require_operator: config.requireOperator,
      activated_at: toIso(result.deviceRow.enrolled_at as string | Date),
      egress_pinned_to: result.deviceRow.allowed_ip_cidrs ?? null,

      venue: result.venue === null ? null : {
        location_id: result.venue.id,
        code: result.venue.code,
        name: result.venue.name,
        city: result.venue.city,
        timezone: result.venue.timezone,
      },

      auth,
      session: {
        /** Open a guard session here; the token it returns is what `kiosk-punch` requires. */
        endpoint: "kiosk-operator-auth",
        /** spec-kiosk §5.3: short-lived device credential, refreshed silently. */
        token_ttl_seconds: DEVICE_SESSION_TTL_SECONDS,
        refresh_op: "heartbeat" as const,
        header: "x-operator-session",
      },
      endpoints: ["kiosk-punch", "kiosk-operator-auth", "kiosk-heartbeat"] as const,

      config,
      config_version: configVersion,
      server_time: serverTime,
      server_business_date: istDate(serverTime),
      ignored_fields: ignoredFields,
      replayed: false,
      request_id: requestId,
    };
    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ─────────────
    // WITHOUT the secret. See the header note: a replay must not be able to
    // re-issue a credential out of a 24-hour cache.
    await store(idempotencyKey, status, {
      ...responseBody,
      device_secret: null,
      device_secret_returned_once: true,
      secret_already_issued: true,
      detail: "This device was already paired with this code. Re-pair with a new activation code to get a new secret.",
    });

    log.info("device paired", {
      device_id: responseBody.device_id,
      device_code: responseBody.device_code,
      app_version: body.device.app_version,
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

    // A refused pairing is a security event: an unauthenticated caller guessing
    // codes, or an installer at the wrong device. Written on the pool because
    // the business transaction (if there was one) has rolled back — this is the
    // documented use of `writeAuditOnPool`.
    if (status === 401 || status === 403 || status === 409 || status === 410) {
      try {
        await writeAuditOnPool({
          actorId: null,
          actorRole: null,
          source: "kiosk",
          sourceRoute: FN_NAME,
          requestId,
          ip,
          ua: userAgentFrom(req),
          deviceId: auditFailureFor?.deviceId ?? null,
          reason: `kiosk pairing refused: ${problem.code ?? "unknown"} from ${ip ?? "an unknown address"}`,
        }, {
          action: "login_failed",
          entityTable: "public.kiosk_devices",
          entityId: auditFailureFor?.deviceId ?? null,
          entityLabel: auditFailureFor?.deviceCode ?? "unpaired device",
          newValue: { code: problem.code ?? null, status },
          isRedacted: true,
        });
      } catch (auditErr) {
        log.warn("could not record the refused pairing", { err: auditErr });
      }
    }

    if (problem.isServerFault) {
      log.error("unhandled failure", { err, code: problem.code });
    } else {
      log.warn("pairing refused", { code: problem.code, status });
    }
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported for `supabase/tests` and the tablet SDK — one schema, both sides. */
export { ACTIVATION_SCOPE, ActivateBody };

/** Exported so an admin-side function can build the same 6-digit code shape. */
export function activationCodeShape(): { digits: number; ttlMinutes: number; scope: string } {
  return { digits: 6, ttlMinutes: 15, scope: ACTIVATION_SCOPE };
}

/** Kept out of the request path: proves the pool is reachable from a smoke test. */
export async function pingDatabase(): Promise<boolean> {
  const rows = await sql()`SELECT 1 AS ok`;
  return (rows as unknown as { ok: number }[])[0]?.ok === 1;
}
