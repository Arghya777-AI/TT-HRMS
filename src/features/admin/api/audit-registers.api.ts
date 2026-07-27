/**
 * audit-registers.api.ts — the three append-only registers the Audit console
 * reads that are NOT `audit_log`, plus the actor-name lookup every audit screen
 * needs. READS ONLY, by construction: `audit_log`, `audit_seals`,
 * `data_access_log` and `export_log` all have UPDATE/DELETE revoked from every
 * client role and a BEFORE trigger that raises 0A000 unconditionally (D-20), and
 * `sessions_audit` is written by edge functions with the service role.
 *
 * Split from `audit.api.ts` deliberately: that module owns `audit_log` and
 * `v_audit_trail_employee`, this one owns the sibling registers. Nothing here
 * duplicates a function that already lives there.
 *
 * Every table/column below was read out of the migrations, not assumed:
 *   * `sessions_audit`  — migration 004 §identity_core. Timestamp is
 *     `recorded_at`, NOT `occurred_at`. Actor is `profile_id`, and a failed
 *     login has NO profile_id at all — only `attempted_email`, because the
 *     whole point of the row is that the credential did not resolve to a user.
 *   * `audit_seals`     — migration 006 §3. `verification_result` is written by
 *     `cron-integrity` and is one of 'ok' | 'chain_broken' | 'not_verified'.
 *   * `export_log`      — migration 006 §3. RLS hides `subject = 'audit_log'`
 *     rows from a plain admin (`export_log__admin_read`), so an admin's register
 *     is legitimately shorter than a super-admin's. That is not an error state.
 *   * `system_health`   — migration 031. `component = 'integrity.audit_chain'`,
 *     `metric_name = 'chain_breaks'`, written by the nightly verify_chain task.
 */
import { z } from "zod";
import {
  dbDate,
  dbInt,
  dbIntNullable,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  gte,
  ilike,
  inList,
  lt,
  lte,
  neq,
  paginate,
  selectMany,
  type Cursor,
  type Filter,
  type Page,
} from "@/shared/api/query";

export const SESSIONS_AUDIT_TABLE = "sessions_audit";
export const AUDIT_SEALS_TABLE = "audit_seals";
export const EXPORT_LOG_TABLE = "export_log";
export const SYSTEM_HEALTH_TABLE = "system_health";
export const PROFILES_TABLE = "profiles";

// -----------------------------------------------------------------------------
// 1. Actor names — profile id → full name
// -----------------------------------------------------------------------------

/**
 * `audit_log.actor_id`, `data_access_log.actor_id`, `export_log.actor_id` and
 * `sessions_audit.profile_id` are all `public.profiles.id` (= `auth.users.id`),
 * confirmed by the `LEFT JOIN public.profiles p ON p.id = al.actor_id` inside
 * `v_audit_trail_employee`. `profiles__admin_read` lets an admin read them.
 */
export const actorProfileSchema = z.object({
  id: dbUuid,
  full_name: z.string(),
  email: z.string(),
  is_active: z.boolean(),
});
export type ActorProfile = z.infer<typeof actorProfileSchema>;

/** Resolve a batch of actor ids to names. Empty input never hits the network. */
export async function fetchActorNames(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, ActorProfile>> {
  if (ids.length === 0) return new Map();
  const rows = await selectMany(PROFILES_TABLE, actorProfileSchema, {
    filters: [inList("id", ids)],
    columns: "id,full_name,email,is_active",
    limit: ids.length,
    ...(signal ? { signal } : {}),
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/** One actor, for the User Activity Trail header. */
export async function fetchActorProfile(
  actorId: string,
  signal?: AbortSignal,
): Promise<ActorProfile | null> {
  const map = await fetchActorNames([actorId], signal);
  return map.get(actorId) ?? null;
}

/**
 * The people who could plausibly appear as an actor, for the filter picker.
 * Admin-readable, ordered by name; `is_active` is kept so a revoked account can
 * still be selected — the audit trail of a deactivated admin is exactly the
 * trail an auditor wants.
 */
export function fetchActorOptions(limit = 200, signal?: AbortSignal): Promise<ActorProfile[]> {
  return selectMany(PROFILES_TABLE, actorProfileSchema, {
    columns: "id,full_name,email,is_active",
    order: [{ column: "full_name", ascending: true }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. sessions_audit — /admin/audit/sessions
// -----------------------------------------------------------------------------

/** `ck_sessions_audit__event` — the DEPLOYED vocabulary, verbatim. */
export const sessionEventValues = [
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
] as const;
export type SessionEvent = (typeof sessionEventValues)[number];

/** `ck_sessions_audit__auth_method` — the DEPLOYED vocabulary, verbatim. */
export const sessionAuthMethodValues = [
  "password",
  "passkey",
  "magic_link",
  "otp",
  "kiosk_pin",
] as const;

export const sessionAuditRowSchema = z.object({
  id: dbUuid,
  profile_id: dbUuidNullable,
  /** Present INSTEAD of profile_id on a failed login: the credential missed. */
  attempted_email: z.string().nullable(),
  event: z.string(),
  auth_method: z.string().nullable(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  device_id: z.string().nullable(),
  geo: z.unknown().nullable(),
  failure_reason: z.string().nullable(),
  recorded_at: dbTimestamp,
});
export type SessionAuditRow = z.infer<typeof sessionAuditRowSchema>;

export interface SessionAuditFilters {
  /**
   * Half-open INSTANT window `[from, to)` on `recorded_at`, which is a
   * `timestamptz`. Callers pass the UTC bounds of an IST civil day
   * (`istDayUtcBounds`), never a bare 'YYYY-MM-DD' — comparing a timestamptz
   * against a date literal in Postgres pins it to 00:00 UTC, i.e. 05:30 IST,
   * which silently drops the first five and a half hours of every IST day.
   */
  readonly from?: string;
  readonly to?: string;
  readonly profileIds?: readonly string[];
  readonly events?: readonly string[];
  readonly authMethods?: readonly string[];
  /** Substring over `attempted_email` — how you chase a credential-stuffing run. */
  readonly emailLike?: string;
  /** Substring over `ip` (inet compares as text via ilike). */
  readonly ipLike?: string;
  /** Only rows that record a refusal (`failure_reason IS NOT NULL`). */
  readonly onlyFailures?: boolean;
}

function sessionFilters(f: SessionAuditFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.from !== undefined) filters.push(gte("recorded_at", f.from));
  if (f.to !== undefined) filters.push(lt("recorded_at", f.to));
  if (f.profileIds && f.profileIds.length > 0) filters.push(inList("profile_id", f.profileIds));
  if (f.events && f.events.length > 0) filters.push(inList("event", f.events));
  if (f.authMethods && f.authMethods.length > 0) filters.push(inList("auth_method", f.authMethods));
  if (f.emailLike !== undefined && f.emailLike.trim() !== "")
    filters.push(ilike("attempted_email", `%${f.emailLike.trim()}%`));
  if (f.ipLike !== undefined && f.ipLike.trim() !== "")
    filters.push(ilike("ip", `%${f.ipLike.trim()}%`));
  if (f.onlyFailures === true) filters.push({ op: "not_is", column: "failure_reason", value: null });
  return filters;
}

/** Keyset page of auth events, newest first. `id` is the unique tiebreak. */
export function fetchSessionAudit(
  f: SessionAuditFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<SessionAuditRow>> {
  return paginate(SESSIONS_AUDIT_TABLE, sessionAuditRowSchema, {
    orderBy: "recorded_at",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: sessionFilters(f),
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. export_log — /admin/audit/exports
// -----------------------------------------------------------------------------

/** `ck_export_log__kind`, verbatim from the migration. */
export const exportKindValues = [
  "csv",
  "xlsx",
  "pdf",
  "bank_advice",
  "audit_dump",
  "api_bulk",
  "ai_infographic_data",
] as const;

/** `ck_export_log__subject`, verbatim from the migration. */
export const exportSubjectValues = [
  "employees",
  "attendance",
  "payroll",
  "audit_log",
  "documents",
  "leave",
  "assets",
  "face_match_log",
] as const;

export const exportLogRowSchema = z.object({
  id: dbUuid,
  exported_at: dbTimestamp,
  actor_id: dbUuidNullable,
  actor_role: z.string().nullable(),
  export_kind: z.string(),
  subject: z.string(),
  filters: z.unknown().nullable(),
  columns: z.array(z.string()).nullable(),
  row_count: dbIntNullable,
  file_size_bytes: dbIntNullable,
  contains_pii: z.boolean(),
  contains_salary: z.boolean(),
  contains_biometric: z.boolean(),
  storage_path: z.string().nullable(),
  /** SHA-256 of the delivered file — what a dispute is settled against. */
  checksum_sha256: z.string().nullable(),
  purpose: z.string(),
  approved_by: dbUuidNullable,
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  request_id: dbUuidNullable,
});
export type ExportLogRow = z.infer<typeof exportLogRowSchema>;

export interface ExportLogFilters {
  /** Half-open INSTANT window `[from, to)` on `exported_at` — see above. */
  readonly from?: string;
  readonly to?: string;
  readonly actorIds?: readonly string[];
  readonly kinds?: readonly string[];
  readonly subjects?: readonly string[];
  /** Only egress that carried PII, salary or biometric data. */
  readonly sensitiveOnly?: boolean;
  /** Substring over the written purpose. */
  readonly purposeLike?: string;
}

function exportFilters(f: ExportLogFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.from !== undefined) filters.push(gte("exported_at", f.from));
  if (f.to !== undefined) filters.push(lt("exported_at", f.to));
  if (f.actorIds && f.actorIds.length > 0) filters.push(inList("actor_id", f.actorIds));
  if (f.kinds && f.kinds.length > 0) filters.push(inList("export_kind", f.kinds));
  if (f.subjects && f.subjects.length > 0) filters.push(inList("subject", f.subjects));
  // `contains_pii` is the widest of the three flags and the only one an OR-free
  // filter vocabulary can express without smuggling in raw PostgREST syntax.
  if (f.sensitiveOnly === true) filters.push({ op: "is", column: "contains_pii", value: true });
  if (f.purposeLike !== undefined && f.purposeLike.trim() !== "")
    filters.push(ilike("purpose", `%${f.purposeLike.trim()}%`));
  return filters;
}

export function fetchExportRegister(
  f: ExportLogFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<ExportLogRow>> {
  return paginate(EXPORT_LOG_TABLE, exportLogRowSchema, {
    orderBy: "exported_at",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: exportFilters(f),
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. audit_seals + integrity health — /admin/audit/integrity
// -----------------------------------------------------------------------------

export const auditSealRowSchema = z.object({
  id: dbUuid,
  seal_date: dbDate,
  first_seq: dbInt,
  last_seq: dbInt,
  row_count: dbInt,
  /** `row_hash` of the day's last row. The value to keep outside the system. */
  terminal_hash: z.string(),
  sealed_at: dbTimestamp,
  sealed_by: z.string(),
  external_anchor: z.string().nullable(),
  verified_at: dbTimestampNullable,
  /** 'ok' | 'chain_broken' | 'not_verified' — written by cron-integrity. */
  verification_result: z.string().nullable(),
});
export type AuditSealRow = z.infer<typeof auditSealRowSchema>;

/** The seal ladder for a date window, newest first. */
export function fetchAuditSeals(
  from: string,
  to: string,
  limit = 400,
  signal?: AbortSignal,
): Promise<AuditSealRow[]> {
  return selectMany(AUDIT_SEALS_TABLE, auditSealRowSchema, {
    filters: [gte("seal_date", from), lte("seal_date", to)],
    order: [{ column: "seal_date", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export const integrityHealthRowSchema = z.object({
  id: dbUuid,
  checked_at: dbTimestamp,
  component: z.string(),
  status: z.string(),
  metric_name: z.string().nullable(),
  metric_value: dbNumericNullable,
  detail: z.unknown().nullable(),
  message: z.string().nullable(),
  acknowledged_at: dbTimestampNullable,
  resolved_at: dbTimestampNullable,
});
export type IntegrityHealthRow = z.infer<typeof integrityHealthRowSchema>;

/**
 * The nightly verifier's own verdict rows. `component` is `integrity.audit_chain`
 * on success/failure of `audit.verify_chain`, and `integrity.<task>` when a task
 * itself blew up — both matter on this screen, so the filter is a prefix.
 *
 * Note the shape of the honest answer here: `audit.verify_chain` lives in the
 * `audit` schema, which PostgREST does not expose, and `cron-integrity` demands
 * a cron secret or a service-role bearer. The browser therefore CANNOT re-walk
 * the chain on demand; it reports the server's most recent verdict and says when
 * that verdict was reached.
 */
export function fetchIntegrityHealth(
  limit = 30,
  signal?: AbortSignal,
): Promise<IntegrityHealthRow[]> {
  return selectMany(SYSTEM_HEALTH_TABLE, integrityHealthRowSchema, {
    filters: [ilike("component", "integrity.%")],
    order: [{ column: "checked_at", ascending: false }],
    columns:
      "id,checked_at,component,status,metric_name,metric_value,detail,message,acknowledged_at,resolved_at",
    limit,
    ...(signal ? { signal } : {}),
  });
}

/** Open (unresolved, non-ok) integrity findings — the Critical banner's source. */
export function fetchOpenIntegrityFindings(
  limit = 20,
  signal?: AbortSignal,
): Promise<IntegrityHealthRow[]> {
  return selectMany(SYSTEM_HEALTH_TABLE, integrityHealthRowSchema, {
    filters: [ilike("component", "integrity.%"), neq("status", "ok"), { op: "is", column: "resolved_at", value: null }],
    order: [{ column: "checked_at", ascending: false }],
    columns:
      "id,checked_at,component,status,metric_name,metric_value,detail,message,acknowledged_at,resolved_at",
    limit,
    ...(signal ? { signal } : {}),
  });
}
