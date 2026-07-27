/**
 * useKioskLocation — where the gate tablet is, kept ready so a punch never waits
 * for it.
 *
 * WHY IT EXISTS
 * -------------
 * `attendance_punches` has `lat`, `lng`, `location_accuracy_m` and `geofence_ok`,
 * and `kiosk-punch` wrote NONE of them: the tablet never asked the browser for a
 * fix, so every gate punch landed with a blank location while a web punch from the
 * same employee carried coordinates. "Their location will be tracked, and it will
 * be audit trailed properly" was only half true, and the half that was missing was
 * the one at the gate where most punches happen.
 *
 * WHY A HELD FIX AND NOT ONE PER SCAN
 * -----------------------------------
 * A kiosk is bolted to a wall. Asking `getCurrentPosition` on every face would add
 * up to eight seconds to the hot path (the helper's own timeout) for a coordinate
 * that has not changed since the shift started — and the client has been explicit
 * that the gate must feel instant. So a fix is taken once when the screen mounts
 * and refreshed on a slow timer, and the punch reads whatever is currently in hand.
 *
 * THE HOT PATH NEVER AWAITS THIS. `current()` is synchronous and returns `null`
 * when there is no fix yet; `sendPunch` omits `geo` and the punch is recorded
 * anyway. A location is evidence attached to attendance, never a condition of it —
 * the same rule the employee-facing path follows, and the reason a guard whose
 * tablet has location switched off can still run the gate.
 *
 * ON A PHONE OPENED OVER PLAIN HTTP THIS IS SIMPLY UNAVAILABLE.
 * `navigator.geolocation` needs a secure context, so a kiosk reached at
 * `http://192.168.x.x:5173` reports `unavailable` and records no coordinates — and
 * `getUserMedia` refuses the camera there for the same reason, so that deployment
 * does not work at all. Serve the kiosk link over HTTPS (or from localhost).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  requestSignInLocation,
  supportsGeolocation,
  toPunchGeo,
  type PunchGeoWire,
  type SignInLocationStatus,
} from "@/features/auth/lib/geolocation";

/**
 * A stationary device does not need a fresh fix per scan, but a stale one held for
 * a whole shift is not evidence either — a tablet does get moved. Five minutes is
 * far longer than the hot path and far shorter than a shift.
 */
const REFRESH_MS = 5 * 60 * 1000;

export interface KioskLocation {
  status: SignInLocationStatus;
  /**
   * Accuracy of the held fix, for the footer. STATE, unlike the coordinates: it is
   * rendered, and it is the one part of a location that is safe to show a guard —
   * a number they can act on ("go outside") without putting the venue's position on
   * a screen in a public doorway.
   */
  accuracyMetres: number | null;
  /** Read synchronously by the punch path. `null` = no fix; send the punch without one. */
  current: () => PunchGeoWire | null;
  /** Take a fix now (the guard can retry after granting permission). */
  refresh: () => Promise<void>;
}

export function useKioskLocation(): KioskLocation {
  const [status, setStatus] = useState<SignInLocationStatus>(() =>
    supportsGeolocation() ? "idle" : "unavailable",
  );
  const [accuracyMetres, setAccuracyMetres] = useState<number | null>(null);
  // A ref, not state: the punch reads it inside an async callback that must not
  // re-run or re-render when a fix lands mid-scan.
  const geoRef = useRef<PunchGeoWire | null>(null);
  const liveRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!supportsGeolocation()) {
      setStatus("unavailable");
      return;
    }
    setStatus((prev) => (prev === "granted" ? prev : "asking"));
    const outcome = await requestSignInLocation();
    if (!liveRef.current) return;
    setStatus(outcome.status);
    // A REFUSAL DOES NOT DISCARD A FIX WE ALREADY HAVE. A transient "position
    // unavailable" between two good fixes would otherwise blank the location for
    // every punch until the next successful poll, which is worse evidence than a
    // five-minute-old coordinate from a device that has not moved.
    if (outcome.geo !== null) {
      geoRef.current = toPunchGeo(outcome.geo);
      setAccuracyMetres(outcome.geo.accuracy_m > 0 ? outcome.geo.accuracy_m : null);
    }
  }, []);

  useEffect(() => {
    liveRef.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    return () => {
      liveRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const current = useCallback(() => geoRef.current, []);
  return { status, accuracyMetres, current, refresh };
}
