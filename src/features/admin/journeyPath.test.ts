/**
 * A route drawn from location pings, and the two things it must never claim.
 *
 * ── THE DATA THIS WAS BUILT AGAINST ──────────────────────────────────────────
 * A real day at this venue, read off the trail panel: ten points between 13:28 and 16:40,
 * each 16 to 60 m from the gate, and every one of them accurate to no better than ±35 m.
 * Joined with a line it reads as somebody walking a route. It is not one — the entire
 * day's spread is inside the error of a single reading, and two fixes 30 m apart, each
 * ±35 m, are exactly what a person who never moved produces.
 *
 * So the map states that in words (`admin.journey.withinError`) rather than leaving a
 * reader to infer it from overlapping circles, and `spreadIsWithinError` is the test it
 * asks. These assertions exist because the failure mode here is not a crash: it is a
 * plausible-looking map used to accuse somebody of leaving the site.
 *
 * The second claim it must not make is continuity. A gap in the trail means the app was
 * CLOSED, so the route across it is unknown; `pathRuns` splits there and the caller draws
 * the join dashed.
 */
import { describe, expect, it } from "vitest";
import { pathRuns, spreadIsWithinError, toFixes, type Fix } from "./journeyPath";
import type { LocationPing } from "./api/locationTrail.api";

const ping = (over: Partial<LocationPing> = {}): LocationPing => ({
  id: crypto.randomUUID(),
  employee_id: "e1",
  captured_at: "2026-09-04T08:00:00.000Z",
  ist_date: "2026-09-04",
  lat: 12.864142,
  lng: 77.563220,
  accuracy_m: 35,
  source: "web_foreground",
  within_shift: true,
  distance_m: 20,
  captured_offline: false,
  synced_at: null,
  ...over,
});

/** A fix at an offset in metres from the venue, for the geometry cases. */
const at = (minutes: number, northMetres: number, accuracy: number | null = 35): Fix => ({
  at: new Date(Date.UTC(2026, 8, 4, 8, minutes)).toISOString(),
  lat: 12.864142 + northMetres / 111_320,
  lng: 77.563220,
  accuracy,
  distance: null,
  coarse: accuracy !== null && accuracy > 2_000,
  offline: false,
});

describe("only real positions are plotted", () => {
  it("drops a ping with half a coordinate", () => {
    /*
      `Number(null)` is 0 and 0 is a real latitude — in the Atlantic. Defaulting here would
      draw a line from Bangalore to the Gulf of Guinea.
    */
    expect(toFixes([ping({ lat: null })])).toHaveLength(0);
    expect(toFixes([ping({ lng: null })])).toHaveLength(0);
  });

  it("keeps a ping that reported no accuracy at all", () => {
    // Unknown accuracy is not the same as a bad position; it is shown and labelled.
    const [f] = toFixes([ping({ accuracy_m: null })]);
    expect(f?.accuracy).toBeNull();
    expect(f?.coarse).toBe(false);
  });

  it("marks a fix too coarse to place anybody", () => {
    const [f] = toFixes([ping({ accuracy_m: 5_000 })]);
    expect(f?.coarse).toBe(true);
  });

  it("preserves the order it was given", () => {
    const out = toFixes([
      ping({ captured_at: "2026-09-04T08:00:00.000Z" }),
      ping({ captured_at: "2026-09-04T09:00:00.000Z" }),
    ]);
    expect(out.map((f) => f.at)).toEqual([
      "2026-09-04T08:00:00.000Z",
      "2026-09-04T09:00:00.000Z",
    ]);
  });
});

describe("a silence is not a straight line", () => {
  it("splits the path where the app was closed", () => {
    // 08:00, 08:05 — then an hour of nothing — then 09:10, 09:15.
    const runs = pathRuns([at(0, 0), at(5, 10), at(70, 20), at(75, 30)]);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(2);
    expect(runs[1]).toHaveLength(2);
  });

  it("keeps one run when the sampling held", () => {
    const runs = pathRuns([at(0, 0), at(5, 10), at(10, 20)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(3);
  });

  it("never joins a coarse fix into the route", () => {
    /*
      THE ONE THAT MATTERS MOST HERE. A 5 km fix plotted mid-route would drag the line
      across the city and read as a trip nobody took.
    */
    const runs = pathRuns([at(0, 0), at(5, 0, 5_000), at(10, 10)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(2);
    expect(runs.flat().every((f) => !f.coarse)).toBe(true);
  });

  it("splits exactly at the boundary and not before it", () => {
    expect(pathRuns([at(0, 0), at(15, 0)])).toHaveLength(1); // 15 min: still one run
    expect(pathRuns([at(0, 0), at(16, 0)])).toHaveLength(2); // 16 min: the app was shut
  });

  it("returns nothing for a day with nothing plottable", () => {
    expect(pathRuns([])).toEqual([]);
    expect(pathRuns([at(0, 0, 5_000)])).toEqual([]);
  });
});

describe("whether the route is movement at all", () => {
  it("calls the venue's real day what it is: inside the error", () => {
    /*
      The screenshot this was built from — a 60 m spread from ±35 m readings. Two readings
      each good to ±35 m can sit 70 m apart with nobody having moved, so 60 m proves
      nothing and the map must say so.
    */
    const day = [at(0, 0), at(5, 20), at(10, 40), at(15, 60)];
    expect(spreadIsWithinError(day)).toBe(true);
  });

  it("does not cry noise when somebody genuinely moved", () => {
    // 500 m apart on ±35 m readings is movement by any reading of the numbers.
    expect(spreadIsWithinError([at(0, 0), at(30, 500)])).toBe(false);
  });

  it("treats a single point as no journey to judge", () => {
    expect(spreadIsWithinError([at(0, 0)])).toBe(true);
    expect(spreadIsWithinError([])).toBe(true);
  });

  it("uses the WORST accuracy among the points, not the best", () => {
    /*
      A 200 m spread looks like movement against a ±8 m reading and like nothing against a
      ±150 m one. Taking the best would let one good fix vouch for a bad one.
    */
    expect(spreadIsWithinError([at(0, 0, 8), at(10, 200, 8)])).toBe(false);
    expect(spreadIsWithinError([at(0, 0, 8), at(10, 200, 150)])).toBe(true);
  });

  it("ignores coarse fixes when judging the spread", () => {
    // Otherwise one 5 km reading would declare every day's movement to be noise.
    expect(spreadIsWithinError([at(0, 0, 20), at(5, 500, 20), at(10, 0, 5_000)])).toBe(false);
  });

  it("does not call it noise when no accuracy was reported", () => {
    // Unknown error is not infinite error; with nothing to compare against, do not excuse.
    expect(spreadIsWithinError([at(0, 0, null), at(10, 500, null)])).toBe(false);
  });
});
