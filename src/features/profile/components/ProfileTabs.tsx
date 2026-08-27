/**
 * ProfileTabs.tsx — the E-07 tab strip, built from ROUTES.
 *
 * Not a `<Tabs>` component with local state: every tab is a real URL
 * (`/me/profile/basic` … `/me/profile/history`), deep-linkable and back-button
 * correct, which is the "no mega-tab pages" invariant (spec-employee §0) and
 * DR-48's "tab strips only with ≥2 tabs".
 *
 * The strip scrolls horizontally in its own container below 768px so the PAGE
 * never scrolls sideways — the six-tab strip is exactly the kind of wide
 * content that otherwise breaks a 360px viewport.
 *
 * NO SALARY TAB AND NO PAYMENT TAB. Both routes still exist and still render
 * their pages (`MySalary.page.tsx`, `ProfilePayment.page.tsx`); what is withdrawn
 * is the employee's way in. Salary's companion change is the "Salary" row removed
 * from the rail in `nav-model.ts` — removing one and leaving the other would hide
 * nothing. Payment's companion is the `BANK_CHANGE` tile suppressed in
 * `ApplyLauncher.page.tsx`, which pointed here.
 *
 * HR AND ADMINS ARE UNAFFECTED: the same fields are on the admin's Employee 360
 * (`admin.p360.tab.payment`), which is a different screen and untouched.
 *
 * TO RESTORE: re-add the entries below, in spec order —
 *   payment between `employment` and `personal`;
 *   salary  between `documents`  and `history`.
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
  { to: "/me/profile/personal", labelKey: "profile.tab.personal" },
  { to: "/me/profile/custom", labelKey: "profile.tab.custom" },
  { to: "/me/profile/documents", labelKey: "profile.tab.documents" },
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
