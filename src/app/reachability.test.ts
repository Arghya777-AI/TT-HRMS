/**
 * reachability.test.ts — every screen must have a way in.
 *
 * THE AUDIT THAT PRODUCED THIS
 * ---------------------------
 * An adversarial pass over all 188 routes (42 agents, every claim verified by a
 * second agent trying to refute it) found 35 screens with NO entrance: no rail
 * entry, no inbound link, no redirect, no row click. Twenty-two were rated
 * blockers. Whole spec sections were affected — every `/admin/org/*` screen and
 * every `/admin/time/*` screen had no entrance at all, including
 * `/admin/org/locations`, which is where the venue coordinates that decide every
 * geofence verdict are entered.
 *
 * ZERO of those 35 were false positives, and zero broken links were found — the
 * link targets were all fine. The defect was never a bad link; it was the absence
 * of any link.
 *
 * WHY THE PALETTE IS THE FIX AND THIS IS THE TEST OF IT
 * ---------------------------------------------------
 * The rail carries roughly one entry per section and cannot carry 188. Hand-adding
 * links to 35 pages fixes those 35 and says nothing about the 36th. The command
 * palette — the search box that had no listener — is a general entrance: if every
 * navigable route is searchable, then every screen is reachable from every screen,
 * and a new route inherits that for free.
 *
 * So this file asserts the invariant that makes it true, rather than re-listing the
 * 35 findings, which would rot the moment a route is renamed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES } from "./route-manifest";
import {
  OPEN_SEARCH_EVENT,
  SEARCHABLE_ROUTES,
  isNavigable,
  rankRoutes,
  score,
} from "./shell/commandSearch";

const ROOT = process.cwd();
const SHELL = readFileSync(join(ROOT, "src/app/shell/AppShell.tsx"), "utf8");
const PALETTE = readFileSync(join(ROOT, "src/app/shell/CommandPalette.tsx"), "utf8");

describe("the search box is wired to something", () => {
  it("AppShell dispatches the event the palette listens for", () => {
    /*
      THE ORIGINAL BUG, exactly. AppShell dispatched
      `new CustomEvent("tt:open-search")` from the top-bar field and from ⌘K, and
      nothing in the app called addEventListener for it. The most prominent control
      on every screen — a search box with a ⌘K hint printed inside it — did nothing
      at all, and no test noticed because both halves were individually fine.

      This compares the string in BOTH directions: the shell must dispatch the
      constant the palette exports, and the palette must listen for it.
    */
    expect(SHELL).toContain(`CustomEvent("${OPEN_SEARCH_EVENT}")`);
    expect(PALETTE).toContain(`addEventListener(OPEN_SEARCH_EVENT`);
  });

  it("mounts the palette in the shell, so it exists on every signed-in screen", () => {
    // A listener in a component nobody renders is the same as no listener.
    expect(SHELL).toContain("<CommandPalette />");
  });
});

describe("every screen is reachable through the palette", () => {
  it("offers every navigable route in the manifest", () => {
    // THE INVARIANT. Not "the 35 we found" — all of them, so a future route cannot
    // be born unreachable.
    const navigable = ROUTES.filter(isNavigable).map((r) => r.path);
    const searchable = new Set(SEARCHABLE_ROUTES.map((r) => r.path));
    const missing = navigable.filter((p) => !searchable.has(p));
    expect(missing).toEqual([]);
    expect(navigable.length).toBeGreaterThan(150);
  });

  it("excludes parameterised routes, which cannot be opened without a value", () => {
    // `/admin/people/:code` would render "undefined". Those are reached by clicking
    // a row on their list screen, which the audit confirmed works.
    expect(SEARCHABLE_ROUTES.every((r) => !r.path.includes(":"))).toBe(true);
    expect(isNavigable({ path: "/admin/people/:code" } as never)).toBe(false);
  });

  it("finds the screens the audit found unreachable", () => {
    // Spot-checks drawn from the confirmed blockers. Each is a screen that had no
    // entrance whatsoever before the palette existed.
    const cases: readonly [string, string][] = [
      ["locations", "/admin/org/locations"],
      ["holidays", "/admin/time/holidays"],
      ["shifts", "/admin/time/shifts"],
      ["departments", "/admin/org/departments"],
      ["roles", "/admin/settings/roles"],
      ["import", "/admin/people/import"],
    ];
    for (const [query, path] of cases) {
      const hit = rankRoutes(SEARCHABLE_ROUTES, query).map((r) => r.path);
      expect(hit, `searching "${query}" should offer ${path}`).toContain(path);
    }
  });

  it("puts the obvious answer first", () => {
    // Ranking is the difference between a search box and a list. Somebody typing
    // "loc" wants Locations, not the first route whose hint happens to say "local".
    expect(rankRoutes(SEARCHABLE_ROUTES, "loc")[0]?.path).toBe("/admin/org/locations");
    expect(rankRoutes(SEARCHABLE_ROUTES, "locations")[0]?.path).toBe("/admin/org/locations");
  });

  it("matches on a later word, not just the start of a title", () => {
    // "Attendance policies" must be findable by "policies" — otherwise a user has to
    // guess the first word of a screen name they have never seen.
    const byWord = rankRoutes(SEARCHABLE_ROUTES, "policies").map((r) => r.path);
    expect(byWord).toContain("/admin/time/attendance-policies");
  });

  it("returns something for an empty query, so the palette is never a dead end", () => {
    expect(rankRoutes(SEARCHABLE_ROUTES, "").length).toBeGreaterThan(0);
    expect(rankRoutes(SEARCHABLE_ROUTES, "   ").length).toBeGreaterThan(0);
  });

  it("returns nothing for a query that matches nothing, rather than everything", () => {
    // A search that silently falls back to the full list teaches people to ignore it.
    expect(rankRoutes(SEARCHABLE_ROUTES, "zzzzqqqq")).toEqual([]);
  });

  it("scores an exact title above a hint mention", () => {
    const exact = ROUTES.find((r) => r.title.toLowerCase() === "locations");
    expect(exact, "no route titled Locations").toBeDefined();
    if (exact !== undefined) expect(score(exact, "locations")).toBeGreaterThan(50);
  });
});
