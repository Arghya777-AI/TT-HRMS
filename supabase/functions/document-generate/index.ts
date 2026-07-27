/**
 * document-generate — catalogue #11, auth model **U** (`document.generate`).
 *
 * Render a `contract_templates` body against resolved variables, produce a PDF,
 * store it in the document type's private bucket, and record it in
 * `public.documents` + `public.document_versions` with its SHA-256 — so the file
 * that is served can always be proven to be the file that was generated
 * (migration 025: "checksum_sha256 … proves the file served equals the file
 * signed").
 *
 * Follows the 12-step lifecycle of spec-architecture §4 verbatim; the reference
 * walk-through is `kiosk-heartbeat/index.ts`.
 *
 * FOUR RULES THIS FUNCTION ENFORCES, EACH LEARNED FROM A REAL DEFECT CLASS
 *
 *  1. AN UNRESOLVED TOKEN NEVER SHIPS. spec-admin §Comms: "unresolved token
 *     blocks send". Every `{{token}}` in the template body must resolve — from
 *     the request, or from a declared deterministic `source` path — or the call
 *     is a 422 naming the tokens. A contract that says "Dear {{first_name}}" is
 *     worse than no contract.
 *
 *  2. VARIABLE VALUES ARE DATA, NEVER MARKUP. Values are markup-escaped before
 *     substitution and substitution is single-pass, so a value can neither
 *     inject formatting, break a table, nor smuggle a second token.
 *
 *  3. THE RENDERER REFUSES WHAT IT CANNOT DRAW. pdf-lib without fontkit can only
 *     encode WinAnsi (Latin-1 + CP1252). Kannada/Devanagari text would be
 *     silently drawn as `?????` in a legal document, so it is a 422 instead. See
 *     the DB/system gap note at the foot of this file.
 *
 *  4. STORAGE AND THE ROW AGREE OR NEITHER EXISTS. The object is uploaded first
 *     (Storage has no transaction), then the metadata rows are written in ONE
 *     `withContext` transaction. If that transaction fails the object is
 *     removed, so `documents` never points at a missing file and the bucket
 *     never holds an unreferenced PDF.
 *
 * NOT DONE HERE, DELIBERATELY: nothing is emailed (that is `communication-send`),
 * no signature chain is started (that is `esign-flow`), and no long-lived URL is
 * ever minted — a download URL is returned only when explicitly asked for, is
 * short-lived, and writes `document_access_log` first.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  badGateway,
  methodNotAllowed,
  notFound,
  ok,
  toProblem,
  unprocessable,
  type ProblemErrorItem,
} from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { financialYear, istDate, istToday, now, nowIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  serviceClient,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { requireCapWithStepUp, verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { claim, release, replayResponse, requestHash, requireIdempotencyKey, store } from "../_shared/idempotency.ts";
import { loadPdfLib } from "../_shared/deps.ts";

const FN_NAME = "document-generate";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;
const CAP = "document.generate";

/** A rendered letter is a few pages of text; anything larger is a mistake, not a document. */
const MAX_BODY_BYTES = 128 * 1024;
/** Ceiling on the produced PDF. Well above a 40-page handbook at ~2 KB/page. */
const MAX_PDF_BYTES = 8 * 1024 * 1024;
/** `security.signed_url_default_ttl_seconds` (migration 046 seeds 300). */
const SIGNED_URL_TTL_SECONDS = 300;

// ═════════════════════════════════════════════════════════════════════════════
// Request contract
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A merge value. `{{` is refused so a value can never re-open the token syntax,
 * which is what makes the "no unresolved token" check below sound.
 */
const VariableValue = z.union([
  z.string().max(4_000).refine((v) => !v.includes("{{"), {
    message: "A variable value may not contain `{{`.",
  }),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const GenerateBody = z
  .object({
    /** One of the two template selectors. `template_code` is resolved per company. */
    template_id: common.uuid.optional(),
    template_code: z.string().trim().min(1).max(64).optional(),
    /** One of the two document-type selectors; defaults to the template's own type link. */
    document_type_id: common.uuid.optional(),
    document_type_code: z.string().trim().min(1).max(64).optional(),

    employee_id: common.uuid.nullish(),
    /** `ck_documents__subject_kind`. `employee` demands `employee_id`. */
    subject_kind: z
      .enum(["employee", "company", "policy", "asset", "payroll_run", "event", "vendor"])
      .default("employee"),
    /** Only needed when there is no employee to inherit it from. */
    company_id: common.uuid.optional(),
    /** Links the render to a contract row and unlocks the `contract.*` sources. */
    contract_id: common.uuid.optional(),

    title: z.string().trim().min(1).max(200).optional(),
    variables: z.record(z.string().min(1).max(80), VariableValue).default({}),

    issue_date: common.isoDate.nullish(),
    expiry_date: common.isoDate.nullish(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    is_confidential: z.boolean().optional(),
    requires_acknowledgement: z.boolean().optional(),
    acknowledgement_due_on: common.isoDate.nullish(),

    /** Render and report, write nothing. No idempotency key needed. */
    dry_run: z.boolean().default(false),
    /** Return a short-lived signed URL; writes `document_access_log` first. */
    include_download_url: z.boolean().default(false),
    /** Mandatory when a URL is minted (`document_access_log.purpose`). */
    purpose: z.string().trim().min(10).max(500).optional(),
  })
  .strict()
  .refine((b) => b.template_id !== undefined || b.template_code !== undefined, {
    message: "Provide template_id or template_code.",
    path: ["template_id"],
  })
  .refine((b) => b.subject_kind !== "employee" || (b.employee_id ?? null) !== null, {
    message: "subject_kind 'employee' requires employee_id (ck_documents__employee_when_subject).",
    path: ["employee_id"],
  })
  .refine((b) => !b.include_download_url || b.purpose !== undefined, {
    message: "A download URL requires a purpose of at least 10 characters — it is written to document_access_log.",
    path: ["purpose"],
  });

/** The client-side contract for this endpoint. */
export type GenerateInput = z.infer<typeof GenerateBody>;

// ═════════════════════════════════════════════════════════════════════════════
// Text safety — what the standard fonts can actually encode
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The CP1252 0x80–0x9F block, which WinAnsiEncoding supports on top of Latin-1.
 * Without these, an en dash or a curly quote from a template would be rejected.
 */
const CP1252_EXTRAS =
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ" +
  "‘’“”•–—˜™š›œžŸ";

/** Characters that are safe to silently normalise rather than reject. */
const NORMALISE: readonly [RegExp, string][] = [
  [/₹/g, "Rs."], // ₹ — not in WinAnsi, and "Rs." is the legally accepted form
  [/[     ]/g, " "], // fixed-width and non-breaking spaces
  [/[​‌‍﻿]/g, ""], // zero-width joiners and the BOM
  [/−/g, "-"], // minus sign → hyphen
  [/[⁄∕]/g, "/"], // fraction slashes
  [/\t/g, "    "],
  [/\r\n?/g, "\n"],
];

function normaliseText(input: string): string {
  let out = input;
  for (const [re, to] of NORMALISE) out = out.replace(re, to);
  return out;
}

function isEncodable(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x0a) return true; // newline is structure, not a glyph
  if (cp >= 0x20 && cp <= 0x7e) return true; // ASCII printable
  if (cp >= 0xa1 && cp <= 0xff) return true; // Latin-1 supplement
  return CP1252_EXTRAS.includes(ch);
}

/**
 * Collect every character the standard fonts cannot draw. Returned rather than
 * substituted: a contract with `?????` where a name should be is a defect that
 * reaches a court, so the caller is told instead.
 */
function unencodableCharacters(text: string): string[] {
  const bad = new Set<string>();
  for (const ch of text) {
    if (!isEncodable(ch)) bad.add(ch);
  }
  return [...bad];
}

/** Neutralise markup in a substituted value: it is data, never formatting. */
function escapeMarkup(value: string): string {
  return value.replace(/([\\*`|])/g, "\\$1");
}

// ═════════════════════════════════════════════════════════════════════════════
// Markdown → blocks
// ═════════════════════════════════════════════════════════════════════════════

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
}

type Block =
  | { kind: "heading"; level: number; runs: Run[] }
  | { kind: "para"; runs: Run[] }
  | { kind: "item"; ordered: boolean; depth: number; marker: string; runs: Run[] }
  | { kind: "quote"; runs: Run[] }
  | { kind: "rule" }
  | { kind: "pagebreak" }
  | { kind: "table"; header: Run[][] | null; rows: Run[][][] };

const EMPTY_RUN: Run = { text: "", bold: false, italic: false, mono: false };

/**
 * Inline markup: `**bold**`, `*italic*`, `` `mono` ``, `\` escapes.
 *
 * `_underscore_` italics are deliberately NOT supported: resolved values are
 * full of snake_case (`fixed_term`, `employee_code`) and a template author must
 * not have to think about whether a merged value will turn the rest of a clause
 * italic.
 */
function inlineRuns(src: string): Run[] {
  const runs: Run[] = [];
  let bold = false;
  let italic = false;
  let mono = false;
  let buf = "";
  const flush = (): void => {
    if (buf !== "") {
      runs.push({ text: buf, bold, italic, mono });
      buf = "";
    }
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === "\\" && next !== undefined && "\\*`|".includes(next)) {
      buf += next;
      i++;
      continue;
    }
    if (!mono && c === "*" && next === "*") {
      flush();
      bold = !bold;
      i++;
      continue;
    }
    if (!mono && c === "*") {
      flush();
      italic = !italic;
      continue;
    }
    if (c === "`") {
      flush();
      mono = !mono;
      continue;
    }
    buf += c;
  }
  flush();
  return runs.length > 0 ? runs : [EMPTY_RUN];
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^(\s*)[-+*]\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const RULE_RE = /^\s*([-*_])\1{2,}\s*$/;
const PAGEBREAK_RE = /^\s*(\\pagebreak|---pagebreak---|<!--\s*pagebreak\s*-->)\s*$/i;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP_RE = /^\s*\|[\s:|-]+\|\s*$/;

function tableCells(line: string): Run[][] {
  const inner = (TABLE_ROW_RE.exec(line) as RegExpExecArray)[1] as string;
  // Split on unescaped pipes only — `\|` is a literal pipe inside a cell.
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string;
    if (c === "\\" && inner[i + 1] === "|") {
      buf += "\\|";
      i++;
      continue;
    }
    if (c === "|") {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  cells.push(buf);
  return cells.map((c) => inlineRuns(c.trim()));
}

function parseMarkdown(body: string): Block[] {
  const lines = normaliseText(body).split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "para", runs: inlineRuns(paragraph.join(" ").trim()) });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    if (PAGEBREAK_RE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "pagebreak" });
      continue;
    }
    if (TABLE_ROW_RE.test(line)) {
      flushParagraph();
      const rows: Run[][][] = [];
      let header: Run[][] | null = null;
      let first = true;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i] as string)) {
        const current = lines[i] as string;
        if (TABLE_SEP_RE.test(current)) {
          // The separator promotes the row above it to a header.
          if (first === false && header === null && rows.length === 1) header = rows.shift() ?? null;
          i++;
          continue;
        }
        rows.push(tableCells(current));
        first = false;
        i++;
      }
      i--; // the outer loop will step past the last consumed line
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (RULE_RE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: (heading[1] as string).length,
        runs: inlineRuns((heading[2] as string).trim()),
      });
      continue;
    }
    if (line.trimStart().startsWith("> ")) {
      flushParagraph();
      blocks.push({ kind: "quote", runs: inlineRuns(line.trimStart().slice(2).trim()) });
      continue;
    }
    const ol = OL_RE.exec(line);
    if (ol !== null) {
      flushParagraph();
      blocks.push({
        kind: "item",
        ordered: true,
        depth: Math.min(2, Math.floor((ol[1] as string).length / 2)),
        marker: `${ol[2]}.`,
        runs: inlineRuns((ol[3] as string).trim()),
      });
      continue;
    }
    const ul = UL_RE.exec(line);
    if (ul !== null) {
      flushParagraph();
      const depth = Math.min(2, Math.floor((ul[1] as string).length / 2));
      blocks.push({
        kind: "item",
        ordered: false,
        depth,
        marker: depth === 0 ? "•" : "–",
        runs: inlineRuns((ul[2] as string).trim()),
      });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

// ═════════════════════════════════════════════════════════════════════════════
// PDF rendering
// ═════════════════════════════════════════════════════════════════════════════

/** A4 portrait, in PDF points. */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 68;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BODY_SIZE = 10.5;
const BODY_LEADING = 15.2;
const HEADING_SIZES: Record<number, number> = { 1: 17, 2: 13.5, 3: 12, 4: 11, 5: 11, 6: 11 };

interface PdfFonts {
  regular: unknown;
  bold: unknown;
  italic: unknown;
  boldItalic: unknown;
  mono: unknown;
}

/** Minimal structural view of the pdf-lib objects this file touches. */
interface MeasurableFont {
  widthOfTextAtSize(text: string, size: number): number;
}
interface DrawablePage {
  drawText(text: string, opts: Record<string, unknown>): void;
  drawLine(opts: Record<string, unknown>): void;
  drawRectangle(opts: Record<string, unknown>): void;
}

function fontFor(fonts: PdfFonts, run: Run): MeasurableFont {
  if (run.mono) return fonts.mono as MeasurableFont;
  if (run.bold && run.italic) return fonts.boldItalic as MeasurableFont;
  if (run.bold) return fonts.bold as MeasurableFont;
  if (run.italic) return fonts.italic as MeasurableFont;
  return fonts.regular as MeasurableFont;
}

interface Piece {
  text: string;
  font: MeasurableFont;
  size: number;
}

/** Greedy word wrap across a run sequence. Returns one `Piece[]` per visual line. */
function wrapRuns(runs: readonly Run[], fonts: PdfFonts, size: number, maxWidth: number): Piece[][] {
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let used = 0;

  const commit = (): void => {
    // Whitespace at either edge of a wrapped line carries no meaning, and a
    // leading space would silently indent the line by a few points.
    while (line.length > 0 && (line[line.length - 1] as Piece).text.trim() === "") line.pop();
    while (line.length > 0 && (line[0] as Piece).text.trim() === "") line.shift();
    if (line.length > 0) {
      const last = line[line.length - 1] as Piece;
      line[line.length - 1] = { ...last, text: last.text.replace(/\s+$/, "") };
      const head = line[0] as Piece;
      line[0] = { ...head, text: head.text.replace(/^\s+/, "") };
    }
    lines.push(line);
    line = [];
    used = 0;
  };

  for (const run of runs) {
    if (run.text === "") continue;
    const font = fontFor(fonts, run);
    const runSize = run.mono ? size - 0.5 : size;
    // Keep the space attached to the word before it so widths stay exact.
    const words = run.text.match(/\S+\s*|\s+/g) ?? [];
    for (const word of words) {
      const w = font.widthOfTextAtSize(word, runSize);
      if (used > 0 && used + font.widthOfTextAtSize(word.trimEnd(), runSize) > maxWidth) commit();
      if (w > maxWidth && word.trim().length > 1) {
        // A single token longer than the line (a URL, a long code): hard-split it.
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, runSize) > maxWidth && chunk !== "") {
            line.push({ text: chunk, font, size: runSize });
            commit();
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        if (chunk !== "") {
          line.push({ text: chunk, font, size: runSize });
          used += font.widthOfTextAtSize(chunk, runSize);
        }
        continue;
      }
      line.push({ text: word, font, size: runSize });
      used += w;
    }
  }
  commit();
  return lines.length > 0 ? lines : [[]];
}

export interface RenderInput {
  bodyMarkdown: string;
  title: string;
  /** Printed above the title on page 1. */
  companyLine: string;
  /** Small print on every page footer, left side. */
  reference: string;
  /** Small print on every page footer, right of the page numbers. */
  governingLaw: string | null;
}

export interface RenderResult {
  bytes: Uint8Array;
  pageCount: number;
  /** The substituted markdown, for `contracts.rendered_html` and previews. */
  plainText: string;
}

/**
 * Draw the document. Everything is laid out top-down in one pass and the footers
 * are stamped afterwards, because "Page 1 of 4" cannot be written until the
 * fourth page exists.
 */
async function renderPdf(input: RenderInput): Promise<RenderResult> {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();

  const pdf = await PDFDocument.create();
  const fonts: PdfFonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const ink = rgb(0.07, 0.12, 0.22); // brand navy #121F38
  const muted = rgb(0.42, 0.42, 0.45);
  const ruleColor = rgb(0.8, 0.8, 0.82);
  const zebra = rgb(0.96, 0.955, 0.95);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN_TOP;

  const nextPage = (): void => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN_TOP;
  };
  const ensure = (needed: number): void => {
    if (y - needed < MARGIN_BOTTOM) nextPage();
  };
  const drawLinePieces = (pieces: readonly Piece[], x: number, baseline: number): void => {
    let cursor = x;
    for (const p of pieces) {
      if (p.text !== "") {
        (page as unknown as DrawablePage).drawText(p.text, {
          x: cursor,
          y: baseline,
          size: p.size,
          font: p.font,
          color: ink,
        });
      }
      cursor += p.font.widthOfTextAtSize(p.text, p.size);
    }
  };

  // ── Page-1 masthead ───────────────────────────────────────────────────────
  const company = wrapRuns([{ ...EMPTY_RUN, text: input.companyLine, bold: true }], fonts, 10, CONTENT_W);
  for (const l of company) {
    y -= 13;
    drawLinePieces(l, MARGIN_X, y);
  }
  y -= 8;
  for (const l of wrapRuns([{ ...EMPTY_RUN, text: input.title, bold: true }], fonts, 18, CONTENT_W)) {
    y -= 22;
    drawLinePieces(l, MARGIN_X, y);
  }
  y -= 10;
  (page as unknown as DrawablePage).drawLine({
    start: { x: MARGIN_X, y },
    end: { x: PAGE_W - MARGIN_X, y },
    thickness: 0.9,
    color: ruleColor,
  });
  y -= 18;

  // ── Body ──────────────────────────────────────────────────────────────────
  const blocks = parseMarkdown(input.bodyMarkdown);
  for (const block of blocks) {
    switch (block.kind) {
      case "pagebreak": {
        nextPage();
        break;
      }
      case "rule": {
        ensure(16);
        y -= 8;
        (page as unknown as DrawablePage).drawLine({
          start: { x: MARGIN_X, y },
          end: { x: PAGE_W - MARGIN_X, y },
          thickness: 0.7,
          color: ruleColor,
        });
        y -= 10;
        break;
      }
      case "heading": {
        const size = HEADING_SIZES[block.level] ?? 11;
        const bolded = block.runs.map((r) => ({ ...r, bold: true }));
        const lines = wrapRuns(bolded, fonts, size, CONTENT_W);
        ensure(size * 1.4 * lines.length + 8);
        y -= block.level <= 2 ? 14 : 10;
        for (const l of lines) {
          y -= size * 1.35;
          drawLinePieces(l, MARGIN_X, y);
        }
        y -= 5;
        break;
      }
      case "para": {
        const lines = wrapRuns(block.runs, fonts, BODY_SIZE, CONTENT_W);
        for (const l of lines) {
          ensure(BODY_LEADING);
          y -= BODY_LEADING;
          drawLinePieces(l, MARGIN_X, y);
        }
        y -= 6;
        break;
      }
      case "quote": {
        const indent = 16;
        const lines = wrapRuns(
          block.runs.map((r) => ({ ...r, italic: true })),
          fonts,
          BODY_SIZE,
          CONTENT_W - indent,
        );
        for (const l of lines) {
          ensure(BODY_LEADING);
          y -= BODY_LEADING;
          (page as unknown as DrawablePage).drawRectangle({
            x: MARGIN_X,
            y: y - 3,
            width: 2,
            height: BODY_LEADING,
            color: ruleColor,
          });
          drawLinePieces(l, MARGIN_X + indent, y);
        }
        y -= 6;
        break;
      }
      case "item": {
        const indent = 16 + block.depth * 16;
        const markerW = 14;
        const lines = wrapRuns(block.runs, fonts, BODY_SIZE, CONTENT_W - indent - markerW);
        for (let li = 0; li < lines.length; li++) {
          ensure(BODY_LEADING);
          y -= BODY_LEADING;
          if (li === 0) {
            (page as unknown as DrawablePage).drawText(block.marker, {
              x: MARGIN_X + indent,
              y,
              size: BODY_SIZE,
              font: fonts.regular,
              color: ink,
            });
          }
          drawLinePieces(lines[li] as Piece[], MARGIN_X + indent + markerW, y);
        }
        y -= 2;
        break;
      }
      case "table": {
        const bodyRows = block.rows;
        const columnCount = Math.max(
          block.header?.length ?? 0,
          ...bodyRows.map((r) => r.length),
          1,
        );
        // Column widths in proportion to the widest natural cell, floored so a
        // narrow column stays readable.
        const natural = new Array<number>(columnCount).fill(0);
        const allRows = block.header === null ? bodyRows : [block.header, ...bodyRows];
        for (const row of allRows) {
          for (let c = 0; c < columnCount; c++) {
            const cell = row[c] ?? [];
            const w = cell.reduce(
              (sum, run) => sum + fontFor(fonts, run).widthOfTextAtSize(run.text, BODY_SIZE),
              0,
            );
            if (w > (natural[c] as number)) natural[c] = w;
          }
        }
        const naturalTotal = natural.reduce((a, b) => a + b, 0) || 1;
        const minWidth = 46;
        const widths = natural.map((n) =>
          Math.max(minWidth, (n / naturalTotal) * (CONTENT_W - 12 * columnCount))
        );
        const scale = (CONTENT_W - 12 * columnCount) / (widths.reduce((a, b) => a + b, 0) || 1);
        const finalWidths = widths.map((w) => w * Math.min(1, scale));

        const drawRow = (row: Run[][], isHeader: boolean, striped: boolean): void => {
          const cellLines = finalWidths.map((w, c) =>
            wrapRuns(
              (row[c] ?? []).map((r) => (isHeader ? { ...r, bold: true } : r)),
              fonts,
              BODY_SIZE,
              w,
            )
          );
          const rowLines = Math.max(1, ...cellLines.map((l) => l.length));
          const rowHeight = rowLines * BODY_LEADING + 6;
          if (y - rowHeight < MARGIN_BOTTOM) {
            nextPage();
            if (block.header !== null && !isHeader) drawRow(block.header, true, false);
          }
          if (striped) {
            (page as unknown as DrawablePage).drawRectangle({
              x: MARGIN_X - 2,
              y: y - rowHeight + 4,
              width: CONTENT_W + 4,
              height: rowHeight,
              color: zebra,
            });
          }
          let top = y;
          for (let li = 0; li < rowLines; li++) {
            top -= BODY_LEADING;
            let x = MARGIN_X;
            for (let c = 0; c < columnCount; c++) {
              const l = (cellLines[c] as Piece[][])[li];
              if (l !== undefined) drawLinePieces(l, x, top);
              x += (finalWidths[c] as number) + 12;
            }
          }
          y -= rowHeight;
          (page as unknown as DrawablePage).drawLine({
            start: { x: MARGIN_X - 2, y: y + 3 },
            end: { x: PAGE_W - MARGIN_X + 2, y: y + 3 },
            thickness: 0.5,
            color: ruleColor,
          });
        };

        ensure(BODY_LEADING * 2 + 12);
        y -= 6;
        if (block.header !== null) drawRow(block.header, true, false);
        bodyRows.forEach((row, idx) => drawRow(row, false, idx % 2 === 1));
        y -= 8;
        break;
      }
    }
  }

  // ── Footers, now that the page count is known ─────────────────────────────
  const pages = pdf.getPages();
  const generated = `Generated ${istDate(nowIso())} IST`;
  pages.forEach((p: unknown, index: number) => {
    const target = p as DrawablePage;
    const left = input.reference;
    const centre = `Page ${index + 1} of ${pages.length}`;
    const right = input.governingLaw ?? generated;
    target.drawLine({
      start: { x: MARGIN_X, y: MARGIN_BOTTOM - 22 },
      end: { x: PAGE_W - MARGIN_X, y: MARGIN_BOTTOM - 22 },
      thickness: 0.5,
      color: ruleColor,
    });
    target.drawText(left, {
      x: MARGIN_X,
      y: MARGIN_BOTTOM - 34,
      size: 7.5,
      font: fonts.regular,
      color: muted,
    });
    const centreW = (fonts.regular as MeasurableFont).widthOfTextAtSize(centre, 7.5);
    target.drawText(centre, {
      x: (PAGE_W - centreW) / 2,
      y: MARGIN_BOTTOM - 34,
      size: 7.5,
      font: fonts.regular,
      color: muted,
    });
    const rightW = (fonts.regular as MeasurableFont).widthOfTextAtSize(right, 7.5);
    target.drawText(right, {
      x: PAGE_W - MARGIN_X - rightW,
      y: MARGIN_BOTTOM - 34,
      size: 7.5,
      font: fonts.regular,
      color: muted,
    });
  });

  pdf.setTitle(input.title);
  pdf.setAuthor(input.companyLine);
  pdf.setSubject(input.reference);
  pdf.setProducer("Tamarind Tree HRMS");
  pdf.setCreator("Tamarind Tree HRMS · document-generate");
  pdf.setCreationDate(now());
  pdf.setModificationDate(now());

  const bytes = await pdf.save({ useObjectStreams: false });
  return {
    bytes,
    pageCount: pages.length,
    plainText: normaliseText(input.bodyMarkdown),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Variable resolution
// ═════════════════════════════════════════════════════════════════════════════

/** Integer paise → `Rs. 1,23,456.00` with Indian digit grouping. D-04 respected: no floats. */
export function formatPaise(paise: number | bigint | null | undefined): string {
  if (paise === null || paise === undefined) return "";
  const value = typeof paise === "bigint" ? paise : BigInt(Math.trunc(Number(paise)));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rupees = (abs / 100n).toString();
  const fraction = (abs % 100n).toString().padStart(2, "0");
  let grouped: string;
  if (rupees.length <= 3) {
    grouped = rupees;
  } else {
    const last3 = rupees.slice(-3);
    let rest = rupees.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest.length > 0) parts.unshift(rest);
    grouped = `${parts.join(",")},${last3}`;
  }
  return `${negative ? "-" : ""}Rs. ${grouped}.${fraction}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** `2026-07-26` → `26 July 2026`. The form Indian letters use. */
export function formatLongDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m === null) return "";
  const month = MONTHS[Number(m[2]) - 1] ?? "";
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** A `date`/`timestamptz` as postgres.js hydrates it, flattened to `YYYY-MM-DD`. */
function toIsoDate(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return istDate(value);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return istDate(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/**
 * The allowlist of deterministic `source` paths a template may declare.
 *
 * DELIBERATELY ABSENT: anything from `employee_statutory`, `employee_bank_accounts`
 * or `employee_salary_revisions`. Those are masked-by-default columns whose read
 * must go through a reveal endpoint that writes `data_access_log` (§6). A
 * template that needs a salary figure receives it in `variables`, from a client
 * that has already paid that price — this function will not become a silent
 * salary-reveal channel.
 */
function buildSourceContext(rows: {
  employee: Record<string, unknown> | null;
  company: Record<string, unknown>;
  contract: Record<string, unknown> | null;
  template: Record<string, unknown>;
  documentTypeName: string;
  title: string;
}): Map<string, string> {
  const ctx = new Map<string, string>();
  const put = (key: string, value: unknown): void => {
    ctx.set(key, str(value));
  };

  const e = rows.employee;
  if (e !== null) {
    put("employee.employee_code", e.employee_code);
    put("employee.title", e.title);
    put("employee.first_name", e.first_name);
    put("employee.middle_name", e.middle_name);
    put("employee.last_name", e.last_name);
    put("employee.display_name", e.display_name);
    put("employee.preferred_name", e.preferred_name);
    put(
      "employee.full_name",
      [e.first_name, e.middle_name, e.last_name].filter((p) => str(p) !== "").join(" "),
    );
    put("employee.work_email", e.work_email);
    put("employee.personal_email", e.personal_email);
    put("employee.mobile", e.mobile);
    put("employee.date_of_birth", toIsoDate(e.date_of_birth));
    put("employee.date_of_birth_long", formatLongDate(toIsoDate(e.date_of_birth)));
    put("employee.date_of_join", toIsoDate(e.date_of_join));
    put("employee.date_of_join_long", formatLongDate(toIsoDate(e.date_of_join)));
    put("employee.employment_type", e.employment_type);
    put("employee.employment_status", e.employment_status);
    put("employee.probation_months", e.probation_months);
    put("employee.notice_period_days", e.notice_period_days);
    put("employee.confirmation_due_date", toIsoDate(e.confirmation_due_date));
    put("employee.contract_start_date", toIsoDate(e.contract_start_date));
    put("employee.contract_end_date", toIsoDate(e.contract_end_date));
    put("employee.work_order_number", e.work_order_number);
    put("employee.designation", e.designation_name);
    put("employee.department", e.department_name);
    put("employee.section", e.section_name);
    put("employee.grade", e.grade_name);
    put("employee.location", e.location_name);
    put("employee.cost_centre", e.cost_centre_name);
    put("employee.reporting_manager", e.reporting_manager_name);
    put("employee.reporting_manager_designation", e.reporting_manager_designation);
  }

  const c = rows.company;
  put("company.code", c.code);
  put("company.name", c.name);
  put("company.legal_name", c.legal_name);
  put("company.trade_name", c.trade_name);
  put("company.entity_type", c.entity_type);
  put("company.registration_number", c.registration_number);
  put("company.pan", c.pan);
  put("company.gstin", c.gstin);
  put("company.shops_establishment_reg", c.shops_establishment_reg);
  put("company.registered_address", c.registered_address_text);

  const k = rows.contract;
  if (k !== null) {
    put("contract.contract_number", k.contract_number);
    put("contract.contract_kind", k.contract_kind);
    put("contract.start_date", toIsoDate(k.start_date));
    put("contract.start_date_long", formatLongDate(toIsoDate(k.start_date)));
    put("contract.end_date", toIsoDate(k.end_date));
    put("contract.end_date_long", formatLongDate(toIsoDate(k.end_date)));
    put("contract.probation_months", k.probation_months);
    put("contract.notice_period_days", k.notice_period_days);
    put("contract.monthly_ctc", formatPaise(k.monthly_ctc_paise as number | null));
    put("contract.annual_ctc", formatPaise(k.annual_ctc_paise as number | null));
    put("contract.working_hours_text", k.working_hours_text);
    put("contract.weekly_off_text", k.weekly_off_text);
    put("contract.candidate_name", k.candidate_name);
    put("contract.candidate_email", k.candidate_email);
    put("contract.candidate_mobile", k.candidate_mobile);
    put("contract.designation", k.designation_name);
    put("contract.department", k.department_name);
    put("contract.location", k.location_name);
    put("contract.grade", k.grade_name);
    put("contract.reporting_manager", k.reporting_manager_name);
  }

  const t = rows.template;
  put("template.code", t.code);
  put("template.name", t.name);
  put("template.version", t.version);
  put("template.governing_law", t.governing_law);
  put("template.jurisdiction", t.jurisdiction);
  put("template.contract_kind", t.contract_kind);

  const today = istToday();
  put("today.date", today);
  put("today.date_long", formatLongDate(today));
  put("today.financial_year", financialYear(today));
  put("document.title", rows.title);
  put("document.type", rows.documentTypeName);
  return ctx;
}

const TOKEN_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_.]{0,79})\s*\}\}/g;

interface TemplateVariable {
  token: string;
  label?: string;
  required?: boolean;
  source?: string;
}

interface Resolution {
  values: Record<string, string>;
  missing: string[];
  body: string;
}

/**
 * Resolve every token the body uses. Precedence: the request's `variables` win,
 * then the declared `source` path, then the token is missing.
 *
 * A token that appears in the body but is NOT declared in
 * `contract_templates.variables` is treated as REQUIRED. A legal document with a
 * blank where a name belongs must fail loudly, and forgetting to declare a
 * variable is exactly how that blank happens.
 */
function resolveVariables(
  bodyMarkdown: string,
  declared: readonly TemplateVariable[],
  supplied: Record<string, string | number | boolean | null>,
  sources: Map<string, string>,
): Resolution {
  const declaredByToken = new Map<string, TemplateVariable>();
  for (const v of declared) {
    if (typeof v?.token === "string" && v.token !== "") declaredByToken.set(v.token, v);
  }

  const used = new Set<string>();
  for (const match of bodyMarkdown.matchAll(TOKEN_RE)) used.add(match[1] as string);

  const values: Record<string, string> = {};
  const missing: string[] = [];

  const resolveOne = (token: string): string | null => {
    if (Object.prototype.hasOwnProperty.call(supplied, token)) {
      const raw = supplied[token];
      const asString = raw === null ? "" : str(raw);
      if (asString !== "") return asString;
    }
    const spec = declaredByToken.get(token);
    const source = typeof spec?.source === "string" ? spec.source : null;
    if (source !== null) {
      // A source may itself be one of the allowlisted paths, or `literal:<text>`.
      if (source.startsWith("literal:")) return source.slice("literal:".length);
      const fromSource = sources.get(source);
      if (fromSource !== undefined && fromSource !== "") return fromSource;
    }
    // Convention: a token whose own name is an allowlisted path resolves itself,
    // so `{{employee.display_name}}` works with no declaration at all.
    const direct = sources.get(token);
    if (direct !== undefined && direct !== "") return direct;
    return null;
  };

  for (const token of used) {
    const resolved = resolveOne(token);
    const spec = declaredByToken.get(token);
    const required = spec === undefined ? true : spec.required !== false;
    if (resolved === null) {
      if (required) missing.push(token);
      values[token] = "";
    } else {
      values[token] = resolved;
    }
  }

  // Declared-and-required tokens that the body never uses are still reported:
  // it means the template and its variable list have drifted apart.
  for (const [token, spec] of declaredByToken) {
    if (spec.required === true && !used.has(token) && resolveOne(token) === null) {
      missing.push(token);
    }
  }

  // ONE pass, so a substituted value is never rescanned for tokens.
  const body = bodyMarkdown.replace(TOKEN_RE, (_whole, token: string) =>
    escapeMarkup(values[token] ?? ""));

  return { values, missing: [...new Set(missing)].sort(), body };
}

// ═════════════════════════════════════════════════════════════════════════════
// Small helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `_shared/auth.ts` hashes strings; a PDF is bytes, and the checksum in
 * `documents.checksum_sha256` must be of the exact bytes that were stored.
 *
 * The copy into a fresh `ArrayBuffer` is deliberate: a `Uint8Array` may be backed
 * by a `SharedArrayBuffer`, which is not a `BufferSource`, and pinning the type
 * here keeps this compiling on every TypeScript version rather than only the one
 * that widened `Uint8Array` to a generic.
 */
async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Storage-object-safe slug. Never the source of truth for the display title. */
function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug === "" ? fallback : slug;
}

// ═════════════════════════════════════════════════════════════════════════════
// Handler
// ═════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ──────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;
  /** Set once the object is in the bucket, so a failed transaction can undo it. */
  let uploaded: { bucket: string; path: string } | null = null;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model U) ─────────────────────────────────────────────
    const auth = await verifyUser(req);
    const db = sql();

    // ── STEP 5 · Authority, from the DATABASE ───────────────────────────────
    // `requireCapWithStepUp` resolves both the capability and whether it demands
    // `aal2` from `public.role_capabilities` (migration 050), so revoking
    // `document.generate` takes effect without a redeploy.
    await requireCapWithStepUp(db, auth, CAP);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    // Per actor, outside any transaction: a rejected render still spends a token.
    await enforce(RATE_LIMITS.mutation, limitKey(FN_NAME, auth.userId), "DOCUMENT_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const { data: body, raw } = await parseBody(req, GenerateBody, { maxBytes: MAX_BODY_BYTES });

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // A dry run writes nothing, so it neither needs nor may consume a key — the
    // real generate that follows would otherwise replay the preview.
    if (!body.dry_run) {
      idempotencyKey = requireIdempotencyKey(req);
      const hash = await requestHash(FN_NAME, raw, auth.userId);
      const claimed = await claim({
        key: idempotencyKey,
        fnName: FN_NAME,
        requestHash: hash,
        actorId: auth.userId,
      });
      if (claimed.state === "replay") {
        status = claimed.status;
        log.info("idempotent replay", { key: idempotencyKey });
        return replayResponse(claimed, { ...cors, "x-request-id": requestId });
      }
    }

    // ── Load the template, type and merge sources (reads, before the write txn)
    const templateRows = await db`
      SELECT t.id,
             t.company_id,
             t.code,
             t.name,
             t.contract_kind,
             t.body_markdown,
             t.variables,
             t.governing_law,
             t.jurisdiction,
             t.version,
             t.is_published,
             t.requires_witness,
             t.default_clause_ids,
             c.code                     AS company_code,
             c.name                     AS company_name,
             c.legal_name,
             c.trade_name,
             c.entity_type,
             c.registration_number,
             c.pan,
             c.gstin,
             c.shops_establishment_reg,
             concat_ws(', ',
               c.registered_address #>> '{line1}',
               c.registered_address #>> '{line2}',
               c.registered_address #>> '{city}',
               c.registered_address #>> '{state}',
               c.registered_address #>> '{pincode}')  AS registered_address_text
        FROM public.contract_templates t
        JOIN public.companies c ON c.id = t.company_id AND c.deleted_at IS NULL
       WHERE t.deleted_at IS NULL
         AND t.is_active
         AND (
           (${body.template_id ?? null}::uuid IS NOT NULL AND t.id = ${body.template_id ?? null}::uuid)
           OR (
             ${body.template_id ?? null}::uuid IS NULL
             AND t.code = ${body.template_code ?? null}::text
             AND (${body.company_id ?? null}::uuid IS NULL OR t.company_id = ${body.company_id ?? null}::uuid)
           )
         )
       ORDER BY t.version DESC
       LIMIT 1
    `;
    const template = firstRow(templateRows as unknown as Record<string, unknown>[]);
    if (template === null) {
      // 404, never "exists but forbidden" (§4).
      throw notFound("No such template, or it is not active.", "TEMPLATE_NOT_FOUND");
    }
    if (template.is_published !== true) {
      throw unprocessable(
        [{
          pointer: "/template_id",
          code: "not_published",
          detail: "This template is a draft. Publish it before generating documents from it.",
        }],
        "The template is not published.",
        "TEMPLATE_NOT_PUBLISHED",
      );
    }

    // Prefer the type the caller named; fall back to the type that points at
    // this template (`document_types.template_id`).
    const typeRows = await db`
      SELECT dt.id,
             dt.code,
             dt.name,
             dt.category,
             dt.requires_approval,
             dt.requires_acknowledgement,
             dt.acknowledgement_deadline_days,
             dt.requires_esign,
             dt.requires_expiry,
             dt.is_sensitive,
             dt.storage_bucket,
             dt.retention_years,
             dt.retention_basis,
             dt.max_file_size_mb
        FROM public.document_types dt
       WHERE dt.deleted_at IS NULL
         AND dt.is_active
         AND (
           (${body.document_type_id ?? null}::uuid IS NOT NULL AND dt.id = ${body.document_type_id ?? null}::uuid)
           OR (${body.document_type_id ?? null}::uuid IS NULL
               AND ${body.document_type_code ?? null}::text IS NOT NULL
               AND dt.code = ${body.document_type_code ?? null}::text)
           OR (${body.document_type_id ?? null}::uuid IS NULL
               AND ${body.document_type_code ?? null}::text IS NULL
               AND dt.template_id = ${template.id as string}::uuid)
         )
       ORDER BY dt.sort_order
       LIMIT 1
    `;
    const docType = firstRow(typeRows as unknown as Record<string, unknown>[]);
    if (docType === null) {
      throw unprocessable(
        [{
          pointer: "/document_type_code",
          code: "unresolved",
          detail:
            "No active document type was named, and no document type links to this template. Send document_type_code.",
        }],
        "The document type could not be resolved.",
        "DOCUMENT_TYPE_NOT_FOUND",
      );
    }

    let employee: Record<string, unknown> | null = null;
    if ((body.employee_id ?? null) !== null) {
      const rows = await db`
        SELECT e.id, e.company_id, e.employee_code, e.title, e.first_name, e.middle_name, e.last_name,
               e.display_name, e.preferred_name, e.work_email, e.personal_email, e.mobile,
               e.date_of_birth, e.date_of_join, e.employment_type::text AS employment_type,
               e.employment_status::text AS employment_status, e.probation_months,
               e.notice_period_days, e.confirmation_due_date, e.contract_start_date,
               e.contract_end_date, e.work_order_number,
               d.name  AS designation_name,
               dep.name AS department_name,
               sec.name AS section_name,
               g.name  AS grade_name,
               l.name  AS location_name,
               cc.name AS cost_centre_name,
               m.display_name AS reporting_manager_name,
               md.name        AS reporting_manager_designation
          FROM public.employees e
          LEFT JOIN public.designations  d   ON d.id  = e.designation_id
          LEFT JOIN public.departments   dep ON dep.id = e.department_id
          LEFT JOIN public.sections      sec ON sec.id = e.section_id
          LEFT JOIN public.grades        g   ON g.id  = e.grade_id
          LEFT JOIN public.locations     l   ON l.id  = e.location_id
          LEFT JOIN public.cost_centres  cc  ON cc.id = e.cost_centre_id
          LEFT JOIN public.employees     m   ON m.id  = e.reporting_manager_id AND m.deleted_at IS NULL
          LEFT JOIN public.designations  md  ON md.id = m.designation_id
         WHERE e.id = ${body.employee_id as string}::uuid
           AND e.deleted_at IS NULL
         LIMIT 1
      `;
      employee = firstRow(rows as unknown as Record<string, unknown>[]);
      if (employee === null) throw notFound(undefined, "EMPLOYEE_NOT_FOUND");
    }

    let contract: Record<string, unknown> | null = null;
    if (body.contract_id !== undefined) {
      const rows = await db`
        SELECT k.id, k.contract_number, k.contract_kind, k.start_date, k.end_date,
               k.probation_months, k.notice_period_days, k.monthly_ctc_paise, k.annual_ctc_paise,
               k.working_hours_text, k.weekly_off_text, k.candidate_name, k.candidate_email,
               k.candidate_mobile, k.employee_id, k.status,
               d.name  AS designation_name,
               dep.name AS department_name,
               l.name  AS location_name,
               g.name  AS grade_name,
               m.display_name AS reporting_manager_name
          FROM public.contracts k
          LEFT JOIN public.designations d   ON d.id  = k.designation_id
          LEFT JOIN public.departments  dep ON dep.id = k.department_id
          LEFT JOIN public.locations    l   ON l.id  = k.location_id
          LEFT JOIN public.grades       g   ON g.id  = k.grade_id
          LEFT JOIN public.employees    m   ON m.id  = k.reporting_manager_id AND m.deleted_at IS NULL
         WHERE k.id = ${body.contract_id}::uuid AND k.deleted_at IS NULL
         LIMIT 1
      `;
      contract = firstRow(rows as unknown as Record<string, unknown>[]);
      if (contract === null) throw notFound(undefined, "CONTRACT_NOT_FOUND");
    }

    const companyId = (employee?.company_id as string | undefined) ??
      body.company_id ??
      (template.company_id as string);

    const title = body.title ??
      `${str(docType.name)}${employee === null ? "" : ` — ${str(employee.display_name)}`}`;

    const sources = buildSourceContext({
      employee,
      company: {
        code: template.company_code,
        name: template.company_name,
        legal_name: template.legal_name,
        trade_name: template.trade_name,
        entity_type: template.entity_type,
        registration_number: template.registration_number,
        pan: template.pan,
        gstin: template.gstin,
        shops_establishment_reg: template.shops_establishment_reg,
        registered_address_text: template.registered_address_text,
      },
      contract,
      template,
      documentTypeName: str(docType.name),
      title,
    });

    const declared = Array.isArray(template.variables)
      ? (template.variables as TemplateVariable[])
      : [];
    const resolution = resolveVariables(
      str(template.body_markdown),
      declared,
      body.variables as Record<string, string | number | boolean | null>,
      sources,
    );

    if (resolution.missing.length > 0) {
      // spec-admin: an unresolved merge token blocks the send. Same rule here,
      // one pointer per token so the console can highlight the exact inputs.
      const errors: ProblemErrorItem[] = resolution.missing.map((token) => ({
        pointer: `/variables/${token.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        code: "unresolved_token",
        detail: `The template needs a value for {{${token}}} and none could be resolved.`,
      }));
      throw unprocessable(
        errors,
        `${errors.length} template variable${errors.length === 1 ? "" : "s"} could not be resolved.`,
        "TEMPLATE_VARIABLES_UNRESOLVED",
      );
    }

    // Rule 3: refuse what the standard fonts cannot draw, rather than printing
    // question marks into a legal document. Everything that reaches `drawText`
    // is checked — body, title, masthead and footer alike.
    const renderable = normaliseText(
      [title, str(template.legal_name), str(template.jurisdiction), resolution.body].join("\n"),
    );
    const badChars = unencodableCharacters(renderable);
    if (badChars.length > 0) {
      throw unprocessable(
        [{
          pointer: "/variables",
          code: "unencodable_characters",
          detail:
            `These characters cannot be drawn with the built-in PDF fonts: ${badChars.slice(0, 12).join(" ")}. ` +
            "Latin script only until a Unicode font is embedded.",
        }],
        "The document contains characters the renderer cannot draw.",
        "PDF_UNSUPPORTED_CHARACTERS",
      );
    }

    // ── Render ──────────────────────────────────────────────────────────────
    const reference = contract === null
      ? `${str(docType.code)} · ${str(template.code)} v${str(template.version)}`
      : `${str(contract.contract_number)} · ${str(template.code)} v${str(template.version)}`;

    const rendered = await renderPdf({
      bodyMarkdown: resolution.body,
      title: normaliseText(title),
      companyLine: str(template.legal_name),
      reference,
      governingLaw: str(template.jurisdiction) === "" ? null : `Jurisdiction: ${str(template.jurisdiction)}`,
    });

    if (rendered.bytes.byteLength > MAX_PDF_BYTES) {
      throw unprocessable(
        [{ pointer: "", code: "too_large", detail: "The rendered PDF exceeds the size ceiling." }],
        "The rendered document is too large to store.",
        "PDF_TOO_LARGE",
      );
    }
    const maxTypeBytes = Number(docType.max_file_size_mb ?? 10) * 1024 * 1024;
    if (rendered.bytes.byteLength > maxTypeBytes) {
      throw unprocessable(
        [{
          pointer: "",
          code: "too_large",
          detail: `This document type allows at most ${str(docType.max_file_size_mb)} MB.`,
        }],
        "The rendered document exceeds the type's file-size limit.",
        "PDF_TOO_LARGE",
      );
    }

    const checksum = await sha256HexBytes(rendered.bytes);

    if (body.dry_run) {
      status = 200;
      const preview = {
        dry_run: true as const,
        template: {
          id: template.id,
          code: template.code,
          name: template.name,
          version: Number(template.version),
        },
        document_type: { id: docType.id, code: docType.code, name: docType.name },
        title,
        page_count: rendered.pageCount,
        file_size_bytes: rendered.bytes.byteLength,
        checksum_sha256: checksum,
        variables_resolved: resolution.values,
        rendered_markdown: rendered.plainText,
        request_id: requestId,
      };
      return ok(preview, { status, headers: cors, requestId });
    }

    // ── Upload FIRST (Storage is not transactional) ──────────────────────────
    const bucket = str(docType.storage_bucket) === "" ? "documents" : str(docType.storage_bucket);
    const fileName = `${slugify(title, str(docType.code).toLowerCase())}.pdf`;
    // `<company_id>/<employee_id|company>/<TYPE_CODE>/<uuid>-<file>` — foldername[2]
    // is the employee id, which is what the `documents__own_write` storage policy
    // in migration 039 keys on.
    const objectPath = [
      companyId,
      (body.employee_id ?? null) === null ? "company" : (body.employee_id as string),
      str(docType.code),
      `${crypto.randomUUID()}-${fileName}`,
    ].join("/");

    const upload = await serviceClient().storage.from(bucket).upload(objectPath, rendered.bytes, {
      contentType: "application/pdf",
      upsert: false,
      cacheControl: "no-store",
    });
    if (upload.error !== null) {
      // Storage is an upstream dependency, not our logic: 502, and the detail
      // never carries the provider message (it can contain the bucket URL).
      log.error("storage upload failed", { bucket, err: upload.error });
      throw badGateway("The document could not be stored. Try again.", "STORAGE_UPLOAD_FAILED", {
        cause: upload.error,
      });
    }
    uploaded = { bucket, path: objectPath };

    // ── STEP 9 · app.set_context + ONE transaction ──────────────────────────
    const ctx: RequestContext = {
      actorId: auth.userId,
      actorRole: auth.role,
      source: "web_admin",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      // `public.documents` is in audit.reason_required_tables with applies_to
      // 'update_delete', so this INSERT needs no reason — but the contract UPDATE
      // and any future edit does, and a request-scoped reason is always honest.
      reason: body.purpose ?? `${FN_NAME}: render ${str(docType.code)} from template ${str(template.code)}`,
    };

    const result = await withContext(ctx, async (tx) => {
      // Re-check the capability inside the transaction so the authorisation
      // decision and the write share one snapshot.
      await requireCapWithStepUp(tx, auth, CAP);

      const inserted = await tx`
        INSERT INTO public.documents (
          document_type_id, company_id, subject_kind, employee_id, title, file_name,
          storage_bucket, storage_path, mime_type, file_size_bytes, checksum_sha256,
          page_count, current_version, status, issue_date, expiry_date, uploaded_by,
          is_system_generated, generated_from_template_id, source_reference,
          requires_acknowledgement, acknowledgement_due_on, tags, is_confidential,
          virus_scan_status, retention_until
        )
        VALUES (
          ${docType.id as string}::uuid,
          ${companyId}::uuid,
          ${body.subject_kind}::text,
          ${body.employee_id ?? null}::uuid,
          ${title}::text,
          ${fileName}::text,
          ${bucket}::text,
          ${objectPath}::text,
          'application/pdf',
          ${rendered.bytes.byteLength}::bigint,
          ${checksum}::text,
          ${rendered.pageCount}::integer,
          1,
          ${docType.requires_approval === true ? "pending_review" : "approved"}::public.document_status,
          ${body.issue_date ?? null}::date,
          ${body.expiry_date ?? null}::date,
          ${auth.userId}::uuid,
          true,
          ${template.id as string}::uuid,
          ${JSON.stringify({
        template_code: template.code,
        template_version: Number(template.version),
        document_type_code: docType.code,
        contract_id: body.contract_id ?? null,
        request_id: requestId,
        generated_by: auth.userId,
        generated_at: nowIso(),
        variables: resolution.values,
      })}::jsonb,
          ${body.requires_acknowledgement ?? (docType.requires_acknowledgement === true)}::boolean,
          COALESCE(
            ${body.acknowledgement_due_on ?? null}::date,
            CASE WHEN ${docType.requires_acknowledgement === true}::boolean
                       AND ${docType.acknowledgement_deadline_days ?? null}::integer IS NOT NULL
                 THEN (util.ist_today() + make_interval(days => ${docType.acknowledgement_deadline_days ?? 0}::integer))::date
            END
          ),
          ${body.tags}::text[],
          ${body.is_confidential ?? (docType.is_sensitive === true)}::boolean,
          -- Never touched a browser upload: there is nothing for a scanner to do.
          -- 'skipped' is an honest state; 'clean' would be a claim we cannot make.
          'skipped',
          CASE ${str(docType.retention_basis)}::text
            WHEN 'from_upload' THEN (util.ist_today() + make_interval(years => ${Number(docType.retention_years ?? 8)}::integer))::date
            WHEN 'from_expiry' THEN CASE WHEN ${body.expiry_date ?? null}::date IS NOT NULL
                                         THEN (${body.expiry_date ?? null}::date + make_interval(years => ${Number(docType.retention_years ?? 8)}::integer))::date
                                    END
          END
        )
        RETURNING id, title, status::text AS status, storage_bucket, storage_path,
                  file_name, file_size_bytes, checksum_sha256, page_count,
                  requires_acknowledgement, acknowledgement_due_on, retention_until
      `;
      const doc = firstRow(inserted as unknown as Record<string, unknown>[]);
      if (doc === null) throw badGateway("The document row could not be written.", "DOCUMENT_INSERT_FAILED");

      // Version 1 of 1. Migration 025: replacing a document never overwrites
      // storage, so version rows exist from the very first render.
      await tx`
        INSERT INTO public.document_versions
          (document_id, version, storage_path, file_name, file_size_bytes,
           checksum_sha256, mime_type, page_count, uploaded_by, is_current)
        VALUES (
          ${doc.id as string}::uuid, 1, ${objectPath}::text, ${fileName}::text,
          ${rendered.bytes.byteLength}::bigint, ${checksum}::text, 'application/pdf',
          ${rendered.pageCount}::integer, ${auth.userId}::uuid, true
        )
      `;

      // Link the render back to its contract, if there is one. `contracts` is
      // audited but not reason-required; the trigger writes the field-level rows.
      if (contract !== null) {
        await tx`
          UPDATE public.contracts
             SET rendered_pdf_document_id = ${doc.id as string}::uuid,
                 rendered_html            = ${rendered.plainText}::text,
                 variables                = ${JSON.stringify(resolution.values)}::jsonb,
                 contract_template_id     = COALESCE(contract_template_id, ${template.id as string}::uuid),
                 status                   = CASE WHEN status = 'draft' THEN 'draft' ELSE status END
           WHERE id = ${contract.id as string}::uuid
        `;
        await tx`
          INSERT INTO public.contract_events (contract_id, event, payload, ip, recorded_by)
          VALUES (
            ${contract.id as string}::uuid,
            'created',
            ${JSON.stringify({
          document_id: doc.id,
          template_code: template.code,
          template_version: Number(template.version),
          checksum_sha256: checksum,
          request_id: requestId,
        })}::jsonb,
            ${clientIpFrom(req)}::inet,
            ${auth.userId}::uuid
          )
        `;
      }

      // ── STEP 10 · Audit, in the SAME transaction ──────────────────────────
      // Nothing explicit: `trg_documents__audit`, `trg_contracts__audit` and
      // `trg_document_versions__*` all fire `audit.log_changes()` inside this
      // transaction and read the actor from the context set above. A second
      // `writeAudit` here would double-log the same fact.

      let downloadUrl: string | null = null;
      if (body.include_download_url) {
        // §6: the access log is written BEFORE the value is handed over.
        await tx`
          INSERT INTO public.document_access_log
            (document_id, accessed_by, accessed_by_role, access_kind, purpose,
             ip, user_agent, signed_url_expires_at, request_id)
          VALUES (
            ${doc.id as string}::uuid,
            ${auth.userId}::uuid,
            ${auth.role}::public.app_role,
            'signed_url_minted',
            ${body.purpose as string}::text,
            ${clientIpFrom(req)}::inet,
            ${userAgentFrom(req)}::text,
            now() + make_interval(secs => ${SIGNED_URL_TTL_SECONDS}::double precision),
            ${requestId}::uuid
          )
        `;
        downloadUrl = "pending";
      }

      return { doc, mintUrl: downloadUrl !== null };
    });

    // The signed URL is minted only after the log row is committed, so a URL can
    // never exist without its access record.
    let downloadUrl: string | null = null;
    let downloadExpiresIn: number | null = null;
    if (result.mintUrl) {
      const signed = await serviceClient().storage
        .from(bucket)
        .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
      if (signed.error !== null || signed.data === null) {
        // The document exists and is recorded; only the convenience URL failed.
        log.warn("signed url mint failed", { err: signed.error });
      } else {
        downloadUrl = signed.data.signedUrl;
        downloadExpiresIn = SIGNED_URL_TTL_SECONDS;
      }
    }

    const doc = result.doc;
    const responseBody = {
      document: {
        id: doc.id,
        title: doc.title,
        status: doc.status,
        document_type_code: docType.code,
        storage_bucket: doc.storage_bucket,
        storage_path: doc.storage_path,
        file_name: doc.file_name,
        mime_type: "application/pdf" as const,
        file_size_bytes: Number(doc.file_size_bytes),
        checksum_sha256: doc.checksum_sha256,
        page_count: Number(doc.page_count),
        version: 1,
        requires_acknowledgement: doc.requires_acknowledgement === true,
        acknowledgement_due_on: toIsoDate(doc.acknowledgement_due_on) || null,
        retention_until: toIsoDate(doc.retention_until) || null,
      },
      template: {
        id: template.id,
        code: template.code,
        name: template.name,
        version: Number(template.version),
      },
      contract_id: contract === null ? null : contract.id,
      requires_esign: docType.requires_esign === true,
      variables_resolved: resolution.values,
      download_url: downloadUrl,
      download_url_expires_in_seconds: downloadExpiresIn,
      request_id: requestId,
    };
    status = 201;

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);

    log.info("document generated", {
      document_id: doc.id,
      template_code: template.code,
      page_count: Number(doc.page_count),
      bytes: Number(doc.file_size_bytes),
    });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    // Rule 4: no orphan objects. The row and the file live or die together.
    if (uploaded !== null) {
      try {
        await serviceClient().storage.from(uploaded.bucket).remove([uploaded.path]);
        log.warn("rolled back stored object", { bucket: uploaded.bucket });
      } catch (removeErr) {
        // Worth a loud line: the bucket now holds a file nothing references.
        log.error("orphaned storage object", { bucket: uploaded.bucket, path: uploaded.path, err: removeErr });
      }
    }

    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, problem.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }

    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ─────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported for `supabase/tests` and the admin console's shared contract. */
export { GenerateBody, parseMarkdown, renderPdf, resolveVariables, unencodableCharacters };
