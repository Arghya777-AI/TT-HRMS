/**
 * selfPunchContract.test.ts — lock the portal's request body to the EDGE
 * FUNCTION's own schema.
 *
 * WHY THIS EXISTS
 * ---------------
 * The located-punch path shipped dead. `postPunch` posted the browser's
 * `SignInGeo` ({lat, lon, accuracy_m, captured_at, source}) into
 * `attendance-self-punch`'s `Geo` schema, which is `.strict()` and names its
 * fields {latitude, longitude, accuracyMetres}. Four unrecognised keys and two
 * missing ones: every punch WITH a location was a 422, and the geo-less retry
 * then recorded the punch with no coordinates at all — so the geofence was never
 * evaluated and nothing surfaced as a failure. An adversarial review caught it;
 * nothing in the test suite did.
 *
 * That is the gap this file closes. A `.strict()` schema turns a single renamed
 * key into a total outage of one feature, and the two halves live in different
 * runtimes (Deno vs the browser bundle) so the compiler cannot join them.
 *
 * HOW IT AVOIDS BECOMING A SECOND SOURCE OF TRUTH
 * -----------------------------------------------
 * The expected key names are not written here. They are PARSED OUT OF
 * supabase/functions/attendance-self-punch/index.ts at test time, so the server
 * file remains the only definition. Rename a field there and this test fails
 * until the client is updated — which is exactly the coupling that was missing.
 *
 * The function cannot simply be imported: it is Deno, its dependencies use `npm:`
 * specifiers, and `tsconfig.app.json` scopes `include` to `src`. Reading its text
 * is the honest way to reach its contract from here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSelfPunchBody, type SelfPunchRequest } from "./api/selfPunch.api";

const FN_PATH = join(
  process.cwd(),
  "supabase/functions/attendance-self-punch/index.ts",
);

/**
 * Top-level keys of a named `z.object({ … })` in the function source.
 *
 * Deliberately shallow: it counts brace depth so nested objects (`metrics`,
 * `geo`) contribute their own name and not their children, which is precisely
 * the granularity `.strict()` rejects on.
 */
function schemaKeys(source: string, constName: string): string[] {
  const start = source.indexOf(`const ${constName} = z`);
  if (start === -1) throw new Error(`${constName} not found in the function source`);
  // The declarations are formatted `const X = z\n  .object({ … })`, so the `z`
  // and the `.object(` are on different lines — search for the call, not the
  // concatenation.
  const open = source.indexOf(".object({", start);
  if (open === -1) throw new Error(`${constName} is not a z.object`);

  let depth = 0;
  let end = -1;
  for (let i = open + ".object(".length; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`${constName} object never closes`);

  const body = source.slice(open, end);
  const keys: string[] = [];
  let d = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    // Track depth so only keys at the object's own level are collected.
    const before = d;
    d += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (before !== 1) continue;
    const m = /^([A-Za-z_][\w]*)\s*:/.exec(trimmed);
    if (m?.[1] !== undefined) keys.push(m[1]);
  }
  return keys.sort();
}

const REQUEST: SelfPunchRequest = {
  descriptor: Array.from({ length: 128 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1)),
  metrics: {
    detectionScore: 0.91,
    livenessScore: 0.82,
    livenessModel: "frame-motion-heuristic-v1",
    framesAnalysed: 3,
  },
  geo: {
    lat: 12.9716,
    lon: 77.5946,
    accuracy_m: 24,
    captured_at: "2026-07-27T09:00:00+05:30",
    source: "browser",
  },
  deviceId: "browser-device-0001",
  clientEventId: "11111111-2222-4333-8444-555555555555",
};

describe("attendance-self-punch request contract", () => {
  const source = readFileSync(FN_PATH, "utf8");

  it("the function's body schema is .strict() — so an unknown key is fatal, not ignored", () => {
    const idx = source.indexOf("const SelfPunchBody = z");
    expect(idx, "SelfPunchBody not found").toBeGreaterThan(-1);
    expect(source.slice(idx, idx + 1200)).toContain(".strict()");
  });

  it("posts exactly the keys the function accepts, and no others", () => {
    const accepted = schemaKeys(source, "SelfPunchBody");
    const posted = Object.keys(buildSelfPunchBody(REQUEST, "first")).sort();
    expect(posted).toEqual(accepted);
  });

  it("posts geo under the function's own field names", () => {
    const acceptedGeo = schemaKeys(source, "Geo");
    const body = buildSelfPunchBody(REQUEST, "first");
    const geo = body["geo"] as Record<string, unknown>;
    expect(geo, "geo was not included for a located punch").toBeTruthy();
    // Every key posted must be one the schema names. `accuracyMetres` is optional
    // there, so the posted set may be a subset — never a superset.
    for (const key of Object.keys(geo)) expect(acceptedGeo).toContain(key);
    expect(Object.keys(geo)).toContain("latitude");
    expect(Object.keys(geo)).toContain("longitude");
  });

  it("translates the browser geo shape rather than passing it through", () => {
    const geo = buildSelfPunchBody(REQUEST, "first")["geo"] as Record<string, unknown>;
    expect(geo["latitude"]).toBe(12.9716);
    expect(geo["longitude"]).toBe(77.5946);
    // The browser-side names must NOT reach the wire: these four are what made
    // every located punch a 422.
    for (const leaked of ["lat", "lon", "accuracy_m", "captured_at", "source"]) {
      expect(Object.keys(geo)).not.toContain(leaked);
    }
  });

  it("omits geo entirely on the fallback attempt", () => {
    expect(buildSelfPunchBody(REQUEST, "fallback")["geo"]).toBeUndefined();
  });

  it("never asserts an accuracy the browser did not report", () => {
    const noAccuracy = buildSelfPunchBody(
      { ...REQUEST, geo: { ...REQUEST.geo!, accuracy_m: 0 } },
      "first",
    );
    const geo = noAccuracy["geo"] as Record<string, unknown>;
    // 0 would be written into attendance_punches.location_accuracy_m as an
    // invented metre-perfect fix and would neutralise the server's
    // accuracyTooCoarse review flag.
    expect(Object.keys(geo)).not.toContain("accuracyMetres");
  });

  it("metrics uses the function's own metric names", () => {
    const acceptedMetrics = schemaKeys(source, "ProbeMetrics");
    const metrics = buildSelfPunchBody(REQUEST, "first")["metrics"] as Record<string, unknown>;
    for (const key of Object.keys(metrics)) expect(acceptedMetrics).toContain(key);
  });
});
