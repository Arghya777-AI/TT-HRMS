/**
 * claim-receipt-extract — read a receipt so the claimant does not have to type it.
 *
 * Asked for: "when user upload invoice or related document OCR will capture and
 * will update information (it should ask to update details or user want to fill
 * manually)". The second half of that sentence is the important half, and it is
 * enforced here rather than left to the screen: this function EXTRACTS and
 * RETURNS. It writes nothing to the claim. The employee decides whether to
 * accept what was read, and their own typing always wins.
 *
 * ── WHY CLAUDE VISION AND NOT AN OCR VENDOR ───────────────────────────────────
 *
 * The project already holds an `ANTHROPIC_API_KEY`, a per-month rupee budget
 * (`ai.monthly_budget_inr`), a cost ledger with a `document_extract` category
 * already permitted by `ck_aul__feature`, and a rate-limit bucket sized to
 * protect that budget. A dedicated OCR vendor would mean a second key, a second
 * bill and a second thing to govern, to read a few hundred receipts a month.
 * Native image input also reads a crumpled auto receipt and a GST invoice
 * without a layout template, which is most of what arrives here.
 *
 * ── THE THREE REFUSALS THAT MATTER ────────────────────────────────────────────
 *
 *  1. ONLY `EXPENSE_RECEIPT` DOCUMENTS. Not a general "read this document with
 *     AI" endpoint. RLS already decides which documents the caller may see — but
 *     a manager may legitimately see a subordinate's Aadhaar, and this function
 *     would happily transcribe it. Restricting the type keeps the capability to
 *     the thing it was asked for rather than to everything the reader can open.
 *
 *  2. LOW CONFIDENCE COMES BACK AS NULL. The model reports a confidence per
 *     field; anything under `MIN_CONFIDENCE` is blanked here, on the server,
 *     before it is ever sent. An amount is money — a plausible-looking wrong
 *     figure that someone taps "use these details" on is far worse than an empty
 *     box. The confidence is returned alongside so the screen can say how sure it
 *     was rather than implying certainty.
 *
 *  3. A SPENT BUDGET IS NOT AN OUTAGE. When the monthly cap is reached this
 *     returns a plain "unavailable" that the form is expected to swallow and
 *     carry on with manual entry. A cost control that stops people claiming
 *     their own money back would be a worse failure than the overspend it
 *     prevents.
 *
 * Auth model U (`verifyUser` + `claim.submit`), no `config.toml` entry, so the
 * gateway's `verify_jwt = true` default applies.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  conflict,
  methodNotAllowed,
  notFound,
  ok,
  toProblem,
  unavailable,
} from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { istToday, nowMs } from "../_shared/datetime.ts";
import {
  asCaller,
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  serviceClient,
  sql as sqlHandle,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { requireCapDb, verifyUser } from "../_shared/auth.ts";
import { auditDataAccess } from "../_shared/audit.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { loadAnthropic } from "../_shared/deps.ts";

const FN_NAME = "claim-receipt-extract";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** The one document type this may read. See refusal 1 in the header. */
const RECEIPT_TYPE_CODE = "EXPENSE_RECEIPT";

/**
 * Below this, a field is returned as null rather than as a guess.
 *
 * 0.55 rather than something stricter because the cost of a null is one field
 * typed by hand, while the cost of a wrong amount is a wrong payment — but a
 * floor set too high makes the feature useless and everyone types everything.
 */
const MIN_CONFIDENCE = 0.55;

/** spec-architecture §0 fixes the model; `ANTHROPIC_MODEL` is the escape hatch. */
const DEFAULT_MODEL = "claude-opus-5";

/** Per-million-token USD, mirroring `ai-agent`'s catalogue. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const FALLBACK_PRICING = { input: 5, output: 25 };
const DEFAULT_USD_INR = 88;

/** 10 MB — `document_types.max_file_size_mb` for this type. Base64 inflates it by 4/3. */
const MAX_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const PDF_MIME = "application/pdf";

const ExtractBody = z.object({ document_id: common.uuid }).strict();

interface DocRow {
  id: string;
  storage_bucket: string | null;
  storage_path: string | null;
  mime_type: string | null;
  employee_id: string | null;
  virus_scan_status: string;
  document_types: { code: string | null } | null;
}

/**
 * Two parallel objects rather than one `{value, confidence}` per field: the
 * schema stays flat enough for the model to fill reliably, and the client gets
 * one object it can spread into form state and one it can render as a caveat.
 */
const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fields", "confidence", "notes"],
  properties: {
    fields: {
      type: "object",
      additionalProperties: false,
      required: [
        "total_amount_rupees",
        "bill_date",
        "vendor_name",
        "gst_number",
        "description",
        "travel_mode",
      ],
      properties: {
        total_amount_rupees: {
          anyOf: [{ type: "number" }, { type: "null" }],
          description:
            "The total payable on the bill in rupees, including tax. Null if no total is legible.",
        },
        bill_date: {
          anyOf: [{ type: "string", format: "date" }, { type: "null" }],
          description: "The date printed on the bill as YYYY-MM-DD. Null if absent or ambiguous.",
        },
        vendor_name: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Who issued the bill.",
        },
        gst_number: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description:
            "The 15-character GSTIN exactly as printed. Null unless clearly a GSTIN.",
        },
        description: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "One short line describing what was bought or the journey taken.",
        },
        travel_mode: {
          anyOf: [
            {
              type: "string",
              enum: [
                "taxi",
                "auto",
                "bus",
                "bike",
                "car",
                "company_bike",
                "company_car",
                "train",
                "flight",
                "other",
              ],
            },
            { type: "null" },
          ],
          description: "Only if the bill itself shows the mode of travel. Null otherwise.",
        },
      },
    },
    confidence: {
      type: "object",
      additionalProperties: false,
      required: [
        "total_amount_rupees",
        "bill_date",
        "vendor_name",
        "gst_number",
        "description",
        "travel_mode",
      ],
      properties: {
        total_amount_rupees: { type: "number" },
        bill_date: { type: "number" },
        vendor_name: { type: "number" },
        gst_number: { type: "number" },
        description: { type: "number" },
        travel_mode: { type: "number" },
      },
    },
    notes: {
      type: "string",
      description:
        "One sentence for the employee if something is off — blurred, cropped, more than one bill in the photo. Empty string when the bill reads cleanly.",
    },
  },
} as const;

const SYSTEM_PROMPT = [
  "You read expense receipts and invoices for an Indian hospitality company and return their fields as data.",
  "",
  "Report only what is legible on the document. When a field is absent, unclear, or you are inferring it from context rather than reading it, return null for that field and a low confidence — a null costs the employee one typed box, a wrong amount costs a wrong payment.",
  "Confidence is 0 to 1 and describes how certain you are that you read that field correctly, not how likely the value is to be typical.",
  "Amounts are the total payable including tax, in rupees, as a number without separators or a currency symbol.",
  "Dates: Indian bills are usually DD/MM/YYYY. If a date could be either DD/MM or MM/DD and both are plausible, say so in notes and lower the confidence rather than picking one.",
  "Never invent a GSTIN. Return it only when 15 characters are clearly printed.",
].join("\n");

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface AnthropicMessage {
  content?: { type?: string; text?: string }[];
  usage?: AnthropicUsage;
  stop_reason?: string;
  model?: string;
}

interface MessagesClient {
  messages: { create: (params: Record<string, unknown>) => Promise<unknown> };
}

const extractedSchema = z.object({
  fields: z.object({
    total_amount_rupees: z.number().nullable(),
    bill_date: z.string().nullable(),
    vendor_name: z.string().nullable(),
    gst_number: z.string().nullable(),
    description: z.string().nullable(),
    travel_mode: z.string().nullable(),
  }),
  confidence: z.object({
    total_amount_rupees: z.number(),
    bill_date: z.number(),
    vendor_name: z.number(),
    gst_number: z.number(),
    description: z.number(),
    travel_mode: z.number(),
  }),
  notes: z.string(),
});

type Extracted = z.infer<typeof extractedSchema>;

function billingMonth(): string {
  return istToday().slice(0, 7);
}

function costOf(model: string, usage: AnthropicUsage) {
  const price = PRICING[model] ?? FALLBACK_PRICING;
  const inTok = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const inputUsd =
    (inTok * price.input + cacheRead * price.input * 0.1 + cacheWrite * price.input * 1.25) /
    1_000_000;
  const outputUsd = (outTok * price.output) / 1_000_000;
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}

/** Base64 without blowing the stack on a multi-megabyte file. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Blank anything the model was not sure about. Server-side on purpose: a client
 * that forgot to check the confidence would otherwise present a guess as a
 * reading, and this is the only place that can guarantee it never happens.
 */
function gateByConfidence(raw: Extracted): Extracted {
  const f = { ...raw.fields };
  const c = raw.confidence;
  if (c.total_amount_rupees < MIN_CONFIDENCE) f.total_amount_rupees = null;
  if (c.bill_date < MIN_CONFIDENCE) f.bill_date = null;
  if (c.vendor_name < MIN_CONFIDENCE) f.vendor_name = null;
  if (c.gst_number < MIN_CONFIDENCE) f.gst_number = null;
  if (c.description < MIN_CONFIDENCE) f.description = null;
  if (c.travel_mode < MIN_CONFIDENCE) f.travel_mode = null;
  // A non-positive amount is not a reading, whatever the model's confidence.
  if (f.total_amount_rupees !== null && !(f.total_amount_rupees > 0)) f.total_amount_rupees = null;
  return { fields: f, confidence: c, notes: raw.notes };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;
  const started = nowMs();
  let status = 500;

  try {
    assertOriginAllowed(req);
    const auth = await verifyUser(req);
    const client = sqlHandle();
    await requireCapDb(client, auth, "claim.submit");
    await enforce(RATE_LIMITS.aiAsk, limitKey(FN_NAME, auth.userId));

    const { data: body } = await parseBody(req, ExtractBody, { instance, requestId });

    // ── The key, then the budget — both before a single token is spent ────────
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    if (apiKey.trim() === "") {
      status = 503;
      return unavailable(
        "Reading receipts automatically is switched off. Type the details in and attach the bill as usual.",
        "OCR_DISABLED",
      ).toResponse(cors);
    }

    const budgetRows = await client<{ budget_inr: string | null; spent_inr: string | null; usd_inr: string | null }[]>`
      SELECT (SELECT (s.value #>> '{}')::numeric
                FROM public.settings s
               WHERE s.key = 'ai.monthly_budget_inr'
               ORDER BY (s.scope = 'global') DESC
               LIMIT 1)                                  AS budget_inr,
             (SELECT COALESCE(SUM(l.total_cost_inr), 0)
                FROM public.ai_usage_ledger l
               WHERE l.billing_month = ${billingMonth()}) AS spent_inr,
             (SELECT (s.value #>> '{}')::numeric
                FROM public.settings s
               WHERE s.key = 'ai.usd_inr_rate'
               LIMIT 1)                                   AS usd_inr
    `;
    const budgetRow = firstRow(budgetRows) ?? { budget_inr: null, spent_inr: "0", usd_inr: null };
    const budgetInr = Number(budgetRow.budget_inr ?? 0);
    const spentInr = Number(budgetRow.spent_inr ?? 0);
    const envRate = Number(Deno.env.get("AI_USD_INR_RATE") ?? "");
    const usdInr = Number(budgetRow.usd_inr ?? 0) > 0
      ? Number(budgetRow.usd_inr)
      : Number.isFinite(envRate) && envRate > 0
      ? envRate
      : DEFAULT_USD_INR;

    if (budgetInr <= 0 || spentInr >= budgetInr) {
      log.warn("ocr budget kill switch", { budgetInr, spentInr, billingMonth: billingMonth() });
      status = 503;
      return unavailable(
        "Reading receipts automatically has paused for this month. Type the details in — the bill you attached is still saved with the claim.",
        "OCR_BUDGET_EXCEEDED",
      ).toResponse(cors);
    }

    // ── The document, through the caller's own RLS ────────────────────────────
    const caller = asCaller(auth.token);
    const { data, error } = await caller
      .from("documents")
      .select(
        "id, storage_bucket, storage_path, mime_type, employee_id, virus_scan_status, document_types(code)",
      )
      .eq("id", body.document_id)
      .is("deleted_at", null)
      .limit(1);
    if (error !== null) throw error;

    const doc = firstRow((data ?? []) as DocRow[]);
    // 404, not 403 — the caller must not learn that a document they cannot see exists.
    if (doc === null) {
      status = 404;
      return notFound("That receipt is not available.", "DOCUMENT_NOT_FOUND").toResponse(cors);
    }

    if (doc.document_types?.code !== RECEIPT_TYPE_CODE) {
      status = 409;
      return conflict(
        "Only an expense receipt can be read automatically.",
        "DOCUMENT_NOT_A_RECEIPT",
      ).toResponse(cors);
    }
    if (doc.virus_scan_status === "infected") {
      status = 409;
      return conflict(
        "This file was flagged by the virus scanner and cannot be opened.",
        "DOCUMENT_INFECTED",
      ).toResponse(cors);
    }
    if (doc.storage_path === null || doc.storage_bucket === null) {
      status = 409;
      return conflict(
        "There is no file stored against this receipt yet.",
        "DOCUMENT_NO_FILE",
      ).toResponse(cors);
    }

    const mime = (doc.mime_type ?? "").toLowerCase();
    const isImage = (IMAGE_MIME as readonly string[]).includes(mime);
    const isPdf = mime === PDF_MIME;
    if (!isImage && !isPdf) {
      status = 409;
      return conflict(
        "That file type cannot be read automatically. A photo or a PDF of the bill can be.",
        "DOCUMENT_UNREADABLE_TYPE",
      ).toResponse(cors);
    }

    // ── Bytes ────────────────────────────────────────────────────────────────
    const download = await serviceClient().storage
      .from(doc.storage_bucket)
      .download(doc.storage_path);
    if (download.error !== null || download.data === null) {
      log.warn("receipt download failed", { err: download.error, documentId: doc.id });
      status = 409;
      return conflict(
        "The receipt record exists but its file is not in storage, so there is nothing to read.",
        "DOCUMENT_FILE_MISSING",
      ).toResponse(cors);
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) {
      status = 409;
      return conflict(
        "That file is too large to read automatically. Attach a smaller photo of the bill.",
        "DOCUMENT_TOO_LARGE",
      ).toResponse(cors);
    }

    // ── The model turn ───────────────────────────────────────────────────────
    const model = Deno.env.get("ANTHROPIC_MODEL")?.trim() || DEFAULT_MODEL;
    const AnthropicClass = await loadAnthropic();
    const anthropic = new AnthropicClass({ apiKey, maxRetries: 1 }) as unknown as MessagesClient;

    const source = { type: "base64", media_type: mime, data: toBase64(bytes) };
    const message = (await anthropic.messages.create({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      // `effort: low` — reading a receipt is perception, not deliberation, and
      // this is charged per claim. The JSON schema does the shaping.
      output_config: { effort: "low", format: { type: "json_schema", schema: RECEIPT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            isPdf ? { type: "document", source } : { type: "image", source },
            { type: "text", text: "Read this receipt and return its fields." },
          ],
        },
      ],
    })) as AnthropicMessage;

    const usage = message.usage ?? {};
    const usd = costOf(model, usage);
    const inr = usd.totalUsd * usdInr;

    // Record the spend even when parsing fails below — the tokens were spent
    // either way, and a ledger that only counts successes understates the bill.
    const ctx: RequestContext = {
      actorId: auth.userId,
      source: "edge_function",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      reason: "receipt read automatically to pre-fill a reimbursement claim",
    };
    await withContext(ctx, async (tx) => {
      await tx`
        INSERT INTO public.ai_usage_ledger
          (profile_id, model, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, input_cost_usd, output_cost_usd,
           total_cost_usd, usd_inr_rate, total_cost_inr, billing_month, feature)
        VALUES (
          ${auth.userId}::uuid,
          ${model}::text,
          ${usage.input_tokens ?? 0}::integer,
          ${usage.output_tokens ?? 0}::integer,
          ${usage.cache_read_input_tokens ?? 0}::integer,
          ${usage.cache_creation_input_tokens ?? 0}::integer,
          ${usd.inputUsd}::numeric,
          ${usd.outputUsd}::numeric,
          ${usd.totalUsd}::numeric,
          ${usdInr}::numeric,
          ${inr}::numeric,
          ${billingMonth()}::text,
          'document_extract'::text
        )
      `;
      await auditDataAccess(tx, ctx, {
        accessKind: "ai_query",
        entityTable: "documents",
        entityId: doc.id,
        subjectEmployeeId: doc.employee_id,
        fields: ["storage_path", "mime_type"],
        purpose: "read an expense receipt to pre-fill a claim",
        recordCount: 1,
      });
    });

    if (message.stop_reason === "refusal") {
      status = 409;
      return conflict(
        "That file could not be read automatically. Type the details in instead.",
        "OCR_REFUSED",
      ).toResponse(cors);
    }

    const text = (message.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    let parsed: Extracted;
    try {
      parsed = extractedSchema.parse(JSON.parse(text));
    } catch (parseErr) {
      log.warn("receipt extraction did not parse", { err: parseErr, documentId: doc.id });
      status = 409;
      return conflict(
        "The bill could not be read clearly enough to fill the form. Type the details in — it is still attached to the claim.",
        "OCR_UNREADABLE",
      ).toResponse(cors);
    }

    const gated = gateByConfidence(parsed);
    status = 200;
    return ok({
      document_id: doc.id,
      fields: gated.fields,
      confidence: gated.confidence,
      notes: gated.notes,
      /** So the screen can say what it cost to read, if it ever needs to. */
      cost_inr: Number(inr.toFixed(4)),
      model,
    }, { headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId);
    status = problem.status;
    if (problem.status >= 500) log.error("unhandled failure", { err });
    return problem.toResponse(cors);
  } finally {
    log.info("request complete", { status, durationMs: nowMs() - started });
  }
});
