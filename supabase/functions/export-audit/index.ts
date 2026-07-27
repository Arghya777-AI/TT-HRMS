/**
 * export-audit — catalogue #18, auth model **U+ super_admin** (`audit.export`,
 * which `public.role_capabilities` marks `requires_step_up`).
 *
 * Streams a filtered slice of `public.audit_log` into `exports/<export_log_id>/`
 * as **`.csv.gz` plus a `manifest.json`**, records the act in
 * `public.export_log`, `public.data_access_log` and on the hash chain, and hands
 * back a short-lived signed URL.
 *
 * WHY A MANIFEST AND NOT JUST A CHECKSUM. The audit log is evidence: its value is
 * that `row_hash = sha256(prev_hash || canonical_row)` chains every row to the one
 * before it (migration 006), sealed daily into `audit_seals` with the head hash
 * mailed off-box. A CSV torn out of that chain proves nothing on its own. The
 * manifest therefore carries, alongside the file's SHA-256:
 *   - the `seq` range and the first/last `row_hash` of the slice, so the extract
 *     can be positioned inside the chain;
 *   - the `audit_seals` rows covering the window, whose `terminal_hash` values
 *     were recorded independently and can be compared with an off-box copy;
 *   - the result of `audit.verify_chain()` over the window, run at export time;
 *   - the exact recomputation recipe, so a third party can re-derive every
 *     `row_hash` from the CSV without our code.
 * That is what makes this an export a regulator can use rather than a spreadsheet.
 *
 * STREAMING, on purpose: rows leave Postgres through a server-side CURSOR in
 * batches, are serialised to CSV and pushed straight through a `CompressionStream`
 * — the uncompressed CSV is never held in memory, only the gzip output is
 * accumulated so it can be hashed and uploaded as one object. A row ceiling and a
 * byte ceiling END THE PAGE rather than failing it: what was written is a complete
 * prefix of the ordered slice, `partial` says so, and `nextAfterSeq` is the cursor
 * for the next page — which is its own separately manifested export.
 *
 * TWO DELIBERATE REFUSALS:
 *   1. The CSV is written VERBATIM — no neutralising of leading `=`/`+`/`@`, no
 *      trimming, no re-formatting. Spreadsheet-injection hardening would change
 *      bytes whose whole purpose is to hash to a known value. The manifest says,
 *      in words, not to open the file in a spreadsheet.
 *   2. `ck_export_log__approval` requires a named approver once an export carries
 *      salary or more than 500 rows, and this function enforces exactly that: a
 *      second live super_admin, never the exporter (Q20: there are two, by
 *      design). It is refused at the edge with a readable 422 rather than left to
 *      surface as a CHECK violation.
 *
 * ONE LOCAL INSERT, EXPLAINED. Every other audit write here goes through
 * `_shared/audit.ts`. The `public.export_log` row does not, because migration 039
 * fixes the object path as `<export_log_id>/<file>` and `export_log` is
 * insert-only (`audit.refuse_mutation`): the id must be known BEFORE the object is
 * written and can never be patched afterwards, and `auditExport()` has no
 * parameter for it. The row is therefore inserted with an id generated here, and
 * the chain row and the `data_access_log` row are still written by the shared
 * helpers. `auditExport()` gaining an optional id would remove this exception.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  badGateway,
  forbidden,
  methodNotAllowed,
  notFound,
  ok,
  toProblem,
  unprocessable,
} from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { addDays, daysBetween, istInstant, istToday, nowIso, toIso } from "../_shared/datetime.ts";
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
import type { Sql } from "../_shared/deps.ts";
import { requireCapWithStepUp, requireRole, verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import {
  claim,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";
import { auditDataAccess, writeAudit } from "../_shared/audit.ts";

const FN_NAME = "export-audit";
const CAP = "audit.export";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

const EXPORTS_BUCKET = "exports";
/** `ck_export_log__kind` / `ck_export_log__subject`. */
const EXPORT_KIND = "audit_dump";
const EXPORT_SUBJECT = "audit_log";

/** Longest window one export may cover; audit is retained 25 months hot (§6). */
const MAX_RANGE_DAYS = 400;
/**
 * Rows in ONE file. This is a page size, not a refusal: a wider window is
 * exported in slices, each with its own `export_log` row and its own manifest,
 * and the response hands back `nextAfterSeq` to continue from.
 */
const MAX_ROWS = 150_000;
/** Ceiling on the stored object. Reaching it ends the page early, honestly. */
const MAX_OBJECT_BYTES = 40 * 1024 * 1024;
/** Rows fetched per cursor batch. */
const CURSOR_BATCH = 2_000;
/** `audit.verify_chain` re-hashes every row; only worth it on a small window. */
const VERIFY_MAX_ROWS = 60_000;
/** `ck_export_log__approval` demands an approver beyond this row count. */
const APPROVAL_ROW_THRESHOLD = 500;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

/** `public.audit_action` — the caller may filter to any subset. */
const AUDIT_ACTIONS = [
  "insert",
  "update",
  "delete",
  "soft_delete",
  "restore",
  "hard_delete",
  "login",
  "logout",
  "login_failed",
  "read_sensitive",
  "export",
  "approve",
  "reject",
  "cancel",
  "void",
  "override",
  "recompute",
  "lock",
  "unlock",
  "send",
  "sign",
  "enrol_biometric",
  "purge_biometric",
  "grant_role",
  "revoke_role",
  "impersonate",
  "config_change",
  "job_run",
] as const;

/** Entity tables whose audited values can carry pay. Drives `contains_salary`. */
const SALARY_TABLE_RE = /salary|payroll|payslip|revision|bank_account|statutory|claim|bonus/i;

const Body = z
  .object({
    /** Inclusive IST business dates. The UTC bounds are derived, not supplied. */
    from: common.isoDate,
    to: common.isoDate,
    actions: z.array(z.enum(AUDIT_ACTIONS)).min(1).max(AUDIT_ACTIONS.length).optional(),
    /** Schema-qualified, e.g. `public.employees`. */
    entityTables: z.array(z.string().trim().min(3).max(120)).min(1).max(50).optional(),
    actorIds: z.array(common.uuid).min(1).max(200).optional(),
    subjectEmployeeIds: z.array(common.uuid).min(1).max(200).optional(),
    /** Trace one request end to end. */
    correlationRequestId: common.uuid.optional(),
    /** Only `is_redacted = false` rows, or only redacted ones. */
    redactedOnly: z.boolean().optional(),
    /**
     * Include `old_value` / `new_value`. Omitting them yields a metadata-only
     * trail ("who touched what, when") with far less personal data in it.
     */
    includeValues: z.boolean().default(true),
    /** Paging cursor: exclusive lower bound on `seq`. Echo `nextAfterSeq`. */
    afterSeq: z.number().int().min(0).optional(),
    /** Run `audit.verify_chain` over the window and record the result. */
    verifyChain: z.boolean().default(true),
    /** A second live super_admin. Required once the CHECK constraint demands one. */
    approvedBy: common.uuid.optional(),
    /** `ck_export_log__purpose` and `ck_dalog__purpose`: at least 10 characters. */
    purpose: common.reason,
  })
  .strict()
  .superRefine((value, ctx) => {
    const span = daysBetween(value.from, value.to);
    if (span < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "`to` must not precede `from`." });
      return;
    }
    if (span + 1 > MAX_RANGE_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `One export may cover at most ${MAX_RANGE_DAYS} days.`,
      });
    }
    if (value.from > istToday()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "`from` is in the future; there is nothing to export.",
      });
    }
  });

// ═════════════════════════════════════════════════════════════════════════════
// CSV
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every field quoted, always. Fully-quoted output is the same discipline the
 * importer demands of the client: a consumer never has to guess whether an empty
 * field was NULL-ish, and no identifier can be re-read as a number.
 *
 * A NULL is written as an EMPTY UNQUOTED field, which is the only way a CSV can
 * distinguish "no value" from "the empty string".
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (value instanceof Date) text = toIso(value);
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

interface CsvColumn {
  name: string;
  read: (row: Record<string, unknown>) => unknown;
}

function csvColumns(includeValues: boolean): CsvColumn[] {
  const columns: CsvColumn[] = [
    { name: "seq", read: (r) => r.seq },
    { name: "occurred_at_utc", read: (r) => r.occurred_at },
    { name: "ist_timestamp", read: (r) => r.ist_timestamp },
    { name: "ist_date", read: (r) => r.ist_date },
    { name: "action", read: (r) => r.action },
    { name: "entity_table", read: (r) => r.entity_table },
    { name: "entity_id", read: (r) => r.entity_id },
    { name: "entity_label", read: (r) => r.entity_label },
    { name: "subject_employee_id", read: (r) => r.subject_employee_id },
    { name: "field_name", read: (r) => r.field_name },
  ];
  if (includeValues) {
    columns.push(
      { name: "old_value", read: (r) => r.old_value },
      { name: "new_value", read: (r) => r.new_value },
    );
  }
  columns.push(
    { name: "is_redacted", read: (r) => r.is_redacted },
    { name: "reason", read: (r) => r.reason },
    { name: "actor_id", read: (r) => r.actor_id },
    { name: "actor_employee_id", read: (r) => r.actor_employee_id },
    { name: "actor_email", read: (r) => r.actor_email },
    { name: "actor_role", read: (r) => r.actor_role },
    { name: "actor_source", read: (r) => r.actor_source },
    { name: "on_behalf_of", read: (r) => r.on_behalf_of },
    { name: "impersonated_by", read: (r) => r.impersonated_by },
    { name: "approval_request_id", read: (r) => r.approval_request_id },
    { name: "source", read: (r) => r.source },
    { name: "request_id", read: (r) => r.request_id },
    { name: "transaction_id", read: (r) => r.transaction_id },
    { name: "ip", read: (r) => r.ip },
    { name: "user_agent", read: (r) => r.user_agent },
    { name: "device_id", read: (r) => r.device_id },
    { name: "session_id", read: (r) => r.session_id },
    { name: "chain_id", read: (r) => r.chain_id },
    { name: "prev_hash", read: (r) => r.prev_hash },
    { name: "row_hash", read: (r) => r.row_hash },
  );
  return columns;
}

// ═════════════════════════════════════════════════════════════════════════════
// Gzip sink
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A `CompressionStream` wrapper that accumulates only the COMPRESSED output.
 * Reader and writer run concurrently: writing without draining would deadlock on
 * the stream's backpressure once its queue filled.
 */
class GzipSink {
  /**
   * The WHATWG IDL types `CompressionStream.writable` as `WritableStream<
   * BufferSource>` while some runtime libs narrow it to `Uint8Array`; the two
   * disagree under `strict` in opposite directions. One cast here fixes the shape
   * once, so every member below is precisely typed instead of every call site
   * carrying an assertion. Nothing is loosened: what we write is always the
   * encoder's `Uint8Array`, and what gzip emits is always bytes.
   */
  private readonly stream = new CompressionStream("gzip") as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly drain: Promise<void>;
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor() {
    this.writer = this.stream.writable.getWriter();
    this.drain = (async () => {
      const reader = this.stream.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        if (value !== undefined) {
          this.chunks.push(value);
          this.bytes += value.byteLength;
        }
      }
    })();
  }

  get compressedBytes(): number {
    return this.bytes;
  }

  write(text: string): Promise<void> {
    return this.writer.write(this.encoder.encode(text));
  }

  async finish(): Promise<Uint8Array> {
    await this.writer.close();
    await this.drain;
    const out = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /** Release the stream after a failure so the drain promise cannot dangle. */
  async abort(): Promise<void> {
    try {
      await this.writer.abort();
    } catch {
      // Already errored or closed; nothing to do.
    }
    try {
      await this.drain;
    } catch {
      // The drain rejects when the writer is aborted. Expected.
    }
  }
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // The copy into a fresh `ArrayBuffer` is deliberate, and matches
  // `document-generate`: a `Uint8Array` may be backed by a `SharedArrayBuffer`,
  // which is not a `BufferSource`, so pinning the type here keeps this compiling
  // on every TypeScript version rather than only the one that widened
  // `Uint8Array` to a generic.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** postgres.js query handle, narrowed to the cursor API this function needs. */
interface CursorQuery<T> {
  cursor(size: number, callback: (rows: T[]) => Promise<void> | void): Promise<void>;
}

/** Thrown from inside the cursor callback to stop the scan at the byte ceiling. */
class ObjectTooLarge extends Error {
  override readonly name = "ObjectTooLarge";
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
  /** Objects already in the bucket, so a later failure can remove them. */
  const uploaded: string[] = [];
  let committed = false;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model U+) ────────────────────────────────────────────
    const auth = await verifyUser(req);
    const db = sql();

    // ── STEP 5 · Authority, from the DATABASE ───────────────────────────────
    // `audit.export` is seeded against `super_admin` only and carries
    // `requires_step_up`, so `requireCapWithStepUp` enforces both. The explicit
    // role assertion is belt and braces: if the capability were ever mis-seeded
    // against `admin`, the audit log would still not be exportable by an admin.
    await requireCapWithStepUp(db, auth, CAP);
    requireRole(auth, "super_admin");

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    await enforce(RATE_LIMITS.export, limitKey(FN_NAME, auth.userId), "EXPORT_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const { data: body, raw } = await parseBody(req, Body);

    const today = istToday();
    const from = body.from;
    const to = body.to > today ? today : body.to;

    // IST dates in, UTC instants out. `[fromInstant, toInstant)` is exactly the
    // IST window, and because `audit_log` is partitioned on `occurred_at` the
    // bounds also prune the partitions the scan touches.
    const fromInstant = toIso(istInstant(from, "00:00:00"));
    const toInstant = toIso(istInstant(addDays(to, 1), "00:00:00"));

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // An export is a mutation: it writes `export_log`, `data_access_log`, two
    // chain rows and two storage objects. A retry must replay, not re-export.
    idempotencyKey = requireIdempotencyKey(req);
    const claimed = await claim({
      key: idempotencyKey,
      fnName: FN_NAME,
      requestHash: await requestHash(FN_NAME, raw, auth.userId),
      actorId: auth.userId,
    });
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { key: idempotencyKey });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    const ctx: RequestContext = {
      actorId: auth.userId,
      actorRole: auth.role,
      source: "web_admin",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      reason: body.purpose,
    };

    // Nullable filter parameters, bound once and reused by the count, the scan
    // and the manifest so the three can never describe different sets of rows.
    const actions = body.actions ?? null;
    const entityTables = body.entityTables ?? null;
    const actorIds = body.actorIds ?? null;
    const subjectIds = body.subjectEmployeeIds ?? null;
    const correlationId = body.correlationRequestId ?? null;
    const redactedOnly = body.redactedOnly ?? null;
    const afterSeq = body.afterSeq ?? 0;

    /** The one WHERE clause of this function, applied by both queries below. */
    const whereClause = (client: Sql) =>
      client`
        a.occurred_at >= ${fromInstant}::timestamptz
        AND a.occurred_at <  ${toInstant}::timestamptz
        AND a.seq > ${afterSeq}::bigint
        AND (${actions}::text[] IS NULL OR a.action::text = ANY(${actions}::text[]))
        AND (${entityTables}::text[] IS NULL OR a.entity_table = ANY(${entityTables}::text[]))
        AND (${actorIds}::uuid[] IS NULL OR a.actor_id = ANY(${actorIds}::uuid[]))
        AND (${subjectIds}::uuid[] IS NULL OR a.subject_employee_id = ANY(${subjectIds}::uuid[]))
        AND (${correlationId}::uuid IS NULL OR a.request_id = ${correlationId}::uuid)
        AND (${redactedOnly}::boolean IS NULL OR a.is_redacted = ${redactedOnly}::boolean)
      `;

    // ── Size and shape of the slice, before any work is done ────────────────
    const countRows = await db`
      SELECT count(*)::bigint       AS row_count,
             min(a.seq)::bigint     AS first_seq,
             max(a.seq)::bigint     AS last_seq
        FROM public.audit_log a
       WHERE ${whereClause(db)}
    `;
    const counts = firstRow(
      countRows as unknown as { row_count: string; first_seq: string | null; last_seq: string | null }[],
    );
    const rowCount = Number(counts?.row_count ?? "0");

    if (rowCount === 0) {
      // 404, not an empty file: an export row and an object that prove nothing
      // are worse than a clear "that window is empty".
      throw notFound(
        "No audit rows match those filters, so no export was produced.",
        "AUDIT_EXPORT_EMPTY",
      );
    }
    // ── The approval rule the DB will enforce anyway (§4.9) ─────────────────
    const containsSalary = body.includeValues &&
      (entityTables === null || entityTables.some((table) => SALARY_TABLE_RE.test(table)));
    const needsApproval = rowCount > APPROVAL_ROW_THRESHOLD || containsSalary;

    let approvedBy: string | null = null;
    if (needsApproval) {
      if (body.approvedBy === undefined) {
        throw unprocessable(
          [{
            pointer: "/approvedBy",
            code: "required",
            detail: `An export of ${rowCount} rows${containsSalary ? " that can contain pay data" : ""} ` +
              "needs a second super admin named as approver (ck_export_log__approval). " +
              "Pass their profile id in approvedBy.",
          }],
          "This export needs a named approver.",
          "EXPORT_APPROVAL_REQUIRED",
        );
      }
      if (body.approvedBy === auth.userId) {
        throw forbidden(
          "An export cannot approve itself: name a different super admin.",
          "SELF_APPROVAL_BLOCKED",
        );
      }
      const approverRows = await db`
        SELECT p.id
          FROM public.profiles p
         WHERE p.id = ${body.approvedBy}::uuid
           AND p.is_active
           AND EXISTS (
             SELECT 1 FROM public.user_roles ur
              WHERE ur.user_id = p.id
                AND ur.role = 'super_admin'::public.app_role
                AND ur.revoked_at IS NULL
           )
         LIMIT 1
      `;
      if (firstRow(approverRows as unknown as { id: string }[]) === null) {
        throw unprocessable(
          [{
            pointer: "/approvedBy",
            code: "invalid",
            detail: "The named approver is not an active super admin.",
          }],
          "The approver could not be accepted.",
          "APPROVER_INVALID",
        );
      }
      approvedBy = body.approvedBy;
    }

    // ── Chain context for the manifest ──────────────────────────────────────
    // `audit.verify_chain` walks by `occurred_at::date` in UTC. An IST day starts
    // at 18:30 UTC on the PREVIOUS calendar day, so the UTC window that covers
    // this IST window starts a day earlier. Verifying slightly more of the chain
    // than was exported is harmless; verifying less would be a false assurance.
    const utcFromDate = addDays(from, -1);
    const utcToDate = to;

    const columns = csvColumns(body.includeValues);
    const columnNames = columns.map((column) => column.name);

    interface SealRow {
      seal_date: string;
      first_seq: string;
      last_seq: string;
      row_count: string;
      terminal_hash: string;
      sealed_at: Date | string;
      verified_at: Date | string | null;
      verification_result: string | null;
    }

    const sealRows = await db`
      SELECT s.seal_date::text AS seal_date,
             s.first_seq::text AS first_seq,
             s.last_seq::text  AS last_seq,
             s.row_count::text AS row_count,
             s.terminal_hash,
             s.sealed_at,
             s.verified_at,
             s.verification_result
        FROM public.audit_seals s
       WHERE s.seal_date BETWEEN ${utcFromDate}::date AND ${utcToDate}::date
       ORDER BY s.seal_date
    `;
    const seals = (sealRows as unknown as SealRow[]).map((seal) => ({
      sealDate: seal.seal_date,
      firstSeq: Number(seal.first_seq),
      lastSeq: Number(seal.last_seq),
      rowCount: Number(seal.row_count),
      terminalHash: seal.terminal_hash,
      sealedAt: toIso(seal.sealed_at),
      verifiedAt: seal.verified_at === null ? null : toIso(seal.verified_at),
      verificationResult: seal.verification_result,
    }));

    interface ChainVerification {
      ran: boolean;
      intact: boolean | null;
      skippedReason: string | null;
      firstBadSeq: number | null;
      note: string | null;
    }
    let verification: ChainVerification = {
      ran: false,
      intact: null,
      skippedReason: null,
      firstBadSeq: null,
      note: null,
    };
    if (body.verifyChain) {
      if (rowCount > VERIFY_MAX_ROWS) {
        verification = {
          ran: false,
          intact: null,
          skippedReason: `window holds ${rowCount} rows, above the ${VERIFY_MAX_ROWS}-row ` +
            "verification ceiling; cron-integrity verifies the chain nightly",
          firstBadSeq: null,
          note: null,
        };
      } else {
        const badRows = await db`
          SELECT v.bad_seq::text AS bad_seq, v.note
            FROM audit.verify_chain(${utcFromDate}::date, ${utcToDate}::date) v
           LIMIT 1
        `;
        const bad = firstRow(badRows as unknown as { bad_seq: string; note: string }[]);
        verification = {
          ran: true,
          intact: bad === null,
          skippedReason: null,
          firstBadSeq: bad === null ? null : Number(bad.bad_seq),
          note: bad === null ? "chain intact over the exported window" : bad.note,
        };
      }
    }

    // ── Stream: cursor → CSV → gzip ─────────────────────────────────────────
    const exportId = crypto.randomUUID();
    const sink = new GzipSink();
    let written = 0;
    let firstRowHash: string | null = null;
    let firstPrevHash: string | null = null;
    let lastRowHash: string | null = null;
    let lastSeq = afterSeq;
    let truncatedByBytes = false;

    try {
      await sink.write(`${columnNames.map((name) => `"${name}"`).join(",")}\r\n`);
      await withContext(ctx, async (tx) => {
        const query = tx`
          SELECT a.seq::text                 AS seq,
                 a.occurred_at,
                 a.ist_timestamp::text       AS ist_timestamp,
                 a.ist_date::text            AS ist_date,
                 a.actor_id,
                 a.actor_employee_id,
                 a.actor_role::text          AS actor_role,
                 a.actor_email,
                 a.actor_source::text        AS actor_source,
                 a.on_behalf_of,
                 a.impersonated_by,
                 a.action::text              AS action,
                 a.entity_table,
                 a.entity_id,
                 a.entity_label,
                 a.subject_employee_id,
                 a.field_name,
                 a.old_value,
                 a.new_value,
                 a.is_redacted,
                 a.reason,
                 a.source,
                 a.request_id,
                 a.transaction_id::text      AS transaction_id,
                 a.ip::text                  AS ip,
                 a.user_agent,
                 a.device_id,
                 a.session_id,
                 a.approval_request_id,
                 a.prev_hash,
                 a.row_hash,
                 a.chain_id
            FROM public.audit_log a
           WHERE ${whereClause(tx)}
           ORDER BY a.seq
           LIMIT ${MAX_ROWS}::bigint
        ` as unknown as CursorQuery<Record<string, unknown>>;

        await query.cursor(CURSOR_BATCH, async (batch) => {
          let payload = "";
          for (const row of batch) {
            payload += `${columns.map((column) => csvField(column.read(row))).join(",")}\r\n`;
            written += 1;
            if (firstRowHash === null) {
              firstRowHash = typeof row.row_hash === "string" ? row.row_hash : null;
              firstPrevHash = typeof row.prev_hash === "string" ? row.prev_hash : null;
            }
            if (typeof row.row_hash === "string") lastRowHash = row.row_hash;
            lastSeq = Number(row.seq);
          }
          await sink.write(payload);
          if (sink.compressedBytes > MAX_OBJECT_BYTES) throw new ObjectTooLarge();
        });
      });
    } catch (streamErr) {
      // The byte ceiling ends the PAGE, it does not fail the export: everything
      // already compressed is a complete prefix of the ordered slice, and
      // `nextAfterSeq` says exactly where it stopped. Any other failure discards
      // the stream — a half-written audit extract must never be published.
      if (streamErr instanceof ObjectTooLarge) truncatedByBytes = true;
      else {
        await sink.abort();
        throw streamErr;
      }
    }
    const gzip = await sink.finish();
    const partial = truncatedByBytes || written < rowCount;

    const checksum = await sha256HexBytes(gzip);
    const fileName = `audit-log_${from}_to_${to}.csv.gz`;
    // Migration 039: the exports policy keys on `foldername[1] = export_log.id`.
    const objectPath = `${exportId}/${fileName}`;
    const manifestPath = `${exportId}/manifest.json`;

    const firstSeqRaw = counts?.first_seq ?? null;
    const firstSeq = firstSeqRaw === null ? null : Number(firstSeqRaw);

    const filters = {
      ist_from: from,
      ist_to: to,
      requested_to: body.to,
      occurred_at_from_utc: fromInstant,
      occurred_at_to_utc_exclusive: toInstant,
      after_seq: afterSeq,
      actions,
      entity_tables: entityTables,
      actor_ids: actorIds,
      subject_employee_ids: subjectIds,
      correlation_request_id: correlationId,
      redacted_only: redactedOnly,
      include_values: body.includeValues,
    };

    const manifest = {
      manifest_version: 1,
      export_id: exportId,
      subject: EXPORT_SUBJECT,
      export_kind: EXPORT_KIND,
      generated_at: nowIso(),
      generated_by: { profile_id: auth.userId, email: auth.email, role: auth.role },
      approved_by: approvedBy,
      purpose: body.purpose,
      request_id: requestId,
      filters,
      columns: columnNames,
      row_count: written,
      seq_range: { first: firstSeq, last: lastSeq },
      partial,
      next_after_seq: partial ? lastSeq : null,
      truncated_by: truncatedByBytes ? "byte_ceiling" : written < rowCount ? "row_ceiling" : null,
      rows_matching_filters: rowCount,
      chain: {
        chain_id: "global",
        first_prev_hash: firstPrevHash,
        first_row_hash: firstRowHash,
        last_row_hash: lastRowHash,
        verification,
        seals,
        recomputation:
          "row_hash = sha256(concat_ws('|', prev_hash, seq, occurred_at, actor_id, action, " +
          "entity_table, entity_id, field_name, old_value, new_value, reason)) with NULLs as empty " +
          "strings and occurred_at rendered in UTC — the exact payload of audit.write_row() " +
          "(migration 006). Each row's prev_hash equals the preceding row's row_hash in seq order.",
      },
      file: {
        name: fileName,
        storage_bucket: EXPORTS_BUCKET,
        storage_path: objectPath,
        sha256: checksum,
        byte_size: gzip.byteLength,
        content_encoding: "gzip",
        csv: { delimiter: ",", quoting: "all-fields", line_ending: "CRLF", encoding: "utf-8" },
      },
      handling:
        "Evidence. Verify with `sha256sum` BEFORE decompressing, then `gunzip -c`. Do not open the " +
        "CSV in a spreadsheet: it will re-read identifiers as numbers and may evaluate leading '=' " +
        "as a formula. The bytes are deliberately unmodified so this checksum stays meaningful.",
    };
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const manifestChecksum = await sha256HexBytes(manifestBytes);

    // ── Upload both objects BEFORE the transaction (Storage is not txn-safe) ─
    const storage = serviceClient().storage.from(EXPORTS_BUCKET);
    const gzipUpload = await storage.upload(objectPath, gzip, {
      contentType: "application/gzip",
      upsert: false,
      cacheControl: "no-store",
    });
    if (gzipUpload.error !== null) {
      log.error("export upload failed", { err: gzipUpload.error });
      throw badGateway("The export could not be stored. Nothing was recorded.", "STORAGE_UPLOAD_FAILED", {
        cause: gzipUpload.error,
      });
    }
    uploaded.push(objectPath);

    const manifestUpload = await storage.upload(manifestPath, manifestBytes, {
      contentType: "application/json; charset=utf-8",
      upsert: false,
      cacheControl: "no-store",
    });
    if (manifestUpload.error !== null) {
      log.error("manifest upload failed", { err: manifestUpload.error });
      throw badGateway(
        "The export manifest could not be stored, so the export was discarded.",
        "STORAGE_UPLOAD_FAILED",
        { cause: manifestUpload.error },
      );
    }
    uploaded.push(manifestPath);

    // ── STEP 9/10 · One transaction: export_log + data_access_log + chain ────
    await withContext(ctx, async (tx) => {
      // The local INSERT explained in the header: the id must exist before the
      // object path does, and `export_log` can never be updated afterwards.
      await tx`
        INSERT INTO public.export_log (
          id, actor_id, actor_role, export_kind, subject, filters, columns, row_count,
          file_size_bytes, contains_pii, contains_salary, contains_biometric,
          storage_path, checksum_sha256, purpose, approved_by, ip, user_agent, request_id
        ) VALUES (
          ${exportId}::uuid,
          ${auth.userId}::uuid,
          ${auth.role}::public.app_role,
          ${EXPORT_KIND}::text,
          ${EXPORT_SUBJECT}::text,
          ${JSON.stringify(filters)}::jsonb,
          ${columnNames}::text[],
          ${written}::integer,
          ${gzip.byteLength}::bigint,
          -- contains_pii: always. Even a values-free extract carries actor emails,
          -- entity labels (employee names) and IP addresses.
          true,
          ${containsSalary}::boolean,
          false,
          ${objectPath}::text,
          ${checksum}::text,
          ${body.purpose}::text,
          ${approvedBy}::uuid,
          ${ctx.ip}::inet,
          ${ctx.ua}::text,
          ${requestId}::uuid
        )
      `;

      // The hash-chained record of the export itself.
      await writeAudit(tx, ctx, {
        action: "export",
        entityTable: "public.export_log",
        entityId: exportId,
        entityLabel: `${EXPORT_KIND}:${EXPORT_SUBJECT}`,
        newValue: {
          row_count: written,
          seq_range: { first: manifest.seq_range.first, last: lastSeq },
          file_sha256: checksum,
          manifest_sha256: manifestChecksum,
          storage_path: objectPath,
          approved_by: approvedBy,
          include_values: body.includeValues,
          chain_verified: verification.intact,
        },
        reason: body.purpose,
      });

      // §6: an export of personal data is a data-access event in its own right,
      // recorded with the purpose BEFORE the file is handed over.
      await auditDataAccess(tx, ctx, {
        accessKind: "export",
        entityTable: "public.audit_log",
        entityId: exportId,
        fields: columnNames,
        purpose: body.purpose,
        recordCount: written,
        filterSummary: filters,
      });
    });
    committed = true;

    // ── Signed URL (TTL from settings, not a constant here) ─────────────────
    const ttlRows = await db`SELECT app.setting('security.signed_url_default_ttl_seconds') AS value`;
    const configuredTtl = Number((ttlRows as unknown as { value: string | null }[])[0]?.value ?? "");
    const ttlSeconds = Number.isFinite(configuredTtl) && configuredTtl > 0
      ? Math.min(3_600, Math.trunc(configuredTtl))
      : DEFAULT_SIGNED_URL_TTL_SECONDS;

    const signed = await storage.createSignedUrl(objectPath, ttlSeconds);
    const signedManifest = await storage.createSignedUrl(manifestPath, ttlSeconds);
    if (signed.error !== null) {
      // The export EXISTS and is recorded; only the convenience link failed.
      log.warn("signed url failed", { err: signed.error });
    }

    const responseBody = {
      exportId,
      subject: EXPORT_SUBJECT,
      exportKind: EXPORT_KIND,
      scope: { from, to, requestedTo: body.to, afterSeq, includeValues: body.includeValues },
      totals: {
        rowCount: written,
        rowsMatchingFilters: rowCount,
        byteSize: gzip.byteLength,
        seqFirst: firstSeq,
        seqLast: lastSeq,
      },
      partial,
      truncatedBy: truncatedByBytes ? "byte_ceiling" : written < rowCount ? "row_ceiling" : null,
      /** Echo as `afterSeq` to export the next page of the same window. */
      nextAfterSeq: partial ? lastSeq : null,
      file: {
        bucket: EXPORTS_BUCKET,
        path: objectPath,
        name: fileName,
        sha256: checksum,
        contentEncoding: "gzip",
      },
      manifest: { path: manifestPath, sha256: manifestChecksum },
      chain: { verification, sealCount: seals.length, lastRowHash },
      approvedBy,
      download: {
        url: signed.error === null ? signed.data?.signedUrl ?? null : null,
        manifestUrl: signedManifest.error === null ? signedManifest.data?.signedUrl ?? null : null,
        expiresInSeconds: ttlSeconds,
      },
      purpose: body.purpose,
      requestId,
    };
    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    // The signed URL is short-lived and deliberately NOT replayed: a stored URL
    // would be a bearer credential sitting in a table long after it expired.
    await store(idempotencyKey, status, {
      ...responseBody,
      download: { url: null, manifestUrl: null, expiresInSeconds: 0 },
    });

    log.info("audit export written", {
      export_id: exportId,
      rows: written,
      rows_matching: rowCount,
      bytes: gzip.byteLength,
      partial,
      chain_verified: verification.intact,
    });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const asProblem = toProblem(err, requestId).withContext({ requestId, instance });
    status = asProblem.status;

    // An object with no `export_log` row is untraceable — exactly what an audit
    // export must never leave behind. Remove it, but only while uncommitted.
    if (uploaded.length > 0 && !committed) {
      try {
        await serviceClient().storage.from(EXPORTS_BUCKET).remove(uploaded);
        log.warn("rolled back export objects", { count: uploaded.length });
      } catch (removeErr) {
        log.error("orphaned export objects", { paths: uploaded, err: removeErr });
      }
    }

    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, asProblem.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }

    if (asProblem.isServerFault) log.error("unhandled failure", { err, code: asProblem.code });
    else log.warn("request refused", { code: asProblem.code, status });
    return asProblem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported so `supabase/tests` and the audit console assert against one schema. */
export { Body, csvColumns, csvField };
