/**
 * legacySafari.test.ts — the gate has to run on iOS 12.5.7.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The terminal is an iPad on iOS 12.5.7 — the terminal release for the iPad Air 1 and
 * mini 2/3, hardware that is fine for a wall-mounted scanner and will never get another
 * major iOS. It ships Safari 12.1, which predates OPTIONAL CHAINING and NULLISH
 * COALESCING (both Safari 13.1).
 *
 * At `build.target: "es2020"` esbuild kept both, and the shipped gate bundle carried 52
 * `?.` and 85 `??`. A module that cannot be PARSED executes nothing — there is no runtime
 * in which an error could even be thrown — so the terminal was a black screen with no
 * message. That is the whole of "the link is not opening in Safari".
 *
 * Nothing else catches this. `tsc` is happy, `vite build` exits 0, every other test passes,
 * and the app runs perfectly on the laptop it was built on. The failure appears only on the
 * device, and only as an absence. So this reads the real `dist/` output, like
 * `bundleBudget.test.ts`, and for the same reason: this class of fault lives in the build
 * artefact, not the source.
 *
 * SKIPS with no `dist/`, so a clean checkout is not a failure — and fails loudly once a
 * build exists and would not start on the gate.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const ASSETS = join(DIST, "assets");
const KIOSK_HTML = join(DIST, "kiosk", "index.html");
const built = existsSync(KIOSK_HTML) && existsSync(ASSETS);

/**
 * Every chunk the gate can pull in, concatenated.
 *
 * Deliberately not just the entry: the parse failure was in a shared vendor chunk, and a
 * chunk that is only reached when the camera opens still has to parse when it is reached.
 */
function gateChunks(): string {
  const html = readFileSync(KIOSK_HTML, "utf8");
  const referenced = new Set(
    [...html.matchAll(/\/assets\/([A-Za-z0-9_.-]+\.js)/g)].map((m) => m[1]!),
  );
  // Plus the lazily-imported ones, which the HTML never names.
  for (const file of readdirSync(ASSETS)) {
    if (/^(kiosk|index|face|camera|geolocation)[-.]/.test(file) && file.endsWith(".js")) {
      referenced.add(file);
    }
  }
  return [...referenced].map((f) => readFileSync(join(ASSETS, f), "utf8")).join("\n");
}

describe.skipIf(!built)("the gate bundle parses on Safari 12", () => {
  const code = built ? gateChunks() : "";

  it("ships no optional chaining", () => {
    /*
      `?.` cannot be matched literally: minified ternaries produce `x==null?.01:x`, which is
      `?` followed by the number `.01`. Optional chaining is always followed by an
      identifier, a `(` or a `[`, and never by a digit — that is what separates them.
    */
    const hits = [...code.matchAll(/\?\.(?![0-9])/g)];
    expect(hits.length, `found ${hits.length} optional-chaining sites`).toBe(0);
  });

  it("ships no nullish coalescing outside a worker source string", () => {
    /*
      face-api embeds a Web Worker as a STRING, and esbuild cannot reach inside it to lower
      the syntax. The gate never spawns that worker, so it is tolerated and bounded rather
      than ignored — if the count climbs, something new arrived that this reasoning has not
      been applied to.
    */
    const hits = [...code.matchAll(/\?\?[^=]/g)];
    expect(hits.length, "nullish sites outside lowered code").toBeLessThanOrEqual(2);
  });

  it("declares safari12 as the build target, so this stays true", () => {
    const config = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    expect(config).toContain('target: "safari12"');
  });
});

describe.skipIf(!built)("the gate entry polyfills what Safari 12.1 lacks", () => {
  const html = built ? readFileSync(KIOSK_HTML, "utf8") : "";
  const preludes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .join("\n");

  it("runs its preludes before the module esbuild hoists into the head", () => {
    const module = html.indexOf('<script type="module"');
    expect(module).toBeGreaterThan(-1);
    // Vite hoists the entry into <head>. A prelude after it would be armed too late for a
    // load failure, which fires as soon as the fetch settles.
    expect(html.indexOf("<script>")).toBeLessThan(module);
  });

  it.each([
    ["Array.prototype.at", "Array.prototype.at", "Safari 15.4"],
    ["Promise.allSettled", "allSettled", "Safari 13"],
    ["Object.fromEntries", "fromEntries", "Safari 12.1"],
    ["globalThis", "globalThis", "Safari 12.1"],
    ["queueMicrotask", "queueMicrotask", "Safari 12.1"],
  ])("polyfills %s (added in %s)", (_label, token) => {
    expect(preludes).toContain(token);
  });

  it("keeps the preludes free of syntax Safari 12 cannot parse", () => {
    // They exist to report and repair; being unparseable themselves would defeat both.
    const code = preludes.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toMatch(/=>/);
    expect(code).not.toMatch(/\bconst\b/);
    expect(code).not.toMatch(/\blet\b/);
    expect(code).not.toMatch(/\?\?/);
    expect(code).not.toMatch(/\?\.(?![0-9])/);
  });

  it("measures flexbox gap rather than asking @supports about it", () => {
    /*
      `@supports (gap: 1px)` answers YES on Safari 12 — truthfully, about GRID gap, which it
      has had since 10.1. Flex gap arrived in 14.1. Trusting the query leaves every flex gap
      in the gate silently zero, so the support has to be measured.
    */
    expect(preludes).toContain("row-gap:1px");
    expect(preludes).toContain("no-flex-gap");
    expect(html).toContain(".no-flex-gap .flex");
  });

  it("shows something other than a black screen when the module never runs", () => {
    expect(html).toContain('id="kiosk-boot"');
    expect(html).toContain("<noscript>");
  });
});
