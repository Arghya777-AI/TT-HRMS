/**
 * _shared/ratelimit.ts — lifecycle step 6. Token bucket in Postgres
 * (`app.rate_limit_take`, migration 031) so every edge isolate, every region and
 * every retry share one counter. An in-memory limiter in a Deno isolate counts
 * nothing useful: isolates are created and destroyed per burst.
 *
 * `app.rate_limit_take(bucket, key, capacity, refill_per_minute) → boolean`
 * refills lazily from `refilled_at`, takes one token, returns false when empty.
 * It lives in the `app` schema, which is not exposed to PostgREST, so it is
 * reached through the direct connection — see `db.ts`.
 *
 * Deliberately OUTSIDE the business transaction: a throttled or failed request
 * must still have consumed its token, otherwise the limit is free to bypass by
 * making requests that fail.
 */

import type { Sql } from "./deps.ts";
import { sql as sqlHandle } from "./db.ts";
import { tooMany } from "./errors.ts";

export interface RateLimitSpec {
  /** Bucket name, part of the PK in `app.rate_limit_buckets`. */
  bucket: string;
  /** Burst size. */
  capacity: number;
  /** Sustained rate. `capacity/refillPerMinute` is the time to refill from empty. */
  refillPerMinute: number;
}

/**
 * The documented limits, in one place. Values from spec-kiosk §8.1 ("Rate
 * limits") and spec-architecture §4/§5; anything not written down there is a
 * conservative default, not an invention to be trusted blindly.
 */
export const RATE_LIMITS = {
  /** kiosk.rate_scans_per_minute = 40, per device. */
  kioskPunch: { bucket: "kiosk_punch", capacity: 40, refillPerMinute: 40 },
  /**
   * REPLAY of an offline queue, per device — deliberately far above the live scan rate.
   *
   * The live bucket is 40/minute, and every item of a batch takes a token from it. That made
   * draining an outage take minutes: 200 held punches could not clear in under five, however
   * they were batched, and a 25-item batch sent against an empty bucket was refused whole so
   * the queue made no progress at all.
   *
   * A replay is not the thing 40/minute exists to limit. It is bounded by a queue the device
   * already holds, every item is idempotent on its `clientEventId`, and the punches were
   * captured at human pace — the burst is an artefact of the network returning, not of anybody
   * scanning faster. What the live limit protects is a device being used to hammer the 1:N
   * search, and that is still bounded here: 200/minute, five times the live rate and no more,
   * so a full day's queue clears in a couple of minutes while the search stays capped.
   */
  kioskReplay: { bucket: "kiosk_replay", capacity: 200, refillPerMinute: 200 },
  /** Heartbeat interval is 60s (kiosk.heartbeat_interval_seconds); allow retries and a burst on reconnect. */
  kioskHeartbeat: { bucket: "kiosk_heartbeat", capacity: 30, refillPerMinute: 30 },
  /** Pairing: 10/hour/IP (spec-kiosk §5.1). */
  kioskPair: { bucket: "kiosk_pair", capacity: 10, refillPerMinute: 10 / 60 },
  /** kiosk.max_pin_attempts = 5 per 15 min, per operator. */
  kioskOperatorAuth: { bucket: "kiosk_operator_auth", capacity: 5, refillPerMinute: 5 / 15 },
  /** Pre-auth surfaces keyed by IP. */
  authPreLogin: { bucket: "auth_pre_login", capacity: 20, refillPerMinute: 20 },
  webauthn: { bucket: "webauthn", capacity: 10, refillPerMinute: 10 },
  /** Ordinary authenticated mutation, per actor. */
  mutation: { bucket: "mutation", capacity: 60, refillPerMinute: 60 },
  /** AI questions per user — protects the monthly ₹ budget as well as the API. */
  aiAsk: { bucket: "ai_ask", capacity: 12, refillPerMinute: 12 },
  /** Exports and reveals are audited and rare by design. */
  export: { bucket: "export", capacity: 5, refillPerMinute: 5 },
  reveal: { bucket: "reveal", capacity: 20, refillPerMinute: 20 },
  /** Long-running admin jobs: payroll run, recompute, import. */
  heavyJob: { bucket: "heavy_job", capacity: 4, refillPerMinute: 2 },
  /**
   * Reverse geocoding a punch coordinate, PER USER. A punch-log page holds ~50
   * rows but only a handful of DISTINCT places (one gate, one office), and every
   * repeat is a cache hit that never reaches this bucket, so 30 is generous for a
   * human paging through the log and low enough that one admin cannot drain the
   * provider quota for everybody.
   */
  reverseGeocode: { bucket: "reverse_geocode", capacity: 30, refillPerMinute: 30 },
  /**
   * The OpenStreetMap Nominatim usage policy's hard ceiling: ONE request per
   * second for the whole deployment — not per user, not per isolate.
   *
   * `capacity: 1` with `refillPerMinute: 60` is exactly that: one token, refilled
   * one per second, with NO burst allowance. Because the bucket lives in Postgres
   * (`app.rate_limit_buckets`), every edge isolate in every region shares the one
   * counter, which is the only way this limit can be true — an in-process limiter
   * would permit one request per second PER ISOLATE.
   *
   * Keyed on the provider name, never on the caller: the policy is about our
   * traffic to them.
   */
  nominatim: { bucket: "nominatim", capacity: 1, refillPerMinute: 60 },
} as const satisfies Record<string, RateLimitSpec>;

/** Build a bucket key. `null`/`undefined` parts collapse to `anon` so a key is never empty. */
export function limitKey(...parts: (string | null | undefined)[]): string {
  const joined = parts.map((p) => (p === null || p === undefined || p === "" ? "anon" : p)).join(":");
  return joined.slice(0, 200);
}

/** Milliseconds until one token is available again. */
function retryAfterMs(spec: RateLimitSpec): number {
  if (spec.refillPerMinute <= 0) return 60_000;
  return Math.max(250, Math.ceil(60_000 / spec.refillPerMinute));
}

/** Take a token. `true` when allowed, `false` when throttled. Never throws on throttle. */
export async function tryTake(
  spec: RateLimitSpec,
  key: string,
  client: Sql = sqlHandle(),
): Promise<boolean> {
  const rows = await client`
    SELECT app.rate_limit_take(
             ${spec.bucket},
             ${key},
             ${spec.capacity}::integer,
             ${spec.refillPerMinute}::numeric
           ) AS allowed
  `;
  const row = (rows as unknown as { allowed: boolean }[])[0];
  return row?.allowed === true;
}

/**
 * Lifecycle step 6. Throws 429 with `Retry-After` when the bucket is empty.
 *
 * ```ts
 * await enforce(RATE_LIMITS.kioskHeartbeat, limitKey(device.id), "KIOSK_RATE_LIMITED");
 * ```
 */
export async function enforce(
  spec: RateLimitSpec,
  key: string,
  code = "RATE_LIMITED",
  client: Sql = sqlHandle(),
): Promise<void> {
  const allowed = await tryTake(spec, key, client);
  if (!allowed) {
    throw tooMany(
      retryAfterMs(spec),
      "Too many requests from this caller. Wait for the stated delay and retry.",
      code,
    );
  }
}
