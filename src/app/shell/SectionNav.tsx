/**
 * SectionNav — every screen in a section, reachable from every other screen in it.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM IT SOLVES
 *
 * The rail carries roughly ONE entry per section. Org has ten screens behind one
 * rail row, Payroll fifteen, Settings eleven. Everything past the first row of each
 * section could be reached only by ⌘K or by typing a URL — and a screen nobody can
 * find is, from the client's side of the desk, a screen that was never built. That
 * exact failure has already happened once on this project: a "Gate link" card was
 * added to a kiosk screen that had no way in, and the client reported, correctly,
 * that there was no link anywhere.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THE TABS COME FROM THE ROUTE MANIFEST, NOT FROM A LIST HERE
 *
 * `ROUTES` is already the single register of every screen, and each entry carries
 * its `domain`. Deriving the strip from it means a new screen appears in its
 * section's strip the moment it is added to the manifest — there is no second list
 * to forget. `KioskSectionNav` hand-lists its nine tabs and has to be edited twice
 * for every change; this cannot fall out of step because there is nothing to sync.
 *
 * WHAT IS EXCLUDED, AND WHY
 *
 *   * Parameterised paths (`/admin/people/:code`). A tab needs a URL you can click,
 *     and `:code` is not one. These are detail screens reached from a list, never
 *     section peers.
 *   * Screens whose capability the reader does not hold. UX ONLY — `RequireCap` on
 *     the route and RLS in the database are the actual boundaries. Hiding a tab
 *     stops somebody being sent to a screen that will refuse them; it is a courtesy,
 *     not a control.
 *   * Sections with one screen. A strip of one tab is furniture, not navigation.
 *
 * Order is the manifest's order, which is spec order — the sequence the work is
 * actually done in, not alphabetical.
 */
import { NavLink } from "react-router-dom";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";

import { SECTION_NAV_LABEL, hasSectionNav, sectionRoutes } from "./sectionNavModel";

export interface SectionNavProps {
  readonly domain: string;
}

export function SectionNav({ domain }: SectionNavProps) {
  const { can } = useAuth();

  const tabs = useMemo(() => {
    if (!hasSectionNav(domain)) return [];
    // `can` takes the UX capability union; the manifest stores it as the same
    // string, so the cast narrows a value that is already correct.
    return sectionRoutes(domain).filter((r) => can(r.cap as Parameters<typeof can>[0]));
  }, [domain, can]);

  // One tab is not navigation, and zero means the reader holds no capability in this
  // section — in which case the route guard is about to say so anyway.
  if (tabs.length < 2) return null;

  const labelKey = SECTION_NAV_LABEL[domain];
  if (labelKey === undefined) return null;

  return (
    <nav aria-label={t(labelKey)} className="mb-4 border-b">
      {/* Horizontal scroll rather than wrap: the strip stays one line on a tablet so
          the page below does not shift as tabs reflow. `overflow-x-auto` is on the
          strip alone, so the page body never scrolls sideways. */}
      <ul className="-mb-px flex gap-1 overflow-x-auto pb-0 text-sm">
        {tabs.map((tab) => (
          <li key={tab.path} className="shrink-0">
            <NavLink
              to={tab.path}
              // `end` so a section index path is not left highlighted while a deeper
              // screen in the same section is open.
              end
              className={({ isActive }) =>
                cn(
                  "block whitespace-nowrap border-b-2 px-3 py-2 transition-colors",
                  isActive
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )
              }
            >
              {tab.title}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
