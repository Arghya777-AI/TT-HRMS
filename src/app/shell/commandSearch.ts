/**
 * commandSearch.ts — the palette's pure search logic, with no React in it.
 *
 * SPLIT OUT OF `CommandPalette.tsx` because a file that exports both a component and
 * shared functions breaks Fast Refresh (`react-refresh/only-export-components`), and
 * because the ranking is the part worth testing without a DOM: it decides whether
 * typing "loc" offers Locations or a claim form. It got that wrong once already.
 *
 * The event name lives here too, so the shell's dispatcher and the palette's listener
 * reference ONE constant rather than two copies of a string. Two copies is exactly how
 * the search box ended up firing an event nobody listened for.
 */
import { ROUTES, type RouteMeta } from "@/app/route-manifest";

/** The event `AppShell` already dispatches from the search field and from ⌘K. */
export const OPEN_SEARCH_EVENT = "tt:open-search";

/** Long lists stop being scannable; the ranking below puts the best first. */
export const MAX_RESULTS = 12;

/**
 * A parameterised route cannot be navigated to without a value for its parameter,
 * so offering `/admin/people/:code` would send somebody to a screen that renders
 * "undefined". Those are reached from their list screens, by clicking a row.
 */
export function isNavigable(route: RouteMeta): boolean {
  return !route.path.includes(":");
}

/**
 * Every screen this palette can offer: all navigable routes in the manifest.
 *
 * Exported so a test can assert the set is COMPLETE — that is the invariant which
 * makes the palette a real fix rather than a nice extra. If a future route is
 * excluded here, it goes back to being unreachable unless somebody also adds a
 * link, which is exactly the failure this replaces.
 */
export const SEARCHABLE_ROUTES: readonly RouteMeta[] = ROUTES.filter(isNavigable);

/**
 * Score a route against the query. Higher is better; 0 means "no match".
 *
 * Ordering matters more than cleverness here: somebody typing "loc" wants
 * Locations, not "Leave allocation". So a title that STARTS with the query beats a
 * title that merely contains it, which beats a path match, which beats a hit in the
 * one-line hint.
 */
export function score(route: RouteMeta, query: string): number {
  const q = query.toLowerCase();
  const title = route.title.toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  // Word-boundary hit: "policies" should find "Attendance policies".
  if (title.split(/[\s/&—-]+/).some((word) => word.startsWith(q))) return 70;
  if (title.includes(q)) return 60;
  if (route.path.toLowerCase().includes(q)) return 40;
  if (route.hint.toLowerCase().includes(q)) return 20;
  return 0;
}

/**
 * The visible result list for a query. Pure, so it can be tested without a DOM.
 *
 * An EMPTY query returns the first screens rather than nothing: an empty palette
 * would be a dead end again, and this is what stands in for the section navigation
 * a first-time user does not have.
 */
export function rankRoutes(
  routes: readonly RouteMeta[],
  query: string,
  max = MAX_RESULTS,
): readonly RouteMeta[] {
  const q = query.trim();
  if (q === "") return routes.slice(0, max);
  return routes
    .map((route) => ({ route, s: score(route, q) }))
    .filter((r) => r.s > 0)
    /*
      Ties break on the CLOSER TITLE first, then the shorter path.

      Title length before path length is not arbitrary. "loc" prefix-matches both
      "Locations" and "Local claim", so both score 80; breaking on path length put
      `/me/apply/claim` (15 chars) above `/admin/org/locations` (20) and the palette
      answered a search for Locations with a claim form. The shorter TITLE is the
      one the query covers more of, which is the better answer — and path length
      still decides genuine ties like /admin/leave/requests vs a deeper sibling.
    */
    .sort(
      (a, b) =>
        b.s - a.s ||
        a.route.title.length - b.route.title.length ||
        a.route.path.length - b.route.path.length,
    )
    .slice(0, max)
    .map((r) => r.route);
}
