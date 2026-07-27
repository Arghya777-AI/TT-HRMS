/**
 * i18n keys owned EXCLUSIVELY by the roles-ist work. One file per author — `t()` is
 * typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Copy for the "HR is the Administrator role" explanation on
 * /admin/settings/roles. Written for the client, not for an engineer: no
 * capability strings, no table names, no `super_admin` with an underscore.
 */
export const keysRolesIst = {
  "roles.hrIsAdmin.title": "HR is the Administrator role",
  "roles.hrIsAdmin.body":
    "Tamarind Tree has no separate HR login, and it does not need one. The people who run HR hold the Administrator role, and that role opens every day-to-day screen in this system — people records, attendance and the gate tablets, leave, payroll, documents, announcements, assets, approvals, the audit trail and every report. Nothing HR needs to do its job is held back from it.",

  "roles.superReserved.title": "What Super administrator adds — and why so little",
  "roles.superReserved.body":
    "Super administrator is a safety tier, not a more senior job. It adds only the handful of actions that cannot be undone, or that change who is trusted: granting and revoking roles, deleting an employee record for good, erasing personal or face data, releasing a pay period once it has been locked or writing into a locked one, deleting a payroll run, taking the audit log off this system, changing the security rules, editing a gate tablet's own settings and rotating its secret, and overriding the AI spending cap. Every one of them also asks for a second factor before it will run. Keep the number of people holding it as small as the venue can bear.",

  "roles.legend.title": "What each role means, in plain words",
  "roles.legend.employeeBody":
    "Everyone who works here. Sees and edits only their own record: their attendance, their leave balances, their payslips and their documents. Applies for leave, corrections, claims and equipment.",
  "roles.legend.managerBody":
    "Anyone with people reporting to them. This is worked out from the reporting lines — it is never granted by hand. Sees their team's attendance and leave, plans and publishes the roster, and decides their team's requests. Deliberately cannot see a reportee's salary, bank details, gate photographs or identity numbers.",
  "roles.legend.adminBody":
    "HR, and anyone else running the venue's people operations. Every administration screen, for every employee their scope covers. This is the role HR staff are given.",
  "roles.legend.superAdminBody":
    "One or two trusted people — usually an owner and whoever maintains the system. Everything an Administrator can do, plus the irreversible actions listed above.",
  "roles.legend.scopeNote":
    "An Administrator still only sees the employees their scope covers. The scope register further down this page is where that is set — an Administrator with no scope row can open every screen and will list nobody.",

  "roles.matrix.nesting":
    "The table below is read straight from the database, not written out by hand here. The roles nest: an Administrator holds every capability ticked for Employee, Manager or Administrator. Only the Super administrator column stands on its own.",

  "roles.matrix.narrowerNote":
    "One caution when reading it: this is the role model, and a few individual records are guarded more tightly still by rules that run row by row. Releasing a locked pay period and editing a gate tablet's own settings both sit behind Super administrator even though the row above them is ticked for Administrator — the note beside each of those says so. If an action is refused on the screen that performs it, the row-by-row rule is the one that decided, and it is the stricter of the two.",

  "roles.readOnlyForAdmin":
    "You are signed in as an Administrator, so this page is read-only: you can see every role, every grant and every capability, but granting or revoking a role is a Super administrator action.",
} as const;
