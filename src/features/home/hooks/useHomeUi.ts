/**
 * useHomeUi.ts — the two browser-state hooks E-02 needs, kept out of the query
 * layer because neither talks to the server.
 */
import { useEffect, useState } from "react";

/**
 * Re-renders on an interval so the IST-hour greeting and the running-shift
 * stopwatch stay honest without refetching. Returns the tick instant, which
 * callers pass to `lib/datetime` helpers as `now` (never formatted directly).
 *
 * 30s is deliberate: the display unit is whole minutes ('2h 14m'), so a
 * per-second timer would repaint 30 times for nothing on a Moto G-class device.
 */
export function useIstTicker(intervalMs = 30_000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return tick;
}

/**
 * Connectivity, for the honest offline banner (§7.2 state 6). `navigator.onLine`
 * false is reliable; true only means "a network exists", which is why the
 * per-card offline state comes from `QueryError.isOffline` as well.
 */
export function useIsOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}
