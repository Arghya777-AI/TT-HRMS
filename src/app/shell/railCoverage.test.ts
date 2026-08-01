/**
 * Every admin section must have a rail entry.
 *
 * WHY THIS EXISTS. `reachability.test.ts` proves the command palette can FIND every route,
 * and that test passed while an entire seven-screen section had no entry in the navigation
 * rail. Search is a fallback for somebody who already knows the screen exists; the rail is
 * how anybody discovers that it does. Two sections have now been reported missing for
 * exactly this reason — Face & kiosk (nine screens) and Time & policy (seven) — and both
 * were reported as "where is that option?" while being told which menu to open.
 *
 * So this asserts coverage by DOMAIN rather than by route. A section landing plus its own
 * tabs is the intended pattern: `/admin/time/shifts` is the entry and the other six time
 * screens hang off its section nav. Demanding a rail item per route would be wrong and
 * would push people to add fifty. Demanding one per domain is the actual rule.
 */
import { describe, expect, it } from "vitest";
import { ROUTES } from "@/app/route-manifest";
import { FOOTER_ITEMS, NAV_GROUPS } from "./nav-model";

/** Every `to` the shell offers anywhere — rail groups plus the footer items. */
const NAV_TARGETS: readonly string[] = [
  ...NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to)),
  ...FOOTER_ITEMS.map((item) => item.to),
];

/** Domain → the routes that belong to it, for admin sections only. */
function adminDomains(): Map<string, string[]> {
  const byDomain = new Map<string, string[]>();
  for (const route of ROUTES) {
    if (!route.path.startsWith("/admin")) continue;
    if (route.path.includes(":")) continue;
    const list = byDomain.get(route.domain) ?? [];
    list.push(route.path);
    byDomain.set(route.domain, list);
  }
  return byDomain;
}

describe("admin rail coverage", () => {
  it("gives every admin domain at least one navigation entry", () => {
    const uncovered: string[] = [];
    for (const [domain, paths] of adminDomains()) {
      const covered = paths.some((path) => NAV_TARGETS.includes(path));
      if (!covered) uncovered.push(`${domain} (${paths.length} screens, e.g. ${paths[0] ?? "?"})`);
    }
    expect(
      uncovered,
      "admin sections with no way in except typing a URL — add a rail entry pointing at the section's landing screen",
    ).toEqual([]);
  });

  it("covers time & policy specifically — the section this test was written for", () => {
    const timePaths = adminDomains().get("admin-time") ?? [];
    expect(timePaths.length).toBeGreaterThan(0);
    expect(timePaths.some((path) => NAV_TARGETS.includes(path))).toBe(true);
  });

  it("covers face & kiosk, the same defect found earlier", () => {
    const kioskPaths = adminDomains().get("admin-kiosk") ?? [];
    expect(kioskPaths.length).toBeGreaterThan(0);
    expect(kioskPaths.some((path) => NAV_TARGETS.includes(path))).toBe(true);
  });

  it("points every navigation entry at a route that exists", () => {
    const known = new Set(ROUTES.map((route) => route.path));
    const dangling = NAV_TARGETS.filter(
      (to) => !known.has(to) && !to.startsWith("/me/") && !to.startsWith("/team"),
    );
    // `/me/*` and `/team*` targets include redirects and section defaults; the admin ones
    // must resolve to a real manifest route, since that is where the gaps have appeared.
    expect(dangling.filter((to) => to.startsWith("/admin"))).toEqual([]);
  });
});
