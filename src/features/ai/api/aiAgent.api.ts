/**
 * aiAgent.api.ts — the client half of the `ai-agent` edge function.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THE BACKEND WAS ALREADY BUILT. THIS IS THE MISSING HALF.
 *
 * `supabase/functions/ai-agent` is 3,600 lines and has been deployed and keyed for
 * days: it resolves the caller's scope in SQL, runs a fixed set of vetted tools,
 * validates the model's output against fourteen deterministic checks, and records
 * tokens and rupees in `ai_usage_ledger`. What did not exist was a screen. `/me/ask`
 * was a phase-P2 stub, so the whole thing was unreachable.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * TWO RULES THIS MODULE DOES NOT GET TO BREAK
 *
 * 1. RENDER `display`, NEVER RE-FORMAT `raw`.
 *    The SERVER computes `display` from `raw` after the model has spoken, precisely so a
 *    model cannot state a figure that differs from the one the tool returned. If this
 *    client formatted `raw` itself, that guarantee would be worth nothing — a rounding
 *    difference here would silently become the number a person reads. `raw` is used ONLY
 *    for chart geometry, where a string cannot be plotted.
 *
 *    This was only two-thirds true when the page was first built, and the gap was worth
 *    more than the formatting. The validator ran its grounding check — "every number must
 *    be copied from a tool result" — and computed `display` for `values[]` and
 *    `items[].value`, but the model actually emits `kpi_row` items with `raw`/`format`
 *    FLATTENED, and `stat_callout` with the figure on the BLOCK. Those numbers reached
 *    the client both unformatted AND unchecked. The function now normalises all three
 *    shapes through the same check, so this rule is true for every figure rather than
 *    for the shapes the schema happened to describe.
 *
 * 2. THE SCHEMA IS TOLERANT ON PURPOSE.
 *    Block `type` is a plain string, not an enum, and unknown fields pass through.
 *    The function can add a block type without this file being redeployed; the
 *    renderer skips what it does not recognise and says so. A strict enum would turn
 *    a new server capability into a blank screen.
 *
 * `masked` is honoured, not decoded: when the server masks a figure the display string
 * is already the mask, so rendering `display` is what keeps the mask.
 */
import { z } from "zod";
import { invokeEdgeFn } from "@/shared/api/invoke";

export const AI_AGENT_FN = "ai-agent";

/** Mirrors the function's `VALUE_FORMATS`. Kept for the exporter, not for display. */
export const VALUE_FORMATS = [
  "inr",
  "inr_lakh",
  "inr_crore",
  "int",
  "decimal1",
  "pct1",
  "hours",
  "duration_min",
  "days",
  "date",
  "month",
  "time",
  "datetime",
  "text",
] as const;

export type ValueFormat = (typeof VALUE_FORMATS)[number];

/** Tolerant: an unfamiliar format still renders, because `display` is authoritative. */
const valueFormat = z.string().min(1);

export const specValueSchema = z.object({
  label: z.string(),
  raw: z.union([z.number(), z.string(), z.null()]),
  format: valueFormat,
  masked: z.boolean().default(false),
  /** Server-computed. THE thing to render. */
  display: z.string().optional(),
});

export type SpecValue = z.infer<typeof specValueSchema>;

export const seriesSchema = z.object({
  name: z.string(),
  /** A palette TOKEN (`series-1`, `positive`, …), never a hex. See `aiSpec.ts`. */
  colour: z.string(),
  format: valueFormat,
  points: z.array(z.object({ x: z.string(), y: z.number().nullable() })),
});

export const specTableSchema = z.object({
  columns: z.array(z.object({ key: z.string(), label: z.string(), format: valueFormat })),
  rows: z.array(z.array(z.union([z.number(), z.string(), z.null()]))),
  exportable: z.boolean().default(false),
});

/**
 * Where a block's numbers came from. Rendered, not hidden: the whole product states
 * its provenance, and an answer assembled by a model needs it more than most.
 */
export const citationSchema = z
  .object({
    tool: z.string().optional(),
    call_id: z.string().optional(),
    row_count: z.number().optional(),
    as_of: z.string().optional(),
    truncated: z.boolean().optional(),
    filters: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type SpecCitation = z.infer<typeof citationSchema>;

export const specBlockSchema = z
  .object({
    type: z.string(),
    title: z.string().default(""),
    subtitle: z.string().nullish(),
    severity: z.string().nullish(),
    message: z.string().nullish(),
    orientation: z.string().nullish(),
    /*
      `stat_callout` carries its single figure on the BLOCK, not in `items` or `values` —
      observed in live responses. Without these four the callout rendered as "nothing to
      show" while the answer plainly contained a number.
    */
    raw: z.union([z.number(), z.string(), z.null()]).optional(),
    format: valueFormat.optional(),
    display: z.string().optional(),
    masked: z.boolean().optional(),
    values: z.array(specValueSchema).nullish(),
    items: z
      .array(
        z.object({
          label: z.string(),
          detail: z.string().nullish(),
          value: specValueSchema.nullish(),
          /** `kpi_row` items arrive flattened — label/raw/format on the item itself. */
          raw: z.union([z.number(), z.string(), z.null()]).optional(),
          format: valueFormat.optional(),
          display: z.string().optional(),
          masked: z.boolean().optional(),
        }),
      )
      .nullish(),
    series: z.array(seriesSchema).nullish(),
    table: specTableSchema.nullish(),
    citation: citationSchema.nullish(),
  })
  .passthrough();

export type SpecBlock = z.infer<typeof specBlockSchema>;

export const infographicSpecSchema = z
  .object({
    version: z.string(),
    narrative: z.string().default(""),
    blocks: z.array(specBlockSchema).default([]),
    followups: z.array(z.string()).default([]),
    caveats: z.array(z.string()).default([]),
    refusal_code: z.string().nullish(),
    meta: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export type InfographicSpec = z.infer<typeof infographicSpecSchema>;

export const askUsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    /** Rupees, computed server-side from the model's own pricing table. */
    cost_inr: z.number().optional(),
  })
  .passthrough();

export const askResponseSchema = z
  .object({
    conversation_id: z.string(),
    message_id: z.string(),
    spec: infographicSpecSchema,
    usage: askUsageSchema.optional(),
    validation: z.unknown().optional(),
  })
  .passthrough();

export type AskResponse = z.infer<typeof askResponseSchema>;

export interface AskInput {
  message: string;
  /** Continue a thread. Ownership and scope are re-checked server-side. */
  conversationId?: string;
  /** `panel` is the quick answer; `analyst` spends more effort and tokens. */
  mode?: "panel" | "analyst";
}

/**
 * Ask a question.
 *
 * `stream: false` deliberately. The function CAN stream, but it buffers every block
 * until the validator has passed them — only the narrative would arrive early. Half a
 * sentence with no figures is not a useful partial state, and a streamed answer that
 * the validator then rejects would have to be retracted on screen, which is worse than
 * waiting. Answers take 15–25 seconds, so the page shows what it is doing instead.
 */
export async function askAgent(input: AskInput, signal?: AbortSignal): Promise<AskResponse> {
  return invokeEdgeFn(
    AI_AGENT_FN,
    {
      message: input.message,
      mode: input.mode ?? "panel",
      stream: false,
      ...(input.conversationId !== undefined ? { conversation_id: input.conversationId } : {}),
    },
    askResponseSchema,
    { ...(signal ? { signal } : {}) },
  );
}
