/**
 * kiosk-provision — the admin-side half of gate provisioning, auth model **U+**
 * (`kiosk.device.manage`, step-up decided by the DB row as everywhere else).
 *
 * Three ops, all of which the deployed pipeline already CONSUMES but nothing
 * yet PRODUCED — the same promised-but-missing pattern as decide_regularization:
 *
 *   issue_activation_code  kiosk-device-activate trades a 6-digit code held as
 *                          an Argon2id hash in `secure.api_keys` (scope
 *                          'kiosk.activate', ≤15 min, single-use). Nothing
 *                          minted such rows, so no tablet could ever pair.
 *   set_operator_pin       kiosk-operator-auth verifies a guard PIN against
 *                          `secure.kiosk_operator_secrets.pin_hash`. Nothing
 *                          wrote those rows, so no guard could ever sign in.
 *   record_consent         face-enrol refuses to enrol without an un-withdrawn
 *                          `secure.biometric_consents` row at the current DPDP
 *                          notice version. Nothing captured consent.
 *
 * Argon2id lives in this runtime (`_shared/argon2.ts`) and deliberately not in
 * Postgres, which is why these are an edge function and not a migration.
 *
 * RETURN-ONCE RULE: the activation code and the PIN appear in their success
 * responses and nowhere else — both are hashed at rest, both are redacted from
 * logs by construction (never logged), and re-issuing revokes the predecessor.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { conflict, methodNotAllowed, notFound, ok, toProblem } from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { nowIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql as sqlHandle,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { requireCapWithStepUp, verifyUser } from "../_shared/auth.ts";
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
import { hashSecret } from "../_shared/argon2.ts";

const FN_NAME = "kiosk-provision";
// An ARRAY, not a string. `handlePreflight` and `methodNotAllowed` both take
// `readonly string[]` and join it; a string made the OPTIONS preflight throw, so
// this function answered 500 to every browser preflight and the browser then
// blocked the POST it was asking permission for. `curl` never preflights, which
// is why every server-side test of this endpoint passed while the console could
// not save anything. Nothing typechecks supabase/functions (tsconfig.app.json
// scopes `include` to `src`), so the wrong shape compiled cleanly.
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;
const CAP_MANAGE = "kiosk.device.manage";

/** Same scope string kiosk-device-activate looks for — the contract. */
const ACTIVATION_SCOPE = "kiosk.activate";
const ACTIVATION_TTL_MINUTES = 15;

/** Mirrors face-enrol: the setting wins, this is only the fallback. */
const DEFAULT_CONSENT_VERSION = "TT-BIO-NOTICE-v1.0";
const CONSENT_MODALITY = "face";
const CONSENT_PURPOSE = "attendance_identification";

const IssueCode = z.object({
  op: z.literal("issue_activation_code"),
  device_id: common.uuid,
  reason: z.string().trim().min(10).max(500),
});
const SetPin = z.object({
  op: z.literal("set_operator_pin"),
  operator_id: common.uuid,
  pin: z.string().regex(/^\d{4,10}$/, "The PIN is 4–10 digits."),
  reason: z.string().trim().min(10).max(500),
});
const RecordConsent = z.object({
  op: z.literal("record_consent"),
  employee_id: common.uuid,
  /** The admin attests the employee read and accepted the current notice. */
  attested: z.literal(true),
  reason: z.string().trim().min(10).max(500),
});
/**
 * add_device — create a gate device AND its pairing code in one action.
 *
 * WHY, IN THE CLIENT'S WORDS
 * -------------------------
 * "In the admin page admin should be able to add new devices… Also, the device name
 *  shouldn't matter; they can put anything for the device name. Only the pairing
 *  code should match, then it should be automatically registered."
 *
 * There was NO way to create a device. `issue_activation_code` needs a
 * `device_id`, and the only row in `kiosk_devices` was seeded by a migration — so
 * the fleet was permanently one tablet and the "Issue pairing code" button could
 * only ever re-pair that one.
 *
 * WHAT IS DELIBERATELY NOT ASKED FOR
 * ---------------------------------
 * `device_code` is NOT an input. It is `NOT NULL` with a unique partial index, so
 * SOMETHING must fill it, and asking the admin to invent a code the guard would
 * then have to type exactly is the friction the client is objecting to. The server
 * generates it, the guard never sees it, and the human-readable `label` is whatever
 * the guard types at the kiosk (see `kiosk-device-activate`).
 *
 * `label` is optional here for the same reason: at issue time nobody knows which
 * phone will be used. It falls back to a placeholder that the guard's own name
 * replaces on activation.
 */
const AddDevice = z.object({
  op: z.literal("add_device"),
  /** Optional placeholder. The guard's name at activation wins over this. */
  label: z.string().trim().min(1).max(120).optional(),
  /**
   * Optional: with a single active location — the case here — the server resolves
   * it rather than making the admin pick from a list of one.
   */
  location_id: common.uuid.optional(),
  reason: z.string().trim().min(10).max(500),
});

const Body = z.discriminatedUnion("op", [IssueCode, SetPin, RecordConsent, AddDevice]);

function sixDigitCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + ((buf[0] ?? 0) % 900000));
}

/**
 * A machine-generated `device_code`.
 *
 * `kiosk_devices.device_code` is NOT NULL with `uq_kiosk_devices__device_code`
 * (partial, WHERE deleted_at IS NULL). Nobody should have to think of one: it is an
 * internal handle, not a name. The guard never types it — pairing works from the
 * activation code alone — and the label carries the meaning.
 *
 * Crockford-ish alphabet with I/O/0/1 removed so a code read off a screen is never
 * ambiguous, in case it ever does have to be read aloud during support.
 */
function generatedDeviceCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `GATE-${suffix}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;

  try {
    assertOriginAllowed(req);
    const client = sqlHandle();

    const auth = await verifyUser(req);
    await requireCapWithStepUp(client, auth, CAP_MANAGE);
    await enforce(RATE_LIMITS.mutation, limitKey(FN_NAME, auth.userId), "RATE_LIMITED", client);

    const { data: body, raw } = await parseBody(req, Body, { maxBytes: 8 * 1024 });

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

    // ── issue_activation_code ────────────────────────────────────────────────
    if (body.op === "issue_activation_code") {
      const code = sixDigitCode();
      const codeHash = await hashSecret(code);

      const result = await withContext(ctx, async (tx) => {
        const device = firstRow(
          await tx<{ id: string; device_code: string; label: string }[]>`
            SELECT id, device_code, label
              FROM public.kiosk_devices
             WHERE id = ${body.device_id}::uuid AND deleted_at IS NULL
             LIMIT 1
          `,
        );
        if (device === null) throw notFound("No such kiosk device.", "KIOSK_DEVICE_UNKNOWN");

        // One live code per device: issuing again revokes the predecessor, so a
        // mislaid sticky note stops mattering the moment a new code exists.
        await tx`
          UPDATE secure.api_keys
             SET revoked_at = now()
           WHERE kiosk_device_id = ${device.id}::uuid
             AND ${ACTIVATION_SCOPE} = ANY (scopes)
             AND revoked_at IS NULL
        `;
        const inserted = firstRow(
          await tx<{ id: string; expires_at: string }[]>`
            INSERT INTO secure.api_keys
              (name, key_prefix, key_hash, scopes, kiosk_device_id,
               rate_limit_per_min, expires_at, created_by)
            VALUES
              (${`kiosk activation: ${device.device_code}`},
               ${
                 // uq_api_keys__key_prefix is total, not partial: revoked codes
                 // keep their prefix, so each issue needs a distinct one.
                 "act_" + device.device_code + "_" + crypto.randomUUID().slice(0, 8)},
               ${codeHash},
               ${[ACTIVATION_SCOPE]}::text[],
               ${device.id}::uuid,
               6,
               now() + make_interval(mins => ${ACTIVATION_TTL_MINUTES}),
               ${auth.userId}::uuid)
            RETURNING id, expires_at
          `,
        );
        if (inserted === null) throw conflict("Could not store the activation code.", "PROVISION_FAILED");

        await writeAudit(tx, ctx, {
          action: "insert",
          entityTable: "secure.api_keys",
          entityId: inserted.id,
          entityLabel: `kiosk activation code for ${device.device_code}`,
          newValue: {
            op: body.op,
            device_id: device.id,
            device_code: device.device_code,
            expires_at: inserted.expires_at,
          },
          isRedacted: true,
          reason: body.reason,
        });
        return { device, expiresAt: inserted.expires_at };
      });

      status = 201;
      const responseBody = {
        op: body.op,
        deviceCode: result.device.device_code,
        label: result.device.label,
        // Shown ONCE. At rest it exists only as an Argon2id hash.
        activationCode: code,
        expiresAt: result.expiresAt,
        ttlMinutes: ACTIVATION_TTL_MINUTES,
        requestId,
      };
      await store(idempotencyKey, status, responseBody, client);
      log.info("activation code issued", { device_id: result.device.id });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    // ── add_device ───────────────────────────────────────────────────────────
    if (body.op === "add_device") {
      const code = sixDigitCode();
      const codeHash = await hashSecret(code);
      const deviceCode = generatedDeviceCode();

      const result = await withContext(ctx, async (tx) => {
        // Resolve the location. `kiosk_devices.location_id` is NOT NULL REFERENCES
        // public.locations, so this cannot be skipped — but with one active
        // location there is nothing to ask.
        let locationId = body.location_id ?? null;
        if (locationId === null) {
          const locations = await tx<{ id: string }[]>`
            SELECT id FROM public.locations WHERE deleted_at IS NULL ORDER BY code LIMIT 2
          `;
          if (locations.length === 0) {
            throw notFound(
              "No location exists to attach a gate device to. Add one under Admin → Org → Locations first.",
              "LOCATION_REQUIRED",
            );
          }
          if (locations.length > 1) {
            // Ambiguous: picking one silently would attach the gate to the wrong
            // site, and every geofence verdict from it would then be wrong.
            throw conflict(
              "More than one location exists — say which one this gate belongs to.",
              "LOCATION_AMBIGUOUS",
            );
          }
          locationId = locations[0]?.id ?? null;
        } else {
          const found = firstRow(
            await tx<{ id: string }[]>`
              SELECT id FROM public.locations
               WHERE id = ${locationId}::uuid AND deleted_at IS NULL LIMIT 1
            `,
          );
          if (found === null) throw notFound("No such location.", "LOCATION_UNKNOWN");
        }
        if (locationId === null) throw notFound("No such location.", "LOCATION_UNKNOWN");

        const device = firstRow(
          await tx<{ id: string; device_code: string; label: string }[]>`
            INSERT INTO public.kiosk_devices (device_code, label, location_id, device_kind)
            VALUES (${deviceCode},
                    ${body.label ?? "Unnamed gate device"},
                    ${locationId}::uuid,
                    'mobile_pwa')
            RETURNING id, device_code, label
          `,
        );
        if (device === null) throw conflict("Could not create the device.", "PROVISION_FAILED");

        // Same insert as `issue_activation_code`, and it must STAY the same: the
        // scope string is the contract `kiosk-device-activate` looks for, and the
        // key_prefix has to be unique because uq_api_keys__key_prefix is total.
        const inserted = firstRow(
          await tx<{ id: string; expires_at: string }[]>`
            INSERT INTO secure.api_keys
              (name, key_prefix, key_hash, scopes, kiosk_device_id,
               rate_limit_per_min, expires_at, created_by)
            VALUES
              (${`kiosk activation: ${device.device_code}`},
               ${"act_" + device.device_code + "_" + crypto.randomUUID().slice(0, 8)},
               ${codeHash},
               ${[ACTIVATION_SCOPE]}::text[],
               ${device.id}::uuid,
               6,
               now() + make_interval(mins => ${ACTIVATION_TTL_MINUTES}),
               ${auth.userId}::uuid)
            RETURNING id, expires_at
          `,
        );
        if (inserted === null) throw conflict("Could not store the activation code.", "PROVISION_FAILED");

        await writeAudit(tx, ctx, {
          action: "insert",
          entityTable: "public.kiosk_devices",
          entityId: device.id,
          entityLabel: `${device.device_code} created`,
          newValue: {
            op: body.op,
            device_code: device.device_code,
            label: device.label,
            location_id: locationId,
            device_kind: "mobile_pwa",
          },
          reason: body.reason,
        });
        // The code itself is never audited — only that one was issued.
        await writeAudit(tx, ctx, {
          action: "insert",
          entityTable: "secure.api_keys",
          entityId: inserted.id,
          entityLabel: `kiosk activation code for ${device.device_code}`,
          newValue: {
            op: body.op,
            device_id: device.id,
            device_code: device.device_code,
            expires_at: inserted.expires_at,
          },
          isRedacted: true,
          reason: body.reason,
        });

        return { device, expiresAt: inserted.expires_at };
      });

      status = 201;
      const responseBody = {
        op: body.op,
        deviceId: result.device.id,
        deviceCode: result.device.device_code,
        label: result.device.label,
        // Shown ONCE. At rest it exists only as an Argon2id hash.
        activationCode: code,
        expiresAt: result.expiresAt,
        ttlMinutes: ACTIVATION_TTL_MINUTES,
        requestId,
      };
      await store(idempotencyKey, status, responseBody, client);
      log.info("device created and activation code issued", { device_id: result.device.id });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    // ── set_operator_pin ─────────────────────────────────────────────────────
    if (body.op === "set_operator_pin") {
      const pinHash = await hashSecret(body.pin);

      const operator = await withContext(ctx, async (tx) => {
        const row = firstRow(
          await tx<{ id: string; employee_id: string; display_name: string | null }[]>`
            SELECT o.id, o.employee_id, e.display_name
              FROM public.kiosk_operators o
              JOIN public.employees e ON e.id = o.employee_id
             WHERE o.id = ${body.operator_id}::uuid
             LIMIT 1
          `,
        );
        if (row === null) throw notFound("No such kiosk operator.", "KIOSK_OPERATOR_UNKNOWN");

        await tx`
          INSERT INTO secure.kiosk_operator_secrets
            (operator_id, pin_hash, pin_rotated_at, failed_attempts, locked_until)
          VALUES (${row.id}::uuid, ${pinHash}, now(), 0, NULL)
          ON CONFLICT (operator_id) DO UPDATE
            SET previous_pin_hash = secure.kiosk_operator_secrets.pin_hash,
                pin_hash = EXCLUDED.pin_hash,
                pin_rotated_at = now(),
                rotation_grace_until = now() + interval '10 minutes',
                failed_attempts = 0,
                locked_until = NULL
        `;

        await writeAudit(tx, ctx, {
          action: "update",
          entityTable: "secure.kiosk_operator_secrets",
          entityId: row.id,
          entityLabel: "guard PIN set",
          subjectEmployeeId: row.employee_id,
          newValue: { op: body.op, operator_id: row.id },
          isRedacted: true,
          reason: body.reason,
        });
        return row;
      });

      status = 200;
      const responseBody = {
        op: body.op,
        operatorId: operator.id,
        operatorName: operator.display_name,
        rotationGraceMinutes: 10,
        requestId,
      };
      await store(idempotencyKey, status, responseBody, client);
      log.info("operator pin set", { operator_id: operator.id });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    // ── record_consent ───────────────────────────────────────────────────────
    const result = await withContext(ctx, async (tx) => {
      const employee = firstRow(
        await tx<{ id: string; display_name: string; in_scope: boolean }[]>`
          SELECT e.id, e.display_name, app.admin_scope_covers(e.id) AS in_scope
            FROM public.employees e
           WHERE e.id = ${body.employee_id}::uuid AND e.deleted_at IS NULL
           LIMIT 1
        `,
      );
      if (employee === null) throw notFound("No such employee.", "EMPLOYEE_UNKNOWN");
      if (!employee.in_scope) {
        throw conflict("This employee is outside your admin scope.", "EMPLOYEE_OUT_OF_SCOPE");
      }

      const cfg = firstRow(
        await tx<{ consent_version: string | null }[]>`
          SELECT app.setting('biometric.consent_version') AS consent_version
        `,
      );
      const version = cfg?.consent_version ?? DEFAULT_CONSENT_VERSION;
      // The hash binds the consent row to WHAT was accepted — version + purpose
      // + modality — so a later notice edit cannot silently re-scope old rows.
      const textHash = await sha256Hex(`${version}:${CONSENT_PURPOSE}:${CONSENT_MODALITY}`);

      const existing = firstRow(
        await tx<{ id: string }[]>`
          SELECT id FROM secure.biometric_consents
           WHERE employee_id = ${employee.id}::uuid
             AND granted AND withdrawn_at IS NULL
             AND modality IN ('face','both')
             AND purpose = ${CONSENT_PURPOSE}
             AND consent_version = ${version}
           LIMIT 1
        `,
      );
      if (existing !== null) {
        return { employee, version, consentId: existing.id, alreadyOnFile: true };
      }

      // uq_biometric_consents__active: one live consent per employee. Consent
      // at a NEWER notice version SUPERSEDES the old one — the old row is
      // withdrawn (with the reason on it), never deleted; the register keeps
      // the full history, which is the DPDP point.
      await tx`
        UPDATE secure.biometric_consents
           SET withdrawn_at = now(),
               withdrawal_reason = ${'superseded by consent at notice version ' + version}
         WHERE employee_id = ${employee.id}::uuid
           AND granted AND withdrawn_at IS NULL
      `;

      const inserted = firstRow(
        await tx<{ id: string }[]>`
          INSERT INTO secure.biometric_consents
            (employee_id, modality, consent_version, consent_text_hash, purpose,
             granted, granted_at, granted_via, witnessed_by, ip)
          VALUES
            (${employee.id}::uuid, ${CONSENT_MODALITY}, ${version}, ${textHash},
             ${CONSENT_PURPOSE}, true, ${nowIso()}::timestamptz, 'paper_form',
             ${auth.userId}::uuid, ${clientIpFrom(req)}::inet)
          RETURNING id
        `,
      );
      if (inserted === null) throw conflict("Could not record consent.", "PROVISION_FAILED");

      await writeAudit(tx, ctx, {
        action: "insert",
        entityTable: "secure.biometric_consents",
        entityId: inserted.id,
        entityLabel: "biometric consent captured",
        subjectEmployeeId: employee.id,
        newValue: { op: body.op, consent_version: version, witnessed_by: auth.userId },
        isRedacted: true,
        reason: body.reason,
      });
      return { employee, version, consentId: inserted.id, alreadyOnFile: false };
    });

    status = result.alreadyOnFile ? 200 : 201;
    const responseBody = {
      op: body.op,
      employeeId: result.employee.id,
      consentId: result.consentId,
      consentVersion: result.version,
      alreadyOnFile: result.alreadyOnFile,
      requestId,
    };
    await store(idempotencyKey, status, responseBody, client);
    log.info("consent recorded", {
      employee_id: result.employee.id,
      already_on_file: result.alreadyOnFile,
    });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, problem.problem, sqlHandle());
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }

    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});
