/**
 * roles.api.ts — who is an admin, a manager or a normal user.
 *
 * WHY THIS IS NEW. There was no way to set anybody's role. No `grant_role` RPC, no
 * screen, nothing — `user_roles` had only ever been written by the seed. The live
 * consequence was not abstract: three people ran teams (nine reportees, one, one) and
 * NOBODY held the `manager` role, which is why the assistant told a manager "as an
 * employee your access is limited to your own records". It was answering correctly
 * about a role he did not have.
 *
 * `set_employee_role` (migration 089) owns every rule and this module argues with
 * none of them: admin-within-scope, super_admin requires super_admin, nobody may
 * change their own role, a ten-character reason, and the manager role still needs a
 * reportee. Its refusals are plain sentences and are shown unchanged — the server's
 * wording is the accurate one, and "a manager needs at least one person reporting to
 * them" is more useful than anything this file could paraphrase.
 */
import { z } from "zod";
import { dbUuid, rpcOne, selectMany } from "@/shared/api/query";

export const EMPLOYEE_ROLES_VIEW = "v_employee_roles";

/**
 * `no_login` is not a role — it is an employee with no account yet, and it is in the
 * list because "why can I not set this person's role" needs an answer on screen
 * rather than a refusal after the click.
 */
export const effectiveRoles = ["employee", "manager", "admin", "super_admin", "no_login"] as const;
export type EffectiveRole = (typeof effectiveRoles)[number];

/** What HR may actually choose. `no_login` is a state, not a choice. */
export const assignableRoles = ["employee", "manager", "admin", "super_admin"] as const;
export type AssignableRole = (typeof assignableRoles)[number];

export const employeeRoleRowSchema = z.object({
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  department_name: z.string().nullable(),
  designation: z.string().nullable(),
  profile_id: dbUuid.nullable(),
  reportee_count: z.number(),
  roles: z.array(z.string()),
  effective_role: z.enum(effectiveRoles),
  /** Holds `manager` with nobody reporting to them — a stale grant. */
  manager_without_team: z.boolean(),
  /** Has reportees but no manager role — the bug that hid a whole team. */
  team_without_manager_role: z.boolean(),
  can_manage: z.boolean(),
});

export type EmployeeRoleRow = z.infer<typeof employeeRoleRowSchema>;

export async function fetchEmployeeRoles(signal?: AbortSignal): Promise<EmployeeRoleRow[]> {
  return selectMany(EMPLOYEE_ROLES_VIEW, employeeRoleRowSchema, {
    // Mismatches first: those are the rows somebody has to act on. Then the people
    // with the most reports, who matter most if their role is wrong.
    order: [
      { column: "reportee_count", ascending: false },
      { column: "employee_code", ascending: true },
    ],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Set what somebody IS. One call: the named role is granted and every other
 * privileged role revoked in the same statement, so a demotion cannot leave the old
 * role behind. `employee` is the floor and is never removed.
 */
export async function setEmployeeRole(
  employeeId: string,
  role: AssignableRole,
  reason: string,
): Promise<string> {
  const applied = await rpcOne(
    "set_employee_role",
    { p_employee_id: employeeId, p_role: role, p_reason: reason },
    z.string(),
  );
  if (applied === null) throw new Error("The role change could not be recorded.");
  return applied;
}
