/**
 * webauthn-register — catalogue #19, auth model **U** (user JWT).
 *
 * Two ops, one endpoint, one round-trip each:
 *
 *   action=options  → `generateRegistrationOptions()` for the signed-in user,
 *                     challenge persisted server-side
 *   action=verify   → `verifyRegistrationResponse()` against that challenge,
 *                     then one row in `public.webauthn_credentials`
 *
 * THE RULE THIS FUNCTION EXISTS TO ENFORCE (spec-architecture §6, PRD §10.3
 * "⚠︎ FIX"): the reference repo shipped a client-trusted WebAuthn path where the
 * attestation was never sent to a server and the browser decided whether the
 * ceremony succeeded. We never do that anywhere. The challenge is issued here,
 * stored in `secure.webauthn_challenges` (a schema PostgREST cannot see,
 * boundary B6), consumed exactly once, and the attestation is verified here.
 * The client's opinion of the outcome is not an input.
 *
 * Challenge lifecycle, all four properties enforced in SQL, not in TypeScript:
 *   - single-use   `UPDATE … SET consumed_at = now() WHERE consumed_at IS NULL`
 *                  with the null-check in the OUTER predicate, so two concurrent
 *                  verifies cannot both win the row;
 *   - short-lived  3 minutes (the table's own default), and the ceremony
 *                  `timeout` below is set to the same number so the browser and
 *                  the database agree about when it is too late;
 *   - one live at a time  issuing options voids any earlier live `register`
 *                  challenge for the same profile — a stockpile of valid
 *                  challenges is a replay window;
 *   - bound to the profile  `lookup = profiles.id`, per migration 012's comment.
 *
 * rpID: `hr.thetamarindtree.in` in production, `localhost` for Vite dev.
 * `kiosk.thetamarindtree.in` is deliberately ABSENT — a credential scoped to
 * `hr.thetamarindtree.in` cannot be asserted from the kiosk host anyway (the RP
 * ID must equal or be a registrable suffix of the origin's domain), and the
 * kiosk's own passkey-attendance path (spec-kiosk K7) needs a decision about
 * whether to scope credentials to the apex domain. That is not this function's
 * decision to make silently.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  conflict,
  forbidden,
  gone,
  methodNotAllowed,
  ok,
  toProblem,
  unprocessable,
} from "../_shared/errors.ts";
import { parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { toIso } from "../_shared/datetime.ts";
import { loadWebAuthn } from "../_shared/deps.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql as sqlHandle,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { hasCapDb, sha256Hex, verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { claim, idempotencyKeyFrom, release, replayResponse, requestHash, store } from "../_shared/idempotency.ts";
import { auditSession } from "../_shared/audit.ts";

const FN_NAME = "webauthn-register";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

const RP_NAME = "Tamarind Tree HRMS";

/**
 * Origin → rpID. The map, not the request, decides the RP ID: an attacker-chosen
 * `rpId` in the body would let a phishing origin mint credentials for ours.
 *
 * Duplicated verbatim in `webauthn-login/index.ts`. Two copies rather than a new
 * `_shared` module because the `_shared` inventory is fixed by
 * spec-architecture §4; if a third WebAuthn surface appears (kiosk K7), promote
 * this and the base64url helpers to `_shared/webauthn.ts` and delete both copies.
 */
const RP_BY_ORIGIN: Readonly<Record<string, string>> = {
  "https://hr.thetamarindtree.in": "hr.thetamarindtree.in",
  "http://localhost:5173": "localhost",
};

/** Browser ceremony timeout = the challenge TTL in migration 012 (3 minutes). */
const CEREMONY_TIMEOUT_MS = 180_000;

/** Capability, if the data model grows one. See the note at step 5. */
const CAP_REGISTER = "auth.passkey.register";

interface RelyingParty {
  rpId: string;
  origin: string;
}

function resolveRelyingParty(req: Request): RelyingParty {
  const origin = req.headers.get("origin");
  const rpId = origin === null ? undefined : RP_BY_ORIGIN[origin];
  if (origin === null || rpId === undefined) {
    // 403 and not 422: the host is the problem, and no body will fix it.
    throw forbidden(
      "Passkeys can only be set up from the HRMS web app.",
      "WEBAUTHN_ORIGIN_NOT_ALLOWED",
    );
  }
  return { rpId, origin };
}

// ── base64url ───────────────────────────────────────────────────────────────
// `public_key` is a `text` column and the COSE key is bytes, so one of the two
// has to convert. Done here rather than with the library's `isoBase64URL`
// helper, which lives behind a subpath export (`@simplewebauthn/server/helpers`)
// that `_shared/deps.ts` does not pin — and deps.ts is the only file allowed to
// name a remote specifier.

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── @simplewebauthn/server, shape-tolerantly ────────────────────────────────
// `deps.ts` pins 11.0.0. Between v10 and v12 the library moved
// `registrationInfo.{credentialID,credentialPublicKey,counter}` into a nested
// `registrationInfo.credential.{id,publicKey,counter}`, and `credentialID`
// changed from `Uint8Array` to a base64url string. The calls below are typed
// loosely and the results normalised, so a pin bump cannot silently store a
// `[object Object]` public key. This is the one place in the function where
// `unknown` is the right type.

type OptionsJson = Record<string, unknown> & { challenge: string };

interface RegistrationVerification {
  verified: boolean;
  registrationInfo?: Record<string, unknown> | undefined;
}

interface NormalisedCredential {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[] | null;
  aaguid: string | null;
  backupEligible: boolean;
  deviceType: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A credential id as base64url, whatever the library handed us. */
function asBase64Url(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (value instanceof Uint8Array) return bytesToBase64Url(value);
  if (value instanceof ArrayBuffer) return bytesToBase64Url(new Uint8Array(value));
  return null;
}

function normaliseRegistration(info: Record<string, unknown>): NormalisedCredential | null {
  const nested = asRecord(info.credential);
  const idRaw = nested === null ? info.credentialID : nested.id;
  const keyRaw = nested === null ? info.credentialPublicKey : nested.publicKey;
  const counterRaw = nested === null ? info.counter : nested.counter;
  const transportsRaw = nested === null ? undefined : nested.transports;

  const credentialId = asBase64Url(idRaw);
  const publicKey = keyRaw instanceof Uint8Array
    ? bytesToBase64Url(keyRaw)
    : keyRaw instanceof ArrayBuffer
    ? bytesToBase64Url(new Uint8Array(keyRaw))
    : typeof keyRaw === "string" && keyRaw !== ""
    ? keyRaw
    : null;
  if (credentialId === null || publicKey === null) return null;

  const transports = Array.isArray(transportsRaw)
    ? transportsRaw.filter((t): t is string => typeof t === "string")
    : null;

  return {
    credentialId,
    publicKey,
    signCount: typeof counterRaw === "number" && Number.isFinite(counterRaw)
      ? Math.max(0, Math.trunc(counterRaw))
      : 0,
    transports: transports !== null && transports.length > 0 ? transports : null,
    aaguid: typeof info.aaguid === "string" && info.aaguid !== "" ? info.aaguid : null,
    backupEligible: info.credentialBackedUp === true,
    deviceType: typeof info.credentialDeviceType === "string" ? info.credentialDeviceType : null,
  };
}

// ── Request schemas ─────────────────────────────────────────────────────────

const PURPOSES = ["login", "attendance", "both"] as const;

const OptionsRequest = z
  .object({
    action: z.literal("options"),
    /** Shown on the "your passkeys" list. The user's words, capped. */
    deviceLabel: z.string().trim().min(1).max(80).optional(),
    purpose: z.enum(PURPOSES).default("login"),
    /**
     * `platform` = this phone/laptop's fingerprint sensor (the default we want);
     * `cross-platform` = a roaming security key.
     */
    authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  })
  .strict();

/**
 * `.passthrough()` on the browser's credential: `@simplewebauthn/server` is the
 * authority on this structure and validates it far more thoroughly than a zod
 * shape could. What zod is for here is bounding the SIZE and the type of the
 * fields we ourselves touch, so a 4 MB `attestationObject` never reaches the
 * verifier.
 */
const AttestationResponse = z
  .object({
    clientDataJSON: z.string().min(1).max(8_192),
    attestationObject: z.string().min(1).max(32_768),
    transports: z.array(z.string().max(32)).max(8).optional(),
  })
  .passthrough();

const VerifyRequest = z
  .object({
    action: z.literal("verify"),
    credential: z
      .object({
        id: z.string().min(1).max(1_000),
        rawId: z.string().min(1).max(1_000).optional(),
        type: z.literal("public-key").optional(),
        response: AttestationResponse,
        clientExtensionResults: z.record(z.unknown()).optional(),
        authenticatorAttachment: z.string().max(32).nullish(),
      })
      .passthrough(),
    deviceLabel: z.string().trim().min(1).max(80).optional(),
    purpose: z.enum(PURPOSES).default("login"),
  })
  .strict();

const RegisterBody = z.discriminatedUnion("action", [OptionsRequest, VerifyRequest]);

/** Max live passkeys per profile — a bounded list the user can still reason about. */
const MAX_CREDENTIALS_PER_PROFILE = 10;

interface ExistingCredentialRow {
  credential_id: string;
  transports: string[] | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ─────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ───────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ──────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;

  try {
    assertOriginAllowed(req);
    const client = sqlHandle();
    const rp = resolveRelyingParty(req);

    // ── STEP 4 · Auth (model U) ───────────────────────────────────────────────
    // A passkey is a credential for an account that must already exist and
    // already be signed in. `verifyUser` also refuses a deactivated profile, so a
    // departed employee's unexpired JWT cannot add a new way in.
    const auth = await verifyUser(req);

    // ── STEP 5 · Authority, from the DATABASE ─────────────────────────────────
    // Registering YOUR OWN passkey is self-service: the catalogue calls this
    // endpoint plain U (no capability column), and migration 050 seeds no
    // `auth.passkey.*` row — so `requireCapDb` would deny every employee and
    // lock the whole workforce out of the feature.
    //
    // Data-driven, in both directions: if a future migration grants
    // `auth.passkey.register` to any role, the check below starts enforcing on
    // the next request with no redeploy. Until then, authority is the verified
    // session plus the fact that the credential is written against
    // `auth.userId` — never against a profile id from the body. There is no
    // "register a passkey for someone else" path here at all.
    const capSeeded = firstRow(
      await client<{ seeded: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM public.role_capabilities rc
           WHERE rc.capability = ${CAP_REGISTER}
              OR rc.capability LIKE ${`${CAP_REGISTER}.%`}
        ) AS seeded
      ` as unknown as { seeded: boolean }[],
    )?.seeded === true;
    if (capSeeded && !(await hasCapDb(client, auth, CAP_REGISTER))) {
      throw forbidden(
        `You do not have permission for this action (${CAP_REGISTER}).`,
        "CAP_REQUIRED",
      );
    }

    // ── STEP 6 · Rate limit ───────────────────────────────────────────────────
    await enforce(RATE_LIMITS.webauthn, limitKey(FN_NAME, auth.userId), "RATE_LIMITED", client);

    // ── STEP 7 · Validate ─────────────────────────────────────────────────────
    const { data: body, raw } = await parseBody(req, RegisterBody, { maxBytes: 64 * 1024 });

    const webauthn = await loadWebAuthn();

    // ═════════════════════════════════════════════════════════════════════════
    // action = options
    // ═════════════════════════════════════════════════════════════════════════
    if (body.action === "options") {
      // ── STEP 8 · Idempotency ────────────────────────────────────────────────
      // None, deliberately: every call MUST return a fresh challenge. Replaying a
      // stored one would hand the caller a second use of a nonce whose whole job
      // is to be used once.

      const existing = await client<ExistingCredentialRow[]>`
        SELECT w.credential_id, w.transports
          FROM public.webauthn_credentials w
         WHERE w.profile_id = ${auth.userId}::uuid
           AND w.revoked_at IS NULL
         ORDER BY w.created_at
      ` as unknown as ExistingCredentialRow[];

      if (existing.length >= MAX_CREDENTIALS_PER_PROFILE) {
        throw conflict(
          `You already have ${MAX_CREDENTIALS_PER_PROFILE} passkeys. Remove one before adding another.`,
          "WEBAUTHN_TOO_MANY_CREDENTIALS",
        );
      }

      const generate = webauthn.generateRegistrationOptions as unknown as (
        opts: Record<string, unknown>,
      ) => Promise<OptionsJson>;

      const options = await generate({
        rpName: RP_NAME,
        rpID: rp.rpId,
        // v10+ wants bytes. The profile uuid is the user handle: stable, already
        // known to the client, and not a secret.
        userID: new TextEncoder().encode(auth.userId),
        userName: auth.email,
        userDisplayName: auth.displayName ?? auth.fullName ?? auth.email,
        timeout: CEREMONY_TIMEOUT_MS,
        // `none`: we do not run an MDS metadata service, so an attestation
        // statement we cannot check is a liability rather than evidence.
        attestationType: "none",
        // Stops the user registering the same authenticator twice and then
        // wondering why one of the two entries never works.
        excludeCredentials: existing.map((row) => ({
          id: row.credential_id,
          ...(row.transports === null ? {} : { transports: row.transports }),
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          requireResidentKey: false,
          // The point of the feature is "fingerprint or face on this device".
          userVerification: "required",
          ...(body.authenticatorAttachment === undefined
            ? {}
            : { authenticatorAttachment: body.authenticatorAttachment }),
        },
        // ES256 then RS256. Nothing exotic — every platform authenticator in the
        // venue supports one of these.
        supportedAlgorithmIDs: [-7, -257],
      });

      // ── STEPS 9 + 10 · set_context + ONE transaction ────────────────────────
      // `secure.webauthn_challenges` is unreachable over PostgREST (boundary B6),
      // so this goes through the direct connection. No explicit audit row: an
      // options request grants nothing. The credential INSERT is what matters and
      // `trg_webauthn_credentials__audit` records it on the verify leg.
      const ctx: RequestContext = {
        actorId: auth.userId,
        actorRole: auth.role,
        source: "web_employee",
        sourceRoute: FN_NAME,
        requestId,
        ip: clientIpFrom(req),
        ua: userAgentFrom(req),
      };

      const challengeRow = await withContext(ctx, async (tx) => {
        // One live challenge per profile. An unfinished ceremony is voided rather
        // than left lying around next to the new one.
        await tx`
          UPDATE secure.webauthn_challenges c
             SET consumed_at = now()
           WHERE c.lookup = ${auth.userId}
             AND c.purpose = 'register'
             AND c.consumed_at IS NULL
        `;
        const inserted = await tx<{ id: string; expires_at: Date }[]>`
          INSERT INTO secure.webauthn_challenges (lookup, challenge, purpose, expires_at)
          VALUES (
            ${auth.userId},
            ${options.challenge},
            'register',
            now() + make_interval(secs => ${CEREMONY_TIMEOUT_MS / 1000}::double precision)
          )
          RETURNING id, expires_at
        `;
        return firstRow(inserted as unknown as { id: string; expires_at: Date }[]);
      });

      if (challengeRow === null) {
        // The INSERT returned nothing, which can only be a driver-level fault.
        throw new Error("challenge insert returned no row");
      }

      status = 200;
      log.info("registration options issued", {
        challenge_id: challengeRow.id,
        rp_id: rp.rpId,
        existing_credentials: existing.length,
      });
      return ok(
        {
          action: "options" as const,
          rpId: rp.rpId,
          /** Pass straight to `@simplewebauthn/browser` `startRegistration`. */
          options,
          expiresAt: toIso(challengeRow.expires_at),
          requestId,
        },
        { status, headers: cors, requestId },
      );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // action = verify
    // ═════════════════════════════════════════════════════════════════════════

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // A mutation, so it claims a key (§4 lifecycle step 8). The client is not
    // required to send one — the credential id is a perfectly good natural key,
    // and a double-submitted registration is exactly the case where the two
    // requests carry the SAME credential id. The `uq_webauthn_credentials__
    // credential_id` unique index is the hard backstop underneath it.
    const credentialIdHash = (await sha256Hex(body.credential.id)).slice(0, 40);
    idempotencyKey = idempotencyKeyFrom(req) ?? `${FN_NAME}:${auth.userId}:${credentialIdHash}`;
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

    // ── STEPS 9 + 10 · set_context + ONE transaction ────────────────────────
    const ctx: RequestContext = {
      actorId: auth.userId,
      actorRole: auth.role,
      source: "web_employee",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      reason: "passkey registered by the account holder",
    };

    // The challenge is consumed FIRST and in its own transaction, before any
    // verification work: whatever happens next, this challenge is spent. Doing it
    // after the crypto would leave a live challenge behind on every failed
    // attempt, which is a retry oracle.
    const challenge = await withContext(ctx, async (tx) => {
      const consumed = await tx<{ challenge: string }[]>`
        UPDATE secure.webauthn_challenges c
           SET consumed_at = now()
         WHERE c.id = (
                 SELECT c2.id
                   FROM secure.webauthn_challenges c2
                  WHERE c2.lookup = ${auth.userId}
                    AND c2.purpose = 'register'
                    AND c2.consumed_at IS NULL
                    AND c2.expires_at > now()
                  ORDER BY c2.recorded_at DESC
                  LIMIT 1
               )
           -- Repeated in the OUTER predicate on purpose: it is what makes the
           -- row single-use under concurrency. Postgres re-evaluates this
           -- WHERE after waiting on a row another transaction just updated, so
           -- the second verify finds consumed_at set and updates nothing.
           AND c.consumed_at IS NULL
        RETURNING c.challenge
      `;
      return firstRow(consumed as unknown as { challenge: string }[])?.challenge ?? null;
    });

    if (challenge === null) {
      // Expired, already used, or never issued. 410 rather than 401: the client's
      // recovery is to start the ceremony again, not to re-authenticate.
      throw gone(
        "This passkey setup attempt has expired. Start again.",
        "WEBAUTHN_CHALLENGE_INVALID",
      );
    }

    const verifyRegistration = webauthn.verifyRegistrationResponse as unknown as (
      opts: Record<string, unknown>,
    ) => Promise<RegistrationVerification>;

    let verification: RegistrationVerification;
    try {
      verification = await verifyRegistration({
        response: body.credential,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        // Matches `userVerification: "required"` in the options. A ceremony that
        // did not actually check a fingerprint is not the credential we asked for.
        requireUserVerification: true,
      });
    } catch (err) {
      // The library throws on a malformed or mismatched attestation. That is a
      // 422 about the submitted credential, not a 500 about us.
      log.warn("attestation rejected", { err });
      throw unprocessable(
        [{ pointer: "/credential", code: "invalid", detail: "The attestation could not be verified." }],
        "This device's passkey could not be verified.",
        "WEBAUTHN_VERIFICATION_FAILED",
      );
    }

    const info = verification.registrationInfo === undefined
      ? null
      : asRecord(verification.registrationInfo);
    if (verification.verified !== true || info === null) {
      throw unprocessable(
        [{ pointer: "/credential", code: "invalid", detail: "The attestation could not be verified." }],
        "This device's passkey could not be verified.",
        "WEBAUTHN_VERIFICATION_FAILED",
      );
    }

    const normalised = normaliseRegistration(info);
    if (normalised === null) {
      // A pinned-version shape change (see the note above the normaliser). Fail
      // loudly as a 500 rather than writing a broken credential row that would
      // then never verify at login.
      log.error("registration info shape not recognised", { keys: Object.keys(info) });
      throw new Error("unrecognised registrationInfo shape from @simplewebauthn/server");
    }

    // The credential id the authenticator signed must be the one the client said
    // it was using. A mismatch means the body was assembled by hand.
    if (normalised.credentialId !== body.credential.id) {
      throw unprocessable(
        [{ pointer: "/credential/id", code: "mismatch", detail: "Credential id does not match the attestation." }],
        "This device's passkey could not be verified.",
        "WEBAUTHN_VERIFICATION_FAILED",
      );
    }

    // The authenticator's own answer wins; the browser's `transports` hint is the
    // fallback. Widened to `unknown[]` before filtering so this narrows the same
    // way whether zod typed the field or passed it through.
    const rawTransports: unknown = body.credential.response.transports;
    const hintedTransports: string[] = Array.isArray(rawTransports)
      ? (rawTransports as unknown[]).filter((t): t is string => typeof t === "string" && t.length <= 32)
      : [];
    const transports = normalised.transports ??
      (hintedTransports.length > 0 ? hintedTransports : null);

    const stored = await withContext(ctx, async (tx) => {
      const inserted = await tx<{ id: string; created_at: Date }[]>`
        INSERT INTO public.webauthn_credentials
          (profile_id, credential_id, public_key, sign_count, transports, aaguid,
           device_label, purpose, backup_eligible, created_by)
        VALUES (
          ${auth.userId}::uuid,
          ${normalised.credentialId},
          ${normalised.publicKey},
          ${normalised.signCount}::bigint,
          ${transports === null || transports.length === 0 ? null : transports}::text[],
          ${normalised.aaguid}::text,
          ${body.deviceLabel ?? null}::text,
          ${body.purpose}::text,
          ${normalised.backupEligible}::boolean,
          ${auth.userId}::uuid
        )
        ON CONFLICT (credential_id) DO NOTHING
        RETURNING id, created_at
      `;
      const row = firstRow(inserted as unknown as { id: string; created_at: Date }[]);
      if (row === null) {
        // The unique index refused it: this authenticator is already registered,
        // to this profile or to another one. Either way the caller is told the
        // same thing and learns nothing about other accounts.
        throw conflict(
          "This device already has a passkey for Tamarind Tree HRMS.",
          "WEBAUTHN_CREDENTIAL_EXISTS",
        );
      }

      // `trg_webauthn_credentials__audit` (migration 038) already emitted the
      // hash-chained INSERT row for the credential itself, so there is no
      // `writeAudit` here — double-logging one event is how an audit trail stops
      // being trustworthy. What the trigger cannot see is the SESSION event, and
      // `public.sessions_audit` is where the security console reads "a passkey
      // was added to your account" from.
      await auditSession(tx, ctx, {
        event: "passkey_registered",
        profileId: auth.userId,
        attemptedEmail: auth.email,
        authMethod: "passkey",
      });

      return row;
    });

    const responseBody = {
      action: "verify" as const,
      verified: true,
      credential: {
        id: stored.id,
        // Echoed so the client can match this against the browser's credential.
        credentialId: normalised.credentialId,
        deviceLabel: body.deviceLabel ?? null,
        purpose: body.purpose,
        transports,
        backupEligible: normalised.backupEligible,
        deviceType: normalised.deviceType,
        createdAt: toIso(stored.created_at),
      },
      requestId,
    };
    status = 201;

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    // Safe to persist: the body carries no secret. The COSE public key is not in
    // it, and a public key would not be a secret anyway — but there is no reason
    // to ship it to a browser that cannot use it.
    await store(idempotencyKey, status, responseBody, client);

    log.info("passkey registered", { credential_row: stored.id, purpose: body.purpose });
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
    // ── STEP 12 · One structured log line per invocation ─────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported for `supabase/tests` — the same schemas and helpers the handler uses. */
export { normaliseRegistration, RegisterBody, resolveRelyingParty, RP_BY_ORIGIN };
