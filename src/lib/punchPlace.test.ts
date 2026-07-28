/**
 * punchPlace.test.ts — the rules that keep a recorded location honest.
 *
 * Two of these tests exist because of bugs this file was written to avoid rather
 * than bugs it had: the `-0` key collision (which would silently switch off the
 * deduplication that makes a punch log affordable) and the zero-coordinate case
 * (where a falsiness check turns "0°" into "no location"). Both fail loudly here
 * and would fail silently in production.
 */
import { describe, expect, it } from "vitest";
import {
  GEOCODE_KEY_DECIMALS,
  formatCoordinates,
  geocodeKey,
  mapZoomFor,
  openStreetMapUrl,
  readPunchFix,
  roundAccuracy,
  shortPlaceLabel,
} from "./punchPlace";

describe("readPunchFix — absence is not a location", () => {
  it("reads a complete fix", () => {
    const fix = readPunchFix({ lat: 12.92688, lng: 77.606018, location_accuracy_m: 35 });
    expect(fix).toEqual({ latitude: 12.92688, longitude: 77.606018, accuracyMetres: 35 });
  });

  it("returns null when either coordinate is missing", () => {
    // A latitude with no longitude is a broken record, not a place.
    expect(readPunchFix({ lat: 12.9, lng: null, location_accuracy_m: 10 })).toBeNull();
    expect(readPunchFix({ lat: null, lng: 77.6, location_accuracy_m: 10 })).toBeNull();
    expect(readPunchFix({ lat: null, lng: null, location_accuracy_m: null })).toBeNull();
  });

  it("treats 0,0 as a REAL coordinate, not as absent", () => {
    /*
      The Gulf of Guinea is a legitimate point on the globe. A falsiness check
      (`if (!lat)`) would drop it, and the same check drops the equator and the
      prime meridian. The test is `=== null`, and this asserts it stays that way.
    */
    const fix = readPunchFix({ lat: 0, lng: 0, location_accuracy_m: 0 });
    expect(fix).not.toBeNull();
    expect(fix?.latitude).toBe(0);
    expect(fix?.longitude).toBe(0);
  });

  it("rejects coordinates outside the possible range", () => {
    // Not a coordinate — rendering it would put a nonsense pin on a map.
    expect(readPunchFix({ lat: 91, lng: 0, location_accuracy_m: null })).toBeNull();
    expect(readPunchFix({ lat: 0, lng: 181, location_accuracy_m: null })).toBeNull();
    expect(readPunchFix({ lat: Number.NaN, lng: 0, location_accuracy_m: null })).toBeNull();
  });

  it("keeps a null accuracy null rather than inventing a number", () => {
    const fix = readPunchFix({ lat: 12.9, lng: 77.6, location_accuracy_m: null });
    expect(fix?.accuracyMetres).toBeNull();
  });

  it("discards a negative accuracy instead of showing '± -5 m'", () => {
    const fix = readPunchFix({ lat: 12.9, lng: 77.6, location_accuracy_m: -5 });
    expect(fix?.accuracyMetres).toBeNull();
  });

  it("keeps an accuracy of 0 distinguishable from a missing one", () => {
    // 0 is a reading the device made. It is not "unreported".
    const fix = readPunchFix({ lat: 12.9, lng: 77.6, location_accuracy_m: 0 });
    expect(fix?.accuracyMetres).toBe(0);
  });
});

describe("geocodeKey — the deduplication contract", () => {
  it("rounds to the same 4 decimals the database key uses", () => {
    expect(GEOCODE_KEY_DECIMALS).toBe(4);
    expect(geocodeKey({ latitude: 12.925761, longitude: 77.5946 })).toBe("12.9258,77.5946");
  });

  it("gives two punches in the same ~11 m square ONE key", () => {
    /*
      This is the whole reason a day of scans at one gate costs one geocode
      instead of fifty: React Query dedupes by key. If this ever stops holding,
      nothing breaks visibly — the log just starts hammering a provider that
      allows one request per second, and most rows come back throttled.
    */
    const a = geocodeKey({ latitude: 12.92688, longitude: 77.606018 });
    const b = geocodeKey({ latitude: 12.926885, longitude: 77.60602 });
    expect(a).toBe(b);
  });

  it("keeps genuinely different places apart", () => {
    const office = geocodeKey({ latitude: 12.9716, longitude: 77.5946 });
    const elsewhere = geocodeKey({ latitude: 12.9258, longitude: 77.5946 });
    expect(office).not.toBe(elsewhere);
  });

  it("never produces a '-0' key for a point on the equator or meridian", () => {
    /*
      `(-0.00001).toFixed(4)` is "-0.0000", and "-0.0000" !== "0.0000". Without the
      normalisation, two coordinates a centimetre apart on either side of the line
      would key differently, silently halving the cache hit rate for anybody near
      it — and the failure is invisible everywhere else on the planet.
    */
    expect(geocodeKey({ latitude: -0.00001, longitude: -0.00001 })).toBe("0.0000,0.0000");
    expect(geocodeKey({ latitude: -0.00001, longitude: 0 })).toBe(
      geocodeKey({ latitude: 0, longitude: 0 }),
    );
  });
});

describe("formatting", () => {
  it("shows six decimals, matching the numeric(9,6) column", () => {
    expect(formatCoordinates({ latitude: 12.9716, longitude: 77.5946, accuracyMetres: null })).toBe(
      "12.971600, 77.594600",
    );
  });

  it("never rounds a sub-metre accuracy down to '± 0 m'", () => {
    // "± 0 m" claims perfect knowledge of a position. Nothing does.
    expect(roundAccuracy(0)).toBe(1);
    expect(roundAccuracy(0.4)).toBe(1);
    expect(roundAccuracy(1)).toBe(1);
  });

  it("rounds whole metres below 100 and tens above", () => {
    expect(roundAccuracy(18)).toBe(18);
    expect(roundAccuracy(35.4)).toBe(35);
    // "± 1,847 m" implies the uncertainty is known to the metre. It is not.
    expect(roundAccuracy(1_847)).toBe(1_850);
  });
});

describe("openStreetMapUrl", () => {
  it("drops a marker AND centres the map", () => {
    const url = openStreetMapUrl({ latitude: 12.9716, longitude: 77.5946, accuracyMetres: 20 });
    // Without mlat/mlon, OSM centres the view and shows nothing at the point,
    // which reads as a broken link.
    expect(url).toContain("mlat=12.971600");
    expect(url).toContain("mlon=77.594600");
    expect(url).toContain("#map=19/12.971600/77.594600");
  });

  it("zooms out for a coarse fix instead of framing it as a building", () => {
    const tight = mapZoomFor(10);
    const coarse = mapZoomFor(3_000);
    expect(tight).toBeGreaterThan(coarse);
  });

  it("does not zoom to building level when accuracy is unknown", () => {
    // Unknown accuracy must not present as a precise fix — in map form either.
    expect(mapZoomFor(null)).toBeLessThan(mapZoomFor(10));
  });
});

describe("shortPlaceLabel", () => {
  it("prefers the feature name, which identifies a place to a human", () => {
    expect(
      shortPlaceLabel({
        name: "St. Joseph's Indian High School",
        road: "1st Cross Road",
        suburb: "D'Souza Layout",
        city: "Bengaluru",
      }),
    ).toBe("St. Joseph's Indian High School, 1st Cross Road");
  });

  it("does not repeat the road when the geocoder used it as the feature name", () => {
    /*
      Nominatim returned "32nd G Cross Street" as BOTH `name` and `road` for a
      mid-street fix — a real response from this project's own data. Joining them
      blindly gives "32nd G Cross Street, 32nd G Cross Street", which reads as a bug.
    */
    expect(
      shortPlaceLabel({
        name: "32nd G Cross Street",
        road: "32nd G Cross Street",
        suburb: "Tilak Nagara",
        city: "Bengaluru",
      }),
    ).toBe("32nd G Cross Street, Tilak Nagara");
  });

  it("falls back to the locality when the provider gives neither name nor road", () => {
    /*
      A REAL response from this project's own punch data (12.926818, 77.605862 —
      a web punch taken on 28 Jul): Nominatim returned no `name` and no `road`,
      only `suburb`. Both preferred parts being null is the common case for a fix
      in a residential layout, and returning null here would have shown
      "Address lookup unavailable" for a punch that geocoded perfectly.
    */
    expect(
      shortPlaceLabel({
        name: null,
        road: null,
        suburb: "Balaji Layout",
        city: "Bengaluru",
        postcode: "560029",
      }),
    ).toBe("Balaji Layout");
  });

  it("falls back through road and locality", () => {
    expect(shortPlaceLabel({ name: null, road: "MG Road", suburb: null, city: "Bengaluru" })).toBe(
      "MG Road, Bengaluru",
    );
  });

  it("returns null when there is nothing to say, so the caller can fall back", () => {
    // Not an empty string: an empty cell looks like a rendering failure.
    expect(shortPlaceLabel({})).toBeNull();
    expect(shortPlaceLabel({ name: "  ", road: "", suburb: null })).toBeNull();
  });

  it("ignores whitespace-only parts from the provider", () => {
    expect(shortPlaceLabel({ name: "   ", road: "Kasturba Road", suburb: null })).toBe(
      "Kasturba Road",
    );
  });
});
