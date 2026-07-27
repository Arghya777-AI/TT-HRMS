/**
 * _shared/cors.ts — explicit origin allowlist. NEVER `*`.
 *
 * spec-architecture §4: "`cors.ts` (explicit allowlist, never `*`, preflight
 * 600s)". Three origins exist and no more:
 *   - https://hr.thetamarindtree.in     the app (Vercel, prod branch `main`)
 *   - https://kiosk.thetamarindtree.in  the kiosk host (same bundle, own CSP + camera policy)
 *   - http://localhost:5173             Vite dev
 *
 * Vercel PREVIEW deployments are deliberately absent: a wildcard
 * `*.vercel.app` would let any Vercel tenant's page drive these functions with a
 * user's cookies. Previews point at a Supabase branch project with its own
 * function deployment and its own allowlist (§9 environments).
 *
 * A request with NO `Origin` header is not a browser request (kiosk native
 * wrapper, pg_net cron, curl, server-to-server) — CORS does not apply and none
 * of these headers are emitted. Authorisation is still enforced by `auth.ts`;
 * CORS is not an authorisation mechanism.
 */

import { forbidden } from "./errors.ts";

export const ALLOWED_ORIGINS: readonly string[] = [
  "https://hr.thetamarindtree.in",
  "https://kiosk.thetamarindtree.in",
  "http://localhost:5173",
] as const;

/** Preflight cache: 600s, the maximum Chrome honours. */
export const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Every header a client of these 27 functions may send. Kept explicit so a new
 * header is a reviewed decision.
 *   authorization/apikey            Supabase user JWT + anon key
 *   x-client-info                   supabase-js version tag
 *   x-request-id                    client-supplied correlation id (UUID, else replaced)
 *   x-reason                        justification for reason-required writes (audit engine)
 *   x-idempotency-key               lifecycle step 8
 *   x-device-id/x-signature/
 *   x-timestamp/x-nonce             kiosk device HMAC (auth model D)
 *   x-operator-session              open guard session token (auth model D+O)
 *   x-app-version                   kiosk build, for min-version gating
 */
export const ALLOWED_REQUEST_HEADERS: readonly string[] = [
  "authorization",
  "apikey",
  "content-type",
  "accept",
  "x-client-info",
  "x-request-id",
  "x-reason",
  "x-idempotency-key",
  "x-device-id",
  "x-signature",
  "x-timestamp",
  "x-nonce",
  "x-operator-session",
  "x-app-version",
] as const;

/**
 * Response headers the browser is allowed to read.
 *
 * `x-idempotent-replay` is here because `_shared/idempotency.ts` documents it as
 * a client-facing signal (spec-kiosk §8.1: the kiosk queue checks it before
 * deleting its local item). The kiosk PWA on https://kiosk.thetamarindtree.in is
 * a browser and sends `Origin`, so without this entry `replayResponse()`'s header
 * is invisible to exactly the client that needs it — and the `replayed: true`
 * body field would be the only signal, which is not what the contract says.
 */
export const EXPOSED_RESPONSE_HEADERS: readonly string[] = [
  "x-request-id",
  "retry-after",
  "content-type",
  "x-idempotent-replay",
] as const;

/**
 * Any loopback origin, on ANY port: `http://localhost:5174`, `http://127.0.0.1:3000`.
 *
 * The fixed list below names `http://localhost:5173` only, which is Vite's default
 * — but Vite silently increments to 5174 when 5173 is taken, and then EVERY edge
 * function answers 403 CORS_ORIGIN_NOT_ALLOWED while PostgREST keeps working. The
 * failure surfaces as "saving doesn't work" with no clue attached, and it cost a
 * real debugging session.
 *
 * This is not a weakening of the production posture: a loopback origin can only be
 * produced by a browser on the developer's own machine, it cannot be reached from
 * the internet, and authorisation is still enforced by auth.ts on every call —
 * `assertOriginAllowed` was never the authorisation boundary (see this file's
 * header). Production origins remain exact-match.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string | null): boolean {
  if (origin === null) return false;
  return ALLOWED_ORIGINS.includes(origin) || isLoopbackOrigin(origin);
}

/**
 * CORS headers for this request. Empty object when there is no `Origin`
 * (non-browser caller) or the origin is not allowlisted — the response then
 * carries no `Access-Control-Allow-Origin` and the browser blocks it.
 *
 * `Vary: Origin` is mandatory: without it a CDN can cache the allow header from
 * one origin and serve it to another.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin as string,
    "access-control-allow-credentials": "true",
    "access-control-expose-headers": EXPOSED_RESPONSE_HEADERS.join(", "),
    vary: "Origin",
  };
}

/**
 * Lifecycle step 1. Returns the 204 preflight response for an OPTIONS request,
 * or `null` when this is not a preflight and the handler should continue.
 *
 * A preflight from an unknown origin gets an explicit 403 problem+json rather
 * than a silent 204: the browser blocks either way, but the developer sees why.
 */
export function handlePreflight(req: Request, allowedMethods: readonly string[] = ["POST", "OPTIONS"]): Response | null {
  if (req.method !== "OPTIONS") return null;
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return forbidden(
      "This origin is not on the allowlist for Tamarind Tree HRMS functions.",
      "CORS_ORIGIN_NOT_ALLOWED",
    ).toResponse({ vary: "Origin" });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(req),
      "access-control-allow-methods": allowedMethods.join(", "),
      "access-control-allow-headers": ALLOWED_REQUEST_HEADERS.join(", "),
      "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
    },
  });
}

/**
 * Reject a non-preflight browser request from an unlisted origin before any work
 * is done. Throws `HttpProblem`. No-op when `Origin` is absent.
 */
export function assertOriginAllowed(req: Request): void {
  const origin = req.headers.get("origin");
  if (origin !== null && !isAllowedOrigin(origin)) {
    throw forbidden(
      "This origin is not on the allowlist for Tamarind Tree HRMS functions.",
      "CORS_ORIGIN_NOT_ALLOWED",
    );
  }
}
