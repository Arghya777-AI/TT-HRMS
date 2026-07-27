/**
 * security.api.ts — E-18.2. The account-security surface, all of it real.
 *
 * Two different backends live behind this one screen, and keeping them apart is
 * the point:
 *
 *  A. GoTrue (Supabase Auth) — password and authenticator factors. These are not
 *     Postgres rows, so they do not go through the query layer: they are
 *     `supabase.auth.*` calls. They live HERE rather than in the page because a
 *     feature page never imports `@/lib/supabase` (architecture D-01).
 *     Verified against the live project (xfoeudhwxlbkkwetncjb):
 *       * `PUT /auth/v1/user` with a new password succeeds on the session alone —
 *         no reauthentication step is configured — and answers 422
 *         `same_password` when the new password equals the old one.
 *       * `POST /auth/v1/factors {factor_type:'totp'}` returns `totp.qr_code` as a
 *         RAW `<svg>` document (not a data: URL) plus `totp.secret` and
 *         `totp.uri`; the factor is created `unverified` and only counts once
 *         `challenge` + `verify` succeed.
 *       * `DELETE /auth/v1/factors/:id` removes it again.
 *     Both were exercised end to end and the probe factor was unenrolled.
 *
 *  B. Postgres — the things the app records ABOUT the account: passkeys
 *     (`webauthn_credentials`), auth events (`sessions_audit`), biometric consent
 *     and template state (`v_my_biometric_status`), and the employee's own
 *     face-enrolment requests (`face_enrolment_requests`). All four are read
 *     through the query layer, and all four are filtered to me EXPLICITLY —
 *     `sessions_audit` and `webauthn_credentials` both carry an admin read policy,
 *     so an HR administrator's own security page would otherwise list the whole
 *     company's sign-ins.
 *
 * What is deliberately absent:
 *   * No client write to `webauthn_credentials`: the table grants SELECT only and
 *     the `webauthn-register` edge function holds the pen. The screen lists
 *     passkeys and says where registration happens.
 *   * No "revoke this session" per row: GoTrue exposes no session inventory to a
 *     client. What it does expose is `signOut({scope:'others'})`, which is
 *     offered, and `sessions_audit` is presented as the auth EVENT log it is.
 *   * No face enrolment capture: that is a camera flow posting to the `face-enrol`
 *     edge function. Status is shown; nothing is faked.
 */
import { z } from "zod";
import type { Factor } from "@supabase/supabase-js";
import {
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  selectMany,
  selectOne,
} from "@/shared/api/query";
import { supabase } from "@/lib/supabase";

// =============================================================================
// A. GoTrue — password and authenticator factors
// =============================================================================

/**
 * A GoTrue failure, already in words a person can act on.
 *
 * `code` is kept so a caller can distinguish the cases that are not really
 * errors (`same_password`) from the ones that are.
 */
export class AuthActionError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "AuthActionError";
    this.code = code;
  }
}

interface GoTrueErrorish {
  message?: unknown;
  code?: unknown;
  status?: unknown;
}

function toAuthError(error: unknown, fallback: string): AuthActionError {
  if (error !== null && typeof error === "object") {
    const rec = error as GoTrueErrorish;
    const message = typeof rec.message === "string" && rec.message !== "" ? rec.message : fallback;
    const code = typeof rec.code === "string" ? rec.code : null;
    return new AuthActionError(message, code);
  }
  return new AuthActionError(fallback, null);
}

/** Set a new password on the signed-in account. Throws `AuthActionError`. */
export async function changePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error !== null) throw toAuthError(error, "The password could not be changed.");
}

/**
 * Sign out every OTHER session, leaving this one signed in.
 *
 * Called right after a password change: a password that has been shared or
 * shoulder-surfed is only really rotated once the old sessions are gone.
 */
export async function signOutOtherSessions(): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope: "others" });
  if (error !== null) throw toAuthError(error, "Other sessions could not be signed out.");
}

/** Every enrolled factor, verified or not. */
export async function listMfaFactors(): Promise<readonly Factor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error !== null) throw toAuthError(error, "Your authenticators could not be listed.");
  return data.all;
}

/** The session's assurance level — `aal2` once a factor has been used. */
export async function fetchAssuranceLevel(): Promise<{
  current: string | null;
  next: string | null;
}> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error !== null) throw toAuthError(error, "The session's assurance level is unavailable.");
  return { current: data.currentLevel, next: data.nextLevel };
}

export interface TotpEnrolment {
  readonly factorId: string;
  /** RAW `<svg>` markup from GoTrue — wrap it before putting it in an `img`. */
  readonly qrSvg: string;
  readonly secret: string;
  readonly uri: string;
}

/**
 * Start TOTP enrolment. The factor exists `unverified` from this moment, so a
 * dismissed dialog must call `unenrolFactor` — otherwise a dead half-enrolled
 * factor accumulates on the account.
 *
 * `issuer` is passed so the authenticator app shows "Tamarind Tree HRMS" rather
 * than the deployment host (live, the default was `localhost:3000`).
 */
export async function enrolTotp(friendlyName: string, issuer: string): Promise<TotpEnrolment> {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName,
    issuer,
  });
  if (error !== null) throw toAuthError(error, "The authenticator could not be set up.");
  return {
    factorId: data.id,
    qrSvg: data.totp.qr_code,
    secret: data.totp.secret,
    uri: data.totp.uri,
  };
}

/**
 * Verify the six-digit code and promote the factor to `verified`.
 *
 * `challengeAndVerify` is one round trip and also lifts the SESSION to aal2,
 * which is what the step-up-gated admin actions need.
 */
export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
  if (error !== null) throw toAuthError(error, "That code was not accepted.");
}

/** Remove a factor (enrolled or half-enrolled). */
export async function unenrolFactor(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error !== null) throw toAuthError(error, "The authenticator could not be removed.");
}

/**
 * A raw `<svg>` document is not a valid `img` source; percent-encoding it into a
 * `data:` URL is, and it keeps the QR out of the DOM as markup — no
 * `dangerouslySetInnerHTML` on a server-supplied string.
 */
export function qrSvgToDataUrl(svg: string): string {
  return `data:image/svg+xml;utf-8,${encodeURIComponent(svg)}`;
}

// =============================================================================
// B. Postgres — what the app records about this account
// =============================================================================

export const WEBAUTHN_TABLE = "webauthn_credentials";
export const SESSIONS_AUDIT_TABLE = "sessions_audit";
export const BIOMETRIC_STATUS_VIEW = "v_my_biometric_status";
export const FACE_ENROLMENT_REQUESTS_TABLE = "face_enrolment_requests";

export const passkeySchema = z.object({
  id: dbUuid,
  device_label: z.string().nullable(),
  purpose: z.string(),
  transports: z.array(z.string()).nullable(),
  backup_eligible: z.boolean(),
  last_used_at: dbTimestampNullable,
  revoked_at: dbTimestampNullable,
  created_at: dbTimestamp,
});

export type Passkey = z.infer<typeof passkeySchema>;

/** My registered passkeys. SELECT-only for `authenticated` by design. */
export async function fetchMyPasskeys(
  profileId: string,
  signal?: AbortSignal,
): Promise<Passkey[]> {
  return selectMany(WEBAUTHN_TABLE, passkeySchema, {
    columns:
      "id, device_label, purpose, transports, backup_eligible, last_used_at, revoked_at, created_at",
    filters: [eq("profile_id", profileId)],
    order: [{ column: "created_at", ascending: false }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

/** `ck_sessions_audit__event` (migration 004). */
export const sessionEventSchema = z.enum([
  "login_success",
  "login_failed",
  "logout",
  "token_refresh",
  "password_reset_requested",
  "password_changed",
  "passkey_registered",
  "passkey_used",
  "mfa_challenge",
  "session_revoked",
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionAuditSchema = z.object({
  id: dbUuid,
  event: sessionEventSchema,
  auth_method: z.string().nullable(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  device_id: z.string().nullable(),
  failure_reason: z.string().nullable(),
  recorded_at: dbTimestamp,
});

export type SessionAuditEntry = z.infer<typeof sessionAuditSchema>;

/**
 * My own auth events, newest first.
 *
 * Written ONLY by the service-role paths (`auth-identify`, `webauthn-login`,
 * `kiosk-operator-auth`, `employee-account-create`) — a plain password sign-in
 * goes straight to GoTrue and records nothing here, so this list can legitimately
 * be shorter than the number of times you have signed in. The screen says so.
 */
export async function fetchMySessionEvents(
  profileId: string,
  signal?: AbortSignal,
): Promise<SessionAuditEntry[]> {
  return selectMany(SESSIONS_AUDIT_TABLE, sessionAuditSchema, {
    columns: "id, event, auth_method, ip, user_agent, device_id, failure_reason, recorded_at",
    filters: [eq("profile_id", profileId)],
    order: [{ column: "recorded_at", ascending: false }],
    limit: 25,
    ...(signal ? { signal } : {}),
  });
}

export const biometricStatusSchema = z.object({
  modality: z.string(),
  granted: z.boolean(),
  granted_at: dbTimestampNullable,
  withdrawn_at: dbTimestampNullable,
  face_template_active: z.boolean(),
  face_template_version: z.number().int().nullable(),
  face_enrolled_at: dbTimestampNullable,
});

export type BiometricStatus = z.infer<typeof biometricStatusSchema>;

/**
 * Consent + template state for me.
 *
 * `null` is a REAL state, not an error: the view selects FROM
 * `secure.biometric_consents`, so an employee with no consent row has no row here
 * even if a face template exists. Live, that is the case for the demo staff, and
 * the page says "no consent recorded" instead of "not enrolled".
 */
export async function fetchMyBiometricStatus(
  signal?: AbortSignal,
): Promise<BiometricStatus | null> {
  return selectOne(BIOMETRIC_STATUS_VIEW, biometricStatusSchema, [], {
    columns:
      "modality, granted, granted_at, withdrawn_at, face_template_active, " +
      "face_template_version, face_enrolled_at",
    order: [{ column: "granted_at", ascending: false }],
    ...(signal ? { signal } : {}),
  });
}

export const faceEnrolmentRequestSchema = z.object({
  id: dbUuid,
  requested_at: dbTimestamp,
  requested_via: z.string(),
  quality_score: dbNumericNullable,
  status: z.string(),
  reviewed_at: dbTimestampNullable,
  reviewed_by: dbUuidNullable,
  review_comment: z.string().nullable(),
});

export type FaceEnrolmentRequest = z.infer<typeof faceEnrolmentRequestSchema>;

/** My face-enrolment requests, newest first (self-readable by RLS P1). */
export async function fetchMyFaceEnrolmentRequests(
  employeeId: string,
  signal?: AbortSignal,
): Promise<FaceEnrolmentRequest[]> {
  return selectMany(FACE_ENROLMENT_REQUESTS_TABLE, faceEnrolmentRequestSchema, {
    columns:
      "id, requested_at, requested_via, quality_score, status, reviewed_at, reviewed_by, review_comment",
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "requested_at", ascending: false }],
    limit: 10,
    ...(signal ? { signal } : {}),
  });
}
