/**
 * kioskReachability.test.ts — can a human actually GET to every kiosk screen?
 *
 * THE BUG THIS LOCKS OUT
 * ----------------------
 * A "Gate link" card was added to `/admin/kiosk/devices`. The client, standing on
 * `/admin/kiosk/enrolment`, reported that there was no link anywhere — and was
 * right. The rail carries ONE entry for the whole kiosk section, pointing at the
 * Enrolment Queue, and that screen's only outbound kiosk link went to Face
 * Templates. Devices, Operators, Match review, Abuse, Consent, Policy and Purge
 * were reachable only by typing a URL.
 *
 * So the feature was built, typechecked, tested and deployed onto a screen nobody
 * could open. Every gate in this repo passed. A screen with no way in is not a
 * screen, and no unit test of its contents can tell you that.
 *
 * WHAT THIS ASSERTS
 * -----------------
 *   1. Every `/admin/kiosk/*` route in the route manifest has a tab in
 *      `KioskSectionNav` — so a new kiosk screen cannot be added without a way in.
 *   2. Every tab points at a route that actually exists — so a tab cannot send
 *      somebody to a 404 (there was already a live example of this class:
 *      AnalyticsKiosk links to `/admin/kiosk/matches`, which is not a route; the
 *      real path is `/admin/kiosk/match-review`).
 *   3. Every kiosk PAGE renders the section nav — a tab strip that exists but is
 *      not on the screen you are looking at does not help you leave it.
 *   4. The section's rail entry still points at a kiosk route, so the section has
 *      an entrance at all.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIOSK_TAB_PATHS } from "./components/KioskSectionNav";

const ROOT = process.cwd();
const MANIFEST = readFileSync(join(ROOT, "src/app/route-manifest.ts"), "utf8");
const NAV = readFileSync(join(ROOT, "src/app/shell/nav-model.ts"), "utf8");
const PAGES_DIR = join(ROOT, "src/features/admin/pages");

/**
 * Every route path in the manifest. TWO shapes live in that file and reading only
 * one gives a confidently wrong answer:
 *   ME / TEAM   ->  { path: "/me/leave", … }
 *   ADMIN_ROWS  ->  ["/admin/kiosk/devices", "Kiosk Devices", …]
 */
const ROUTES: readonly string[] = [
  ...[...MANIFEST.matchAll(/\bpath:\s*"(\/[^"]*)"/g)].map((m) => m[1] ?? ""),
  ...[...MANIFEST.matchAll(/^\s*\["(\/[^"]*)"/gm)].map((m) => m[1] ?? ""),
].filter((p) => p !== "");

const KIOSK_ROUTES = ROUTES.filter((p) => p.startsWith("/admin/kiosk/"));

/** Kiosk pages, found by their own `@route /admin/kiosk/...` tag. */
const KIOSK_PAGES = readdirSync(PAGES_DIR)
  .filter((f) => f.endsWith(".page.tsx"))
  .map((f) => ({ file: f, code: readFileSync(join(PAGES_DIR, f), "utf8") }))
  .filter((p) => /@route\s+\/admin\/kiosk\//.test(p.code));

describe("kiosk section reachability", () => {
  it("finds the routes and the pages at all — a silent zero would pass everything below", () => {
    expect(ROUTES.length).toBeGreaterThan(150);
    expect(KIOSK_ROUTES.length).toBeGreaterThanOrEqual(9);
    expect(KIOSK_PAGES.length).toBeGreaterThanOrEqual(9);
  });

  it("gives every kiosk route a tab, so a new screen cannot be unreachable", () => {
    const missing = KIOSK_ROUTES.filter((r) => !KIOSK_TAB_PATHS.includes(r));
    expect(missing).toEqual([]);
  });

  it("points every tab at a route that exists", () => {
    const dangling = KIOSK_TAB_PATHS.filter((p) => !ROUTES.includes(p));
    expect(dangling).toEqual([]);
  });

  it("renders the section nav on every kiosk page", () => {
    // A strip that is not on the screen you are stuck on is no exit at all.
    const without = KIOSK_PAGES.filter((p) => !p.code.includes("<KioskSectionNav />")).map(
      (p) => p.file,
    );
    expect(without).toEqual([]);
  });

  it("keeps a rail entry that leads into the section", () => {
    const railTargets = [...NAV.matchAll(/to:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    const entrances = railTargets.filter((p) => p.startsWith("/admin/kiosk/"));
    expect(entrances.length).toBeGreaterThanOrEqual(1);
    // And that entrance must itself be a real route.
    for (const entrance of entrances) expect(ROUTES).toContain(entrance);
  });

  it("shows the gate link on the screen the rail actually lands on", () => {
    // The whole point of the original report. The link lives on Devices AND on the
    // rail's landing screen, because that is where somebody looking for it stands.
    const railTargets = [...NAV.matchAll(/to:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    const landing = railTargets.find((p) => p.startsWith("/admin/kiosk/"));
    expect(landing).toBeDefined();
    const page = KIOSK_PAGES.find((p) =>
      new RegExp(`@route\\s+${landing?.replace(/[/-]/g, "\\$&")}(\\s|$)`).test(p.code),
    );
    expect(page, `no page implements ${landing ?? "(none)"}`).toBeDefined();
    expect(page?.code).toContain("<KioskLinkCard />");
  });
});
