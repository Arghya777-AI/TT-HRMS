/**
 * useLocationTrail — sample this employee's position while the app is open.
 *
 * ── WHAT IT DOES, AND THE LIMIT IT CANNOT PASS ──────────────────────────────
 * The venue holds signed consent to track staff location and asked for continuous background
 * GPS. This is the most that a web application can deliver against that, and the shortfall is
 * not a setting:
 *
 *   `watchPosition` is suspended when the page is hidden, and the Geolocation API is not
 *   exposed to service workers. So the moment the app is backgrounded or closed, sampling
 *   stops. A native app with iOS `UIBackgroundModes: location` is the only thing that samples
 *   in the background, and this product has no native project — the WKWebView shell's whole
 *   bridge is `playSound` and `speak`.
 *
 * A GAP IN THE TRAIL THEREFORE MEANS THE APP WAS CLOSED. It does not mean the employee was
 * elsewhere, and no screen built on this may imply that it does.
 *
 * ── WHY IT STOPS WHEN THE TAB IS HIDDEN, ON PURPOSE ─────────────────────────
 * The browser suspends the watch anyway, but leaving it registered means a burst of stale
 * readings on return, all timestamped at once. Tearing it down on `visibilitychange` and
 * re-arming on return keeps the trail to fixes that were actually taken when they say.
 *
 * ── FAILURE IS SILENT, DELIBERATELY ─────────────────────────────────────────
 * A refused permission, a device with no GPS, a dropped request: none of them is the
 * employee's problem to solve mid-shift, and none of them may interrupt what they were doing.
 * Nothing here throws, nothing renders, and a punch is completely unaffected — the punch path
 * captures its own location and enforces its own rules.
 */
import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { nowInstantIso } from "@/lib/datetime";
import { shouldRecord, type Sample } from "../locationTrail";

/** `record_location_ping` answers `within_shift` and the venue distance server-side. */
const RECORD_FN = "record_location_ping";

export interface LocationTrailOptions {
  /** Off unless the venue's tracking policy applies to this signed-in employee. */
  readonly enabled: boolean;
}

export function useLocationTrail({ enabled }: LocationTrailOptions): void {
  /*
    The last sample actually WRITTEN, not the last seen. `shouldRecord` compares against it so
    a slow drift under the distance floor still accumulates into a recorded move rather than
    being discarded forever.
  */
  const lastRecorded = useRef<Sample | null>(null);
  /** Guards against two writes racing while one is still in flight. */
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || navigator.geolocation === undefined) return;

    let watchId: number | null = null;

    const send = (sample: Sample): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      void supabase
        .rpc(RECORD_FN, {
          /*
            `nowInstantIso` rather than `toISOString()`: the repo bans the latter because it
            silently produces UTC where a BUSINESS date was meant. This is a genuine instant,
            not a date — but the helper is the sanctioned way to render one, and an exception
            here would be the next person's precedent for a real bug.
          */
          p_captured_at: nowInstantIso(new Date(sample.at)),
          p_lat: sample.lat,
          p_lng: sample.lng,
          p_accuracy_m: sample.accuracyM,
        })
        .then(({ error }) => {
          // Only advance the cursor on a write that actually landed, so a dropped
          // request does not silently open a five-minute hole in the trail.
          if (!error) lastRecorded.current = sample;
        })
        .then(undefined, () => undefined)
        .then(() => {
          inFlight.current = false;
        });
    };

    const onFix = (position: GeolocationPosition): void => {
      const sample: Sample = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        at: position.timestamp,
      };
      if (shouldRecord(sample, lastRecorded.current).record) send(sample);
    };

    const start = (): void => {
      if (watchId !== null) return;
      try {
        watchId = navigator.geolocation.watchPosition(onFix, () => undefined, {
          enableHighAccuracy: true,
          // Older than two minutes is not "now"; the throttles decide what is stored.
          maximumAge: 120_000,
          timeout: 30_000,
        });
      } catch {
        // Some webviews expose the object and throw on use.
        watchId = null;
      }
    };

    const stop = (): void => {
      if (watchId === null) return;
      try {
        navigator.geolocation.clearWatch(watchId);
      } catch {
        // Nothing depends on the teardown succeeding.
      }
      watchId = null;
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [enabled]);
}
