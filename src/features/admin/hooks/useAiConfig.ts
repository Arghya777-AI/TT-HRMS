/**
 * useAiConfig.ts — reads behind `/admin/settings/ai`.
 *
 * The writable half of that screen already has hooks: `useSettingsGroup('ai')` +
 * `useSettingMutation` for the four `ai.*` rows, `useFeatureFlags` +
 * `useFeatureFlagMutation` for the two agent flags, and `useRoleCapabilities` for
 * the capability matrix. Nothing here duplicates them — a second way to write a
 * setting is a second reason-prompt policy to keep in step.
 *
 * What this file adds is the EVIDENCE half: what the agent has actually been
 * doing. Every figure is a Postgres `count=exact` or a stored column; nothing is
 * summed, averaged or annualised in the browser.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { nowIstMonth } from "@/lib/datetime";
import {
  AI_SCOPES,
  countAiConversations,
  fetchModelInForce,
  fetchModelUsage,
  fetchRecentAiUsage,
  type AiUsageRow,
  type ModelUsageCount,
} from "../api/ai-config.api";

function aiKey(part: string, filters: Record<string, unknown> = {}) {
  return qk.admin.list({ area: "ai-config", part, ...filters });
}

/** The current IST billing month, in the same 'YYYY-MM' shape the ledger stores. */
export function currentBillingMonth(): string {
  return nowIstMonth();
}

export interface ModelUsage {
  readonly perModel: readonly ModelUsageCount[];
  readonly total: number;
}

/** Per-model call counts for the billing month, counted by the database. */
export function useAiModelUsage(month: string): UseQueryResult<ModelUsage, Error> {
  return useQuery({
    queryKey: aiKey("model-usage", { month }),
    queryFn: ({ signal }) => fetchModelUsage(month, signal),
    retry: shouldRetryQuery,
  });
}

export interface ConversationCounts {
  readonly total: number;
  readonly self: number;
  readonly team: number;
  readonly org: number;
}

/**
 * Conversations started this billing month, whole and per scope. Four HEAD counts
 * in one query function: the scope split is the thing an administrator checks
 * after switching the employee gate on, so it must not be a client-side filter of
 * a page of rows.
 */
export function useAiConversationCounts(month: string): UseQueryResult<ConversationCounts, Error> {
  return useQuery({
    queryKey: aiKey("conversation-counts", { month }),
    queryFn: async ({ signal }) => {
      const [total, ...perScope] = await Promise.all([
        countAiConversations(month, null, signal),
        ...AI_SCOPES.map((scope) => countAiConversations(month, scope, signal)),
      ]);
      return {
        total,
        self: perScope[0] ?? 0,
        team: perScope[1] ?? 0,
        org: perScope[2] ?? 0,
      };
    },
    retry: shouldRetryQuery,
  });
}

/** The last call's model and timestamp — the only readable proof of what is live. */
export function useAiModelInForce(): UseQueryResult<
  { model: string | null; occurredAt: string | null } | null,
  Error
> {
  return useQuery({
    queryKey: aiKey("model-in-force"),
    queryFn: ({ signal }) => fetchModelInForce(signal),
    retry: shouldRetryQuery,
  });
}

/** The most recent ledger rows — one row per model turn, newest first. */
export function useAiRecentUsage(limit = 10): UseQueryResult<AiUsageRow[], Error> {
  return useQuery({
    queryKey: aiKey("recent-usage", { limit }),
    queryFn: ({ signal }) => fetchRecentAiUsage(limit, signal),
    retry: shouldRetryQuery,
  });
}
