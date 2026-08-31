/**
 * venueDistance.ts — how far a punch was taken from the venue, in words a person reads.
 *
 * ── WHERE "THE VENUE" COMES FROM ─────────────────────────────────────────────
 * `public.locations.lat / lng` on the primary location. Those columns were NULL in production
 * for the whole life of this system, which is why `geofence_ok` was false on all 908 punches
 * ever recorded — not because anybody was outside a fence, but because there was no fence to be
 * outside of. Migration 046 says as much: "venue lat/lng are captured on site".
 *
 * They were captured, in effect, by the gate tablet. 844 punches from "Official tt gate Redme
 * tab" cluster inside about 17 m × 32 m, and every other gate device sits within ~20 m of that
 * centre. So the venue point is the median of what the fixed tablet at the gate has been
 * reporting all along — which is exactly how the venue described it: the gate tab's location IS
 * the campus location.
 *
 * That is a one-time write to `locations`, not something computed here. Deriving it at render
 * time would mean the distance shown to an admin depended on which punches happened to be in
 * the window, and two admins could see different numbers for the same punch.
 *
 * ── WHY NULL IS RENDERED, NOT DEFAULTED ──────────────────────────────────────
 * With no venue point there is no distance, and `null` says so. Falling back to a plausible
 * centre — the city, the first punch of the day — would put a number on screen that looks like
 * a measurement and is a guess. An admin acting on "3.4 km away" needs it to be 3.4 km away.
 *
 * ── ONE HAVERSINE ────────────────────────────────────────────────────────────
 * Imported from `_shared/geofence.ts`, the same function `attendance-self-punch` and
 * `kiosk-punch` evaluate their fences with. A second copy here is how the dashboard ends up
 * disagreeing with the `geofence_ok` stored on the row it is describing.
 */
import { haversineMetres } from "../../supabase/functions/_shared/geofence";

/** The venue's reference point. Either half missing means there is no venue point at all. */
export interface VenuePoint {
  readonly lat: number;
  readonly lng: number;
  /** `locations.geofence_radius_m` — what the venue considers "on site". */
  readonly radiusM: number;
  readonly name: string;
}

export interface VenueDistance {
  readonly metres: number;
  /** Inside the venue's own radius. Not a verdict on the person — see `accuracyM`. */
  readonly withinFence: boolean;
  /**
   * True when the fix is so coarse that the distance cannot resolve the fence.
   *
   * A ±800 m fix against a 300 m radius produces a real number whose error bar is wider than
   * the thing being measured. The number is still worth showing — 5 km out is 5 km out at
   * ±800 m — but it must not be presented as a clean in/out.
   */
  readonly coarse: boolean;
}

export function distanceFromVenue(
  fix: { readonly latitude: number; readonly longitude: number; readonly accuracyMetres: number | null },
  venue: VenuePoint | null,
): VenueDistance | null {
  if (venue === null) return null;
  const metres = haversineMetres(venue.lat, venue.lng, fix.latitude, fix.longitude);
  return {
    metres,
    withinFence: metres <= venue.radiusM,
    coarse: fix.accuracyMetres !== null && fix.accuracyMetres > venue.radiusM,
  };
}

/**
 * Metres under a kilometre, kilometres above it — the way somebody would say it out loud.
 *
 * Rounded to 10 m below 1 km because the fixes themselves are accurate to tens of metres, and
 * "417 m" claims a precision the GPS did not have. One decimal place on kilometres for the same
 * reason: "3.4 km", never "3.42 km".
 */
export function formatDistance(metres: number): string {
  if (metres < 1_000) {
    const rounded = metres < 20 ? Math.round(metres) : Math.round(metres / 10) * 10;
    return `${rounded} m`;
  }
  const km = metres / 1_000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}
