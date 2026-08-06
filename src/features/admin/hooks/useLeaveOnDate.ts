/**
 * useLeaveOnDate — the leave requests covering one date, for a named handful of employees.
 *
 * `enabled` is what keeps it lazy: the board fires no leave query at all until somebody opens an
 * on-leave list. See `leave-on-date.api.ts` for why leave is the one drill-down that needs a
 * round trip while the others are served from memory.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { shouldRetryQuery } from "@/shared/api/query";
import { fetchLeaveOnDate, type LeaveOnDate } from "../api/leave-on-date.api";

export function useLeaveOnDate(
  employeeIds: readonly string[],
  istDate: string,
  enabled: boolean,
): UseQueryResult<LeaveOnDate[], Error> {
  // Sorted, so the key is stable whichever order the bucket happened to produce.
  const ids = [...employeeIds].sort();
  return useQuery({
    queryKey: ["admin", "leave-on-date", istDate, ids],
    queryFn: ({ signal }) => fetchLeaveOnDate(ids, istDate, signal),
    enabled: enabled && ids.length > 0,
    // A leave request does not change while somebody reads a panel.
    staleTime: 60_000,
    retry: shouldRetryQuery,
  });
}
