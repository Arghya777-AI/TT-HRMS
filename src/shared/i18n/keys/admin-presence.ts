/**
 * i18n keys owned EXCLUSIVELY by the admin-presence work. One file per author — `t()`
 * is typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Surface: the "on leave today" and "working from home" tiles on the Command Centre,
 * and the leave calendar band beneath them.
 *
 * THE HINTS NAME THE DEFINITION, not the feature. Two of these numbers are easy to
 * confuse with ones already on the screen — "on leave" with the ops band's `off`
 * chip, and "working from home" with "present" — so each hint says what is counted
 * and, where it matters, what is not.
 */
export const keysAdminPresence = {
  "admin.cc.kpi.onLeave": "On leave today",
  "admin.cc.kpi.onLeave.hint":
    "Leave only — weekly offs, holidays and comp-off availed are not counted here.",
  "admin.cc.kpi.onLeave.drill": "See who is on leave",

  "admin.cc.kpi.wfh": "Working from home",
  "admin.cc.kpi.wfh.hint": "Working today, away from the venue.",
  "admin.cc.kpi.wfh.drill": "See who is working remotely",

  // ── Leave calendar band ───────────────────────────────────────────────────
  "admin.cc.calendar.title": "Leave calendar",
  "admin.cc.calendar.subtitle":
    "Every employee's approved and pending leave, by day. Change the month or the year to look ahead or back.",
  "admin.cc.calendar.openFull": "Open the full calendar",
  /*
    Each name in the day popover opens the cancel picker. The label says "manage", not
    "cancel": pressing it opens a dialog where days are chosen, and a button that said
    "cancel" would imply the leave went the moment it was clicked.
  */
  "admin.cc.calendar.manageAria": "Manage {name}'s leave on this day",
  "admin.cc.calendar.empty": "Nobody is on leave this month.",
  "admin.cc.calendar.peopleOnLeave": "{n} on leave",
  "admin.cc.calendar.today": "Today",
  "admin.cc.calendar.weekdayAria": "Day of the week",
  "admin.cc.calendar.dayAria": "{date} — {n} on leave",
  "admin.cc.calendar.monthTotal": "{n} leave day(s) this month, across {people} employee(s)",
  "admin.cc.calendar.yearAria": "Choose the year",
  "admin.cc.calendar.noneOnDay": "Nobody is on leave on this day.",
} as const;

/**
 * "Other…" on the four org lookups in Add Employee / Employee 360.
 *
 * The hint states the consequence out loud — a new master row, visible to everyone
 * from then on — because an admin typing into a box that looks like free text has no
 * other way to know they are editing the org structure.
 */
export const keysOrgOther = {
  "admin.people.other.option": "Other — add a new one",
  "admin.people.other.nameLabel": "New {field}",
  "admin.people.other.nameHint":
    "This is added to the org master, so it appears in this list for everyone from now on.",
  "admin.people.other.namePlaceholder": "e.g. Banquet Operations",
  "admin.people.other.newGradeLevel":
    "New grades are added at the bottom of the band ladder. Reorder them in Org · Grades.",
  "admin.people.other.needName": "Type a name for the new entry, or pick one from the list.",
  "admin.people.other.needDepartment":
    "Choose a department first — a new section has to belong to one.",
  "admin.people.other.created": "{name} was added to the list.",
} as const;
