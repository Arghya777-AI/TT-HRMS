/**
 * ProfileTabs.tsx — the E-07 tab strip, built from ROUTES.
 *
 * Not a `<Tabs>` component with local state: every tab is a real URL
 * (`/me/profile/basic` … `/me/profile/history`), deep-linkable and back-button
 * correct, which is the "no mega-tab pages" invariant (spec-employee §0) and
 * DR-48's "tab strips only with ≥2 tabs".
 *
 * The strip scrolls horizontally in its own container below 768px so the PAGE
 * never scrolls sideways — the eight-tab strip is exactly the kind of wide
 * content that otherwise breaks a 360px viewport.
 *
 * The Salary tab is listed and rendered as a link because its route exists in the
 * manifest, but it is marked `phase: 'P1.5'` there: the router shows the honest
 * "not switched on yet" stub rather than an empty card. It is not this build's
 * screen and is not faked here.
 */
import { NavLink } from "react-router-dom";
import { t, type MessageKey } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";

interface TabDef {
  readonly to: string;
  readonly labelKey: MessageKey;
}

/** Paths are the manifest paths verbatim — the registry keys must match these. */
const TABS: readonly TabDef[] = [
  { to: "/me/profile/basic", labelKey: "profile.tab.basic" },
  { to: "/me/profile/employment", labelKey: "profile.tab.employment" },
  { to: "/me/profile/payment", labelKey: "profile.tab.payment" },
  { to: "/me/profile/personal", labelKey: "profile.tab.personal" },
  { to: "/me/profile/custom", labelKey: "profile.tab.custom" },
  { to: "/me/profile/documents", labelKey: "profile.tab.documents" },
  { to: "/me/profile/salary", labelKey: "profile.tab.salary" },
  { to: "/me/profile/history", labelKey: "profile.tab.history" },
];

export function ProfileTabs() {
  return (
    <nav aria-label={t("profile.tabs.label")} className="mb-6 border-b">
      <ul className="-mb-px flex gap-1 overflow-x-auto pb-px">
        {TABS.map((tab) => (
          <li key={tab.to} className="shrink-0">
            <NavLink
              to={tab.to}
              className={({ isActive }) =>
                cn(
                  "inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "border-primary text-foreground"
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
