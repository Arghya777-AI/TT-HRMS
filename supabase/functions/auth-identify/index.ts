/**
 * auth-identify — step 1 of the three-step sign-in (spec-employee §129,
 * 01-prd-employee §10.3). Auth model: **none (pre-auth, anon key only)**.
 *
 * CATALOGUE NOTE: spec-architecture §4 lists 27 functions and this is not one of
 * them, but spec-employee §129 and PRD §10.3 both name `auth-identify` as the
 * resolver for the login screen's single identifier field. It is function #28 by
 * necessity, and it follows the same 12-step lifecycle as the other 27.
 *
 * WHY IT EXISTS AT ALL: `/login` has ONE field that accepts either `TT0042` or a
 * work email, and the screen must then decide between three very different next
 * steps — passkey, password, or the "gate attendance only" message for kiosk-only
 * staff. None of that is decidable in the browser: `public.employees` is not
 * readable pre-auth (RLS, boundary B3), so the lookup has to happen here with the
 * service role.
 *
 * WHAT IT WILL AND WILL NOT SAY (this is the whole security design):
 *   - Returns exactly five facts, per PRD §10.3: `{found, displayNameFirstOnly,
 *     maskedEmail, hasPasskey, portalState}`. Nothing else — no employee id, no
 *     employee code, no role, no phone, no photo, no employment status.
 *   - `must_change_password` appears in the PRD's sequence diagram; it is
 *     DELIBERATELY NOT returned here. Pre-auth, it tells an attacker which
 *     accounts are still sitting on an HR-issued temporary password, which is
 *     precisely the set worth attacking. The client learns it from `profiles`
 *     after the session exists (and `webauthn-login` returns it on verify).
 *   - `found: false` is an enumeration oracle by design: the product needs to
 *     say "we couldn't find that code". It is bounded by two rate limits
 *     (10/10 min/IP, 5/10 min/identifier) and a constant ~400 ms response time,
 *     which is the mitigation PRD §10.3 specifies.
 *   - First name only, and the email masked. A shared back-office screen must
 *     not turn an employee code into a full name plus address book entry.
 *
 * AUDIT: one hash-chained row per attempt (`auth.identify.succeeded` /
 * `auth.identify.failed`) carrying the SHA-256 of the attempted identifier, not
 * the identifier. Nothing is written to `public.sessions_audit`: its
 * `ck_sessions_audit__event` set has no `identify` value, and the `login_failed`
 * value it does have drives `sessions_audit_apply_event()` — which increments
 * `profiles.failed_login_count` and deactivates the account at 10. Logging a
 * mistyped employee code there would hand anyone a remote account-lockout button.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem } from "../_shared/errors.ts";
import { parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { nowMs } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql as sqlHandle,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { sha256Hex } from "../_shared/auth.ts";
import { enforce, limitKey, type RateLimitSpec } from "../_shared/ratelimit.ts";
import { writeAudit } from "../_shared/audit.ts";

const FN_NAME = "auth-identify";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/**
 * PRD §10.3: "10 attempts / 10 min / IP, 5 / 10 min / identifier".
 *
 * Not in `RATE_LIMITS` — `_shared/ratelimit.ts` carries `authPreLogin`
 * (20/minute) which is an order of magnitude looser than the number the PRD
 * writes down for this screen. The two documented buckets are declared here
 * rather than loosening the shared table; if a second pre-auth surface ever
 * needs the same numbers, promote them to `_shared/ratelimit.ts` unchanged.
 *
 * `refillPerMinute = capacity / 10` gives "N per 10 minutes" exactly: an empty
 * bucket takes ten minutes to refill and a full one absorbs the whole burst.
 */
const LIMIT_PER_IP: RateLimitSpec = {
  bucket: "auth_identify_ip",
  capacity: 10,
  refillPerMinute: 10 / 10,
};
const LIMIT_PER_IDENTIFIER: RateLimitSpec = {
  bucket: "auth_identify_identifier",
  capacity: 5,
  refillPerMinute: 5 / 10,
};

/** PRD §10.3 anti-enumeration: every answer takes about this long, hit or miss. */
const CONSTANT_TIME_MS = 400;

const IdentifyBody = z
  .object({
    /**
     * Whatever the user typed. Classified below into an employee code or an
     * email; a value that is neither is answered `found: false` rather than 422,
     * so there is exactly ONE failure shape on this endpoint and a probe learns
     * nothing from the status code.
     */
    identifier: z.string().trim().min(2).max(254),
  })
  .strict();

/** `employees.employee_code` is generated uppercase from `employee_code_prefix`. */
const CODE_RE = /^[A-Z]{1,6}[0-9]{1,10}$/;
/** Deliberately laxer than `common.email`: classification, not validation. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/;

export type PortalState = "none" | "invited" | "active" | "suspended";

interface Classified {
  /** Uppercased, punctuation-stripped employee code, or `null`. */
  code: string | null;
  /** Lowercased email, or `null`. */
  email: string | null;
}

/**
 * Split the single field into the two things it can be.
 *
 * The code branch uppercases (PRD §10.3: "employee code, case-insensitive") so
 * the lookup can use `uq_employees__employee_code` directly instead of a
 * sequential scan through `upper(employee_code)`.
 */
export function classifyIdentifier(raw: string): Classified {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    return { code: null, email: EMAIL_RE.test(email) ? email : null };
  }
  const code = trimmed.replace(/[\s._-]+/g, "").toUpperCase();
  return { code: CODE_RE.test(code) ? code : null, email: null };
}

/**
 * `ravi.kumar@tamarindtree.co` → `r•••••••r@t•••••••••.co`.
 *
 * Enough for the employee to recognise their own address on the password step,
 * useless to anyone else. The run of dots is capped at 8 so the mask does not
 * leak the exact length of the local part or the domain, and the public suffix
 * is kept because "is this my work address or my personal one?" is the question
 * the employee is actually answering.
 */
export function maskEmail(email: string | null): string | null {
  if (email === null || email === "") return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  const dots = (n: number): string => "•".repeat(Math.min(Math.max(n, 1), 8));
  const maskedLocal = local.length <= 2
    ? `${local.slice(0, 1)}${dots(2)}`
    : `${local.slice(0, 1)}${dots(local.length - 2)}${local.slice(-1)}`;

  const labels = domain.split(".");
  const suffix = labels.length > 1 ? labels[labels.length - 1] as string : "";
  const head = labels.slice(0, Math.max(labels.length - 1, 1));
  const maskedHead = head
    .map((label) => (label.length <= 1 ? label : `${label.slice(0, 1)}${dots(label.length - 1)}`))
    .join(".");

  return suffix === "" ? `${maskedLocal}@${maskedHead}` : `${maskedLocal}@${maskedHead}.${suffix}`;
}

/** One row, always — the query is built from a one-row seed with LEFT JOINs. */
interface LookupRow {
  employee_id: string | null;
  profile_id: string | null;
  first_name: string | null;
  display_name: string | null;
  full_name: string | null;
  email: string | null;
  employment_status: string | null;
  profile_active: boolean | null;
  has_logged_in: boolean | null;
  has_passkey: boolean | null;
}

/**
 * `employees.portal_access_state` (PRD §10.7, spec-employee §135) does not exist
 * as a column in migrations 001–050 — see the DB gap note in the handover. It is
 * DERIVED here from facts that do exist, with the same four values and the same
 * meanings:
 *
 *   none       no `profiles` row is attached → no auth user → kiosk-only staff
 *   suspended  profile deactivated, or employment ended / suspended / absconding
 *   invited    auth user exists, has never signed in (`last_login_at IS NULL`)
 *   active     has signed in at least once
 *
 * When the column lands, replace this function with a read of it and delete the
 * derivation — do not keep two answers.
 */
export function derivePortalState(row: LookupRow): PortalState {
  if (row.profile_id === null) return "none";
  const ended = row.employment_status !== null &&
    ["suspended", "exited", "absconding", "retired"].includes(row.employment_status);
  if (row.profile_active !== true || ended) return "suspended";
  return row.has_logged_in === true ? "active" : "invited";
}

/** First name only. `employees.first_name` when known, else the first token. */
function firstNameOnly(row: LookupRow): string | null {
  const explicit = (row.first_name ?? "").trim();
  if (explicit !== "") return explicit;
  const fallback = (row.display_name ?? row.full_name ?? "").trim();
  if (fallback === "") return null;
  return (fallback.split(/\s+/)[0] as string | undefined) ?? null;
}

/** Sleep out the remainder of the constant-time budget. */
async function padToConstantTime(startedMs: number): Promise<void> {
  const remaining = CONSTANT_TIME_MS - (nowMs() - startedMs);
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ─────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ───────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ──────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;
  const startedMs = nowMs();

  let status = 500;

  try {
    assertOriginAllowed(req);
    const client = sqlHandle();

    // ── STEP 4 · Auth ─────────────────────────────────────────────────────────
    // NONE, by definition: this runs before anybody has a session. The only
    // credential in play is the project's anon key, which the Supabase gateway
    // has already checked — so `verify_jwt` can stay ON for this function; it
    // needs no `--no-verify-jwt` deployment flag. The anon key is public
    // (boundary B2), so it is not treated as authority anywhere below.

    // ── STEP 5 · Authority ────────────────────────────────────────────────────
    // Nothing to authorise: the response is the same five facts for every caller,
    // and none of them is capability-gated. The controls are the rate limits, the
    // constant-time answer and the response allowlist, not a capability.

    // ── STEP 6 · Rate limit (a) per IP ────────────────────────────────────────
    // Taken before the body is even parsed and OUTSIDE any transaction, so a
    // rejected or malformed attempt still spends its token.
    const ip = clientIpFrom(req);
    await enforce(
      LIMIT_PER_IP,
      limitKey(FN_NAME, "ip", ip),
      "AUTH_IDENTIFY_RATE_LIMITED",
      client,
    );

    // ── STEP 7 · Validate ─────────────────────────────────────────────────────
    const { data: body } = await parseBody(req, IdentifyBody, { maxBytes: 2 * 1024 });
    const classified = classifyIdentifier(body.identifier);

    // ── STEP 6 (b) · Rate limit per identifier ────────────────────────────────
    // Out of numerical order because the key IS the parsed body. Hashed, so
    // `app.rate_limit_buckets` never accumulates a list of real employee emails,
    // and normalised first so `TT0042`, `tt0042` and `tt 0042` share one bucket
    // instead of getting three times the budget.
    const identifierNormalised = classified.code ?? classified.email ?? body.identifier.trim().toLowerCase();
    const identifierHash = await sha256Hex(identifierNormalised);
    await enforce(
      LIMIT_PER_IDENTIFIER,
      limitKey(FN_NAME, "id", identifierHash.slice(0, 32)),
      "AUTH_IDENTIFY_RATE_LIMITED",
      client,
    );

    // ── STEP 8 · Idempotency ──────────────────────────────────────────────────
    // Deliberately none. This is a lookup: it mutates no business row, and the
    // one row it does write (the audit record of the attempt) MUST be written
    // again on a retry — that is the point of an audit trail. Claiming a key here
    // would also let a caller pin a stale answer for 24 hours.

    // ── STEPS 9 + 10 · app.set_context + ONE transaction, audit inside it ─────
    // `sql()` is the service-role path (`SUPABASE_DB_URL`), which is what makes
    // the pre-auth read possible at all: RLS on `employees`/`profiles` denies
    // `anon` outright (boundary B3). PostgREST is not an option here — the audit
    // row goes through `audit.write_row()` in an unexposed schema, and it has to
    // share ONE transaction with the read so that "we answered" and "we recorded
    // that we answered" cannot come apart.
    const ctx: RequestContext = {
      actorId: null, // nobody is signed in yet
      actorRole: null,
      source: "web_employee",
      sourceRoute: FN_NAME,
      requestId,
      ip,
      ua: userAgentFrom(req),
      reason: "pre-auth identifier resolution for the sign-in screen",
    };

    const row = await withContext(ctx, async (tx) => {
      const rows = await tx<LookupRow[]>`
        WITH input AS (
          SELECT ${classified.code}::text AS code,
                 ${classified.email}::text AS email
        ),
        -- Employee match: exact employee_code (uppercased by the caller, so the
        -- unique index is usable) or work_email (uq_employees__work_email is on
        -- lower(work_email)). A rehired person can hold two rows across time;
        -- prefer the one that is not an old exit.
        matched AS (
          SELECT e.id                       AS employee_id,
                 e.profile_id,
                 e.first_name,
                 e.display_name,
                 e.work_email,
                 e.employment_status::text  AS employment_status
            FROM public.employees e
            CROSS JOIN input i
           WHERE e.deleted_at IS NULL
             AND (
                   (i.code  IS NOT NULL AND e.employee_code = i.code)
                OR (i.email IS NOT NULL AND lower(e.work_email) = i.email)
             )
           ORDER BY (e.employment_status::text NOT IN ('exited', 'retired')) DESC,
                    e.created_at DESC
           LIMIT 1
        ),
        -- The profile behind that employee, or — for a login that has no employee
        -- record yet (a pre-joining or platform-admin account) — a profile found
        -- by email alone.
        prof AS (
          SELECT p.id, p.email, p.full_name, p.is_active, p.last_login_at
            FROM public.profiles p
           WHERE p.id = (SELECT m.profile_id FROM matched m)
          UNION ALL
          SELECT p.id, p.email, p.full_name, p.is_active, p.last_login_at
            FROM public.profiles p
            CROSS JOIN input i
           WHERE NOT EXISTS (SELECT 1 FROM matched)
             AND i.email IS NOT NULL
             AND lower(p.email) = i.email
           LIMIT 1
        )
        SELECT m.employee_id,
               pr.id                                   AS profile_id,
               m.first_name,
               m.display_name,
               pr.full_name,
               COALESCE(m.work_email, pr.email)        AS email,
               m.employment_status,
               pr.is_active                            AS profile_active,
               (pr.last_login_at IS NOT NULL)          AS has_logged_in,
               EXISTS (
                 SELECT 1
                   FROM public.webauthn_credentials w
                  WHERE w.profile_id = pr.id
                    AND w.revoked_at IS NULL
                    AND w.purpose IN ('login', 'both')
               )                                       AS has_passkey
          FROM (SELECT 1) seed
          LEFT JOIN matched m  ON true
          LEFT JOIN prof    pr ON true
         LIMIT 1
      `;

      const found = firstRow(rows as unknown as LookupRow[]) ?? {
        employee_id: null,
        profile_id: null,
        first_name: null,
        display_name: null,
        full_name: null,
        email: null,
        employment_status: null,
        profile_active: null,
        has_logged_in: null,
        has_passkey: null,
      };

      // ── STEP 10 · Audit, same transaction ───────────────────────────────────
      // `read_sensitive` is the honest action: an unauthenticated caller was told
      // a first name and a masked address. The PRD's event names
      // (`auth.identify.succeeded` / `.failed`) travel in `entity_label`, because
      // `public.audit_action` has no `identify` member and inventing one would be
      // a migration this function is not allowed to write.
      //
      // The attempted identifier is stored HASHED. `is_redacted = true` says so.
      const exists = found.employee_id !== null || found.profile_id !== null;
      await writeAudit(tx, ctx, {
        action: "read_sensitive",
        entityTable: "public.employees",
        entityId: found.employee_id,
        entityLabel: exists ? "auth.identify.succeeded" : "auth.identify.failed",
        subjectEmployeeId: found.employee_id,
        fieldName: "identifier_sha256",
        newValue: {
          outcome: exists ? "found" : "not_found",
          identifier_sha256: identifierHash,
          identifier_kind: classified.email !== null
            ? "email"
            : classified.code !== null
            ? "employee_code"
            : "unparsed",
          portal_state: exists ? derivePortalState(found) : null,
        },
        isRedacted: true,
      });

      return found;
    });

    const exists = row.employee_id !== null || row.profile_id !== null;
    const portalState = exists ? derivePortalState(row) : null;

    // Response allowlist — PRD §10.3 "returns only". Five facts. Adding a field
    // here is a pre-auth disclosure decision, not a convenience.
    const responseBody = {
      found: exists,
      displayNameFirstOnly: exists ? firstNameOnly(row) : null,
      // `portal_state = 'none'` has no login and, usually, no address at all.
      maskedEmail: exists && portalState !== "none" ? maskEmail(row.email) : null,
      hasPasskey: exists && row.has_passkey === true,
      portalState,
      requestId,
    };
    status = 200;

    // ── STEP 11 · Store under the idempotency key ─────────────────────────────
    // Not applicable — see step 8.

    log.info("identifier resolved", {
      found: exists,
      portal_state: portalState,
      has_passkey: responseBody.hasPasskey,
      // The identifier itself is never logged; its hash is the join key.
      identifier_sha256: identifierHash.slice(0, 16),
    });

    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;
    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── Constant time, every path ────────────────────────────────────────────
    // In an async function an `await` in `finally` delays the returned response,
    // which is exactly what is wanted: hit, miss, 422 and 429 all leave after
    // ~400 ms, so the timing of the answer carries no information about whether
    // the identifier exists. A request that genuinely took longer than the budget
    // is not slowed further — it is already indistinguishable.
    await padToConstantTime(startedMs);

    // ── STEP 12 · One structured log line per invocation ─────────────────────
    log.finish(status, { constant_time_ms: CONSTANT_TIME_MS });
  }
});

/** Exported for `supabase/tests` — the same schema the handler enforces. */
export { IdentifyBody };
