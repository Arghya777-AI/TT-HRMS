/**
 * locationTrail.ts — when to take a location sample, and when not to.
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
 * The venue holds signed consent to track staff location and asked for continuous
 * background GPS. Consent settles whether it should be done; it does not move the platform
 * ceiling, and being straight about the ceiling is the whole reason this module exists as
 * testable logic rather than a `setInterval` buried in a component:
 *
 *   A WEB PAGE CANNOT SAMPLE POSITION IN THE BACKGROUND. `watchPosition` is suspended when
 *   the page is hidden, and the Geolocation API is not exposed to service workers at all.
 *   This product is a PWA plus a WKWebView shell whose entire bridge is `playSound` and
 *   `speak` — there is no native background capability to switch on.
 *
 * So this samples while the app is OPEN. A gap in the trail means the app was closed, not
 * that somebody was absent, and anything reading it as evidence has to say so.
 *
 * ── THE TWO THROTTLES, AND WHY BOTH ─────────────────────────────────────────
 * Cost was raised directly: "I can build something which will cost you one lakh per month,
 * but that's not my goal." An unthrottled `watchPosition` fires several times a second, which
 * for 83 people is millions of rows a day for no extra information.
 *
 *   TIME      at most one sample every five minutes.
 *   DISTANCE  and only when the position has moved fifty metres.
 *
 * Both, not either: time alone writes a dozen identical points for somebody at a desk, and
 * distance alone writes nothing at all for somebody who has not moved — which is
 * indistinguishable from the app being shut. The first sample of a session always goes
 * through, so "arrived and stayed put" is recorded once rather than never.
 */

/** One reading from the browser, reduced to what is stored. */
export interface Sample {
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number | null;
  /** Epoch milliseconds, as `GeolocationPosition.timestamp` gives it. */
  readonly at: number;
}

export const MIN_INTERVAL_MS = 5 * 60 * 1000;
export const MIN_MOVE_M = 50;

/**
 * Readings this coarse are not evidence of being anywhere.
 *
 * A desktop with no GPS is located by IP and comes back accurate to whole kilometres. Storing
 * that beside a phone's 8-metre fix, on the same map, invites somebody to read a city-sized
 * circle as a place. The punch path already refuses beyond 2 km for the same reason.
 */
export const MAX_ACCURACY_M = 2_000;

/** Metres between two coordinates. IUGG mean Earth radius, as `_shared/geofence.ts` uses. */
export function metresBetween(a: Sample, b: Sample): number {
  const R = 6_371_008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type SkipReason = "too_coarse" | "too_soon" | "too_close";

export type Decision = { readonly record: true } | { readonly record: false; readonly why: SkipReason };

/**
 * Should this reading be written?
 *
 * `last` is the last sample actually RECORDED, not the last one seen — otherwise a slow drift
 * of forty metres every four minutes would never be written at all, while the person walked
 * across town.
 */
export function shouldRecord(next: Sample, last: Sample | null): Decision {
  if (next.accuracyM !== null && next.accuracyM > MAX_ACCURACY_M) {
    return { record: false, why: "too_coarse" };
  }
  // The first fix of a session always counts: "arrived and did not move" must appear once.
  if (last === null) return { record: true };
  if (next.at - last.at < MIN_INTERVAL_MS) return { record: false, why: "too_soon" };
  if (metresBetween(last, next) < MIN_MOVE_M) return { record: false, why: "too_close" };
  return { record: true };
}
