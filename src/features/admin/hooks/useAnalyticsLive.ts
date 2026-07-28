/**
 * useAnalyticsLive — makes the analytics surface actually live, so the client's "when
 * the data changes, everything should change" is true rather than polled.
 *
 * Mount it ONCE per analytics screen, next to the panels:
 *
 *   const live = useAnalyticsLive({ enabled: canReadAnalytics });
 *   …
 *   <StatusChip label={t(liveStatusCopy(live.status).label)} />
 *
 * It renders nothing and returns no data. Every panel keeps reading its own
 * `useQuery`; this hook only decides when those cache entries stop being trusted. That
 * is deliberate — a live feed that carried the rows itself would be a second source of
 * truth for numbers the panels already agree on, and the two would drift.
 *
 * WHAT ONE INVALIDATION REACHES. `useAnalytics.ts` gives every panel the SAME query
 * key and differs only in `select`, so the KPI strip, the department bars, the
 * employee list and the daily trend are four projections of one cache entry: one
 * invalidation moves all four together, and they cannot briefly disagree the way four
 * independent refetches would. `invalidationKeysFor` adds the neighbouring prefixes
 * the changed table genuinely affects — and nothing else.
 *
 * WHAT IT COSTS AT A BUSY GATE. Nothing, by construction: see the window in
 * `../analyticsLive.ts`. A lone scan lands immediately; a shift-change burst is
 * coalesced into one refresh every two seconds instead of one per scan.
 *
 * DEGRADATION IS THE DEFAULT. There is no throw path, no error state and no retry
 * loop here. If Realtime is unreachable the status settles on `unavailable`, no
 * invalidations are issued, and the dashboard is exactly the dashboard it was before
 * this hook existed. The only thing the user loses is the live claim — which is why
 * the status is returned rather than swallowed.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ANALYTICS_LIVE_WINDOW_MS,
  createRefreshCoalescer,
  invalidationKeysFor,
  liveStatusFrom,
  type AnalyticsLiveStatus,
  type AnalyticsLiveTable,
} from "../analyticsLive";
import { subscribeToAnalyticsChanges } from "../api/analyticsLive.api";

export interface UseAnalyticsLiveOptions {
  /**
   * Subscribe at all. Pass `false` for a screen the user cannot read anyway, or to
   * turn the feed off from a setting — the status becomes `off`, which the chip
   * reports honestly rather than showing a dead "Live".
   */
  readonly enabled?: boolean;
}

export interface AnalyticsLiveState {
  readonly status: AnalyticsLiveStatus;
  /**
   * Coalesced refreshes issued since this hook mounted. Not decoration: it is the one
   * observable that separates "live and nothing has happened" from "live and the
   * events are not landing", and it is what a support conversation asks for.
   */
  readonly refreshes: number;
}

export function useAnalyticsLive(
  { enabled = true }: UseAnalyticsLiveOptions = {},
): AnalyticsLiveState {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AnalyticsLiveStatus>("off");
  const [refreshes, setRefreshes] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      return;
    }
    setStatus("connecting");

    /**
     * Fences THIS effect run's callbacks. React StrictMode double-invokes the effect:
     * channel A is created, torn down, then channel B is created — and A's final
     * CLOSED status arrives AFTER B has already reported SUBSCRIBED. Without the
     * fence, a dead channel's parting shot flips a live dashboard to "Not live" in
     * development and stays wrong. It also stops a queued flush from firing an
     * invalidation into a QueryClient the screen has already left.
     */
    let disposed = false;

    const coalescer = createRefreshCoalescer<AnalyticsLiveTable>({
      windowMs: ANALYTICS_LIVE_WINDOW_MS,
      onFlush: (tables) => {
        if (disposed) return;
        for (const queryKey of invalidationKeysFor(tables)) {
          // Default `refetchType: 'active'` on purpose: mounted panels refetch now,
          // everything else is merely marked stale and re-reads when it is next
          // looked at. A dashboard left open in a background tab must not keep
          // pulling ten thousand rows all afternoon.
          void queryClient.invalidateQueries({ queryKey });
        }
        setRefreshes((n) => n + 1);
      },
    });

    const unsubscribe = subscribeToAnalyticsChanges({
      onChange: (table) => {
        if (!disposed) coalescer.signal(table);
      },
      onStatus: (channelState) => {
        if (!disposed) setStatus(liveStatusFrom(channelState));
      },
    });

    return () => {
      disposed = true;
      // Order matters: drop the pending window BEFORE the socket, so a flush already
      // scheduled inside it cannot land between the two.
      coalescer.cancel();
      unsubscribe();
    };
  }, [enabled, queryClient]);

  return { status, refreshes };
}
