/**
 * identity.ts — the "is there an employee record behind this login?" gate.
 *
 * Every pay hook is `enabled: employeeId !== null`, and a disabled TanStack
 * query stays `pending` forever. Without this gate a kiosk-only account
 * (`portal_access_state = 'none'`, spec-employee E-01) would sit on a skeleton
 * for ever instead of being told plainly that there is nothing to show — one of
 * the seven states the contract requires (§8.3).
 */
import { useAuth } from "@/app/auth/AuthProvider";
import { useEmployeeId } from "@/shared/api/employee-scope";
import { QueryError } from "@/shared/api/query";

export interface IdentityGate {
  /** Identity is still resolving — show the skeleton, not an error. */
  readonly resolving: boolean;
  /** Set when the account has no employee row: render the no-permission state. */
  readonly error: QueryError | undefined;
  readonly employeeId: string | null;
}

export function useIdentityGate(): IdentityGate {
  const employeeId = useEmployeeId();
  const { isLoading } = useAuth();
  if (isLoading) return { resolving: true, error: undefined, employeeId };
  if (employeeId === null) {
    return {
      resolving: false,
      employeeId,
      error: new QueryError(
        "identity",
        "no_permission",
        "No employee record is linked to this account, so there is no salary information to show.",
      ),
    };
  }
  return { resolving: false, error: undefined, employeeId };
}
