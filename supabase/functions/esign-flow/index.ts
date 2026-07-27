/**
 * esign-flow — catalogue #12. Two auth models in one function:
 *   **T** — a signer presents a single-use signed token in the BODY. No JWT, no
 *           DB credential, no session. Actions: `view`, `verify_identity`,
 *           `sign`, `decline`.
 *   **U** — the initiator is an authenticated admin. Actions: `create`, `send`,
 *           `remind`, `seal`, `cancel`, `status`.
 *
 * The two share one function because they share one state machine, and a state
 * machine split across two deployables drifts.
 *
 * ORDERED CHAIN (migration 026). `e_sign_requests.signing_order` is
 * `sequential` or `parallel`. Under `sequential` the only signer who may sign is
 * the one holding the LOWEST `signer_order` among signers not yet
 * signed/declined/expired/delegated; under `parallel` any un-actioned signer may.
 * `e_sign_signers` has a deliberately NON-unique index on
 * `(esign_request_id, signer_order)` because a delegated signer is re-issued as a
 * new row at the same order — "the esign-flow edge function owns order
 * integrity", so that is enforced here and nowhere else.
 *
 * TOKENS. 256 bits from `crypto.getRandomValues`, returned to the caller exactly
 * once and stored only as a SHA-256 in `secure.esign_signer_tokens` (a
 * zero-policy table in a schema that is not on PostgREST — boundary B6). One live
 * token per signer (the table's PK is `signer_id`), so re-issuing rotates and the
 * old value dies. SINGLE-USE means single-SIGNATURE: `view` and
 * `verify_identity` may be repeated by the same signer, but the token is revoked
 * the moment it produces a signature or a declination, so it can never produce a
 * second one. Chain advance mints the NEXT signer a fresh token.
 *
 * WHY A SIGNATURE IS NEVER LOST TO A FAILED SEAL. The final PDF (source document
 * + certificate page) is a DERIVED artefact. The signature itself is committed in
 * its own transaction first; the seal is then attempted, and if Storage or the
 * renderer fails the response is still 200 with `seal_pending: true` and the
 * initiator finishes it with `action: "seal"`. Refusing the signature because a
 * PDF could not be written would be the worse failure.
 *
 * EVERY transition appends to `public.e_sign_events`, which is append-only
 * (`audit.refuse_mutation`), and every row change on `e_sign_requests` /
 * `e_sign_signers` / `contracts` additionally lands on the hash-chained audit log
 * through `audit.log_changes()` — nothing here calls `writeAudit` for those, or
 * the same fact would be logged twice.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  badGateway,
  conflict,
  forbidden,
  gone,
  locked,
  methodNotAllowed,
  notFound,
  ok,
  toProblem,
  unauthorized,
  unprocessable,
} from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger, type Logger } from "../_shared/log.ts";
import { istDate, istTime, now, nowIso, toIso } from "../_shared/datetime.ts";
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
import { hasCapDb, requireCapWithStepUp, sha256Hex, verifyUser, type AuthContext } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { claim, idempotencyKeyFrom, release, replayResponse, requestHash, store } from "../_shared/idempotency.ts";
import { loadPdfLib, type Sql } from "../_shared/deps.ts";

const FN_NAME = "esign-flow";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/**
 * The initiator capability.
 *
 * ⚠ There is no `document.esign.*` row in `public.role_capabilities` (migration
 * 050). `document.generate` is the closest true statement — "this admin may
 * produce and route documents" — and is used so the function is not dead on
 * arrival. See the DB gap note at the foot of the file: two capability rows
 * should be seeded and this constant then split.
 */
const CAP_INITIATE = "document.generate";

/** A drawn signature PNG is the only large field; 512 KB covers it comfortably. */
const MAX_BODY_BYTES = 512 * 1024;
const MAX_SIGNATURE_BYTES = 256 * 1024;
/** `security.signed_url_default_ttl_seconds` (migration 046 seeds 300). */
const SIGNED_URL_TTL_SECONDS = 300;
/** Wrong answers before the signer is locked out of the identity gate. */
const MAX_IDENTITY_ATTEMPTS = 5;
const DEFAULT_TOKEN_TTL_HOURS = 14 * 24;
const MAX_PDF_BYTES = 16 * 1024 * 1024;

/** Statuses in which a signer is still expected to act. */
const OPEN_SIGNER_STATUSES = ["pending", "notified", "viewed", "identity_verified"] as const;
/** Statuses in which the request will accept a signature. */
const SIGNABLE_REQUEST_STATUSES = ["sent", "partially_signed"] as const;

// ═════════════════════════════════════════════════════════════════════════════
// Request contract
// ═════════════════════════════════════════════════════════════════════════════

/** 32 random bytes, base64url — 43 characters. Never logged (log.ts redacts `token`). */
const SignerToken = z.string().trim().min(32).max(128).regex(
  /^[A-Za-z0-9_-]+$/,
  "Malformed signing token.",
);

const IdentityCheckKind = z.enum([
  "none",
  "dob",
  "id_last4",
  "custom_question",
  "otp_email",
  "otp_sms",
]);

const SignerInput = z
  .object({
    signer_order: z.number().int().min(1).max(20),
    signer_kind: z.enum([
      "employee",
      "manager",
      "hr",
      "authorised_signatory",
      "witness",
      "candidate",
      "external",
    ]),
    employee_id: common.uuid.nullish(),
    full_name: z.string().trim().min(2).max(160),
    email: common.email.nullish(),
    /** `ck_e_sign_signers__mobile` — a bare Indian 10-digit number. */
    mobile: z.string().regex(/^[6-9][0-9]{9}$/, "Expected a 10-digit Indian mobile number.").nullish(),
    designation_snapshot: z.string().trim().max(160).nullish(),
    identity_check_kind: IdentityCheckKind.default("none"),
    /** The expected answer, hashed here. Never stored or returned in the clear. */
    identity_check_value: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (s) => s.identity_check_kind === "none" || s.identity_check_value !== undefined ||
      s.identity_check_kind === "otp_email" || s.identity_check_kind === "otp_sms",
    { message: "This identity check needs identity_check_value.", path: ["identity_check_value"] },
  );

const CreateAction = z
  .object({
    action: z.literal("create"),
    document_id: common.uuid.optional(),
    contract_id: common.uuid.optional(),
    subject_employee_id: common.uuid.nullish(),
    title: z.string().trim().min(3).max(200),
    message: z.string().trim().max(2_000).nullish(),
    signing_order: z.enum(["sequential", "parallel"]).default("sequential"),
    expires_in_days: z.number().int().min(1).max(180).default(14),
    reminder_schedule_days: z.array(z.number().int().min(1).max(180)).max(6).optional(),
    signers: z.array(SignerInput).min(1).max(10),
  })
  // NOT `.refine`d: `z.discriminatedUnion` accepts only ZodObject members, and a
  // refinement wraps the object in a ZodEffects that has no `.shape` for the
  // discriminator to be read from. The "document_id or contract_id" rule is
  // therefore asserted in the handler, where it can also resolve a contract's
  // already-rendered PDF.
  .strict();

const SendAction = z
  .object({
    action: z.enum(["send", "remind"]),
    esign_request_id: common.uuid,
    token_ttl_hours: z.number().int().min(1).max(24 * 180).optional(),
    /**
     * Hand the freshly minted signing URLs back so the caller can deliver them
     * (this function does not send email — that is `communication-send`).
     * Off by default: a token in a response is secret material.
     */
    return_links: z.boolean().default(false),
  })
  .strict();

const SealAction = z.object({ action: z.literal("seal"), esign_request_id: common.uuid }).strict();

const CancelAction = z
  .object({
    action: z.literal("cancel"),
    esign_request_id: common.uuid,
    /** `ck_e_sign_requests__cancelled_reason` — at least 10 characters. */
    reason: common.reason,
  })
  .strict();

const StatusAction = z.object({ action: z.literal("status"), esign_request_id: common.uuid }).strict();

const ViewAction = z.object({ action: z.literal("view"), token: SignerToken }).strict();

const VerifyIdentityAction = z
  .object({
    action: z.literal("verify_identity"),
    token: SignerToken,
    answer: z.string().trim().min(1).max(200),
  })
  .strict();

const SignAction = z
  .object({
    action: z.literal("sign"),
    token: SignerToken,
    signature: z
      .object({
        kind: z.enum(["drawn", "typed", "uploaded"]),
        /** PNG, optionally as a `data:image/png;base64,` URL. */
        image_base64: z.string().max(400_000).optional(),
        typed_name: z.string().trim().min(2).max(160).optional(),
      })
      .strict()
      .refine((s) => s.kind !== "typed" || s.typed_name !== undefined, {
        message: "A typed signature needs typed_name.",
        path: ["typed_name"],
      })
      .refine((s) => s.kind === "typed" || s.image_base64 !== undefined, {
        message: "A drawn or uploaded signature needs image_base64 (PNG).",
        path: ["image_base64"],
      }),
    /**
     * IT Act 2000 s.10A: the electronic record must carry the signer's assent.
     * `agreed` must be literally true and the statement is stored verbatim.
     */
    consent: z
      .object({
        agreed: z.literal(true),
        statement: z.string().trim().min(20).max(1_000),
      })
      .strict(),
    pages_signed: z.array(z.number().int().min(1).max(2_000)).max(2_000).optional(),
    /** IANA zone reported by the browser — evidence, never trusted for arithmetic. */
    timezone: z.string().trim().max(64).nullish(),
    geo: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracy_m: z.number().nonnegative().max(100_000).optional(),
      })
      .strict()
      .nullish(),
  })
  .strict();

const DeclineAction = z
  .object({
    action: z.literal("decline"),
    token: SignerToken,
    reason: z.string().trim().min(5).max(1_000),
  })
  .strict();

const EsignBody = z.discriminatedUnion("action", [
  CreateAction,
  SendAction,
  SealAction,
  CancelAction,
  StatusAction,
  ViewAction,
  VerifyIdentityAction,
  SignAction,
  DeclineAction,
]);

type EsignInput = z.infer<typeof EsignBody>;

/** Actions authenticated by a body token (auth model T). */
const TOKEN_ACTIONS: ReadonlySet<string> = new Set(["view", "verify_identity", "sign", "decline"]);
/** Actions that only read. They neither claim nor need an idempotency key. */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(["status"]);

// ═════════════════════════════════════════════════════════════════════════════
// Small primitives
// ═════════════════════════════════════════════════════════════════════════════

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A 256-bit signing token. Returned once, then only its SHA-256 exists. */
function mintTokenValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function decodePngBase64(value: string): Uint8Array {
  const cleaned = value.replace(/^data:image\/png;base64,/i, "").replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch {
    throw unprocessable(
      [{ pointer: "/signature/image_base64", code: "invalid_base64", detail: "The signature image is not valid base64." }],
      "The signature image could not be decoded.",
      "SIGNATURE_IMAGE_INVALID",
    );
  }
  if (binary.length > MAX_SIGNATURE_BYTES) {
    throw unprocessable(
      [{ pointer: "/signature/image_base64", code: "too_large", detail: "The signature image is too large." }],
      "The signature image is too large.",
      "SIGNATURE_IMAGE_INVALID",
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // PNG magic. The `signatures` bucket is declared image/png only (migration 039),
  // and a mislabelled upload would be rejected there — better to fail here, with
  // a pointer, than at the storage boundary.
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || magic.some((b, i) => bytes[i] !== b)) {
    throw unprocessable(
      [{ pointer: "/signature/image_base64", code: "not_png", detail: "The signature image must be a PNG." }],
      "The signature image must be a PNG.",
      "SIGNATURE_IMAGE_INVALID",
    );
  }
  return bytes;
}

/**
 * SHA-256 of raw bytes (`_shared/auth.ts` hashes strings). The copy into a fresh
 * `ArrayBuffer` pins the type: a `Uint8Array` may be backed by a
 * `SharedArrayBuffer`, which is not a `BufferSource`.
 */
async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Canonical form of an identity answer before hashing, so `26-07-1994`,
 * `1994-07-26` and ` 1994-07-26 ` are the same answer, and `abcd`/`ABCD` are the
 * same last-four.
 */
function canonicalIdentityAnswer(kind: string, value: string): string {
  const trimmed = value.trim();
  if (kind === "dob") {
    const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(trimmed);
    if (dmy !== null) {
      return `${dmy[3]}-${(dmy[2] as string).padStart(2, "0")}-${(dmy[1] as string).padStart(2, "0")}`;
    }
    const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(trimmed);
    if (ymd !== null) {
      return `${ymd[1]}-${(ymd[2] as string).padStart(2, "0")}-${(ymd[3] as string).padStart(2, "0")}`;
    }
    return trimmed;
  }
  if (kind === "id_last4") return trimmed.toUpperCase().replace(/\s+/g, "");
  return trimmed.toLowerCase().replace(/\s+/g, " ");
}

/**
 * The standard PDF fonts encode WinAnsi only (see `document-generate`). At
 * `create` time a non-encodable signer name is a 422; here, at seal time, the
 * signature has already legally happened, so an unexpected character is replaced
 * rather than allowed to abort the certificate.
 */
const CP1252_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

function isEncodable(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa1 && cp <= 0xff) return true;
  return CP1252_EXTRAS.includes(ch);
}

export function encodableOrNull(text: string): string | null {
  const bad = [...text].filter((ch) => !isEncodable(ch) && ch !== "\n");
  return bad.length === 0 ? null : [...new Set(bad)].join(" ");
}

function pdfSafe(text: string): string {
  return [...text.replace(/₹/g, "Rs.").replace(/\s+/g, " ")]
    .map((ch) => (isEncodable(ch) ? ch : "?"))
    .join("");
}

/** `2026-07-26T09:14:02Z` → `26-07-2026 14:44 IST`. Evidence is written in IST. */
function istStamp(instant: string | Date): string {
  const date = istDate(instant);
  const [y, m, d] = date.split("-") as [string, string, string];
  return `${d}-${m}-${y} ${istTime(instant).slice(0, 5)} IST`;
}

/** `rakesh@example.com` → `r****h@example.com`. Signers see each other, not each other's contacts. */
function maskEmail(email: string | null): string | null {
  if (email === null || email === "") return null;
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : "";
  return `${head}${"*".repeat(Math.max(1, local.length - head.length - tail.length))}${tail}${email.slice(at)}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Certificate + sealed PDF
// ═════════════════════════════════════════════════════════════════════════════

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;

export interface SealSigner {
  order: number;
  fullName: string;
  signerKind: string;
  email: string | null;
  designation: string | null;
  status: string;
  signedAt: string | null;
  identityCheckKind: string;
  identityVerifiedAt: string | null;
  signatureKind: string | null;
  typedName: string | null;
  ip: string | null;
  userAgent: string | null;
  timezone: string | null;
  pagesSigned: number[] | null;
  /** PNG bytes, already fetched from the `signatures` bucket. */
  signatureImage: Uint8Array | null;
}

export interface SealInput {
  sourcePdf: Uint8Array;
  sourceChecksum: string;
  requestNumber: string;
  title: string;
  companyLine: string;
  legalFramework: string;
  contractNumber: string | null;
  completedAt: string;
  signers: readonly SealSigner[];
}

/**
 * Append the signature certificate to the document that was signed.
 *
 * The source pages are copied verbatim — the signed document must be
 * byte-for-byte the document the signers saw, so nothing is stamped over it. The
 * evidence goes on appended pages: who signed, when in IST, from where, under
 * which identity check, plus the SHA-256 of the source PDF so the pairing is
 * provable years later.
 */
export async function sealPdf(input: SealInput): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();

  const out = await PDFDocument.create();
  const source = await PDFDocument.load(input.sourcePdf, { ignoreEncryption: false });
  const copied = await out.copyPages(source, source.getPageIndices());
  for (const p of copied) out.addPage(p);
  const sourcePageCount = copied.length;

  const regular = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const italic = await out.embedFont(StandardFonts.HelveticaOblique);
  const ink = rgb(0.07, 0.12, 0.22);
  const muted = rgb(0.42, 0.42, 0.45);
  const rule = rgb(0.8, 0.8, 0.82);

  interface Drawable {
    drawText(text: string, opts: Record<string, unknown>): void;
    drawLine(opts: Record<string, unknown>): void;
    drawImage(image: unknown, opts: Record<string, unknown>): void;
  }
  interface Measurable {
    widthOfTextAtSize(text: string, size: number): number;
  }

  let page = out.addPage([PAGE_W, PAGE_H]) as unknown as Drawable;
  let y = PAGE_H - MARGIN;
  const ensure = (needed: number): void => {
    if (y - needed < MARGIN) {
      page = out.addPage([PAGE_W, PAGE_H]) as unknown as Drawable;
      y = PAGE_H - MARGIN;
    }
  };
  const write = (
    text: string,
    opts: { size?: number; font?: unknown; color?: unknown; indent?: number; gap?: number } = {},
  ): void => {
    const size = opts.size ?? 10;
    const font = (opts.font ?? regular) as Measurable;
    const maxWidth = PAGE_W - MARGIN * 2 - (opts.indent ?? 0);
    const words = pdfSafe(text).split(" ");
    let line = "";
    const flush = (): void => {
      if (line === "") return;
      ensure(size * 1.5);
      y -= size * 1.5;
      page.drawText(line, {
        x: MARGIN + (opts.indent ?? 0),
        y,
        size,
        font,
        color: opts.color ?? ink,
      });
      line = "";
    };
    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line !== "") {
        flush();
        line = word;
      } else {
        line = candidate;
      }
    }
    flush();
    if (opts.gap !== undefined) y -= opts.gap;
  };
  const hr = (): void => {
    ensure(10);
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.7,
      color: rule,
    });
    y -= 8;
  };

  write(input.companyLine, { size: 9.5, font: bold, gap: 4 });
  write("Signature Certificate", { size: 17, font: bold, gap: 4 });
  write(
    `This certificate is part of the electronic record and evidences the signatures applied to the document described below.`,
    { size: 9, font: italic, color: muted, gap: 6 },
  );
  hr();

  const facts: [string, string][] = [
    ["Request number", input.requestNumber],
    ["Document", input.title],
    ["Contract number", input.contractNumber ?? "—"],
    ["Source pages", String(sourcePageCount)],
    ["Source SHA-256", input.sourceChecksum],
    ["Completed at", istStamp(input.completedAt)],
    ["Legal framework", input.legalFramework],
  ];
  for (const [label, value] of facts) {
    ensure(15);
    y -= 15;
    page.drawText(pdfSafe(`${label}:`), { x: MARGIN, y, size: 9, font: bold, color: ink });
    const labelWidth = 108;
    const text = pdfSafe(value);
    const maxWidth = PAGE_W - MARGIN * 2 - labelWidth;
    // The digest is 64 characters; break it rather than let it run off the page.
    if ((regular as unknown as Measurable).widthOfTextAtSize(text, 9) > maxWidth) {
      const half = Math.ceil(text.length / 2);
      page.drawText(text.slice(0, half), { x: MARGIN + labelWidth, y, size: 9, font: regular, color: ink });
      y -= 12;
      page.drawText(text.slice(half), { x: MARGIN + labelWidth, y, size: 9, font: regular, color: ink });
    } else {
      page.drawText(text, { x: MARGIN + labelWidth, y, size: 9, font: regular, color: ink });
    }
  }
  y -= 8;
  hr();

  write(`Signatories (${input.signers.length})`, { size: 12, font: bold, gap: 2 });

  for (const signer of input.signers) {
    ensure(96);
    y -= 16;
    page.drawText(
      pdfSafe(`${signer.order}. ${signer.fullName} — ${signer.signerKind.replace(/_/g, " ")}`),
      { x: MARGIN, y, size: 10.5, font: bold, color: ink },
    );
    const details: string[] = [];
    if (signer.designation !== null && signer.designation !== "") details.push(signer.designation);
    if (signer.email !== null) details.push(signer.email);
    details.push(`status: ${signer.status}`);
    if (signer.signedAt !== null) details.push(`signed ${istStamp(signer.signedAt)}`);
    details.push(
      signer.identityCheckKind === "none"
        ? "identity check: none"
        : `identity: ${signer.identityCheckKind}${
          signer.identityVerifiedAt === null ? " (unverified)" : ` verified ${istStamp(signer.identityVerifiedAt)}`
        }`,
    );
    if (signer.signatureKind !== null) details.push(`signature: ${signer.signatureKind}`);
    if (signer.ip !== null) details.push(`ip ${signer.ip}`);
    if (signer.timezone !== null && signer.timezone !== "") details.push(`tz ${signer.timezone}`);
    if (signer.pagesSigned !== null && signer.pagesSigned.length > 0) {
      details.push(`pages viewed ${signer.pagesSigned.join(", ")}`);
    }
    write(details.join("  ·  "), { size: 8.5, color: muted, indent: 14, gap: 2 });

    if (signer.signatureImage !== null) {
      try {
        const image = await out.embedPng(signer.signatureImage);
        const maxW = 170;
        const maxH = 46;
        const scale = Math.min(maxW / image.width, maxH / image.height, 1);
        const w = image.width * scale;
        const h = image.height * scale;
        ensure(h + 8);
        y -= h + 4;
        page.drawImage(image, { x: MARGIN + 14, y, width: w, height: h });
      } catch {
        // A corrupt PNG must not stop the certificate; the evidence row remains.
        write("[signature image could not be embedded]", { size: 8, color: muted, indent: 14 });
      }
    } else if (signer.typedName !== null && signer.typedName !== "") {
      ensure(22);
      y -= 20;
      page.drawText(pdfSafe(`/s/ ${signer.typedName}`), {
        x: MARGIN + 14,
        y,
        size: 14,
        font: italic,
        color: ink,
      });
    }
    ensure(12);
    y -= 10;
    page.drawLine({
      start: { x: MARGIN + 14, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.4,
      color: rule,
    });
  }

  y -= 12;
  write(
    "Any alteration of the pages above invalidates this certificate: the SHA-256 recorded here is of the source document exactly as presented to the signatories, and the SHA-256 of this sealed file is recorded against the e-sign request in the HRMS audit trail.",
    { size: 8, font: italic, color: muted },
  );

  out.setTitle(`${input.title} (signed)`);
  out.setAuthor(input.companyLine);
  out.setSubject(`${input.requestNumber} · signature certificate`);
  out.setProducer("Tamarind Tree HRMS");
  out.setCreator("Tamarind Tree HRMS · esign-flow");
  out.setCreationDate(now());
  out.setModificationDate(now());

  const bytes = await out.save({ useObjectStreams: false });
  return { bytes, pageCount: out.getPageCount() };
}

// ═════════════════════════════════════════════════════════════════════════════
// Storage helpers
// ═════════════════════════════════════════════════════════════════════════════

async function downloadObject(bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await serviceClient().storage.from(bucket).download(path);
  if (error !== null || data === null) {
    throw badGateway("The document to be signed could not be read.", "STORAGE_DOWNLOAD_FAILED", {
      cause: error,
    });
  }
  return new Uint8Array(await data.arrayBuffer());
}

async function uploadObject(
  bucket: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const { error } = await serviceClient().storage.from(bucket).upload(path, bytes, {
    contentType,
    upsert: true,
    cacheControl: "no-store",
  });
  if (error !== null) {
    throw badGateway("The file could not be stored. Try again.", "STORAGE_UPLOAD_FAILED", { cause: error });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Token issue / revoke (inside a transaction)
// ═════════════════════════════════════════════════════════════════════════════

interface IssuedToken {
  signerId: string;
  signerOrder: number;
  fullName: string;
  email: string | null;
  token: string;
  expiresAt: string;
}

/**
 * Mint a fresh token for one signer and store only its hash. The PK on
 * `secure.esign_signer_tokens` is `signer_id`, so this rotates in place: whatever
 * value was live a moment ago can no longer be looked up.
 */
async function issueToken(
  tx: Sql,
  signer: { id: string; signer_order: number; full_name: string; email: string | null },
  ttlHours: number,
): Promise<IssuedToken> {
  const token = mintTokenValue();
  const tokenHash = await sha256Hex(token);
  const rows = await tx`
    INSERT INTO secure.esign_signer_tokens (signer_id, token_hash, expires_at)
    VALUES (
      ${signer.id}::uuid,
      ${tokenHash}::text,
      now() + make_interval(hours => ${ttlHours}::integer)
    )
    ON CONFLICT (signer_id) DO UPDATE
      SET token_hash = EXCLUDED.token_hash,
          created_at = now(),
          expires_at = EXCLUDED.expires_at,
          revoked_at = NULL
    RETURNING expires_at
  `;
  const row = firstRow(rows as unknown as { expires_at: Date | string }[]);
  await tx`
    UPDATE public.e_sign_signers
       SET token_expires_at = now() + make_interval(hours => ${ttlHours}::integer),
           notified_at      = COALESCE(notified_at, now()),
           status           = CASE WHEN status = 'pending' THEN 'notified' ELSE status END
     WHERE id = ${signer.id}::uuid
  `;
  return {
    signerId: signer.id,
    signerOrder: Number(signer.signer_order),
    fullName: signer.full_name,
    email: signer.email,
    token,
    expiresAt: row === null ? nowIso() : toIso(row.expires_at),
  };
}

async function revokeTokens(tx: Sql, esignRequestId: string, signerId?: string): Promise<void> {
  if (signerId !== undefined) {
    await tx`
      UPDATE secure.esign_signer_tokens
         SET revoked_at = now()
       WHERE signer_id = ${signerId}::uuid AND revoked_at IS NULL
    `;
    return;
  }
  await tx`
    UPDATE secure.esign_signer_tokens t
       SET revoked_at = now()
     WHERE t.revoked_at IS NULL
       AND t.signer_id IN (
         SELECT s.id FROM public.e_sign_signers s WHERE s.esign_request_id = ${esignRequestId}::uuid
       )
  `;
}

async function appendEvent(
  tx: Sql,
  input: {
    esignRequestId: string;
    signerId?: string | null;
    event: string;
    payload?: unknown;
    ip: string | null;
    userAgent: string | null;
    recordedBy?: string | null;
  },
): Promise<void> {
  await tx`
    INSERT INTO public.e_sign_events
      (esign_request_id, signer_id, event, payload, ip, user_agent, recorded_by)
    VALUES (
      ${input.esignRequestId}::uuid,
      ${input.signerId ?? null}::uuid,
      ${input.event}::text,
      ${input.payload === undefined ? null : JSON.stringify(input.payload)}::jsonb,
      ${input.ip}::inet,
      ${input.userAgent}::text,
      ${input.recordedBy ?? null}::uuid
    )
  `;
}

/**
 * Serialise everything that touches one request. Two signers pressing "Sign" at
 * the same moment on a parallel request would otherwise both believe they were
 * the last, and both try to seal.
 */
async function lockRequest(tx: Sql, esignRequestId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`esign:${esignRequestId}`}))`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Signer-facing projection (explicit allowlist)
// ═════════════════════════════════════════════════════════════════════════════

interface TokenContext {
  signerId: string;
  esignRequestId: string;
  signerOrder: number;
  signerKind: string;
  employeeId: string | null;
  profileId: string | null;
  fullName: string;
  email: string | null;
  designation: string | null;
  identityCheckKind: string;
  identityCheckValueHash: string | null;
  identityVerifiedAt: string | null;
  identityAttempts: number;
  signerStatus: string;
  viewedAt: string | null;
  signedAt: string | null;
  tokenExpiresAt: string | null;
  tokenRevokedAt: string | null;
  requestNumber: string;
  requestTitle: string;
  requestMessage: string | null;
  requestStatus: string;
  signingOrder: string;
  requestExpiresAt: string | null;
  documentId: string | null;
  contractId: string | null;
  subjectEmployeeId: string | null;
  legalFramework: string;
  completedDocumentId: string | null;
  currentOrder: number | null;
}

/**
 * postgres.js hydrates `timestamptz` to a `Date`. Everything that leaves this
 * function or is compared against `nowIso()` goes through `_shared/datetime.ts`,
 * so every instant on the wire has the one canonical UTC form — which is also
 * what makes the lexicographic comparisons below sound.
 */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return toIso(value);
  return toIso(String(value));
}

async function loadByToken(db: Sql, token: string): Promise<TokenContext> {
  const tokenHash = await sha256Hex(token);
  const rows = await db`
    SELECT s.id                        AS signer_id,
           s.esign_request_id,
           s.signer_order,
           s.signer_kind,
           s.employee_id,
           s.full_name,
           s.email,
           s.designation_snapshot,
           s.identity_check_kind,
           s.identity_check_value_hash,
           s.identity_verified_at,
           s.identity_attempts,
           s.status::text              AS signer_status,
           s.viewed_at,
           s.signed_at,
           t.expires_at                AS token_expires_at,
           t.revoked_at                AS token_revoked_at,
           r.id                        AS request_id,
           r.request_number,
           r.title,
           r.message,
           r.status::text              AS request_status,
           r.signing_order,
           r.expires_at                AS request_expires_at,
           r.document_id,
           r.contract_id,
           r.subject_employee_id,
           r.legal_framework,
           r.completed_document_id,
           e.profile_id,
           (SELECT min(x.signer_order)
              FROM public.e_sign_signers x
             WHERE x.esign_request_id = r.id
               AND x.status = ANY(${[...OPEN_SIGNER_STATUSES]}::public.signer_status[])
           )                           AS current_order
      FROM secure.esign_signer_tokens t
      JOIN public.e_sign_signers  s ON s.id = t.signer_id
      JOIN public.e_sign_requests r ON r.id = s.esign_request_id
      LEFT JOIN public.employees  e ON e.id = s.employee_id AND e.deleted_at IS NULL
     WHERE t.token_hash = ${tokenHash}::text
     LIMIT 1
  `;
  const row = firstRow(rows as unknown as Record<string, unknown>[]);
  if (row === null) {
    // 401 and nothing else: a wrong token must not distinguish "never existed"
    // from "was rotated an hour ago".
    throw unauthorized("This signing link is not valid.", "ESIGN_TOKEN_INVALID");
  }
  return {
    signerId: row.signer_id as string,
    esignRequestId: row.esign_request_id as string,
    signerOrder: Number(row.signer_order),
    signerKind: row.signer_kind as string,
    employeeId: (row.employee_id as string | null) ?? null,
    profileId: (row.profile_id as string | null) ?? null,
    fullName: row.full_name as string,
    email: (row.email as string | null) ?? null,
    designation: (row.designation_snapshot as string | null) ?? null,
    identityCheckKind: row.identity_check_kind as string,
    identityCheckValueHash: (row.identity_check_value_hash as string | null) ?? null,
    identityVerifiedAt: toIsoOrNull(row.identity_verified_at),
    identityAttempts: Number(row.identity_attempts ?? 0),
    signerStatus: row.signer_status as string,
    viewedAt: toIsoOrNull(row.viewed_at),
    signedAt: toIsoOrNull(row.signed_at),
    tokenExpiresAt: toIsoOrNull(row.token_expires_at),
    tokenRevokedAt: toIsoOrNull(row.token_revoked_at),
    requestNumber: row.request_number as string,
    requestTitle: row.title as string,
    requestMessage: (row.message as string | null) ?? null,
    requestStatus: row.request_status as string,
    signingOrder: row.signing_order as string,
    requestExpiresAt: toIsoOrNull(row.request_expires_at),
    documentId: (row.document_id as string | null) ?? null,
    contractId: (row.contract_id as string | null) ?? null,
    subjectEmployeeId: (row.subject_employee_id as string | null) ?? null,
    legalFramework: row.legal_framework as string,
    completedDocumentId: (row.completed_document_id as string | null) ?? null,
    currentOrder: row.current_order === null || row.current_order === undefined
      ? null
      : Number(row.current_order),
  };
}

/** Guard shared by every token action. Order matters; each check has one status. */
function assertTokenUsable(tc: TokenContext, options: { forSigning: boolean }): void {
  if (tc.tokenRevokedAt !== null) {
    throw gone("This signing link has already been used.", "ESIGN_TOKEN_CONSUMED");
  }
  const nowInstant = nowIso();
  if (tc.tokenExpiresAt !== null && tc.tokenExpiresAt < nowInstant) {
    throw gone("This signing link has expired. Ask the sender for a new one.", "ESIGN_TOKEN_EXPIRED");
  }
  if (tc.requestStatus === "cancelled") {
    throw gone("This signature request was cancelled.", "ESIGN_REQUEST_CANCELLED");
  }
  if (tc.requestStatus === "declined") {
    throw gone("This signature request was declined.", "ESIGN_REQUEST_DECLINED");
  }
  if (tc.requestStatus === "expired" || tc.requestStatus === "voided") {
    throw gone("This signature request is no longer open.", "ESIGN_REQUEST_CLOSED");
  }
  if (!options.forSigning) return;

  if (tc.requestStatus === "completed") {
    throw conflict("This document is already fully signed.", "ESIGN_ALREADY_COMPLETE");
  }
  if (!(SIGNABLE_REQUEST_STATUSES as readonly string[]).includes(tc.requestStatus)) {
    throw conflict(
      "This request has not been sent out for signature yet.",
      "ESIGN_REQUEST_NOT_SENT",
    );
  }
  if (!(OPEN_SIGNER_STATUSES as readonly string[]).includes(tc.signerStatus)) {
    throw conflict("You have already responded to this request.", "ESIGN_SIGNER_CLOSED");
  }
  // Ordered chain: sequential means the lowest open signer_order and no other.
  if (tc.signingOrder === "sequential" && tc.currentOrder !== null && tc.signerOrder !== tc.currentOrder) {
    throw conflict(
      "It is not your turn yet — an earlier signatory has still to sign. You will be emailed when it is.",
      "ESIGN_NOT_YOUR_TURN",
    );
  }
  if (tc.identityCheckKind !== "none" && tc.identityVerifiedAt === null) {
    throw forbidden(
      "Confirm your identity before signing.",
      "ESIGN_IDENTITY_REQUIRED",
    );
  }
}

/** What a token holder is allowed to learn. Everything else is withheld. */
function signerView(
  tc: TokenContext,
  others: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    request: {
      request_number: tc.requestNumber,
      title: tc.requestTitle,
      message: tc.requestMessage,
      status: tc.requestStatus,
      signing_order: tc.signingOrder,
      expires_at: tc.requestExpiresAt,
      legal_framework: tc.legalFramework,
    },
    you: {
      full_name: tc.fullName,
      signer_kind: tc.signerKind,
      designation: tc.designation,
      signer_order: tc.signerOrder,
      status: tc.signerStatus,
      viewed_at: tc.viewedAt,
      signed_at: tc.signedAt,
      identity_check_kind: tc.identityCheckKind,
      identity_verified: tc.identityVerifiedAt !== null,
      identity_attempts_remaining: Math.max(0, MAX_IDENTITY_ATTEMPTS - tc.identityAttempts),
      is_your_turn: tc.signingOrder === "parallel" ||
        tc.currentOrder === null ||
        tc.signerOrder === tc.currentOrder,
    },
    // Names and order only — never another signer's email or mobile.
    signatories: others.map((o) => ({
      signer_order: Number(o.signer_order),
      full_name: o.full_name,
      signer_kind: o.signer_kind,
      status: o.status,
      signed_at: toIsoOrNull(o.signed_at),
    })),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The seal
// ═════════════════════════════════════════════════════════════════════════════

interface SealOutcome {
  sealed: boolean;
  completedDocumentId: string | null;
  certificateHash: string | null;
}

/**
 * Build and record the final sealed PDF for a request whose signers have all
 * signed. Idempotent: a request that already has `completed_document_id` is left
 * alone, which is what makes `action: "seal"` a safe retry.
 */
async function performSeal(
  db: Sql,
  ctx: RequestContext,
  esignRequestId: string,
  log: Logger,
): Promise<SealOutcome> {
  const headRows = await db`
    SELECT r.id,
           r.request_number,
           r.title,
           r.status::text          AS status,
           r.legal_framework,
           r.completed_document_id,
           r.certificate_hash,
           r.document_id,
           r.contract_id,
           r.subject_employee_id,
           d.id                    AS source_document_id,
           d.storage_bucket,
           d.storage_path,
           d.checksum_sha256,
           d.document_type_id,
           d.company_id,
           d.employee_id           AS document_employee_id,
           d.title                 AS document_title,
           d.subject_kind,
           k.contract_number,
           k.employee_id           AS contract_employee_id,
           c.legal_name            AS company_legal_name,
           (SELECT count(*) FROM public.e_sign_signers s
             WHERE s.esign_request_id = r.id
               AND s.status = ANY(${[...OPEN_SIGNER_STATUSES]}::public.signer_status[])) AS open_signers,
           (SELECT count(*) FROM public.e_sign_signers s
             WHERE s.esign_request_id = r.id AND s.status = 'signed')                     AS signed_signers
      FROM public.e_sign_requests r
      LEFT JOIN public.contracts k ON k.id = r.contract_id
      LEFT JOIN public.documents d
             ON d.id = COALESCE(r.document_id, k.rendered_pdf_document_id)
            AND d.deleted_at IS NULL
      LEFT JOIN public.companies c ON c.id = d.company_id AND c.deleted_at IS NULL
     WHERE r.id = ${esignRequestId}::uuid
     LIMIT 1
  `;
  const head = firstRow(headRows as unknown as Record<string, unknown>[]);
  if (head === null) throw notFound(undefined, "ESIGN_REQUEST_NOT_FOUND");

  if (head.completed_document_id !== null) {
    return {
      sealed: true,
      completedDocumentId: head.completed_document_id as string,
      certificateHash: (head.certificate_hash as string | null) ?? null,
    };
  }
  if (Number(head.open_signers) > 0) {
    throw conflict(
      `${head.open_signers} signatory/signatories have still to sign; the document cannot be sealed yet.`,
      "ESIGN_SIGNATURES_OUTSTANDING",
    );
  }
  if (Number(head.signed_signers) === 0) {
    throw conflict("No signature has been captured, so there is nothing to seal.", "ESIGN_NOTHING_SIGNED");
  }
  if (head.storage_path === null || head.storage_bucket === null) {
    throw unprocessable(
      [{
        pointer: "/esign_request_id",
        code: "no_source_document",
        detail: "This request has no stored PDF to seal. Generate the document first (document-generate).",
      }],
      "There is no document to seal.",
      "ESIGN_NO_SOURCE_DOCUMENT",
    );
  }

  const signerRows = await db`
    SELECT s.id, s.signer_order, s.signer_kind, s.full_name, s.email, s.designation_snapshot,
           s.status::text AS status, s.signed_at, s.identity_check_kind, s.identity_verified_at,
           s.signature_kind, s.signature_image_path, s.ip::text AS ip, s.user_agent,
           s.timezone, s.pages_signed
      FROM public.e_sign_signers s
     WHERE s.esign_request_id = ${esignRequestId}::uuid
       AND s.status <> 'delegated'
     ORDER BY s.signer_order, s.created_at
  `;

  const sourcePdf = await downloadObject(head.storage_bucket as string, head.storage_path as string);
  const sourceChecksum = (head.checksum_sha256 as string | null) ?? await sha256HexBytes(sourcePdf);

  const signers: SealSigner[] = [];
  for (const raw of signerRows as unknown as Record<string, unknown>[]) {
    let image: Uint8Array | null = null;
    const path = raw.signature_image_path as string | null;
    if (path !== null && path !== "") {
      try {
        image = await downloadObject("signatures", path);
      } catch (err) {
        // The evidence row survives without the picture; do not lose the seal.
        log.warn("signature image unavailable", { signer_id: raw.id, err });
      }
    }
    signers.push({
      order: Number(raw.signer_order),
      fullName: raw.full_name as string,
      signerKind: raw.signer_kind as string,
      email: maskEmail((raw.email as string | null) ?? null),
      designation: (raw.designation_snapshot as string | null) ?? null,
      status: raw.status as string,
      signedAt: toIsoOrNull(raw.signed_at),
      identityCheckKind: raw.identity_check_kind as string,
      identityVerifiedAt: toIsoOrNull(raw.identity_verified_at),
      signatureKind: (raw.signature_kind as string | null) ?? null,
      typedName: raw.signature_kind === "typed" ? (raw.full_name as string) : null,
      ip: (raw.ip as string | null) ?? null,
      userAgent: (raw.user_agent as string | null) ?? null,
      timezone: (raw.timezone as string | null) ?? null,
      pagesSigned: (raw.pages_signed as number[] | null) ?? null,
      signatureImage: image,
    });
  }

  const completedAt = nowIso();
  const sealed = await sealPdf({
    sourcePdf,
    sourceChecksum,
    requestNumber: head.request_number as string,
    title: (head.document_title as string | null) ?? (head.title as string),
    companyLine: (head.company_legal_name as string | null) ?? "Machani Hospitalities LLP",
    legalFramework: head.legal_framework as string,
    contractNumber: (head.contract_number as string | null) ?? null,
    completedAt,
    signers,
  });
  if (sealed.bytes.byteLength > MAX_PDF_BYTES) {
    throw unprocessable(
      [{ pointer: "", code: "too_large", detail: "The sealed PDF exceeds the size ceiling." }],
      "The sealed document is too large to store.",
      "PDF_TOO_LARGE",
    );
  }
  const certificateHash = await sha256HexBytes(sealed.bytes);

  // A signed contract goes to the `contracts` bucket under `/signed/`, which is
  // where migration 039's `contracts__own_signed_read` policy looks; everything
  // else stays in the source document's bucket.
  const contractNumber = (head.contract_number as string | null) ?? null;
  const targetBucket = contractNumber === null ? (head.storage_bucket as string) : "contracts";
  const employeeId = (head.document_employee_id as string | null) ??
    (head.contract_employee_id as string | null) ??
    (head.subject_employee_id as string | null);
  const safeNumber = (contractNumber ?? (head.request_number as string)).replace(/[^A-Za-z0-9._-]+/g, "-");
  const objectPath = contractNumber === null
    ? `${head.company_id as string}/${employeeId ?? "company"}/ESIGN/${safeNumber}-signed.pdf`
    : `${head.company_id as string}/signed/${safeNumber}.pdf`;
  const fileName = `${safeNumber}-signed.pdf`;

  await uploadObject(targetBucket, objectPath, sealed.bytes, "application/pdf");

  try {
    return await withContext(ctx, async (tx) => {
      await lockRequest(tx, esignRequestId);

      // Another request may have sealed while we were rendering. Its object wins;
      // ours is removed by the catch below.
      const recheck = await tx`
        SELECT completed_document_id, certificate_hash
          FROM public.e_sign_requests WHERE id = ${esignRequestId}::uuid FOR UPDATE
      `;
      const existing = firstRow(recheck as unknown as Record<string, unknown>[]);
      if (existing !== null && existing.completed_document_id !== null) {
        throw conflict("This request was sealed by a concurrent request.", "ESIGN_SEAL_RACE");
      }

      const insertedDoc = await tx`
        INSERT INTO public.documents (
          document_type_id, company_id, subject_kind, employee_id, title, file_name,
          storage_bucket, storage_path, mime_type, file_size_bytes, checksum_sha256,
          page_count, current_version, status, uploaded_by, is_system_generated,
          source_reference, esign_request_id, virus_scan_status, is_confidential
        )
        VALUES (
          ${head.document_type_id as string}::uuid,
          ${head.company_id as string}::uuid,
          ${(head.subject_kind as string | null) ?? "employee"}::text,
          ${employeeId ?? null}::uuid,
          ${`${(head.document_title as string | null) ?? (head.title as string)} (signed)`}::text,
          ${fileName}::text,
          ${targetBucket}::text,
          ${objectPath}::text,
          'application/pdf',
          ${sealed.bytes.byteLength}::bigint,
          ${certificateHash}::text,
          ${sealed.pageCount}::integer,
          1,
          'approved',
          -- documents.uploaded_by is NOT NULL and an external signer has no
          -- profile row, so the actor of record is whoever set the request up.
          COALESCE(
            (SELECT r2.created_by FROM public.e_sign_requests r2 WHERE r2.id = ${esignRequestId}::uuid),
            ${ctx.actorId ?? null}::uuid
          ),
          true,
          ${JSON.stringify({
        sealed_from_document_id: head.source_document_id,
        esign_request_number: head.request_number,
        source_checksum_sha256: sourceChecksum,
        signer_count: signers.length,
        completed_at: completedAt,
        request_id: ctx.requestId,
      })}::jsonb,
          ${esignRequestId}::uuid,
          'skipped',
          true
        )
        RETURNING id
      `;
      const docRow = firstRow(insertedDoc as unknown as { id: string }[]);
      if (docRow === null) throw badGateway("The sealed document row could not be written.", "DOCUMENT_INSERT_FAILED");

      await tx`
        INSERT INTO public.document_versions
          (document_id, version, storage_path, file_name, file_size_bytes,
           checksum_sha256, mime_type, page_count, is_current)
        VALUES (
          ${docRow.id}::uuid, 1, ${objectPath}::text, ${fileName}::text,
          ${sealed.bytes.byteLength}::bigint, ${certificateHash}::text, 'application/pdf',
          ${sealed.pageCount}::integer, true
        )
      `;

      await tx`
        UPDATE public.e_sign_requests
           SET status                = 'completed',
               completed_at          = ${completedAt}::timestamptz,
               completed_document_id = ${docRow.id}::uuid,
               certificate_hash      = ${certificateHash}::text
         WHERE id = ${esignRequestId}::uuid
      `;

      await appendEvent(tx, {
        esignRequestId,
        event: "certificate_generated",
        payload: {
          document_id: docRow.id,
          certificate_hash: certificateHash,
          source_checksum_sha256: sourceChecksum,
          page_count: sealed.pageCount,
        },
        ip: ctx.ip ?? null,
        userAgent: ctx.ua ?? null,
        recordedBy: ctx.actorId ?? null,
      });
      await appendEvent(tx, {
        esignRequestId,
        event: "completed",
        payload: { signer_count: signers.length, completed_at: completedAt },
        ip: ctx.ip ?? null,
        userAgent: ctx.ua ?? null,
        recordedBy: ctx.actorId ?? null,
      });

      if (head.contract_id !== null) {
        await tx`
          UPDATE public.contracts
             SET status    = 'signed',
                 signed_at = ${completedAt}::timestamptz
           WHERE id = ${head.contract_id as string}::uuid
             AND status <> 'signed'
        `;
        await tx`
          INSERT INTO public.contract_events (contract_id, event, payload, ip, recorded_by)
          VALUES (
            ${head.contract_id as string}::uuid,
            'signed_by',
            ${JSON.stringify({
          esign_request_number: head.request_number,
          signed_document_id: docRow.id,
          certificate_hash: certificateHash,
        })}::jsonb,
            ${ctx.ip ?? null}::inet,
            ${ctx.actorId ?? null}::uuid
          )
        `;
      }

      // Every live token dies with completion.
      await revokeTokens(tx, esignRequestId);

      return { sealed: true, completedDocumentId: docRow.id, certificateHash };
    });
  } catch (err) {
    // No orphan sealed PDFs: if the metadata did not land, the object goes.
    try {
      await serviceClient().storage.from(targetBucket).remove([objectPath]);
    } catch (removeErr) {
      log.error("orphaned sealed object", { bucket: targetBucket, path: objectPath, err: removeErr });
    }
    throw err;
  }
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
  const ip = clientIpFrom(req);
  const ua = userAgentFrom(req);

  let status = 500;
  let idempotencyKey: string | null = null;
  /** Signature PNG written before the transaction; removed if the write fails. */
  let uploadedSignature: string | null = null;

  try {
    assertOriginAllowed(req);

    const raw = await readRawBody(req, { maxBytes: MAX_BODY_BYTES });
    const decoded = decodeJson(raw);
    const peek = (decoded ?? {}) as Record<string, unknown>;
    const action = typeof peek.action === "string" ? peek.action : "";
    const isTokenAction = TOKEN_ACTIONS.has(action);
    const db = sql();

    // ── STEP 4 · Auth ───────────────────────────────────────────────────────
    let auth: AuthContext | null = null;
    let tokenContext: TokenContext | null = null;
    if (isTokenAction) {
      // Model T. The token is the whole credential; nothing else is trusted.
      const presented = typeof peek.token === "string" ? peek.token.trim() : "";
      if (presented === "") throw unauthorized("This signing link is not valid.", "ESIGN_TOKEN_INVALID");
      tokenContext = await loadByToken(db, presented);
    } else {
      // Model U. Capability comes from role_capabilities, never from the request.
      auth = await verifyUser(req);
    }

    // ── STEP 5 · Authority ──────────────────────────────────────────────────
    // `status` is the one action a non-admin may reach: the subject of a request,
    // or one of its signatories, can read their own chain. The capability is
    // resolved here; the row-scope half of the decision needs a validated UUID
    // and so is asserted in the `status` case below, before anything is read.
    let isInitiator = false;
    if (auth !== null) {
      if (action === "status") {
        isInitiator = await hasCapDb(db, auth, CAP_INITIATE);
      } else {
        await requireCapWithStepUp(db, auth, CAP_INITIATE);
        isInitiator = true;
      }
    }

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    if (tokenContext !== null) {
      // A public surface: throttle the link AND the caller's address, so neither
      // a single stolen link nor a single host can be used to brute-force the
      // identity gate. Outside any transaction — a refusal still spends a token.
      await enforce(
        RATE_LIMITS.authPreLogin,
        limitKey(FN_NAME, "signer", tokenContext.signerId),
        "ESIGN_RATE_LIMITED",
      );
      await enforce(RATE_LIMITS.authPreLogin, limitKey(FN_NAME, "ip", ip), "ESIGN_RATE_LIMITED");
    } else if (auth !== null) {
      const spec = action === "seal" ? RATE_LIMITS.heavyJob : RATE_LIMITS.mutation;
      await enforce(spec, limitKey(FN_NAME, auth.userId), "ESIGN_RATE_LIMITED");
    }

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const body: EsignInput = parse(EsignBody, decoded, "request body");

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    if (!READ_ONLY_ACTIONS.has(body.action)) {
      const actorKey = tokenContext === null ? (auth as AuthContext).userId : tokenContext.signerId;
      idempotencyKey = idempotencyKeyFrom(req) ??
        `${FN_NAME}:${body.action}:${actorKey}:${await sha256Hex(raw)}`;
      const hash = await requestHash(FN_NAME, raw, actorKey);
      const claimed = await claim({
        key: idempotencyKey,
        fnName: FN_NAME,
        requestHash: hash,
        actorId: tokenContext === null ? (auth as AuthContext).userId : tokenContext.signerId,
      });
      if (claimed.state === "replay") {
        status = claimed.status;
        log.info("idempotent replay", { action: body.action });
        return replayResponse(claimed, { ...cors, "x-request-id": requestId });
      }
    }

    // Context for every write below. A token signer is not a `web_*` surface and
    // may have no profile at all, so `edge_function` is the honest source and
    // `actorId` is the signer's profile when (and only when) one exists.
    const ctx: RequestContext = tokenContext !== null
      ? {
        actorId: tokenContext.profileId,
        actorRole: null,
        source: "edge_function",
        sourceRoute: FN_NAME,
        requestId,
        ip,
        ua,
        reason: `${FN_NAME}: ${body.action} by signer ${tokenContext.signerOrder} of ${tokenContext.requestNumber}`,
      }
      : {
        actorId: (auth as AuthContext).userId,
        actorRole: (auth as AuthContext).role,
        source: "web_admin",
        sourceRoute: FN_NAME,
        requestId,
        ip,
        ua,
        reason: `${FN_NAME}: ${body.action}`,
      };

    let responseBody: unknown;

    switch (body.action) {
      // ═══════════════════════════════════════════════════════════════════════
      // U · create
      // ═══════════════════════════════════════════════════════════════════════
      case "create": {
        if (body.document_id === undefined && body.contract_id === undefined) {
          throw unprocessable(
            [{
              pointer: "/document_id",
              code: "required",
              detail: "Provide document_id or contract_id — there must be something to sign.",
            }],
            "Nothing was nominated for signature.",
            "ESIGN_NO_SOURCE_DOCUMENT",
          );
        }
        for (const signer of body.signers) {
          if (signer.identity_check_kind === "otp_email" || signer.identity_check_kind === "otp_sms") {
            // Honest refusal rather than a dead end: delivering an OTP needs
            // `communication-send` plus a one-time-code store, and neither is
            // wired into this function. See the DB gap note.
            throw unprocessable(
              [{
                pointer: "/signers/identity_check_kind",
                code: "unsupported",
                detail:
                  "OTP identity checks are not available yet (no OTP store, and delivery belongs to communication-send). Use dob, id_last4, custom_question or none.",
              }],
              "That identity check is not available.",
              "ESIGN_IDENTITY_KIND_UNSUPPORTED",
            );
          }
          const bad = encodableOrNull(signer.full_name);
          if (bad !== null) {
            // Refused HERE, at create, so the certificate can never be forced to
            // print `?????` where a signatory's name belongs.
            throw unprocessable(
              [{
                pointer: "/signers/full_name",
                code: "unencodable_characters",
                detail:
                  `A signatory name may only use Latin characters until a Unicode font is embedded (found: ${bad}).`,
              }],
              "A signatory name cannot be printed on the certificate.",
              "PDF_UNSUPPORTED_CHARACTERS",
            );
          }
        }
        const orders = body.signers.map((s) => s.signer_order);
        if (new Set(orders).size !== orders.length && body.signing_order === "sequential") {
          throw unprocessable(
            [{
              pointer: "/signers",
              code: "duplicate_order",
              detail: "A sequential chain needs one signatory per signer_order.",
            }],
            "Two signatories share a position in the chain.",
            "ESIGN_ORDER_AMBIGUOUS",
          );
        }

        const hashes = await Promise.all(
          body.signers.map(async (s) =>
            s.identity_check_value === undefined || s.identity_check_kind === "none"
              ? null
              : await sha256Hex(canonicalIdentityAnswer(s.identity_check_kind, s.identity_check_value))
          ),
        );

        responseBody = await withContext(ctx, async (tx) => {
          await requireCapWithStepUp(tx, auth as AuthContext, CAP_INITIATE);

          // Resolve what is being signed. A contract signs its rendered PDF.
          const target = await tx`
            SELECT COALESCE(${body.document_id ?? null}::uuid, k.rendered_pdf_document_id) AS document_id,
                   k.id                AS contract_id,
                   k.contract_number,
                   k.employee_id       AS contract_employee_id,
                   d.id                AS resolved_document_id,
                   d.title             AS document_title,
                   d.employee_id       AS document_employee_id
              FROM (SELECT 1) one
              LEFT JOIN public.contracts k
                     ON k.id = ${body.contract_id ?? null}::uuid AND k.deleted_at IS NULL
              LEFT JOIN public.documents d
                     ON d.id = COALESCE(${body.document_id ?? null}::uuid, k.rendered_pdf_document_id)
                    AND d.deleted_at IS NULL
             LIMIT 1
          `;
          const t = firstRow(target as unknown as Record<string, unknown>[]);
          if (body.contract_id !== undefined && (t === null || t.contract_id === null)) {
            throw notFound(undefined, "CONTRACT_NOT_FOUND");
          }
          if (t === null || t.resolved_document_id === null) {
            throw unprocessable(
              [{
                pointer: "/document_id",
                code: "not_found",
                detail:
                  "No stored PDF was found to sign. Generate it with document-generate first, or pass document_id.",
              }],
              "There is nothing to sign yet.",
              "ESIGN_NO_SOURCE_DOCUMENT",
            );
          }

          // Number the request. `e_sign_requests.request_number` is NOT NULL with
          // a unique index and has no default and no trigger, so the edge owns
          // it — same advisory-lock pattern as `generate_leave_request_number`
          // (migration 019). The lock is its OWN statement: folded into the
          // numbering query as a CTE, an empty `e_sign_requests` scan could let
          // the planner reach the aggregate without ever taking the lock, and two
          // concurrent creates would then race for the same number.
          await tx`SELECT pg_advisory_xact_lock(hashtext('esign_request_number'))`;
          const numbered = await tx`
            SELECT 'ES-' || to_char(util.ist_today(), 'YYYY') || '-' ||
                   lpad((
                     COALESCE(MAX(substring(r.request_number FROM '[0-9]+$')::integer), 0) + 1
                   )::text, 6, '0') AS request_number
              FROM public.e_sign_requests r
             WHERE r.request_number LIKE 'ES-' || to_char(util.ist_today(), 'YYYY') || '-%'
          `;
          const requestNumber = (firstRow(numbered as unknown as { request_number: string }[]))
            ?.request_number as string;

          const subjectEmployeeId = body.subject_employee_id ??
            (t.document_employee_id as string | null) ??
            (t.contract_employee_id as string | null) ??
            null;

          const insertedRequest = await tx`
            INSERT INTO public.e_sign_requests (
              request_number, document_id, contract_id, subject_employee_id, title, message,
              status, signing_order, expires_at, reminder_schedule_days
            )
            VALUES (
              ${requestNumber}::text,
              ${t.resolved_document_id as string}::uuid,
              ${(t.contract_id as string | null) ?? null}::uuid,
              ${subjectEmployeeId}::uuid,
              ${body.title}::text,
              ${body.message ?? null}::text,
              'draft',
              ${body.signing_order}::text,
              now() + make_interval(days => ${body.expires_in_days}::integer),
              COALESCE(${body.reminder_schedule_days ?? null}::integer[], '{3,7,10}'::integer[])
            )
            RETURNING id, request_number, status::text AS status, expires_at
          `;
          const request = firstRow(insertedRequest as unknown as Record<string, unknown>[]);
          if (request === null) throw badGateway("The request could not be created.", "ESIGN_CREATE_FAILED");
          const newId = request.id as string;

          const createdSigners: Record<string, unknown>[] = [];
          for (let i = 0; i < body.signers.length; i++) {
            const s = body.signers[i] as z.infer<typeof SignerInput>;
            const inserted = await tx`
              INSERT INTO public.e_sign_signers (
                esign_request_id, signer_order, signer_kind, employee_id, full_name, email,
                mobile, designation_snapshot, identity_check_kind, identity_check_value_hash, status
              )
              VALUES (
                ${newId}::uuid,
                ${s.signer_order}::integer,
                ${s.signer_kind}::text,
                ${s.employee_id ?? null}::uuid,
                ${s.full_name}::text,
                ${s.email ?? null}::text,
                ${s.mobile ?? null}::text,
                ${s.designation_snapshot ?? null}::text,
                ${s.identity_check_kind}::text,
                ${hashes[i] ?? null}::text,
                'pending'
              )
              RETURNING id, signer_order, signer_kind, full_name, status::text AS status
            `;
            const row = firstRow(inserted as unknown as Record<string, unknown>[]);
            if (row !== null) createdSigners.push(row);
          }

          if (t.contract_id !== null) {
            await tx`
              UPDATE public.contracts
                 SET esign_request_id = ${newId}::uuid
               WHERE id = ${t.contract_id as string}::uuid
            `;
          }

          await appendEvent(tx, {
            esignRequestId: newId,
            event: "created",
            payload: {
              request_number: requestNumber,
              signing_order: body.signing_order,
              signer_count: body.signers.length,
              document_id: t.resolved_document_id,
              contract_id: t.contract_id,
            },
            ip,
            userAgent: ua,
            recordedBy: (auth as AuthContext).userId,
          });

          // STEP 10 · the audit rows for e_sign_requests / e_sign_signers /
          // contracts are written by their `audit.log_changes()` triggers inside
          // this same transaction, from the context set above.
          return {
            esign_request: {
              id: newId,
              request_number: requestNumber,
              status: request.status,
              signing_order: body.signing_order,
              expires_at: toIsoOrNull(request.expires_at),
              document_id: t.resolved_document_id,
              contract_id: t.contract_id,
              subject_employee_id: subjectEmployeeId,
            },
            signers: createdSigners.map((s) => ({
              id: s.id,
              signer_order: Number(s.signer_order),
              signer_kind: s.signer_kind,
              full_name: s.full_name,
              status: s.status,
            })),
            next: "Call action 'send' to issue signing links.",
            request_id: requestId,
          };
        });
        status = 201;
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // U · send / remind
      // ═══════════════════════════════════════════════════════════════════════
      case "send":
      case "remind": {
        const ttlHours = body.token_ttl_hours ?? DEFAULT_TOKEN_TTL_HOURS;
        const isSend = body.action === "send";

        const outcome = await withContext(ctx, async (tx) => {
          await requireCapWithStepUp(tx, auth as AuthContext, CAP_INITIATE);
          await lockRequest(tx, body.esign_request_id);

          const rows = await tx`
            SELECT r.id, r.request_number, r.status::text AS status, r.signing_order,
                   r.expires_at, r.document_id
              FROM public.e_sign_requests r
             WHERE r.id = ${body.esign_request_id}::uuid
             FOR UPDATE
          `;
          const request = firstRow(rows as unknown as Record<string, unknown>[]);
          if (request === null) throw notFound(undefined, "ESIGN_REQUEST_NOT_FOUND");

          if (isSend && request.status !== "draft") {
            throw conflict(
              `This request is already ${request.status}. Use 'remind' to re-issue a signing link.`,
              "ESIGN_ALREADY_SENT",
            );
          }
          if (!isSend && !(SIGNABLE_REQUEST_STATUSES as readonly string[]).includes(request.status as string)) {
            throw conflict(
              `A ${request.status} request cannot be reminded.`,
              "ESIGN_REQUEST_NOT_SENT",
            );
          }
          const requestExpiresAt = toIsoOrNull(request.expires_at);
          if (requestExpiresAt !== null && requestExpiresAt < nowIso()) {
            await tx`
              UPDATE public.e_sign_requests SET status = 'expired' WHERE id = ${body.esign_request_id}::uuid
            `;
            await revokeTokens(tx, body.esign_request_id);
            await appendEvent(tx, {
              esignRequestId: body.esign_request_id,
              event: "expired",
              ip,
              userAgent: ua,
              recordedBy: (auth as AuthContext).userId,
            });
            throw gone("This request has passed its expiry date.", "ESIGN_REQUEST_EXPIRED");
          }

          // Whose turn is it? Sequential issues one link; parallel issues all.
          const openSigners = await tx`
            SELECT s.id, s.signer_order, s.full_name, s.email
              FROM public.e_sign_signers s
             WHERE s.esign_request_id = ${body.esign_request_id}::uuid
               AND s.status = ANY(${[...OPEN_SIGNER_STATUSES]}::public.signer_status[])
             ORDER BY s.signer_order, s.created_at
          `;
          const open = openSigners as unknown as {
            id: string;
            signer_order: number;
            full_name: string;
            email: string | null;
          }[];
          if (open.length === 0) {
            throw conflict("Every signatory has already responded.", "ESIGN_NO_OPEN_SIGNERS");
          }
          const lowest = Math.min(...open.map((s) => Number(s.signer_order)));
          const targets = request.signing_order === "parallel"
            ? open
            : open.filter((s) => Number(s.signer_order) === lowest);

          const issued: IssuedToken[] = [];
          for (const target of targets) issued.push(await issueToken(tx, target, ttlHours));

          if (isSend) {
            await tx`
              UPDATE public.e_sign_requests
                 SET status  = 'sent',
                     sent_at = COALESCE(sent_at, now())
               WHERE id = ${body.esign_request_id}::uuid
            `;
          }

          for (const one of issued) {
            await appendEvent(tx, {
              esignRequestId: body.esign_request_id,
              signerId: one.signerId,
              event: isSend ? "sent" : "reminded",
              // The token itself is NEVER in the trail — only that one was issued.
              payload: { signer_order: one.signerOrder, token_expires_at: one.expiresAt },
              ip,
              userAgent: ua,
              recordedBy: (auth as AuthContext).userId,
            });
          }

          return { requestNumber: request.request_number as string, issued };
        });

        responseBody = {
          esign_request_id: body.esign_request_id,
          request_number: outcome.requestNumber,
          status: isSend ? "sent" : "reminded",
          notified: outcome.issued.map((one) => ({
            signer_id: one.signerId,
            signer_order: one.signerOrder,
            full_name: one.fullName,
            email: one.email,
            token_expires_at: one.expiresAt,
            // Secret material. Present only on an explicit `return_links: true`,
            // because whatever delivers the link (communication-send) needs it
            // once and nothing else ever should.
            ...(body.return_links
              ? { signing_url: `https://hr.thetamarindtree.in/sign/${one.token}` }
              : {}),
          })),
          delivery:
            "This function does not send email. Hand each signing_url to communication-send, or deliver it out of band.",
          request_id: requestId,
        };
        status = 200;
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // U · seal (retry the derived artefact)
      // ═══════════════════════════════════════════════════════════════════════
      case "seal": {
        const outcome = await performSeal(db, ctx, body.esign_request_id, log);
        responseBody = {
          esign_request_id: body.esign_request_id,
          sealed: outcome.sealed,
          completed_document_id: outcome.completedDocumentId,
          certificate_hash: outcome.certificateHash,
          request_id: requestId,
        };
        status = 200;
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // U · cancel
      // ═══════════════════════════════════════════════════════════════════════
      case "cancel": {
        responseBody = await withContext({ ...ctx, reason: body.reason }, async (tx) => {
          await requireCapWithStepUp(tx, auth as AuthContext, CAP_INITIATE);
          await lockRequest(tx, body.esign_request_id);

          const updated = await tx`
            UPDATE public.e_sign_requests
               SET status           = 'cancelled',
                   cancelled_by     = ${(auth as AuthContext).userId}::uuid,
                   cancelled_at     = now(),
                   cancelled_reason = ${body.reason}::text
             WHERE id = ${body.esign_request_id}::uuid
               AND status IN ('draft', 'sent', 'partially_signed')
            RETURNING id, request_number, contract_id
          `;
          const request = firstRow(updated as unknown as Record<string, unknown>[]);
          if (request === null) {
            // Either it does not exist or it is already terminal. Distinguish, so
            // the console can say something useful — existence is not a secret
            // from a caller who already holds the initiator capability.
            const probe = await tx`
              SELECT status::text AS status FROM public.e_sign_requests WHERE id = ${body.esign_request_id}::uuid
            `;
            const found = firstRow(probe as unknown as { status: string }[]);
            if (found === null) throw notFound(undefined, "ESIGN_REQUEST_NOT_FOUND");
            throw conflict(`A ${found.status} request cannot be cancelled.`, "ESIGN_NOT_CANCELLABLE");
          }

          await revokeTokens(tx, body.esign_request_id);
          await appendEvent(tx, {
            esignRequestId: body.esign_request_id,
            event: "cancelled",
            payload: { reason: body.reason },
            ip,
            userAgent: ua,
            recordedBy: (auth as AuthContext).userId,
          });
          if (request.contract_id !== null) {
            await tx`
              UPDATE public.contracts SET status = 'cancelled'
               WHERE id = ${request.contract_id as string}::uuid
                 AND status NOT IN ('signed', 'superseded')
            `;
            await tx`
              INSERT INTO public.contract_events (contract_id, event, payload, ip, recorded_by)
              VALUES (${request.contract_id as string}::uuid, 'cancelled',
                      ${JSON.stringify({ reason: body.reason, esign_request_number: request.request_number })}::jsonb,
                      ${ip}::inet, ${(auth as AuthContext).userId}::uuid)
            `;
          }
          return {
            esign_request_id: body.esign_request_id,
            request_number: request.request_number,
            status: "cancelled" as const,
            request_id: requestId,
          };
        });
        status = 200;
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // U · status (read-only)
      // ═══════════════════════════════════════════════════════════════════════
      case "status": {
        if (!isInitiator) {
          const participates = await db`
            SELECT 1
              FROM public.e_sign_requests r
             WHERE r.id = ${body.esign_request_id}::uuid
               AND ${(auth as AuthContext).employeeId ?? null}::uuid IS NOT NULL
               AND (
                 r.subject_employee_id = ${(auth as AuthContext).employeeId ?? null}::uuid
                 OR EXISTS (
                   SELECT 1 FROM public.e_sign_signers s
                    WHERE s.esign_request_id = r.id
                      AND s.employee_id = ${(auth as AuthContext).employeeId ?? null}::uuid
                 )
               )
             LIMIT 1
          `;
          // 404, not 403: whether a request exists is nobody else's business
          // (§4 "never exists-but-forbidden").
          if ((participates as unknown as unknown[]).length === 0) {
            throw notFound(undefined, "ESIGN_REQUEST_NOT_FOUND");
          }
        }

        const rows = await db`
          SELECT r.id, r.request_number, r.title, r.status::text AS status, r.signing_order,
                 r.sent_at, r.completed_at, r.expires_at, r.document_id, r.contract_id,
                 r.completed_document_id, r.certificate_hash, r.cancelled_reason,
                 r.subject_employee_id, r.legal_framework
            FROM public.e_sign_requests r
           WHERE r.id = ${body.esign_request_id}::uuid
           LIMIT 1
        `;
        const request = firstRow(rows as unknown as Record<string, unknown>[]);
        if (request === null) throw notFound(undefined, "ESIGN_REQUEST_NOT_FOUND");

        const signers = await db`
          SELECT s.id, s.signer_order, s.signer_kind, s.full_name, s.email,
                 s.designation_snapshot, s.status::text AS status, s.notified_at, s.viewed_at,
                 s.signed_at, s.signature_kind, s.declined_reason, s.identity_check_kind,
                 s.identity_verified_at, s.identity_attempts, s.token_expires_at
            FROM public.e_sign_signers s
           WHERE s.esign_request_id = ${body.esign_request_id}::uuid
           ORDER BY s.signer_order, s.created_at
        `;
        const events = await db`
          SELECT e.event, e.signer_id, e.payload, e.recorded_at, e.ip::text AS ip
            FROM public.e_sign_events e
           WHERE e.esign_request_id = ${body.esign_request_id}::uuid
           ORDER BY e.recorded_at, e.id
           LIMIT 500
        `;
        const signerRows = signers as unknown as Record<string, unknown>[];
        const openOrders = signerRows
          .filter((s) => (OPEN_SIGNER_STATUSES as readonly string[]).includes(s.status as string))
          .map((s) => Number(s.signer_order));

        responseBody = {
          esign_request: {
            id: request.id,
            request_number: request.request_number,
            title: request.title,
            status: request.status,
            signing_order: request.signing_order,
            sent_at: toIsoOrNull(request.sent_at),
            completed_at: toIsoOrNull(request.completed_at),
            expires_at: toIsoOrNull(request.expires_at),
            document_id: request.document_id,
            contract_id: request.contract_id,
            completed_document_id: request.completed_document_id,
            certificate_hash: request.certificate_hash,
            cancelled_reason: request.cancelled_reason,
            legal_framework: request.legal_framework,
          },
          /** NULL when nobody is left to sign. */
          current_signer_order: openOrders.length === 0 ? null : Math.min(...openOrders),
          signers: signerRows.map((s) => ({
            id: s.id,
            signer_order: Number(s.signer_order),
            signer_kind: s.signer_kind,
            full_name: s.full_name,
            email: maskEmail((s.email as string | null) ?? null),
            designation: s.designation_snapshot,
            status: s.status,
            notified_at: toIsoOrNull(s.notified_at),
            viewed_at: toIsoOrNull(s.viewed_at),
            signed_at: toIsoOrNull(s.signed_at),
            signature_kind: s.signature_kind,
            declined_reason: s.declined_reason,
            identity_check_kind: s.identity_check_kind,
            identity_verified_at: toIsoOrNull(s.identity_verified_at),
            identity_attempts: Number(s.identity_attempts ?? 0),
            token_expires_at: toIsoOrNull(s.token_expires_at),
          })),
          events: (events as unknown as Record<string, unknown>[]).map((e) => ({
            event: e.event,
            signer_id: e.signer_id,
            payload: e.payload,
            recorded_at: toIsoOrNull(e.recorded_at),
            ip: e.ip,
          })),
          request_id: requestId,
        };
        status = 200;
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // T · view
      // ═══════════════════════════════════════════════════════════════════════
      case "view": {
        const tc = tokenContext as TokenContext;
        assertTokenUsable(tc, { forSigning: false });

        const result = await withContext(ctx, async (tx) => {
          const firstView = tc.viewedAt === null;
          await tx`
            UPDATE public.e_sign_signers
               SET viewed_at = COALESCE(viewed_at, now()),
                   status    = CASE WHEN status IN ('pending', 'notified') THEN 'viewed' ELSE status END
             WHERE id = ${tc.signerId}::uuid
          `;
          await appendEvent(tx, {
            esignRequestId: tc.esignRequestId,
            signerId: tc.signerId,
            event: firstView ? "opened" : "viewed_page",
            payload: { signer_order: tc.signerOrder },
            ip,
            userAgent: ua,
            recordedBy: tc.profileId,
          });

          const docRows = await tx`
            SELECT d.id, d.title, d.storage_bucket, d.storage_path, d.page_count,
                   d.checksum_sha256, d.file_size_bytes
              FROM public.documents d
             WHERE d.id = ${tc.completedDocumentId ?? tc.documentId}::uuid
               AND d.deleted_at IS NULL
               AND d.virus_scan_status <> 'infected'
             LIMIT 1
          `;
          const doc = firstRow(docRows as unknown as Record<string, unknown>[]);
          if (doc !== null) {
            // §6: the access record is written BEFORE the URL is handed over.
            // `accessed_by` is NOT NULL and an external signer has no profile, so
            // the signer row's id stands in — the purpose text names what it is.
            await tx`
              INSERT INTO public.document_access_log
                (document_id, accessed_by, access_kind, purpose, ip, user_agent,
                 signed_url_expires_at, request_id)
              VALUES (
                ${doc.id as string}::uuid,
                ${tc.profileId ?? tc.signerId}::uuid,
                'signed_url_minted',
                ${`e-sign signer review — request ${tc.requestNumber}, signer ${tc.signerOrder} (${tc.fullName})`}::text,
                ${ip}::inet,
                ${ua}::text,
                now() + make_interval(secs => ${SIGNED_URL_TTL_SECONDS}::double precision),
                ${requestId}::uuid
              )
            `;
          }

          const others = await tx`
            SELECT s.signer_order, s.full_name, s.signer_kind, s.status::text AS status, s.signed_at
              FROM public.e_sign_signers s
             WHERE s.esign_request_id = ${tc.esignRequestId}::uuid
               AND s.status <> 'delegated'
             ORDER BY s.signer_order, s.created_at
          `;
          return { doc, others: others as unknown as Record<string, unknown>[] };
        });

        let documentUrl: string | null = null;
        if (result.doc !== null) {
          const signed = await serviceClient().storage
            .from(result.doc.storage_bucket as string)
            .createSignedUrl(result.doc.storage_path as string, SIGNED_URL_TTL_SECONDS);
          if (signed.error !== null || signed.data === null) {
            log.warn("signed url mint failed", { err: signed.error });
          } else {
            documentUrl = signed.data.signedUrl;
          }
        }

        responseBody = {
          ...signerView(tc, result.others),
          document: result.doc === null ? null : {
            title: result.doc.title,
            page_count: Number(result.doc.page_count ?? 0) || null,
            file_size_bytes: Number(result.doc.file_size_bytes ?? 0) || null,
            checksum_sha256: result.doc.checksum_sha256,
            url: documentUrl,
            url_expires_in_seconds: documentUrl === null ? null : SIGNED_URL_TTL_SECONDS,
          },
          request_id: requestId,
        };
        status = 200;
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // T · verify_identity
      // ═══════════════════════════════════════════════════════════════════════
      case "verify_identity": {
        const tc = tokenContext as TokenContext;
        assertTokenUsable(tc, { forSigning: false });

        if (tc.identityCheckKind === "none") {
          throw unprocessable(
            [{ pointer: "/answer", code: "not_required", detail: "This request needs no identity check." }],
            "No identity check is configured for you.",
            "ESIGN_IDENTITY_NOT_REQUIRED",
          );
        }
        if (tc.identityAttempts >= MAX_IDENTITY_ATTEMPTS) {
          throw locked(
            "Too many incorrect answers. Ask the sender to re-issue your signing link.",
            "ESIGN_IDENTITY_LOCKED",
          );
        }
        if (tc.identityCheckValueHash === null) {
          throw unprocessable(
            [{
              pointer: "/answer",
              code: "misconfigured",
              detail: "No expected answer was recorded for this identity check.",
            }],
            "This identity check cannot be completed.",
            "ESIGN_IDENTITY_MISCONFIGURED",
          );
        }

        const presentedHash = await sha256Hex(
          canonicalIdentityAnswer(tc.identityCheckKind, body.answer),
        );
        // Both sides are 64 hex characters of equal length; the comparison leaks
        // nothing useful, and the answer space is guarded by the attempt counter.
        const passed = presentedHash === tc.identityCheckValueHash;

        const attempts = await withContext(ctx, async (tx) => {
          if (passed) {
            await tx`
              UPDATE public.e_sign_signers
                 SET identity_verified_at = COALESCE(identity_verified_at, now()),
                     status = CASE WHEN status IN ('pending', 'notified', 'viewed')
                                   THEN 'identity_verified' ELSE status END
               WHERE id = ${tc.signerId}::uuid
            `;
          } else {
            await tx`
              UPDATE public.e_sign_signers
                 SET identity_attempts = identity_attempts + 1
               WHERE id = ${tc.signerId}::uuid
            `;
          }
          await appendEvent(tx, {
            esignRequestId: tc.esignRequestId,
            signerId: tc.signerId,
            event: passed ? "identity_passed" : "identity_failed",
            // The answer, and any hash of it, stays out of the trail.
            payload: { check_kind: tc.identityCheckKind, attempt: tc.identityAttempts + (passed ? 0 : 1) },
            ip,
            userAgent: ua,
            recordedBy: tc.profileId,
          });
          const rows = await tx`
            SELECT identity_attempts FROM public.e_sign_signers WHERE id = ${tc.signerId}::uuid
          `;
          return Number((firstRow(rows as unknown as { identity_attempts: number }[]))?.identity_attempts ?? 0);
        });

        if (!passed) {
          const remaining = Math.max(0, MAX_IDENTITY_ATTEMPTS - attempts);
          if (remaining === 0) {
            throw locked(
              "Too many incorrect answers. Ask the sender to re-issue your signing link.",
              "ESIGN_IDENTITY_LOCKED",
            );
          }
          throw forbidden(
            `That does not match our records. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`,
            "ESIGN_IDENTITY_FAILED",
          );
        }

        responseBody = {
          identity_verified: true as const,
          you: { full_name: tc.fullName, signer_order: tc.signerOrder },
          next: "You may now sign.",
          request_id: requestId,
        };
        status = 200;
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // T · sign
      // ═══════════════════════════════════════════════════════════════════════
      case "sign": {
        const tc = tokenContext as TokenContext;
        assertTokenUsable(tc, { forSigning: true });
        if (tc.requestExpiresAt !== null && tc.requestExpiresAt < nowIso()) {
          throw gone("This request has passed its expiry date.", "ESIGN_REQUEST_EXPIRED");
        }

        // Write the signature image first: it is referenced by the row we are
        // about to write, and `upsert: true` keeps a retry harmless.
        let signaturePath: string | null = null;
        if (body.signature.kind !== "typed") {
          const png = decodePngBase64(body.signature.image_base64 as string);
          signaturePath = `${tc.signerId}/signature.png`;
          await uploadObject("signatures", signaturePath, png, "image/png");
          uploadedSignature = signaturePath;
        }

        /** One instant for the row and the certificate; two clocks would disagree. */
        const signedAt = nowIso();

        const committed = await withContext(ctx, async (tx) => {
          await lockRequest(tx, tc.esignRequestId);

          // Re-assert eligibility under the lock. Between step 4 and here another
          // signer may have declined, or the request may have been cancelled.
          const fresh = await tx`
            SELECT s.status::text AS signer_status,
                   r.status::text AS request_status,
                   r.signing_order,
                   (SELECT min(x.signer_order) FROM public.e_sign_signers x
                     WHERE x.esign_request_id = r.id
                       AND x.status = ANY(${[...OPEN_SIGNER_STATUSES]}::public.signer_status[])) AS current_order,
                   t.revoked_at
              FROM public.e_sign_signers s
              JOIN public.e_sign_requests r ON r.id = s.esign_request_id
              LEFT JOIN secure.esign_signer_tokens t ON t.signer_id = s.id
             WHERE s.id = ${tc.signerId}::uuid
          `;
          const state = firstRow(fresh as unknown as Record<string, unknown>[]);
          if (state === null) throw notFound(undefined, "ESIGN_SIGNER_NOT_FOUND");
          if (state.revoked_at !== null) {
            throw gone("This signing link has already been used.", "ESIGN_TOKEN_CONSUMED");
          }
          if (!(OPEN_SIGNER_STATUSES as readonly string[]).includes(state.signer_status as string)) {
            throw conflict("You have already responded to this request.", "ESIGN_SIGNER_CLOSED");
          }
          if (!(SIGNABLE_REQUEST_STATUSES as readonly string[]).includes(state.request_status as string)) {
            throw conflict("This request is no longer open for signature.", "ESIGN_REQUEST_CLOSED");
          }
          if (
            state.signing_order === "sequential" &&
            state.current_order !== null &&
            Number(state.current_order) !== tc.signerOrder
          ) {
            throw conflict("It is not your turn yet.", "ESIGN_NOT_YOUR_TURN");
          }

          await tx`
            UPDATE public.e_sign_signers
               SET status               = 'signed',
                   signed_at            = ${signedAt}::timestamptz,
                   signature_image_path = ${signaturePath}::text,
                   signature_kind       = ${body.signature.kind}::text,
                   ip                   = ${ip}::inet,
                   user_agent           = ${ua}::text,
                   geo                  = ${body.geo === null || body.geo === undefined ? null : JSON.stringify(body.geo)}::jsonb,
                   timezone             = ${body.timezone ?? null}::text,
                   pages_signed         = ${body.pages_signed ?? null}::integer[],
                   viewed_at            = COALESCE(viewed_at, ${signedAt}::timestamptz)
             WHERE id = ${tc.signerId}::uuid
          `;
          // Consumed: this token can never produce a second signature.
          await revokeTokens(tx, tc.esignRequestId, tc.signerId);

          await appendEvent(tx, {
            esignRequestId: tc.esignRequestId,
            signerId: tc.signerId,
            event: "signed",
            payload: {
              signer_order: tc.signerOrder,
              signature_kind: body.signature.kind,
              typed_name: body.signature.typed_name ?? null,
              consent_statement: body.consent.statement,
              signed_at: signedAt,
              pages_signed: body.pages_signed ?? null,
              timezone: body.timezone ?? null,
              geo: body.geo ?? null,
              identity_check_kind: tc.identityCheckKind,
            },
            ip,
            userAgent: ua,
            recordedBy: tc.profileId,
          });

          const remainingRows = await tx`
            SELECT count(*)::integer AS remaining
              FROM public.e_sign_signers s
             WHERE s.esign_request_id = ${tc.esignRequestId}::uuid
               AND s.status = ANY(${[...OPEN_SIGNER_STATUSES]}::public.signer_status[])
          `;
          const remaining = Number((firstRow(remainingRows as unknown as { remaining: number }[]))?.remaining ?? 0);

          // 'partially_signed' either way: the request only becomes 'completed'
          // when the sealed PDF exists, so a stuck seal is visible rather than
          // silently reported as done.
          await tx`
            UPDATE public.e_sign_requests
               SET status = 'partially_signed'
             WHERE id = ${tc.esignRequestId}::uuid
               AND status <> 'completed'
          `;

          // Sequential chain advance: the next signatory gets a fresh token now.
          const issued: IssuedToken[] = [];
          if (remaining > 0 && state.signing_order === "sequential") {
            const nextRows = await tx`
              SELECT s.id, s.signer_order, s.full_name, s.email
                FROM public.e_sign_signers s
               WHERE s.esign_request_id = ${tc.esignRequestId}::uuid
                 AND s.status = ANY(${[...OPEN_SIGNER_STATUSES]}::public.signer_status[])
               ORDER BY s.signer_order, s.created_at
               LIMIT 1
            `;
            const next = firstRow(nextRows as unknown as {
              id: string;
              signer_order: number;
              full_name: string;
              email: string | null;
            }[]);
            if (next !== null) {
              const one = await issueToken(tx, next, DEFAULT_TOKEN_TTL_HOURS);
              issued.push(one);
              await appendEvent(tx, {
                esignRequestId: tc.esignRequestId,
                signerId: next.id,
                event: "sent",
                payload: { signer_order: one.signerOrder, reason: "chain advanced" },
                ip,
                userAgent: ua,
                recordedBy: tc.profileId,
              });
            }
          }

          return { remaining, issued };
        });

        // Committed: the signature stands whatever happens next.
        uploadedSignature = null;

        let seal: SealOutcome = { sealed: false, completedDocumentId: null, certificateHash: null };
        let sealPending = false;
        if (committed.remaining === 0) {
          try {
            seal = await performSeal(db, ctx, tc.esignRequestId, log);
          } catch (sealErr) {
            // A derived artefact failed, not the signature. 200 with
            // `seal_pending`, and `action: "seal"` finishes the job.
            sealPending = true;
            log.error("seal failed after final signature", {
              esign_request_id: tc.esignRequestId,
              err: sealErr,
            });
          }
        }

        responseBody = {
          signed: true as const,
          you: { full_name: tc.fullName, signer_order: tc.signerOrder, signed_at: signedAt },
          request: {
            request_number: tc.requestNumber,
            signatures_outstanding: committed.remaining,
            status: seal.sealed ? "completed" : "partially_signed",
          },
          sealed: seal.sealed,
          seal_pending: sealPending,
          certificate_hash: seal.certificateHash,
          completed_document_id: seal.completedDocumentId,
          next_signatory_notified: committed.issued.length > 0,
          request_id: requestId,
        };
        status = 200;
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // T · decline
      // ═══════════════════════════════════════════════════════════════════════
      case "decline": {
        const tc = tokenContext as TokenContext;
        assertTokenUsable(tc, { forSigning: true });

        responseBody = await withContext(ctx, async (tx) => {
          await lockRequest(tx, tc.esignRequestId);
          const updated = await tx`
            UPDATE public.e_sign_signers
               SET status          = 'declined',
                   declined_reason = ${body.reason}::text,
                   ip              = ${ip}::inet,
                   user_agent      = ${ua}::text
             WHERE id = ${tc.signerId}::uuid
               AND status = ANY(${[...OPEN_SIGNER_STATUSES]}::public.signer_status[])
            RETURNING id
          `;
          if ((updated as unknown as unknown[]).length === 0) {
            throw conflict("You have already responded to this request.", "ESIGN_SIGNER_CLOSED");
          }

          // One declination ends the whole chain: a partially signed document is
          // not a contract, and re-opening it must be a deliberate new request.
          await tx`
            UPDATE public.e_sign_requests
               SET status = 'declined'
             WHERE id = ${tc.esignRequestId}::uuid
               AND status IN ('sent', 'partially_signed')
          `;
          await revokeTokens(tx, tc.esignRequestId);
          await appendEvent(tx, {
            esignRequestId: tc.esignRequestId,
            signerId: tc.signerId,
            event: "declined",
            payload: { signer_order: tc.signerOrder, reason: body.reason },
            ip,
            userAgent: ua,
            recordedBy: tc.profileId,
          });

          if (tc.contractId !== null) {
            await tx`
              UPDATE public.contracts SET status = 'declined'
               WHERE id = ${tc.contractId}::uuid AND status NOT IN ('signed', 'superseded')
            `;
            await tx`
              INSERT INTO public.contract_events (contract_id, event, payload, ip, recorded_by)
              VALUES (${tc.contractId}::uuid, 'declined',
                      ${JSON.stringify({ signer_order: tc.signerOrder, reason: body.reason })}::jsonb,
                      ${ip}::inet, ${tc.profileId ?? null}::uuid)
            `;
          }

          return {
            declined: true as const,
            you: { full_name: tc.fullName, signer_order: tc.signerOrder },
            request: { request_number: tc.requestNumber, status: "declined" as const },
            request_id: requestId,
          };
        });
        status = 200;
        break;
      }
    }

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);

    log.info("action complete", { action: body.action, status });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    if (uploadedSignature !== null) {
      // The signature row was never written, so the image must not linger.
      try {
        await serviceClient().storage.from("signatures").remove([uploadedSignature]);
      } catch (removeErr) {
        log.error("orphaned signature image", { path: uploadedSignature, err: removeErr });
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
export {
  CancelAction,
  CreateAction,
  DeclineAction,
  EsignBody,
  SealAction,
  SendAction,
  SignAction,
  StatusAction,
  VerifyIdentityAction,
  ViewAction,
  canonicalIdentityAnswer,
};
