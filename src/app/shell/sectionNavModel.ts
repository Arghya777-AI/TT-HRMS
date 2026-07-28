/**
 * sectionNavModel.ts — which sections get a tab strip, and which screens are in one.
 *
 * SPLIT OUT OF `SectionNav.tsx` because a file that exports both a component and
 * plain constants breaks `react-refresh/only-export-components`: editing it would
 * force a full reload instead of a hot swap. `commandSearch.ts` was split from
 * `CommandPalette.tsx` for exactly this reason — same rule, same shape.
 *
 * The register of screens is `ROUTES` itself. Nothing here re-lists a screen, so a
 * new page appears in its section's strip the moment it joins the manifest.
 */
import { ROUTES } from "@/app/route-manifest";
import type { MessageKey } from "@/shared/i18n/en";

/**
 * The sections that get a strip, and what to call it for a screen reader.
 *
 * `admin-kiosk` is ABSENT deliberately: it has `KioskSectionNav`, whose tab order is
 * hand-tuned to the enrolment workflow rather than manifest order, and mounting both
 * would put two strips on one page. Sections not listed here simply get none.
 */
export const SECTION_NAV_LABEL: Readonly<Record<string, MessageKey>> = {
  "admin-org": "admin.sectionNav.org",
  "admin-time": "admin.sectionNav.time",
  "admin-payroll": "admin.sectionNav.payroll",
  "admin-leave": "admin.sectionNav.leave",
  "admin-documents": "admin.sectionNav.documents",
  "admin-settings": "admin.sectionNav.settings",
};

/** A section has a strip only if it is listed above. */
export function hasSectionNav(domain: string): boolean {
  return Object.prototype.hasOwnProperty.call(SECTION_NAV_LABEL, domain);
}

export interface SectionTab {
  readonly path: string;
  readonly title: string;
  readonly cap: string;
}

/**
 * Clickable, non-parameterised screens of one section, in manifest order.
 *
 * Parameterised paths (`/admin/people/:code`) are excluded: a tab needs a URL you
 * can click, and those are detail screens reached from a list, never section peers.
 *
 * Exported for the test that proves every eligible screen is reachable from its own
 * section — the check that would have caught the unreachable-screen bug.
 */
export function sectionRoutes(domain: string): readonly SectionTab[] {
  return ROUTES.filter((r) => r.domain === domain && !r.path.includes(":")).map((r) => ({
    path: r.path,
    title: r.title,
    cap: r.cap,
  }));
}
