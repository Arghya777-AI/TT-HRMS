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
  | "admin.access" // admin console tier A — most /admin/** routes
  | "admin.super" // super_admin-only routes (tier S)
  | "kiosk.operate"; // guard/operator actions on the kiosk surface

export type RoleName = "employee" | "manager" | "admin" | "super_admin" | "kiosk_operator";

/**
 * Role → capability, mirroring the DB hierarchy in `app.has_role()`
 * (super_admin ⊃ admin ⊃ manager ⊃ employee, migration 005).
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
  admin: ["me.view", "team.view", "admin.access"],
  super_admin: ["me.view", "team.view", "admin.access", "admin.super"],
  kiosk_operator: ["me.view", "kiosk.operate"],
};

/**
 * Derive the capability set for a signed-in user.
 * - Every authenticated user gets the employee base (`me.view`) even when the
 *   roles query fails or returns nothing — the shell must work before the
 *   backend is live.
 * - `isManager` folds in the server-derived manager flag once available.
 */
export function capsForRoles(roles: readonly string[], opts: { isManager?: boolean } = {}): Set<Capability> {
  const caps = new Set<Capability>(ROLE_CAPS.employee);
  for (const role of roles) {
    const mapped = ROLE_CAPS[role as RoleName];
    if (mapped) for (const cap of mapped) caps.add(cap);
  }
  if (opts.isManager) caps.add("team.view");
  return caps;
}
