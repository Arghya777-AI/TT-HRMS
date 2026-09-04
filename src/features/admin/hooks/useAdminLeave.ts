/**
 * useAdminLeave.ts — TanStack hooks over `admin/api/leave.api.ts` for the four
 * leave-administration screens.
 *
 * Rules this file exists to keep:
 *  - keys come from `qk.admin.*` only, and every leave key is prefixed
 *    `["admin","leave",…]`, so one `invalidateQueries(qk.admin.leaveAll())`
 *    after a decision refreshes the request grid, the balances grid and the
 *    comp-off ledger together. A grid that disagrees with the row above it is
 *    the `7 vs 8` defect (DR-29).
 *  - writes go through `useAuditedMutation`, never `useMutation`, so the reason
 *    is validated in the browser and travels in `X-Reason` on that one request.
 *  - no hook returns a derived figure. Balances come from
 *    `v_leave_balance_current` (a materialised running sum of the ledger); this
 *    layer moves rows and nothing else.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  cancelLeaveRequest,
  cancelLeaveDays,
  decideLeaveRequest,
  editLeaveDates,
  sendLeaveBack,
  fetchLeaveRequestDays,
  type LeaveCancelResult,
  type LeaveDaysCancelResult,
  type LeaveEditResult,
  type LeaveSendBackResult,
  type LeaveRequestDay,
  fetchCompOffBalances,
  fetchCompOffLedger,
  fetchLeaveBalances,
  fetchLeaveRequests,
  fetchLeaveTypes,
  submitLeaveAdjustment,
  type CompOffBalance,
  type CompOffLedgerRow,
  type LeaveAdjustmentInput,
  type LeaveAdjustmentResult,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveRequestStatus,
  type LeaveType,
  fetchMonthlyExtraWork,
  type ExtraWorkRow,
} from "../api/leave.api";

/** Hard row cap on every org-wide grid: keyset paging, never OFFSET. */
export const LEAVE_ROW_CAP = 500;

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** Active + retired leave types — the grid needs names for historical rows too. */
/**
 * The leave types the venue OFFERS — sick, earned, week-off, maternity, paternity.
 *
 * This fetched `includeInactive: true`, and six screens share it: the balances
 * grid, adjustments, requests, the org calendar, encashment, the ledger and the
 * year-end rollover. Every one of their type dropdowns therefore offered
 * Bereavement, Leave Without Pay, Comp-Off, On Duty and Casual — types this venue
 * retired. Picking one returns an empty grid, or worse, offers to credit days in a
 * leave nobody can take.
 *
 * Retired types are still readable where they matter: `leave_types` itself is what
 * the Leave Type Master reads, through `MasterScreen`'s own "include inactive"
 * toggle, so un-retiring one is still possible. This hook is for pickers, and a
 * picker should not offer what cannot be chosen.
 */
export function useAdminLeaveTypes(): UseQueryResult<LeaveType[], Error> {
  return useQuery({
    queryKey: qk.admin.leaveTypes(),
    queryFn: ({ signal }) => fetchLeaveTypes({ includeInactive: false }, signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/** Leave types keyed by id, for a grid cell that has only `leave_type_id`. */
export function useLeaveTypeMap(
  types: readonly LeaveType[] | undefined,
): ReadonlyMap<string, LeaveType> {
  const map = new Map<string, LeaveType>();
  for (const type of types ?? []) map.set(type.id, type);
  return map;
}

export interface RequestFilters {
  readonly statuses?: readonly LeaveRequestStatus[];
  readonly employeeId?: string | null;
  readonly from?: string;
  readonly to?: string;
}

/**
 * One keyset page of requests, org-wide. `LEAVE_ROW_CAP` rows are fetched and the
 * screen says so when the cap is reached — a silently truncated grid is worse
 * than a visible boundary.
 */
export function useAdminLeaveRequests(
  filters: RequestFilters,
): UseQueryResult<LeaveRequest[], Error> {
  const key = {
    statuses: filters.statuses ?? null,
    employeeId: filters.employeeId ?? null,
    from: filters.from ?? null,
    to: filters.to ?? null,
  };
  return useQuery({
    queryKey: qk.admin.leaveRequests(key),
    queryFn: async ({ signal }) => {
      const page = await fetchLeaveRequests(
        {
          ...(filters.statuses ? { statuses: filters.statuses } : {}),
          ...(filters.employeeId != null ? { employeeIds: [filters.employeeId] } : {}),
          ...(filters.from !== undefined && filters.from !== "" ? { from: filters.from } : {}),
          ...(filters.to !== undefined && filters.to !== "" ? { to: filters.to } : {}),
        },
        LEAVE_ROW_CAP,
        null,
        signal,
      );
      return page.rows;
    },
    retry: shouldRetryQuery,
  });
}

export interface BalanceFilters {
  readonly employeeId?: string | null;
  readonly leaveTypeId?: string | null;
}

/** `v_leave_balance_current` — current leave year, whole organisation. */
export function useAdminLeaveBalances(
  filters: BalanceFilters,
): UseQueryResult<LeaveBalance[], Error> {
  const key = {
    employeeId: filters.employeeId ?? null,
    leaveTypeId: filters.leaveTypeId ?? null,
  };
  return useQuery({
    queryKey: qk.admin.leaveBalances(key),
    queryFn: ({ signal }) =>
      fetchLeaveBalances(
        {
          ...(filters.employeeId != null ? { employeeIds: [filters.employeeId] } : {}),
          ...(filters.leaveTypeId != null ? { leaveTypeIds: [filters.leaveTypeId] } : {}),
        },
        LEAVE_ROW_CAP,
        signal,
      ),
    retry: shouldRetryQuery,
  });
}

/** One employee × type balance row — the adjustment form's impact panel. */
export function useOneLeaveBalance(
  employeeId: string | null,
  leaveTypeId: string | null,
): UseQueryResult<LeaveBalance[], Error> {
  return useQuery({
    queryKey: qk.admin.leaveBalances({ employeeId, leaveTypeId, one: true }),
    queryFn: ({ signal }) =>
      fetchLeaveBalances(
        {
          employeeIds: [employeeId ?? ""],
          ...(leaveTypeId != null ? { leaveTypeIds: [leaveTypeId] } : {}),
        },
        50,
        signal,
      ),
    enabled: employeeId != null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}

/** `v_comp_off_balance` — per employee: available, nearest expiry, expiring ≤30d. */
export function useCompOffBalances(): UseQueryResult<CompOffBalance[], Error> {
  return useQuery({
    queryKey: qk.admin.compOff("org-balances"),
    queryFn: ({ signal }) => fetchCompOffBalances([], signal),
    retry: shouldRetryQuery,
  });
}

export interface CompOffFilters {
  readonly employeeId?: string | null;
  readonly status?: string | null;
}

/** The comp-off ledger itself. Read-only for every client role (grants: 019). */
export function useCompOffLedger(
  filters: CompOffFilters,
): UseQueryResult<CompOffLedgerRow[], Error> {
  const key = {
    employeeId: filters.employeeId ?? null,
    status: filters.status ?? null,
    ledger: true,
  };
  return useQuery({
    queryKey: qk.admin.compOff(JSON.stringify(key)),
    queryFn: ({ signal }) =>
      fetchCompOffLedger(
        {
          ...(filters.employeeId != null ? { employeeIds: [filters.employeeId] } : {}),
          ...(filters.status != null && filters.status !== "" ? { statuses: [filters.status] } : {}),
        },
        LEAVE_ROW_CAP,
        signal,
      ),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export interface DecisionInput {
  readonly requestId: string;
  readonly requestNumber: string;
  readonly decision: "approved" | "rejected";
}

/**
 * Approve or reject on behalf of the approver (§7.3 `override_of_level_N`).
 *
 * `decidedBy` is a `profiles.id` — `leave_requests.decided_by` references
 * `profiles`, not `employees` (019). Passing the employee id would silently
 * attribute the decision to nobody.
 *
 * No `defaultReason`: an override of somebody else's approval is exactly the case
 * where the UI must ask.
 */
export function useDecideLeaveRequest(
  decidedBy: string | null,
  onDone?: (input: DecisionInput) => void,
): AuditedMutationResult<LeaveRequest, DecisionInput> {
  return useAuditedMutation<LeaveRequest, DecisionInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.leaveAll()],
    mutationFn: (input, reason) =>
      decideLeaveRequest(
        {
          requestId: input.requestId,
          decision: input.decision,
          decidedBy: decidedBy ?? "",
          comment: reason,
        },
        reason,
      ),
    ...(onDone ? { onSuccess: (_data: LeaveRequest, input: DecisionInput) => onDone(input) } : {}),
  });
}

export interface CancelInput {
  readonly requestId: string;
  readonly requestNumber: string;
}

/** The days of one request, for the pick-which-days dialog. */
export function useLeaveRequestDays(
  requestId: string | null,
): UseQueryResult<LeaveRequestDay[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ part: "leave-request-days", requestId }),
    queryFn: ({ signal }) => fetchLeaveRequestDays(requestId ?? "", signal),
    enabled: requestId !== null,
    retry: shouldRetryQuery,
  });
}

export interface EditDatesInput {
  readonly requestId: string;
  readonly requestNumber: string;
  readonly from: string;
  readonly to: string;
  readonly portion: string;
}

/** Move an approved leave. Attendance changes on BOTH the old dates and the new ones. */
export function useEditLeaveDates(
  onDone?: (input: EditDatesInput, result: LeaveEditResult) => void,
): AuditedMutationResult<LeaveEditResult, EditDatesInput> {
  return useAuditedMutation<LeaveEditResult, EditDatesInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.leaveAll(), qk.admin.attendanceAll(), qk.attendance.all],
    mutationFn: (input, reason) =>
      editLeaveDates(
        { requestId: input.requestId, from: input.from, to: input.to, portion: input.portion },
        reason,
      ),
    ...(onDone ? { onSuccess: (d: LeaveEditResult, i: EditDatesInput) => onDone(i, d) } : {}),
  });
}

/** Hand it back to the employee: pending again, and theirs to change or withdraw. */
export function useSendLeaveBack(
  onDone?: (input: CancelInput, result: LeaveSendBackResult) => void,
): AuditedMutationResult<LeaveSendBackResult, CancelInput> {
  return useAuditedMutation<LeaveSendBackResult, CancelInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.leaveAll(), qk.admin.attendanceAll(), qk.attendance.all],
    mutationFn: (input, reason) => sendLeaveBack(input.requestId, reason),
    ...(onDone ? { onSuccess: (d: LeaveSendBackResult, i: CancelInput) => onDone(i, d) } : {}),
  });
}

export interface CancelDaysInput {
  readonly requestId: string;
  readonly requestNumber: string;
  readonly dates: readonly string[];
}

/**
 * Cancel named days of an approved leave.
 *
 * Invalidates attendance as well as leave: a released day becomes a working day again, so a
 * roster still showing "on leave" would contradict the balance beside it.
 */
export function useCancelLeaveDays(
  onDone?: (input: CancelDaysInput, result: LeaveDaysCancelResult) => void,
): AuditedMutationResult<LeaveDaysCancelResult, CancelDaysInput> {
  return useAuditedMutation<LeaveDaysCancelResult, CancelDaysInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.leaveAll(), qk.admin.attendanceAll(), qk.attendance.all],
    mutationFn: (input, reason) => cancelLeaveDays(input.requestId, input.dates, reason),
    ...(onDone
      ? { onSuccess: (data: LeaveDaysCancelResult, input: CancelDaysInput) => onDone(input, data) }
      : {}),
  });
}

/**
 * A cancel as the shared reason-prompt carries it.
 *
 * `decision: "cancelled"` is what tells the one dialog which verb it is running, so approve,
 * reject and cancel can share a prompt without a second piece of state to keep in step.
 */
export interface CancelTarget extends CancelInput {
  readonly decision: "cancelled";
}

/**
 * Cancel an APPROVED request.
 *
 * The ledger credit, the comp-off restoration and the attendance recompute are the triggers'
 * job, not ours — this only records the intent, and `admin_cancel_leave_request` refuses the
 * cases where recording it would do harm: a locked period, a leave already paid, or a request
 * that was never approved in the first place.
 */
export function useCancelLeaveRequest(
  cancelledBy: string | null,
  onDone?: (input: CancelInput) => void,
): AuditedMutationResult<LeaveCancelResult, CancelInput> {
  return useAuditedMutation<LeaveCancelResult, CancelInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    /*
      Attendance as well as leave: cancelling an approved day re-derives that day's record,
      so a roster or calendar left on the old figure would contradict the balance beside it.
    */
    invalidate: [qk.admin.leaveAll(), qk.admin.attendanceAll(), qk.attendance.all],
    mutationFn: (input, reason) =>
      cancelLeaveRequest(input.requestId, cancelledBy ?? "", reason),
    ...(onDone ? { onSuccess: (_data: LeaveCancelResult, input: CancelInput) => onDone(input) } : {}),
  });
}

/**
 * Manual credit/debit. `submitLeaveAdjustment` rejects on this backend by design:
 * `leave_ledger` grants INSERT to `service_role` only, the append-only guard
 * refuses client mutation, and no `leave-adjust` edge function is deployed. The
 * screen still collects a full reason and surfaces the refusal verbatim rather
 * than hiding the gap behind a disabled button with no explanation.
 */
export function useLeaveAdjustment(
  onDone?: (input: LeaveAdjustmentInput) => void,
): AuditedMutationResult<LeaveAdjustmentResult, LeaveAdjustmentInput> {
  return useAuditedMutation<LeaveAdjustmentResult, LeaveAdjustmentInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.leaveAll()],
    mutationFn: (input, reason) => submitLeaveAdjustment(input, reason),
    ...(onDone ? { onSuccess: (_d: LeaveAdjustmentResult, input: LeaveAdjustmentInput) => onDone(input) } : {}),
  });
}


/**
 * Extra work in the month a week-off suggestion should be drawn from.
 *
 * The month comes from `referenceMonth(istToday())` — before the 15th the month that
 * just ended, from the 15th the month you are in — so this hook is given a year and
 * month rather than deciding for itself, and the rule stays in one tested place.
 */
export function useMonthlyExtraWork(
  year: number,
  month: number,
): UseQueryResult<ExtraWorkRow[], Error> {
  return useQuery({
    queryKey: qk.admin.list({ extraWork: true, year, month }),
    queryFn: ({ signal }) => fetchMonthlyExtraWork(year, month, signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}
