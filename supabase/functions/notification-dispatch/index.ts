/**
 * notification-dispatch — catalogue #14, auth model **C** (cron secret or service_role).
 *
 * Drains the notification outbox: `public.notifications` rows that producers
 * (`sla_sweep`, the attendance engine, the leave engine, …) insert with
 * `channel = 'in_app'` and `status = 'queued'`, whose comment in
 * `20260801002900_workflow.sql` reads "in-app row; the notifier job fans out
 * other channels". This is that job.
 *
 * Two passes, in one invocation:
 *
 *   PASS 1 (fan-out, one transaction, no network)
 *     Every due `in_app` row is marked `delivered` — it is in the user's feed the
 *     moment it exists — and, when preferences allow, a SIBLING row with
 *     `channel = 'email'` is inserted. One row per channel is exactly how
 *     migration 027 models delivery (the seed creates an `in_app` and an `email`
 *     template per event code), and `dedupe_key = '<origin>:email'` makes the
 *     fan-out idempotent even if this function runs twice.
 *
 *   PASS 2 (delivery)
 *     Every due `email` row — the ones just created plus anything left queued by
 *     an earlier run — is rendered, sent through Resend, and its outcome written
 *     back in a single closing transaction. No transaction is held open across
 *     the HTTP calls.
 *
 * PREFERENCES (`public.notification_preferences`, one row per
 * profile × event_code × channel):
 *   `is_enabled = false`  → the email row is written as `suppressed`, not
 *                           dropped, so "why did I not get an email?" has an
 *                           answer in the data.
 *   `digest_frequency`    → `off` suppresses; `hourly`/`daily`/`weekly` defer by
 *                           setting `scheduled_for` to the next boundary.
 *   quiet hours           → per-profile if set, else the company default
 *                           (`notifications.quiet_hours_start/end`, seeded
 *                           22:00–07:00 IST). Deferred to the window's end.
 *
 * EXEMPT from preferences AND quiet hours — the table comment in migration 027 is
 * the rule: "Transactional/statutory notifications ignore preferences — no
 * opt-out from 'salary credited' or a safety alert." So: any template marked
 * `is_transactional`, anything at `priority = 'critical'`, and the operational
 * codes in `QUIET_HOURS_EXEMPT_CODES` below. Half this venue's staff finish at
 * 01:30, so quiet hours are respected for everything else — a roster change is
 * not worth a 02:00 phone buzz.
 *
 * SCHEDULING: migration 041 registers no `cron_jobs` row and no `pg_cron` entry
 * for this function (see the DB-gap note in the handover). Until one exists it is
 * driven manually or by an external scheduler; every 5 minutes is the intended
 * cadence, and `app.job_begin` makes an overlapping run a no-op.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem, unavailable } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { addDays, istInstant, istParts, istTime, istToday, nowIso, toIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import type { Sql } from "../_shared/deps.ts";
import { rejectBrowserOrigin, verifyCron } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { auditJobRun } from "../_shared/audit.ts";
import {
  claim,
  idempotencyKeyFrom,
  release,
  replayResponse,
  requestHash,
  store,
} from "../_shared/idempotency.ts";

const FN_NAME = "notification-dispatch";
const DEFAULT_JOB_CODE = "notification_dispatch";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const SEND_CONCURRENCY = 5;
const DEFAULT_BATCH = 200;
const MAX_BATCH = 1_000;
/** Attempts before a queued email row is given up on as `failed`. */
const MAX_RETRIES = 5;

/** Company defaults seeded in migration 046. */
const SETTING_QUIET_START = "notifications.quiet_hours_start";
const SETTING_QUIET_END = "notifications.quiet_hours_end";
const SETTING_DIGEST_HOUR = "notifications.digest_hour_ist";

/**
 * Codes that ring through quiet hours regardless of template flags. Operational
 * and security events only: something is on fire, nobody turned up for a shift,
 * or an account changed hands.
 */
const QUIET_HOURS_EXEMPT_CODES: ReadonlySet<string> = new Set([
  "NO_SHOW_ALERT",
  "KIOSK_OFFLINE",
  "SAFETY_ALERT",
  "PASSWORD_CHANGED",
  "NEW_DEVICE_LOGIN",
  "SALARY_CREDITED",
]);

const DispatchBody = z
  .object({
    /** `cron_jobs.code`, for the `job_runs` row and the overlap lock. */
    job_code: z.string().trim().min(2).max(64).optional(),
    limit: z.number().int().min(1).max(MAX_BATCH).default(DEFAULT_BATCH),
    /** Restrict a manual replay to one profile or a few event codes. */
    profile_id: common.uuid.optional(),
    event_codes: z.array(z.string().trim().min(2).max(80)).min(1).max(50).optional(),
    /** Resolve everything, send nothing, write nothing. */
    dry_run: z.boolean().default(false),
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// Rendering
// ═════════════════════════════════════════════════════════════════════════════

const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * Render, or `null` when the template needs a value nothing supplied.
 *
 * A notification is machine-generated: unlike `communication-send`, refusing the
 * whole thing would silently drop an alert. So a template that cannot be filled
 * completely falls back to the producer's own `title`/`body`, which
 * `workflow.sql` and the engines already write as finished sentences. An email
 * reading "Your shift on  is now " is worse than the plain fallback.
 */
function renderComplete(template: string, vars: Readonly<Record<string, string>>): string | null {
  let missing = false;
  const out = template.replace(TOKEN_RE, (_whole, name: string) => {
    const value = vars[name.toLowerCase()];
    if (value === undefined || value === "") {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? null : out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br />")}</p>`)
    .join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// Quiet hours + digest windows (all IST; the DB stores naive `time` values)
// ═════════════════════════════════════════════════════════════════════════════

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

function toSeconds(value: string): number | null {
  const m = HHMM_RE.exec(value.trim());
  if (m === null) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[4] ?? "0");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

interface QuietDecision {
  quiet: boolean;
  /** ISO instant when the window ends. Only meaningful when `quiet` is true. */
  until: string | null;
}

/**
 * Is IST wall-clock "now" inside the quiet window, and when does it end?
 *
 * The window wraps midnight in the seeded configuration (22:00 → 07:00), which
 * is the case that matters here: the venue's late shift ends at 01:30.
 */
function quietHours(start: string | null, end: string | null): QuietDecision {
  if (start === null || end === null) return { quiet: false, until: null };
  const startSeconds = toSeconds(start);
  const endSeconds = toSeconds(end);
  if (startSeconds === null || endSeconds === null || startSeconds === endSeconds) {
    return { quiet: false, until: null };
  }
  const now = istTime(nowIso());
  const nowSeconds = toSeconds(now) ?? 0;
  const today = istToday();
  const endTime = `${pad2(Math.floor(endSeconds / 3600))}:${pad2(Math.floor((endSeconds % 3600) / 60))}:00`;

  if (startSeconds < endSeconds) {
    // Same-day window, e.g. 01:00 → 06:00.
    if (nowSeconds >= startSeconds && nowSeconds < endSeconds) {
      return { quiet: true, until: toIso(istInstant(today, endTime)) };
    }
    return { quiet: false, until: null };
  }
  // Wrapping window, e.g. 22:00 → 07:00.
  if (nowSeconds >= startSeconds) {
    return { quiet: true, until: toIso(istInstant(addDays(today, 1), endTime)) };
  }
  if (nowSeconds < endSeconds) {
    return { quiet: true, until: toIso(istInstant(today, endTime)) };
  }
  return { quiet: false, until: null };
}

/** Next `hourly`/`daily`/`weekly` digest boundary as an ISO instant. */
function nextDigestBoundary(frequency: string, digestHourIst: number): string | null {
  const parts = istParts(nowIso());
  const today = istToday();
  if (frequency === "hourly") {
    const nextHour = parts.hour + 1;
    return nextHour > 23
      ? toIso(istInstant(addDays(today, 1), "00:00:00"))
      : toIso(istInstant(today, `${pad2(nextHour)}:00:00`));
  }
  const at = `${pad2(digestHourIst)}:00:00`;
  if (frequency === "daily") {
    return parts.hour < digestHourIst
      ? toIso(istInstant(today, at))
      : toIso(istInstant(addDays(today, 1), at));
  }
  if (frequency === "weekly") {
    // Monday, matching `attendance.week_start_dow = 1` and the Monday 08:00 IST
    // digest of catalogue #27.
    const daysAhead = parts.weekday === 1 && parts.hour < digestHourIst
      ? 0
      : (8 - parts.weekday) % 7 || 7;
    return toIso(istInstant(addDays(today, daysAhead), at));
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Resend transport
// ═════════════════════════════════════════════════════════════════════════════

interface SendOutcome {
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
  /** `notifications.id`, so a provider webhook can be traced back. */
  entityRef: string;
  eventCode: string;
}

function resendApiKey(): string {
  const key = Deno.env.get("RESEND_API_KEY") ?? "";
  if (key === "") {
    throw unavailable("Email sending is not configured on this environment.", "EMAIL_TRANSPORT_UNCONFIGURED");
  }
  return key;
}

/**
 * Email sandbox (settings key `comms.sandbox_redirect_to`).
 *
 * Until a sending DOMAIN is verified with the provider, an unverified account
 * may only deliver to its own address — every other recipient is refused 403.
 * A pilot in that state would fill the delivery log with red rows that look
 * like a broken notifier rather than an unconfigured domain.
 *
 * With this setting present, every message is delivered to that ONE address
 * instead, the real intended recipient is preserved in a header and in the
 * subject prefix, and the send is tagged `sandbox` so the log is honest about
 * what happened. Absent the setting nothing changes and mail goes where it is
 * addressed — this is opt-in, and it never silently drops a message.
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

function safeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

async function sendViaResend(
  apiKey: string,
  email: OutgoingEmail,
  sandboxTo: string | null = null,
): Promise<SendOutcome> {
  const routed = sandboxRedirect(email.to, sandboxTo);
  const payload = {
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
      { name: "source", value: "notification" },
      ...(routed.sandboxed ? [{ name: "sandbox", value: "true" }] : []),
      { name: "event_code", value: safeTagValue(email.eventCode) },
    ],
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          // Resend de-duplicates on this for 24h: a retried batch cannot double-mail.
          "idempotency-key": email.entityRef,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (attempt === 2) return { kind: "transient", providerMessageId: null, detail: `network: ${String(err)}` };
      continue;
    }
    if (response.ok) {
      const body = await response.json().catch(() => null) as { id?: string } | null;
      return { kind: "sent", providerMessageId: body?.id ?? null, detail: null };
    }
    const text = (await response.text().catch(() => "")).slice(0, 500);
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 2) return { kind: "transient", providerMessageId: null, detail: `${response.status}: ${text}` };
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    return { kind: "permanent", providerMessageId: null, detail: `${response.status}: ${text}` };
  }
  return { kind: "transient", providerMessageId: null, detail: "exhausted retries" };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// Configuration
// ═════════════════════════════════════════════════════════════════════════════

interface DispatchConfig {
  companyId: string | null;
  companyName: string;
  quietStart: string | null;
  quietEnd: string | null;
  digestHourIst: number;
  fromEmail: string;
  fromName: string;
  /** `comms.sandbox_redirect_to`: deliver everything here instead. NULL = off. */
  sandboxRedirectTo: string | null;
  appBaseUrl: string;
}

async function loadConfig(client: Sql): Promise<DispatchConfig> {
  const settingRows = await client<{ key: string; value: string | null }[]>`
    SELECT s.key, s.value #>> '{}' AS value
      FROM public.settings s
     WHERE s.key = ANY(${[
    SETTING_QUIET_START,
    SETTING_QUIET_END,
    SETTING_DIGEST_HOUR,
    "comms.from_email",
    "comms.from_name",
    "comms.sandbox_redirect_to",
    "app_base_url",
    "comms.app_base_url",
  ]}::text[])
     ORDER BY (s.scope = 'global') DESC
  `;
  const settings = new Map<string, string | null>();
  for (const row of settingRows) if (!settings.has(row.key)) settings.set(row.key, row.value);

  const companyRows = await client<{ id: string; name: string }[]>`
    SELECT c.id, c.name FROM public.companies c
     WHERE c.deleted_at IS NULL ORDER BY c.created_at LIMIT 1
  `;
  const company = firstRow(companyRows);

  const fromEmail = settings.get("comms.from_email") ?? Deno.env.get("RESEND_FROM_EMAIL") ?? null;
  if (fromEmail === null || fromEmail.trim() === "") {
    // Explicit and actionable, rather than guessing a sending domain that has no
    // DKIM record and watching every message land in spam.
    throw unavailable(
      "No sending address is configured. Set the `comms.from_email` setting or the RESEND_FROM_EMAIL secret.",
      "EMAIL_FROM_UNCONFIGURED",
    );
  }
  const digestHour = Number(settings.get(SETTING_DIGEST_HOUR) ?? "9");

  return {
    companyId: company?.id ?? null,
    companyName: company?.name ?? "The Tamarind Tree",
    quietStart: settings.get(SETTING_QUIET_START) ?? null,
    quietEnd: settings.get(SETTING_QUIET_END) ?? null,
    digestHourIst: Number.isInteger(digestHour) && digestHour >= 0 && digestHour <= 23 ? digestHour : 9,
    fromEmail: fromEmail.trim(),
    fromName: (settings.get("comms.from_name") ?? `${company?.name ?? "The Tamarind Tree"} HR`).trim(),
    sandboxRedirectTo: (settings.get("comms.sandbox_redirect_to") ?? "").trim() || null,
    appBaseUrl: (settings.get("app_base_url") ?? settings.get("comms.app_base_url") ??
      Deno.env.get("APP_BASE_URL") ?? "https://hr.thetamarindtree.in").replace(/\/+$/, ""),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Pass 1 — fan-out
// ═════════════════════════════════════════════════════════════════════════════

interface InAppRow {
  id: string;
  recorded_at: Date | string;
  employee_id: string | null;
  profile_id: string | null;
  resolved_profile_id: string | null;
  template_id: string | null;
  event_code: string;
  title: string;
  body: string | null;
  deep_link: string | null;
  payload: Record<string, unknown> | null;
  priority: string;
  dedupe_key: string | null;
  expires_at: Date | string | null;
  email: string | null;
  /** From the email-channel template for this event code, when one exists. */
  email_template_id: string | null;
  is_transactional: boolean | null;
  pref_enabled: boolean | null;
  pref_quiet_start: string | null;
  pref_quiet_end: string | null;
  pref_digest: string | null;
}

interface FanOutStats {
  considered: number;
  queued: number;
  suppressed: number;
  deferred: number;
  no_address: number;
}

/**
 * Everything the fan-out decision needs, in one query: the queued `in_app` rows
 * plus the addressee, the email-channel template and the preference row.
 */
function dueInAppRows(
  client: Sql,
  input: { limit: number; companyId: string | null; profileId: string | null; eventCodes: string[] | null },
) {
  return client<InAppRow[]>`
    SELECT n.id,
           n.recorded_at,
           n.employee_id,
           n.profile_id,
           COALESCE(n.profile_id, e.profile_id)                        AS resolved_profile_id,
           n.template_id,
           n.event_code,
           n.title,
           n.body,
           n.deep_link,
           n.payload,
           n.priority,
           n.dedupe_key,
           n.expires_at,
           lower(COALESCE(p.email, e.work_email, e.personal_email))    AS email,
           t.id                                                       AS email_template_id,
           t.is_transactional,
           pr.is_enabled                                              AS pref_enabled,
           pr.quiet_hours_start::text                                 AS pref_quiet_start,
           pr.quiet_hours_end::text                                   AS pref_quiet_end,
           pr.digest_frequency                                        AS pref_digest
      FROM public.notifications n
      LEFT JOIN public.employees e ON e.id = n.employee_id AND e.deleted_at IS NULL
      LEFT JOIN public.profiles  p ON p.id = COALESCE(n.profile_id, e.profile_id) AND p.is_active
      LEFT JOIN LATERAL (
        SELECT t2.id, t2.is_transactional
          FROM public.notification_templates t2
         WHERE t2.company_id = COALESCE(e.company_id, ${input.companyId}::uuid)
           AND upper(t2.code) = upper(n.event_code)
           AND t2.channel = 'email'
           AND t2.is_active
           AND t2.deleted_at IS NULL
         LIMIT 1
      ) t ON true
      LEFT JOIN public.notification_preferences pr
             ON pr.profile_id = COALESCE(n.profile_id, e.profile_id)
            AND pr.event_code = n.event_code
            AND pr.channel = 'email'
     WHERE n.channel = 'in_app'
       AND n.status = 'queued'
       AND (n.scheduled_for IS NULL OR n.scheduled_for <= now())
       AND (n.expires_at IS NULL OR n.expires_at > now())
       AND (${input.profileId}::uuid IS NULL
            OR COALESCE(n.profile_id, e.profile_id) = ${input.profileId}::uuid)
       AND (${input.eventCodes}::text[] IS NULL OR n.event_code = ANY(${input.eventCodes}::text[]))
     ORDER BY n.recorded_at
     LIMIT ${input.limit}
  `;
}

interface FanOutDecision {
  status: "queued" | "suppressed";
  scheduledFor: string | null;
  detail: string | null;
}

/**
 * The whole preference policy, in one place and with no I/O, so it can be unit
 * tested against the seeded defaults.
 */
export function decideFanOut(
  row: {
    priority: string;
    event_code: string;
    is_transactional: boolean | null;
    pref_enabled: boolean | null;
    pref_digest: string | null;
    pref_quiet_start: string | null;
    pref_quiet_end: string | null;
  },
  config: { quietStart: string | null; quietEnd: string | null; digestHourIst: number },
): FanOutDecision {
  const exempt = row.is_transactional === true ||
    row.priority === "critical" ||
    QUIET_HOURS_EXEMPT_CODES.has(row.event_code.toUpperCase());

  if (!exempt) {
    if (row.pref_enabled === false) {
      return { status: "suppressed", scheduledFor: null, detail: "preference_disabled" };
    }
    const digest = row.pref_digest ?? "immediate";
    if (digest === "off") {
      return { status: "suppressed", scheduledFor: null, detail: "digest_off" };
    }
    if (digest !== "immediate") {
      const boundary = nextDigestBoundary(digest, config.digestHourIst);
      if (boundary !== null) {
        return { status: "queued", scheduledFor: boundary, detail: `digest_${digest}` };
      }
    }
    // Per-profile window wins; otherwise the company default.
    const start = row.pref_quiet_start ?? config.quietStart;
    const end = row.pref_quiet_end ?? config.quietEnd;
    const quiet = quietHours(start, end);
    if (quiet.quiet) {
      return { status: "queued", scheduledFor: quiet.until, detail: "quiet_hours" };
    }
  }
  return { status: "queued", scheduledFor: null, detail: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// Pass 2 — delivery
// ═════════════════════════════════════════════════════════════════════════════

interface EmailRow {
  id: string;
  recorded_at: Date | string;
  event_code: string;
  title: string;
  body: string | null;
  deep_link: string | null;
  payload: Record<string, unknown> | null;
  retry_count: number;
  email: string | null;
  first_name: string | null;
  display_name: string | null;
  employee_code: string | null;
  subject_template: string | null;
  body_template: string | null;
  company_name: string | null;
}

function dueEmailRows(
  client: Sql,
  input: { limit: number; companyId: string | null; profileId: string | null; eventCodes: string[] | null },
) {
  return client<EmailRow[]>`
    SELECT n.id,
           n.recorded_at,
           n.event_code,
           n.title,
           n.body,
           n.deep_link,
           n.payload,
           n.retry_count,
           lower(COALESCE(p.email, e.work_email, e.personal_email))          AS email,
           COALESCE(e.first_name, split_part(p.full_name, ' ', 1))           AS first_name,
           COALESCE(e.display_name, p.full_name)                            AS display_name,
           e.employee_code,
           t.subject_template,
           t.body_template,
           c.name                                                           AS company_name
      FROM public.notifications n
      LEFT JOIN public.employees e ON e.id = n.employee_id AND e.deleted_at IS NULL
      LEFT JOIN public.profiles  p ON p.id = COALESCE(n.profile_id, e.profile_id) AND p.is_active
      LEFT JOIN public.companies c ON c.id = COALESCE(e.company_id, ${input.companyId}::uuid)
      LEFT JOIN LATERAL (
        SELECT t2.subject_template, t2.body_template
          FROM public.notification_templates t2
         WHERE t2.id = n.template_id
            OR (t2.company_id = COALESCE(e.company_id, ${input.companyId}::uuid)
                AND upper(t2.code) = upper(n.event_code)
                AND t2.channel = 'email'
                AND t2.is_active
                AND t2.deleted_at IS NULL)
         ORDER BY (t2.id = n.template_id) DESC
         LIMIT 1
      ) t ON true
     WHERE n.channel = 'email'
       AND n.status = 'queued'
       AND (n.scheduled_for IS NULL OR n.scheduled_for <= now())
       AND (n.expires_at IS NULL OR n.expires_at > now())
       AND n.retry_count < ${MAX_RETRIES}
       AND (${input.profileId}::uuid IS NULL
            OR COALESCE(n.profile_id, e.profile_id) = ${input.profileId}::uuid)
       AND (${input.eventCodes}::text[] IS NULL OR n.event_code = ANY(${input.eventCodes}::text[]))
     ORDER BY n.recorded_at
     LIMIT ${input.limit}
  `;
}

function composeEmail(row: EmailRow, config: DispatchConfig): OutgoingEmail | null {
  if (row.email === null || row.email === "") return null;

  const vars: Record<string, string> = {
    company_name: row.company_name ?? config.companyName,
    app_url: config.appBaseUrl,
    today: istToday(),
    event_code: row.event_code,
    title: row.title,
    body: row.body ?? "",
    first_name: row.first_name ?? "",
    display_name: row.display_name ?? "",
    full_name: row.display_name ?? "",
    employee_code: row.employee_code ?? "",
    email: row.email,
    deep_link_url: row.deep_link === null ? config.appBaseUrl : `${config.appBaseUrl}${row.deep_link}`,
  };
  // The producer's payload supplies the event-specific tokens
  // (`{{shift_label}}`, `{{from_date}}`, …). Scalars only: an object would
  // stringify to "[object Object]" inside an email.
  if (row.payload !== null && typeof row.payload === "object" && !Array.isArray(row.payload)) {
    for (const [key, value] of Object.entries(row.payload)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "object") continue;
      vars[key.toLowerCase()] = String(value);
    }
  }

  const subject = (row.subject_template === null ? null : renderComplete(row.subject_template, vars)) ?? row.title;
  const bodyText = (row.body_template === null ? null : renderComplete(row.body_template, vars)) ??
    row.body ?? row.title;

  const footer = row.deep_link === null
    ? ""
    : `\n\nOpen it here: ${config.appBaseUrl}${row.deep_link}`;
  const text = `${bodyText}${footer}`;

  return {
    from: `"${config.fromName.replace(/"/g, "")}" <${config.fromEmail}>`,
    to: row.email,
    subject: subject.slice(0, 300),
    html: textToHtml(text),
    text,
    entityRef: row.id,
    eventCode: row.event_code,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Handler
// ═════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ───────────────────────────────────────────────
  // Kept for symmetry only: this endpoint is not browser-callable and step 4
  // refuses any request that carries an Origin.
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ─────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ───────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;
  let jobRunId: string | null = null;
  let jobCode = DEFAULT_JOB_CODE;
  let responseBody: unknown = null;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model C) ─────────────────────────────────────────────
    rejectBrowserOrigin(req);
    const cronAuth = verifyCron(req);
    log.info("cron authenticated", { via: cronAuth.via });

    // ── STEP 5 · Authority ──────────────────────────────────────────────────
    // A scheduled job holds no capability row: presenting the cron secret (or
    // the service-role key) IS the authority, and `verifyCron` compared it in
    // constant time. There is nothing further to check.

    const rawBody = await readRawBody(req, { maxBytes: 16 * 1024, requireJsonContentType: false });
    const decoded = rawBody === "" ? {} : decodeJson(rawBody);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    // A runaway scheduler must not turn into a mail storm.
    await enforce(RATE_LIMITS.heavyJob, limitKey(FN_NAME, "cron"), "DISPATCH_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const body = parse(DispatchBody, decoded, "dispatch request");
    jobCode = body.job_code ?? DEFAULT_JOB_CODE;

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // Keyed to the minute: a pg_net retry inside the same minute replays the
    // stored answer instead of draining the outbox twice. `app.job_begin` below
    // is the real concurrency guard; this one covers the retry.
    if (!body.dry_run) {
      const minuteBucket = `${istToday()}T${istTime(nowIso()).slice(0, 5)}`;
      idempotencyKey = idempotencyKeyFrom(req) ?? `${FN_NAME}:${jobCode}:${minuteBucket}`;
      const hash = await requestHash(FN_NAME, rawBody, jobCode);
      const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: hash });
      if (claimed.state === "replay") {
        status = claimed.status;
        log.info("idempotent replay", { key: idempotencyKey });
        return replayResponse(claimed, { ...cors, "x-request-id": requestId });
      }
    }

    const pool = sql();

    // Double-run guard (§9): `uq_job_runs__running_lock` makes a second
    // concurrent run impossible, and the answer is a 200, not an error.
    if (!body.dry_run) {
      const begun = await pool<{ id: string | null }[]>`
        SELECT app.job_begin(${jobCode}, ${`${FN_NAME}:${jobCode}`}) AS id
      `;
      jobRunId = firstRow(begun)?.id ?? null;
      if (jobRunId === null) {
        status = 200;
        responseBody = { skipped: "already_running", job_code: jobCode, requestId };
        if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
        return ok(responseBody, { status, headers: cors, requestId });
      }
    }

    const config = await loadConfig(pool);
    const apiKey = body.dry_run ? "" : resendApiKey();

    const ctx: RequestContext = {
      actorId: null, // a scheduled job is not a person
      actorRole: null,
      source: "cron",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: null,
      reason: `${FN_NAME}: drain notification outbox`,
    };

    const selector = {
      limit: body.limit,
      companyId: config.companyId,
      profileId: body.profile_id ?? null,
      eventCodes: body.event_codes ?? null,
    };

    // ── PASS 1 · fan-out (STEPS 9 + 10: one transaction, audit inside) ───────
    const inApp = await dueInAppRows(pool, selector);
    const fanOut: FanOutStats = {
      considered: inApp.length,
      queued: 0,
      suppressed: 0,
      deferred: 0,
      no_address: 0,
    };

    if (inApp.length > 0 && !body.dry_run) {
      await withContext(ctx, async (tx) => {
        for (const row of inApp) {
          const recordedAt = toIso(row.recorded_at);
          const hasAddress = row.email !== null && row.email !== "";
          const decision = decideFanOut(row, config);

          if (hasAddress) {
            const dedupe = `${row.dedupe_key ?? row.id}:email`;
            // No ON CONFLICT: `uq_notifications__dedupe` exists per PARTITION,
            // not on the partitioned parent, so an inference clause on
            // `public.notifications` would not resolve. The NOT EXISTS guard is
            // safe under the job lock, and a losing race raises 23505 which
            // aborts only this batch — never a double email.
            await tx`
              INSERT INTO public.notifications
                (employee_id, profile_id, template_id, event_code, channel, title, body,
                 deep_link, payload, priority, status, scheduled_for, dedupe_key, expires_at,
                 failure_detail)
              SELECT ${row.employee_id}::uuid,
                     ${row.resolved_profile_id}::uuid,
                     COALESCE(${row.email_template_id}::uuid, ${row.template_id}::uuid),
                     ${row.event_code}::text,
                     'email'::public.notification_channel,
                     ${row.title}::text,
                     ${row.body}::text,
                     ${row.deep_link}::text,
                     ${row.payload === null ? null : JSON.stringify(row.payload)}::jsonb,
                     ${row.priority}::text,
                     ${decision.status}::public.notification_status,
                     ${decision.scheduledFor}::timestamptz,
                     ${dedupe}::text,
                     ${row.expires_at === null ? null : toIso(row.expires_at)}::timestamptz,
                     ${decision.detail}::text
               WHERE NOT EXISTS (
                 SELECT 1 FROM public.notifications n2 WHERE n2.dedupe_key = ${dedupe}::text
               )
            `;
            if (decision.status === "suppressed") fanOut.suppressed++;
            else if (decision.scheduledFor !== null) fanOut.deferred++;
            else fanOut.queued++;
          } else {
            fanOut.no_address++;
          }

          // The in-app item itself is delivered: it is in the feed. The
          // partition key is part of the PK, so both columns are matched.
          await tx`
            UPDATE public.notifications
               SET status = 'delivered', delivered_at = now()
             WHERE id = ${row.id}::uuid
               AND recorded_at = ${recordedAt}::timestamptz
          `;
        }
      });
    }

    // ── PASS 2 · delivery, with NO transaction open ──────────────────────────
    const emailRows = await dueEmailRows(pool, selector);
    const composed: { row: EmailRow; email: OutgoingEmail }[] = [];
    const unaddressed: EmailRow[] = [];
    for (const row of emailRows) {
      const email = composeEmail(row, config);
      if (email === null) unaddressed.push(row);
      else composed.push({ row, email });
    }

    if (body.dry_run) {
      status = 200;
      responseBody = {
        dry_run: true,
        job_code: jobCode,
        fan_out: { ...fanOut, note: "nothing written" },
        delivery: {
          due: emailRows.length,
          sendable: composed.length,
          without_address: unaddressed.length,
          preview: composed.slice(0, 10).map((c) => ({ to: c.email.to, subject: c.email.subject })),
        },
        requestId,
      };
      return ok(responseBody, { status, headers: cors, requestId });
    }

    const outcomes = await mapWithConcurrency(
      composed,
      SEND_CONCURRENCY,
      (item) => sendViaResend(apiKey, item.email, config.sandboxRedirectTo),
    );

    // ── Closing transaction: outcomes + the job's audit row ──────────────────
    let sent = 0;
    let failed = 0;
    let deferredSend = 0;

    await withContext(ctx, async (tx) => {
      for (let i = 0; i < composed.length; i++) {
        const entry = composed[i] as { row: EmailRow; email: OutgoingEmail };
        const outcome = outcomes[i] as SendOutcome;
        const recordedAt = toIso(entry.row.recorded_at);

        if (outcome.kind === "sent") {
          sent++;
          await tx`
            UPDATE public.notifications
               SET status = 'sent',
                   sent_at = now(),
                   provider_message_id = ${outcome.providerMessageId}::text,
                   failure_detail = NULL
             WHERE id = ${entry.row.id}::uuid
               AND recorded_at = ${recordedAt}::timestamptz
          `;
          continue;
        }
        if (outcome.kind === "permanent") {
          failed++;
          await tx`
            UPDATE public.notifications
               SET status = 'failed',
                   retry_count = retry_count + 1,
                   failure_detail = ${outcome.detail}::text
             WHERE id = ${entry.row.id}::uuid
               AND recorded_at = ${recordedAt}::timestamptz
          `;
          continue;
        }
        // Transient: back off and let the next run try again, until MAX_RETRIES.
        const attempt = entry.row.retry_count + 1;
        const backoffMinutes = Math.min(60, 2 ** attempt);
        deferredSend++;
        await tx`
          UPDATE public.notifications
             SET status = CASE WHEN ${attempt}::integer >= ${MAX_RETRIES}::integer
                               THEN 'failed'::public.notification_status
                               ELSE 'queued'::public.notification_status END,
                 retry_count = ${attempt}::integer,
                 scheduled_for = now() + make_interval(mins => ${backoffMinutes}::integer),
                 failure_detail = ${outcome.detail}::text
           WHERE id = ${entry.row.id}::uuid
             AND recorded_at = ${recordedAt}::timestamptz
        `;
      }

      // No address and no prospect of one: suppress rather than retry forever.
      for (const row of unaddressed) {
        await tx`
          UPDATE public.notifications
             SET status = 'suppressed', failure_detail = 'no_email_address'
           WHERE id = ${row.id}::uuid
             AND recorded_at = ${toIso(row.recorded_at)}::timestamptz
        `;
      }

      // `public.notifications` is deliberately NOT trigger-audited (migration
      // 038), so the job's own row on the hash chain is how a drain appears in
      // the audit trail.
      if (jobRunId !== null) {
        await tx`
          SELECT app.job_end(
                   ${jobRunId}::uuid,
                   'succeeded'::public.job_run_status,
                   ${sent + failed + deferredSend}::integer,
                   ${failed}::integer,
                   ${JSON.stringify({ fan_out: fanOut, sent, failed, deferred: deferredSend })}::jsonb,
                   NULL)
        `;
        await auditJobRun(tx, ctx, {
          jobCode,
          runId: jobRunId,
          outcome: "succeeded",
          stats: { fan_out: fanOut, sent, failed, deferred: deferredSend, suppressed: unaddressed.length },
        });
      }
    });

    status = 200;
    responseBody = {
      job_code: jobCode,
      job_run_id: jobRunId,
      fan_out: fanOut,
      delivery: {
        due: emailRows.length,
        sent,
        failed,
        deferred: deferredSend,
        without_address: unaddressed.length,
      },
      requestId,
    };

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
    log.info("outbox drained", { sent, failed, deferred: deferredSend, fanned_out: fanOut.queued });
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
      // Close the run so its lock key is released; otherwise every later run
      // sees "already_running" forever.
      try {
        await sql()`
          SELECT app.job_end(${jobRunId}::uuid, 'failed'::public.job_run_status, NULL, NULL, NULL,
                             ${`${problem.code ?? "ERROR"}: ${problem.problem.title}`}::text)
        `;
      } catch (jobErr) {
        log.warn("could not close job run", { err: jobErr });
      }
    }

    if (problem.isServerFault) log.error("dispatch failed", { err, code: problem.code });
    else log.warn("dispatch refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey, job_run_id: jobRunId, job_code: jobCode });
  }
});

/** Exported for `supabase/tests`: the contract and the two pure decisions. */
export { DispatchBody, nextDigestBoundary, quietHours, renderComplete };
