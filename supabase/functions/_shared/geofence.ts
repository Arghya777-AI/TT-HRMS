/**
 * geofence.ts — where a punch happened, and whether that is inside the venue.
 *
 * WHY THIS IS SHARED AND NOT COPIED
 * --------------------------------
 * Two functions record punches — `attendance-self-punch` (the employee's phone or
 * browser) and `kiosk-punch` (the guard's tablet at the gate) — and both write the
 * same four columns on `public.attendance_punches`:
 *
 *     lat, lng, location_accuracy_m, geofence_ok
 *
 * `kiosk-punch` wrote NONE of them. The columns existed, the insert simply omitted
 * them, and the tablet never asked the browser for a fix, so every gate punch
 * landed with a blank location while web punches carried coordinates. An audit
 * trail that answers "where was this taken" for one source and not the other is
 * worse than one that answers it for neither, because nobody notices the gap.
 *
 * The distance maths lived inside `attendance-self-punch` as a private function.
 * Copying it into the kiosk would have created two definitions of "inside the
 * venue" that could drift apart on a radius or a rounding — so it moved here and
 * the self-punch path now delegates to it.
 *
 * THE RULE, IDENTICAL ON BOTH PATHS
 * ---------------------------------
 * A punch outside the fence is RECORDED, never refused. Attendance is a fact about
 * something that happened; the fence is an observation about it, for a human to
 * read. Refusing would delete the evidence that somebody punched from the wrong
 * place, which is precisely the case the fence exists to surface.
 *
 * `geofence_ok` is therefore THREE-VALUED and the NULL is load-bearing:
 *
 *   true   — coordinates given, fence configured, distance ≤ radius
 *   false  — coordinates given, fence configured, distance > radius  (flagged)
 *   NULL   — NOT EVALUATED. Either no coordinates were shared (a refused browser
 *            permission is an expected outcome, not a violation) or the venue has
 *            no lat/lng configured yet. NULL must never be read as "outside": one
 *            means "we do not know", the other is an accusation.
 *
 * At the time of writing `public.locations` has `TTT-VENUE` with `lat = NULL`, so
 * every punch in the database — web and kiosk alike — has `geofence_ok = NULL`.
 * The coordinates are recorded regardless; only the verdict waits on someone
 * entering the venue's position under Admin → Org → Locations.
 */

/** Metres. IUGG mean Earth radius, the same constant both callers used. */
const EARTH_RADIUS_M = 6_371_008.8;

/** What a client may send about where it is. Accuracy is optional — some devices lie by omission rather than by number. */
export interface PunchGeo {
  latitude: number;
  longitude: number;
  /** Browser-reported accuracy radius in metres. */
  accuracyMetres?: number;
}

/** A circle to test against: the venue, or a per-device fence. */
export interface GeofenceCircle {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface GeofenceVerdict {
  /** Three-valued on purpose — see the header. NULL is "not evaluated". */
  geofenceOk: boolean | null;
  /** Metres from the fence centre, or null when not evaluated. Recorded for the reviewer, not for a decision. */
  distanceM: number | null;
  /**
   * The fix is so coarse that the verdict is not meaningful — a ±2 km wifi
   * geolocation cannot resolve a 300 m fence, so `geofenceOk` computed from it is
   * a comparison between a point and a guess. The verdict is still returned (it is
   * evidence) but the caller should flag the punch for review rather than treat it
   * as a finding.
   */
  accuracyTooCoarse: boolean;
}

/** Great-circle distance in metres. */
export function haversineMetres(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (toLat - fromLat) * toRad;
  const dLng = (toLng - fromLng) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(fromLat * toRad) * Math.cos(toLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

const NOT_EVALUATED: GeofenceVerdict = {
  geofenceOk: null,
  distanceM: null,
  accuracyTooCoarse: false,
};

/**
 * Judge a punch against a fence. Returns NULL rather than a verdict whenever
 * either side of the comparison is missing — see the header on why that is not
 * the same as `false`.
 */
export function evaluateGeofence(
  geo: PunchGeo | null | undefined,
  fence: GeofenceCircle | null | undefined,
): GeofenceVerdict {
  if (geo === null || geo === undefined) return NOT_EVALUATED;
  if (fence === null || fence === undefined) return NOT_EVALUATED;
  if (!Number.isFinite(fence.lat) || !Number.isFinite(fence.lng)) return NOT_EVALUATED;

  // `geofence_radius_m` is NOT NULL DEFAULT 300 on public.locations, but a device
  // fence comes out of jsonb where anything is possible. A non-positive radius is
  // a misconfiguration, not a fence that nobody can stand inside.
  const radius = Number.isFinite(fence.radiusM) && fence.radiusM > 0 ? fence.radiusM : 300;

  const distanceM = haversineMetres(geo.latitude, geo.longitude, fence.lat, fence.lng);
  const accuracy = geo.accuracyMetres;
  return {
    geofenceOk: distanceM <= radius,
    distanceM,
    accuracyTooCoarse: accuracy !== undefined && accuracy > radius,
  };
}

/**
 * Read a `kiosk_devices.allowed_geofence` jsonb value.
 *
 * The column's CHECK guarantees the three keys are PRESENT when the value is not
 * null; it does not guarantee they are numbers, because jsonb will happily hold
 * `{"lat": "twelve"}`. Anything unreadable degrades to "no fence" — which yields
 * `geofence_ok = NULL`, an honest "not evaluated", rather than a verdict computed
 * from a coerced string.
 */
export function circleFromJson(raw: unknown): GeofenceCircle | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const lat = Number(obj.lat);
  const lng = Number(obj.lng);
  const radiusM = Number(obj.radius_m);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, radiusM: Number.isFinite(radiusM) ? radiusM : 300 };
}
