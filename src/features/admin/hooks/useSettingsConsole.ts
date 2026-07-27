/**
 * useSettingsConsole.ts — TanStack hooks for `/admin/settings/{branding,flags,health,notifications}`.
 *
 * `settings` and `feature_flags` are both reason-required at the product layer:
 * a toggle that changes what the gate accepts or what an employee is emailed is
 * never a silent edit (§15.3 "Toggle = reason"). Neither mutation declares a
 * `defaultReason`, so a caller that forgets to prompt fails loudly on the client
 * instead of writing an unexplained row.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  fetchFeatureFlags,
  fetchSettings,
  setFeatureFlag,
  updateSetting,
  type FeatureFlag,
  type Setting,
} from "../api/system.api";
import {
  acknowledgeHealthAlert,
  fetchCronJobs,
  fetchJobRuns,
  fetchNotificationTemplateRows,
  fetchSystemHealth,
  setNotificationTemplateActive,
  REASON_ACK_HEALTH,
  REASON_TEMPLATE_TOGGLE,
  type CronJob,
  type HealthFilters,
  type JobRun,
  type NotificationTemplateRow,
  type SystemHealthRow,
} from "../api/health.api";

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** All rows of one `settings.group_name` ('branding', 'kiosk', 'security', …). */
export function useSettingsGroup(groupName: string): UseQueryResult<Setting[], Error> {
  return useQuery({
    queryKey: qk.admin.settings(groupName),
    queryFn: ({ signal }) => fetchSettings({ groupName }, signal),
    retry: shouldRetryQuery,
  });
}

export function useFeatureFlags(): UseQueryResult<FeatureFlag[], Error> {
  return useQuery({
    queryKey: qk.admin.featureFlags(),
    queryFn: ({ signal }) => fetchFeatureFlags(signal),
    retry: shouldRetryQuery,
  });
}

export function useSystemHealth(filters: HealthFilters): UseQueryResult<SystemHealthRow[], Error> {
  return useQuery({
    queryKey: qk.admin.systemHealth({
      onlyOpen: filters.onlyOpen ?? false,
      statuses: filters.statuses ?? null,
      since: filters.since ?? null,
    }),
    queryFn: ({ signal }) => fetchSystemHealth(filters, 300, signal),
    retry: shouldRetryQuery,
  });
}

export function useJobRuns(f: { jobCode?: string } = {}): UseQueryResult<JobRun[], Error> {
  return useQuery({
    queryKey: qk.admin.jobRuns({ jobCode: f.jobCode ?? null }),
    queryFn: ({ signal }) => fetchJobRuns(f, 200, signal),
    retry: shouldRetryQuery,
  });
}

export function useCronJobs(): UseQueryResult<CronJob[], Error> {
  return useQuery({
    queryKey: qk.admin.cronJobs(),
    queryFn: ({ signal }) => fetchCronJobs(signal),
    retry: shouldRetryQuery,
  });
}

export function useNotificationTemplates(): UseQueryResult<NotificationTemplateRow[], Error> {
  return useQuery({
    queryKey: qk.admin.notificationTemplates(),
    queryFn: ({ signal }) => fetchNotificationTemplateRows({}, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export interface SettingInput {
  readonly key: string;
  /** The jsonb value the row's `value_kind` calls for — no coercion downstream. */
  readonly value: unknown;
  /** Invalidated on success, so the group grid re-reads the server's own row. */
  readonly groupName: string;
}

export function useSettingMutation(): AuditedMutationResult<Setting, SettingInput> {
  return useAuditedMutation<Setting, SettingInput>({
    mutationFn: (input, reason) => updateSetting(input.key, input.value, reason),
    invalidate: [qk.admin.systemAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export interface FlagInput {
  readonly id: string;
  readonly patch: { is_enabled?: boolean; rollout_pct?: number; kill_switch?: boolean };
}

export function useFeatureFlagMutation(): AuditedMutationResult<FeatureFlag, FlagInput> {
  return useAuditedMutation<FeatureFlag, FlagInput>({
    mutationFn: (input, reason) => setFeatureFlag(input.id, input.patch, reason),
    invalidate: [qk.admin.featureFlags()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export interface HealthAckInput {
  readonly id: string;
  readonly profileId: string;
}

/** Acknowledging is routine, so a specific default sentence is acceptable here. */
export function useHealthAckMutation(): AuditedMutationResult<SystemHealthRow, HealthAckInput> {
  return useAuditedMutation<SystemHealthRow, HealthAckInput>({
    mutationFn: (input, reason) => acknowledgeHealthAlert(input.id, input.profileId, reason),
    invalidate: [qk.admin.systemAll()],
    defaultReason: REASON_ACK_HEALTH,
  });
}

export interface TemplateActiveInput {
  readonly id: string;
  readonly isActive: boolean;
}

export function useNotificationTemplateMutation(): AuditedMutationResult<
  NotificationTemplateRow,
  TemplateActiveInput
> {
  return useAuditedMutation<NotificationTemplateRow, TemplateActiveInput>({
    mutationFn: (input, reason) => setNotificationTemplateActive(input.id, input.isActive, reason),
    invalidate: [qk.admin.notificationTemplates()],
    defaultReason: REASON_TEMPLATE_TOGGLE,
  });
}
