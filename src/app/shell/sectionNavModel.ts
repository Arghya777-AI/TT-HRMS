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
import { HIDDEN_FROM_NAV, ROUTES } from "@/app/route-manifest";
import type { MessageKey } from "@/shared/i18n/en";

/**
 * The sections that get a strip, and what to call it for a screen reader.
 *
 * `admin-kiosk` is ABSENT deliberately: it has `KioskSectionNav`, whose tab order is
 * hand-tuned to the enrolment workflow rather than manifest order, and mounting both
 * would put two strips on one page. Sections not listed here simply get none.
 */
export const SECTION_NAV_LABEL: Readonly<Record<string, MessageKey>> = {
  // Analytics FIRST, and it was the omission that mattered most: fourteen screens
  // behind one rail row, including the dashboard itself, with no tabs at all. The
  // client asked where the dashboard was while looking straight at the section that
  // contains it.
  "admin-analytics": "admin.sectionNav.analytics",
  "admin-org": "admin.sectionNav.org",
  "admin-time": "admin.sectionNav.time",
  "admin-payroll": "admin.sectionNav.payroll",
  "admin-leave": "admin.sectionNav.leave",
  "admin-documents": "admin.sectionNav.documents",
  "admin-settings": "admin.sectionNav.settings",

  /*
    ── THE SEVEN THAT WERE MISSED ─────────────────────────────────────────────
    Reported as "I am not getting allocations page in admin sidebar", from
    /admin/assets/master — the one asset screen the rail links to.

    The list above was written from the six sections the client named at the time,
    which made it a record of one conversation rather than a rule. Every section
    NOT on it kept the original defect: the rail carries one row per section, so
    the section's other screens had no tab and no rail row, and were reachable only
    by ⌘K or by typing the URL. That is fifty screens, including every asset screen
    but the master, every approval screen but the inbox, and every audit screen.

    ⌘K does reach them, and `reachability.test.ts` asserts that it does — but
    searching requires knowing the page exists. Browsing is how somebody finds out
    that it does, and browsing is what was missing.

    `admin-kiosk` stays off deliberately (see below). Nothing else does now, and
    `sectionNav.test.ts` asserts the rule rather than this list, so a section added
    tomorrow cannot repeat it.
  */
  "admin-home": "admin.sectionNav.home",
  "admin-people": "admin.sectionNav.people",
  "admin-attendance": "admin.sectionNav.attendance",
  "admin-comms": "admin.sectionNav.comms",
  "admin-assets": "admin.sectionNav.assets",
  "admin-workflow": "admin.sectionNav.workflow",
  "admin-audit": "admin.sectionNav.audit",

  /*
    ── AND THE EMPLOYEE SIDE, WHICH THE NEW TEST FOUND ────────────────────────
    The rule was written for the admin half and immediately failed on seven more
    sections. Two of those were fine and are exempt in the test; these five were
    not:

      · `/me/settings` — the hub that links notification preferences and activity
        — had NO rail row and NO inbound link from any page. Only `/me/settings/
        security` was in the rail, and it does not link back to its own hub.
      · `/me/regularizations` was linked from exactly one page: the "new
        regularization" screen, which you reach through it. A cycle with no door.
      · The seven apply forms hung off the launcher alone, so moving from a travel
        requisition to an asset request meant going back to /me/apply first.
  */
  apply: "me.sectionNav.apply",
  attendance: "me.sectionNav.attendance",
  leave: "me.sectionNav.leave",
  settings: "me.sectionNav.settings",
  ai: "me.sectionNav.ai",
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
  return ROUTES.filter(
    (r) => r.domain === domain && !r.path.includes(":") && !HIDDEN_FROM_NAV.has(r.path),
  ).map((r) => ({
    path: r.path,
    title: r.title,
    cap: r.cap,
  }));
}
