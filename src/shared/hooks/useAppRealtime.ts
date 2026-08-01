/**
 * useAppRealtime — mounts the app's single live connection, once, for a signed-in user.
 *
 * WHERE IT GOES: the authenticated shell, so every screen inherits live data without
 * knowing anything about it. A screen that wants to be live now simply reads its data the
 * way it always did — the invalidation arrives from here and React Query refetches
 * whatever is mounted. Nothing needs a subscription of its own, which is the point:
 * per-screen channels are how a table gets forgotten on the twelfth screen.
 *
 * TOKEN, NOT JUST CONNECTION. `supabase.realtime.setAuth(token)` must be called with the
 * CURRENT access token, and again after every refresh — `postgres_changes` evaluates RLS
 * with the token the socket was authenticated with, so a stale one silently stops matching
 * rows partway through a session. Hooking it to the session object means a refresh
 * re-authenticates the socket.
 *
 * INVALIDATION IS COALESCED. A recompute run can rewrite a hundred `attendance_days` rows
 * in a second, and each arrives as its own message. Invalidating per message would mean a
 * hundred refetches of the same query. A short trailing window collects them into one
 * pass, which is invisible to a human (the budget is two seconds) and turns a burst into
 * a single request.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import {
  invalidationRootsFor,
  subscribeToAppChanges,
  type RealtimeTable,
} from "@/shared/api/realtime";

/**
 * How long to collect changes before invalidating. Well inside the two-second
 * punch-to-screen budget, and long enough that a bulk recompute lands as one refetch.
 */
const COALESCE_MS = 250;

export function useAppRealtime(profileId: string | null, accessToken: string | null): void {
  const queryClient = useQueryClient();
  /** Tables that changed since the last flush. */
  const pending = useRef<Set<RealtimeTable>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The socket carries its own auth. Re-set it whenever the token changes, or RLS starts
  // being evaluated against an expired token and rows quietly stop arriving.
  useEffect(() => {
    if (accessToken === null) return;
    void supabase.realtime.setAuth(accessToken);
  }, [accessToken]);

  useEffect(() => {
    if (profileId === null || accessToken === null) return;

    // Captured once for this effect, so the cleanup clears the SAME set it filled rather
    // than whatever `pending.current` happens to point at when React tears the effect down.
    const queued = pending.current;

    const flush = (): void => {
      timer.current = null;
      const tables = [...queued];
      queued.clear();

      // De-duplicate the roots: two tables usually share several, and invalidating
      // `["admin"]` five times is five passes over the same cache.
      const roots = new Map<string, readonly string[]>();
      for (const table of tables) {
        for (const root of invalidationRootsFor(table)) roots.set(root.join("/"), root);
      }
      for (const root of roots.values()) {
        void queryClient.invalidateQueries({ queryKey: root });
      }
    };

    const stop = subscribeToAppChanges(profileId, (change) => {
      queued.add(change.table);
      if (timer.current === null) timer.current = setTimeout(flush, COALESCE_MS);
    });

    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      queued.clear();
      stop();
    };
  }, [profileId, accessToken, queryClient]);
}
