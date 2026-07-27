/**
 * deviceAuth.ts — the gate tablet's credential store and signed transport.
 *
 * The tablet is NOT a database user and holds no JWT. It proves possession of a
 * device secret on every request (auth model D): HMAC-SHA256 over the canonical
 * string `${timestamp}.${nonce}.${rawBody}` — the exact recipe
 * `_shared/auth.ts#deviceCanonicalString` verifies, byte for byte. The raw JSON
 * string that is signed IS the string that is sent; re-serialising would change
 * the bytes and break the signature.
 *
 * Storage: localStorage, deliberately. The secret arrives ONCE at pairing and
 * the tablet must survive a reload without re-pairing (re-pairing needs an
 * admin-issued code). A kiosk is a dedicated device in a public place — the
 * defence is device revocation in the admin console plus per-request nonces
 * (server-side replay burn), not hiding the secret from the device itself.
 *
 * Every helper returns typed results and never throws on HTTP errors — a gate
 * screen must degrade to a message, not a white page.
 */
import { env } from "@/lib/env";
import { nowInstantIso } from "@/lib/datetime";

const STORE_KEY = "tt-kiosk-device-v1";

export interface KioskDeviceState {
  deviceId: string;
  deviceCode: string;
  deviceName: string;
  /** `kdt_…`, returned exactly once by kiosk-device-activate. */
  secret: string;
  /** Open guard session token, when a guard is signed in. */
  session?: string;
  operatorName?: string;
  operatorCode?: string;
  canEnrolFaces?: boolean;
  pairedAt: string;
}

export function loadDeviceState(): KioskDeviceState | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as KioskDeviceState;
    return typeof parsed.deviceId === "string" && typeof parsed.secret === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function saveDeviceState(state: KioskDeviceState): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

export function clearDeviceState(): void {
  localStorage.removeItem(STORE_KEY);
}

/** Wipe only the guard session (end of shift); the pairing survives. */
export function clearSession(state: KioskDeviceState): KioskDeviceState {
  const next: KioskDeviceState = { ...state };
  delete next.session;
  delete next.operatorName;
  delete next.operatorCode;
  delete next.canEnrolFaces;
  saveDeviceState(next);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signing
// ─────────────────────────────────────────────────────────────────────────────

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function nonce(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A problem+json error surfaced as data, never thrown. */
export interface KioskCallError {
  status: number;
  code: string;
  detail: string;
}

export type KioskResult<T> = { ok: true; data: T } | { ok: false; error: KioskCallError };

async function parseResult<T>(res: Response): Promise<KioskResult<T>> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fall through — non-JSON body handled below
  }
  const record = (body ?? {}) as Record<string, unknown>;
  if (res.ok) {
    const data = ("data" in record ? record["data"] : record) as T;
    return { ok: true, data };
  }
  return {
    ok: false,
    error: {
      status: res.status,
      code: typeof record["code"] === "string" ? (record["code"] as string) : "UNKNOWN",
      detail:
        typeof record["detail"] === "string"
          ? (record["detail"] as string)
          : `The gate service answered ${res.status}.`,
    },
  };
}

/**
 * Signed device call. The body is serialised ONCE; that exact string is signed
 * and sent. `session` adds the guard's `x-operator-session`.
 */
export async function deviceCall<T>(
  state: Pick<KioskDeviceState, "deviceId" | "secret">,
  fn: string,
  body: Record<string, unknown>,
  opts: { session?: string; signal?: AbortSignal } = {},
): Promise<KioskResult<T>> {
  const raw = JSON.stringify(body);
  const ts = nowInstantIso();
  const n = nonce();
  const signature = await hmacSha256Hex(state.secret, `${ts}.${n}.${raw}`);
  try {
    const res = await fetch(`${env.supabaseUrl}/functions/v1/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.supabasePublishableKey,
        "x-device-id": state.deviceId,
        "x-timestamp": ts,
        "x-nonce": n,
        "x-signature": signature,
        "x-idempotency-key": crypto.randomUUID(),
        ...(opts.session !== undefined ? { "x-operator-session": opts.session } : {}),
      },
      body: raw,
      signal: opts.signal ?? null,
    });
    return await parseResult<T>(res);
  } catch {
    return {
      ok: false,
      error: { status: 0, code: "OFFLINE", detail: "The gate cannot reach the server." },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The protocol steps the kiosk UI performs
//
//   pairDevice            once per device, trades an admin code for the secret
//   identifyGuardByFace   names the guard on duty (identification, no session)
//   openOperatorSession   employee code + PIN → the session punches run under
//   closeOperatorSession  end of shift
//   sendPunch             the hot path
// ─────────────────────────────────────────────────────────────────────────────

interface PairResponse {
  device_id: string;
  device_code: string;
  device_name: string;
  device_secret: string;
}

/**
 * One-time pairing: trades the admin-issued 6-digit code for the HMAC secret.
 *
 * THE CODE IS THE ONLY THING THAT HAS TO MATCH. `device_code` is deliberately NOT
 * sent: it is optional on the server, and the activation code resolves the device
 * on its own. Requiring the guard to also type an exact device code was the
 * friction the client removed — "whatever the device name they can put, and then if
 * they register, then it will be registered".
 *
 * `deviceName` is free text and optional. It travels as `device.proposed_name` and
 * lands on `kiosk_devices.label`; omitted or blank, the admin's placeholder stands.
 */
export async function pairDevice(
  activationCode: string,
  deviceName?: string,
): Promise<KioskResult<KioskDeviceState>> {
  const proposed = deviceName?.trim() ?? "";
  try {
    const res = await fetch(`${env.supabaseUrl}/functions/v1/kiosk-device-activate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.supabasePublishableKey,
        "x-idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        activation_code: activationCode.trim(),
        device: {
          app_version: "1.0.0",
          platform: "web-kiosk",
          // OMITTED when blank, not sent as "": the schema is `.strict()` with a
          // `.max(120)` string, and an empty string would overwrite a perfectly
          // good admin-set label with nothing.
          ...(proposed === "" ? {} : { proposed_name: proposed }),
        },
      }),
    });
    const parsed = await parseResult<PairResponse>(res);
    if (!parsed.ok) return parsed;
    const state: KioskDeviceState = {
      deviceId: parsed.data.device_id,
      deviceCode: parsed.data.device_code,
      deviceName: parsed.data.device_name,
      secret: parsed.data.device_secret,
      pairedAt: nowInstantIso(),
    };
    saveDeviceState(state);
    return { ok: true, data: state };
  } catch {
    return {
      ok: false,
      error: { status: 0, code: "OFFLINE", detail: "The gate cannot reach the server." },
    };
  }
}

interface IdentifyGuardResponse {
  identified?: boolean;
  employeeCode?: string;
  displayName?: string;
}

/** Who the face in front of the front camera is, if they are on the guard roster. */
export interface GuardIdentity {
  employeeCode: string;
  displayName: string;
}

/**
 * Guard identification by face — `kiosk-guard-identify`, auth model D.
 *
 * IDENTIFICATION ONLY. It returns a name and a code and no session; the PIN step
 * below is what opens the shift. See the function's own header for why this repo
 * refuses to let a 1:N face match hand over session authority.
 *
 * `notAvailable` is the honest third outcome: if the function is not deployed on
 * this project yet the gate must fall back to typing the code, not sit on a dead
 * button. 404 (no such function) and 501 land here — and ONLY those. A 401 does
 * NOT: on a deployed project it means `verifyDevice` refused this tablet's
 * signature, or the device was revoked, and reporting that as "face sign-in is not
 * live yet" would hide a security event behind a feature notice.
 */
export type GuardIdentifyOutcome =
  | { kind: "identified"; identity: GuardIdentity }
  | { kind: "not_recognised" }
  | { kind: "not_available" }
  | { kind: "error"; detail: string };

export async function identifyGuardByFace(
  state: Pick<KioskDeviceState, "deviceId" | "secret">,
  descriptor: readonly number[],
  signal?: AbortSignal,
): Promise<GuardIdentifyOutcome> {
  const result = await deviceCall<IdentifyGuardResponse>(
    state,
    "kiosk-guard-identify",
    { descriptor: [...descriptor], mode: "face" },
    signal ? { signal } : {},
  );
  if (!result.ok) {
    if (result.error.status === 404 || result.error.status === 501) {
      return { kind: "not_available" };
    }
    return { kind: "error", detail: result.error.detail };
  }
  const code = result.data.employeeCode;
  const name = result.data.displayName;
  if (result.data.identified !== true || code === undefined) return { kind: "not_recognised" };
  return { kind: "identified", identity: { employeeCode: code, displayName: name ?? code } };
}

interface OpenSessionResponse {
  session_token?: string;
  session?: { token?: string };
  operator?: {
    operator_id?: string;
    display_name?: string;
    employee_code?: string;
    can_enrol_faces?: boolean;
  };
}

/** Guard sign-in: employee code + PIN → device-bound session. */
export async function openOperatorSession(
  state: KioskDeviceState,
  employeeCode: string,
  pin: string,
): Promise<KioskResult<KioskDeviceState>> {
  const result = await deviceCall<OpenSessionResponse>(state, "kiosk-operator-auth", {
    op: "open",
    device_id: state.deviceId,
    employee_code: employeeCode.trim().toUpperCase(),
    pin,
  });
  if (!result.ok) return result;
  const token = result.data.session_token ?? result.data.session?.token;
  if (token === undefined) {
    return {
      ok: false,
      error: { status: 500, code: "NO_SESSION", detail: "The server returned no session token." },
    };
  }
  const next: KioskDeviceState = {
    ...state,
    session: token,
    operatorName: result.data.operator?.display_name ?? employeeCode.trim().toUpperCase(),
    operatorCode: result.data.operator?.employee_code ?? employeeCode.trim().toUpperCase(),
    canEnrolFaces: result.data.operator?.can_enrol_faces === true,
  };
  saveDeviceState(next);
  return { ok: true, data: next };
}

/**
 * The device's own credential is dead — no request from this browser can ever
 * succeed again until it is re-paired.
 *
 * WHY THIS SET EXISTS
 * -------------------
 * A pairing code can be re-issued at any time, and `kiosk-device-activate` ROTATES
 * the device secret with no grace window ("there is no older install to keep
 * alive"). So the moment an admin issues a fresh code and somebody redeems it, every
 * other browser holding that device's old secret is bricked.
 *
 * Until this existed the kiosk had no idea. It showed
 *
 *     "That scan did not go through — Request signature does not verify."
 *
 * over the viewfinder and offered "Type my code instead", which posts through the
 * SAME dead signature and fails identically. There was no way out of that screen
 * except clearing site data, which nobody at a gate is going to do. The client hit
 * exactly this after a pairing code was re-issued.
 *
 * WHAT IS AND IS NOT IN HERE
 * --------------------------
 * `KIOSK_SIGNATURE_INVALID` / `KIOSK_SIGNATURE_STALE` — the secret or the clock is
 * wrong; retrying cannot fix either.
 * `KIOSK_DEVICE_UNKNOWN` / `KIOSK_DEVICE_SUSPENDED` — the row is gone or revoked.
 *
 * DELIBERATELY EXCLUDED: `KIOSK_NONCE_REPLAY` (409) is transient — the next request
 * mints a new nonce and works — and `KIOSK_DEVICE_NETWORK` (403) is a policy
 * refusal about WHERE the device is, not about its credential; forgetting the
 * pairing over either would throw away a perfectly good secret and make an admin
 * issue a code for nothing.
 */
const DEVICE_DEAD_CODES: ReadonlySet<string> = new Set([
  "KIOSK_SIGNATURE_INVALID",
  "KIOSK_SIGNATURE_STALE",
  "KIOSK_DEVICE_UNKNOWN",
  "KIOSK_DEVICE_SUSPENDED",
]);

/**
 * Is this failure fatal to the PAIRING (not just to the request)?
 *
 * Callers use it to drop the stored state and send the screen back to pairing,
 * which is the only action that can actually recover.
 */
export function isDevicePairingDead(code: string): boolean {
  return DEVICE_DEAD_CODES.has(code);
}

/**
 * An ADMIN's face opens the shift — `kiosk-face-signin`, no PIN.
 *
 * "The device photo verification should allow the admin to initiate the Gate link /
 *  kiosk link … if admin is showing its face."
 *
 * The outcomes are separated because the SCREEN has to behave differently for each,
 * and collapsing them into ok/not-ok is what would make this feel broken:
 *   * `opened`         — a session, identical in shape to the PIN path's.
 *   * `not_admin`      — recognised, and deliberately refused. Fall back to the PIN
 *                        WITHOUT an error: this is the normal path for a guard.
 *   * `not_recognised` — no confident match. Keep scanning, then let them type.
 *   * `not_available`  — the function is not deployed on this project. 404/501 ONLY;
 *                        a 401 must never land here, because on a deployed project
 *                        it means the device signature was refused and hiding that
 *                        behind "not live yet" would bury a security event.
 *   * `error`          — anything else, shown once.
 */
export type FaceSignInOutcome =
  | { kind: "opened"; state: KioskDeviceState }
  | { kind: "not_admin" }
  | { kind: "not_recognised" }
  | { kind: "not_available" }
  /** The pairing itself is dead — only re-pairing recovers. See `DEVICE_DEAD_CODES`. */
  | { kind: "unpaired"; detail: string }
  | { kind: "error"; detail: string };

interface FaceSignInResponse {
  session?: { token?: string };
  operator?: {
    operator_id?: string;
    display_name?: string;
    employee_code?: string;
    can_enrol_faces?: boolean;
  };
}

export async function openSessionByFace(
  state: KioskDeviceState,
  descriptor: readonly number[],
  liveness?: { score: number; model: string; framesAnalysed: number },
  signal?: AbortSignal,
): Promise<FaceSignInOutcome> {
  const result = await deviceCall<FaceSignInResponse>(
    state,
    "kiosk-face-signin",
    {
      device_id: state.deviceId,
      descriptor: [...descriptor],
      // OMITTED when unmeasurable, never 0: the server reads a PRESENT low score as
      // positive evidence of a photograph and refuses, so sending 0 for "could not
      // tell" would lock out an honest admin on a device that cannot measure.
      ...(liveness !== undefined && liveness.framesAnalysed >= 2 && liveness.score > 0
        ? {
            liveness: {
              score: liveness.score,
              model: liveness.model,
              frames_analysed: liveness.framesAnalysed,
            },
          }
        : {}),
    },
    signal ? { signal } : {},
  );

  if (!result.ok) {
    if (result.error.status === 404 || result.error.status === 501) {
      return { kind: "not_available" };
    }
    // Checked BEFORE the feature-specific codes: a dead signature means the server
    // never even reached the face logic, so reporting it as "not recognised" would
    // send the guard on a hunt for better lighting.
    if (isDevicePairingDead(result.error.code)) {
      return { kind: "unpaired", detail: result.error.detail };
    }
    if (result.error.code === "FACE_NOT_ADMIN") return { kind: "not_admin" };
    if (
      result.error.code === "KIOSK_FACE_NOT_RECOGNISED" ||
      result.error.code === "KIOSK_FACE_AMBIGUOUS"
    ) {
      return { kind: "not_recognised" };
    }
    return { kind: "error", detail: result.error.detail };
  }

  const token = result.data.session?.token;
  if (token === undefined) {
    return { kind: "error", detail: "The server returned no session token." };
  }
  // Same shape the PIN path writes, so everything downstream — the heartbeat, the
  // punch, the end-of-shift — cannot tell the two apart.
  const next: KioskDeviceState = {
    ...state,
    session: token,
    operatorName: result.data.operator?.display_name ?? "",
    operatorCode: result.data.operator?.employee_code ?? "",
    canEnrolFaces: result.data.operator?.can_enrol_faces === true,
  };
  saveDeviceState(next);
  return { kind: "opened", state: next };
}

/**
 * Keep the shift alive — `kiosk-operator-auth op=heartbeat`, an op that has been
 * deployed all along and that no client was calling.
 *
 * WHY THIS IS NOT OPTIONAL: the operator session token lives TEN MINUTES
 * (`SESSION_TTL_SECONDS = 600`), because with no session table the TTL is the only
 * revocation mechanism there is. A gate shift is eight hours. Without a refresh
 * the eleventh minute of every shift answers `KIOSK_OPERATOR_SESSION_INVALID` and
 * the guard has to sign in again — which is what the previous kiosk did, since it
 * never sent a heartbeat.
 *
 * `last_scan_at` is sent honestly: the server applies its own idle policy
 * (`kiosk.operator_idle_timeout_minutes`, 90) against it and may legitimately end
 * an abandoned session. That refusal is a 403, and the caller's job is to send the
 * guard back to sign-in rather than retry.
 */
export async function refreshOperatorSession(
  state: KioskDeviceState,
  activity: { scansThisSession: number; lastScanAt: string | null },
): Promise<KioskResult<KioskDeviceState>> {
  if (state.session === undefined) {
    return {
      ok: false,
      error: { status: 409, code: "NO_OPERATOR", detail: "No guard is signed in." },
    };
  }
  const result = await deviceCall<OpenSessionResponse>(
    state,
    "kiosk-operator-auth",
    {
      op: "heartbeat",
      device_id: state.deviceId,
      scans_this_session: activity.scansThisSession,
      ...(activity.lastScanAt !== null ? { last_scan_at: activity.lastScanAt } : {}),
    },
    { session: state.session },
  );
  if (!result.ok) return result;
  const token = result.data.session_token ?? result.data.session?.token;
  if (token === undefined) {
    return {
      ok: false,
      error: { status: 500, code: "NO_SESSION", detail: "The server returned no session token." },
    };
  }
  const next: KioskDeviceState = { ...state, session: token };
  saveDeviceState(next);
  return { ok: true, data: next };
}

export async function closeOperatorSession(state: KioskDeviceState): Promise<void> {
  if (state.session === undefined) return;
  await deviceCall(state, "kiosk-operator-auth", { op: "close", device_id: state.deviceId }, {
    session: state.session,
  });
}

/** What the punch endpoint answers with — the allow-listed fields only. */
export interface PunchOutcome {
  matched: boolean;
  displayName?: string;
  employeeCode?: string;
  photoUrl?: string | null;
  punchKind?: string;
  istTime?: string;
  /** Present on ambiguous matches: the guard picks from these. */
  guardConfirmOptions?: readonly { employeeCode: string; displayName: string }[];
  duplicateSuppressed?: boolean;
}

/**
 * Where the tablet is, for `attendance_punches.lat/lng/location_accuracy_m` and
 * the fence verdict. `kiosk-punch` treats it as optional and NEVER refuses a punch
 * for its absence, so a wall-mounted kiosk with no fix still records attendance.
 */
export interface PunchGeo {
  latitude: number;
  longitude: number;
  accuracyMetres?: number;
}

/** THE hot path: one face descriptor → the server's 1:N verdict. */
export function sendPunch(
  state: KioskDeviceState,
  descriptor: readonly number[],
  signal?: AbortSignal,
  /**
   * Optional by design. A gate punch used to carry NO location at all — the
   * columns existed and nothing filled them — so a guard's scan was
   * indistinguishable from a punch taken anywhere on Earth, while a web punch
   * from the same person carried coordinates. Passing it is how the audit trail
   * answers "where" for both paths.
   */
  geo?: PunchGeo | null,
): Promise<KioskResult<PunchOutcome>> {
  if (state.session === undefined) {
    return Promise.resolve({
      ok: false,
      error: { status: 409, code: "NO_OPERATOR", detail: "No guard is signed in." },
    });
  }
  return deviceCall<PunchOutcome>(
    state,
    "kiosk-punch",
    {
      clientEventId: crypto.randomUUID(),
      capturedAt: nowInstantIso(),
      descriptor: [...descriptor],
      // OMITTED, not null, when there is no fix: the request schema is `.strict()`
      // with `geo` optional, and an explicit `null` would fail validation and lose
      // the punch over a missing nicety.
      ...(geo ? { geo } : {}),
      mode: "face",
    },
    { session: state.session, ...(signal ? { signal } : {}) },
  );
}
