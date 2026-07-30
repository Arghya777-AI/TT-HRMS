/**
 * analyticsLive.api.ts — the ONE place the analytics surface touches the Realtime
 * socket. Pages and components may not import the Supabase client (architecture
 * D-01), and `hooks/useAnalyticsLive.ts` wraps this; the decision logic it feeds lives
 * in `../analyticsLive.ts` and imports no client at all, which is what makes the
 * debounce testable without a socket.
 *
 * Modelled on `features/home/api/home.api.ts:subscribeToMyAttendanceDays` — create the
 * channel inside the call, hand back an unsubscribe, and let the effect own the
 * lifetime. Two things differ, both because this one is org-wide rather than "my own
 * rows":
 *
 *   1. FOUR BINDINGS, ONE CHANNEL. A channel per table would open four websocket
 *      joins and four rejoin/backoff cycles for one dashboard. `postgres_changes`
 *      bindings are per-channel, so all four hang off a single join and one
 *      `removeChannel` tears the lot down.
 *   2. NO `filter=`. The home subscription pins `employee_id=eq.…`; analytics is
 *      deliberately venue-wide. RLS still decides what the caller is told about — a
 *      subscriber only receives rows their policies would let them SELECT — so the
 *      absence of a filter here widens the interest, not the permission.
 *
 * The topic carries a per-subscription serial. React StrictMode double-invokes the
 * effect, so channel A is being torn down while channel B joins; two live channels
 * sharing one topic name is the state supabase-js rejects ("tried to subscribe
 * multiple times"), and it would present as a dashboard that is silently not live in
 * development only. A serial makes the overlap harmless.
 */
/*
  ─────────────────────────────────────────────────────────────────────────────
  LIVE UPDATES DO NOT CURRENTLY ARRIVE, AND THE CAUSE IS NOT IN THIS FILE
  ─────────────────────────────────────────────────────────────────────────────
  Measured, not guessed: subscribe as a signed-in user, insert a real row by SQL, count
  the events. ZERO arrive — for punches, for `ai_messages`, for `ai_conversations`, on a
  parent-table binding and on a partition binding alike. So nothing below is at fault and
  no amount of rebinding will help.

  WHAT IS ACTUALLY WRONG. While a client reports `SUBSCRIBED`, `realtime.subscription`
  holds ZERO rows. The websocket join succeeds — that only needs the publishable key — but
  the `postgres_changes` BINDING is never registered, so the server has nothing to match
  WAL changes against. The replication slot is healthy and 0 bytes behind, so the WAL is
  being read and then discarded.

  Why the binding is refused: the user's access token is signed `ES256` with a `kid` — the
  project has moved to asymmetric JWT signing keys. Realtime's postgres_changes path
  verifies user JWTs with the project's legacy HS256 secret and cannot verify an ES256
  token, so it declines to register and says nothing.

  THE FIX IS A PROJECT SETTING, not code: either keep a legacy HS256 shared secret enabled
  alongside the asymmetric keys (Supabase supports both during migration), or run a
  Realtime version that verifies via JWKS. Until one of those happens, every subscription
  in this codebase is inert — including `subscribeToMyAttendanceDays` on the home page,
  which has the same problem and has presumably never worked either.

  ONE REAL MISCONFIGURATION WAS FOUND AND FIXED on the way, and it would have bitten
  immediately afterwards: `supabase_realtime` had `publish_via_partition_root = false`, so
  punch changes published under the PARTITION's identity (`attendance_punches_2026_07`).
  The binding below names the parent, so it could never have matched, and Realtime's
  per-row RLS check would have run against a partition that carries no policies of its
  own. It is `true` now and the publication reports `attendance_punches` — the name used
  below. `sessions_audit` was added at the same time so sign-ins and sign-outs can stream.
*/
import { supabase } from "@/lib/supabase";
import { ANALYTICS_LIVE_TABLES, type AnalyticsLiveTable } from "../analyticsLive";

export interface AnalyticsChangeHandlers {
  /** A row changed on one of {@link ANALYTICS_LIVE_TABLES}. Fires per event. */
  readonly onChange: (table: AnalyticsLiveTable) => void;
  /**
   * A Realtime subscribe state ('SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' |
   * 'CHANNEL_ERROR'). Widened to `string` on the way out so the pure mapper
   * (`liveStatusFrom`) never has to import the realtime enum.
   */
  readonly onStatus: (channelState: string) => void;
}

/** Distinguishes overlapping channels during a StrictMode remount — see the header. */
let channelSerial = 0;

/**
 * Subscribe to every table the analytics layer reads. Returns its own unsubscribe;
 * call it from the effect's cleanup.
 *
 * Nothing here throws. If Realtime is unreachable the channel simply reports
 * CHANNEL_ERROR / TIMED_OUT through `onStatus` and no change events arrive — the
 * dashboard stops being live and keeps working, which is the required degradation.
 */
export function subscribeToAnalyticsChanges(handlers: AnalyticsChangeHandlers): () => void {
  channelSerial += 1;
  const channel = supabase.channel(`admin-analytics-${channelSerial}`);

  for (const table of ANALYTICS_LIVE_TABLES) {
    channel.on(
      "postgres_changes",
      // '*' rather than the per-table event lists in migration 040: the publication
      // decides what is emitted, and pinning INSERT here would mean an engine restamp
      // (UPDATE on attendance_days) left the figures stale until the next visit.
      { event: "*", schema: "public", table },
      () => handlers.onChange(table),
    );
  }

  // `String(...)` because supabase types this as a string ENUM; the pure mapper takes
  // a plain string so it can be exercised without the realtime package.
  channel.subscribe((status) => handlers.onStatus(String(status)));

  return () => {
    void supabase.removeChannel(channel);
  };
}
