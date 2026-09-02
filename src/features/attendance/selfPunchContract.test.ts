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

/**
 * Whatever is chained onto a named `z.object({ … })` after it closes.
 *
 * Shares `schemaKeys`' brace-depth scan rather than guessing a byte offset, so the modifiers
 * (`.strict()`, `.optional()`) can be asserted on regardless of what the schema contains.
 */
function afterObject(source: string, constName: string): string {
  const start = source.indexOf(`const ${constName} = z`);
  if (start === -1) throw new Error(`${constName} not found in the function source`);
  const open = source.indexOf(".object({", start);
  if (open === -1) throw new Error(`${constName} is not a z.object`);
  let depth = 0;
  for (let i = open + ".object(".length; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      // One past the matching brace, then past the `)` that closes `.object(`.
      if (depth === 0) return source.slice(source.indexOf(")", i) + 1, i + 200);
    }
  }
  throw new Error(`${constName} object never closes`);
}

/**
 * The chain that follows an inline `z.object({ … })`, found by a marker rather than a name.
 *
 * Brace-depth scan, like `afterObject`, so it survives however many lines and comments the
 * object body runs to. A fixed byte window here is what broke this file's `.strict()` assertion
 * once already.
 */
function chainAfterObjectAt(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`${marker} not found`);
  const open = source.indexOf(".object({", start);
  if (open === -1) throw new Error(`no .object( after ${marker}`);
  let depth = 0;
  for (let i = open + ".object(".length; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(source.indexOf(")", i) + 1, i + 200);
    }
  }
  throw new Error(`object after ${marker} never closes`);
}

/**
 * Whatever follows one field's type inside a named schema — its `.optional()`, say.
 *
 * Scans from the key to the end of its line, tolerating the multi-line comments the schema
 * carries. Enough to tell a required field from an optional one, which is the only thing asked
 * of it.
 */
function afterField(source: string, constName: string, field: string): string {
  const start = source.indexOf(`const ${constName} = z`);
  if (start === -1) throw new Error(`${constName} not found`);
  const at = source.indexOf(`\n    ${field}: `, start);
  if (at === -1) throw new Error(`${field} not found in ${constName}`);
  const from = at + `\n    ${field}: `.length;
  return source.slice(from, source.indexOf("\n", from));
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
    /*
      Scanned to the object's real closing brace, not a fixed 1200-character window from the
      declaration. The window version broke the moment a comment inside the schema grew — it
      reported "SelfPunchBody is not .strict()" when `.strict()` was right there, four lines past
      the cutoff. A test whose truth depends on how verbose the neighbouring comments are is
      worse than no test: this one failed on a change that could not possibly have affected it.
    */
    expect(afterObject(source, "SelfPunchBody")).toMatch(/^\s*\.strict\(\)/);
  });

  it("posts only keys the function accepts, and every one it requires", () => {
    /*
      Two assertions, not one equality, because the body has OPTIONAL fields now.

      It used to be `toEqual`, which was right while every field was mandatory. `reason` is
      sent only for a punch outside the shift window, so a plain in-hours punch legitimately
      omits it — and the equality then failed on a correct request. What actually matters is
      unchanged: `.strict()` rejects a key the function does not know, and a missing REQUIRED
      key is a 422 the employee cannot fix.
    */
    const accepted = schemaKeys(source, "SelfPunchBody");
    const optional = accepted.filter((k) => afterField(source, "SelfPunchBody", k).includes(".optional()"));
    const required = accepted.filter((k) => !optional.includes(k));
    const posted = Object.keys(buildSelfPunchBody(REQUEST, "first")).sort();

    // Nothing the function would reject.
    for (const key of posted) expect(accepted).toContain(key);
    // Everything it insists on.
    for (const key of required) expect(posted).toContain(key);
  });

  it("posts the off-hours reason when there is one, and omits it otherwise", () => {
    /*
      Omitted rather than sent empty: the schema is `.strict()` and an empty string would be a
      value the server then has to decide is not a reason.
    */
    expect(Object.keys(buildSelfPunchBody(REQUEST, "first"))).not.toContain("reason");
    const withReason = buildSelfPunchBody(
      { ...REQUEST, offHoursReason: "Stayed for the evening banquet setup" },
      "first",
    );
    expect(withReason["reason"]).toBe("Stayed for the evening banquet setup");
    // Whitespace is not a reason.
    expect(Object.keys(buildSelfPunchBody({ ...REQUEST, offHoursReason: "   " }, "first")))
      .not.toContain("reason");
  });

  it("requires a 15-character reason outside the shift, in all three layers", () => {
    /*
      The endpoint, the table constraint and the client each enforce it. Three layers because
      the point of a reason is that somebody reads it months later and can tell what happened,
      and "wfh" cannot do that.
    */
    expect(source).toContain("const MIN_OFF_HOURS_REASON = 15;");
    expect(source).toContain("SELF_PUNCH_OFF_HOURS_REASON_REQUIRED");
    // Decided by the SAME resolver the engine uses for lateness.
    expect(source).toContain("public.punch_within_shift(");
    /*
      And checked before the idempotency key is CLAIMED, so a punch refused for a missing
      reason does not consume the key and does not process a face.

      Anchored on `await claim(` — the claim itself. An earlier version of this assertion used
      `requireIdempotencyKey`, which merely READS the header much earlier in the handler, so it
      reported a violation against correct code.
    */
    expect(source.indexOf("public.punch_within_shift("))
      .toBeLessThan(source.indexOf("await claim("));
  });

  it("leaves the GATE alone", () => {
    // A guard and a fixed camera at a known gate already establish the what, where and when.
    const kiosk = readFileSync(
      join(process.cwd(), "supabase/functions/kiosk-punch/index.ts"),
      "utf8",
    );
    expect(kiosk).not.toContain("punch_within_shift");
    expect(kiosk).not.toContain("requires_approval");
  });

  it("makes the location MANDATORY, and the kiosk exempt", () => {
    /*
      A self-punch is the one route where nobody watched the person arrive, so the coordinates
      are the only evidence it happened anywhere in particular. `geo` was `.optional()` and a
      refusal produced `geofence_ok = NULL`; the venue's decision is that this route must carry
      a location.

      Asserted on the schema line itself rather than on prose, because the failure is silent: an
      `.optional()` here does not break anything, it just quietly allows a locationless punch
      again.
    */
    /*
      `toContain`, not an anchored `toMatch`. The first version of this line was
      `/^\s*\.optional\(\)/` against the slice "Geo.optional()," — which starts with "Geo", so
      the anchor never matched and the assertion passed whether the field was optional or not.
      Caught by reintroducing `.optional()` and watching the test stay green.
    */
    expect(afterField(source, "SelfPunchBody", "geo")).not.toContain(".optional()");

    // The gate is a DIFFERENT function, and it must stay location-tolerant: a fixed camera at a
    // known gate with a guard beside it already establishes the place. Its `geo` is declared
    // inline over several lines, so the chain is read by scanning to the object's real close.
    const kiosk = readFileSync(
      join(process.cwd(), "supabase/functions/kiosk-punch/index.ts"),
      "utf8",
    );
    expect(chainAfterObjectAt(kiosk, "geo: z")).toContain(".optional()");
  });

  it("refuses a fix too coarse to mean anything, separately from a missing one", () => {
    /*
      A browser with location "enabled" can still return an IP-derived fix accurate to tens of
      kilometres. That satisfies the letter of the requirement and answers nothing, and stored
      beside a real GPS fix the two are indistinguishable later.
    */
    expect(source).toContain("SELF_PUNCH_LOCATION_TOO_COARSE");
    expect(source).toMatch(/const MAX_ACCURACY_M = 2_000;/);
    // Its own code, because "turn location on" and "your fix is too vague" need different fixes.
    expect(source).toContain('pointer: "/geo/accuracyMetres"');
  });

  it("no longer retries without the coordinates", () => {
    /*
      The client used to strip a rejected `geo` and re-send. Against a function that now requires
      it that can only fail — and it costs a second `secure.face_match_log` refusal row for one
      tap, overstating the evidence a spoofing investigation reads.
    */
    const api = readFileSync(
      join(process.cwd(), "src/features/attendance/api/selfPunch.api.ts"),
      "utf8",
    );
    const code = api.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    expect(code).not.toContain("refusedOnlyTheLocation");
    expect(code).not.toContain('postPunch(request, "fallback"');
  });

  it("stops before the camera when there is no location", () => {
    /*
      Loading the face engine, taking camera permission and capturing frames before discovering
      the request cannot succeed wastes all three and reports the wrong error — the employee is
      told the punch failed, not that location is off.
    */
    const card = readFileSync(
      join(process.cwd(), "src/features/attendance/components/SelfPunchCard.tsx"),
      "utf8",
    );
    expect(card).toContain("if (geoRef.current === null)");
    expect(card).toContain("locationRequiredMessage(location.status)");
    // Before the engine and camera steps, not after them.
    expect(card.indexOf("if (geoRef.current === null)"))
      .toBeLessThan(card.indexOf("await loadFaceModels()"));
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
