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
  /*
    Added after "I am not getting allocations page in admin sidebar". The rail links
    one screen per section, so the other five asset screens — allocations, returns,
    history, consumables, exit liability — had no tab and no rail row. The same was
    true of six more sections; see the comment in `sectionNavModel.ts`.
  */
  "admin.sectionNav.home": "Command centre screens",
  "admin.sectionNav.people": "People screens",
  "admin.sectionNav.attendance": "Attendance screens",
  "admin.sectionNav.comms": "Communication screens",
  "admin.sectionNav.assets": "Asset screens",
  "admin.sectionNav.workflow": "Approval and workflow screens",
  "admin.sectionNav.audit": "Audit and compliance screens",

  /*
    The employee side had the same shape, and the test written for the admin half
    found it: `/me/settings` — the hub that links notifications and activity — had
    no rail row and no inbound link from anywhere, so the only way to it was to
    type the URL. `/me/regularizations` had one inbound link, from the page you can
    only reach THROUGH it.
  */
  "me.sectionNav.apply": "Request forms",
  "me.sectionNav.attendance": "My attendance screens",
  "me.sectionNav.leave": "My leave screens",
  "me.sectionNav.settings": "My settings screens",
  "me.sectionNav.ai": "Assistant screens",
} as const;
