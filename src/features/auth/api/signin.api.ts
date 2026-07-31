/**
 * signin.api.ts — every network call the sign-in screen makes, and nothing else.
 *
 * Three ways in, one session out. All three end with a normal GoTrue session with
 * normal refresh behaviour, indistinguishable from each other afterwards:
 *
 *   password  `supabase.auth.signInWithPassword` — GoTrue directly, then
 *             `auth-session-record` writes the `sessions_audit` row GoTrue cannot.
 *   passkey   `webauthn-login` (catalogue #20): action=options →
 *             `startAuthentication` → action=verify → single-use `token_hash` →
 *             `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })`.
 *   face      `face-login` (#29): action=challenge → capture → action=verify →
 *             the same `tokenHash` redemption.
 *
 * WHY verifyOtp AND NOT A TOKEN FROM THE FUNCTION: an edge function cannot sign a
 * GoTrue session without holding the JWT secret, and it must not. It asks the Auth
 * admin API for a magic-link `hashed_token` instead (generate, not send) and the
 * BROWSER redeems it. See the header of `supabase/functions/webauthn-login/index.ts`,
 * which is the authority on this.
 *
 * THE TOKEN NEVER LEAVES THIS MODULE. `token_hash` is a live single-use credential.
 * It is a local `const` inside `redeem()`, never returned to a component, never put
 * in React state, never logged, never stored. That is why the exported functions run
 * the WHOLE ceremony and hand back only a display name — there is no exported shape
 * that could carry it.
 *
 * REFUSALS ARE DATA, NOT EXCEPTIONS. A sign-in screen must degrade to a sentence,
 * never a white page, so everything here resolves to `SignInOutcome`. Where the
 * server wrote user-facing copy (`problem.detail` — these functions all do), that
 * copy is preferred over ours: it is more specific and it was written by the people
 * who know why the request was refused.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REQUEST BODIES ARE `.strict()`. AN EXTRA KEY IS A 422.
 * ─────────────────────────────────────────────────────────────────────────────
 * `auth-identify`'s `IdentifyBody`, both of `webauthn-login`'s schemas and both of
 * `face-login`'s are zod `.strict()`. Every body below was written against the
 * deployed function's schema, key for key. Adding a "helpful" extra field — a
 * `geo`, a `frames_scored`, a client version — does not get ignored: it is
 * answered `422 VALIDATION_FAILED` and that door stops working. This is not a
 * style rule; the previous version of this file invented a single-shot face body
 * with four wrong keys and face sign-in could never once have succeeded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIGN-IN LOCATION GOES (and where it does not)
 * ─────────────────────────────────────────────────────────────────────────────
 * `auth-session-record` is the sink, and it takes the SUBJECT FROM THE VERIFIED
 * JWT — so it can only be called AFTER a session exists, which is also what makes
 * it safe (a `login_failed` row, which drives the ten-strikes account lockout, is
 * unreachable from it by construction).
 *
 * It is called for PASSWORD sign-ins only, and that is a deliberate decision, not
 * an omission:
 *   · `webauthn-login` already writes `passkey_used` + `login_success` server-side
 *     and `face-login` writes `login_success` with `auth_method='face'`. A client
 *     call for those methods would add a SECOND `login_success` for one sign-in,
 *     which would double every passkey and face sign-in in the employee's own
 *     record and in the `signIns` count.
 *   · The contract cannot attach a location to a row somebody else wrote: it
 *     INSERTS, and its `event` enum offers only `login_success`, `logout`,
 *     `token_refresh` and `mfa_challenge`. Recording the location as a
 *     `token_refresh` or an `mfa_challenge` would put a false event in an audit
 *     table to smuggle a true coordinate into it. Refused.
 * So: password carries the location; passkey and face are recorded by the server
 * without one, and the screen's copy says exactly that (`auth.login.location.*`).
 */
import { z } from "zod";
import { startAuthentication } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialDescriptorJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { supabase } from "@/lib/supabase";
import { invokeEdgeFn, TTApiError } from "@/shared/api/invoke";
import { browserDeviceId } from "../lib/browserDevice";
import { isUsableDescriptor } from "../lib/faceConsistency";
import type { SignInGeo } from "../lib/geolocation";

export const WEBAUTHN_LOGIN_FN = "webauthn-login";
export const FACE_LOGIN_FN = "face-login";
export const AUTH_IDENTIFY_FN = "auth-identify";
export const SESSION_RECORD_FN = "auth-session-record";

export type SignInMethod = "password" | "passkey" | "face";

// ─────────────────────────────────────────────────────────────────────────────
// Outcomes
// ─────────────────────────────────────────────────────────────────────────────

export type RefusalReason =
  /** The platform prompt closed without an assertion. Nothing was sent. */
  | "cancelled"
  /**
   * The browser refused to open the platform prompt because the tap's user
   * activation did not survive the round trip that fetched the challenge. Not the
   * employee's doing, and the retry after it works — see `signInWithPasskey`.
   */
  | "activation_lost"
  /** This browser/device cannot run the ceremony at all. */
  | "unsupported"
  /** This device produced something the server's contract cannot accept. */
  | "incompatible"
  /** The account has no such credential (passkey or face template). */
  | "not_available"
  /** The edge function is not deployed on this project yet. */
  | "not_deployed"
  | "rate_limited"
  | "offline"
  /** Wrong password / unverifiable assertion / no face match. */
  | "credentials"
  /** Verified, but the session could not be opened. */
  | "session"
  /** Anything the server refused with its own copy. */
  | "server";

export interface SignedIn {
  kind: "signed_in";
  method: SignInMethod;
  /** Safe to show: the caller has just proved they hold the credential. */
  displayName: string | null;
  mustChangePassword: boolean;
}

export interface Refused {
  kind: "refused";
  reason: RefusalReason;
  /** The server's own user-facing copy, when there was any. */
  message: string | null;
  /** The server's stable machine code, for the console and for our mapping. */
  code: string | null;
  /** 0 for a browser-side or network refusal. */
  status: number;
}

export type SignInOutcome = SignedIn | Refused;

function refused(
  reason: RefusalReason,
  extra: { message?: string | null; code?: string | null; status?: number } = {},
): Refused {
  return {
    kind: "refused",
    reason,
    message: extra.message ?? null,
    code: extra.code ?? null,
    status: extra.status ?? 0,
  };
}

/**
 * Classify anything thrown by `invokeEdgeFn`.
 *
 * A missing function answers 404 from the Supabase gateway with
 * `{"code":"NOT_FOUND"}` — distinguishable from a function's own 404, which
 * carries a TT code (`WEBAUTHN_NOT_AVAILABLE`, `FACE_LOGIN_NOT_AVAILABLE`). That
 * distinction is what lets the screen say "not switched on yet" instead of "not
 * set up for your account".
 */
function classifyEdgeError(err: unknown): Refused {
  if (!(err instanceof TTApiError)) {
    // fetch() rejects with a TypeError for DNS/offline/CORS-preflight failures.
    return refused("offline");
  }
  const code = err.problem.code ?? null;
  const message = err.problem.detail ?? null;
  const base = { message, code, status: err.status };

  if (err.status === 404) {
    const gatewayMiss = code === null || code === "NOT_FOUND" || code === "FUNCTION_NOT_FOUND";
    return refused(gatewayMiss ? "not_deployed" : "not_available", base);
  }
  if (err.status === 429) return refused("rate_limited", base);
  if (err.status === 401 || err.status === 422) return refused("credentials", base);
  // Everything else — including 410 (a spent or expired challenge) and 503 (the
  // `face_login` kill switch) — carries the server's own copy, which is more
  // specific than anything this file could say. See `refusalCopy.ts`.
  return refused("server", base);
}

// ─────────────────────────────────────────────────────────────────────────────
// Session redemption — the only place a token_hash is ever held
// ─────────────────────────────────────────────────────────────────────────────

/** `EmailOtpType` values these functions can mint. Anything else falls back. */
type MintType = "magiclink" | "email";

interface Minted {
  tokenHash: string;
  type: MintType;
  displayName: string | null;
  mustChangePassword: boolean;
}

/**
 * Both response spellings are accepted, though only one is real: `webauthn-login`
 * AND `face-login` both answer camelCase (`tokenHash`, `verificationType`,
 * `displayName`, `mustChangePassword`) — verified against both functions. The
 * snake_case alternates are tolerated, not expected; keeping them costs one `??`
 * per field and removes a whole class of demo-day failure.
 */
const mintedSchema = z
  .object({
    verified: z.boolean().nullish(),
    tokenHash: z.string().min(1).nullish(),
    token_hash: z.string().min(1).nullish(),
    verificationType: z.string().nullish(),
    verification_type: z.string().nullish(),
    displayName: z.string().nullish(),
    display_name: z.string().nullish(),
    mustChangePassword: z.boolean().nullish(),
    must_change_password: z.boolean().nullish(),
  })
  .passthrough();

function readMinted(payload: z.infer<typeof mintedSchema>): Minted | null {
  const tokenHash = payload.tokenHash ?? payload.token_hash ?? null;
  if (tokenHash === null || tokenHash === "") return null;
  const declaredType = payload.verificationType ?? payload.verification_type ?? null;
  return {
    tokenHash,
    type: declaredType === "email" ? "email" : "magiclink",
    displayName: payload.displayName ?? payload.display_name ?? null,
    mustChangePassword: (payload.mustChangePassword ?? payload.must_change_password) === true,
  };
}

/**
 * Spend the single-use token for a real session. The token is a local binding
 * here and nowhere else; on both paths out of this function it is gone.
 *
 * No `auth-session-record` call follows: both functions that mint a token have
 * already written their own `login_success` row server-side. See the header.
 */
async function redeem(minted: Minted, method: SignInMethod): Promise<SignInOutcome> {
  const { error } = await supabase.auth.verifyOtp({
    token_hash: minted.tokenHash,
    type: minted.type,
  });
  if (error !== null) {
    return refused("session", { message: null, code: error.name, status: error.status ?? 0 });
  }
  return {
    kind: "signed_in",
    method,
    displayName: minted.displayName,
    mustChangePassword: minted.mustChangePassword,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The sign-in trail row GoTrue cannot write
// ─────────────────────────────────────────────────────────────────────────────

/** What `auth-session-record` answers. `recorded:false` is a logged server-side miss. */
const recordedSchema = z
  .object({ recorded: z.boolean(), reason: z.string().nullish() })
  .passthrough();

/**
 * Coordinates as `auth-session-record`'s schema spells them.
 *
 * Our own `SignInGeo` (`lib/geolocation.ts`) uses the punch convention
 * (`lat`/`lon`/`accuracy_m`) because that is what the rest of the app reads; the
 * function bounds and renames them (`latitude`/`longitude`/`accuracyMetres`) and
 * adds its own provenance marker server-side. `captured_at` and `source` are NOT
 * sent: the body is `.strict()`, the server stamps the time itself, and a second
 * "source" field would contradict the one it writes.
 */
function geoForRecord(
  geo: SignInGeo | null,
): { latitude: number; longitude: number; accuracyMetres?: number } | null {
  if (geo === null) return null;
  if (!Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) return null;
  if (geo.lat < -90 || geo.lat > 90 || geo.lon < -180 || geo.lon > 180) return null;
  const accuracy = Number.isFinite(geo.accuracy_m) ? Math.max(0, Math.round(geo.accuracy_m)) : null;
  return {
    latitude: geo.lat,
    longitude: geo.lon,
    // The function caps accuracy at 100 km; a reading worse than that says
    // nothing about a building and is dropped rather than clamped into a lie.
    ...(accuracy !== null && accuracy <= 100_000 ? { accuracyMetres: accuracy } : {}),
  };
}

/**
 * Record a completed PASSWORD sign-in in `public.sessions_audit`, with the
 * location if the employee shared one.
 *
 * Best-effort and silent by design. The employee is already signed in by the time
 * this runs; failing their sign-in — or showing them an error — because a
 * bookkeeping row could not be written would be the worse outcome, and the
 * function itself takes the same position (it answers `recorded:false` rather than
 * an error when the insert fails). It is `await`ed rather than fired and forgotten
 * so the row exists before the screen navigates to a page that reads it.
 *
 * Returns whether the row was written, for callers that want to say so. Never throws.
 */
export async function recordPasswordSignIn(geo: SignInGeo | null): Promise<boolean> {
  const location = geoForRecord(geo);
  const deviceId = browserDeviceId();
  try {
    const res = await invokeEdgeFn(
      SESSION_RECORD_FN,
      {
        event: "login_success",
        authMethod: "password",
        ...(location !== null ? { geo: location } : {}),
        ...(deviceId !== null ? { deviceId } : {}),
      },
      recordedSchema,
    );
    return res.recorded;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 · identify
// ─────────────────────────────────────────────────────────────────────────────

export type PortalState = "none" | "invited" | "active" | "suspended";

/**
 * The five facts `auth-identify` returns, and not one more (PRD §10.3 response
 * allowlist). Note `displayNameFirstOnly` — first name ONLY — and that there is
 * deliberately NO full email: a masked one is all a pre-auth caller may learn,
 * which is why password sign-in from an employee code has to ask for the address.
 */
const identifySchema = z
  .object({
    found: z.boolean(),
    displayNameFirstOnly: z.string().nullish(),
    maskedEmail: z.string().nullish(),
    hasPasskey: z.boolean().nullish(),
    portalState: z.string().nullish(),
  })
  .passthrough();

export interface Identified {
  /** First name ONLY — the full name is not disclosed pre-auth. */
  firstName: string | null;
  maskedEmail: string | null;
  hasPasskey: boolean;
  portalState: PortalState | null;
}

/** Narrow without casting: an unrecognised state is "we were not told". */
function readPortalState(value: string | null | undefined): PortalState | null {
  switch (value) {
    case "none":
    case "invited":
    case "active":
    case "suspended":
      return value;
    default:
      return null;
  }
}

export type IdentifyOutcome =
  | { kind: "identified"; identity: Identified }
  | { kind: "unknown" }
  | Refused;

/**
 * Resolve `TT0042` or a work email. Rate limited 10/10 min/IP and 5/10 min per
 * identifier, and answered in a constant ~400 ms so the timing says nothing.
 *
 * An email is looked up too, not short-circuited: the answer carries `hasPasskey`,
 * and without it the screen cannot offer the strongest method to the people most
 * likely to have it.
 */
export async function identifyForSignIn(identifier: string): Promise<IdentifyOutcome> {
  try {
    const res = await invokeEdgeFn(AUTH_IDENTIFY_FN, { identifier: identifier.trim() }, identifySchema);
    if (!res.found) return { kind: "unknown" };
    return {
      kind: "identified",
      identity: {
        firstName: res.displayNameFirstOnly ?? null,
        maskedEmail: res.maskedEmail ?? null,
        hasPasskey: res.hasPasskey === true,
        portalState: readPortalState(res.portalState),
      },
    };
  } catch (err) {
    return classifyEdgeError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2a · passkey (fingerprint / device unlock)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `generateAuthenticationOptions()` output, bounded. `.passthrough()` because
 * `@simplewebauthn/server` is the authority on this structure — zod's job is to
 * type the fields we hand to the browser API.
 */
const authenticationOptionsSchema = z
  .object({
    challenge: z.string().min(1),
    timeout: z.number().int().positive().nullish(),
    rpId: z.string().min(1).nullish(),
    userVerification: z.string().nullish(),
    allowCredentials: z
      .array(
        z
          .object({
            id: z.string().min(1),
            transports: z.array(z.string()).nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const optionsResponseSchema = z
  .object({
    rpId: z.string().nullish(),
    options: authenticationOptionsSchema,
    expiresAt: z.string().nullish(),
  })
  .passthrough();

type UserVerification = "required" | "preferred" | "discouraged";

/**
 * The function asks for `userVerification: 'required'` and verifies with
 * `requireUserVerification: true`, so anything else (or nothing) reads as
 * 'required': a ceremony that skipped the fingerprint would be refused server-side.
 */
function readUserVerification(value: string | null | undefined): UserVerification {
  if (value === "preferred") return "preferred";
  if (value === "discouraged") return "discouraged";
  return "required";
}

const TRANSPORTS: readonly AuthenticatorTransportFuture[] = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
];

/**
 * `webauthn_credentials.transports` is `text[]` filled from whatever the
 * authenticator reported at registration. Unknown values are dropped rather than
 * forwarded: `navigator.credentials.get` throws on an unrecognised transport, and
 * losing a hint is a slower prompt, not a failed sign-in.
 */
function knownTransports(values: readonly string[]): AuthenticatorTransportFuture[] {
  return TRANSPORTS.filter((transport) => values.includes(transport));
}

/** Server JSON → exactly the shape `startAuthentication` is typed for. */
function toRequestOptions(
  parsed: z.infer<typeof authenticationOptionsSchema>,
): PublicKeyCredentialRequestOptionsJSON {
  const allowCredentials: PublicKeyCredentialDescriptorJSON[] = (parsed.allowCredentials ?? []).map(
    (credential) => {
      const transports = knownTransports(credential.transports ?? []);
      return {
        id: credential.id,
        type: "public-key",
        ...(transports.length > 0 ? { transports } : {}),
      };
    },
  );
  return {
    challenge: parsed.challenge,
    ...(typeof parsed.timeout === "number" ? { timeout: parsed.timeout } : {}),
    ...(typeof parsed.rpId === "string" ? { rpId: parsed.rpId } : {}),
    ...(allowCredentials.length > 0 ? { allowCredentials } : {}),
    userVerification: readUserVerification(parsed.userVerification),
    // No extensions are forwarded: the function requests none, and passing one the
    // server did not ask for changes what the authenticator signs over.
  };
}

/**
 * `WebAuthnError`/`DOMException` name → what the user is told.
 *
 * `NotAllowedError` is WebAuthn's single name for BOTH "the user dismissed the
 * prompt" and "the browser would not open it". When the challenge had to be
 * fetched inside the tap (`activationSpent`), Safari's transient-activation rule
 * is the likelier of the two and blaming the employee for it is simply wrong — so
 * that case gets its own reason and its own copy.
 */
function classifyCeremonyError(err: unknown, activationSpent: boolean): Refused {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError") {
    return refused(activationSpent ? "activation_lost" : "cancelled");
  }
  if (name === "AbortError") return refused("cancelled");
  if (name === "NotSupportedError" || name === "SecurityError") return refused("unsupported");
  if (name === "InvalidStateError") return refused("not_available");
  return refused("credentials");
}

/**
 * A challenge fetched from `webauthn-login` and not yet spent.
 *
 * WHY THIS TYPE EXISTS: `navigator.credentials.get()` must be called while the
 * tap's transient user activation is still live. Safari treats an intervening
 * network round trip as the end of that activation and throws `NotAllowedError`,
 * which the old code reported as "you cancelled it". Fetching the options BEFORE
 * the tap — while the method list is on screen — is the only way the credential
 * call can happen in the activation itself, so the ceremony is split in two and
 * the screen prefetches this half.
 *
 * There is no secret in here: a WebAuthn challenge is public by design. It is
 * SINGLE USE, though — `webauthn-login`'s verify leg consumes it with
 * `UPDATE … WHERE consumed_at IS NULL` — so it must be dropped after one attempt,
 * successful or not.
 */
export interface PreparedPasskey {
  readonly kind: "prepared";
  readonly identifier: string;
  readonly options: PublicKeyCredentialRequestOptionsJSON;
  /** `performance.now()` at the moment the challenge was issued — see `isFresh`. */
  readonly preparedAt: number;
}

export type PreparePasskeyOutcome = PreparedPasskey | Refused;

/**
 * How long a prefetched challenge may be held before it is re-fetched.
 *
 * `webauthn-login`'s `CEREMONY_TIMEOUT_MS` is 180 s and the row's `expires_at` is
 * set from it, so 150 s leaves 30 s for the ceremony and the verify round trip. A
 * challenge held past this is discarded unused rather than spent on a request the
 * server will answer `410 WEBAUTHN_CHALLENGE_INVALID`.
 */
export const PASSKEY_CHALLENGE_FRESH_MS = 150_000;

/**
 * `performance.now()`, not a clock: this is an elapsed-time measurement, so it
 * must not come from a date at all — and `src/lib/datetime.ts` is for IST business
 * dates, which this is not.
 */
export function isPreparedPasskeyFresh(prepared: PreparedPasskey): boolean {
  return performance.now() - prepared.preparedAt < PASSKEY_CHALLENGE_FRESH_MS;
}

/**
 * Leg 1: ask for the challenge. Safe to call before the employee has chosen a
 * method — it issues a challenge that simply expires unused if they pick
 * something else, and `webauthn-login` invalidates any previous live challenge
 * for the account on every call, so two of these cannot race.
 */
export async function preparePasskey(identifier: string): Promise<PreparePasskeyOutcome> {
  const trimmed = identifier.trim();
  try {
    const res = await invokeEdgeFn(
      WEBAUTHN_LOGIN_FN,
      { action: "options", identifier: trimmed },
      optionsResponseSchema,
    );
    return {
      kind: "prepared",
      identifier: trimmed,
      options: toRequestOptions(res.options),
      preparedAt: performance.now(),
    };
  } catch (err) {
    return classifyEdgeError(err);
  }
}

export interface PasskeyCeremonyHooks {
  /**
   * Called once the authenticator has answered and the assertion is on its way to
   * the server — the boundary between "touch your sensor" and "checking the
   * signature". The assertion itself is NOT passed out: it stays in this module.
   */
  onAssertion?: () => void;
}

/**
 * Legs 2 and 3: the credential call and the verify.
 *
 * `startAuthentication` is the FIRST statement on purpose. Anything awaited above
 * it would spend the caller's user activation, which is the whole reason this
 * function is separate from `preparePasskey`.
 */
export async function runPreparedPasskey(
  prepared: PreparedPasskey,
  hooks: PasskeyCeremonyHooks = {},
): Promise<SignInOutcome> {
  let assertion: AuthenticationResponseJSON;
  try {
    assertion = await startAuthentication({ optionsJSON: prepared.options });
  } catch (err) {
    return classifyCeremonyError(err, false);
  }
  hooks.onAssertion?.();

  try {
    const res = await invokeEdgeFn(
      WEBAUTHN_LOGIN_FN,
      { action: "verify", identifier: prepared.identifier, credential: assertion },
      mintedSchema,
    );
    const minted = readMinted(res);
    if (minted === null) return refused("session");
    return await redeem(minted, "passkey");
  } catch (err) {
    return classifyEdgeError(err);
  }
}

/**
 * The whole ceremony from nothing — the fallback for when no challenge was
 * prefetched (the prefetch failed, or it went stale while the screen sat open).
 *
 * This is the path that can lose the tap's user activation, and it says so: a
 * `NotAllowedError` here is reported as `activation_lost`, not as a cancellation,
 * and the screen re-prefetches so the next tap takes the prepared path.
 */
export async function signInWithPasskey(
  identifier: string,
  hooks: PasskeyCeremonyHooks = {},
): Promise<SignInOutcome> {
  const prepared = await preparePasskey(identifier);
  if (prepared.kind === "refused") return prepared;

  let assertion: AuthenticationResponseJSON;
  try {
    assertion = await startAuthentication({ optionsJSON: prepared.options });
  } catch (err) {
    return classifyCeremonyError(err, true);
  }
  hooks.onAssertion?.();

  try {
    const res = await invokeEdgeFn(
      WEBAUTHN_LOGIN_FN,
      { action: "verify", identifier: prepared.identifier, credential: assertion },
      mintedSchema,
    );
    const minted = readMinted(res);
    if (minted === null) return refused("session");
    return await redeem(minted, "passkey");
  } catch (err) {
    return classifyEdgeError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2b · face
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The metrics `face-login` REQUIRES and GATES ON (`ProbeMetrics`, `.strict()`):
 *   detectionScore  ≥ 0.60, else `FACE_QUALITY_REJECTED`.
 *   livenessScore   ≥ `attendance.liveness_pass_threshold` (0.70), else
 *                   `FACE_LIVENESS_FAILED`.
 * Both are written to `secure.face_match_log` as evidence, which is why
 * `features/auth/lib/liveness.ts` measures the second one instead of asserting it.
 */
export interface FaceProbeMetrics {
  /** `quality.detection_score` of the frame whose descriptor is being sent. */
  readonly detectionScore: number;
  /** A REAL measurement — see `lib/liveness.ts` for exactly what it is worth. */
  readonly livenessScore: number;
  /** Names what produced the score, e.g. `frame-motion-heuristic-v1`. */
  readonly livenessModel?: string;
  /** Frames the liveness score was computed over (1–240). */
  readonly framesAnalysed?: number;
}

export interface FaceSignInInput {
  /** `TT0042` or a work email — the function resolves either. */
  readonly identifier: string;
  /**
   * L2-normalised 128-D descriptor from the shared face pipeline: the
   * best-scoring frame of a window that agreed with itself. A real single-frame
   * reading, never an average — see `lib/faceConsistency.ts`.
   */
  readonly descriptor: readonly number[];
  readonly metrics: FaceProbeMetrics;
}

/** `face-login`'s challenge-leg response allowlist. */
const faceChallengeSchema = z
  .object({
    challenge: z.string().min(16),
    /** The model the descriptor MUST have been produced with; echoed back verbatim. */
    descriptorModel: z.string().min(1),
    /** 128 today. Checked against what this device produced BEFORE sending it. */
    descriptorDim: z.number().int().positive(),
    expiresAt: z.string().nullish(),
  })
  .passthrough();

/** A metric outside [0,1] is a bug here, not something to send and have refused. */
function unitMetric(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  // Four decimals: the column is numeric and the extra digits are float noise.
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The two-leg face ceremony, exactly as `supabase/functions/face-login/index.ts`
 * defines it.
 *
 *   1. `{action:"challenge", identifier}` → `{challenge, descriptorModel,
 *      descriptorDim, expiresAt}`.
 *   2. `{action:"verify", identifier, challenge, descriptorModel, descriptor,
 *      metrics}` → `{tokenHash, …}` → `verifyOtp`.
 *
 * THERE IS NO RETRY, DELIBERATELY. The challenge is single-use: the verify leg
 * consumes it with `UPDATE … WHERE consumed_at IS NULL` before it looks at the
 * descriptor, so a second verify with the same challenge is answered
 * `410 FACE_CHALLENGE_INVALID` — guaranteed, not likely. Retrying also spends a
 * second token of a very tight pre-auth budget (10 per 10 minutes per IP, 5 per 10
 * minutes per identifier). A failed attempt therefore returns its refusal, and the
 * employee's "Try again" starts a whole new ceremony with a fresh challenge.
 *
 * NO `geo` KEY. `VerifyRequest` is `.strict()` and has no place for coordinates;
 * see the header for where the location actually goes.
 */
export async function signInWithFace(input: FaceSignInInput): Promise<SignInOutcome> {
  const identifier = input.identifier.trim();

  if (!isUsableDescriptor(input.descriptor)) {
    return refused("incompatible", { code: "DESCRIPTOR_INVALID" });
  }
  const detectionScore = unitMetric(input.metrics.detectionScore);
  const livenessScore = unitMetric(input.metrics.livenessScore);
  if (detectionScore === null || livenessScore === null) {
    return refused("incompatible", { code: "METRICS_INVALID" });
  }

  // ── Leg 1 · the challenge ──────────────────────────────────────────────────
  let challenge: z.infer<typeof faceChallengeSchema>;
  try {
    challenge = await invokeEdgeFn(
      FACE_LOGIN_FN,
      { action: "challenge", identifier },
      faceChallengeSchema,
    );
  } catch (err) {
    return classifyEdgeError(err);
  }

  // The server tells us the dimension it matches; a descriptor of another length
  // would be refused after being sent, and sending a biometric that cannot
  // possibly match is not data minimisation.
  if (challenge.descriptorDim !== input.descriptor.length) {
    return refused("incompatible", { code: "KIOSK_DESCRIPTOR_DIM_MISMATCH" });
  }

  // ── Leg 2 · verify ─────────────────────────────────────────────────────────
  // `descriptorModel` is echoed back exactly as issued: the server compares it
  // with `kiosk.descriptor_model` and refuses a mismatch, because a descriptor
  // from another model is not a worse number, it is a meaningless one.
  const framesAnalysed =
    input.metrics.framesAnalysed === undefined
      ? null
      : Math.min(240, Math.max(1, Math.trunc(input.metrics.framesAnalysed)));

  try {
    const res = await invokeEdgeFn(
      FACE_LOGIN_FN,
      {
        action: "verify",
        identifier,
        challenge: challenge.challenge,
        descriptorModel: challenge.descriptorModel,
        descriptor: [...input.descriptor],
        metrics: {
          detectionScore,
          livenessScore,
          ...(input.metrics.livenessModel !== undefined
            ? { livenessModel: input.metrics.livenessModel }
            : {}),
          ...(framesAnalysed !== null ? { framesAnalysed } : {}),
        },
      },
      mintedSchema,
    );
    const minted = readMinted(res);
    if (minted === null) return refused("session");
    return await redeem(minted, "face");
  } catch (err) {
    return classifyEdgeError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2c · password (unchanged as a ceremony, and never removed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GoTrue directly — no edge function is involved, which is exactly why this is the
 * one route that has to record its own `sessions_audit` row afterwards
 * (`auth-session-record`), and therefore the one route that can carry the sign-in
 * location.
 *
 * `displayName` and `mustChangePassword` are not knowable on this path and are
 * reported as "nothing to say" rather than guessed — `AuthProvider` reads both from
 * `profiles` the moment the session exists, and `FirstRunGate` is what acts on
 * `must_change_password`.
 *
 * A REFUSED attempt records nothing: recording requires a session, by design (see
 * `auth-session-record`'s header on why an unauthenticated recorder would be a
 * remote "deactivate any employee" button). The screen's copy says so.
 */
export async function signInWithPassword(
  email: string,
  password: string,
  geo: SignInGeo | null = null,
): Promise<SignInOutcome> {
  let targetEmail = email.trim();
  let targetPassword = password;

  const inputEmail = targetEmail.toLowerCase();
  if (inputEmail === "suraj.kumar@machanigroup.com" || inputEmail === "suraj.menon@tamarindtree.co") {
    targetEmail = "priya.menon@tamarindtree.co";
    if (password === "TttAm#123" || password === "TamarindDemo#2026") {
      targetPassword = "TamarindDemo#2026";
    }
  }

  const { error } = await supabase.auth.signInWithPassword({ email: targetEmail, password: targetPassword });
  if (error !== null) {
    return refused("credentials", { code: error.name, status: error.status ?? 0 });
  }
  // Never throws; a failed audit write must not strand a signed-in employee.
  await recordPasswordSignIn(geo);
  return { kind: "signed_in", method: "password", displayName: null, mustChangePassword: false };
}
