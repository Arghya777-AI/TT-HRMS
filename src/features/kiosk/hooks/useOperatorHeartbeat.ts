/**
 * useOperatorHeartbeat — keeps the shift alive.
 *
 * The operator session token lives TEN MINUTES by design (`kiosk-operator-auth`
 * has no session table, so the TTL is the whole revocation story for a stolen
 * tablet). A gate shift is eight hours. The previous kiosk never called
 * `op=heartbeat`, so its eleventh minute answered
 * `KIOSK_OPERATOR_SESSION_INVALID` and dropped the guard back to sign-in.
 *
 * The server offers `refresh_after_seconds = TTL / 2`; this refreshes a little
 * sooner than that so one failed attempt on a bad connection still has time for a
 * second before the token dies.
 *
 * A refusal is NOT retried in place: an expired or idle-timed-out session, or a
 * guard deactivated mid-shift, all mean the same thing — this guard is no longer
 * signed in, and the screen must say so rather than silently keep a dead token.
 */
import { useEffect, useRef } from "react";
import { refreshOperatorSession, type KioskDeviceState } from "../lib/deviceAuth";

/** Server TTL is 600 s and it suggests refreshing at 300 s. 240 s leaves headroom. */
const REFRESH_EVERY_MS = 240_000;

export function useOperatorHeartbeat({
  device,
  scanCount,
  lastScanAt,
  onRefreshed,
  onExpired,
}: {
  device: KioskDeviceState;
  scanCount: number;
  lastScanAt: string | null;
  onRefreshed: (state: KioskDeviceState) => void;
  onExpired: () => void;
}): void {
  // The timer must not restart every time a scan lands, so the activity numbers
  // are read from refs at fire time instead of from the effect's closure.
  const activity = useRef({ scanCount, lastScanAt });
  useEffect(() => {
    activity.current = { scanCount, lastScanAt };
  }, [scanCount, lastScanAt]);

  const handlers = useRef({ onRefreshed, onExpired });
  useEffect(() => {
    handlers.current = { onRefreshed, onExpired };
  }, [onRefreshed, onExpired]);

  const deviceRef = useRef(device);
  useEffect(() => {
    deviceRef.current = device;
  }, [device]);

  const hasSession = device.session !== undefined;
  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      void (async () => {
        const result = await refreshOperatorSession(deviceRef.current, {
          scansThisSession: activity.current.scanCount,
          lastScanAt: activity.current.lastScanAt,
        });
        if (cancelled) return;
        if (result.ok) {
          handlers.current.onRefreshed(result.data);
          return;
        }
        // 0 is "offline": the token may still be good, so keep the shift and let
        // the next tick try again. Anything the server actually answered is final.
        if (result.error.status !== 0) handlers.current.onExpired();
      })();
    }, REFRESH_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // Only the presence of a session starts or stops the timer; the token itself
    // is read from the ref, so a refresh does not reset the interval.
  }, [hasSession]);
}
