/**
 * useApprovals.ts — hooks for E-12. Keys from `qk.approvals.*`.
 *
 * Tracking reuses `useMyOpenRequests` from E-10 (same key, same payload), so the
 * launcher and this screen can never report different counts.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import { fetchPendingActions, type PendingActionsResult } from "../api/approvals.api";

const NO_EMPLOYEE = "no-employee";

/** Everything waiting on me, from all four deployed sources. */
export function usePendingActions(): UseQueryResult<PendingActionsResult, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: [...qk.approvals.inbox(), employeeId ?? NO_EMPLOYEE],
    queryFn: ({ signal }) => fetchPendingActions(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

export { useMyOpenRequests } from "@/features/apply/hooks/useApply";
