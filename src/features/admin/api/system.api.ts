/**
 * system.api.ts — System settings (§15), roles & capabilities (§16), kiosk fleet
 * (§5.11) and enrolment coverage.
 *
 * Write paths here are the narrowest in the whole console, and the narrowing is
 * the DEPLOYED policy set, not a UI choice:
 *   * `settings`      — UPDATE allowed to an admin only when
 *     `is_editable_by_admin`, otherwise super-admin. INSERT is super-admin only.
 *     The table is in `audit.reason_required_tables`, so every toggle needs a
 *     sentence. `is_editable_by_admin` is exposed on the row so a screen can
 *     disable the control instead of letting the save fail.
 *   * `feature_flags` — FOR ALL to super_admin only.
 *   * `user_roles`    — INSERT/UPDATE to super_admin only, and the table is
 *     reason-required. Granting admin is the single most sensitive write in the
 *     product; it always prompts and always at 15 characters.
 *   * `kiosk_devices` — FOR ALL to super_admin only; reason-required.
 *
 * Nothing here writes a secret. Integration credentials, API keys and the
 * Anthropic key are server-side only; a client never reads or writes them.
 */
import { z } from "zod";
import {
  MutationError,
  SENSITIVE_REASON_LENGTH,
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumericNullable,
  dbPercentNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  insertRow,
  isNull,
  lte,
  selectMany,
  selectOne,
  updateRow,
  type Filter,
} from "@/shared/api/query";
import { nowInstantIso } from "@/lib/datetime";

export const SETTINGS_TABLE = "settings";
export const FEATURE_FLAGS_TABLE = "feature_flags";
export const USER_ROLES_TABLE = "user_roles";
export const ROLE_CAPABILITIES_TABLE = "role_capabilities";
export const ROLE_ASSIGNMENTS_TABLE = "employee_role_assignments";
export const KIOSK_DEVICES_TABLE = "kiosk_devices";
export const NOTIFICATION_TEMPLATES_TABLE = "notification_templates";
export const V_KIOSK_HEALTH = "v_kiosk_health";
export const V_ENROLMENT_COVERAGE = "v_enrolment_coverage";

/** `public.app_role` (migration 003). */
export const appRoleSchema = z.enum(["employee", "manager", "admin", "super_admin"]);
export type AppRole = z.infer<typeof appRoleSchema>;

// -----------------------------------------------------------------------------
// 1. Settings (`/admin/settings/*`)
// -----------------------------------------------------------------------------

export const settingSchema = z.object({
  id: dbUuid,
  company_id: dbUuidNullable,
  key: z.string(),
  /**
   * jsonb, NOT text — verified live, where `attendance.ist_day_cutover_time`
   * arrives as the string "05:00" and `payroll.round_net_to_rupee` as the boolean
   * true. `value_kind` ('string' | 'time' | 'boolean' | 'number' | 'json') says
   * how to render it; this layer does not coerce.
   */
  value: z.unknown(),
  value_kind: z.string(),
  scope: z.string(),
  scope_id: dbUuidNullable,
  label: z.string(),
  description: z.string().nullable(),
  group_name: z.string(),
  is_sensitive: z.boolean(),
  /** False → an admin cannot change it; only a super admin can. */
  is_editable_by_admin: z.boolean(),
  validation: z.unknown().nullable(),
  default_value: z.unknown(),
  updated_at: dbTimestamp,
  updated_by: dbUuidNullable,
});
export type Setting = z.infer<typeof settingSchema>;

export function fetchSettings(
  f: { groupName?: string; keys?: readonly string[] } = {},
  signal?: AbortSignal,
): Promise<Setting[]> {
  const filters: Filter[] = [];
  if (f.groupName !== undefined) filters.push(eq("group_name", f.groupName));
  if (f.keys && f.keys.length > 0) filters.push(inList("key", f.keys));
  return selectMany(SETTINGS_TABLE, settingSchema, {
    filters,
    order: [
      { column: "group_name", ascending: true },
      { column: "key", ascending: true },
    ],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

export function fetchSetting(key: string, signal?: AbortSignal): Promise<Setting | null> {
  return selectOne(SETTINGS_TABLE, settingSchema, [eq("key", key)], { ...(signal ? { signal } : {}) });
}

/**
 * Change one setting. `value` is jsonb, so the caller passes the JSON value the
 * `value_kind` calls for — the string "05:00" for a time, the boolean `true` for a
 * toggle, the number 250 for a radius. No coercion happens here: silently turning
 * "5" into 5 is how a grace period becomes 5 hours instead of 5 minutes.
 */
export function updateSetting(
  key: string,
  value: unknown,
  reason: string,
  signal?: AbortSignal,
): Promise<Setting> {
  return updateRow(SETTINGS_TABLE, [eq("key", key)], { value }, settingSchema, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Feature flags (`/admin/settings/flags`) — super admin
// -----------------------------------------------------------------------------

export const featureFlagSchema = z.object({
  id: dbUuid,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  is_enabled: z.boolean(),
  /** Already a percentage; the view clamps it, the client must not. */
  rollout_pct: dbPercentNullable,
  enabled_for_profile_ids: z.array(dbUuid).nullable(),
  enabled_for_department_ids: z.array(dbUuid).nullable(),
  enabled_for_roles: z.array(z.string()).nullable(),
  kill_switch: z.boolean(),
  owner: z.string().nullable(),
  /** Mandatory expiry (§15.3) — NULL means "permanent, justified". */
  expires_at: dbTimestampNullable,
  deleted_at: dbTimestampNullable,
  updated_at: dbTimestamp,
});
export type FeatureFlag = z.infer<typeof featureFlagSchema>;

export function fetchFeatureFlags(signal?: AbortSignal): Promise<FeatureFlag[]> {
  return selectMany(FEATURE_FLAGS_TABLE, featureFlagSchema, {
    filters: [isNull("deleted_at")],
    order: [{ column: "key", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

/** Toggle a flag. Always prompts (§15.3 "Toggle = reason"). */
export function setFeatureFlag(
  id: string,
  patch: { is_enabled?: boolean; rollout_pct?: number; kill_switch?: boolean },
  reason: string,
  signal?: AbortSignal,
): Promise<FeatureFlag> {
  return updateRow(FEATURE_FLAGS_TABLE, [eq("id", id)], patch, featureFlagSchema, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Roles & capabilities (`/admin/settings/roles`) — super admin
// -----------------------------------------------------------------------------

export const userRoleSchema = z.object({
  id: dbUuid,
  user_id: dbUuid,
  role: appRoleSchema,
  granted_by: dbUuidNullable,
  granted_at: dbTimestamp,
  granted_reason: z.string().nullable(),
  revoked_at: dbTimestampNullable,
  revoked_by: dbUuidNullable,
  revoke_reason: z.string().nullable(),
});
export type UserRole = z.infer<typeof userRoleSchema>;

export function fetchRoleGrants(
  f: { userIds?: readonly string[]; onlyActive?: boolean } = {},
  signal?: AbortSignal,
): Promise<UserRole[]> {
  const filters: Filter[] = [];
  if (f.userIds && f.userIds.length > 0) filters.push(inList("user_id", f.userIds));
  if (f.onlyActive === true) filters.push(isNull("revoked_at"));
  return selectMany(USER_ROLES_TABLE, userRoleSchema, {
    filters,
    order: [{ column: "granted_at", ascending: false }],
    limit: 300,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Grant a role. Super-admin only (`user_roles__super_admin_insert`), reason
 * mandatory twice over: `granted_reason` is a column the Role Register renders,
 * and the audit trigger needs `app.reason` as well.
 *
 * §16.1 forbids granting `super_admin` casually and §16.2 wants four-eyes on it;
 * the four-eyes ceremony is a server concern, so this function refuses to be the
 * quiet path for it — a super-admin grant must go through the workflow, and the
 * screen should not offer the button.
 */
export function grantRole(
  input: { userId: string; role: AppRole; grantedBy: string },
  reason: string,
  signal?: AbortSignal,
): Promise<UserRole> {
  return insertRow(
    USER_ROLES_TABLE,
    {
      user_id: input.userId,
      role: input.role,
      granted_by: input.grantedBy,
      granted_reason: reason.trim(),
    },
    userRoleSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, ...(signal ? { signal } : {}) },
  );
}

/** Revoke a role grant. Never a DELETE — the grant history is the evidence. */
export function revokeRole(
  grantId: string,
  revokedBy: string,
  reason: string,
  signal?: AbortSignal,
): Promise<UserRole> {
  return updateRow(
    USER_ROLES_TABLE,
    [eq("id", grantId), isNull("revoked_at")],
    { revoked_at: nowInstantIso(), revoked_by: revokedBy, revoke_reason: reason.trim() },
    userRoleSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, ...(signal ? { signal } : {}) },
  );
}

export const roleCapabilitySchema = z.object({
  role: appRoleSchema,
  capability: z.string(),
  description: z.string().nullable(),
  requires_step_up: z.boolean(),
});
export type RoleCapability = z.infer<typeof roleCapabilitySchema>;

/** The capability matrix (read-only from the client — seeded, not editable). */
export function fetchRoleCapabilities(signal?: AbortSignal): Promise<RoleCapability[]> {
  return selectMany(ROLE_CAPABILITIES_TABLE, roleCapabilitySchema, {
    order: [
      { column: "role", ascending: true },
      { column: "capability", ascending: true },
    ],
    limit: 1000,
    ...(signal ? { signal } : {}),
  });
}

export const roleAssignmentSchema = z.object({
  id: dbUuid,
  profile_id: dbUuid,
  role: appRoleSchema,
  /** 'global' | 'company' | 'location' | 'department' | 'section' | 'employees'. */
  scope_kind: z.string(),
  company_id: dbUuidNullable,
  location_id: dbUuidNullable,
  department_id: dbUuidNullable,
  section_id: dbUuidNullable,
  employee_ids: z.array(dbUuid).nullable(),
  effective_from: dbDate,
  effective_to: dbDateNullable,
  created_at: dbTimestamp,
});
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

/**
 * The scope behind a role. This is the row DEMO-ACCOUNTS.md calls out: an
 * `admin` role with no `employee_role_assignments` row sees every admin screen
 * and zero employees, because every admin read passes through
 * `app.admin_scope_covers()`. A Roles screen that does not show this is lying.
 */
export function fetchRoleAssignments(
  f: { profileIds?: readonly string[] } = {},
  signal?: AbortSignal,
): Promise<RoleAssignment[]> {
  const filters: Filter[] = [];
  if (f.profileIds && f.profileIds.length > 0) filters.push(inList("profile_id", f.profileIds));
  return selectMany(ROLE_ASSIGNMENTS_TABLE, roleAssignmentSchema, {
    filters,
    order: [{ column: "effective_from", ascending: false }],
    limit: 300,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Kiosk fleet (`/admin/kiosk/devices`, `/admin/settings/health`)
// -----------------------------------------------------------------------------

export const kioskDeviceSchema = z.object({
  id: dbUuid,
  device_code: z.string(),
  label: z.string(),
  location_id: dbUuidNullable,
  device_kind: z.string(),
  platform: z.string().nullable(),
  is_active: z.boolean(),
  allowed_ip_cidrs: z.array(z.string()).nullable(),
  allowed_geofence: z.unknown().nullable(),
  require_operator: z.boolean(),
  min_match_confidence: dbNumericNullable,
  max_offline_queue: dbIntNullable,
  clock_skew_seconds: dbIntNullable,
  last_seen_at: dbTimestampNullable,
  last_punch_at: dbTimestampNullable,
  app_version: z.string().nullable(),
  enrolled_at: dbTimestampNullable,
  revoked_at: dbTimestampNullable,
  deleted_at: dbTimestampNullable,
  updated_at: dbTimestamp,
});
export type KioskDevice = z.infer<typeof kioskDeviceSchema>;

export function fetchKioskDevices(signal?: AbortSignal): Promise<KioskDevice[]> {
  return selectMany(KIOSK_DEVICES_TABLE, kioskDeviceSchema, {
    filters: [isNull("deleted_at")],
    order: [{ column: "device_code", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Edit a device. Super-admin only (`kiosk_devices__super_admin_write`) and
 * reason-required — a threshold change silently changes who the gate lets in.
 * `vault_secret_name` is never written from a client.
 */
export function updateKioskDevice(
  id: string,
  patch: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<KioskDevice> {
  if ("vault_secret_name" in patch) {
    return Promise.reject(
      new MutationError(
        KIOSK_DEVICES_TABLE,
        "permission_denied",
        "The device secret is managed in Vault by the pairing edge function and is never written from the browser.",
      ),
    );
  }
  return updateRow(KIOSK_DEVICES_TABLE, [eq("id", id)], patch, kioskDeviceSchema, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

export const kioskHealthSchema = z.object({
  kiosk_device_id: dbUuid,
  device_code: z.string(),
  label: z.string(),
  ist_date: dbDate,
  total_attempts: dbInt,
  matched: dbInt,
  no_match: dbInt,
  ambiguous: dbInt,
  liveness_failures: dbInt,
  capture_failures: dbInt,
  errors: dbInt,
  duplicates_suppressed: dbInt,
  /** Clamped [0,100] by the view; NULL when there were no attempts. */
  match_success_pct: dbPercentNullable,
  p50_latency_ms: dbIntNullable,
  p95_latency_ms: dbIntNullable,
  offline_replays: dbInt,
  last_seen_at: dbTimestampNullable,
  clock_skew_seconds: dbIntNullable,
  is_active: z.boolean(),
  app_version: z.string().nullable(),
});
export type KioskHealthRow = z.infer<typeof kioskHealthSchema>;

export function fetchKioskHealth(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<KioskHealthRow[]> {
  return selectMany(V_KIOSK_HEALTH, kioskHealthSchema, {
    filters: [gte("ist_date", from), lte("ist_date", to)],
    order: [
      { column: "ist_date", ascending: false },
      { column: "device_code", ascending: true },
    ],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

export const enrolmentGapSchema = z.object({
  employee_id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  /*
    NULLABLE, because `employees.date_of_join` is (migration 008 declares it
    `date_of_join date` with no NOT NULL). A joiner recorded before their start
    date is agreed genuinely has none, and the bulk load of the venue's roster
    brought in 32 such records. Declaring it required turned that into a parse
    error that replaced the whole screen with "Something went wrong".
  */
  date_of_join: dbDateNullable,
  has_active_consent: z.boolean(),
  consent_granted_at: dbTimestampNullable,
  consent_withdrawn: z.boolean(),
  has_active_template: z.boolean(),
  face_enrolled_at: dbTimestampNullable,
  /** 'consent_withdrawn' | 'no_consent' | 'consented_not_enrolled'. */
  gap_kind: z.string().nullable(),
});
export type EnrolmentGap = z.infer<typeof enrolmentGapSchema>;

/**
 * Who cannot use the gate yet, and why. A withdrawn consent is a DISTINCT gap
 * kind — those employees use the alternative punch method and must never be
 * nagged to re-enrol (§5.10).
 */
export function fetchEnrolmentGaps(signal?: AbortSignal): Promise<EnrolmentGap[]> {
  return selectMany(V_ENROLMENT_COVERAGE, enrolmentGapSchema, {
    order: [{ column: "employee_code", ascending: true }],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. Notification templates (`/admin/settings/notifications`)
// -----------------------------------------------------------------------------

export const notificationTemplateSchema = z
  .object({
    id: dbUuid,
    code: z.string(),
    name: z.string(),
    is_active: z.boolean(),
  })
  .passthrough();
export type NotificationTemplate = z.infer<typeof notificationTemplateSchema>;

/**
 * Templates are seeded and versioned (§15.7). The row shape could not be probed
 * (the table read back empty on the live project for this persona), so the schema
 * asserts only the four columns the list screen needs and passes the rest
 * through — narrowing it further would be guessing.
 */
export function fetchNotificationTemplates(signal?: AbortSignal): Promise<NotificationTemplate[]> {
  return selectMany(NOTIFICATION_TEMPLATES_TABLE, notificationTemplateSchema, {
    order: [{ column: "code", ascending: true }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}
