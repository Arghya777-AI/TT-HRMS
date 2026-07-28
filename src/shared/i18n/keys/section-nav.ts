/**
 * i18n keys owned EXCLUSIVELY by `app/shell/SectionNav.tsx`.
 *
 * These are screen-reader labels for the section tab strips, never visible text —
 * the tab labels themselves come from the route manifest's own `title`, so a screen
 * is named identically in the rail, in Cmd-K search and in its section strip. One
 * name per screen, defined once.
 */
export const keysSectionNav = {
  "admin.sectionNav.analytics": "Dashboard and analytics screens",
  "admin.sectionNav.org": "Organisation screens",
  "admin.sectionNav.time": "Time and attendance policy screens",
  "admin.sectionNav.payroll": "Payroll screens",
  "admin.sectionNav.leave": "Leave configuration screens",
  "admin.sectionNav.documents": "Document screens",
  "admin.sectionNav.settings": "Settings screens",
} as const;
