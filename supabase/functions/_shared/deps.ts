/**
 * _shared/deps.ts — THE ONLY FILE IN supabase/functions/** WITH A REMOTE IMPORT.
 *
 * spec-architecture §3/§4: every edge function imports third-party code through
 * this file and nothing else. Versions are pinned to an exact release (never a
 * range, never `latest`) so a redeploy months from now resolves byte-identically.
 * CI rule: `grep -rE "from \"(npm|jsr|https)" supabase/functions --include=*.ts`
 * must return this file only.
 *
 * Heavy, single-consumer SDKs (@simplewebauthn/server, @anthropic-ai/sdk) are
 * behind lazy loaders: the URL still lives here, but the module is only fetched
 * by the function that actually needs it, so kiosk cold starts stay small.
 */

// ── Supabase client (PostgREST / Storage / Auth admin) ───────────────────────
export {
  createClient,
  type SupabaseClient,
  type User,
} from "npm:@supabase/supabase-js@2.45.4";

// ── Validation (the only runtime dep shared with @tt/shared) ─────────────────
export { z, ZodError } from "npm:zod@3.23.8";
export type { ZodIssue, ZodType, ZodTypeAny } from "npm:zod@3.23.8";

// ── Direct Postgres (postgres.js) ────────────────────────────────────────────
// Required, not optional. Three things are impossible over PostgREST and are
// therefore done through this driver (see _shared/db.ts for the full argument):
//   1. `secure.*` and `app.*` are NOT in config.toml `db.schemas` — trust
//      boundary B6 — so kiosk device secrets, nonces and app.rate_limit_take()
//      are unreachable via .rpc()/.from().
//   2. `set_config('app.*', …, true)` is transaction-scoped; PostgREST gives
//      every call its own transaction, so context set in one call cannot be
//      read by the write in the next. Lifecycle step 9 ("set_context + ONE
//      txn") only exists with a real BEGIN…COMMIT.
//   3. audit.write_row() is SECURITY DEFINER in an unexposed schema.
import postgresFactory from "npm:postgres@3.4.5";
export { postgresFactory };
/** postgres.js connection handle. A `TransactionSql` is assignable to this. */
export type Sql = ReturnType<typeof postgresFactory>;

// ── Lazy, single-consumer SDKs ───────────────────────────────────────────────

/** WebAuthn attestation/assertion verification — `webauthn-register`, `webauthn-login`, `kiosk-punch` (K7). */
export function loadWebAuthn(): Promise<typeof import("npm:@simplewebauthn/server@11.0.0")> {
  return import("npm:@simplewebauthn/server@11.0.0");
}

/**
 * Argon2id — `kiosk-device-activate`, `kiosk-operator-auth`, `face-enrol`
 * (admin-PIN path) and any future secret-at-rest verifier.
 *
 * Why a WASM implementation and not the database: `secure.kiosk_device_secrets.
 * secret_hash` and `secure.kiosk_operator_secrets.pin_hash` are specified as
 * Argon2id (migration 012, spec-architecture §5), and Postgres cannot produce
 * one — `pgcrypto.crypt()` offers only bf/md5/xdes/des, and `pgsodium` is not
 * among the extensions migration 001 enables. `hash-wasm` embeds its WASM as
 * base64 inside the module, so there is no runtime fetch: it works under the
 * edge runtime's network policy and offline in CI.
 *
 * Lazy, like the other single-consumer SDKs: an unrelated function must not pay
 * for ~40 KB of WASM at cold start.
 */
export function loadArgon2(): Promise<typeof import("npm:hash-wasm@4.11.0")> {
  return import("npm:hash-wasm@4.11.0");
}

/**
 * Anthropic SDK — `ai-agent`, `cron-ai-digest` only. Model id lives in the
 * caller, not here.
 *
 * PIN BUMPED 0.27.3 → 0.115.0 (verified against the npm registry, 2026-07-26).
 * 0.27.3 predates every parameter the AI agent contract requires and would 400
 * or drop them silently: `thinking: {type:"adaptive"}`,
 * `output_config: {effort, format}` (structured outputs), `client.beta.messages`
 * with `betas` + `fallbacks: "default"` (`server-side-fallback-2026-07-01`), and
 * `stop_details` on a `refusal` stop reason. All four are typed in 0.115.0.
 */
export async function loadAnthropic() {
  const mod = await import("npm:@anthropic-ai/sdk@0.115.0");
  return mod.default;
}

/**
 * PDF writer — `document-generate`, `esign-flow`, `payslip-publish`.
 *
 * pdf-lib is pure JavaScript with no native addon and, critically, no network
 * access: the 14 standard PDF fonts are metric-only (no font file to fetch), so
 * a render inside an edge isolate never leaves the process. `fontkit` is NOT
 * loaded — that means WinAnsi/Latin-1 text only, which the callers enforce up
 * front rather than letting pdf-lib throw mid-page.
 */
export function loadPdfLib(): Promise<typeof import("npm:pdf-lib@1.17.1")> {
  return import("npm:pdf-lib@1.17.1");
}
