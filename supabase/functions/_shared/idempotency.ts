/**
 * _shared/idempotency.ts — lifecycle steps 8 and 11, over
 * `public.idempotency_keys` (migration 031).
 *
 * The contract with the client (frontend-contract §5): generate the key ONCE at
 * form mount / at enqueue time on the kiosk, reuse it across every retry, and
 * treat a replay as success. The server then guarantees:
 *
 *   same key + same body   → the ORIGINAL response, nothing written twice
 *   same key + other body  → 409, because that is a client bug, not a retry
 *   key in flight          → 409, so two tabs cannot both write
 *   key past its 24h TTL   → treated as fresh (the DB sweep also deletes it)
 *
 * A 5xx is never stored: the operation may or may not have happened, so the
 * claim is RELEASED and the retry is allowed to try again for real.
 */

import type { Sql } from "./deps.ts";
import { firstRow, sql as sqlHandle } from "./db.ts";
import { conflict, PROBLEM_CONTENT_TYPE, unprocessable } from "./errors.ts";
import { sha256Hex } from "./auth.ts";

/** How long a claim may sit un-completed before another request may take it over. */
export const LOCK_STALE_SECONDS = 60;

export type ClaimResult =
  | { state: "claimed" }
  | { state: "replay"; status: number; body: unknown };

/** Read `x-idempotency-key`. */
export function idempotencyKeyFrom(req: Request): string | null {
  const value = (req.headers.get("x-idempotency-key") ?? "").trim();
  return value === "" ? null : value.slice(0, 200);
}

/** Read `x-idempotency-key` or reject with 422 — for mutations that require one. */
export function requireIdempotencyKey(req: Request): string {
  const key = idempotencyKeyFrom(req);
  if (key === null || key.length < 16) {
    throw unprocessable(
      [{
        pointer: "/headers/x-idempotency-key",
        code: "required",
        detail: "Send an x-idempotency-key header of at least 16 characters, stable across retries.",
      }],
      "This endpoint requires an idempotency key.",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  return key;
}

/**
 * Fingerprint of the request the key was claimed for. Includes the function name
 * and the actor so one client's key cannot be aimed at another endpoint or
 * replayed under a different identity.
 */
export function requestHash(fnName: string, rawBody: string, actorKey: string | null = null): Promise<string> {
  return sha256Hex(`${fnName}\n${actorKey ?? "anon"}\n${rawBody}`);
}

interface KeyRow {
  request_hash: string;
  fn_name: string;
  status_code: number | null;
  response: unknown;
  /** postgres.js hydrates `timestamptz` to a `Date`. */
  completed_at: Date | string | null;
  expired: boolean;
  lock_stale: boolean;
}

/**
 * Lifecycle step 8. One round-trip on the happy path (the insert either wins the
 * race or it does not); the extra reads only happen on an actual collision.
 *
 * Runs on the pool, NOT inside the business transaction: the claim must survive
 * a rollback of the work, otherwise a failed attempt frees the key for a
 * concurrent duplicate.
 */
export async function claim(
  input: { key: string; fnName: string; requestHash: string; actorId?: string | null },
  client: Sql = sqlHandle(),
  attempt = 0,
): Promise<ClaimResult> {
  const inserted = await client`
    INSERT INTO public.idempotency_keys (key, request_hash, fn_name, actor_id)
    VALUES (
      ${input.key},
      ${input.requestHash},
      ${input.fnName},
      ${input.actorId ?? null}::uuid
    )
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `;
  if ((inserted as unknown as unknown[]).length > 0) return { state: "claimed" };

  const rows = await client`
    SELECT k.request_hash,
           k.fn_name,
           k.status_code,
           k.response,
           k.completed_at,
           (k.expires_at < now())                                            AS expired,
           (k.locked_at < now() - make_interval(secs => ${LOCK_STALE_SECONDS}::double precision)) AS lock_stale
      FROM public.idempotency_keys k
     WHERE k.key = ${input.key}
     LIMIT 1
  `;
  const row = firstRow(rows as unknown as KeyRow[]);
  if (row === null) {
    // Swept between the two statements — the key is free again. Bounded retry:
    // a loop here would mean the sweep and the insert are fighting, which is a
    // 409 the client should see rather than a hung request.
    if (attempt >= 2) {
      throw conflict("Could not claim this idempotency key. Retry with a new key.", "IDEMPOTENCY_CLAIM_FAILED");
    }
    return await claim(input, client, attempt + 1);
  }

  if (row.expired) {
    await client`
      UPDATE public.idempotency_keys
         SET request_hash = ${input.requestHash},
             fn_name      = ${input.fnName},
             actor_id     = ${input.actorId ?? null}::uuid,
             status_code  = NULL,
             response     = NULL,
             locked_at    = now(),
             completed_at = NULL,
             expires_at   = now() + interval '24 hours'
       WHERE key = ${input.key}
    `;
    return { state: "claimed" };
  }

  if (row.request_hash !== input.requestHash || row.fn_name !== input.fnName) {
    throw conflict(
      "This idempotency key was already used for a different request. Use a new key.",
      "IDEMPOTENCY_KEY_REUSED",
    );
  }

  if (row.completed_at !== null) {
    return { state: "replay", status: row.status_code ?? 200, body: row.response };
  }

  if (row.lock_stale) {
    // The previous attempt died without completing or releasing. Take it over.
    await client`
      UPDATE public.idempotency_keys
         SET locked_at = now(), completed_at = NULL
       WHERE key = ${input.key}
    `;
    return { state: "claimed" };
  }

  throw conflict(
    "An identical request is still being processed. Retry shortly.",
    "REQUEST_IN_PROGRESS",
  );
}

/**
 * Lifecycle step 11. Store the response so a retry replays it.
 * Only for statuses < 500 — see `release` for the 5xx path.
 */
export async function store(
  key: string,
  status: number,
  body: unknown,
  client: Sql = sqlHandle(),
): Promise<void> {
  if (status >= 500) {
    await release(key, client);
    return;
  }
  await client`
    UPDATE public.idempotency_keys
       SET status_code  = ${status}::integer,
           response     = ${JSON.stringify(body ?? null)}::jsonb,
           completed_at = now()
     WHERE key = ${key}
  `;
}

/**
 * Drop the claim so the client's retry is processed for real. Use on 5xx and on
 * an unexpected throw — never on a 4xx, which is a deterministic answer worth
 * replaying.
 */
export async function release(key: string, client: Sql = sqlHandle()): Promise<void> {
  await client`DELETE FROM public.idempotency_keys WHERE key = ${key} AND completed_at IS NULL`;
}

/**
 * Turn a stored response into the HTTP response. Marks the replay both in a
 * header and (for JSON objects) as `replayed: true`, which is what the kiosk
 * queue checks before deleting its local item (spec-kiosk §8.1).
 *
 * The content type follows the STATUS, not the transport. Every caller stores
 * `problem.problem` for a 4xx (see the `catch` in each function), so a replayed
 * refusal carries an RFC 9457 body and must be labelled
 * `application/problem+json` — exactly as the first attempt was. Labelling it
 * `application/json` made the same refusal arrive under two different media types
 * depending on whether it was the original or the retry, which is the one thing a
 * single error envelope exists to prevent. `replayed: true` stays: RFC 9457
 * permits extension members, and the kiosk queue contract depends on it.
 */
export function replayResponse(
  replay: { status: number; body: unknown },
  headers: Record<string, string> = {},
): Response {
  const body = replay.body !== null && typeof replay.body === "object" && !Array.isArray(replay.body)
    ? { ...(replay.body as Record<string, unknown>), replayed: true }
    : replay.body;
  const contentType = replay.status >= 400
    ? PROBLEM_CONTENT_TYPE
    : "application/json; charset=utf-8";
  return new Response(JSON.stringify(body ?? null), {
    status: replay.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-idempotent-replay": "true",
      ...headers,
    },
  });
}
