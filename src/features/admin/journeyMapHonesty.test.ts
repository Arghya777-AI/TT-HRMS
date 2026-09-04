/**
 * The journey map's honesty properties — the ones that stop it becoming an accusation.
 *
 * This map joins somebody's recorded positions into a line, and a line is the most
 * over-readable thing on the screen: it looks like a route that was observed. It was not.
 * Nobody watched. The device reported a handful of positions, each with an error radius,
 * while the app happened to be open.
 *
 * Four properties therefore have to hold, and none of them is visible in a typecheck:
 *   1. every point is drawn WITH its accuracy circle, at map scale;
 *   2. when the whole spread is inside that error, the map SAYS SO in words;
 *   3. a gap is dashed, because the route across a closed app is unknown;
 *   4. OpenStreetMap is credited, which its tile licence requires.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const map = strip(read("src", "features", "admin", "components", "JourneyMap.tsx"));
const panel = strip(read("src", "features", "admin", "components", "LocationTrailPanel.tsx"));
const en = read("src", "shared", "i18n", "keys", "claim-evidence.ts");

describe("the error on every reading is drawn, not hidden", () => {
  it("puts a circle of the fix's own accuracy on the map", () => {
    expect(map).toContain("radius: f.accuracy");
  });

  it("draws them under the path, so the line cannot hide them", () => {
    const circles = map.indexOf("radius: f.accuracy");
    const path = map.indexOf("leaflet.polyline");
    expect(circles).toBeGreaterThan(-1);
    expect(path).toBeGreaterThan(circles);
  });

  it("fits the frame to the points AND their error", () => {
    /*
      A single ±35 m fix would otherwise zoom to street level and imply it knows which
      doorway somebody stood in.
    */
    expect(map).toContain("f.accuracy ?? 0");
    expect(map).toContain("maxZoom: widest > 100 ? 15 : 17");
  });
});

describe("when the route is inside the margin of error, it says so", () => {
  it("asks the question and renders the answer", () => {
    // THE REGRESSION THIS EXISTS FOR: silently drawing noise as a journey.
    expect(map).toContain("spreadIsWithinError(toFixes(pings))");
    expect(map).toContain("{noise ? (");
    expect(map).toContain('t("admin.journey.withinError")');
  });

  it("puts that sentence ABOVE the map, not in a caption below it", () => {
    const notice = map.indexOf('t("admin.journey.withinError")');
    const canvas = map.indexOf("ref={host}");
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(canvas);
  });

  it("says a person who did not move produces this map", () => {
    // The wording is the point; a vague "readings may vary" would be ignored.
    // Whitespace-insensitive: the wording matters, the line wrapping does not.
    const flat = en.replace(/"\s*\+\s*"/g, "").replace(/\s+/g, " ");
    expect(flat).toContain("this line is not evidence of movement");
    expect(flat).toContain("stayed in one place produces a map like this");
  });
});

describe("a gap is not a walk", () => {
  it("draws the join across a silence dashed", () => {
    expect(map).toContain("dashArray:");
  });

  it("explains the dashed link where somebody clicks it", () => {
    expect(map).toContain('t("admin.journey.gap"');
    expect(en).toContain("straight guess, not a route");
  });

  it("keeps the panel's own caveat about gaps as well", () => {
    // Two different warnings: a GAP is not absence of person; a LINE is not movement.
    expect(panel).toContain('t("admin.trail.caveat")');
    expect(panel).toContain('t("admin.journey.caveat")');
  });
});

describe("the map behaves on the page it sits on", () => {
  it("credits OpenStreetMap, as the tile licence requires", () => {
    expect(map).toContain("openstreetmap.org/copyright");
    expect(map).toContain("attribution: ATTRIBUTION");
  });

  it("does not swallow the page's scroll", () => {
    // The panel is mid-page; a wheel-zooming map traps the reader inside it.
    expect(map).toContain("scrollWheelZoom: false");
  });

  it("loads Leaflet and its stylesheet only when opened", () => {
    /*
      ~150 KB. A static import lands it in the shell chunk every employee downloads to
      look at a payslip.
    */
    expect(panel).toContain('import("./JourneyMap")');
    expect(panel).toContain("lazy(");
    expect(map).toContain('import("leaflet")');
    expect(map).toContain('import("leaflet/dist/leaflet.css")');
  });

  it("survives the map failing without taking the record down", () => {
    expect(map).toContain("setFailed(true)");
    expect(en).toContain("list of points below is the record");
  });

  it("is offered only when there are two points to join", () => {
    // One position is not a journey.
    expect(panel).toContain("canDrawRoute");
    expect(panel).toContain(".length >= 2");
  });

  it("tears the map down when the panel unmounts", () => {
    // Leaflet leaks its container and handlers otherwise, and this panel remounts per day.
    expect(map).toContain("created?.remove()");
  });
});
