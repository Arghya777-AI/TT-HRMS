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

  it("advances the cursor only once the fix is safe", () => {
    /*
      Either sent OR queued — both mean the fix is kept, so the throttle may move on. What must
      never happen is advancing after a fix was LOST, which would open a five-minute hole.

      Rewritten when offline queueing landed: the old assertion pinned
      `if (!error) lastRecorded.current = sample;`, which no longer exists because the success
      path now also covers the queued case. Pinning the two branches is the durable form.
    */
    const sendBlock = hook.slice(hook.indexOf("const send = "));
    expect(sendBlock).toContain("if (ok) {");
    expect(sendBlock.match(/lastRecorded\.current = sample;/g) ?? []).toHaveLength(2);
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

// -----------------------------------------------------------------------------
// A fix taken with no signal
// -----------------------------------------------------------------------------
/**
 * ── WHY THIS HALF MATTERS MOST ───────────────────────────────────────────────
 * "Even if the internet is not on, then we can access the GPS." Correct — a GPS receiver needs
 * no network. What a phone with no signal cannot do is SEND the reading, so every fix taken in
 * a basement, a lift or a dead zone was previously lost.
 *
 * For staff working away from the venue that is exactly the wrong half to lose: the places with
 * no signal are the places somebody is least accounted for.
 *
 * Verified against the live database before shipping: a fix replayed nine hours late kept its
 * own 12:47 capture instant, was resolved as within-shift FOR THAT MOMENT rather than for the
 * replay, carried `captured_offline = true`, and got its own `synced_at`.
 */
describe("a fix the phone could not send is kept", () => {
  const queue = strip(read("src", "features", "attendance", "lib", "locationQueue.ts"));
  const hook = strip(read("src", "features", "attendance", "hooks", "useLocationTrail.ts"));
  const mig = read("supabase", "migrations", "20260905090000_a_location_taken_offline_still_counts.sql")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

  it("queues it instead of dropping it, unconditionally on the failure path", () => {
    /*
      `toContain("await enqueue({")` alone was too weak — it still passes with
      `if (false) await enqueue({`, which is exactly the regression it should catch. So this
      asserts the call is REACHED: nothing between the success branch's `return` and the
      enqueue may reintroduce a condition.
    */
    /*
      Anchored on the LINE, because slicing from the first `return;` found the in-flight guard
      at the top of `send` rather than the success branch — the assertion then failed against
      correct code, which is the second wrong version of this one check. The enqueue must be a
      statement of its own: `if (false) await enqueue({` puts something before the `await` and
      is caught here.
    */
    const enqueueLine = hook
      .split("\n")
      .find((l) => l.includes("await enqueue({"));
    expect(enqueueLine).toBeDefined();
    expect(enqueueLine?.trim()).toBe("await enqueue({");
    expect(hook).toContain("capturedAt: nowInstantIso(new Date(sample.at))");
  });

  it("keeps the ORIGINAL capture instant, never the sync time", () => {
    /*
      Re-dating a replayed fix would draw somebody teleporting to wherever they regained
      signal, every point at once — and it would be judged against the wrong shift window.
    */
    expect(mig).toContain("public.punch_within_shift(v_emp, p_captured_at, 0)");
    expect(queue).toContain("readonly capturedAt: string");
  });

  it("records the arrival separately, so the delay is visible", () => {
    expect(mig).toContain("synced_at");
    expect(mig).toContain("CASE WHEN COALESCE(p_offline, false) THEN now() ELSE NULL END");
  });

  it("cannot claim it arrived before it was taken", () => {
    expect(mig).toContain("synced_at IS NULL OR synced_at >= captured_at");
  });

  it("treats navigator.onLine as a hint, not a verdict", () => {
    /*
      It reports a network interface, not a reachable server: a captive portal and a dead
      uplink both read as online. So it only decides whether to TRY — anything that fails to
      send is queued whatever the flag claimed, and a false "online" costs a retry rather than
      a lost fix.
    */
    expect(hook).toContain("navigator.onLine === false");
    expect(hook).toContain("const attempt = offline ? Promise.resolve(false) : post(sample, false)");
  });

  it("advances the throttle cursor even when the fix was only queued", () => {
    /*
      The fix is KEPT, so treating it as never-taken would make the next reading compare
      against a stale point, fail the five-minute throttle, and queue a burst of near-identical
      fixes the moment signal returned.
    */
    const queuedBranch = hook.slice(hook.indexOf("await enqueue({"));
    expect(queuedBranch).toContain("lastRecorded.current = sample;");
  });

  it("drains on reconnect, on becoming visible, and at mount", () => {
    // None alone is enough: `online` does not fire if the app was shut when signal returned.
    expect(hook).toContain('window.addEventListener("online", onOnline)');
    expect(hook).toContain('window.removeEventListener("online", onOnline)');
    expect(hook).toContain("void drain();");
  });

  it("stops a drain at the first failure rather than burning every attempt", () => {
    // Three attempts is all a fix gets; spending them on one outage would discard the queue.
    expect(hook).toContain("if (!ok) break;");
  });

  it("does not let two drains overlap", () => {
    expect(hook).toContain("if (draining.current) return;");
  });

  it("drops the OLDEST when full, so it never goes blind", () => {
    /*
      For "where is this person", the newest fix is the one that matters. A queue that refused
      new writes would stop recording at exactly the moment it filled.
    */
    expect(queue).toContain("MAX_QUEUED = 2_000");
    expect(queue).toContain('.index("capturedAt")');
    expect(queue).toContain("cursor.delete()");
  });

  it("keeps its own database, not the gate's", () => {
    // One feature's version bump must not block the other's queue mid-outage.
    expect(queue).toContain('const DB_NAME = "tt-hrms-location"');
    expect(queue).not.toContain('"tt-gate"');
  });

  it("parks a fix the server keeps refusing", () => {
    expect(queue).toContain("MAX_ATTEMPTS = 3");
    expect(queue).toContain("p.attempts < MAX_ATTEMPTS");
  });

  it("never throws out of the queue", () => {
    // A trail is never worth breaking a page for.
    expect(queue).toContain("resolve(null)");
    expect(queue).not.toMatch(/\bthrow\b/);
  });
});
