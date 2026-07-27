/**
 * KioskSectionNav — the nine kiosk screens, reachable from each other.
 *
 * WHY THIS EXISTS
 * ---------------
 * The rail carries ONE entry for the whole kiosk section (`/admin/kiosk/enrolment`,
 * labelled "Face & kiosk"), and nine screens live under `/admin/kiosk/*`. The other
 * eight had no rail entry, and the Enrolment Queue's only outbound link went to
 * Face Templates — so Devices, Operators, Match review, Abuse, Consent, Policy and
 * Purge could be reached ONLY by typing a URL.
 *
 * That is how a "Gate link" card was added to the Devices screen and the client,
 * standing on the Enrolment Queue, correctly reported that there was no link
 * anywhere. The card was fine; the screen holding it was unreachable. Building a
 * feature onto an unreachable screen is the same as not building it.
 *
 * WHY A TAB STRIP RATHER THAN NINE RAIL ENTRIES
 * --------------------------------------------
 * The rail has 33 entries across the whole product — roughly one per section. Adding
 * nine kiosk rows would make the kiosk a third of the navigation and push everything
 * else below the fold, and the same argument then applies to Payroll, Leave and
 * Audit. A section strip keeps the rail as an index of sections and makes every
 * screen inside a section one click from every other, which is what was missing.
 *
 * CAPABILITY GATING IS UX ONLY. `cap` hides a tab the person cannot use so they are
 * not sent to a screen that will refuse them — RLS is still the boundary, and the
 * route guard still enforces the capability if somebody types the URL. Purge is
 * super-admin-only and reason-gated on the server; hiding the tab is a courtesy, not
 * the control.
 */
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import type { Capability } from "@/shared/auth/capabilities";

interface KioskTab {
  to: string;
  labelKey: MessageKey;
  /** Omitted = visible to anyone who can already see the kiosk section. */
  cap?: Capability;
}

/**
 * Ordered as the work is actually done, not alphabetically: consent, then
 * enrolment, then the captures, then the hardware, then the people who operate it,
 * then the review and policy screens, and destruction last.
 */
const TABS: readonly KioskTab[] = [
  { to: "/admin/kiosk/enrolment", labelKey: "admin.kiosk.enrolment.title" },
  { to: "/admin/kiosk/templates", labelKey: "admin.kiosk.templates.title" },
  { to: "/admin/kiosk/consent", labelKey: "admin.kiosk.consent.title" },
  { to: "/admin/kiosk/devices", labelKey: "admin.kiosk.devices.title" },
  { to: "/admin/kiosk/operators", labelKey: "admin.kiosk.operators.title" },
  { to: "/admin/kiosk/match-review", labelKey: "admin.kiosk.match.title" },
  { to: "/admin/kiosk/abuse", labelKey: "admin.kiosk.abuse.title" },
  { to: "/admin/kiosk/policy", labelKey: "admin.kiosk.policy.title" },
  // `admin.super`, matching what TemplatePurge itself checks. The server-side
  // capability is `biometric.template.purge`, but that name is not in the UX
  // capability union — only the roles that hold it are — and the page gates on
  // `admin.super`, so the tab must agree with the page rather than invent a check.
  { to: "/admin/kiosk/purge", labelKey: "admin.kiosk.purge.title", cap: "admin.super" },
];

/** Exported for the test that proves every `/admin/kiosk/*` route has a tab. */
export const KIOSK_TAB_PATHS: readonly string[] = TABS.map((tab) => tab.to);

export function KioskSectionNav() {
  const { can } = useAuth();
  const visible = TABS.filter((tab) => tab.cap === undefined || can(tab.cap));

  return (
    <nav aria-label={t("admin.kiosk.sectionNav.label")} className="mt-4 border-b">
      {/* Horizontal scroll rather than wrap: on a tablet the strip stays one line
          and the page below does not shift as tabs reflow. `overflow-x-auto` is on
          the strip alone, so the page body never scrolls sideways. */}
      <ul className="-mb-px flex gap-1 overflow-x-auto pb-0 text-sm">
        {visible.map((tab) => (
          <li key={tab.to} className="shrink-0">
            <NavLink
              to={tab.to}
              // `end` so /admin/kiosk/enrolment is not also matched by a deeper
              // path later; every tab here is a leaf.
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
              {t(tab.labelKey)}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
