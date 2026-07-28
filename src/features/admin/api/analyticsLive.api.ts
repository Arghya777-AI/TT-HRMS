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
