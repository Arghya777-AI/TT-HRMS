/**
 * useLeaveOnBehalf — the admin side of applying for leave FOR an employee.
 *
 * Two hooks and no new write path. `usePreviewLeave` in the leave feature pins the employee
 * to `requireEmployeeId(employeeId)` — the caller's own id — which is right for the employee
 * screen and is the only reason a separate preview hook is needed here. The SUBMIT is reused
 * verbatim from `useSubmitLeave`, because it keys on the request id and has never assumed
 * who the applicant was.
 *
 * The draft is created by the preview, exactly as it is for an employee. That is not an
 * accident of the design: the server stamps `total_days`, `paid_days` and the expanded day
 * rows from the draft, so a preview IS the calculation. An admin form that computed the days
 * itself would disagree with the guard the moment a holiday or weekly off fell in the range.
 */
import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  previewLeaveRequest,
  type LeavePreview,
  type LeavePreviewInput,
  type MyLeaveContext,
} from "@/features/leave/api/leave-apply.api";
import { fetchEmployeeLeaveContext } from "../api/leave-on-behalf.api";

/** The chosen employee's employment facts, for the eligibility gates. */
export function useEmployeeLeaveContext(
  employeeId: string | null,
): UseQueryResult<MyLeaveContext | null, Error> {
  return useQuery({
    queryKey: qk.admin.detail(`leave-context:${employeeId ?? "none"}`),
    queryFn: ({ signal }) => fetchEmployeeLeaveContext(employeeId ?? "", signal),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}

/**
 * Server preview for a NAMED employee — the admin variant of `usePreviewLeave`.
 *
 * Not a query: it WRITES a draft (or reuses the employee's existing one) and reads back what
 * the server computed, so it must be an explicit act rather than something that fires on
 * navigation. A preview that ran automatically would create draft rows for whoever happened
 * to be selected in a picker.
 */
export function usePreviewLeaveFor(): UseMutationResult<LeavePreview, Error, LeavePreviewInput> {
  return useMutation({
    mutationFn: (input: LeavePreviewInput) => previewLeaveRequest(input),
  });
}
