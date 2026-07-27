/**
 * employee-scope.ts — resolving "which employee am I reading?" in one place.
 *
 * Every self-service read is scoped to `app.current_employee_id()` in Postgres,
 * but the client still needs the id to build a query key and a filter. Identity
 * comes from `AuthProvider`, which is the only holder of session state.
 *
 * A signed-in user with NO employee row is a real case: kiosk-only staff
 * (`portal_access_state = 'none'`, spec-employee E-01). Those accounts must see
 * the honest no-permission state, not a spinner and not an empty grid — hence
 * `requireEmployeeId` throws a `QueryError{ kind: "no_permission" }` rather than
 * returning a sentinel.
 */
import { QueryError } from "./query";
import { useAuth } from "@/app/auth/AuthProvider";

/** The signed-in employee's id, or null before identity resolves / if none. */
export function useEmployeeId(): string | null {
  return useAuth().employee?.employeeId ?? null;
}

/**
 * Narrow a possibly-null employee id inside a `queryFn`. With `enabled` set this
 * never fires; when it does, "you have no employee record" is exactly a
 * no-permission state.
 */
export function requireEmployeeId(employeeId: string | null): string {
  if (employeeId === null || employeeId.length === 0) {
    throw new QueryError(
      "identity",
      "no_permission",
      "No employee record is linked to this account, so there is nothing to show.",
    );
  }
  return employeeId;
}

/**
 * The signed-in user's `profiles.id` (= `auth.uid()`), or null before the
 * session resolves.
 *
 * Distinct from the employee id on purpose: audit and authorship columns
 * (`documents.uploaded_by`, `approval_requests.raised_by`,
 * `approval_actions.actor_id`) reference the PROFILE, while business rows
 * reference the EMPLOYEE. Comparing the wrong one is how "HR uploaded this"
 * becomes "you uploaded this".
 */
export function useProfileId(): string | null {
  return useAuth().user?.id ?? null;
}
