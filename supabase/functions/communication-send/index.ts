/**
 * communication-send — catalogue #13, auth model **U** (`comms.send`) or **C**.
 *
 * Two routes in one function (Supabase deploys a directory, not a router):
 *
 *   POST /communication-send          transactional | broadcast | policy | send_pending
 *   POST /communication-send/webhook  Resend delivery webhook, Svix-HMAC verified
 *
 * The send path walks the 12-step lifecycle of spec-architecture §4 in order,
 * with one deliberate deviation that is written down because it looks like a
 * violation: the work happens in **two** transactions, not one.
 *
 *   txn 1  resolve the audience → `communications` (status `sending`) +
 *          `communication_recipients` + one `queued` event per recipient
 *          (+ `secure.communication_recipient_tokens` when an ack link is needed)
 *   ---    Resend HTTP calls. NO transaction is open across the network.
 *   txn 2  per-recipient status + `sent`/`bounced`/`deferred` events + the
 *          counters on `communications` + ONE `send` audit row
 *
 * Holding a Postgres transaction open across a few hundred third-party HTTP
 * calls would pin a connection for minutes and roll back delivery facts that
 * already happened out in the world. A crash between the two transactions leaves
 * recipients `queued` — which `mode: "send_pending"` picks up. That is the whole
 * reason `send_pending` exists.
 *
 * Trust boundary B5 (§1): `RESEND_API_KEY` is read from the function secret and
 * never leaves this file; the webhook is HMAC-verified before a single row is
 * written; the log redactor keeps both out of stdout.
 *
 * NOT here, on purpose:
 *   - SMTP failover. §4 names Resend "primary, SMTP failover", but no SMTP
 *     credentials exist in the secret inventory (§5) and inventing a second
 *     transport would mean inventing its configuration. A transient Resend
 *     failure leaves the recipient `queued` + a `deferred` event, so a retry
 *     (or the failover, when it is configured) loses nothing.
 *   - SMS/WhatsApp. `notifications.sms_enabled` is false until the DLT
 *     templates are registered with TRAI; `channels` accepts `email` only.
 *   - Attaching document bytes. Documents are linked, not attached: a signed
 *     Storage URL is minted by the document surface, not mailed as a blob.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  methodNotAllowed,
  notFound,
  ok,
  toProblem,
  unauthorized,
  unavailable,
  unprocessable,
} from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger, type Logger } from "../_shared/log.ts";
import { epochSeconds, istToday, nowIso, secondsBetween } from "../_shared/datetime.ts";
import {
  APP_ROLES,
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import type { Sql } from "../_shared/deps.ts";
import {
  type AuthContext,
  constantTimeEqual,
  rejectBrowserOrigin,
  requireCapWithStepUp,
  sha256Hex,
  verifyCron,
  verifyUser,
} from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { auditJobRun, writeAudit } from "../_shared/audit.ts";
import {
  claim,
  idempotencyKeyFrom,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";

const FN_NAME = "communication-send";
const CAP = "comms.send";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
/** Concurrent Resend calls. Their documented ceiling is 2 req/s per key on the
 *  free tier and 10 on paid; 5 with retry-on-429 stays inside both. */
const SEND_CONCURRENCY = 5;
/** Recipients per invocation. The remainder stays `queued` for `send_pending`. */
const DEFAULT_MAX_RECIPIENTS = 500;
/** Svix replay window. */
const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Ack/sign link lifetime (§5: "single-use, expiring"). */
const ACK_TOKEN_TTL_DAYS = 30;

/** Employment statuses that receive staff mail unless the caller says otherwise. */
const DEFAULT_STATUSES = [
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "on_long_leave",
  "rehired",
] as const;

const EMPLOYMENT_STATUSES = [
  "pre_joining",
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "suspended",
  "on_long_leave",
  "absconding",
  "exited",
  "retired",
  "rehired",
] as const;

const EMPLOYMENT_TYPES = [
  "permanent",
  "probation",
  "contract",
  "intern",
  "consultant",
  "casual",
  "apprentice",
  "retainer",
] as const;

/**
 * Audience for a scheduled send that names none. Migration 041 posts
 * `{"job_code":"payroll_reminder","template":"payroll_cutoff"}` with no audience;
 * an operational reminder like that belongs to whoever runs the back office, so
 * it resolves through `user_roles` rather than the employee directory (an admin
 * may have no employee row).
 */
const CRON_DEFAULT_AUDIENCE: AudienceInput = { roles: ["admin", "super_admin"] };

/** `ck_communications__kind`. */
const COMMUNICATION_KINDS = [
  "policy",
  "circular",
  "payslip",
  "offer",
  "onboarding",
  "survey",
  "reminder",
  "custom",
] as const;

// ═════════════════════════════════════════════════════════════════════════════
// Request contracts
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The audience builder (spec-admin §14: "AND/OR over entity/location/dept…").
 * Selectors are OR-ed — the union of everything named — then intersected with
 * `include_statuses`. `all` short-circuits the employee selectors.
 */
const Audience = z
  .object({
    all: z.boolean().optional(),
    employee_ids: z.array(common.uuid).min(1).max(5_000).optional(),
    department_ids: z.array(common.uuid).min(1).max(200).optional(),
    location_ids: z.array(common.uuid).min(1).max(200).optional(),
    employment_types: z.array(z.enum(EMPLOYMENT_TYPES)).min(1).optional(),
    /** Role-holders, resolved through `user_roles` — reaches an admin with no employee row. */
    roles: z.array(z.enum(APP_ROLES)).min(1).optional(),
    profile_ids: z.array(common.uuid).min(1).max(2_000).optional(),
    /** External addresses (candidate offer mail). Never merged with employee data. */
    emails: z.array(common.email).min(1).max(200).optional(),
    include_statuses: z.array(z.enum(EMPLOYMENT_STATUSES)).min(1).optional(),
  })
  .strict()
  .refine(
    (a) =>
      a.all === true ||
      a.employee_ids !== undefined ||
      a.department_ids !== undefined ||
      a.location_ids !== undefined ||
      a.employment_types !== undefined ||
      a.roles !== undefined ||
      a.profile_ids !== undefined ||
      a.emails !== undefined,
    { message: "Name at least one audience selector, or set all: true." },
  );

const Message = z
  .object({
    subject: z.string().trim().min(3).max(300).optional(),
    body_html: z.string().max(400_000).optional(),
    body_text: z.string().max(200_000).optional(),
    /** `notification_templates.code` — matched case-insensitively on the email channel row. */
    template_code: z.string().trim().min(2).max(80).optional(),
  })
  .strict();

const SendBody = z
  .object({
    mode: z.enum(["transactional", "broadcast", "policy", "send_pending"]).default("transactional"),
    /** Cron provenance. Enables the `app.job_begin` double-run guard. */
    job_code: z.string().trim().min(2).max(64).optional(),
    /** Cron alias for `message.template_code` (migration 041 posts `{job_code, template}`). */
    template: z.string().trim().min(2).max(80).optional(),
    communication_id: common.uuid.optional(),
    company_id: common.uuid.optional(),
    audience: Audience.optional(),
    message: Message.optional(),
    communication_kind: z.enum(COMMUNICATION_KINDS).default("custom"),
    document_id: common.uuid.optional(),
    requires_signing: z.boolean().default(false),
    /** Merge values shared by every recipient. Per-recipient values win. */
    personalisation: z
      .record(z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]))
      .optional(),
    from_name: z.string().trim().min(1).max(120).optional(),
    from_email: common.email.optional(),
    reply_to: common.email.optional(),
    cc_emails: z.array(common.email).max(10).optional(),
    /** Future instant → the send is staged (`status: scheduled`) and not delivered now. */
    scheduled_at: common.instant.optional(),
    dry_run: z.boolean().default(false),
    max_recipients: z.number().int().min(1).max(5_000).default(DEFAULT_MAX_RECIPIENTS),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.mode === "send_pending") {
      if (b.audience !== undefined || b.message !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mode"],
          message: "send_pending resumes an existing communication; drop audience and message.",
        });
      }
      return;
    }
    // The audience is NOT required here: a cron-triggered send may omit it and
    // fall back to the back-office default (see CRON_DEFAULT_AUDIENCE). The
    // handler, which knows whether the caller is a person, enforces it.
    const hasTemplate = b.message?.template_code !== undefined || b.template !== undefined;
    const hasInline = b.message?.subject !== undefined &&
      (b.message?.body_html !== undefined || b.message?.body_text !== undefined);
    if (!hasTemplate && !hasInline) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message"],
        message: "Give a template_code, or a subject with body_html/body_text.",
      });
    }
    if (b.mode === "policy" && b.document_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["document_id"],
        message: "A policy send must name the document being circulated.",
      });
    }
  });

/** Resend → Svix envelope. Only the fields we act on are typed. */
const WebhookEnvelope = z
  .object({
    type: z.string().min(3).max(80),
    created_at: z.string().max(64).optional(),
    data: z
      .object({
        email_id: z.string().min(1).max(200).optional(),
        to: z.union([z.string(), z.array(z.string())]).optional(),
        subject: z.string().max(500).optional(),
        bounce: z
          .object({ type: z.string().max(60).optional(), message: z.string().max(1_000).optional() })
          .passthrough()
          .optional(),
        click: z.object({ link: z.string().max(2_000).optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();

// ═════════════════════════════════════════════════════════════════════════════
// Small helpers
// ═════════════════════════════════════════════════════════════════════════════

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** URL-safe random string from `crypto.getRandomValues`. */
function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += B64URL[b % 64] as string;
  return out;
}

const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

function templateTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const name = match[1];
    if (name !== undefined) found.add(name.toLowerCase());
  }
  return [...found];
}

/** Replace `{{token}}`. A known token with a null value renders empty, never `{{token}}`. */
function render(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(TOKEN_RE, (_whole, name: string) => vars[name.toLowerCase()] ?? "");
}

/**
 * spec-admin §14: "unresolved token blocks send". Checked ONCE, before anything
 * is written, against the union of every key any recipient could supply — so a
 * typo is a 422 on an empty database instead of 200 emails reading
 * "Dear {{frist_name}}".
 */
function assertTokensKnown(parts: readonly { label: string; text: string }[], allowed: ReadonlySet<string>): void {
  const problems: { pointer: string; code: string; detail: string }[] = [];
  for (const part of parts) {
    for (const token of templateTokens(part.text)) {
      if (!allowed.has(token)) {
        problems.push({
          pointer: `/message/${part.label}`,
          code: "unknown_merge_token",
          detail: `No value is available for {{${token}}}.`,
        });
      }
    }
  }
  if (problems.length > 0) {
    throw unprocessable(
      problems.slice(0, 10),
      "The message has merge tokens nothing can fill.",
      "UNRESOLVED_MERGE_TOKENS",
    );
  }
}

/** Minimal HTML from a plain-text body: paragraphs, escaped. */
function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br />")}</p>`)
    .join("\n");
}

/** Plain text from HTML, for the multipart alternative. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// Resend transport
// ═════════════════════════════════════════════════════════════════════════════

interface SendOutcome {
  /** `sent` = accepted by Resend; `permanent` = it will never be accepted; `transient` = retry. */
  kind: "sent" | "permanent" | "transient";
  providerMessageId: string | null;
  detail: string | null;
}

interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo: string | null;
  cc: string[] | null;
  /** Correlates the provider's webhook back to `communication_recipients.id`. */
  entityRef: string;
  tags: { name: string; value: string }[];
}

function resendApiKey(): string {
  const key = Deno.env.get("RESEND_API_KEY") ?? "";
  if (key === "") {
    // 503, not 500: nothing is broken, email is simply not provisioned here.
    throw unavailable(
      "Email sending is not configured on this environment.",
      "EMAIL_TRANSPORT_UNCONFIGURED",
    );
  }
  return key;
}

/** Resend tag values are restricted to ASCII letters, digits, `_` and `-`. */
function safeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

/**
 * Email sandbox (settings key `comms.sandbox_redirect_to`) — see the identical
 * helper in notification-dispatch. Until a sending DOMAIN is verified, an
 * unverified provider account may only deliver to its own address; without this
 * every staff recipient 403s and the delivery log reads as a broken sender.
 * When set, mail goes to that one address with the intended recipient preserved
 * in a header and the subject, tagged `sandbox`. Absent, behaviour is unchanged.
 */
function sandboxRedirect(
  to: string,
  redirectTo: string | null,
): { to: string; subjectPrefix: string; sandboxed: boolean } {
  const target = (redirectTo ?? "").trim();
  if (target === "" || target.toLowerCase() === to.toLowerCase()) {
    return { to, subjectPrefix: "", sandboxed: false };
  }
  return { to: target, subjectPrefix: `[sandbox → ${to}] `, sandboxed: true };
}

async function sendViaResend(
  apiKey: string,
  email: OutgoingEmail,
  sandboxTo: string | null = null,
): Promise<SendOutcome> {
  const routed = sandboxRedirect(email.to, sandboxTo);
  const payload: Record<string, unknown> = {
    from: email.from,
    to: [routed.to],
    subject: routed.subjectPrefix + email.subject,
    html: email.html,
    text: email.text,
    headers: {
      "X-Entity-Ref-ID": email.entityRef,
      // The real addressee survives the redirect, so the log stays truthful.
      ...(routed.sandboxed ? { "X-Intended-Recipient": email.to } : {}),
    },
    tags: [
      ...email.tags.map((t) => ({ name: t.name, value: safeTagValue(t.value) })),
      ...(routed.sandboxed ? [{ name: "sandbox", value: "true" }] : []),
    ],
  };
  if (email.replyTo !== null) payload.reply_to = email.replyTo;
  if (email.cc !== null && email.cc.length > 0) payload.cc = email.cc;

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          // Resend de-duplicates on this for 24h, so our retries cannot double-send.
          "idempotency-key": email.entityRef,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (attempt === 2) {
        return { kind: "transient", providerMessageId: null, detail: `network: ${String(err)}` };
      }
      continue;
    }

    if (response.ok) {
      const body = await response.json().catch(() => null) as { id?: string } | null;
      return { kind: "sent", providerMessageId: body?.id ?? null, detail: null };
    }

    const text = (await response.text().catch(() => "")).slice(0, 500);
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 2) {
        return { kind: "transient", providerMessageId: null, detail: `${response.status}: ${text}` };
      }
      // Linear backoff; a queue drain is not latency-sensitive.
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    // 400/422 = the address or payload will never be accepted. Do not retry.
    return { kind: "permanent", providerMessageId: null, detail: `${response.status}: ${text}` };
  }
  return { kind: "transient", providerMessageId: null, detail: "exhausted retries" };
}

// ═════════════════════════════════════════════════════════════════════════════
// Configuration reads
// ═════════════════════════════════════════════════════════════════════════════

async function settingsMap(client: Sql, keys: readonly string[]): Promise<Map<string, string | null>> {
  const rows = await client<{ key: string; value: string | null }[]>`
    SELECT s.key, s.value #>> '{}' AS value
      FROM public.settings s
     WHERE s.key = ANY(${[...keys]}::text[])
     ORDER BY (s.scope = 'global') DESC
  `;
  const out = new Map<string, string | null>();
  for (const row of rows) if (!out.has(row.key)) out.set(row.key, row.value);
  return out;
}

/** App base URL for deep links. §0 fixes the host; a setting may override it. */
function appBaseUrl(settings: Map<string, string | null>): string {
  const configured = settings.get("app_base_url") ?? settings.get("comms.app_base_url");
  const env = Deno.env.get("APP_BASE_URL");
  const chosen = (configured ?? env ?? "https://hr.thetamarindtree.in").trim();
  return chosen.replace(/\/+$/, "");
}

interface FromAddress {
  name: string;
  email: string;
}

function resolveFrom(
  body: { from_name?: string | undefined; from_email?: string | undefined },
  settings: Map<string, string | null>,
  companyName: string,
): FromAddress {
  const email = body.from_email ??
    settings.get("comms.from_email") ??
    Deno.env.get("RESEND_FROM_EMAIL") ??
    null;
  if (email === null || email.trim() === "") {
    // Guessing a sending domain would produce silent DKIM failures, so this is
    // an explicit 503 with the exact key to set. See the DB-gap note in the
    // handover: `settings` has no `comms.from_email` row yet.
    throw unavailable(
      "No sending address is configured. Set the `comms.from_email` setting or the RESEND_FROM_EMAIL secret.",
      "EMAIL_FROM_UNCONFIGURED",
    );
  }
  const name = body.from_name ?? settings.get("comms.from_name") ?? `${companyName} HR`;
  return { name: name.trim().slice(0, 120), email: email.trim() };
}

function formatFrom(from: FromAddress): string {
  // Quote the display name: "The Tamarind Tree HR" <hr@…> — an unquoted comma
  // would split the header into two addresses.
  return `"${from.name.replace(/"/g, "")}" <${from.email}>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Audience resolution
// ═════════════════════════════════════════════════════════════════════════════

interface ResolvedRecipient {
  employeeId: string | null;
  profileId: string | null;
  email: string | null;
  mobile: string | null;
  displayName: string;
  vars: Record<string, string>;
}

interface AudienceRow {
  employee_id: string | null;
  profile_id: string | null;
  employee_code: string | null;
  display_name: string | null;
  first_name: string | null;
  email: string | null;
  mobile: string | null;
  department_name: string | null;
  location_name: string | null;
  designation_name: string | null;
}

function toRecipient(row: AudienceRow, companyName: string, extra: Readonly<Record<string, string>>): ResolvedRecipient {
  const displayName = row.display_name ?? row.first_name ?? row.email ?? "colleague";
  return {
    employeeId: row.employee_id,
    profileId: row.profile_id,
    email: row.email === null ? null : row.email.trim().toLowerCase(),
    mobile: row.mobile,
    displayName,
    vars: {
      employee_code: row.employee_code ?? "",
      first_name: row.first_name ?? displayName.split(" ")[0] ?? "",
      display_name: displayName,
      full_name: displayName,
      email: row.email ?? "",
      department_name: row.department_name ?? "",
      location_name: row.location_name ?? "",
      designation_name: row.designation_name ?? "",
      company_name: companyName,
      ...extra,
    },
  };
}

type AudienceInput = z.infer<typeof Audience>;

async function resolveAudience(
  client: Sql,
  input: {
    audience: AudienceInput;
    companyId: string;
    companyName: string;
    limit: number;
    extraVars: Readonly<Record<string, string>>;
  },
): Promise<{ recipients: ResolvedRecipient[]; truncated: boolean }> {
  const a = input.audience;
  const statuses = a.include_statuses ?? [...DEFAULT_STATUSES];
  const byKey = new Map<string, ResolvedRecipient>();
  // One over the cap tells us the audience was larger than we will send to.
  const fetchLimit = input.limit + 1;

  const wantsEmployeeScan = a.all === true ||
    a.employee_ids !== undefined ||
    a.department_ids !== undefined ||
    a.location_ids !== undefined ||
    a.employment_types !== undefined;

  if (wantsEmployeeScan) {
    const rows = await client<AudienceRow[]>`
      SELECT e.id                                                       AS employee_id,
             e.profile_id,
             e.employee_code,
             e.display_name,
             e.first_name,
             lower(COALESCE(e.work_email, p.email, e.personal_email))   AS email,
             e.mobile,
             d.name                                                     AS department_name,
             l.name                                                     AS location_name,
             dg.name                                                    AS designation_name
        FROM public.employees e
        LEFT JOIN public.profiles    p  ON p.id  = e.profile_id AND p.is_active
        LEFT JOIN public.departments d  ON d.id  = e.department_id
        LEFT JOIN public.locations   l  ON l.id  = e.location_id
        LEFT JOIN public.designations dg ON dg.id = e.designation_id
       WHERE e.deleted_at IS NULL
         AND e.company_id = ${input.companyId}::uuid
         AND e.employment_status::text = ANY(${statuses}::text[])
         AND (
              ${a.all === true}::boolean
           OR e.id              = ANY(COALESCE(${a.employee_ids ?? null}::uuid[], '{}'::uuid[]))
           OR e.department_id    = ANY(COALESCE(${a.department_ids ?? null}::uuid[], '{}'::uuid[]))
           OR e.location_id      = ANY(COALESCE(${a.location_ids ?? null}::uuid[], '{}'::uuid[]))
           OR e.employment_type::text = ANY(COALESCE(${a.employment_types ?? null}::text[], '{}'::text[]))
         )
       ORDER BY e.display_name
       LIMIT ${fetchLimit}
    `;
    for (const row of rows) {
      const recipient = toRecipient(row, input.companyName, input.extraVars);
      byKey.set(`e:${row.employee_id}`, recipient);
    }
  }

  if (a.roles !== undefined || a.profile_ids !== undefined) {
    // Profile-first, so a role-holder with no employee record (a back-office
    // admin) still receives operational mail such as the payroll cutoff notice.
    const rows = await client<AudienceRow[]>`
      SELECT e.id                                                     AS employee_id,
             p.id                                                     AS profile_id,
             e.employee_code,
             COALESCE(e.display_name, p.full_name)                    AS display_name,
             COALESCE(e.first_name, split_part(p.full_name, ' ', 1))   AS first_name,
             lower(COALESCE(e.work_email, p.email, e.personal_email)) AS email,
             e.mobile,
             d.name                                                   AS department_name,
             l.name                                                   AS location_name,
             dg.name                                                  AS designation_name
        FROM public.profiles p
        LEFT JOIN public.employees   e  ON e.profile_id = p.id AND e.deleted_at IS NULL
        LEFT JOIN public.departments d  ON d.id  = e.department_id
        LEFT JOIN public.locations   l  ON l.id  = e.location_id
        LEFT JOIN public.designations dg ON dg.id = e.designation_id
       WHERE p.is_active
         AND (
              p.id = ANY(COALESCE(${a.profile_ids ?? null}::uuid[], '{}'::uuid[]))
           OR EXISTS (
                SELECT 1
                  FROM public.user_roles ur
                 WHERE ur.user_id = p.id
                   AND ur.revoked_at IS NULL
                   AND ur.role::text = ANY(COALESCE(${a.roles ?? null}::text[], '{}'::text[]))
              )
         )
       ORDER BY 4
       LIMIT ${fetchLimit}
    `;
    for (const row of rows) {
      const recipient = toRecipient(row, input.companyName, input.extraVars);
      byKey.set(row.employee_id !== null ? `e:${row.employee_id}` : `p:${row.profile_id}`, recipient);
    }
  }

  for (const email of a.emails ?? []) {
    const lower = email.trim().toLowerCase();
    if (byKey.has(`x:${lower}`)) continue;
    byKey.set(`x:${lower}`, {
      employeeId: null,
      profileId: null,
      email: lower,
      mobile: null,
      displayName: lower,
      vars: {
        employee_code: "",
        first_name: "",
        display_name: lower,
        full_name: lower,
        email: lower,
        department_name: "",
        location_name: "",
        designation_name: "",
        company_name: input.companyName,
        ...input.extraVars,
      },
    });
  }

  const all = [...byKey.values()];
  return { recipients: all.slice(0, input.limit), truncated: all.length > input.limit };
}

// ═════════════════════════════════════════════════════════════════════════════
// Company + template resolution
// ═════════════════════════════════════════════════════════════════════════════

async function resolveCompany(
  client: Sql,
  explicit: string | null,
): Promise<{ id: string; name: string }> {
  if (explicit !== null) {
    const rows = await client<{ id: string; name: string }[]>`
      SELECT c.id, c.name FROM public.companies c
       WHERE c.id = ${explicit}::uuid AND c.deleted_at IS NULL LIMIT 1
    `;
    const row = firstRow(rows);
    if (row === null) throw notFound("No such company.", "COMPANY_NOT_FOUND");
    return row;
  }
  const rows = await client<{ id: string; name: string }[]>`
    SELECT c.id, c.name FROM public.companies c
     WHERE c.deleted_at IS NULL ORDER BY c.created_at LIMIT 2
  `;
  if (rows.length === 0) throw notFound("No company is configured.", "COMPANY_NOT_FOUND");
  if (rows.length > 1) {
    throw unprocessable(
      [{ pointer: "/company_id", code: "required", detail: "More than one company exists; name the one to send from." }],
      "company_id is required on this deployment.",
      "COMPANY_ID_REQUIRED",
    );
  }
  return rows[0] as { id: string; name: string };
}

interface TemplateRow {
  id: string;
  code: string;
  subject_template: string | null;
  body_template: string;
  is_transactional: boolean;
}

async function resolveTemplate(client: Sql, companyId: string, code: string): Promise<TemplateRow> {
  const rows = await client<TemplateRow[]>`
    SELECT t.id, t.code, t.subject_template, t.body_template, t.is_transactional
      FROM public.notification_templates t
     WHERE t.company_id = ${companyId}::uuid
       AND upper(t.code) = upper(${code})
       AND t.channel = 'email'
       AND t.is_active
       AND t.deleted_at IS NULL
     LIMIT 1
  `;
  const row = firstRow(rows);
  if (row === null) {
    throw notFound(
      `No active email template with code ${code}.`,
      "TEMPLATE_NOT_FOUND",
    );
  }
  return row;
}

// ═════════════════════════════════════════════════════════════════════════════
// Persistence
// ═════════════════════════════════════════════════════════════════════════════

interface PersistedRecipient {
  id: string;
  employeeId: string | null;
  email: string | null;
  slug: string;
  /** Raw ack token, present only for the request that created it. */
  ackToken: string | null;
  subject: string;
  html: string;
  text: string;
}

interface CreatedCommunication {
  id: string;
  number: string;
  subject: string;
  status: string;
  recipients: PersistedRecipient[];
  suppressed: number;
  truncated: boolean;
}

/** `COM-<IST year>-<6 digits>`. Serialised by an advisory lock — migration 027
 *  defines no sequence for `communication_number` (see the DB-gap note). */
async function nextCommunicationNumber(tx: Sql): Promise<string> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('communications.communication_number'))`;
  const rows = await tx<{ number: string }[]>`
    SELECT 'COM-' || to_char(util.ist_today(), 'YYYY') || '-' ||
           lpad((COALESCE(max((regexp_match(c.communication_number, '^COM-\\d{4}-(\\d+)$'))[1]::integer), 0) + 1)::text,
                6, '0') AS number
      FROM public.communications c
     WHERE c.communication_number LIKE 'COM-' || to_char(util.ist_today(), 'YYYY') || '-%'
  `;
  const row = firstRow(rows);
  if (row === null) throw new Error("communication number could not be derived");
  return row.number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Webhook route (Resend → Svix HMAC)
// ═════════════════════════════════════════════════════════════════════════════

// The return type is inferred on purpose: an explicit `Uint8Array` annotation
// widens to `Uint8Array<ArrayBufferLike>` on TypeScript ≥5.7, which is no longer
// assignable to the `BufferSource` that `crypto.subtle.importKey` wants.
function base64ToBytes(value: string) {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalised.padEnd(normalised.length + ((4 - (normalised.length % 4)) % 4), "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Svix (the signer Resend uses): `HMAC-SHA256(base64decode(secret without the
 * `whsec_` prefix), "<id>.<timestamp>.<body>")`, base64. The header may carry
 * several space-separated `v1,<sig>` values during secret rotation, so every one
 * is compared — in constant time — before the request is refused.
 *
 * `_shared/auth.ts#hmacSha256Hex` cannot be reused here: Svix keys the MAC with
 * raw bytes and encodes the digest as base64, not hex.
 */
async function verifyWebhookSignature(
  req: Request,
  rawBody: string,
  secret: string,
): Promise<{ eventId: string }> {
  const id = (req.headers.get("svix-id") ?? req.headers.get("webhook-id") ?? "").trim();
  const timestamp = (req.headers.get("svix-timestamp") ?? req.headers.get("webhook-timestamp") ?? "").trim();
  const signatures = (req.headers.get("svix-signature") ?? req.headers.get("webhook-signature") ?? "").trim();

  if (id === "" || timestamp === "" || signatures === "") {
    throw unauthorized("This webhook is not signed.", "WEBHOOK_SIGNATURE_MISSING");
  }
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    throw unauthorized("Malformed webhook timestamp.", "WEBHOOK_SIGNATURE_INVALID");
  }
  if (Math.abs(epochSeconds() - sentAt) > WEBHOOK_TOLERANCE_SECONDS) {
    throw unauthorized("This webhook is too old to accept.", "WEBHOOK_SIGNATURE_STALE");
  }

  const keyBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
  );
  const expected = bytesToBase64(new Uint8Array(digest));

  let matched = false;
  for (const candidate of signatures.split(" ")) {
    const parts = candidate.split(",");
    if (parts.length !== 2 || parts[0] !== "v1") continue;
    // Not short-circuited: every candidate is compared so the timing does not
    // leak which one was close.
    if (constantTimeEqual(expected, parts[1] as string)) matched = true;
  }
  if (!matched) throw unauthorized("Webhook signature does not verify.", "WEBHOOK_SIGNATURE_INVALID");
  return { eventId: id };
}

async function webhookSecret(client: Sql): Promise<string> {
  const rows = await client<{ name: string | null; vault: string | null }[]>`
    SELECT i.webhook_secret_name AS name,
           app.secret(COALESCE(i.webhook_secret_name, 'RESEND_WEBHOOK_SECRET')) AS vault
      FROM public.integrations i
     WHERE i.code = 'resend' AND i.deleted_at IS NULL
     LIMIT 1
  `;
  const row = firstRow(rows);
  const envName = row?.name ?? "RESEND_WEBHOOK_SECRET";
  const secret = (row?.vault ?? Deno.env.get(envName) ?? "").trim();
  if (secret === "") {
    // Never accept an unverifiable event: a forged "delivered" would corrupt
    // the delivery log the compliance matrix is built on.
    throw unavailable(
      "The Resend webhook signing secret is not provisioned.",
      "WEBHOOK_SECRET_UNCONFIGURED",
    );
  }
  return secret;
}

/** Resend event type → (`communication_events.event`, recipient status). */
const WEBHOOK_EVENT_MAP: Record<string, { event: string; status: string | null }> = {
  "email.sent": { event: "sent", status: "sent" },
  "email.delivered": { event: "delivered", status: "delivered" },
  "email.delivery_delayed": { event: "deferred", status: null },
  "email.opened": { event: "opened", status: "opened" },
  "email.clicked": { event: "clicked", status: "clicked" },
  "email.bounced": { event: "bounced", status: "bounced" },
  "email.complained": { event: "complained", status: null },
  "email.unsubscribed": { event: "unsubscribed", status: "suppressed" },
  "email.failed": { event: "bounced", status: "failed" },
};

/** Rank so a late `sent` webhook cannot demote a recipient already `clicked`. */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sending: 1,
  suppressed: 1,
  sent: 2,
  delivered: 3,
  opened: 4,
  clicked: 5,
  bounced: 6,
  failed: 6,
  cancelled: 6,
};

async function handleWebhook(req: Request, requestId: string, log: Logger): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed(["POST"]).toResponse();

  let idempotencyKey: string | null = null;
  let status = 500;
  try {
    // The provider is not a browser. No CORS headers are emitted, and a browser
    // call is refused outright so a page cannot forge delivery events.
    rejectBrowserOrigin(req);

    const rawBody = await readRawBody(req, { maxBytes: 128 * 1024 });
    const secret = await webhookSecret(sql());
    const { eventId } = await verifyWebhookSignature(req, rawBody, secret);

    // Per-source bucket: a signed but runaway provider still cannot flood us.
    await enforce(RATE_LIMITS.mutation, limitKey(FN_NAME, "webhook"), "WEBHOOK_RATE_LIMITED");

    const envelope = parse(WebhookEnvelope, decodeJson(rawBody), "webhook payload");
    const mapped = WEBHOOK_EVENT_MAP[envelope.type];
    const providerMessageId = envelope.data.email_id ?? null;

    idempotencyKey = `${FN_NAME}:webhook:${eventId}`;
    const hash = await requestHash(`${FN_NAME}/webhook`, rawBody, "resend");
    const claimed = await claim({ key: idempotencyKey, fnName: `${FN_NAME}/webhook`, requestHash: hash });
    if (claimed.state === "replay") {
      status = claimed.status;
      return replayResponse(claimed, { "x-request-id": requestId });
    }

    if (mapped === undefined || providerMessageId === null) {
      // 200: an unmodelled event type is not an error, and a 4xx would make
      // Resend retry it for days.
      status = 200;
      const body = { ignored: mapped === undefined ? "unhandled_event_type" : "no_email_id", type: envelope.type };
      await store(idempotencyKey, status, body);
      return ok(body, { status, requestId });
    }

    const ctx: RequestContext = {
      actorId: null,
      actorRole: null,
      source: "edge_function",
      sourceRoute: `${FN_NAME}/webhook`,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: null,
    };

    const result = await withContext(ctx, async (tx) => {
      const found = await tx<{ id: string; communication_id: string; status: string }[]>`
        SELECT r.id, r.communication_id, r.status::text AS status
          FROM public.communication_recipients r
         WHERE r.provider_message_id = ${providerMessageId}
         LIMIT 1
      `;
      const recipient = firstRow(found);
      if (recipient === null) return { matched: false as const };

      // `communication_events` has no unique index on provider_event_id
      // (DB-gap note), so the dedupe is an explicit NOT EXISTS. Svix retries
      // reuse the same svix-id, which is what we store.
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO public.communication_events
          (communication_id, recipient_id, event, provider, provider_event_id, payload, occurred_at)
        SELECT ${recipient.communication_id}::uuid,
               ${recipient.id}::uuid,
               ${mapped.event}::text,
               'resend',
               ${eventId}::text,
               ${rawBody}::jsonb,
               now()
         WHERE NOT EXISTS (
           SELECT 1 FROM public.communication_events e
            WHERE e.provider_event_id = ${eventId}::text
              AND e.recipient_id = ${recipient.id}::uuid
              AND e.event = ${mapped.event}::text
         )
        RETURNING id
      `;
      if (inserted.length === 0) return { matched: true as const, duplicate: true as const };

      const bounceKind = envelope.data.bounce?.type ?? null;
      const failureDetail = envelope.data.bounce?.message ?? null;
      const nextStatus = mapped.status;
      const rank = nextStatus === null ? -1 : (STATUS_RANK[nextStatus] ?? 0);

      await tx`
        UPDATE public.communication_recipients r
           SET status          = CASE
                                   WHEN ${nextStatus}::text IS NULL THEN r.status
                                   WHEN COALESCE((${JSON.stringify(STATUS_RANK)}::jsonb ->> r.status::text)::integer, 0)
                                        > ${rank}::integer THEN r.status
                                   ELSE ${nextStatus}::public.notification_status
                                 END,
               delivered_at    = CASE WHEN ${mapped.event} = 'delivered' THEN COALESCE(r.delivered_at, now())
                                      ELSE r.delivered_at END,
               first_opened_at = CASE WHEN ${mapped.event} = 'opened' THEN COALESCE(r.first_opened_at, now())
                                      ELSE r.first_opened_at END,
               last_opened_at  = CASE WHEN ${mapped.event} = 'opened' THEN now() ELSE r.last_opened_at END,
               open_count      = r.open_count + CASE WHEN ${mapped.event} = 'opened' THEN 1 ELSE 0 END,
               clicked_at      = CASE WHEN ${mapped.event} = 'clicked' THEN COALESCE(r.clicked_at, now())
                                      ELSE r.clicked_at END,
               bounce_kind     = COALESCE(${bounceKind}::text, r.bounce_kind),
               failure_detail  = COALESCE(${failureDetail}::text, r.failure_detail)
         WHERE r.id = ${recipient.id}::uuid
      `;

      // Counters are recomputed, never incremented: a replayed or out-of-order
      // webhook then cannot drift them away from the recipient rows.
      //
      // The trailing inequality matters. `public.communications` IS
      // trigger-audited and its counter columns are not in
      // `audit.excluded_columns`, so a no-op write would still put a
      // hash-chained row on the audit log for every open of every mail. Writing
      // only on a real change keeps that to the changes themselves (see the
      // exclusion gap noted in the handover).
      await tx`
        UPDATE public.communications c
           SET delivered_count = agg.delivered,
               opened_count    = agg.opened,
               failed_count    = agg.failed
          FROM (
            SELECT count(*) FILTER (WHERE r.status IN ('delivered','opened','clicked')) AS delivered,
                   count(*) FILTER (WHERE r.first_opened_at IS NOT NULL)                AS opened,
                   count(*) FILTER (WHERE r.status IN ('failed','bounced'))             AS failed
              FROM public.communication_recipients r
             WHERE r.communication_id = ${recipient.communication_id}::uuid
          ) agg
         WHERE c.id = ${recipient.communication_id}::uuid
           AND (c.delivered_count, c.opened_count, c.failed_count)
               IS DISTINCT FROM (agg.delivered::integer, agg.opened::integer, agg.failed::integer)
      `;
      return { matched: true as const, duplicate: false as const, recipientId: recipient.id };
    });

    status = 200;
    const body = result.matched
      ? { accepted: true, duplicate: result.duplicate === true, type: envelope.type }
      : { ignored: "unknown_provider_message_id", type: envelope.type };
    await store(idempotencyKey, status, body);
    log.info("webhook processed", { type: envelope.type, matched: result.matched });
    return ok(body, { status, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance: `/${FN_NAME}/webhook` });
    status = problem.status;
    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, problem.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }
    if (problem.isServerFault) log.error("webhook failed", { err, code: problem.code });
    else log.warn("webhook refused", { code: problem.code, status });
    return problem.toResponse();
  } finally {
    log.finish(status, { route: "webhook" });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Handler
// ═════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const requestId = requestIdFrom(req);
  const isWebhook = url.pathname.split("/").filter((s) => s !== "").pop() === "webhook";

  if (isWebhook) {
    return await handleWebhook(req, requestId, createLogger({ fn: `${FN_NAME}/webhook`, requestId }));
  }

  // ── STEP 1 · OPTIONS / CORS ───────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ─────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ────────────────────────────────────────────
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = url.pathname;

  let status = 500;
  let idempotencyKey: string | null = null;
  let jobRunId: string | null = null;
  let responseBody: unknown = null;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (U by default, C when the cron secret is presented) ────
    const rawBody = await readRawBody(req, { maxBytes: 1024 * 1024 });
    const decoded = decodeJson(rawBody);
    const viaCron = req.headers.get("x-cron-secret") !== null;

    let auth: AuthContext | null = null;
    let actorId: string | null = null;
    let actorRole: RequestContext["actorRole"] = null;
    if (viaCron) {
      verifyCron(req);
      log.info("cron authenticated", { via: "cron_secret" });
    } else {
      auth = await verifyUser(req);
      actorId = auth.userId;
      actorRole = auth.role;
      log.info("user authenticated", { actor_id: auth.userId, role: auth.role });
    }

    // ── STEP 5 · Authority (capability + step-up, both from the DB) ──────────
    if (auth !== null) {
      await requireCapWithStepUp(sql(), auth, CAP);
    }

    // Peek at the mode before validation so the rate-limit bucket matches the
    // cost of the call. The value is re-parsed properly at step 7.
    const peeked = typeof decoded === "object" && decoded !== null
      ? (decoded as Record<string, unknown>)
      : {};
    const peekedMode = typeof peeked.mode === "string" ? peeked.mode : "transactional";
    const heavy = peekedMode !== "transactional";

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    await enforce(
      heavy ? RATE_LIMITS.heavyJob : RATE_LIMITS.mutation,
      limitKey(FN_NAME, actorId ?? "cron", peekedMode),
      "COMMS_RATE_LIMITED",
    );

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const body = parse(SendBody, decoded, "send request");
    const templateCode = body.message?.template_code ?? body.template ?? null;
    const reason = (req.headers.get("x-reason") ?? "").trim();

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // A dry run writes nothing, so it needs no key. Everything else does: for a
    // user the client supplies it; for cron it is derived from the job code and
    // the IST day, so a pg_net retry replays instead of mailing twice.
    if (!body.dry_run) {
      idempotencyKey = viaCron
        ? (idempotencyKeyFrom(req) ??
          `${FN_NAME}:${body.job_code ?? "cron"}:${templateCode ?? body.mode}:${istToday()}`)
        : requireIdempotencyKey(req);
      const hash = await requestHash(FN_NAME, rawBody, actorId ?? body.job_code ?? "cron");
      const claimed = await claim({
        key: idempotencyKey,
        fnName: FN_NAME,
        requestHash: hash,
        actorId,
      });
      if (claimed.state === "replay") {
        status = claimed.status;
        log.info("idempotent replay", { key: idempotencyKey });
        return replayResponse(claimed, { ...cors, "x-request-id": requestId });
      }
    }

    // Cron double-run guard (§9). `overlap_policy = 'skip'` in `cron_jobs`.
    const pool = sql();
    if (viaCron && body.job_code !== undefined) {
      const begun = await pool<{ id: string | null }[]>`
        SELECT app.job_begin(${body.job_code}, ${`${FN_NAME}:${body.job_code}`}) AS id
      `;
      jobRunId = firstRow(begun)?.id ?? null;
      if (jobRunId === null) {
        status = 200;
        responseBody = { skipped: "already_running", job_code: body.job_code, requestId };
        if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
        return ok(responseBody, { status, headers: cors, requestId });
      }
    }

    const ctx: RequestContext = {
      actorId,
      actorRole,
      source: viaCron ? "cron" : "web_admin",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: null,
      reason: reason === "" ? null : reason,
    };

    const apiKeyNeeded = !body.dry_run;
    const apiKey = apiKeyNeeded ? resendApiKey() : "";

    const settings = await settingsMap(pool, [
      "comms.from_email",
      "comms.from_name",
      "comms.sandbox_redirect_to",
      "app_base_url",
      "comms.app_base_url",
    ]);
    const baseUrl = appBaseUrl(settings);

    // ── mode: send_pending — resume, no new communication ────────────────────
    if (body.mode === "send_pending") {
      const pending = await loadPending(pool, body.communication_id ?? null, body.max_recipients, baseUrl);
      if (pending === null) {
        status = 200;
        responseBody = { sent: 0, failed: 0, deferred: 0, drained: 0, note: "nothing pending", requestId };
      } else if (body.dry_run) {
        // A dry run must not touch the transport; report what WOULD go out.
        status = 200;
        responseBody = {
          dry_run: true,
          communication_id: pending.communicationId,
          communication_number: pending.number,
          pending_recipients: pending.emails.length,
          preview: pending.recipients.slice(0, 10).map((r) => ({ email: r.email, subject: r.subject })),
          requestId,
        };
      } else {
        const outcomes = await deliver(apiKey, pending.emails);
        const summary = await recordOutcomes(ctx, pending.communicationId, pending.recipients, outcomes, {
          mode: body.mode,
          subject: pending.subject,
          number: pending.number,
        });
        status = 200;
        responseBody = {
          communication_id: pending.communicationId,
          communication_number: pending.number,
          mode: body.mode,
          ...summary,
          requestId,
        };
      }
      if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
      if (jobRunId !== null) await endJob(ctx, jobRunId, body.job_code ?? "communication_send", "succeeded", responseBody);
      return ok(responseBody, { status, headers: cors, requestId });
    }

    // ── Compose ─────────────────────────────────────────────────────────────
    const company = await resolveCompany(pool, body.company_id ?? auth?.companyId ?? null);
    const template = templateCode === null ? null : await resolveTemplate(pool, company.id, templateCode);

    const subjectTemplate = body.message?.subject ?? template?.subject_template ?? null;
    if (subjectTemplate === null) {
      throw unprocessable(
        [{ pointer: "/message/subject", code: "required", detail: "This template has no subject; supply one." }],
        "The message has no subject.",
        "SUBJECT_REQUIRED",
      );
    }
    const htmlTemplate = body.message?.body_html ??
      (body.message?.body_text !== undefined
        ? textToHtml(body.message.body_text)
        : template !== null
        ? textToHtml(template.body_template)
        : null);
    if (htmlTemplate === null) {
      throw unprocessable(
        [{ pointer: "/message/body_html", code: "required", detail: "Supply body_html or body_text." }],
        "The message has no body.",
        "BODY_REQUIRED",
      );
    }
    const textTemplate = body.message?.body_text ?? template?.body_template ?? htmlToText(htmlTemplate);

    // Merge tokens available to every recipient. Checked before anything is
    // written; an unknown token is a 422, never an email reading "{{name}}".
    const sharedVars: Record<string, string> = {
      company_name: company.name,
      app_url: baseUrl,
      today: istToday(),
      subject: "",
      ack_url: "",
      document_url: "",
    };
    for (const [key, value] of Object.entries(body.personalisation ?? {})) {
      sharedVars[key.toLowerCase()] = value === null ? "" : String(value);
    }
    const allowedTokens = new Set<string>([
      ...Object.keys(sharedVars),
      "employee_code",
      "first_name",
      "display_name",
      "full_name",
      "email",
      "department_name",
      "location_name",
      "designation_name",
    ]);
    assertTokensKnown(
      [
        { label: "subject", text: subjectTemplate },
        { label: "body_html", text: htmlTemplate },
        { label: "body_text", text: textTemplate },
      ],
      allowedTokens,
    );

    // A person must always say who they are mailing. A scheduled job may omit
    // the audience — migration 041's `payroll_reminder` posts only
    // `{job_code, template}` — and then it goes to the back office, which is
    // exactly who a payroll-cutoff reminder is for.
    if (body.audience === undefined && !viaCron) {
      throw unprocessable(
        [{ pointer: "/audience", code: "required", detail: "Name at least one audience selector." }],
        "No audience was given.",
        "AUDIENCE_REQUIRED",
      );
    }
    const audience: AudienceInput = body.audience ?? CRON_DEFAULT_AUDIENCE;
    const resolved = await resolveAudience(pool, {
      audience,
      companyId: company.id,
      companyName: company.name,
      limit: body.max_recipients,
      extraVars: sharedVars,
    });

    if (resolved.recipients.length === 0) {
      throw unprocessable(
        [{ pointer: "/audience", code: "empty", detail: "This audience matches nobody." }],
        "No recipient matched the audience.",
        "AUDIENCE_EMPTY",
      );
    }

    // ── dry run: the audience preview the console shows before sending ───────
    if (body.dry_run) {
      status = 200;
      responseBody = {
        dry_run: true,
        mode: body.mode,
        subject: render(subjectTemplate, { ...sharedVars, ...(resolved.recipients[0]?.vars ?? {}) }),
        recipients: {
          total: resolved.recipients.length,
          without_email: resolved.recipients.filter((r) => r.email === null).length,
          truncated: resolved.truncated,
        },
        // Ten names, per spec-admin §14's "live count + 10 names".
        preview: resolved.recipients.slice(0, 10).map((r) => ({ name: r.displayName, email: r.email })),
        requestId,
      };
      return ok(responseBody, { status, headers: cors, requestId });
    }

    const from = resolveFrom(body, settings, company.name);
    const scheduledAt = body.scheduled_at ?? null;
    // Instant comparison, not string comparison: `common.instant` permits an
    // offset (`…+05:30`), which sorts wrongly against a `Z` string.
    const isScheduled = scheduledAt !== null && secondsBetween(nowIso(), scheduledAt) > 0;
    const needsToken = body.requires_signing || body.mode === "policy";

    // ── STEPS 9 + 10 · txn 1: create the send, audit rows included ───────────
    const created = await withContext(ctx, async (tx) => {
      const number = await nextCommunicationNumber(tx);

      const commRows = await tx<{ id: string }[]>`
        INSERT INTO public.communications
          (communication_number, company_id, subject, body_html, body_text, template_id,
           communication_kind, channels, requires_signing, document_id, send_mode,
           scheduled_at, status, recipient_count, from_name, from_email, reply_to, cc_emails)
        VALUES (
          ${number},
          ${company.id}::uuid,
          ${subjectTemplate},
          ${htmlTemplate},
          ${textTemplate},
          ${template?.id ?? null}::uuid,
          ${body.communication_kind}::text,
          ARRAY['email']::public.notification_channel[],
          ${body.requires_signing}::boolean,
          ${body.document_id ?? null}::uuid,
          ${isScheduled ? "scheduled" : "immediate"}::text,
          ${scheduledAt}::timestamptz,
          ${isScheduled ? "scheduled" : "sending"}::text,
          ${resolved.recipients.length}::integer,
          ${from.name},
          ${from.email},
          ${body.reply_to ?? null}::text,
          ${body.cc_emails ?? null}::text[]
        )
        RETURNING id
      `;
      const commRow = firstRow(commRows);
      if (commRow === null) throw new Error("communications insert returned no row");
      const commId = commRow.id;

      const slugs = resolved.recipients.map(() => randomToken(18));
      const tokens = resolved.recipients.map(() => (needsToken ? randomToken(32) : null));

      const insertedRows = await tx<{ id: string; slug: string; employee_id: string | null; email: string | null }[]>`
        INSERT INTO public.communication_recipients
          (communication_id, employee_id, email, mobile, personalisation, slug, status)
        SELECT ${commId}::uuid,
               x.employee_id::uuid,
               nullif(x.email, ''),
               nullif(x.mobile, ''),
               nullif(x.personalisation, '')::jsonb,
               x.slug,
               CASE WHEN nullif(x.email, '') IS NULL THEN 'suppressed' ELSE 'queued' END
                 ::public.notification_status
          FROM unnest(
                 ${resolved.recipients.map((r) => r.employeeId)}::uuid[],
                 ${resolved.recipients.map((r) => r.email ?? "")}::text[],
                 ${resolved.recipients.map((r) => r.mobile ?? "")}::text[],
                 ${resolved.recipients.map((r) => JSON.stringify(r.vars))}::text[],
                 ${slugs}::text[]
               ) AS x(employee_id, email, mobile, personalisation, slug)
        RETURNING id, slug, employee_id, email
      `;

      const bySlug = new Map(insertedRows.map((row) => [row.slug, row] as const));

      // Ack/sign links: the raw token is mailed, only its SHA-256 is stored
      // (§5 "single-use, expiring"; the hash lives in `secure`, off PostgREST).
      if (needsToken) {
        const recipientIds: string[] = [];
        const hashes: string[] = [];
        for (let i = 0; i < slugs.length; i++) {
          const token = tokens[i];
          const row = bySlug.get(slugs[i] as string);
          if (token === null || token === undefined || row === undefined) continue;
          recipientIds.push(row.id);
          hashes.push(await sha256Hex(token));
        }
        if (recipientIds.length > 0) {
          await tx`
            INSERT INTO secure.communication_recipient_tokens (recipient_id, token_hash, expires_at)
            SELECT x.rid::uuid, x.hash, now() + make_interval(days => ${ACK_TOKEN_TTL_DAYS}::integer)
              FROM unnest(${recipientIds}::uuid[], ${hashes}::text[]) AS x(rid, hash)
            ON CONFLICT (recipient_id) DO UPDATE
              SET token_hash = EXCLUDED.token_hash,
                  expires_at = EXCLUDED.expires_at,
                  revoked_at = NULL
          `;
        }
      }

      // One `queued` event per recipient: the delivery log starts at creation,
      // not at the first provider callback.
      await tx`
        INSERT INTO public.communication_events
          (communication_id, recipient_id, event, provider, payload, recorded_by)
        SELECT ${commId}::uuid, r.id, 'queued', 'resend',
               jsonb_build_object('mode', ${body.mode}::text, 'request_id', ${requestId}::text),
               ${actorId}::uuid
          FROM public.communication_recipients r
         WHERE r.communication_id = ${commId}::uuid
      `;

      // The INSERT on `communications` is trigger-audited (migration 038); the
      // explicit `send` row below records the dispatch as an ACT, with counts.
      // `communication_recipients` is deliberately not trigger-audited — a
      // per-recipient chain row per open would bury everything else.
      const persisted: PersistedRecipient[] = [];
      for (let i = 0; i < resolved.recipients.length; i++) {
        const recipient = resolved.recipients[i] as ResolvedRecipient;
        const row = bySlug.get(slugs[i] as string);
        if (row === undefined) continue;
        const token = tokens[i] ?? null;
        const vars: Record<string, string> = {
          ...sharedVars,
          ...recipient.vars,
          ack_url: token === null ? "" : `${baseUrl}/ack/${row.slug}?t=${token}`,
          document_url: body.document_id === undefined ? "" : `${baseUrl}/documents/${body.document_id}`,
        };
        vars.subject = render(subjectTemplate, vars);
        persisted.push({
          id: row.id,
          employeeId: row.employee_id,
          email: row.email,
          slug: row.slug,
          ackToken: token,
          subject: vars.subject,
          html: render(htmlTemplate, vars),
          text: render(textTemplate, vars),
        });
      }

      return {
        id: commId,
        number,
        subject: subjectTemplate,
        status: isScheduled ? "scheduled" : "sending",
        recipients: persisted,
        suppressed: persisted.filter((r) => r.email === null).length,
        truncated: resolved.truncated,
      } satisfies CreatedCommunication;
    });

    // A future-dated send stops here: rows exist, nothing is mailed. The
    // `send_pending` mode delivers it when its time comes.
    if (isScheduled) {
      status = 202;
      responseBody = {
        communication_id: created.id,
        communication_number: created.number,
        status: "scheduled",
        scheduled_at: scheduledAt,
        mode: body.mode,
        recipients: { total: created.recipients.length, queued: created.recipients.length - created.suppressed },
        requestId,
      };
      if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
      if (jobRunId !== null) await endJob(ctx, jobRunId, body.job_code ?? "communication_send", "succeeded", responseBody);
      return ok(responseBody, { status, headers: cors, requestId });
    }

    // ── Resend, with NO transaction open ────────────────────────────────────
    const emails: OutgoingEmail[] = created.recipients
      .filter((r): r is PersistedRecipient & { email: string } => r.email !== null)
      .map((r) => ({
        from: formatFrom(from),
        to: r.email,
        subject: r.subject,
        html: r.html,
        text: r.text,
        replyTo: body.reply_to ?? null,
        cc: body.cc_emails ?? null,
        entityRef: r.id,
        tags: [
          { name: "communication_id", value: created.id },
          { name: "kind", value: body.communication_kind },
        ],
      }));
    const outcomes = await deliver(apiKey, emails);

    // ── txn 2: outcomes, counters, one `send` audit row ─────────────────────
    const summary = await recordOutcomes(ctx, created.id, created.recipients, outcomes, {
      mode: body.mode,
      subject: created.subject,
      number: created.number,
    });

    status = 200;
    responseBody = {
      communication_id: created.id,
      communication_number: created.number,
      mode: body.mode,
      template_code: template?.code ?? null,
      audience_truncated: created.truncated,
      ...summary,
      requestId,
    };

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
    if (jobRunId !== null) {
      await endJob(ctx, jobRunId, body.job_code ?? "communication_send", "succeeded", responseBody);
    }
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, problem.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }
    if (jobRunId !== null) {
      try {
        await sql()`
          SELECT app.job_end(${jobRunId}::uuid, 'failed'::public.job_run_status, NULL, NULL, NULL,
                             ${`${problem.code ?? "ERROR"}: ${problem.problem.title}`}::text)
        `;
      } catch (jobErr) {
        log.warn("could not close job run", { err: jobErr });
      }
    }

    if (problem.isServerFault) log.error("send failed", { err, code: problem.code });
    else log.warn("send refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey, job_run_id: jobRunId });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Delivery + bookkeeping
// ═════════════════════════════════════════════════════════════════════════════

async function deliver(apiKey: string, emails: readonly OutgoingEmail[]): Promise<Map<string, SendOutcome>> {
  const out = new Map<string, SendOutcome>();
  if (emails.length === 0) return out;
  const sandboxTo = (settings.get("comms.sandbox_redirect_to") ?? "").trim() || null;
    const outcomes = await mapWithConcurrency(emails, SEND_CONCURRENCY, (email) =>
      sendViaResend(apiKey, email, sandboxTo),
    );
  for (let i = 0; i < emails.length; i++) {
    out.set((emails[i] as OutgoingEmail).entityRef, outcomes[i] as SendOutcome);
  }
  return out;
}

interface SendSummary {
  recipients: { total: number; sent: number; failed: number; deferred: number; suppressed: number };
  status: string;
}

/**
 * txn 2. Per-recipient status + one event each, then the counters and a single
 * `send` audit row for the whole dispatch.
 */
async function recordOutcomes(
  ctx: RequestContext,
  communicationId: string,
  recipients: readonly PersistedRecipient[],
  outcomes: ReadonlyMap<string, SendOutcome>,
  meta: { mode: string; subject: string; number: string },
): Promise<SendSummary> {
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  let suppressed = 0;

  await withContext(ctx, async (tx) => {
    for (const recipient of recipients) {
      if (recipient.email === null) {
        suppressed++;
        await tx`
          UPDATE public.communication_recipients
             SET status = 'suppressed', failure_detail = 'no_email_address'
           WHERE id = ${recipient.id}::uuid
        `;
        continue;
      }
      const outcome = outcomes.get(recipient.id);
      if (outcome === undefined) {
        deferred++;
        continue;
      }
      if (outcome.kind === "sent") {
        sent++;
        await tx`
          UPDATE public.communication_recipients
             SET status = 'sent',
                 sent_at = now(),
                 provider_message_id = ${outcome.providerMessageId}::text,
                 failure_detail = NULL
           WHERE id = ${recipient.id}::uuid
        `;
      } else if (outcome.kind === "permanent") {
        failed++;
        await tx`
          UPDATE public.communication_recipients
             SET status = 'failed',
                 bounce_kind = 'hard',
                 failure_detail = ${outcome.detail}::text
           WHERE id = ${recipient.id}::uuid
        `;
      } else {
        deferred++;
        // Stays `queued` on purpose: `mode: "send_pending"` retries it.
        await tx`
          UPDATE public.communication_recipients
             SET status = 'queued', failure_detail = ${outcome.detail}::text
           WHERE id = ${recipient.id}::uuid
        `;
      }

      const event = outcome.kind === "sent" ? "sent" : outcome.kind === "permanent" ? "bounced" : "deferred";
      await tx`
        INSERT INTO public.communication_events
          (communication_id, recipient_id, event, provider, provider_event_id, payload, recorded_by)
        VALUES (
          ${communicationId}::uuid,
          ${recipient.id}::uuid,
          ${event}::text,
          'resend',
          ${outcome.providerMessageId}::text,
          jsonb_build_object('detail', ${outcome.detail}::text, 'request_id', ${ctx.requestId}::text),
          ${ctx.actorId}::uuid
        )
      `;
    }

    const finalStatus = deferred > 0 ? "sending" : failed > 0 ? "partially_failed" : "sent";
    await tx`
      UPDATE public.communications c
         SET status          = ${finalStatus}::text,
             sent_at         = COALESCE(c.sent_at, now()),
             failed_count    = agg.failed,
             recipient_count = GREATEST(c.recipient_count, agg.total)
        FROM (
          SELECT count(*)                                                        AS total,
                 count(*) FILTER (WHERE r.status IN ('failed','bounced'))        AS failed
            FROM public.communication_recipients r
           WHERE r.communication_id = ${communicationId}::uuid
        ) agg
       WHERE c.id = ${communicationId}::uuid
    `;

    await writeAudit(tx, ctx, {
      action: "send",
      entityTable: "public.communications",
      entityId: communicationId,
      entityLabel: `${meta.number}: ${meta.subject}`.slice(0, 200),
      newValue: {
        mode: meta.mode,
        channel: "email",
        recipients: recipients.length,
        sent,
        failed,
        deferred,
        suppressed,
      },
      reason: ctx.reason ??
        `communication-send ${meta.mode}: ${meta.number} to ${recipients.length} recipient(s)`,
    });
  });

  return {
    recipients: { total: recipients.length, sent, failed, deferred, suppressed },
    status: deferred > 0 ? "sending" : failed > 0 ? "partially_failed" : "sent",
  };
}

interface PendingWork {
  communicationId: string;
  number: string;
  subject: string;
  recipients: PersistedRecipient[];
  emails: OutgoingEmail[];
}

/**
 * `mode: "send_pending"` — everything still `queued`, either because a schedule
 * came due or because a previous attempt was cut short. Rendering is redone from
 * the stored body and the recipient's own `personalisation` snapshot, so the
 * message is exactly what the audience saw at creation time.
 */
async function loadPending(
  client: Sql,
  communicationId: string | null,
  limit: number,
  baseUrl: string,
): Promise<PendingWork | null> {
  const comms = await client<
    {
      id: string;
      communication_number: string;
      subject: string;
      body_html: string | null;
      body_text: string | null;
      from_name: string | null;
      from_email: string | null;
      reply_to: string | null;
      cc_emails: string[] | null;
      document_id: string | null;
      communication_kind: string;
    }[]
  >`
    SELECT c.id, c.communication_number, c.subject, c.body_html, c.body_text,
           c.from_name, c.from_email, c.reply_to, c.cc_emails, c.document_id,
           c.communication_kind
      FROM public.communications c
     WHERE c.status IN ('scheduled','sending')
       AND (${communicationId}::uuid IS NULL OR c.id = ${communicationId}::uuid)
       AND (c.scheduled_at IS NULL OR c.scheduled_at <= now())
       AND EXISTS (
         SELECT 1 FROM public.communication_recipients r
          WHERE r.communication_id = c.id AND r.status = 'queued' AND r.email IS NOT NULL
       )
     ORDER BY COALESCE(c.scheduled_at, c.created_at)
     LIMIT 1
  `;
  const comm = firstRow(comms);
  if (comm === null) return null;
  if (comm.from_email === null) {
    throw unprocessable(
      [{ pointer: "/communication_id", code: "invalid", detail: "This communication has no sending address." }],
      "The staged communication cannot be sent.",
      "EMAIL_FROM_UNCONFIGURED",
    );
  }

  const rows = await client<
    { id: string; employee_id: string | null; email: string; slug: string; personalisation: Record<string, unknown> | null }[]
  >`
    SELECT r.id, r.employee_id, r.email, r.slug, r.personalisation
      FROM public.communication_recipients r
     WHERE r.communication_id = ${comm.id}::uuid
       AND r.status = 'queued'
       AND r.email IS NOT NULL
     ORDER BY r.created_at
     LIMIT ${limit}
  `;

  const html = comm.body_html ?? (comm.body_text === null ? "" : textToHtml(comm.body_text));
  const text = comm.body_text ?? htmlToText(html);
  const from: FromAddress = { name: comm.from_name ?? "HR", email: comm.from_email };

  const recipients: PersistedRecipient[] = [];
  const emails: OutgoingEmail[] = [];
  for (const row of rows) {
    const vars: Record<string, string> = { app_url: baseUrl, today: istToday() };
    for (const [key, value] of Object.entries(row.personalisation ?? {})) {
      vars[key.toLowerCase()] = value === null || value === undefined ? "" : String(value);
    }
    // The raw ack token is unrecoverable (only its hash is stored), so a resumed
    // send links to the slug landing page, which re-issues the link on request.
    vars.ack_url = `${baseUrl}/ack/${row.slug}`;
    vars.document_url = comm.document_id === null ? "" : `${baseUrl}/documents/${comm.document_id}`;
    const subject = render(comm.subject, vars);
    const renderedHtml = render(html, vars);
    const renderedText = render(text, vars);
    recipients.push({
      id: row.id,
      employeeId: row.employee_id,
      email: row.email,
      slug: row.slug,
      ackToken: null,
      subject,
      html: renderedHtml,
      text: renderedText,
    });
    emails.push({
      from: formatFrom(from),
      to: row.email,
      subject,
      html: renderedHtml,
      text: renderedText,
      replyTo: comm.reply_to,
      cc: comm.cc_emails,
      entityRef: row.id,
      tags: [
        { name: "communication_id", value: comm.id },
        { name: "kind", value: comm.communication_kind },
      ],
    });
  }

  return {
    communicationId: comm.id,
    number: comm.communication_number,
    subject: comm.subject,
    recipients,
    emails,
  };
}

async function endJob(
  ctx: RequestContext,
  jobRunId: string,
  jobCode: string,
  outcome: "succeeded" | "failed",
  result: unknown,
): Promise<void> {
  await withContext(ctx, async (tx) => {
    await tx`
      SELECT app.job_end(
               ${jobRunId}::uuid,
               ${outcome}::public.job_run_status,
               NULL, NULL,
               ${JSON.stringify(result ?? null)}::jsonb,
               NULL)
    `;
    await auditJobRun(tx, ctx, { jobCode, runId: jobRunId, outcome, stats: result });
  });
}

/** Exported for `supabase/tests` and the admin console's shared contract. */
export { Audience, Message, SendBody, WebhookEnvelope };
