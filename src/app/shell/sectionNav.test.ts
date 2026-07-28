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
import { describe, expect, it } from "vitest";
import { ROUTES } from "@/app/route-manifest";
import { SECTION_NAV_LABEL, hasSectionNav, sectionRoutes } from "./sectionNavModel";
import { KIOSK_TAB_PATHS } from "@/features/admin/components/KioskSectionNav";
import { en } from "@/shared/i18n/en";

const COVERED = Object.keys(SECTION_NAV_LABEL);

describe("the six sections the client named all have a strip", () => {
  for (const domain of [
    "admin-org",
    "admin-time",
    "admin-payroll",
    "admin-leave",
    "admin-documents",
    "admin-settings",
  ]) {
    it(`${domain} is covered`, () => {
      expect(hasSectionNav(domain)).toBe(true);
    });
  }
});

describe("every screen in a covered section is reachable from that section", () => {
  for (const domain of COVERED) {
    it(`${domain}: every clickable route has a tab`, () => {
      const clickable = ROUTES.filter((r) => r.domain === domain && !r.path.includes(":"));
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
