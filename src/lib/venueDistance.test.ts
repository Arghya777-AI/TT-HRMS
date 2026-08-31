/**
 * Distance from the venue — the arithmetic an admin will act on.
 *
 * The venue point used throughout is the one the gate tablet itself established: the median of
 * 844 punches from "Official tt gate Redme tab", which cluster inside about 17 m x 32 m. That
 * is not a test fixture invented for convenience — it is the real reference this feature
 * measures against, so a bug in the maths shows up here as a wrong number about a real place.
 */
import { describe, expect, it } from "vitest";
import { distanceFromVenue, formatDistance, type VenuePoint } from "./venueDistance";

const VENUE: VenuePoint = {
  lat: 12.864249,
  lng: 77.563386,
  radiusM: 300,
  name: "Tamarind Tree, Avalahalli",
};

const fix = (latitude: number, longitude: number, accuracyMetres: number | null = 20) => ({
  latitude,
  longitude,
  accuracyMetres,
});

describe("distanceFromVenue", () => {
  it("returns null when nobody has told the system where the venue is", () => {
    /*
      `locations.lat/lng` were NULL in production for this system's whole life — which is why
      `geofence_ok` was false on all 908 punches, not because anybody was outside a fence. Null
      must stay null: a fallback centre would put a number on screen that looks measured and is
      guessed.
    */
    expect(distanceFromVenue(fix(12.9, 77.6), null)).toBeNull();
  });

  it("is zero at the venue itself", () => {
    expect(distanceFromVenue(fix(VENUE.lat, VENUE.lng), VENUE)?.metres).toBeCloseTo(0, 6);
  });

  it("puts the gate tablet's own spread well inside the fence", () => {
    // The far corner of the observed cloud: +0.000156 lat, +0.000296 lng.
    const corner = distanceFromVenue(fix(VENUE.lat + 0.000156, VENUE.lng + 0.000296), VENUE);
    expect(corner).not.toBeNull();
    expect(corner?.metres).toBeLessThan(50);
    expect(corner?.withinFence).toBe(true);
  });

  it("puts somebody punching from a few kilometres away outside it", () => {
    // ~0.05 degrees of latitude is roughly 5.5 km.
    const away = distanceFromVenue(fix(VENUE.lat + 0.05, VENUE.lng), VENUE);
    expect(away?.withinFence).toBe(false);
    expect(away?.metres).toBeGreaterThan(5_000);
    expect(away?.metres).toBeLessThan(6_000);
  });

  it("marks a fix too coarse to resolve the fence, without discarding it", () => {
    /*
      A +/-800 m reading against a 300 m radius has an error bar wider than the thing measured,
      so it must not read as a clean inside/outside. It is still kept: 5 km out is 5 km out even
      at +/-800 m, and nulling it would throw away real evidence.
    */
    const coarse = distanceFromVenue(fix(VENUE.lat + 0.05, VENUE.lng, 800), VENUE);
    expect(coarse?.coarse).toBe(true);
    expect(coarse?.metres).toBeGreaterThan(5_000);

    expect(distanceFromVenue(fix(VENUE.lat + 0.05, VENUE.lng, 20), VENUE)?.coarse).toBe(false);
  });
});

describe("formatDistance", () => {
  it("reads the way somebody would say it out loud", () => {
    expect(formatDistance(0)).toBe("0 m");
    expect(formatDistance(12)).toBe("12 m");
    expect(formatDistance(417)).toBe("420 m");
    expect(formatDistance(3_420)).toBe("3.4 km");
    expect(formatDistance(42_000)).toBe("42 km");
  });

  it("does not claim precision the fix never had", () => {
    /*
      These readings are accurate to tens of metres, so "417 m" asserts a precision the GPS did
      not have. Rounded to 10 m above 20 m, and to 0.1 km above a kilometre.
    */
    expect(formatDistance(417)).not.toContain("417");
    expect(formatDistance(3_426)).toBe("3.4 km");
  });

  it("switches units at a kilometre, not before", () => {
    expect(formatDistance(999)).toContain("m");
    expect(formatDistance(999)).not.toContain("km");
    expect(formatDistance(1_000)).toContain("km");
  });
});
