/**
 * capabilities.ts — static role → capability map.
 *
 * UX ONLY. Capabilities decide what navigation/routes the shell *shows*;
 * Row-Level Security decides what data anyone can *read or write*. A user who
 * hand-crafts a URL past a hidden nav item still sees only RLS-scoped data.
 *
 * Role model (spec-admin D-01): `employee`, `admin`, `super_admin` (+
 * `kiosk_operator` capability tier). `public.app_role` has exactly four values
 * and NO `hr` — HR staff hold `admin`, which is why
 * `public.resolve_approver_kind('hr_admin', …)` resolves
 * `user_roles.role = 'admin'`. Manager is DERIVED, never granted
 * (spec-manager D-02-01): the backend computes `is_manager` from reporting
 * lines. Until that flag is live, a `manager` row in `user_roles` (or none at
 * all) is tolerated here — the map treats it as a pseudo-role for nav purposes.
 */

export type Capability =
  | "me.view" // every authenticated employee — all /me/** routes
  | "team.view" // has reportees (derived server-side) — /team/** routes
  | "team.today" // team.view AND a management department — /team only
  | "admin.access" // admin console tier A — most /admin/** routes
  | "admin.super" // super_admin-only routes (tier S)
  | "kiosk.operate"; // guard/operator actions on the kiosk surface

export type RoleName = "employee" | "manager" | "admin" | "super_admin" | "kiosk_operator";

/**
 * Departments whose managers get `team.today`, and therefore Team Today.
 *
 * `team.today` is NOT in `ROLE_CAPS`, because no role grants it. It is derived
 * from the reader's own department, the same way `team.view` is derived from
 * having reportees — a department is not a role and must not become one.
 *
 * MATCHED ON `departments.name`, WHICH IS A DISPLAY STRING, and that is the weak
 * point of this gate. `departments` also carries a stable `code`, which is what a
 * rule like this should key on; the code's value in this tenant was not knowable
 * from the client when this was written, while the name was — "Management", as
 * printed on every profile. So the trade is deliberate and this is the ONE place
 * it lives. Rename the department in Admin → Organisation → Departments and Team
 * Today silently vanishes for its managers, so the rename and this list have to
 * move together — or this switches to reading the code.
 *
 * Compared case-insensitively after trimming, so casing and stray whitespace in
 * the org master do not decide who sees a screen.
 */
export const TEAM_TODAY_DEPARTMENTS: readonly string[] = ["management"];

/** True when this department name is one of `TEAM_TODAY_DEPARTMENTS`. */
export function isTeamTodayDepartment(departmentName: string | null | undefined): boolean {
  if (typeof departmentName !== "string") return false;
  return TEAM_TODAY_DEPARTMENTS.includes(departmentName.trim().toLowerCase());
}

/**
 * Role → capability, mirroring the DB hierarchy in `app.has_role()`
 * (super_admin ⊃ admin ⊃ manager ⊃ employee, migration 005).
 *
 * `admin` carries `admin.super` BY PRODUCT DECISION (2026-07-31). An admin and a
 * super admin are meant to see one identical console: when somebody is promoted to
 * admin they must be able to find every screen, not a subset whose gaps they cannot
 * see to report. Tier "S" in `route-manifest` therefore no longer hides a route from
 * an admin.
 *
 * WHAT THIS DOES NOT DO, and must not be read as doing. This map is nav/route
 * shaping only. A handful of operations are gated in Postgres by
 * `app.is_super_admin()` DIRECTLY rather than by a capability — granting a role,
 * revoking one, and purging biometric templates among them — and those still refuse
 * a plain admin at the server, with the server's own message. Showing the screen and
 * being allowed to press the button are two different promises; this file can only
 * keep the first.
 *
 * `admin` carries `team.view` deliberately. HR IS the admin role — there is no
 * `hr` value in `public.app_role` — and `app.has_cap('team.view')` returns true
 * for an admin because `app.has_role('manager')` does. Omitting it here made the
 * shell disagree with the database: the /team routes survived only because the
 * `isManager` probe in AuthProvider counts rows from `v_team_employee_basic`,
 * which returns admin-scoped employees too. When that probe returns nothing
 * (fresh tenant, no `employee_role_assignments` row yet) an admin lost a nav
 * section the server would have served. The team screens are already scoped by
 * the `v_team_*` views, so showing them is safe as well as correct.
 */
const ROLE_CAPS: Record<RoleName, readonly Capability[]> = {
  employee: ["me.view"],
  manager: ["me.view", "team.view"],
  admin: ["me.view", "team.view", "admin.access", "admin.super"],
  super_admin: ["me.view", "team.view", "admin.access", "admin.super"],
  kiosk_operator: ["me.view", "kiosk.operate"],
};

/**
 * Derive the capability set for a signed-in user.
 * - Every authenticated user gets the employee base (`me.view`) even when the
 *   roles query fails or returns nothing — the shell must work before the
 *   backend is live.
 * - `isManager` folds in the server-derived manager flag once available.
 * - `departmentName` decides `team.today` — see `TEAM_TODAY_DEPARTMENTS`.
 */
export function capsForRoles(
  roles: readonly string[],
  opts: { isManager?: boolean; departmentName?: string | null } = {},
): Set<Capability> {
  const caps = new Set<Capability>(ROLE_CAPS.employee);
  for (const role of roles) {
    const mapped = ROLE_CAPS[role as RoleName];
    if (mapped) for (const cap of mapped) caps.add(cap);
  }
  if (opts.isManager) caps.add("team.view");
  /*
    `team.today` REQUIRES BOTH: the /team surface at all, and a management
    department. Team Today is a manager's screen, so somebody in Management with
    no reportees gets nothing — there is no team to show them.
    An ADMIN is not exempt. `admin` carries `team.view` (see above) but Team Today
    is a manager surface, not the admin console, and the rule asked for was "only
    Management" without a carve-out. An admin outside Management therefore keeps
    the whole /admin console and Team Attendance, and loses this one row.

    THIS FAILS CLOSED, unlike `FirstRunGate`. When the department cannot be read
    the cap is withheld, because a restriction that evaporates on a failed read is
    not a restriction — and the cost of being wrong here is one hidden nav row that
    a reload recovers, not a user locked out of the product.
  */
  if (caps.has("team.view") && isTeamTodayDepartment(opts.departmentName)) {
    caps.add("team.today");
  }
  return caps;
}
