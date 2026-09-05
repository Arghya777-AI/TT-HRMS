/**
 * useHomeUi.ts — the two browser-state hooks E-02 needs, kept out of the query
 * layer because neither talks to the server.
 */
import { useEffect, useState } from "react";

/**
 * Re-renders when the DISPLAYED MINUTE CHANGES, so an IST wall clock on screen is the same
 * wall clock the employee is holding.
 *
 * ── WHY THE OLD ONE READ A MINUTE SLOW ───────────────────────────────────────
 * It fired every 30 seconds from whenever the component happened to mount, which is not the
 * same thing as being correct to the minute. Mount at 09:02:59 and the ticks land at 09:03:29
 * and 09:03:59 — so between 09:03:00 and 09:03:29 the header still said 09:02. Up to a full
 * minute behind, on a clock people were checking against their phones and concluding the
 * system was losing time.
 *
 * Halving the interval would only have halved the error. The fix is to stop sampling on a
 * fixed period and instead wake exactly at the next minute boundary, then re-arm from the new
 * `Date.now()` each time — self-correcting, so drift and a device sleeping through a tick
 * both heal on the next wake.
 *
 * It is still ONE repaint per minute, not per second: the display unit is whole minutes, and
 * a per-second timer would repaint sixty times for nothing on a Moto G-class device.
 */
export function useIstTicker(): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    let id: number | undefined;
    const arm = (): void => {
      const now = Date.now();
      // +25ms so a wake that lands a hair early still reads the new minute.
      const msToNextMinute = 60_000 - (now % 60_000) + 25;
      id = window.setTimeout(() => {
        setTick(Date.now());
        arm();
      }, msToNextMinute);
    };
    arm();
    return () => {
      if (id !== undefined) window.clearTimeout(id);
    };
  }, []);
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
