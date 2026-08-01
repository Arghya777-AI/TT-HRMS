/**
 * useLeaveApply.ts — hooks for E-05.4 (apply), E-05.6 (calendar), E-05.7
 * (detail) and E-06 (comp-off), over `leave-apply.api`.
 *
 * The preview is a MUTATION, not a query, and that is deliberate: it writes the
 * draft the server expands, so it must run when the user asks (or when the shape
 * of the request changes) and never speculatively on cache revalidation. The
 * apply form gates its submit button on `preview.isSuccess`, which is the
 * mechanised form of "cannot submit without preview loaded".
 */
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import {
  fetchApprovalTrail,
  fetchHolidaysInWindow,
  fetchLeaveAllocation,
  fetchLeaveTypeRules,
  fetchMyLeaveContext,
  fetchColleagues,
  previewLeaveRequest,
  submitLeaveRequest,
  withdrawLeaveRequest,
  type ApprovalTrail,
  type CalendarHoliday,
  type LeaveAllocationDay,
  type EmployeeRef,
  type LeavePreview,
  type LeavePreviewInput,
  type LeaveTypeRule,
  type MyLeaveContext,
  type SubmitLeaveInput,
} from "../api/leave-apply.api";
import type { LeaveRequest } from "../api/leave.api";

const NO_EMPLOYEE = "no-employee";

/** Active leave types and their rulebook. Static enough to cache hard. */
export function useLeaveTypeRules(): UseQueryResult<LeaveTypeRule[], Error> {
  return useQuery({
    queryKey: qk.leave.types(),
    queryFn: ({ signal }) => fetchLeaveTypeRules(signal),
    staleTime: 10 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/**
 * My employment context. `null` = no employee record linked to this login,
 * which the screens render as no-permission, never as an empty leave list.
 */
export function useMyLeaveContext(): UseQueryResult<MyLeaveContext | null, Error> {
  return useQuery({
    queryKey: qk.leave.context(),
    queryFn: ({ signal }) => fetchMyLeaveContext(signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/** The per-date allocation of one request — E-05.7's allocation table. */
export function useLeaveAllocation(
  requestId: string | undefined,
): UseQueryResult<LeaveAllocationDay[], Error> {
  const id = requestId ?? "";
  return useQuery({
    queryKey: qk.leave.allocation(id),
    queryFn: ({ signal }) => fetchLeaveAllocation(id, signal),
    enabled: id.length > 0,
    retry: shouldRetryQuery,
  });
}

/** L1/L2 decision trail of one request. */
export function useApprovalTrail(
  requestId: string | undefined,
): UseQueryResult<ApprovalTrail, Error> {
  const id = requestId ?? "";
  return useQuery({
    queryKey: qk.leave.trail(id),
    queryFn: ({ signal }) => fetchApprovalTrail(id, signal),
    enabled: id.length > 0,
    retry: shouldRetryQuery,
  });
}

/** Holidays on my calendar in a window. Disabled until the calendar id is known. */
export function useHolidaysInWindow(
  holidayCalendarId: string | null | undefined,
  from: string,
  to: string,
): UseQueryResult<CalendarHoliday[], Error> {
  const calendarId = holidayCalendarId ?? "";
  return useQuery({
    queryKey: qk.leave.holidays(calendarId, from, to),
    queryFn: ({ signal }) => fetchHolidaysInWindow({ holidayCalendarId: calendarId, from, to }, signal),
    enabled: calendarId.length > 0,
    staleTime: 60 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/**
 * The mandatory server preview. `mutateAsync` resolves with the per-date
 * allocation and the draft id that a later submit transitions.
 */
export function useLeavePreview(): UseMutationResult<
  LeavePreview,
  Error,
  Omit<LeavePreviewInput, "employeeId">
> {
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (input: Omit<LeavePreviewInput, "employeeId">) =>
      previewLeaveRequest({ ...input, employeeId: requireEmployeeId(employeeId) }),
  });
}

/**
 * Submit the previewed draft. Invalidates `qk.leave.all` on success: a
 * submission moves the balance (reserved days), the request list AND the
 * calendar, so the widest correct prefix is the only safe one.
 */
export function useSubmitLeave(): UseMutationResult<LeaveRequest, Error, SubmitLeaveInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitLeaveInput) => submitLeaveRequest(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.leave.all });
      void client.invalidateQueries({ queryKey: qk.compOff.all });
    },
  });
}

export interface WithdrawLeaveInput {
  readonly requestId: string;
  readonly reason: string;
}

/** Withdraw an undecided request; the server releases the reserved days. */
export function useWithdrawLeave(): UseMutationResult<void, Error, WithdrawLeaveInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: WithdrawLeaveInput) => withdrawLeaveRequest(input.requestId, input.reason),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.leave.all });
      void client.invalidateQueries({ queryKey: qk.compOff.all });
    },
  });
}

export { NO_EMPLOYEE };

/**
 * Colleagues this employee may name — the handover person, and peers to mention.
 *
 * Long `staleTime`: a roster does not change while somebody fills in one form, and this list
 * is read by every leave application.
 */
export function useColleagues(): UseQueryResult<EmployeeRef[], Error> {
  return useQuery({
    queryKey: qk.leave.list({ what: "colleagues" }),
    queryFn: ({ signal }) => fetchColleagues(300, signal),
    staleTime: 5 * 60_000,
    retry: shouldRetryQuery,
  });
}
