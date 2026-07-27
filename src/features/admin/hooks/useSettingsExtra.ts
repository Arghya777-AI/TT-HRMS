/**
 * useSettingsExtra.ts — TanStack hooks for `/admin/settings/{roles,security,
 * localisation,integrations,api,backup}` and `/admin/people/archive`.
 *
 * Three rules this file exists to keep:
 *
 *  1. EVERY NUMBER ON THESE SCREENS IS A POSTGRES COUNT. The role register, the
 *     auth-posture strip and the passkey tiles all read through `selectCount`
 *     (`count=exact`, HEAD). Counting the rows a grid happens to hold would make
 *     "2 super admins" depend on the page size — and §16.1 makes that figure a
 *     safety rule ("≥2 super_admins mandatory"), not decoration.
 *  2. THE STEP-UP FLAG COMES FROM THE DATABASE. `role_capabilities.requires_step_up`
 *     is what the edge layer enforces, so `capRequiresStepUp` reads the fetched
 *     matrix instead of a hard-coded list of sensitive actions. A capability that
 *     stops needing a second factor stops asking for one, with no code change.
 *  3. NO NEW QUERY KEYS ARE INVENTED. Everything composes `qk.admin.*` factories
 *     (`shared/api/keys.ts` is shared and must not be edited from a feature), so
 *     `qk.admin.systemAll()` still invalidates settings, and the generic
 *     `qk.admin.list({ area })` carries the reads that have no dedicated factory.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  fetchRoleAssignments,
  fetchRoleCapabilities,
  fetchRoleGrants,
  fetchSettings,
  grantRole,
  revokeRole,
  type AppRole,
  type RoleAssignment,
  type RoleCapability,
  type Setting,
  type UserRole,
} from "../api/system.api";
import { fetchActorOptions, type ActorProfile } from "../api/audit-registers.api";
import {
  countArchivedEmployees,
  countProfiles,
  countPasskeys,
  countRoleCapabilities,
  countRoleGrants,
  countSessionEvents,
  fetchArchivedEmployees,
  fetchCronSchedules,
  fetchIntegrations,
  fetchPasskeys,
  restoreEmployee,
  setIntegrationEnabled,
  type ArchiveFilters,
  type ArchivedEmployee,
  type CronSchedule,
  type Integration,
  type Passkey,
  type ProfilePostureKind,
  type SessionPostureEvent,
} from "../api/settings-extra.api";

// -----------------------------------------------------------------------------
// 1. Roles & capabilities
// -----------------------------------------------------------------------------

/** The deployed capability matrix (migration 050 §2). Read-only from a client. */
export function useRoleCapabilities(): UseQueryResult<RoleCapability[], Error> {
  return useQuery({
    queryKey: qk.admin.roleCapabilities(),
    queryFn: ({ signal }) => fetchRoleCapabilities(signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/**
 * True when this capability needs a fresh MFA step-up as well as the role.
 * A pure lookup over the fetched matrix — the flag is the server's, not ours.
 */
export function capRequiresStepUp(
  matrix: readonly RoleCapability[] | undefined,
  capability: string,
): boolean {
  if (matrix === undefined) return false;
  return matrix.some((row) => row.capability === capability && row.requires_step_up);
}

/** Every grant, live and revoked — the revoked ones ARE the evidence. */
export function useRoleGrants(): UseQueryResult<UserRole[], Error> {
  return useQuery({
    queryKey: qk.admin.roleGrants(),
    queryFn: ({ signal }) => fetchRoleGrants({}, signal),
    retry: shouldRetryQuery,
  });
}

/** `employee_role_assignments` — the SCOPE behind a role, not the role itself. */
export function useRoleAssignments(): UseQueryResult<RoleAssignment[], Error> {
  return useQuery({
    queryKey: qk.admin.roleAssignments(),
    queryFn: ({ signal }) => fetchRoleAssignments({}, signal),
    retry: shouldRetryQuery,
  });
}

/** Login accounts, for the holder labels and the grant picker. */
export function useProfileDirectory(): UseQueryResult<ActorProfile[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ area: "profiles" }),
    queryFn: ({ signal }) => fetchActorOptions(300, signal),
    staleTime: 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/** Live grants of one role, counted by the server. Omit `role` for all roles. */
export function useRoleGrantCount(role?: AppRole): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.list({ area: "role-grant-count", role: role ?? "any" }),
    queryFn: ({ signal }) =>
      countRoleGrants({ onlyActive: true, ...(role !== undefined ? { role } : {}) }, signal),
    retry: shouldRetryQuery,
  });
}

/** How many (role, capability) pairs the matrix holds. */
export function useCapabilityCount(): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.list({ area: "capability-count" }),
    queryFn: ({ signal }) => countRoleCapabilities(signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

export interface GrantRoleInput {
  readonly userId: string;
  readonly role: AppRole;
  readonly grantedBy: string;
}

/**
 * Grant a role. `user_roles__super_admin_insert` is the only INSERT policy and
 * `user_roles` is reason-required, so this always prompts at the D-21 length.
 * `role.grant` carries `requires_step_up`, which the CALLER must satisfy with
 * `useStepUp` before invoking this — the direct table path has no aal2 predicate
 * of its own (see the Roles screen header).
 */
export function useRoleGrantMutation(): AuditedMutationResult<UserRole, GrantRoleInput> {
  return useAuditedMutation<UserRole, GrantRoleInput>({
    mutationFn: (input, reason) =>
      grantRole({ userId: input.userId, role: input.role, grantedBy: input.grantedBy }, reason),
    invalidate: [qk.admin.roleGrants(), qk.admin.list({ area: "role-grant-count", role: "any" })],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export interface RevokeRoleInput {
  readonly grantId: string;
  readonly revokedBy: string;
}

/** Revoke a grant. Never a DELETE — the row stays, stamped with who and why. */
export function useRoleRevokeMutation(): AuditedMutationResult<UserRole, RevokeRoleInput> {
  return useAuditedMutation<UserRole, RevokeRoleInput>({
    mutationFn: (input, reason) => revokeRole(input.grantId, input.revokedBy, reason),
    invalidate: [qk.admin.roleGrants(), qk.admin.list({ area: "role-grant-count", role: "any" })],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

// -----------------------------------------------------------------------------
// 2. Settings by key (localisation, retention — cross-group key sets)
// -----------------------------------------------------------------------------

/**
 * Named `settings` rows, whatever group they belong to.
 *
 * `/admin/settings/localisation` and `/admin/settings/backup` are not settings
 * GROUPS: `settings.group_name` is constrained to
 * ('attendance','payroll','leave','notifications','security','ai','branding',
 * 'kiosk','system'), so those two screens assemble a named key set instead of
 * reading one group. The keys are sorted into the query key so two orderings of
 * the same set share a cache entry.
 */
export function useSettingsByKeys(keys: readonly string[]): UseQueryResult<Setting[], Error> {
  const sorted = [...keys].sort();
  return useQuery({
    queryKey: qk.admin.settings(`keys:${sorted.join(",")}`),
    queryFn: ({ signal }) => fetchSettings({ keys: sorted }, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 3. Integrations
// -----------------------------------------------------------------------------

export function useIntegrations(): UseQueryResult<Integration[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ area: "integrations" }),
    queryFn: ({ signal }) => fetchIntegrations(signal),
    retry: shouldRetryQuery,
  });
}

export interface IntegrationToggleInput {
  readonly id: string;
  readonly isEnabled: boolean;
}

export function useIntegrationMutation(): AuditedMutationResult<
  Integration,
  IntegrationToggleInput
> {
  return useAuditedMutation<Integration, IntegrationToggleInput>({
    mutationFn: (input, reason) => setIntegrationEnabled(input.id, input.isEnabled, reason),
    invalidate: [qk.admin.list({ area: "integrations" })],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

// -----------------------------------------------------------------------------
// 4. Auth posture
// -----------------------------------------------------------------------------

/** One append-only auth-event count since an instant (see `countSessionEvents`). */
export function useSessionEventCount(
  event: SessionPostureEvent,
  fromInstant: string,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.list({ area: "session-event-count", event, from: fromInstant }),
    queryFn: ({ signal }) => countSessionEvents(event, fromInstant, signal),
    retry: shouldRetryQuery,
  });
}

export function useProfilePostureCount(kind: ProfilePostureKind): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.list({ area: "profile-posture-count", kind }),
    queryFn: ({ signal }) => countProfiles(kind, signal),
    retry: shouldRetryQuery,
  });
}

export function usePasskeyCount(onlyActive: boolean): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.list({ area: "passkey-count", onlyActive }),
    queryFn: ({ signal }) => countPasskeys({ onlyActive }, signal),
    retry: shouldRetryQuery,
  });
}

export function usePasskeys(): UseQueryResult<Passkey[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ area: "passkeys" }),
    queryFn: ({ signal }) => fetchPasskeys(200, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 5. Retention schedule
// -----------------------------------------------------------------------------

export function useCronSchedules(codes: readonly string[]): UseQueryResult<CronSchedule[], Error> {
  const sorted = [...codes].sort();
  return useQuery({
    queryKey: qk.admin.list({ area: "cron-schedules", codes: sorted.join(",") }),
    queryFn: ({ signal }) => fetchCronSchedules(sorted, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 6. Archive restore
// -----------------------------------------------------------------------------

/**
 * Soft-deleted employees. Reads `public.employees` directly, NOT
 * `v_admin_employee` — the view filters `deleted_at IS NULL`, so it can never
 * return an archived row (see `fetchArchivedEmployees`).
 */
export function useArchivedEmployees(
  filters: ArchiveFilters,
): UseQueryResult<ArchivedEmployee[], Error> {
  return useQuery({
    queryKey: qk.admin.list({
      area: "archived-employees",
      name: filters.nameLike ?? null,
      code: filters.employeeCode ?? null,
    }),
    queryFn: ({ signal }) => fetchArchivedEmployees(filters, 200, signal),
    retry: shouldRetryQuery,
  });
}

/** The same filters, counted by the server — never `rows.length`. */
export function useArchivedEmployeeCount(
  filters: ArchiveFilters,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.list({
      area: "archived-employee-count",
      name: filters.nameLike ?? null,
      code: filters.employeeCode ?? null,
    }),
    queryFn: ({ signal }) => countArchivedEmployees(filters, signal),
    retry: shouldRetryQuery,
  });
}

export interface RestoreEmployeeInput {
  readonly employeeId: string;
}

/**
 * Undo a soft delete. Always prompts at the D-21 length: the sentence lands in
 * `deletion_reason` and in the `action = 'restore'` audit row.
 */
export function useEmployeeRestoreMutation(): AuditedMutationResult<void, RestoreEmployeeInput> {
  return useAuditedMutation<void, RestoreEmployeeInput>({
    mutationFn: (input, reason) => restoreEmployee(input.employeeId, reason),
    invalidate: [qk.admin.employeesAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}
