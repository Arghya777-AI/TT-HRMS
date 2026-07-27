/**
 * webauthn-login — catalogue #20, auth model **none (pre-auth)**.
 *
 * Step 2 of the three-step sign-in (PRD §10.3): the employee has already been
 * resolved by `auth-identify`, which told the client `hasPasskey: true`. Two ops:
 *
 *   action=options  identifier → `generateAuthenticationOptions()` + a stored
 *                   single-use challenge
 *   action=verify   assertion → `verifyAuthenticationResponse()`, sign-count
 *                   monotonicity, then a one-time `token_hash` the browser
 *                   redeems with `supabase.auth.verifyOtp()`
 *
 * WHY THE SESSION IS MINTED THIS WAY. Supabase Auth issues sessions; an edge
 * function cannot sign a GoTrue session itself without holding the JWT secret,
 * and it must not. So the assertion is verified here, and on success the service
 * role asks the Auth admin API for a magic-link `hashed_token` for that email
 * (`auth.admin.generateLink({type:'magiclink'})` — which generates, it does not
 * send). The browser then calls `verifyOtp({token_hash, type:'magiclink'})` and
 * gets a normal session with normal refresh behaviour, indistinguishable from any
 * other login. The token is single-use and short-lived; it is returned once, in a
 * `no-store` response, and is never logged (`log.ts` redacts any key matching
 * /token/) nor persisted anywhere by us.
 *
 * ANTI-REPLAY, in three independent layers:
 *   1. the challenge is consumed by an `UPDATE … WHERE consumed_at IS NULL` whose
 *      null-check sits in the OUTER predicate, so two concurrent verifies cannot
 *      both claim it;
 *   2. the signature is checked against that challenge and this origin/rpID;
 *   3. `sign_count` must move forward — the UPDATE carries
 *      `AND (newCounter = 0 OR sign_count < newCounter)`, so a cloned
 *      authenticator whose counter has fallen behind is refused by the database,
 *      not by an `if` that could be reordered.
 *
 * ACCOUNT-LOCKOUT NOTE (read before adding a `sessions_audit` row). A failed
 * assertion here is NOT written to `public.sessions_audit` as `login_failed`.
 * That event drives `sessions_audit_apply_event()`, which increments
 * `profiles.failed_login_count` and DEACTIVATES the account at ten. That counter
 * is designed for password attempts, where a failure means somebody guessed a
 * secret wrongly. A WebAuthn assertion failure carries no such signal — anybody
 * who knows an employee's email can request options and post ten pieces of
 * garbage, which would turn this endpoint into a remote "deactivate any account"
 * button. Failures are recorded on the audit chain instead (`login_failed`
 * action, `public.audit_log`), which is what the security console reads.
 * Successes DO write `sessions_audit` (`passkey_used` + `login_success`), because
 * that is what maintains `profiles.last_login_at` and clears the counter.
 *
 * rpID: `hr.thetamarindtree.in` in production, `localhost` for Vite dev.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  badGateway,
  conflict,
  forbidden,
  gone,
  methodNotAllowed,
  notFound,
  ok,
  toProblem,
  unprocessable,
} from "../_shared/errors.ts";
import { parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { nowMs, toIso } from "../_shared/datetime.ts";
import { loadWebAuthn } from "../_shared/deps.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  serviceClient,
  sql as sqlHandle,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { sha256Hex } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { auditSession, writeAudit } from "../_shared/audit.ts";

const FN_NAME = "webauthn-login";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** Origin → rpID. See the identical map in `webauthn-register/index.ts`. */
const RP_BY_ORIGIN: Readonly<Record<string, string>> = {
  "https://hr.thetamarindtree.in": "hr.thetamarindtree.in",
  "http://localhost:5173": "localhost",
};

/** Ceremony timeout = the `secure.webauthn_challenges` TTL (3 minutes). */
const CEREMONY_TIMEOUT_MS = 180_000;

/**
 * PRD §10.3 anti-enumeration budget, applied to the `options` leg only. Verify is
 * a cryptographic operation whose duration is dominated by the signature check
 * and reveals nothing about which account it was for.
 */
const CONSTANT_TIME_MS = 400;

interface RelyingParty {
  rpId: string;
  origin: string;
}

function resolveRelyingParty(req: Request): RelyingParty {
  const origin = req.headers.get("origin");
  const rpId = origin === null ? undefined : RP_BY_ORIGIN[origin];
  if (origin === null || rpId === undefined) {
    throw forbidden(
      "Passkey sign-in is only available in the HRMS web app.",
      "WEBAUTHN_ORIGIN_NOT_ALLOWED",
    );
  }
  return { rpId, origin };
}

// ── base64url ───────────────────────────────────────────────────────────────

/** `webauthn_credentials.public_key` is base64url text; the verifier wants bytes. */
function base64UrlToBytes(value: string): Uint8Array {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised.padEnd(
    normalised.length + ((4 - (normalised.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── Identifier classification ───────────────────────────────────────────────
// The canonical copy lives in `auth-identify/index.ts`; it cannot be imported
// from here because that module calls `Deno.serve` at load. Keep the two in step:
// a code the login screen accepted at step 1 must resolve identically at step 2.

const CODE_RE = /^[A-Z]{1,6}[0-9]{1,10}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/;

function classifyIdentifier(raw: string): { code: string | null; email: string | null } {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    return { code: null, email: EMAIL_RE.test(email) ? email : null };
  }
  const code = trimmed.replace(/[\s._-]+/g, "").toUpperCase();
  return { code: CODE_RE.test(code) ? code : null, email: null };
}

// ── @simplewebauthn/server, shape-tolerantly ────────────────────────────────
// See the same note in `webauthn-register/index.ts`: v10→v12 renamed
// `authenticator` to `credential` on the verify call and moved the counter. Both
// spellings are sent and both result shapes are read, so a pin bump in deps.ts
// cannot turn into a silent authentication bypass or a hard 500.

type OptionsJson = Record<string, unknown> & { challenge: string };

interface AuthenticationVerification {
  verified: boolean;
  authenticationInfo?: Record<string, unknown> | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The post-assertion signature counter, whichever field carries it. */
function readNewCounter(info: Record<string, unknown>): number | null {
  const nested = asRecord(info.credential);
  const raw = info.newCounter ?? (nested === null ? undefined : nested.counter);
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.trunc(raw);
}

// ── Request schemas ─────────────────────────────────────────────────────────

const Identifier = z.string().trim().min(2).max(254);

const OptionsRequest = z
  .object({
    action: z.literal("options"),
    identifier: Identifier,
  })
  .strict();

/**
 * `.passthrough()`: `@simplewebauthn/server` is the authority on this structure.
 * zod's job is to bound the sizes and types of the fields WE touch.
 */
const AssertionResponse = z
  .object({
    clientDataJSON: z.string().min(1).max(8_192),
    authenticatorData: z.string().min(1).max(32_768),
    signature: z.string().min(1).max(8_192),
    userHandle: z.string().max(1_000).nullish(),
  })
  .passthrough();

const VerifyRequest = z
  .object({
    action: z.literal("verify"),
    identifier: Identifier,
    credential: z
      .object({
        id: z.string().min(1).max(1_000),
        rawId: z.string().min(1).max(1_000).optional(),
        type: z.literal("public-key").optional(),
        response: AssertionResponse,
        clientExtensionResults: z.record(z.unknown()).optional(),
        authenticatorAttachment: z.string().max(32).nullish(),
      })
      .passthrough(),
  })
  .strict();

const LoginBody = z.discriminatedUnion("action", [OptionsRequest, VerifyRequest]);

// ── Rows ────────────────────────────────────────────────────────────────────

interface AccountRow {
  profile_id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  must_change_password: boolean;
  employee_id: string | null;
  display_name: string | null;
  employment_status: string | null;
}

interface CredentialRow {
  id: string;
  credential_id: string;
  public_key: string;
  sign_count: string | number;
  transports: string[] | null;
  purpose: string;
}

/** `employment_status` values that may not open a session (mirrors PRD §10.7 `suspended`). */
const BLOCKED_EMPLOYMENT_STATUSES = ["suspended", "exited", "absconding", "retired"] as const;

/**
 * ONE generic refusal for "no such identifier", "no passkey on this account" and
 * "the credential you offered is not one of ours".
 *
 * It is a 404 per spec-architecture §4 ("never exists-but-forbidden"): the caller
 * learns only that passkey sign-in is not available for what they typed, which is
 * no more than `auth-identify` already told them.
 */
function passkeyUnavailable(): never {
  throw notFound(
    "Fingerprint sign-in isn't available for that account. Use your password instead.",
    "WEBAUTHN_NOT_AVAILABLE",
  );
}

async function padToConstantTime(startedMs: number): Promise<void> {
  const remaining = CONSTANT_TIME_MS - (nowMs() - startedMs);
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

/** Resolve `TT0042` or a work/login email to exactly one account. Service-role read. */
async function resolveAccount(
  client: ReturnType<typeof sqlHandle>,
  identifier: string,
): Promise<AccountRow | null> {
  const { code, email } = classifyIdentifier(identifier);
  if (code === null && email === null) return null;

  const rows = await client<AccountRow[]>`
    WITH input AS (
      SELECT ${code}::text AS code, ${email}::text AS email
    ),
    by_employee AS (
      SELECT e.profile_id
        FROM public.employees e
        CROSS JOIN input i
       WHERE e.deleted_at IS NULL
         AND e.profile_id IS NOT NULL
         AND (
               (i.code  IS NOT NULL AND e.employee_code = i.code)
            OR (i.email IS NOT NULL AND lower(e.work_email) = i.email)
         )
       ORDER BY (e.employment_status::text NOT IN ('exited', 'retired')) DESC,
                e.created_at DESC
       LIMIT 1
    )
    SELECT p.id                        AS profile_id,
           p.email,
           p.full_name,
           p.is_active,
           p.must_change_password,
           e.id                        AS employee_id,
           e.display_name,
           e.employment_status::text    AS employment_status
      FROM public.profiles p
      LEFT JOIN public.employees e
             ON e.profile_id = p.id AND e.deleted_at IS NULL
      CROSS JOIN input i
     WHERE p.id = (SELECT b.profile_id FROM by_employee b)
        OR (i.email IS NOT NULL AND lower(p.email) = i.email)
     ORDER BY (p.id = (SELECT b.profile_id FROM by_employee b)) DESC
     LIMIT 1
  ` as unknown as AccountRow[];

  return firstRow(rows);
}

/** 403 for a profile or employment state that cannot hold a session. */
function assertAccountUsable(account: AccountRow): void {
  const blocked = account.employment_status !== null &&
    (BLOCKED_EMPLOYMENT_STATUSES as readonly string[]).includes(account.employment_status);
  if (account.is_active !== true || blocked) {
    // No incremental disclosure: `auth-identify` returns `portalState:'suspended'`
    // for exactly this account, and the PRD specifies this copy for it.
    throw forbidden("This account is not active. Please contact HR.", "ACCOUNT_DISABLED");
  }
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
  const startedMs = nowMs();

  let status = 500;
  let padConstantTime = false;

  try {
    assertOriginAllowed(req);
    const client = sqlHandle();
    const rp = resolveRelyingParty(req);
    const ip = clientIpFrom(req);

    // ── STEP 4 · Auth ─────────────────────────────────────────────────────────
    // NONE — this is how a session is obtained in the first place. The anon key
    // the Supabase gateway checked is public (boundary B2) and is not authority.
    // The credential being verified below is the only authentication that happens.

    // ── STEP 5 · Authority ────────────────────────────────────────────────────
    // Not applicable pre-auth. Capabilities are re-derived from the DB on the
    // FIRST authenticated call after the session exists, never here.

    // ── STEP 6 · Rate limit, per IP ───────────────────────────────────────────
    await enforce(RATE_LIMITS.webauthn, limitKey(FN_NAME, "ip", ip), "RATE_LIMITED", client);

    // ── STEP 7 · Validate ─────────────────────────────────────────────────────
    const { data: body } = await parseBody(req, LoginBody, { maxBytes: 64 * 1024 });

    // ── STEP 6 (b) · Rate limit, per identifier ───────────────────────────────
    // Out of order because the key is the parsed body. Hashed, so
    // `app.rate_limit_buckets` never holds a list of real employee emails.
    const identifierHash = (await sha256Hex(body.identifier.trim().toLowerCase())).slice(0, 32);
    await enforce(
      RATE_LIMITS.webauthn,
      limitKey(FN_NAME, "id", identifierHash),
      "RATE_LIMITED",
      client,
    );

    const account = await resolveAccount(client, body.identifier);
    const webauthn = await loadWebAuthn();

    // ═════════════════════════════════════════════════════════════════════════
    // action = options
    // ═════════════════════════════════════════════════════════════════════════
    if (body.action === "options") {
      // Timing is padded on this leg: it is the one that answers a question about
      // whether an account exists.
      padConstantTime = true;

      if (account === null) passkeyUnavailable();
      assertAccountUsable(account);

      const credentials = await client<CredentialRow[]>`
        SELECT w.id, w.credential_id, w.public_key, w.sign_count, w.transports, w.purpose
          FROM public.webauthn_credentials w
         WHERE w.profile_id = ${account.profile_id}::uuid
           AND w.revoked_at IS NULL
           AND w.purpose IN ('login', 'both')
         ORDER BY w.last_used_at DESC NULLS LAST, w.created_at
      ` as unknown as CredentialRow[];

      if (credentials.length === 0) passkeyUnavailable();

      const generate = webauthn.generateAuthenticationOptions as unknown as (
        opts: Record<string, unknown>,
      ) => Promise<OptionsJson>;

      const options = await generate({
        rpID: rp.rpId,
        timeout: CEREMONY_TIMEOUT_MS,
        // Named credentials rather than a discoverable-credential prompt: the
        // employee has already identified themselves at step 1, and this keeps
        // the browser from offering a passkey for a different account on a shared
        // back-office machine.
        allowCredentials: credentials.map((row) => ({
          id: row.credential_id,
          ...(row.transports === null ? {} : { transports: row.transports }),
        })),
        userVerification: "required",
      });

      // ── STEPS 9 + 10 · set_context + ONE transaction ────────────────────────
      // `actorId` stays NULL: resolving an identifier is not proof of identity,
      // and stamping this write with the profile id would assert something the
      // caller has not yet demonstrated.
      const ctx: RequestContext = {
        actorId: null,
        actorRole: null,
        source: "web_employee",
        sourceRoute: FN_NAME,
        requestId,
        ip,
        ua: userAgentFrom(req),
      };

      const challengeRow = await withContext(ctx, async (tx) => {
        // Migration 012: `lookup` is the lowercased email for the login purpose.
        await tx`
          UPDATE secure.webauthn_challenges c
             SET consumed_at = now()
           WHERE c.lookup = ${account.email}
             AND c.purpose = 'login'
             AND c.consumed_at IS NULL
        `;
        const inserted = await tx<{ id: string; expires_at: Date }[]>`
          INSERT INTO secure.webauthn_challenges (lookup, challenge, purpose, expires_at)
          VALUES (
            ${account.email},
            ${options.challenge},
            'login',
            now() + make_interval(secs => ${CEREMONY_TIMEOUT_MS / 1000}::double precision)
          )
          RETURNING id, expires_at
        `;
        return firstRow(inserted as unknown as { id: string; expires_at: Date }[]);
      });

      if (challengeRow === null) throw new Error("challenge insert returned no row");

      status = 200;
      log.info("authentication options issued", {
        challenge_id: challengeRow.id,
        rp_id: rp.rpId,
        credentials: credentials.length,
      });
      return ok(
        {
          action: "options" as const,
          rpId: rp.rpId,
          /** Pass straight to `@simplewebauthn/browser` `startAuthentication`. */
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

    // ── STEP 8 · Idempotency ────────────────────────────────────────────────
    // Deliberately NO claim, for two reasons that both point the same way:
    //   1. the response contains a live single-use session credential, and
    //      `public.idempotency_keys.response` is a jsonb column with a 24-hour
    //      life — storing it there would keep a usable login token at rest for a
    //      day, which is a strictly worse trade than a client having to redo a
    //      three-second ceremony;
    //   2. it is not needed. The challenge row IS the single-use guard, and the
    //      sign-count check is the second one. A replayed verify gets 410, which
    //      is the honest answer: that assertion has been spent.

    if (account === null) passkeyUnavailable();
    assertAccountUsable(account);

    const auditCtx: RequestContext = {
      actorId: null,
      actorRole: null,
      source: "web_employee",
      sourceRoute: FN_NAME,
      requestId,
      ip,
      ua: userAgentFrom(req),
      reason: "passkey assertion at sign-in",
    };

    // ── Consume the challenge FIRST, in its own transaction ──────────────────
    // Spend it before any verification work: a failed attempt must not leave a
    // live challenge behind, or the failure becomes a retry oracle.
    const challenge = await withContext(auditCtx, async (tx) => {
      const consumed = await tx<{ challenge: string }[]>`
        UPDATE secure.webauthn_challenges c
           SET consumed_at = now()
         WHERE c.id = (
                 SELECT c2.id
                   FROM secure.webauthn_challenges c2
                  WHERE c2.lookup = ${account.email}
                    AND c2.purpose = 'login'
                    AND c2.consumed_at IS NULL
                    AND c2.expires_at > now()
                  ORDER BY c2.recorded_at DESC
                  LIMIT 1
               )
           -- In the OUTER predicate so Postgres re-checks it after waiting on a
           -- concurrent updater: this is what makes the challenge single-use.
           AND c.consumed_at IS NULL
        RETURNING c.challenge
      `;
      return firstRow(consumed as unknown as { challenge: string }[])?.challenge ?? null;
    });

    if (challenge === null) {
      throw gone(
        "This sign-in attempt has expired. Try again.",
        "WEBAUTHN_CHALLENGE_INVALID",
      );
    }

    // The credential must belong to the account the identifier resolved to.
    // Looking it up by `(profile_id, credential_id)` rather than by
    // `credential_id` alone is what stops one employee's passkey being used to
    // open another employee's session.
    const credential = firstRow(
      await client<CredentialRow[]>`
        SELECT w.id, w.credential_id, w.public_key, w.sign_count, w.transports, w.purpose
          FROM public.webauthn_credentials w
         WHERE w.profile_id = ${account.profile_id}::uuid
           AND w.credential_id = ${body.credential.id}
           AND w.revoked_at IS NULL
           AND w.purpose IN ('login', 'both')
         LIMIT 1
      ` as unknown as CredentialRow[],
    );
    if (credential === null) passkeyUnavailable();

    const storedCounter = Number(credential.sign_count);
    const verifyAuthentication = webauthn.verifyAuthenticationResponse as unknown as (
      opts: Record<string, unknown>,
    ) => Promise<AuthenticationVerification>;

    // Both key names are sent: `authenticator` (v10/v11) and `credential` (v12+).
    // Whichever the pinned version reads, the other is ignored.
    const authenticatorShape = {
      id: credential.credential_id,
      credentialID: credential.credential_id,
      publicKey: base64UrlToBytes(credential.public_key),
      credentialPublicKey: base64UrlToBytes(credential.public_key),
      counter: storedCounter,
      ...(credential.transports === null ? {} : { transports: credential.transports }),
    };

    let verification: AuthenticationVerification;
    try {
      verification = await verifyAuthentication({
        response: body.credential,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
        authenticator: authenticatorShape,
        credential: authenticatorShape,
      });
    } catch (err) {
      log.warn("assertion rejected", { err, credential_row: credential.id });
      await recordFailure(auditCtx, account, "assertion_verification_failed");
      throw unprocessable(
        [{ pointer: "/credential", code: "invalid", detail: "The passkey signature could not be verified." }],
        "That passkey could not be verified. Try again, or use your password.",
        "WEBAUTHN_VERIFICATION_FAILED",
      );
    }

    const info = verification.authenticationInfo === undefined
      ? null
      : asRecord(verification.authenticationInfo);
    if (verification.verified !== true || info === null) {
      await recordFailure(auditCtx, account, "assertion_not_verified");
      throw unprocessable(
        [{ pointer: "/credential", code: "invalid", detail: "The passkey signature could not be verified." }],
        "That passkey could not be verified. Try again, or use your password.",
        "WEBAUTHN_VERIFICATION_FAILED",
      );
    }

    const newCounter = readNewCounter(info);
    if (newCounter === null) {
      log.error("authenticationInfo shape not recognised", { keys: Object.keys(info) });
      throw new Error("unrecognised authenticationInfo shape from @simplewebauthn/server");
    }

    // ── Sign-count monotonicity, enforced by the database ────────────────────
    // `newCounter = 0` is the normal, spec-legal report from platform
    // authenticators that do not keep a counter (Apple, most Android): the check
    // has to accept it or passkeys stop working on the phones the venue actually
    // uses. Any authenticator that DOES count must count upwards; a value that
    // has gone backwards or stood still means two authenticators hold the same
    // private key, i.e. a clone.
    const bumped = await withContext(
      { ...auditCtx, actorId: account.profile_id, reason: "passkey sign-in" },
      async (tx) => {
        const rows = await tx<{ sign_count: string | number }[]>`
          UPDATE public.webauthn_credentials w
             SET sign_count   = GREATEST(w.sign_count, ${newCounter}::bigint),
                 last_used_at = now()
           WHERE w.id = ${credential.id}::uuid
             AND w.revoked_at IS NULL
             AND (${newCounter}::bigint = 0 OR w.sign_count < ${newCounter}::bigint)
          RETURNING w.sign_count
        `;
        return firstRow(rows as unknown as { sign_count: string | number }[]);
      },
    );

    if (bumped === null) {
      log.error("sign count regression", {
        credential_row: credential.id,
        stored_counter: storedCounter,
        presented_counter: newCounter,
      });
      await recordFailure(auditCtx, account, "sign_count_regression");
      // 409, not 401: the signature was valid: the STATE is wrong. The client
      // must fall back to a password, and someone should look at this credential.
      throw conflict(
        "This passkey needs to be set up again. Sign in with your password for now.",
        "WEBAUTHN_COUNTER_REPLAY",
      );
    }

    // ── Mint the session (Supabase Auth admin API) ───────────────────────────
    // OUTSIDE any transaction, and only after the counter has moved: an HTTP call
    // has no business holding a Postgres transaction open, and minting before the
    // replay check would hand a live token to a cloned authenticator.
    const link = await serviceClient().auth.admin.generateLink({
      type: "magiclink",
      email: account.email,
    });
    const tokenHash = link.data?.properties?.hashed_token ?? null;
    if (link.error !== null || tokenHash === null || tokenHash === "") {
      log.error("could not mint a session token", { err: link.error });
      await recordFailure(auditCtx, account, "session_mint_failed");
      throw badGateway(
        "Sign-in succeeded but the session could not be created. Try again.",
        "AUTH_SESSION_MINT_FAILED",
      );
    }

    // ── STEPS 9 + 10 · set_context + ONE transaction, audit inside it ────────
    // Now the actor IS known — the assertion proved it — so the session events are
    // attributed to them. `login_success` also drives
    // `sessions_audit_apply_event()`: `profiles.last_login_at` moves and
    // `failed_login_count` resets, which is why the success path DOES write here.
    const successCtx: RequestContext = {
      ...auditCtx,
      actorId: account.profile_id,
      reason: "passkey sign-in",
    };
    await withContext(successCtx, async (tx) => {
      await auditSession(tx, successCtx, {
        event: "passkey_used",
        profileId: account.profile_id,
        attemptedEmail: account.email,
        authMethod: "passkey",
      });
      await auditSession(tx, successCtx, {
        event: "login_success",
        profileId: account.profile_id,
        attemptedEmail: account.email,
        authMethod: "passkey",
      });
    });

    /**
     * The client's next call is:
     *
     *   supabase.auth.verifyOtp({ token_hash: tokenHash, type: verificationType })
     *
     * `tokenHash` is a live single-use credential. It is in a `no-store` response,
     * it is not stored by us, and `log.ts`'s redactor drops any field whose name
     * matches /token/ — so it cannot reach a log line by accident either.
     */
    const responseBody = {
      action: "verify" as const,
      verified: true,
      tokenHash,
      verificationType: "magiclink" as const,
      email: account.email,
      /**
       * Safe to disclose HERE and only here: the caller has just proved they hold
       * the account's passkey. `auth-identify` withholds it pre-auth on purpose.
       */
      mustChangePassword: account.must_change_password === true,
      displayName: account.display_name ?? account.full_name,
      requestId,
    };
    status = 200;

    // ── STEP 11 · Store under the idempotency key ───────────────────────────
    // Not applicable — see step 8. Nothing about this response is replayable.

    log.info("passkey sign-in verified", {
      profile_id: account.profile_id,
      credential_row: credential.id,
      counter: newCounter,
    });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;
    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // Constant-time only on the leg that answers an existence question; see the
    // note on CONSTANT_TIME_MS.
    if (padConstantTime) await padToConstantTime(startedMs);

    // ── STEP 12 · One structured log line per invocation ─────────────────────
    log.finish(status);
  }
});

/**
 * A failed assertion on the audit CHAIN only — never in `public.sessions_audit`.
 * See the account-lockout note at the top of this file: `sessions_audit`'s
 * `login_failed` deactivates the account at ten, and this endpoint's failures are
 * forgeable by anyone who knows an email.
 *
 * Best-effort: a login refusal must not turn into a 500 because the audit write
 * failed. The refusal itself is already logged and returned.
 */
async function recordFailure(
  ctx: RequestContext,
  account: AccountRow,
  failureReason: string,
): Promise<void> {
  try {
    await withContext({ ...ctx, reason: `passkey sign-in refused: ${failureReason}` }, async (tx) => {
      await writeAudit(tx, ctx, {
        action: "login_failed",
        entityTable: "public.profiles",
        entityId: account.profile_id,
        entityLabel: account.email,
        subjectEmployeeId: account.employee_id,
        fieldName: "auth.login.failed",
        newValue: { method: "passkey", failure_reason: failureReason },
        reason: `passkey sign-in refused: ${failureReason}`,
      });
    });
  } catch {
    // Swallowed on purpose. Nothing actionable, and the caller already has an
    // answer; the structured log line for this request records the refusal.
  }
}

/** Exported for `supabase/tests` — the same schemas and helpers the handler uses. */
export { base64UrlToBytes, classifyIdentifier, LoginBody, resolveRelyingParty, RP_BY_ORIGIN };
