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
  fetchLeaveRoster,
  type LeaveRosterRow,
  fetchApprovalTrail,
  fetchHolidaysInWindow,
  fetchLeaveAllocation,
  fetchLeaveTypeRules,
  fetchMyLeaveContext,
  fetchColleagues,
  fetchCountableDates,
  fetchMyBookedLeave,
  previewLeaveRequest,
  submitLeaveRequest,
  withdrawLeaveRequest,
  type ApprovalTrail,
  type CalendarHoliday,
  fetchDepartmentIsOperational,
  type CountableDate,
  type MyBookedLeaveRow,
  type LeaveAllocationDay,
  type EmployeeRef,
  type LeavePreview,
  type LeavePreviewInput,
  type LeaveTypeRule,
  type MyLeaveContext,
  type SubmitLeaveInput,
} from "../api/leave-apply.api";
import type { LeaveRequest } from "../api/leave.api";
import { rangeProblem } from "../leaveRange";

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
 * Who else is on approved leave in this window — the whole venue, not just my reports.
 *
 * Reads `v_leave_roster`, which is deliberately narrow (name, department, leave type, portion)
 * and runs as its owner so it is not limited to the rows RLS would return for me. See the view's
 * own comment for what it does NOT expose.
 *
 * A month of company-wide leave changes when somebody's request is approved, not by the second,
 * so it is cached for five minutes rather than refetched on every focus.
 */
export function useLeaveRoster(from: string, to: string): UseQueryResult<LeaveRosterRow[], Error> {
  return useQuery({
    queryKey: qk.leave.roster(from, to),
    queryFn: ({ signal }) => fetchLeaveRoster(from, to, signal),
    staleTime: 5 * 60 * 1000,
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

/**
 * Which dates in a from–to range would actually cost leave, per date.
 *
 * A QUERY, unlike the preview beside it — it writes nothing, so it is safe to re-run whenever
 * either end of the range moves, and safe for react-query to cache and revalidate. The preview
 * is a mutation because it creates a draft; this only reads the rota.
 *
 * Disabled until the range is complete and sane. `rangeProblem` is checked HERE rather than
 * relying on the server's own guards so an inverted or absurd range costs no round trip and
 * shows no error the employee has to decode.
 */
export function useCountableDates(
  fromDate: string,
  toDate: string,
): UseQueryResult<CountableDate[], Error> {
  const employeeId = useEmployeeId();
  const ok = employeeId !== null && rangeProblem(fromDate, toDate) === null;
  return useQuery({
    queryKey: qk.leave.countable(employeeId ?? NO_EMPLOYEE, fromDate, toDate),
    queryFn: ({ signal }) => fetchCountableDates(requireEmployeeId(employeeId), fromDate, toDate, null, signal),
    enabled: ok,
    // The rota and the holiday calendar do not move during an application.
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/**
 * What this employee already holds over the picked range.
 *
 * Same enable rule and same key shape as `useCountableDates`, so the two reads that describe
 * a chosen range arrive together and neither fires on a half-typed date.
 *
 * `staleTime` is short where the countable dates' is long: a rota does not move during an
 * application, but a booking can — the employee may have filed one in another tab, and an
 * approver may have decided one a minute ago. Advice built on a stale answer sends somebody
 * into a refusal.
 */
export function useMyBookedLeave(
  fromDate: string,
  toDate: string,
): UseQueryResult<MyBookedLeaveRow[], Error> {
  const employeeId = useEmployeeId();
  const ok = employeeId !== null && rangeProblem(fromDate, toDate) === null;
  return useQuery({
    queryKey: qk.leave.detail(`booked:${employeeId ?? NO_EMPLOYEE}:${fromDate}:${toDate}`),
    queryFn: ({ signal }) =>
      fetchMyBookedLeave(requireEmployeeId(employeeId), fromDate, toDate, signal),
    enabled: ok,
    staleTime: 30 * 1000,
    retry: shouldRetryQuery,
  });
}

/**
 * Whether the signed-in employee's department demands a named cover.
 *
 * Its own query rather than a column on the context: `v_my_employee` is a fixed
 * allowlist that does not carry the department's flags, and widening a view
 * everybody reads to answer one form's question is the wrong trade.
 */
export function useDepartmentIsOperational(
  departmentId: string | null,
): UseQueryResult<boolean, Error> {
  return useQuery({
    queryKey: qk.leave.detail(`department-operational:${departmentId ?? "none"}`),
    queryFn: ({ signal }) => fetchDepartmentIsOperational(departmentId, signal),
    staleTime: 5 * 60_000,
    retry: shouldRetryQuery,
  });
}
