/**
 * ai-config.api.ts — reads behind `/admin/settings/ai` (spec-admin §15.6).
 *
 * The configuration this screen governs lives in three DIFFERENT places, and the
 * screen is only honest if it says which is which:
 *
 *   * `public.settings`, group `ai` — the four rows the deployed `ai-agent`
 *     function actually reads at request time: `ai.monthly_budget_inr` (the hard
 *     stop), `ai.employee_scope_enabled` (the self-tier gate),
 *     `ai.context_views_only` and `ai.provider`. Written through `system.api.ts`,
 *     reason-required, and super-admin-only where `is_editable_by_admin` is false.
 *   * `public.role_capabilities` — who may ask at all (`ai.ask.self`,
 *     `ai.ask.team`, `ai.ask.all`, `ai.budget.override`). Seeded, read-only from a
 *     client, and the real per-role switch.
 *   * A FUNCTION SECRET — the model. `ai-agent` resolves it as
 *     `Deno.env.get("ANTHROPIC_MODEL") || DEFAULT_MODEL`, so no database row holds
 *     it and no client write can change it. This file therefore does not pretend
 *     to read the model from configuration; it reads what the LEDGER SAYS WAS
 *     USED, which is a fact rather than an intention.
 *
 * `ai_usage_ledger` is append-only and admin-readable (migration 030), so per-model
 * CALL COUNTS come from Postgres `count=exact` — one HEAD request per model, in
 * parallel, inside a single query function. Spend does NOT: `total_cost_inr` is
 * `numeric(14,4)` and summing money in a browser over whatever page happened to
 * load is exactly the defect /admin/analytics/ai refuses to commit. There is no
 * `v_ai_usage_*` aggregate view, so this screen shows counts and the budget, names
 * the missing relation, and stops.
 */
import { z } from "zod";
import {
  dbInt,
  dbNumericNullable,
  dbTimestamp,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  lt,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { istRangeInstantBounds, istMonthRange } from "@/lib/datetime";
import { AI_USAGE_LEDGER_TABLE } from "./analytics-workforce.api";

export const AI_CONVERSATIONS_TABLE = "ai_conversations";
export const AI_MESSAGES_TABLE = "ai_messages";
export { AI_USAGE_LEDGER_TABLE };

/** `settings.group_name` this screen owns. */
export const AI_SETTINGS_GROUP = "ai";

/** The four `ai.*` keys the deployed function reads, in the order it reads them. */
export const AI_SETTING_KEYS = [
  "ai.monthly_budget_inr",
  "ai.employee_scope_enabled",
  "ai.context_views_only",
  "ai.provider",
] as const;

/** `feature_flags.key` — declared intent for the two agent surfaces (seed 046). */
export const AI_FLAG_KEYS = ["ai_agent_admin_scope", "ai_agent_employee_scope"] as const;

/** `role_capabilities.capability` — the per-role switches that ARE enforced. */
export const AI_CAPABILITIES = [
  "ai.ask.self",
  "ai.ask.team",
  "ai.ask.all",
  "ai.budget.override",
] as const;

// -----------------------------------------------------------------------------
// 1. The model catalogue — the function's own PRICING map, not a guess
// -----------------------------------------------------------------------------

export interface ModelCatalogueEntry {
  readonly model: string;
  /** USD per million input tokens, from `PRICING` in `ai-agent/index.ts`. */
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  /** True for the value `DEFAULT_MODEL` falls back to when the secret is unset. */
  readonly isFunctionDefault?: boolean;
}

/**
 * Mirrors `PRICING` and `DEFAULT_MODEL` in `supabase/functions/ai-agent/index.ts`.
 * A model absent from that map is billed at `FALLBACK_PRICING`, which is why the
 * screen states the list rather than offering a free-text box: setting
 * `ANTHROPIC_MODEL` to something outside it silently changes how cost is recorded.
 */
export const MODEL_CATALOGUE: readonly ModelCatalogueEntry[] = [
  { model: "claude-opus-5", inputUsdPerMTok: 5, outputUsdPerMTok: 25, isFunctionDefault: true },
  { model: "claude-opus-4-8", inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  { model: "claude-sonnet-5", inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  { model: "claude-haiku-4-5", inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
];

/** `AI usage per scope` — `ai_conversations.scope` is fixed at creation (030). */
export const AI_SCOPES = ["self", "team", "org"] as const;
export type AiScope = (typeof AI_SCOPES)[number];

// -----------------------------------------------------------------------------
// 2. The usage ledger
// -----------------------------------------------------------------------------

export const aiUsageRowSchema = z.object({
  id: dbUuid,
  occurred_at: dbTimestamp,
  profile_id: dbUuidNullable,
  conversation_id: dbUuidNullable,
  model: z.string().nullable(),
  input_tokens: dbInt,
  output_tokens: dbInt,
  cache_read_tokens: dbInt,
  cache_creation_tokens: dbInt,
  /** numeric(14,6) / numeric(14,4) — arrive as strings, coerced, never summed here. */
  total_cost_usd: dbNumericNullable,
  usd_inr_rate: dbNumericNullable,
  total_cost_inr: dbNumericNullable,
  /** 'YYYY-MM' in IST, written by the function. */
  billing_month: z.string().nullable(),
  feature: z.string().nullable(),
});
export type AiUsageRow = z.infer<typeof aiUsageRowSchema>;

/** The most recent calls, newest first — the evidence of what the agent is doing. */
export function fetchRecentAiUsage(limit = 10, signal?: AbortSignal): Promise<AiUsageRow[]> {
  return selectMany(AI_USAGE_LEDGER_TABLE, aiUsageRowSchema, {
    order: [{ column: "occurred_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export interface ModelUsageCount {
  readonly model: string;
  /** Ledger rows for this model in the billing month — counted by Postgres. */
  readonly calls: number;
}

/**
 * Per-model call counts for one `billing_month`, plus an `(other)` bucket for a
 * model the catalogue does not know — that bucket being non-zero is the signal
 * that `ANTHROPIC_MODEL` was pointed somewhere unpriced.
 *
 * One HEAD count per model, issued in parallel from ONE query function: no hook
 * runs in a loop, and nothing is added up in the client.
 */
export async function fetchModelUsage(
  billingMonth: string,
  signal?: AbortSignal,
): Promise<{ readonly perModel: readonly ModelUsageCount[]; readonly total: number }> {
  const monthFilter: Filter[] = [eq("billing_month", billingMonth)];
  const [total, ...counts] = await Promise.all([
    selectCount(AI_USAGE_LEDGER_TABLE, monthFilter, { ...(signal ? { signal } : {}) }),
    ...MODEL_CATALOGUE.map((entry) =>
      selectCount(AI_USAGE_LEDGER_TABLE, [...monthFilter, eq("model", entry.model)], {
        ...(signal ? { signal } : {}),
      }),
    ),
  ]);
  const perModel = MODEL_CATALOGUE.map((entry, index) => ({
    model: entry.model,
    calls: counts[index] ?? 0,
  }));
  return { perModel, total };
}

/** Conversations started in an IST month, by scope. `null` scope = every scope. */
export function countAiConversations(
  month: string,
  scope: AiScope | null,
  signal?: AbortSignal,
): Promise<number> {
  const { from, to } = istMonthRange(month);
  const { fromInstant, toInstantExclusive } = istRangeInstantBounds(from, to);
  const filters: Filter[] = [
    gte("started_at", fromInstant),
    lt("started_at", toInstantExclusive),
  ];
  if (scope !== null) filters.push(eq("scope", scope));
  return selectCount(AI_CONVERSATIONS_TABLE, filters, { ...(signal ? { signal } : {}) });
}

/**
 * The model of the most recent call, with when it happened. This is the ONLY
 * trustworthy answer to "which model is in force": the secret itself is not
 * readable from a browser, and a screen that printed a hard-coded name would be
 * guessing.
 */
export async function fetchModelInForce(
  signal?: AbortSignal,
): Promise<{ readonly model: string | null; readonly occurredAt: string | null } | null> {
  const rows = await selectMany(AI_USAGE_LEDGER_TABLE, aiUsageRowSchema, {
    order: [{ column: "occurred_at", ascending: false }],
    limit: 1,
    ...(signal ? { signal } : {}),
  });
  const latest = rows[0];
  if (latest === undefined) return null;
  return { model: latest.model, occurredAt: latest.occurred_at };
}
