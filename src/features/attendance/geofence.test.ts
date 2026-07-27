/**
 * geofence.test.ts — the "inside the venue" verdict, which no live punch can
 * currently exercise.
 *
 * WHY IT NEEDS A TEST RATHER THAN A ROUND TRIP
 * -------------------------------------------
 * `geofence_ok` is NULL on every punch in the database, and correctly so:
 * `locations.lat` for TTT-VENUE has never been filled in, so there is nothing to
 * compare a coordinate against. That means the branch that actually decides
 * inside/outside has never run in production and will run for the first time the
 * moment somebody types the venue's position into Admin → Org → Locations. It has
 * to be right before then, not after.
 *
 * The module under test is `supabase/functions/_shared/geofence.ts` — Deno code,
 * but pure: no imports, no Deno APIs, no `Deno.serve`. It is therefore importable
 * here directly, which is the whole reason the maths was moved out of
 * `attendance-self-punch` instead of copied into `kiosk-punch`: ONE implementation,
 * used by both punch paths, testable from the suite everyone already runs.
 *
 * THE THREE-VALUED RESULT IS THE POINT. `false` is an accusation ("this person
 * punched from somewhere else") and NULL is an absence of knowledge ("nobody
 * shared a location, or the venue has none configured"). Collapsing them would
 * flag honest employees the day the venue coordinates are entered, or — worse —
 * before.
 */
import { describe, expect, it } from "vitest";
import {
  circleFromJson,
  evaluateGeofence,
  haversineMetres,
} from "../../../supabase/functions/_shared/geofence";

/** The venue's neighbourhood, so the distances below are realistic rather than antipodal. */
const FENCE = { lat: 12.926880, lng: 77.606018, radiusM: 300 };

describe("haversineMetres", () => {
  it("is zero for a point against itself", () => {
    expect(haversineMetres(FENCE.lat, FENCE.lng, FENCE.lat, FENCE.lng)).toBeCloseTo(0, 6);
  });

  it("measures a known short distance", () => {
    // 0.001° of latitude ≈ 111.2 m anywhere on Earth. A gross unit error (degrees
    // for radians, or a radius in km) shows up immediately here.
    const d = haversineMetres(FENCE.lat, FENCE.lng, FENCE.lat + 0.001, FENCE.lng);
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(115);
  });

  it("is symmetric", () => {
    const there = haversineMetres(12.9, 77.6, 12.95, 77.65);
    const back = haversineMetres(12.95, 77.65, 12.9, 77.6);
    expect(there).toBeCloseTo(back, 6);
  });
});

describe("evaluateGeofence — inside, outside, and NOT KNOWN", () => {
  it("says INSIDE for a fix at the fence centre", () => {
    const v = evaluateGeofence({ latitude: FENCE.lat, longitude: FENCE.lng }, FENCE);
    expect(v.geofenceOk).toBe(true);
    expect(v.distanceM).toBeCloseTo(0, 3);
  });

  it("says INSIDE just within the radius and OUTSIDE just beyond it", () => {
    // ~222 m north (inside 300) and ~556 m north (outside).
    const inside = evaluateGeofence({ latitude: FENCE.lat + 0.002, longitude: FENCE.lng }, FENCE);
    const outside = evaluateGeofence({ latitude: FENCE.lat + 0.005, longitude: FENCE.lng }, FENCE);
    expect(inside.geofenceOk).toBe(true);
    expect(outside.geofenceOk).toBe(false);
    expect(outside.distanceM).toBeGreaterThan(FENCE.radiusM);
  });

  it("treats the boundary as inside", () => {
    // `distance <= radius`. Somebody standing exactly on the line is at work, and
    // a strict `<` would flag them on a rounding.
    const v = evaluateGeofence({ latitude: FENCE.lat, longitude: FENCE.lng }, { ...FENCE, radiusM: 0.5 });
    expect(v.geofenceOk).toBe(true);
  });

  it("returns NULL — not false — when no coordinates were shared", () => {
    // A refused browser permission is an expected outcome, not a violation.
    expect(evaluateGeofence(undefined, FENCE).geofenceOk).toBeNull();
    expect(evaluateGeofence(null, FENCE).geofenceOk).toBeNull();
  });

  it("returns NULL — not false — when the venue has no coordinates", () => {
    // THE CURRENT STATE OF THIS PROJECT. If this ever returned false, every punch
    // in the database would read as "outside the venue" on a screen, which is a
    // false accusation against fifteen people.
    const v = evaluateGeofence({ latitude: FENCE.lat, longitude: FENCE.lng }, null);
    expect(v.geofenceOk).toBeNull();
    expect(v.distanceM).toBeNull();
  });

  it("flags a fix too coarse to resolve the fence, while still giving the verdict", () => {
    // A ±2 km wifi fix cannot decide a 300 m circle. The verdict is evidence and is
    // still returned; `accuracyTooCoarse` is what sends the punch to review instead
    // of letting a guess stand as a finding.
    const v = evaluateGeofence(
      { latitude: FENCE.lat, longitude: FENCE.lng, accuracyMetres: 2000 },
      FENCE,
    );
    expect(v.accuracyTooCoarse).toBe(true);
    expect(v.geofenceOk).toBe(true);
  });

  it("does not flag an ordinary phone fix", () => {
    const v = evaluateGeofence(
      { latitude: FENCE.lat, longitude: FENCE.lng, accuracyMetres: 24 },
      FENCE,
    );
    expect(v.accuracyTooCoarse).toBe(false);
  });

  it("falls back to 300 m rather than fencing nobody in on a bad radius", () => {
    // A zero or negative radius is a misconfiguration, not a circle that excludes
    // everyone — which is what `distance <= 0` would mean for every real punch.
    for (const radiusM of [0, -50, Number.NaN]) {
      const v = evaluateGeofence(
        { latitude: FENCE.lat + 0.001, longitude: FENCE.lng },
        { ...FENCE, radiusM },
      );
      expect(v.geofenceOk, `radius ${radiusM}`).toBe(true);
    }
  });
});

describe("circleFromJson — kiosk_devices.allowed_geofence", () => {
  it("reads a well-formed fence", () => {
    expect(circleFromJson({ lat: 12.9, lng: 77.6, radius_m: 150 })).toEqual({
      lat: 12.9,
      lng: 77.6,
      radiusM: 150,
    });
  });

  it("defaults only the radius, never a coordinate", () => {
    expect(circleFromJson({ lat: 12.9, lng: 77.6 })).toEqual({ lat: 12.9, lng: 77.6, radiusM: 300 });
  });

  it("refuses a half-configured or unreadable fence", () => {
    // The column's CHECK guarantees the KEYS are present, not that they are
    // numbers. Coercing "twelve" to NaN — or a missing longitude to 0 — would put
    // the venue in the Gulf of Guinea and mark every real punch as outside.
    expect(circleFromJson({ lat: 12.9, radius_m: 150 })).toBeNull();
    expect(circleFromJson({ lat: "twelve", lng: 77.6, radius_m: 150 })).toBeNull();
    expect(circleFromJson(null)).toBeNull();
    expect(circleFromJson("nonsense")).toBeNull();
  });
});
