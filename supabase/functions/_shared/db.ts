/**
 * _shared/db.ts — database access and request context.
 *
 * THREE transports, each with a job. Picking the wrong one is the most likely
 * way to break a trust boundary, so the reasoning is written down here.
 *
 * 1. `serviceClient()` — supabase-js with the service-role key. PostgREST +
 *    Storage + Auth admin, `public` schema only. Bypasses RLS. Use for Storage
 *    signing, `auth.admin.*`, and ordinary `public` reads/writes where a
 *    transaction is not needed.
 *
 * 2. `asCaller(jwt)` — supabase-js carrying the END USER's JWT, so RLS applies
 *    exactly as it would from the browser. This is the correct client for
 *    anything on behalf of a user that should be scope-limited (spec-architecture
 *    §6 threat T-15: AI tools run as the caller, under RLS).
 *
 * 3. `sql` — postgres.js, a real connection. REQUIRED, not a convenience:
 *      a) `config.toml` exposes only `["public","graphql_public"]`. `app.*`,
 *         `secure.*`, `audit.*` and `util.*` are unreachable over PostgREST by
 *         design (boundary B6). `app.rate_limit_take`, `app.secret`,
 *         `audit.write_row`, `secure.kiosk_device_secrets` and
 *         `secure.kiosk_nonces` therefore have no `.rpc()`/`.from()` path.
 *      b) `set_config('app.*', …, true)` is TRANSACTION-scoped. PostgREST runs
 *         every call in its own transaction, so context set by one HTTP call is
 *         gone before the next one's write. Lifecycle step 9 — "app.set_context
 *         + one txn" — is only physically possible inside `BEGIN…COMMIT`, which
 *         is what `withContext()` gives you.
 *
 * `SUPABASE_DB_URL` is injected by the Supabase Edge runtime alongside
 * `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; it is not a new secret to
 * provision, and it is never logged (log.ts redacts it).
 */

import { createClient, postgresFactory, type Sql, type SupabaseClient } from "./deps.ts";
import { serverError } from "./errors.ts";

// ── Environment ─────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") {
    // The name of a missing variable is safe to state; its value never is.
    throw serverError("env", `Server misconfigured: ${name} is not set.`, { code: "ENV_MISSING" });
  }
  return value;
}

// ── 1. Service-role supabase-js client (singleton) ──────────────────────────

let serviceSingleton: SupabaseClient | null = null;

/**
 * Service-role PostgREST/Storage/Auth client. Bypasses RLS — spec-architecture
 * §6: "only inside Edge Fns, only after lifecycle step 4, always after
 * app.set_context()".
 */
export function serviceClient(): SupabaseClient {
  if (serviceSingleton === null) {
    serviceSingleton = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { "x-tt-edge": "service" } },
      },
    );
  }
  return serviceSingleton;
}

/**
 * A client that acts AS the caller: RLS, column grants and allowlist views all
 * apply. Not cached — the JWT differs per request.
 */
export function asCaller(jwt: string): SupabaseClient {
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  return createClient(requireEnv("SUPABASE_URL"), anonKey ?? jwt, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${jwt}`, "x-tt-edge": "caller" } },
  });
}

// ── 3. Direct Postgres ──────────────────────────────────────────────────────

let sqlSingleton: Sql | null = null;

/**
 * The pooled postgres.js handle for this isolate. Small pool on purpose: an edge
 * isolate handles a handful of concurrent requests, and Postgres connections are
 * the scarce resource.
 */
export function sql(): Sql {
  if (sqlSingleton === null) {
    sqlSingleton = postgresFactory(requireEnv("SUPABASE_DB_URL"), {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
      // Safe under both the direct connection and the transaction pooler.
      prepare: false,
      onnotice: () => {},
    });
  }
  return sqlSingleton;
}

/** Close the pool. Tests and one-shot scripts only; never inside a request. */
export async function closeSql(): Promise<void> {
  if (sqlSingleton !== null) {
    await sqlSingleton.end({ timeout: 5 });
    sqlSingleton = null;
  }
}

// ── Request context (migrations 005/006) ────────────────────────────────────

/**
 * `public.actor_source` (migration 003). `app.source` is cast to this enum by
 * `audit.log_changes()`, so an unknown value raises inside the trigger — it is
 * validated here instead.
 */
export const ACTOR_SOURCES = [
  "web_employee",
  "web_manager",
  "web_admin",
  "kiosk",
  "edge_function",
  "cron",
  "import",
  "ai_agent",
  "service_role",
  "migration",
] as const;
export type ActorSource = typeof ACTOR_SOURCES[number];

/** `public.app_role` (migration 003). */
export const APP_ROLES = ["employee", "manager", "admin", "super_admin"] as const;
export type AppRole = typeof APP_ROLES[number];

/**
 * Transaction-scoped guard flags. Each corresponds to a trigger that refuses the
 * write unless the flag is `'on'`:
 *   allow_punch_void        `trg_attendance_punches__append_only` (016)
 *   override_lock           `trg_attendance_days__lock_guard` (017)
 *   allow_locked_recompute  payroll recompute inside a locked period (023)
 */
export interface ContextFlags {
  allow_punch_void?: boolean;
  override_lock?: boolean;
  allow_locked_recompute?: boolean;
}

/**
 * Everything the audit engine and RLS helpers read out of the session.
 * `requestId` must be a UUID and `ip` a valid inet: `audit.log_changes()` casts
 * both (`::uuid`, `::inet`) and a bad value aborts the transaction.
 */
export interface RequestContext {
  /** `profiles.id` of the human. NULL for kiosk/cron — those are not people. */
  actorId?: string | null;
  /** Snapshot of the caller's highest role. Informational; the audit engine re-derives it. */
  actorRole?: AppRole | null;
  source: ActorSource;
  /** Function name or route that caused the write, e.g. `kiosk-heartbeat`. Lands in `audit_log.source`. */
  sourceRoute?: string;
  /** UUID. The join key between the response, the logs and every audit row. */
  requestId: string;
  ip?: string | null;
  ua?: string | null;
  deviceId?: string | null;
  /** Mandatory for writes to `audit.reason_required_tables`; ≥10 characters. */
  reason?: string | null;
  onBehalfOf?: string | null;
  impersonatedBy?: string | null;
  approvalRequestId?: string | null;
  flags?: ContextFlags;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrEmpty(value: string | null | undefined): string {
  return typeof value === "string" && UUID_RE.test(value) ? value : "";
}

/** Bare-minimum inet sanity check — enough to keep `::inet` from aborting a txn. */
function inetOrEmpty(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (v.length === 0 || v.length > 45) return "";
  return /^[0-9a-fA-F:.]+$/.test(v) ? v : "";
}

/**
 * The `set_config` batch from the migration 005/006 comments, in ONE round-trip.
 *
 * `is_local = true` makes every setting transaction-scoped, which is what stops
 * one request's actor leaking into the next on a pooled connection — and also
 * means this call is pointless outside a transaction. Use `withContext()`.
 *
 * Keys, and who reads them:
 *   app.actor_id            `app.ctx_actor_id()` → every RLS helper, `util.stamp_row`
 *   app.actor_role          snapshot for downstream helpers
 *   app.source              `audit.log_changes` → `audit_log.actor_source` (cast to enum)
 *   app.source_route        `audit.write_row`   → `audit_log.source`
 *   app.request_id          `audit_log.request_id` (cast to uuid)
 *   app.reason              `app.has_reason()`, the mandatory-reason gate
 *   app.ip / app.user_agent / app.device_id     forensic columns
 *   app.on_behalf_of / app.impersonated_by / app.approval_request_id
 *   app.allow_punch_void / app.override_lock / app.allow_locked_recompute
 */
export async function setContext(client: Sql, ctx: RequestContext): Promise<void> {
  if (!UUID_RE.test(ctx.requestId)) {
    throw serverError("ctx", "Server misconfigured: request id must be a UUID.", {
      code: "BAD_REQUEST_CONTEXT",
    });
  }
  if (!ACTOR_SOURCES.includes(ctx.source)) {
    throw serverError("ctx", `Server misconfigured: unknown actor source ${ctx.source}.`, {
      code: "BAD_REQUEST_CONTEXT",
    });
  }

  const pairs: [string, string][] = [
    ["app.actor_id", uuidOrEmpty(ctx.actorId)],
    ["app.actor_role", ctx.actorRole ?? ""],
    ["app.source", ctx.source],
    ["app.source_route", ctx.sourceRoute ?? ""],
    ["app.request_id", ctx.requestId],
    ["app.reason", (ctx.reason ?? "").trim()],
    ["app.ip", inetOrEmpty(ctx.ip)],
    ["app.user_agent", (ctx.ua ?? "").slice(0, 500)],
    ["app.device_id", (ctx.deviceId ?? "").slice(0, 200)],
    ["app.on_behalf_of", uuidOrEmpty(ctx.onBehalfOf)],
    ["app.impersonated_by", uuidOrEmpty(ctx.impersonatedBy)],
    ["app.approval_request_id", uuidOrEmpty(ctx.approvalRequestId)],
    ["app.allow_punch_void", ctx.flags?.allow_punch_void === true ? "on" : ""],
    ["app.override_lock", ctx.flags?.override_lock === true ? "on" : ""],
    ["app.allow_locked_recompute", ctx.flags?.allow_locked_recompute === true ? "on" : ""],
  ];

  const selects = pairs
    .map((_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`)
    .join(", ");
  await client.unsafe(`SELECT ${selects}`, pairs.flat());
}

/**
 * Lifecycle step 9 + 10: ONE transaction that begins with the context batch and
 * ends with the caller's writes and their audit rows. Nothing that mutates
 * business data should run outside this.
 *
 * ```ts
 * const punch = await withContext(ctx, async (tx) => {
 *   const [row] = await tx`INSERT INTO public.attendance_punches (…) VALUES (…) RETURNING id`;
 *   await writeAudit(tx, ctx, { action: "insert", entityTable: "public.attendance_punches", entityId: row.id });
 *   return row;
 * });
 * ```
 */
export async function withContext<T>(
  ctx: RequestContext,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  const client = sql();
  // `tx` is postgres.js's `TransactionSql`. Annotated `unknown` and narrowed so
  // this file typechecks identically under Deno and under a bare `tsc` that
  // cannot resolve the `npm:` specifier.
  return await client.begin(async (tx: unknown) => {
    await setContext(tx as Sql, ctx);
    return await fn(tx as Sql);
  }) as T;
}

// ── Context construction from the request ───────────────────────────────────

/**
 * Lifecycle step 3. A client-supplied `x-request-id` is honoured only when it is
 * a UUID — the value reaches a `::uuid` cast in the audit engine, so an
 * arbitrary string would abort the write.
 */
export function requestIdFrom(req: Request): string {
  const supplied = req.headers.get("x-request-id");
  return supplied !== null && UUID_RE.test(supplied) ? supplied : crypto.randomUUID();
}

/** First hop of `x-forwarded-for`, which on Supabase Edge is the real client. */
export function clientIpFrom(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff !== null) {
    const first = xff.split(",")[0]?.trim() ?? "";
    const ip = inetOrEmpty(first);
    if (ip !== "") return ip;
  }
  const real = inetOrEmpty(req.headers.get("x-real-ip"));
  return real === "" ? null : real;
}

export function userAgentFrom(req: Request): string | null {
  return req.headers.get("user-agent");
}

/** Rows from a `SELECT` that must return exactly one row, or `null`. */
export function firstRow<T>(rows: readonly T[]): T | null {
  return rows.length > 0 ? (rows[0] as T) : null;
}
