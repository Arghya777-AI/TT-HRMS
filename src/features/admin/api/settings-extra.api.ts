/**
 * settings-extra.api.ts — the reads and writes behind `/admin/settings/{roles,
 * security,localisation,integrations,api,backup}` and `/admin/people/archive`.
 *
 * Everything here was checked against the DEPLOYED migrations, and three of the
 * screens above exist mostly to say what the database does NOT expose:
 *
 *  * `secure.api_keys` (migration 012 §9) is `REVOKE ALL … FROM PUBLIC, anon,
 *    authenticated`, and the `secure` schema is never granted USAGE to a client.
 *    So there is no read, issue or rotate path for a machine credential from the
 *    browser at all — not a narrow one, none. This module therefore has no
 *    api-keys function, and the screen says so instead of listing an empty grid.
 *  * There is no `webhooks` / `webhook_deliveries` table anywhere in
 *    `supabase/migrations`, so endpoints, HMAC secrets, the delivery log and
 *    replay (spec-admin §15.5) have no backing store yet.
 *  * There is no `backups` / `restore_drills` / retention-policy table either.
 *    What IS readable about retention is the `retention_sweep` cron row, its
 *    `job_runs` history, and the retention-shaped `settings` keys.
 *
 * `integrations.config` holds secret NAMES only (migration 046 §3 —
 * `{"api_key_secret": "RESEND_API_KEY"}`); the values live in Function secrets.
 * Rendering the name is therefore not a disclosure, and `secretNamesOf` exists so
 * a screen never reaches into the jsonb itself.
 *
 * `cron_jobs` is re-declared here rather than reused from `health.api.ts`,
 * because that module's `cronJobSchema` requires a `job_code` column and orders
 * by it, while `public.cron_jobs` (migration 031 §4) names the column `code` —
 * `job_code` exists on `job_runs`, not on the schedule register.
 */
import { z } from "zod";
import {
  SENSITIVE_REASON_LENGTH,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  ilike,
  inList,
  isFalse,
  isNotNull,
  isNull,
  isTrue,
  restoreRow,
  selectCount,
  selectMany,
  updateRow,
  type Filter,
} from "@/shared/api/query";
import { EMPLOYEES_TABLE } from "./employees.api";
import { ROLE_CAPABILITIES_TABLE, USER_ROLES_TABLE, type AppRole } from "./system.api";
import { SESSIONS_AUDIT_TABLE, PROFILES_TABLE } from "./audit-registers.api";

export const INTEGRATIONS_TABLE = "integrations";
export const WEBAUTHN_TABLE = "webauthn_credentials";
export const CRON_JOBS_TABLE = "cron_jobs";

// -----------------------------------------------------------------------------
// 1. Integrations (`/admin/settings/integrations`, `/admin/settings/api`)
// -----------------------------------------------------------------------------

export const integrationKindValues = [
  "email",
  "sms",
  "ai",
  "biometric_device",
  "banking",
  "accounting",
  "calendar",
  "storage",
] as const;
export const integrationHealthValues = ["ok", "degraded", "down", "unknown"] as const;

export const integrationSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  kind: z.string(),
  is_enabled: z.boolean(),
  /** jsonb holding secret NAMES only — never a secret value. */
  config: z.unknown(),
  base_url: z.string().nullable(),
  webhook_secret_name: z.string().nullable(),
  last_success_at: dbTimestampNullable,
  last_failure_at: dbTimestampNullable,
  failure_count: dbInt,
  health_status: z.string(),
  rate_limit_per_min: dbIntNullable,
  updated_at: dbTimestamp,
});
export type Integration = z.infer<typeof integrationSchema>;

const INTEGRATION_COLUMNS = [
  "id",
  "code",
  "name",
  "kind",
  "is_enabled",
  "config",
  "base_url",
  "webhook_secret_name",
  "last_success_at",
  "last_failure_at",
  "failure_count",
  "health_status",
  "rate_limit_per_min",
  "updated_at",
].join(",");

/** Every integration an admin may see (`integrations__admin_read`). */
export function fetchIntegrations(signal?: AbortSignal): Promise<Integration[]> {
  return selectMany(INTEGRATIONS_TABLE, integrationSchema, {
    filters: [isNull("deleted_at")],
    order: [
      { column: "kind", ascending: true },
      { column: "code", ascending: true },
    ],
    columns: INTEGRATION_COLUMNS,
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The env/Vault entry NAMES this integration reads its credential from. The
 * values are Supabase Function secrets and are not in the database, so a screen
 * showing these names is naming a place, not revealing a key.
 */
export function secretNamesOf(config: unknown): readonly string[] {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return [];
  const out: string[] = [];
  for (const value of Object.values(config as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim() !== "") out.push(value);
  }
  return out;
}

/**
 * Enable or disable an integration. `integrations__super_admin_write` is the
 * only write policy, and the reason is a product requirement rather than a
 * database one (`integrations` is not in `audit.reason_required_tables`) — a
 * silently disabled email provider is how payslip notices stop arriving.
 */
export function setIntegrationEnabled(
  id: string,
  isEnabled: boolean,
  reason: string,
  signal?: AbortSignal,
): Promise<Integration> {
  return updateRow(
    INTEGRATIONS_TABLE,
    [eq("id", id)],
    { is_enabled: isEnabled },
    integrationSchema,
    {
      reason,
      minReasonLength: SENSITIVE_REASON_LENGTH,
      columns: INTEGRATION_COLUMNS,
      ...(signal ? { signal } : {}),
    },
  );
}

// -----------------------------------------------------------------------------
// 2. Role register counts (`/admin/settings/roles`)
// -----------------------------------------------------------------------------

/** Live grants counted by POSTGRES, not by the rows a grid happens to hold. */
export function countRoleGrants(
  f: { role?: AppRole; onlyActive?: boolean } = {},
  signal?: AbortSignal,
): Promise<number> {
  const filters: Filter[] = [];
  if (f.role !== undefined) filters.push(eq("role", f.role));
  if (f.onlyActive === true) filters.push(isNull("revoked_at"));
  return selectCount(USER_ROLES_TABLE, filters, { ...(signal ? { signal } : {}) });
}

/** How many (role, capability) pairs the deployed matrix holds. */
export function countRoleCapabilities(signal?: AbortSignal): Promise<number> {
  return selectCount(ROLE_CAPABILITIES_TABLE, [], { ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// 3. Auth posture (`/admin/settings/security`)
// -----------------------------------------------------------------------------

export const sessionPostureEvents = [
  "login_failed",
  "mfa_challenge",
  "passkey_used",
  "passkey_registered",
  "session_revoked",
  "password_changed",
] as const;
export type SessionPostureEvent = (typeof sessionPostureEvents)[number];

/**
 * How many `sessions_audit` rows of one kind since an instant. `sessions_audit`
 * is append-only, admin-readable (`sessions_audit__admin_read`) and written by
 * the edge functions with the service role — so these counts are the only honest
 * statement a client can make about auth activity.
 */
export function countSessionEvents(
  event: SessionPostureEvent,
  fromInstant: string,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(
    SESSIONS_AUDIT_TABLE,
    [eq("event", event), gte("recorded_at", fromInstant)],
    { ...(signal ? { signal } : {}) },
  );
}

/** 'all' | 'locked' (is_active = false) | 'must_change_password' | 'never_logged_in'. */
export type ProfilePostureKind = "all" | "locked" | "must_change_password" | "never_logged_in";

const PROFILE_POSTURE_FILTERS: Readonly<Record<ProfilePostureKind, readonly Filter[]>> = {
  all: [],
  locked: [isFalse("is_active")],
  must_change_password: [isTrue("must_change_password")],
  never_logged_in: [isNull("last_login_at")],
};

/**
 * Account-state counts from `profiles`. `is_active = false` is what the
 * lockout projection in `sessions_audit_apply_event()` writes once
 * `failed_login_count` reaches the threshold, so "locked" here means exactly
 * "the database deactivated or an admin deactivated this login".
 */
export function countProfiles(kind: ProfilePostureKind, signal?: AbortSignal): Promise<number> {
  return selectCount(PROFILES_TABLE, PROFILE_POSTURE_FILTERS[kind], {
    ...(signal ? { signal } : {}),
  });
}

export const passkeySchema = z.object({
  id: dbUuid,
  profile_id: dbUuid,
  device_label: z.string().nullable(),
  /** 'login' | 'attendance' | 'both'. */
  purpose: z.string(),
  transports: z.array(z.string()).nullable(),
  backup_eligible: z.boolean(),
  last_used_at: dbTimestampNullable,
  revoked_at: dbTimestampNullable,
  created_at: dbTimestamp,
});
export type Passkey = z.infer<typeof passkeySchema>;

const PASSKEY_COLUMNS = [
  "id",
  "profile_id",
  "device_label",
  "purpose",
  "transports",
  "backup_eligible",
  "last_used_at",
  "revoked_at",
  "created_at",
].join(",");

/**
 * Registered passkeys. `credential_id` and `public_key` are deliberately NOT in
 * the projection: the register answers "who can sign in without a password",
 * which needs no key material.
 */
export function fetchPasskeys(limit = 200, signal?: AbortSignal): Promise<Passkey[]> {
  return selectMany(WEBAUTHN_TABLE, passkeySchema, {
    order: [{ column: "created_at", ascending: false }],
    columns: PASSKEY_COLUMNS,
    limit,
    ...(signal ? { signal } : {}),
  });
}

export function countPasskeys(
  f: { onlyActive?: boolean } = {},
  signal?: AbortSignal,
): Promise<number> {
  const filters: Filter[] = f.onlyActive === true ? [isNull("revoked_at")] : [];
  return selectCount(WEBAUTHN_TABLE, filters, { ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// 4. Retention schedule (`/admin/settings/backup`)
// -----------------------------------------------------------------------------

export const cronScheduleSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  schedule_cron: z.string(),
  schedule_human: z.string(),
  timezone: z.string(),
  /** 'sql_function' | 'edge_function'. */
  target: z.string(),
  target_name: z.string(),
  is_enabled: z.boolean(),
  timeout_seconds: dbInt,
  overlap_policy: z.string(),
  alert_on_failure: z.boolean(),
  last_run_id: dbUuidNullable,
  next_run_at: dbTimestampNullable,
  updated_at: dbTimestamp,
});
export type CronSchedule = z.infer<typeof cronScheduleSchema>;

const CRON_COLUMNS = [
  "id",
  "code",
  "name",
  "description",
  "schedule_cron",
  "schedule_human",
  "timezone",
  "target",
  "target_name",
  "is_enabled",
  "timeout_seconds",
  "overlap_policy",
  "alert_on_failure",
  "last_run_id",
  "next_run_at",
  "updated_at",
].join(",");

/**
 * The named schedules a retention screen is about. Filtered SERVER-side by
 * `code` so the screen never fetches 20 rows to show three.
 */
export function fetchCronSchedules(
  codes: readonly string[],
  signal?: AbortSignal,
): Promise<CronSchedule[]> {
  const filters: Filter[] = codes.length > 0 ? [inList("code", codes)] : [];
  return selectMany(CRON_JOBS_TABLE, cronScheduleSchema, {
    filters,
    order: [{ column: "code", ascending: true }],
    columns: CRON_COLUMNS,
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. Archive restore (`/admin/people/archive`)
// -----------------------------------------------------------------------------

/**
 * WHY THE ARCHIVE READS THE BASE TABLE AND NOT `v_admin_employee`.
 *
 * `v_admin_employee` ends in `WHERE e.deleted_at IS NULL` (migration 033 §5), so
 * asking it for soft-deleted rows returns ZERO rows FOREVER — the view's own
 * predicate and an `deleted_at IS NOT NULL` filter are mutually exclusive. An
 * Archive console built on it would be a permanently empty grid that looks like
 * "nothing has ever been archived" rather than a broken read.
 *
 * The honest path is `public.employees` itself:
 *  * ROW visibility — `employees__admin_read` (migration 051 §1) is
 *    `USING (app.is_admin() AND app.admin_scope_covers(id))` with NO `deleted_at`
 *    predicate, and its comment says soft-deletes are admin-visible on purpose
 *    because "the Archive console needs them".
 *  * COLUMN privilege — migration 051 §2 issues `GRANT SELECT, UPDATE (…)`, where
 *    the column list binds to UPDATE only, so SELECT is granted table-wide to
 *    `authenticated` (widening migration 008's 7-column SELECT grant).
 *
 * The cost is that the base table has no resolved lookup names, so this
 * projection carries ids and the screen resolves the deleter through `profiles`.
 * No org-name column is invented from a join the database did not do.
 */
export const archivedEmployeeSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  work_email: z.string().nullable(),
  employment_status: z.string(),
  employment_type: z.string(),
  /*
    NULLABLE, because `employees.date_of_join` is (migration 008 declares it
    `date_of_join date` with no NOT NULL). A joiner recorded before their start
    date is agreed genuinely has none, and the bulk load of the venue's roster
    brought in 32 such records. Declaring it required turned that into a parse
    error that replaced the whole screen with "Something went wrong".
  */
  date_of_join: dbDateNullable,
  last_working_day: dbDateNullable,
  exit_type: z.string().nullable(),
  deleted_at: dbTimestamp,
  deleted_by: dbUuidNullable,
  deletion_reason: z.string().nullable(),
  updated_at: dbTimestamp,
});
export type ArchivedEmployee = z.infer<typeof archivedEmployeeSchema>;

const ARCHIVED_COLUMNS = [
  "id",
  "employee_code",
  "display_name",
  "work_email",
  "employment_status",
  "employment_type",
  "date_of_join",
  "last_working_day",
  "exit_type",
  "deleted_at",
  "deleted_by",
  "deletion_reason",
  "updated_at",
].join(",");

export interface ArchiveFilters {
  /** Substring of the display name. */
  readonly nameLike?: string;
  /** Substring of the employee code. */
  readonly employeeCode?: string;
}

/**
 * `deleted_at IS NOT NULL` is the archive predicate. There is no `archived`
 * column on `employees` anywhere in the deployed schema — the soft-delete stamp
 * IS the flag (migration 008: `deleted_at`/`deleted_by`/`deletion_reason`, with
 * `ck_employees__deletion_reason` forcing an actor and a ≥10-char reason).
 */
function archiveFilters(f: ArchiveFilters): Filter[] {
  const filters: Filter[] = [isNotNull("deleted_at")];
  if (f.nameLike !== undefined && f.nameLike.trim() !== "")
    filters.push(ilike("display_name", `%${f.nameLike.trim()}%`));
  if (f.employeeCode !== undefined && f.employeeCode.trim() !== "")
    filters.push(ilike("employee_code", `%${f.employeeCode.trim()}%`));
  return filters;
}

/** How many archived employees match, counted by POSTGRES (`count=exact`). */
export function countArchivedEmployees(
  f: ArchiveFilters = {},
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(EMPLOYEES_TABLE, archiveFilters(f), { ...(signal ? { signal } : {}) });
}

/**
 * Archived employees, most recently archived first — the order an admin
 * restoring an accidental delete actually needs. Built from the SAME
 * `archiveFilters(f)` array as the count, so the header total and the grid agree
 * by construction.
 */
export function fetchArchivedEmployees(
  f: ArchiveFilters = {},
  limit = 200,
  signal?: AbortSignal,
): Promise<ArchivedEmployee[]> {
  return selectMany(EMPLOYEES_TABLE, archivedEmployeeSchema, {
    filters: archiveFilters(f),
    order: [{ column: "deleted_at", ascending: false }],
    columns: ARCHIVED_COLUMNS,
    limit,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Undo a soft delete (D-23). `restoreRow` clears `deleted_at`/`deleted_by` and
 * writes the typed sentence into `deletion_reason`; the audit trigger classifies
 * the UPDATE as `action = 'restore'` because `deleted_at` went value → NULL.
 *
 * `employees` grants `UPDATE (deleted_at, deleted_by, deletion_reason)` to
 * `authenticated` (migration 051 §2) and the admin SELECT policy deliberately
 * covers soft-deleted rows, so the write itself is a sanctioned path. Note the
 * asymmetry the screen has to be honest about: the READ path
 * (`v_admin_employee`) ends in `WHERE e.deleted_at IS NULL`, so a restore can
 * only be offered for a row the console can actually list.
 */
export function restoreEmployee(
  employeeId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  return restoreRow(EMPLOYEES_TABLE, employeeId, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

/** Roles a screen may offer to grant. `super_admin` is deliberately absent. */
export const GRANTABLE_ROLES: readonly AppRole[] = ["employee", "manager", "admin"];
