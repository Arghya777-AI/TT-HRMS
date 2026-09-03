/**
 * When a location sample is taken, and when it is not.
 *
 * The venue asked for continuous background GPS and holds signed consent for tracking. The
 * consent settles whether; the platform settles how much. A web page cannot sample position
 * in the background — `watchPosition` is suspended when the page is hidden and the API is not
 * exposed to service workers — so this trail is bounded to when the app is open, and these
 * assertions pin the throttles that keep it affordable and the guard that keeps it honest.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_ACCURACY_M,
  MIN_INTERVAL_MS,
  MIN_MOVE_M,
  metresBetween,
  shouldRecord,
  type Sample,
} from "./locationTrail";

const at = (mins: number): number => new Date("2026-09-03T09:00:00Z").getTime() + mins * 60_000;
const s = (over: Partial<Sample> = {}): Sample => ({
  lat: 12.864272, lng: 77.563372, accuracyM: 12, at: at(0), ...over,
});

describe("the first fix of a session", () => {
  it("is always recorded", () => {
    // "Arrived and never moved" must appear once, not never.
    expect(shouldRecord(s(), null)).toEqual({ record: true });
  });
});

describe("both throttles apply, not either", () => {
  it("skips a second reading within five minutes", () => {
    const first = s();
    expect(shouldRecord(s({ at: at(4), lat: 12.9 }), first)).toEqual({ record: false, why: "too_soon" });
  });

  it("skips a reading that has not moved fifty metres", () => {
    /*
      Time alone would write a dozen identical points for somebody at a desk. That is the cost
      the venue asked about directly.
    */
    const first = s();
    expect(shouldRecord(s({ at: at(30) }), first)).toEqual({ record: false, why: "too_close" });
  });

  it("records once both are satisfied", () => {
    const first = s();
    expect(shouldRecord(s({ at: at(30), lat: 12.891 }), first)).toEqual({ record: true });
  });

  it("measures movement from the last RECORDED point, not the last seen", () => {
    /*
      Otherwise a slow drift — forty metres every four minutes — is never written at all while
      the person walks across the city. Every intermediate reading is skipped, and the next
      comparison is still against the last one stored.
    */
    const recorded = s();
    const drifting = s({ at: at(6), lat: 12.864672 });   // ~44 m, under the floor
    expect(shouldRecord(drifting, recorded).record).toBe(false);
    const later = s({ at: at(12), lat: 12.865172 });      // ~100 m from `recorded`
    expect(shouldRecord(later, recorded)).toEqual({ record: true });
  });
});

describe("a reading too coarse to mean anything is discarded", () => {
  it("refuses an IP-located desktop fix", () => {
    /*
      A desktop with no GPS is located by IP and comes back accurate to kilometres. Drawn on a
      map beside a phone's 8-metre fix it invites somebody to read a city-sized circle as a
      place. The punch path refuses beyond the same 2 km.
    */
    expect(shouldRecord(s({ accuracyM: 5_000 }), null)).toEqual({ record: false, why: "too_coarse" });
    expect(MAX_ACCURACY_M).toBe(2_000);
  });

  it("checks accuracy before the throttles, so a coarse first fix is not stored", () => {
    // Ordering matters: the first-fix rule would otherwise wave a 5 km reading straight through.
    expect(shouldRecord(s({ accuracyM: 5_000 }), null).record).toBe(false);
  });

  it("accepts a reading with no accuracy figure rather than inventing one", () => {
    expect(shouldRecord(s({ accuracyM: null }), null)).toEqual({ record: true });
  });
});

describe("the distance maths", () => {
  it("agrees with the venue geofence's own radius", () => {
    // ~3 km due north of the venue, the same check the SQL side makes.
    const d = metresBetween(s(), s({ lat: 12.891 }));
    expect(d).toBeGreaterThan(2_800);
    expect(d).toBeLessThan(3_100);
  });

  it("is zero for the same point", () => {
    expect(metresBetween(s(), s())).toBeCloseTo(0, 6);
  });
});

describe("the throttles are the documented ones", () => {
  it("five minutes and fifty metres", () => {
    expect(MIN_INTERVAL_MS).toBe(300_000);
    expect(MIN_MOVE_M).toBe(50);
  });
});

// -----------------------------------------------------------------------------
// The trail is actually wired up
// -----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
/*
  Block AND line comments. The first version stripped only block comments, and a `//` reading
  "expose the object and throw on use" then failed the no-throw assertion below — a comment
  masquerading as code, which is the exact failure mode these strips exist to prevent.
*/
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("it is mounted where it survives navigation", () => {
  const shell = strip(read("src", "app", "shell", "AppShell.tsx"));
  const hook = strip(read("src", "features", "attendance", "hooks", "useLocationTrail.ts"));

  it("lives in the shell, not on a page", () => {
    /*
      On a page it would restart the watch and re-record a first fix on every navigation
      between My Attendance and Apply.
    */
    expect(shell).toContain("useLocationTrail({ enabled: employee !== null })");
  });

  it("is off for an account with no employee record", () => {
    // An admin-only login has no attendance to trail.
    expect(shell).toContain("employee !== null");
  });

  it("tears the watch down when the tab is hidden", () => {
    /*
      The browser suspends it anyway, but leaving it registered produces a burst of stale
      readings on return, all timestamped at once.
    */
    expect(hook).toContain('document.addEventListener("visibilitychange", onVisibility)');
    expect(hook).toContain('document.removeEventListener("visibilitychange", onVisibility)');
  });

  it("advances the cursor only on a write that landed", () => {
    // Otherwise a dropped request silently opens a five-minute hole in the trail.
    expect(hook).toContain("if (!error) lastRecorded.current = sample;");
  });

  it("never throws, and renders nothing", () => {
    /*
      A refused permission or a device with no GPS is not the employee's problem to solve
      mid-shift, and must not interrupt them or affect a punch. Every failure path in the hook
      swallows: `watchPosition`'s error callback is `() => undefined`, the RPC's rejection is
      too, and both geolocation calls sit in try/catch.
    */
    expect(hook).not.toContain("throw ");
    expect(hook).toContain("() => undefined");
    /*
      A hook, not a component: its signature returns void. Dropped a `not.toContain("return (")`
      here — the effect's own cleanup is `return () => {...}`, which matches it. The signature
      is the honest check.
    */
    expect(hook).toContain("): void {");
  });

  it("records through the server function, so the venue distance is not computed here", () => {
    // `within_shift` and the distance are facts about the moment of capture.
    expect(hook).toContain('const RECORD_FN = "record_location_ping"');
    expect(hook).not.toContain("from(\"employee_location_pings\")");
  });

  it("is permitted by the deployed Permissions-Policy", () => {
    // `geolocation=(self)` — without it the watch is blocked by the browser, silently.
    expect(read("vercel.json")).toContain("geolocation=(self)");
  });
});
