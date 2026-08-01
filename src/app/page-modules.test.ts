/**
 * page-modules.test.ts — import EVERY registered page module.
 *
 * WHY THIS EXISTS
 * ---------------
 * `route-manifest.test.ts` proves each page is REGISTERED. This proves each page
 * can be LOADED. They are different failures, and the second one is the one that
 * has actually bitten this project:
 *
 *   * a page importing a helper that was renamed or never existed
 *     (`errorMessage` instead of `mutationUserMessage` — cost a red build);
 *   * a module that imports a type-only export as a value;
 *   * a circular import between a page and its api/hooks module;
 *   * anything that throws at module scope rather than at render.
 *
 * Every one of those compiles clean under `tsc` in some cases and always passes
 * the registry check, yet the route renders nothing but an error boundary. A
 * lazy route is only exercised when a human clicks it, so with 184 routes and
 * four personas, import-time faults are exactly what a manual pass misses.
 *
 * WHAT THIS DOES NOT PROVE — stated so the green tick is not read as more than it
 * is. This does NOT render the component, so it cannot catch a bad hook call, a
 * missing i18n key used at render time, a query against a column that does not
 * exist, or a broken layout. It proves the module graph resolves and the default
 * export is a component. Nothing more.
 */
import { describe, expect, it } from "vitest";
import { PAGE_REGISTRY } from "@/features/registry";

const entries = Object.entries(PAGE_REGISTRY);

describe("page modules", () => {
  it("registry is not empty (a generated file that silently emptied would pass every other test)", () => {
    expect(entries.length).toBeGreaterThan(150);
  });

  /*
    One test per page: a failure names the exact route, which is what makes the output useful
    when several break at once.

    THE TIMEOUT IS RAISED, and not to paper over a slow page. Each of these is a cold dynamic
    import, so whichever route Vitest happens to run FIRST pays for transforming the shared
    graph behind it — providers, the query client, the design system — while the rest are then
    nearly free. Under load that first import passed 5 s and the suite failed on a different,
    arbitrary route each run (/admin one time, /admin/analytics the next), which reads as a
    broken page and is not one. 20 s is well clear of the observed worst case and still fails
    fast on a page that genuinely cannot load.
  */
  const COLD_IMPORT_TIMEOUT_MS = 20_000;

  for (const [routePath, load] of entries) {
    it(`${routePath} loads and default-exports a component`, async () => {
      const mod = await load();
      expect(mod, `${routePath} resolved to nothing`).toBeTruthy();
      expect(
        typeof mod.default,
        `${routePath} has no default export (found: ${typeof mod.default})`,
      ).toBe("function");
    }, COLD_IMPORT_TIMEOUT_MS);
  }
});
