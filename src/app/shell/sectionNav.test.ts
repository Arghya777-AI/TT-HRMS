/**
 * sectionNav.test.ts — the reachability guarantee, asserted rather than assumed.
 *
 * The bug this defends against has already happened on this project: a feature was
 * built onto a screen that had no way in, and the client reported — correctly — that
 * the feature did not exist. Thirty-five screens were reachable only by typing a URL.
 *
 * So the property under test is not "the component renders". It is: EVERY clickable
 * screen in a covered section appears in that section's strip, and every tab points
 * at a screen that actually exists.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HIDDEN_FROM_NAV, ROUTES } from "@/app/route-manifest";
import { SECTION_NAV_LABEL, hasSectionNav, sectionRoutes } from "./sectionNavModel";
import { KIOSK_TAB_PATHS } from "@/features/admin/components/KioskSectionNav";
import { en } from "@/shared/i18n/en";

const COVERED = Object.keys(SECTION_NAV_LABEL);

/**
 * Sections allowed to have no generic strip, each for a stated reason.
 *
 * This list is the ONLY way out of the rule below, which is the point: skipping a
 * section now requires writing down why, in a file somebody reviews.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  "admin-kiosk":
    "has KioskSectionNav, whose tab order follows the enrolment workflow; two strips would render on one page",
  profile:
    "has ProfileTabs, mounted by the profile pages themselves; a second strip would sit directly above it",
  team:
    "seven of its eight screens are their own rail rows, so a strip would repeat the rail verbatim",
};

describe("every section with more than one screen has a strip", () => {
  /*
    THIS REPLACED A LIST OF SIX DOMAIN NAMES.

    The old version asserted that the six sections the client had named were
    covered. It passed for a year while seven other sections — assets, people,
    attendance, communications, workflow, audit and the command centre — had none,
    which is fifty screens with no tab. It could not have failed: it only ever
    checked the six that already worked.

    A test that lists what was fixed proves the fix happened once. This asserts the
    RULE, so the next section inherits it without anybody remembering to.
  */
  const domains = [...new Set(ROUTES.map((r) => r.domain))];

  for (const domain of domains) {
    const clickable = ROUTES.filter((r) => r.domain === domain && !r.path.includes(":"));
    // One screen needs no strip: there is nowhere else in the section to go.
    if (clickable.length < 2) continue;
    if (Object.prototype.hasOwnProperty.call(EXEMPT, domain)) continue;

    it(`${domain} (${String(clickable.length)} screens) is covered`, () => {
      expect(
        hasSectionNav(domain),
        `${domain} has ${String(clickable.length)} screens and no tab strip, so ` +
          `${String(clickable.length - 1)} of them can only be reached by ⌘K or by typing ` +
          `the URL. Add it to SECTION_NAV_LABEL, or to EXEMPT with a reason.`,
      ).toBe(true);
    });
  }

  it("covers something — a manifest that stopped parsing would empty this file", () => {
    expect(domains.length).toBeGreaterThan(10);
  });
});

describe("a section with ONE screen is in the rail, since it gets no strip", () => {
  /*
    The gap in the rule above, found by reading its own output: a section with a
    single screen is skipped — correctly, because a one-tab strip is furniture —
    and that skip was silently also excusing it from having any entrance at all.

    `/me/documents` was exactly that. The rail row labelled "Documents" pointed at
    `/me/profile/documents`, a different screen in a different section, so the page
    holding everything issued to and signed by the employee had no door. It is a
    single-screen section, so the strip rule skipped it, and it is not `:code`
    parameterised, so nothing else objected.
  */
  const RAIL = readFileSync(join(process.cwd(), "src/app/shell/nav-model.ts"), "utf8");

  const singles = [...new Set(ROUTES.map((r) => r.domain))]
    .map((domain) => ({
      domain,
      routes: ROUTES.filter((r) => r.domain === domain && !r.path.includes(":")),
    }))
    .filter((s) => s.routes.length === 1);

  for (const { domain, routes } of singles) {
    const only = routes[0];
    if (only === undefined) continue;

    it(`${domain}: ${only.path} has a rail row`, () => {
      expect(
        RAIL.includes(`"${only.path}"`),
        `${only.path} is the only screen in its section, so it gets no tab strip, and ` +
          `it has no rail row either — nothing in the app leads to it. Add a NavItem ` +
          `in nav-model.ts pointing at it.`,
      ).toBe(true);
    });
  }

  it("found some to check", () => {
    expect(singles.length).toBeGreaterThan(3);
  });
});

describe("every screen in a covered section is reachable from that section", () => {
  for (const domain of COVERED) {
    it(`${domain}: every clickable route has a tab`, () => {
      /*
        The invariant is "no screen is reachable only by URL", and it is worth
        keeping. `HIDDEN_FROM_NAV` is its one exception, and an ENUMERATED one:
        a route in that set is deliberately unadvertised — comp-off, at the
        venue's request — rather than forgotten. Reading the exception from the
        manifest means a future hide has to be written down in a reviewable place
        instead of being achieved by deleting a tab and hoping.
      */
      const clickable = ROUTES.filter(
        (r) => r.domain === domain && !r.path.includes(":") && !HIDDEN_FROM_NAV.has(r.path),
      );
      const tabbed = new Set(sectionRoutes(domain).map((t) => t.path));
      const missing = clickable.filter((r) => !tabbed.has(r.path)).map((r) => r.path);
      expect(
        missing,
        `${domain} has screens with no tab, so they are reachable only by URL: ${missing.join(", ")}`,
      ).toEqual([]);
    });

    it(`${domain}: has at least two tabs, or the strip would be furniture`, () => {
      // `SectionNav` returns null below two. A covered section that never renders is
      // a silent no-op, which reads as "built" while changing nothing.
      expect(sectionRoutes(domain).length).toBeGreaterThanOrEqual(2);
    });
  }
});

describe("tabs point at real screens", () => {
  it("every tab path exists in the manifest", () => {
    const known = new Set(ROUTES.map((r) => r.path));
    for (const domain of COVERED) {
      for (const tab of sectionRoutes(domain)) {
        expect(known.has(tab.path), `${tab.path} is not a manifest route`).toBe(true);
      }
    }
  });

  it("no parameterised path becomes a tab", () => {
    // `/admin/people/:code` is not a URL anybody can click.
    for (const domain of COVERED) {
      for (const tab of sectionRoutes(domain)) {
        expect(tab.path.includes(":"), `${tab.path} is parameterised`).toBe(false);
      }
    }
  });
});

describe("the two strips do not both claim one page", () => {
  it("admin-kiosk is NOT covered by the generic strip", () => {
    /*
      `KioskSectionNav` is mounted by the kiosk pages themselves and its tab order is
      hand-tuned to the enrolment workflow. Covering `admin-kiosk` here as well would
      render two strips on every kiosk screen.
    */
    expect(hasSectionNav("admin-kiosk")).toBe(false);
    expect(KIOSK_TAB_PATHS.length).toBeGreaterThan(0);
  });
});

describe("labels exist", () => {
  it("every covered section's aria-label is a real message key", () => {
    for (const [domain, key] of Object.entries(SECTION_NAV_LABEL)) {
      expect(Object.prototype.hasOwnProperty.call(en, key), `${domain} -> ${key} missing`).toBe(
        true,
      );
    }
  });
});

describe("routes hidden from navigation are hidden, not broken", () => {
  /*
    The danger with an exception list is that it becomes a place to bury a route
    that no longer works. Each hidden path must still be a REAL manifest entry —
    so "unadvertised" can never quietly become "deleted and forgotten".
  */
  it("every hidden path is still a served route", () => {
    const served = new Set(ROUTES.map((r) => r.path));
    const dangling = [...HIDDEN_FROM_NAV].filter((p) => !served.has(p));
    expect(
      dangling,
      `HIDDEN_FROM_NAV names paths the router does not serve: ${dangling.join(", ")}`,
    ).toEqual([]);
  });

  it("stays small enough to be read", () => {
    // Hiding is a per-request decision, not a mechanism for tidying the rail.
    expect(HIDDEN_FROM_NAV.size).toBeLessThanOrEqual(6);
  });
});
