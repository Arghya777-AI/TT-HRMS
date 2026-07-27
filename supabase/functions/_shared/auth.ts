/**
 * _shared/auth.ts — lifecycle steps 4 and 5 for all six auth models of
 * spec-architecture §4:
 *
 *   U    user JWT, capability re-derived server-side   → `verifyUser` + `requireCapDb`
 *   U+   U plus MFA step-up (`aal2`, 15 min)           → `requireCapWithStepUp`
 *   D    kiosk device HMAC                             → `verifyDevice`
 *   D+O  D plus an open operator (guard) session       → `requireOperatorSession`
 *   C    cron secret, constant-time                    → `verifyCron`
 *   T    single-use signed token in the body           → owned by `esign-flow`
 *
 * Rules that are load-bearing:
 *   - Capabilities and roles come from the DATABASE (`public.user_roles` +
 *     `public.role_capabilities` via `app.has_cap()`, migration 050), never from
 *     the request. A JWT claim saying `role: admin` means nothing here, and the
 *     synchronous `requireCap` matrix below is a documented fallback only.
 *   - The kiosk tablet is not a database user and holds no DB credential. It
 *     proves possession of a device secret per request and nothing more.
 *   - Every comparison of a secret uses `constantTimeEqual`.
 */

import type { Sql } from "./deps.ts";
import {
  APP_ROLES,
  type AppRole,
  clientIpFrom,
  firstRow,
  serviceClient,
  sql as sqlHandle,
} from "./db.ts";
import { conflict, forbidden, problem, serverError, unauthorized } from "./errors.ts";
import {
  epochSeconds,
  fromEpochSeconds,
  nowIso,
  parseFlexibleInstant,
  secondsBetween,
  toIso,
} from "./datetime.ts";

// ── Crypto primitives ───────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** Length-safe, timing-safe comparison of two strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  // Compare a fixed number of bytes so the loop count never depends on content.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  return atob(padded);
}

// ═════════════════════════════════════════════════════════════════════════════
// U / U+ — user JWT
// ═════════════════════════════════════════════════════════════════════════════

export interface AuthContext {
  /** The verified bearer token. Pass to `asCaller()` when RLS should apply. */
  token: string;
  /** `profiles.id` = `auth.users.id`. This is `app.actor_id`. */
  userId: string;
  email: string;
  fullName: string;
  /** NULL for a login with no employee record yet (pre-joining accounts). */
  employeeId: string | null;
  employeeCode: string | null;
  displayName: string | null;
  companyId: string | null;
  locationId: string | null;
  departmentId: string | null;
  employmentStatus: string | null;
  /** Live grants from `public.user_roles` (revoked rows excluded). */
  roles: AppRole[];
  /** Highest live role, for `audit_log.actor_role` and cheap tier checks. */
  role: AppRole;
  /** Supabase assurance level: `aal2` once TOTP has been presented. */
  aal: string;
  /** Authentication methods with the instant each was satisfied. */
  amr: { method: string; timestamp: number }[];
  mustChangePassword: boolean;
}

interface JwtPayload {
  sub?: string;
  aal?: string;
  amr?: { method?: string; timestamp?: number }[];
  session_id?: string;
  exp?: number;
}

/** Payload of an ALREADY-VERIFIED token. Never call this on an unverified one. */
function decodeJwtPayload(token: string): JwtPayload {
  const part = token.split(".")[1];
  if (part === undefined) return {};
  try {
    return JSON.parse(base64UrlDecode(part)) as JwtPayload;
  } catch {
    return {};
  }
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : (match[1] as string).trim();
}

function highestRole(roles: readonly AppRole[]): AppRole {
  for (const candidate of ["super_admin", "admin", "manager", "employee"] as const) {
    if (roles.includes(candidate)) return candidate;
  }
  return "employee";
}

/**
 * Lifecycle step 4 for auth models U / U+.
 *
 * The signature is verified by the Auth server (`auth.getUser`), then identity,
 * employment and roles are read from the database in one round-trip. A token
 * that verifies but has no `profiles` row, or whose profile is deactivated, is
 * not authenticated here — a departed employee's unexpired JWT must not work.
 */
export async function verifyUser(req: Request): Promise<AuthContext> {
  const token = bearerToken(req);
  if (token === null) {
    throw unauthorized("Sign in to continue.", "MISSING_BEARER_TOKEN");
  }

  const { data, error } = await serviceClient().auth.getUser(token);
  if (error !== null || data.user === null) {
    throw unauthorized("Your session is not valid. Sign in again.", "INVALID_TOKEN", { cause: error });
  }

  const rows = await sqlHandle()`
    SELECT p.id,
           p.email,
           p.full_name,
           p.is_active,
           p.must_change_password,
           e.id                  AS employee_id,
           e.employee_code,
           e.display_name,
           e.company_id,
           e.location_id,
           e.department_id,
           e.employment_status::text AS employment_status,
           COALESCE(
             (SELECT array_agg(DISTINCT ur.role::text)
                FROM public.user_roles ur
               WHERE ur.user_id = p.id AND ur.revoked_at IS NULL),
             '{}'::text[]
           )                     AS roles
      FROM public.profiles p
      LEFT JOIN public.employees e
             ON e.profile_id = p.id AND e.deleted_at IS NULL
     WHERE p.id = ${data.user.id}::uuid
     LIMIT 1
  `;

  const row = firstRow(rows as unknown as Record<string, unknown>[]);
  if (row === null) {
    // Verified token, no profile: the account was never provisioned in HRMS.
    throw unauthorized("This account is not set up in HRMS.", "PROFILE_MISSING");
  }
  if (row.is_active !== true) {
    throw forbidden("This account has been deactivated.", "ACCOUNT_DISABLED");
  }

  const roles = ((row.roles as string[] | null) ?? []).filter((r): r is AppRole =>
    (APP_ROLES as readonly string[]).includes(r)
  );
  const payload = decodeJwtPayload(token);

  return {
    token,
    userId: row.id as string,
    email: row.email as string,
    fullName: row.full_name as string,
    employeeId: (row.employee_id as string | null) ?? null,
    employeeCode: (row.employee_code as string | null) ?? null,
    displayName: (row.display_name as string | null) ?? null,
    companyId: (row.company_id as string | null) ?? null,
    locationId: (row.location_id as string | null) ?? null,
    departmentId: (row.department_id as string | null) ?? null,
    employmentStatus: (row.employment_status as string | null) ?? null,
    roles,
    role: highestRole(roles),
    aal: payload.aal ?? "aal1",
    amr: (payload.amr ?? []).map((entry) => ({
      method: entry.method ?? "unknown",
      timestamp: entry.timestamp ?? 0,
    })),
    mustChangePassword: row.must_change_password === true,
  };
}

// ── Roles and capabilities ──────────────────────────────────────────────────

const ROLE_RANK: Record<AppRole, number> = {
  employee: 1,
  manager: 2,
  admin: 3,
  super_admin: 4,
};

/** True when the caller holds `role` or anything above it (mirrors `app.has_role`). */
export function hasRole(auth: AuthContext, role: AppRole): boolean {
  return ROLE_RANK[auth.role] >= ROLE_RANK[role];
}

export function requireRole(auth: AuthContext, role: AppRole): void {
  if (!hasRole(auth, role)) {
    throw forbidden(`This action needs the ${role.replace("_", " ")} role.`, "ROLE_REQUIRED");
  }
}

/**
 * Capabilities the caller's DB roles imply.
 *
 * AUTHORITY: `public.role_capabilities` + `app.has_cap()` (migration 050) are
 * the real authorisation model — use `hasCapDb()` / `requireCapDb()` below,
 * which ask the database. Authority must never come from the request, and it
 * should not come from TypeScript either: a capability change is a data change.
 *
 * The sets below remain ONLY as a synchronous fallback for code paths that have
 * no SQL connection in hand (and for fast local reasoning). They mirror the
 * seed in migration 050; if the two ever disagree, the DB wins. Prefer the
 * async DB check in every new function.
 */
const SUPER_ADMIN_ONLY_CAPS: ReadonlySet<string> = new Set([
  "audit.export",
  "biometric.template.purge",
  "employee.hard_delete",
  "employee.data.purge",
  "role.grant",
  "role.revoke",
  "kiosk.device.secret.rotate",
  "settings.security.write",
  "ai.budget.override",
  // These three were missing while the comment above claimed the set mirrors
  // migration 050 §2. No live caller was affected (every function uses
  // requireCapDb / requireCapWithStepUp / hasCapDb, i.e. app.has_cap()), but the
  // synchronous fallback answered TRUE for a plain admin asking for
  // `attendance.lock.override` — permission to write into a locked payroll
  // period. A fallback that is wrong in the permissive direction is worse than
  // no fallback, so the list is now complete: all 12 super_admin rows of 050.
  "admin.super",
  "payroll.run.delete",
  "attendance.lock.override",
]);

/** Capabilities every active employee holds for their own data. */
const EMPLOYEE_CAPS: ReadonlySet<string> = new Set([
  "me.view",
  "ai.ask.self",
  "attendance.regularization.submit",
  "attendance.punch.web",
  "leave.request.submit",
  "leave.request.withdraw",
  "claim.submit",
  "document.self.view",
  "profile.self.update",
  "biometric.consent.manage",
]);

/** Beyond `.team`-scoped caps and everything an employee holds. */
const MANAGER_CAPS: ReadonlySet<string> = new Set([
  "team.view",
  "ai.ask.team",
  "roster.publish",
  "attendance.regularization.approve",
  "leave.request.approve",
  "claim.approve",
]);

function isSelfCap(cap: string): boolean {
  return cap.startsWith("me.") || cap.endsWith(".self") || cap.endsWith(".own");
}

export function hasCap(auth: AuthContext, cap: string): boolean {
  if (auth.roles.includes("super_admin")) return true;
  if (SUPER_ADMIN_ONLY_CAPS.has(cap)) return false;
  if (auth.roles.includes("admin")) return true;
  if (auth.roles.includes("manager")) {
    if (cap.endsWith(".team") || MANAGER_CAPS.has(cap)) return true;
  }
  return isSelfCap(cap) || EMPLOYEE_CAPS.has(cap);
}

/**
 * Lifecycle step 5, synchronous fallback. 403, not 404: the caller may know the
 * endpoint exists — it is row EXISTENCE that must never be leaked by a status
 * code, not endpoint existence.
 *
 * Prefer `requireCapDb()` — it consults `role_capabilities`, so revoking a
 * capability takes effect without a redeploy.
 */
export function requireCap(auth: AuthContext, cap: string): void {
  if (!hasCap(auth, cap)) {
    throw forbidden(`You do not have permission for this action (${cap}).`, "CAP_REQUIRED");
  }
}

/**
 * Lifecycle step 5, authoritative. Resolves the capability against
 * `public.role_capabilities` via `app.has_cap()` (migration 050) inside the
 * caller's own request context, so a capability revoked a minute ago is already
 * in force.
 *
 * `sql` is the postgres.js handle from `_shared/db.ts` (`sql()` or the `tx`
 * inside `withContext`). Pass the transaction when the check guards a write, so
 * the authorisation decision and the write share one snapshot.
 */
export async function hasCapDb(sql: Sql, auth: AuthContext, cap: string): Promise<boolean> {
  // `app.has_cap()` resolves the caller through `app.ctx_actor_id()`, so the
  // actor must be in the session before the predicate runs. Two statements
  // cannot do it on the pool: `set_config(…, true)` is transaction-scoped and
  // each pooled statement is its own transaction. Hence one statement, with the
  // actor set in a MATERIALIZED CTE — `set_config` is VOLATILE, so the CTE can
  // never be inlined or reordered into the target list, and the target list is
  // evaluated per row the CTE has already produced.
  //
  // Safe to call with the `tx` from `withContext()` too: it re-sets the same
  // actor the context batch already set.
  const rows = await sql<{ allowed: boolean }[]>`
    WITH ctx AS MATERIALIZED (
      SELECT set_config('app.actor_id', ${auth.userId}, true) AS actor
    )
    SELECT app.has_cap(${cap}) AS allowed FROM ctx
  `;
  // A NULL from has_cap (no session context) is a denial, never a pass.
  return rows[0]?.allowed === true;
}

/** Throwing form of `hasCapDb`. */
export async function requireCapDb(sql: Sql, auth: AuthContext, cap: string): Promise<void> {
  if (!(await hasCapDb(sql, auth, cap))) {
    throw forbidden(`You do not have permission for this action (${cap}).`, "CAP_REQUIRED");
  }
}

/**
 * Lifecycle step 5, complete: the capability AND the step-up it demands, both
 * decided by `public.role_capabilities`.
 *
 * This is the call every U / U+ function should make. It removes the second
 * hard-coded list — "which actions need aal2" — from TypeScript entirely:
 * `requires_step_up` on the capability row is the whole answer, so adding a
 * step-up requirement is a data change, not a redeploy of 27 functions.
 */
export async function requireCapWithStepUp(sql: Sql, auth: AuthContext, cap: string): Promise<void> {
  await requireCapDb(sql, auth, cap);
  if (await capRequiresStepUp(sql, cap)) requireStepUp(auth);
}

/**
 * Does this capability demand an MFA step-up as well as the role? Read from
 * `role_capabilities.requires_step_up` so the step-up list is configuration,
 * not a second hard-coded list that can drift from the first.
 */
export async function capRequiresStepUp(sql: Sql, cap: string): Promise<boolean> {
  const rows = await sql<{ required: boolean }[]>`
    SELECT app.cap_requires_step_up(${cap}) AS required
  `;
  return rows[0]?.required === true;
}

/** Step-up window: `aal2` must have been satisfied within 15 minutes (§6). */
export const STEP_UP_MAX_AGE_SECONDS = 15 * 60;

const MFA_METHODS: ReadonlySet<string> = new Set(["totp", "mfa", "webauthn", "aal2", "otp"]);

/**
 * Auth model U+. Required for role grant/revoke, payroll publish, audit export,
 * biometric purge, bulk salary reveal, employee hard-delete and kiosk device
 * secret rotation.
 */
export function requireStepUp(auth: AuthContext): void {
  if (auth.aal !== "aal2") {
    throw forbidden(
      "Confirm your identity with your authenticator app to continue.",
      "MFA_STEP_UP_REQUIRED",
    );
  }
  const satisfiedAt = auth.amr
    .filter((entry) => MFA_METHODS.has(entry.method))
    .reduce((latest, entry) => Math.max(latest, entry.timestamp), 0);
  if (satisfiedAt === 0) return; // aal2 with no timestamped method: trust the claim.
  const ageSeconds = epochSeconds() - satisfiedAt;
  if (ageSeconds > STEP_UP_MAX_AGE_SECONDS) {
    throw forbidden(
      "Your step-up confirmation has expired. Confirm again to continue.",
      "MFA_STEP_UP_STALE",
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// D — kiosk device HMAC
// ═════════════════════════════════════════════════════════════════════════════

/** Maximum |device clock − server clock| for a signature to be accepted (§4). */
export const DEVICE_MAX_SKEW_SECONDS = 120;

export interface KioskDevice {
  id: string;
  deviceCode: string;
  label: string;
  locationId: string;
  requireOperator: boolean;
  minMatchConfidence: number;
  maxOfflineQueue: number;
  storedClockSkewSeconds: number;
  storedAppVersion: string | null;
  /**
   * The circle a punch from this device is judged against, resolved HERE so every
   * kiosk function sees the same fence.
   *
   * `kiosk_devices.allowed_geofence` wins when set — a tablet is bolted to one
   * gate, so a per-device fence can be tighter than the venue's — and it falls
   * back to the device's location (`locations.lat/lng/geofence_radius_m`). NULL
   * when neither is configured, which is the current state of this project: the
   * venue row has no coordinates, so `geofence_ok` is NULL on every punch.
   *
   * `null` here means "no fence to judge against", never "outside".
   */
  geofence: { lat: number; lng: number; radiusM: number } | null;
}

export interface DeviceAuth {
  device: KioskDevice;
  /** Raw shared secret in force for this request. Never logged, never returned. */
  secret: string;
  /** Client-declared instant, already skew-checked. Metadata only (INV-1). */
  deviceTimestamp: string;
  /** Signed skew in seconds: positive when the device clock runs ahead. */
  clockSkewSeconds: number;
  nonce: string;
}

/**
 * The string that is signed, single-sourced so the tablet SDK, the four kiosk
 * functions and the tests cannot drift:
 *
 *     HMAC-SHA256(device_secret, `${timestamp}.${nonce}.${rawBody}`)  → lowercase hex
 *
 * Method and path are deliberately NOT in the payload: the nonce is single-use
 * per device (`secure.kiosk_nonces`, PK `(device_id, nonce)`), so a signature
 * lifted from one endpoint cannot be replayed against another — the second
 * request burns on nonce reuse and returns 409. If a future client needs
 * per-endpoint binding (spec-kiosk §5.3 canonicalises method + path +
 * body_sha256), change it HERE and nowhere else.
 */
export function deviceCanonicalString(timestamp: string, nonce: string, rawBody: string): string {
  return `${timestamp}.${nonce}.${rawBody}`;
}

/** Parse `x-timestamp`: ISO-8601, or epoch seconds/milliseconds. */
const parseDeviceTimestamp = parseFlexibleInstant;

/** postgres.js hydrates `timestamptz` to `Date` and `numeric` to `string`. */
interface DeviceRow {
  id: string;
  device_code: string;
  label: string;
  location_id: string;
  is_active: boolean;
  revoked_at: Date | string | null;
  require_operator: boolean;
  min_match_confidence: string;
  max_offline_queue: number;
  clock_skew_seconds: number;
  app_version: string | null;
  /** Resolved in SQL: the device's own fence, else its location's. `numeric` → string. */
  fence_lat: string | null;
  fence_lng: string | null;
  fence_radius_m: string | null;
  ip_ok: boolean;
  has_secret_row: boolean;
  rotation_grace_until: Date | string | null;
  vault_secret_name: string;
  secret_current: string | null;
  secret_previous: string | null;
}

/**
 * Assemble the fence, or nothing.
 *
 * BOTH coordinates must be readable numbers. A half-configured fence (a latitude
 * with no longitude) is not a location on Earth, and treating the missing half as
 * 0 would place the venue in the Gulf of Guinea and mark every real punch as
 * outside — a false accusation, which is exactly what the NULL exists to prevent.
 * The radius is allowed to fall back because `locations.geofence_radius_m` is NOT
 * NULL DEFAULT 300 and a missing one is a readable default, not a wrong place.
 */
function kioskFenceFromRow(row: DeviceRow): KioskDevice["geofence"] {
  if (row.fence_lat === null || row.fence_lng === null) return null;
  const lat = Number(row.fence_lat);
  const lng = Number(row.fence_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const radius = row.fence_radius_m === null ? 300 : Number(row.fence_radius_m);
  return { lat, lng, radiusM: Number.isFinite(radius) && radius > 0 ? radius : 300 };
}

/**
 * Where a device's raw HMAC secret lives (migration 050 §5/§7).
 *
 * `kiosk_devices.vault_secret_name` names the Vault entry; rotation writes the
 * new value under the same name and keeps `<name>_prev` readable until
 * `secure.kiosk_device_secrets.rotation_grace_until`. The Argon2id hash in
 * `secure.kiosk_device_secrets` is the presence/rotation record only — a one-way
 * hash cannot compute an HMAC, so it is never a verification input here.
 *
 * The `COALESCE` is the back-fill convention from migration 050 §7, kept so a
 * device row written before that migration still resolves.
 */
export const VAULT_SECRET_PREVIOUS_SUFFIX = "_prev";

/**
 * Lifecycle step 4 for auth models D and D+O.
 *
 * Order is security-critical:
 *   1. headers present            → 401
 *   2. clock skew ≤ 120s          → 401 (cheap, no DB)
 *   3. device active + IP allowed → 401 / 403
 *   4. signature verifies         → 401
 *   5. nonce claimed              → 409
 * The nonce is burned only AFTER the signature verifies, otherwise an
 * unauthenticated caller could exhaust a device's nonce space at will.
 *
 * `rawBody` must be the exact string from `validate.readRawBody(req)` — parsing
 * and re-serialising the JSON changes the bytes and breaks the signature.
 */
export async function verifyDevice(req: Request, rawBody: string, client: Sql = sqlHandle()): Promise<DeviceAuth> {
  const deviceId = (req.headers.get("x-device-id") ?? "").trim();
  const signature = (req.headers.get("x-signature") ?? "").trim().toLowerCase();
  const timestamp = (req.headers.get("x-timestamp") ?? "").trim();
  const nonce = (req.headers.get("x-nonce") ?? "").trim();

  if (deviceId === "" || signature === "" || timestamp === "" || nonce === "") {
    throw unauthorized(
      "This device is not signing its requests correctly.",
      "KIOSK_SIGNATURE_INVALID",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(signature)) {
    throw unauthorized("Malformed request signature.", "KIOSK_SIGNATURE_INVALID");
  }
  if (nonce.length < 16 || nonce.length > 120) {
    throw unauthorized("Malformed request nonce.", "KIOSK_SIGNATURE_INVALID");
  }

  const declared = parseDeviceTimestamp(timestamp);
  if (declared === null) {
    throw unauthorized("Malformed request timestamp.", "KIOSK_SIGNATURE_INVALID");
  }
  const serverNow = nowIso();
  const clockSkewSeconds = secondsBetween(serverNow, declared);
  if (Math.abs(clockSkewSeconds) > DEVICE_MAX_SKEW_SECONDS) {
    throw unauthorized(
      `Device clock is ${clockSkewSeconds}s from server time; re-sync and retry.`,
      "KIOSK_SIGNATURE_STALE",
    );
  }

  // Sanitised: this value reaches a `::inet` cast, and an unparseable one would
  // abort the statement rather than fail the check.
  const ip = clientIpFrom(req);
  const rows = await client`
    SELECT d.id,
           d.device_code,
           d.label,
           d.location_id,
           d.is_active,
           d.revoked_at,
           d.require_operator,
           d.min_match_confidence,
           d.max_offline_queue,
           d.clock_skew_seconds,
           d.app_version,
           -- THE FENCE, resolved once. The device's own allowed_geofence (jsonb,
           -- CHECKed to carry lat/lng/radius_m) takes precedence over the venue,
           -- because a tablet is fixed to one gate and can be fenced more tightly
           -- than the whole property. Text-extract then cast, so a string value in
           -- the jsonb fails the cast loudly instead of coercing to nonsense.
           -- NO BACKTICKS IN THIS COMMENT: it lives inside a template literal, and
           -- a backtick here ends the SQL string mid-statement. That is not a style
           -- rule — it is a syntax error that takes device auth down with it.
           COALESCE((d.allowed_geofence ->> 'lat')::numeric,  loc.lat)  AS fence_lat,
           COALESCE((d.allowed_geofence ->> 'lng')::numeric,  loc.lng)  AS fence_lng,
           COALESCE((d.allowed_geofence ->> 'radius_m')::numeric,
                    loc.geofence_radius_m)                              AS fence_radius_m,
           (
             ${ip}::text IS NULL
             OR d.allowed_ip_cidrs IS NULL
             OR EXISTS (SELECT 1 FROM unnest(d.allowed_ip_cidrs) c WHERE ${ip}::inet <<= c)
           )                                          AS ip_ok,
           (s.secret_hash IS NOT NULL)                AS has_secret_row,
           s.rotation_grace_until,
           v.name                                     AS vault_secret_name,
           app.secret(v.name)                         AS secret_current,
           -- Only decrypt the outgoing secret while a rotation grace window is
           -- actually open. Outside one it must not even be readable here.
           CASE WHEN s.rotation_grace_until > now()
                THEN app.secret(v.name || ${VAULT_SECRET_PREVIOUS_SUFFIX})
           END                                        AS secret_previous
      FROM public.kiosk_devices d
      CROSS JOIN LATERAL (
        SELECT COALESCE(d.vault_secret_name, 'kiosk_device_secret:' || d.id::text) AS name
      ) v
      LEFT JOIN secure.kiosk_device_secrets s ON s.device_id = d.id
      -- LEFT, not INNER: location_id is NOT NULL, but a soft-deleted location must
      -- not make a paired device unauthenticatable. It loses its fence, which
      -- degrades to geofence_ok = NULL, not to a refused punch.
      LEFT JOIN public.locations loc
             ON loc.id = d.location_id
            AND loc.deleted_at IS NULL
     WHERE d.id = ${deviceId}::uuid
       AND d.deleted_at IS NULL
     LIMIT 1
  `;

  const row = firstRow(rows as unknown as DeviceRow[]);
  if (row === null) {
    throw unauthorized("This device is not paired.", "KIOSK_DEVICE_UNKNOWN");
  }
  if (row.revoked_at !== null || row.is_active !== true) {
    throw forbidden("This device has been suspended.", "KIOSK_DEVICE_SUSPENDED");
  }
  if (row.ip_ok !== true) {
    throw forbidden("This device is calling from an unapproved network.", "KIOSK_GEOFENCE_VIOLATION");
  }

  const candidates: string[] = [];
  if (typeof row.secret_current === "string" && row.secret_current !== "") {
    candidates.push(row.secret_current);
  }
  const graceOpen = row.rotation_grace_until !== null &&
    secondsBetween(serverNow, row.rotation_grace_until) > 0;
  if (graceOpen && typeof row.secret_previous === "string" && row.secret_previous !== "") {
    candidates.push(row.secret_previous);
  }
  if (candidates.length === 0) {
    // Nothing in Vault under `vault_secret_name`, so no HMAC can be verified for
    // this device: it was never activated, or activation failed to write the raw
    // secret. `kiosk-device-activate` owns that write (migration 050 §5). A
    // present `secret_hash` with an absent Vault entry is exactly this case, and
    // it is a re-pair, not a 500.
    throw unauthorized(
      "This device needs to be re-paired before it can be used.",
      "KIOSK_DEVICE_SECRET_UNAVAILABLE",
    );
  }

  const expectedFor = deviceCanonicalString(timestamp, nonce, rawBody);
  let matched: string | null = null;
  for (const candidate of candidates) {
    const computed = await hmacSha256Hex(candidate, expectedFor);
    if (constantTimeEqual(computed, signature)) {
      matched = candidate;
      break;
    }
  }
  if (matched === null) {
    throw unauthorized("Request signature does not verify.", "KIOSK_SIGNATURE_INVALID");
  }

  // Burn the nonce. PK (device_id, nonce) makes this the replay check: a second
  // arrival while the row is live claims nothing and 409s.
  //
  // `DO UPDATE … WHERE expires_at < now()` rather than `DO NOTHING`: the row's
  // 10-minute TTL is longer than the 120-second skew window, so once a row has
  // expired the same nonce value can no longer be part of a viable replay, and
  // a device that recycles nonce values must not be locked out by a row nobody
  // has reaped yet. `secure.kiosk_nonces` has no reaper — see the DB gap note.
  const claimed = await client`
    INSERT INTO secure.kiosk_nonces (device_id, nonce)
    VALUES (${row.id}::uuid, ${nonce})
    ON CONFLICT (device_id, nonce) DO UPDATE
      SET seen_at    = now(),
          expires_at = now() + interval '10 minutes'
      WHERE secure.kiosk_nonces.expires_at < now()
    RETURNING nonce
  `;
  if ((claimed as unknown as unknown[]).length === 0) {
    throw conflict("This request was already processed.", "KIOSK_NONCE_REPLAY");
  }

  return {
    device: {
      id: row.id,
      deviceCode: row.device_code,
      label: row.label,
      locationId: row.location_id,
      requireOperator: row.require_operator,
      minMatchConfidence: Number(row.min_match_confidence),
      maxOfflineQueue: row.max_offline_queue,
      storedClockSkewSeconds: row.clock_skew_seconds,
      storedAppVersion: row.app_version,
      geofence: kioskFenceFromRow(row),
    },
    secret: matched,
    deviceTimestamp: toIso(declared),
    clockSkewSeconds,
    nonce,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// D+O — operator (guard) session
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ⚠ DB GAP: spec-kiosk §5.3 names a `kiosk_operator_session` table; migrations
 * 001–049 create `public.kiosk_operators` but no session table. The session is
 * therefore a STATELESS token, minted by `kiosk-operator-auth` and signed with
 * the DEVICE secret, so it is device-bound by construction and dies when the
 * secret rotates or the device is suspended. Every use still re-reads the
 * operator row, so deactivating a guard takes effect on the next request.
 *
 * Wire format: `v1.<base64url(json payload)>.<base64url(hex hmac)>`
 */
export const OPERATOR_SESSION_TTL_SECONDS = 90 * 60;

interface OperatorSessionPayload {
  sid: string;
  did: string;
  oid: string;
  /** Unix seconds. */
  exp: number;
  /** Unix seconds. */
  iat: number;
}

export interface OperatorSession {
  sessionId: string;
  operatorId: string;
  profileId: string;
  employeeId: string | null;
  displayName: string | null;
  employeeCode: string | null;
  canEnrolFaces: boolean;
  canManualPunch: boolean;
  expiresAt: string;
}

/** Issue a session token. Called only by `kiosk-operator-auth` after PIN/passkey verification. */
export async function mintOperatorSession(
  deviceSecret: string,
  input: { deviceId: string; operatorId: string; ttlSeconds?: number },
): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const nowSeconds = epochSeconds();
  const payload: OperatorSessionPayload = {
    sid: crypto.randomUUID(),
    did: input.deviceId,
    oid: input.operatorId,
    iat: nowSeconds,
    exp: nowSeconds + (input.ttlSeconds ?? OPERATOR_SESSION_TTL_SECONDS),
  };
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(await hmacSha256Hex(deviceSecret, `operator-session.${body}`));
  return {
    token: `v1.${body}.${signature}`,
    sessionId: payload.sid,
    expiresAt: toIso(fromEpochSeconds(payload.exp)),
  };
}

/**
 * Lifecycle step 4/5 for auth model D+O. Verifies the `x-operator-session`
 * token against the device secret, then re-reads the operator row so a
 * deactivated guard cannot keep punching with a live token.
 *
 * 409 (not 401) on failure, matching spec-kiosk §4.5
 * `KIOSK_OPERATOR_SESSION_INVALID` → the kiosk routes to K1 (guard sign-in)
 * rather than treating the device as unauthenticated.
 */
export async function requireOperatorSession(
  req: Request,
  deviceAuth: DeviceAuth,
  client: Sql = sqlHandle(),
): Promise<OperatorSession> {
  const raw = (req.headers.get("x-operator-session") ?? "").trim();
  if (raw === "") {
    throw conflict("A guard must be signed in on this kiosk.", "KIOSK_OPERATOR_SESSION_INVALID");
  }
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw conflict("Guard session is not valid.", "KIOSK_OPERATOR_SESSION_INVALID");
  }
  const [, body, signature] = parts as [string, string, string];

  const expected = base64UrlEncode(
    await hmacSha256Hex(deviceAuth.secret, `operator-session.${body}`),
  );
  if (!constantTimeEqual(expected, signature)) {
    throw conflict("Guard session is not valid.", "KIOSK_OPERATOR_SESSION_INVALID");
  }

  let payload: OperatorSessionPayload;
  try {
    payload = JSON.parse(base64UrlDecode(body)) as OperatorSessionPayload;
  } catch {
    throw conflict("Guard session is not valid.", "KIOSK_OPERATOR_SESSION_INVALID");
  }

  const nowSeconds = epochSeconds();
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    throw conflict("The guard session has ended. Sign in again.", "KIOSK_OPERATOR_SESSION_INVALID");
  }
  if (payload.did !== deviceAuth.device.id) {
    throw conflict("This guard session belongs to another kiosk.", "KIOSK_OPERATOR_SESSION_INVALID");
  }

  const rows = await client`
    SELECT o.id,
           o.profile_id,
           o.employee_id,
           o.can_enrol_faces,
           o.can_manual_punch,
           e.display_name,
           e.employee_code
      FROM public.kiosk_operators o
      LEFT JOIN public.employees e ON e.id = o.employee_id AND e.deleted_at IS NULL
     WHERE o.id = ${payload.oid}::uuid
       AND o.is_active
       AND (o.kiosk_device_id IS NULL OR o.kiosk_device_id = ${deviceAuth.device.id}::uuid)
     LIMIT 1
  `;
  const row = firstRow(rows as unknown as Record<string, unknown>[]);
  if (row === null) {
    throw conflict("This guard is no longer authorised on this kiosk.", "KIOSK_OPERATOR_SESSION_INVALID");
  }

  return {
    sessionId: payload.sid,
    operatorId: row.id as string,
    profileId: row.profile_id as string,
    employeeId: (row.employee_id as string | null) ?? null,
    displayName: (row.display_name as string | null) ?? null,
    employeeCode: (row.employee_code as string | null) ?? null,
    canEnrolFaces: row.can_enrol_faces === true,
    canManualPunch: row.can_manual_punch === true,
    expiresAt: toIso(fromEpochSeconds(payload.exp)),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// C — cron / service-role
// ═════════════════════════════════════════════════════════════════════════════

export interface CronAuth {
  via: "cron_secret" | "service_role";
}

/**
 * Auth model C. `pg_cron` + `pg_net` POST with `x-cron-secret` taken from
 * `app.secret('cron_secret')` (migration 041); the same value is the
 * `CRON_SECRET` function secret. Compared in constant time, and the failure
 * response says nothing about which half was wrong.
 */
export function verifyCron(req: Request): CronAuth {
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  const presented = req.headers.get("x-cron-secret") ?? "";
  if (expected === "") {
    throw serverError("cron", "Server misconfigured: CRON_SECRET is not set.", {
      code: "ENV_MISSING",
    });
  }
  if (presented !== "" && constantTimeEqual(expected, presented)) {
    return { via: "cron_secret" };
  }

  // A service-role bearer is the documented manual/backfill path (§4 "C = cron
  // secret … or service_role").
  const token = bearerToken(req);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (token !== null && serviceKey !== "" && constantTimeEqual(serviceKey, token)) {
    return { via: "service_role" };
  }

  throw unauthorized("This endpoint is for scheduled jobs only.", "CRON_AUTH_FAILED");
}

/** Guard for functions that must never be reachable by a browser at all. */
export function rejectBrowserOrigin(req: Request): void {
  if (req.headers.get("origin") !== null) {
    throw problem(403, "Forbidden", "This endpoint is not callable from a browser.", undefined, {
      code: "NOT_BROWSER_CALLABLE",
    });
  }
}
