/**
 * punchPlace.ts — turning a stored punch coordinate into something a person can
 * read, and into the cache key that stops us asking OpenStreetMap the same
 * question fifty times.
 *
 * PURE ON PURPOSE. No React, no network, no clock. Every rule here is a decision
 * about how to present someone's recorded location honestly, and each one is
 * cheap to test in isolation — which matters, because the failure mode of this
 * file is not a crash, it is a number on screen that a manager believes.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * SIX DECIMAL PLACES, AND WHY ACCURACY IS NOT OPTIONAL
 *
 * `12.926880` looks surveyed. It is ~11 cm of notional resolution, and a phone
 * that reported it may have been guessing from a cell tower two kilometres away.
 * The digits carry no information about their own reliability, so the coordinate
 * and its accuracy are formatted TOGETHER by `formatFix` and the component never
 * gets the option of drawing one without the other.
 *
 * When accuracy is absent we say "accuracy not reported" rather than printing the
 * coordinate bare. Silence would read as precision.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THE KEY IS THE DEDUPLICATION
 *
 * `geocodeKey` rounds to four decimals — the same rounding `util.geocode_key`
 * applies in the database, which is what makes a client cache entry and a server
 * cache row agree about what "the same place" means. Four decimals is ~11 m at
 * this latitude.
 *
 * This is the whole reason a punch log costs one geocode instead of fifty: React
 * Query dedupes by key, so every punch inside the same 11 m square shares one
 * in-flight request and one cache entry. A day of scans at one gate is a single
 * lookup. Widening the rounding would merge genuinely different addresses;
 * narrowing it would ask the provider once per punch and hit Nominatim's
 * 1 request/second ceiling immediately.
 */

/** Decimals used for the cache key. MUST match `util.geocode_key` (numeric(9,6) → 4dp). */
export const GEOCODE_KEY_DECIMALS = 4;

/** Decimals shown to a reader. The stored column is numeric(9,6). */
const DISPLAY_DECIMALS = 6;

export interface PunchFix {
  latitude: number;
  longitude: number;
  /** Metres of horizontal uncertainty the device reported, or null if it did not. */
  accuracyMetres: number | null;
}

/**
 * A punch row's raw location columns, as they arrive from
 * `v_attendance_punch_detail`. Numerics cross PostgREST as `number` after the
 * Zod layer, but `null` is the common case: most punches carry no coordinate at
 * all, and that is not an error.
 */
export interface PunchLocationColumns {
  lat: number | null;
  lng: number | null;
  /**
   * REQUIRED, not optional, and that is the point.
   *
   * As an optional field this interface was satisfied by a row schema that had
   * `lat` and `lng` and no accuracy at all — so `PunchLocation` typechecked
   * against the admin punch log and rendered "accuracy not reported" on every
   * single row, for a column that WAS in the database. A silent wrong answer.
   *
   * Required, any surface that forgets to select the column fails to compile.
   * `null` still means "the device reported none", which is a real state and a
   * caller must state it deliberately.
   */
  location_accuracy_m: number | null;
}

/**
 * Read the location out of a punch row, or `null` when there isn't one.
 *
 * BOTH coordinates are required. A row with a latitude and no longitude is not a
 * location, it is a broken record — and `evaluateGeofence`'s three-valued rule
 * applies here too: absent means "not known", never "at the equator". Zero is a
 * legitimate coordinate, so the test is `=== null`, never falsiness.
 */
export function readPunchFix(row: PunchLocationColumns): PunchFix | null {
  const { lat, lng } = row;
  if (lat === null || lng === null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Out-of-range values mean the column holds something that is not a coordinate;
  // rendering it would put a nonsense pin on a map.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const accuracy = row.location_accuracy_m;
  return {
    latitude: lat,
    longitude: lng,
    accuracyMetres:
      accuracy === null || accuracy === undefined || !Number.isFinite(accuracy) || accuracy < 0
        ? null
        : accuracy,
  };
}

/**
 * The cache key for a coordinate: rounded to `GEOCODE_KEY_DECIMALS` and rendered
 * as fixed-point text.
 *
 * `toFixed` rather than arithmetic rounding, so `-0` cannot appear (it would key
 * `"-0.0000"` and `"0.0000"` to different entries for the same point) and so the
 * string form is stable regardless of float representation.
 */
export function geocodeKey(fix: Pick<PunchFix, "latitude" | "longitude">): string {
  const lat = fix.latitude.toFixed(GEOCODE_KEY_DECIMALS);
  const lng = fix.longitude.toFixed(GEOCODE_KEY_DECIMALS);
  // `+ 0` collapses "-0.0000" to "0.0000". Without it two identical points can
  // produce two keys and the deduplication silently stops working.
  const norm = (value: string): string => (Number(value) + 0).toFixed(GEOCODE_KEY_DECIMALS);
  return `${norm(lat)},${norm(lng)}`;
}

/** `12.926880, 77.606018` — the coordinate as a reader should see it. */
export function formatCoordinates(fix: PunchFix): string {
  return `${fix.latitude.toFixed(DISPLAY_DECIMALS)}, ${fix.longitude.toFixed(DISPLAY_DECIMALS)}`;
}

/**
 * Accuracy as a rounded metre figure, or `null` when the device reported none.
 *
 * Rounded to whole metres below 100 and to the nearest 10 above it: a reading of
 * "±1,847 m" implies the uncertainty itself is known to the metre, which it is
 * not. Sub-metre readings round UP to 1 rather than to 0 — "±0 m" would claim
 * perfect knowledge.
 */
export function roundAccuracy(metres: number): number {
  if (metres <= 1) return 1;
  if (metres < 100) return Math.round(metres);
  return Math.round(metres / 10) * 10;
}

/**
 * An OpenStreetMap link for the fix — the client's chosen default map.
 *
 * `#map=<zoom>/<lat>/<lon>` puts the viewport on the point and `mlat`/`mlon`
 * drops the marker; without the marker parameters OSM centres the map but shows
 * nothing at the coordinate, which looks like the link failed.
 *
 * Zoom follows accuracy, because framing a 2 km fix at building zoom is the same
 * false-precision problem in map form.
 */
export function openStreetMapUrl(fix: PunchFix): string {
  const zoom = mapZoomFor(fix.accuracyMetres);
  const lat = fix.latitude.toFixed(DISPLAY_DECIMALS);
  const lon = fix.longitude.toFixed(DISPLAY_DECIMALS);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`;
}

/** Zoom level matched to how well the point is actually known. */
export function mapZoomFor(accuracyMetres: number | null): number {
  // No accuracy reported: do NOT zoom to building level, that would assert a
  // precision nothing supports. Neighbourhood zoom is the honest default.
  if (accuracyMetres === null) return 16;
  if (accuracyMetres <= 25) return 19;
  if (accuracyMetres <= 100) return 17;
  if (accuracyMetres <= 500) return 15;
  if (accuracyMetres <= 2_000) return 13;
  return 11;
}

/**
 * A short place label from the geocoder's address parts, for a table cell where
 * the full display name (which runs to a dozen commas in Bengaluru) will not fit.
 *
 * Order is deliberate: the FEATURE name first when there is one, because "St.
 * Joseph's Indian High School" identifies a place to a human far better than
 * "1st Cross Road" does, then the road, then the locality. At most two parts —
 * beyond that a cell truncates mid-word and the label stops being scannable.
 *
 * Returns null when every part is empty, which is the caller's cue to fall back
 * to coordinates rather than render an empty cell.
 */
export interface GeocodedParts {
  name?: string | null;
  road?: string | null;
  suburb?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
  country?: string | null;
}

export function shortPlaceLabel(parts: GeocodedParts): string | null {
  const clean = (value: string | null | undefined): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  };

  const feature = clean(parts.name);
  const road = clean(parts.road);
  const locality = clean(parts.suburb) ?? clean(parts.city);

  // A geocoder often returns the road AS the feature name for a mid-street fix
  // ("32nd G Cross Street" came back as both). Repeating it reads as a bug.
  const primary = feature ?? road;
  const secondary = primary === road ? locality : (road ?? locality);

  const chosen = [primary, secondary === primary ? null : secondary].filter(
    (part): part is string => part !== null,
  );
  return chosen.length === 0 ? null : chosen.join(", ");
}
