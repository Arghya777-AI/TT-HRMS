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
  decideLeaveRequest,
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
} from "../api/leave.api";

/** Hard row cap on every org-wide grid: keyset paging, never OFFSET. */
export const LEAVE_ROW_CAP = 500;

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** Active + retired leave types — the grid needs names for historical rows too. */
export function useAdminLeaveTypes(): UseQueryResult<LeaveType[], Error> {
  return useQuery({
    queryKey: qk.admin.leaveTypes(),
    queryFn: ({ signal }) => fetchLeaveTypes({ includeInactive: true }, signal),
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

/** Cancel an approved request. The ledger credit is the trigger's job, not ours. */
export function useCancelLeaveRequest(
  cancelledBy: string | null,
  onDone?: (input: CancelInput) => void,
): AuditedMutationResult<LeaveRequest, CancelInput> {
  return useAuditedMutation<LeaveRequest, CancelInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.leaveAll()],
    mutationFn: (input, reason) =>
      cancelLeaveRequest(input.requestId, cancelledBy ?? "", reason),
    ...(onDone ? { onSuccess: (_data: LeaveRequest, input: CancelInput) => onDone(input) } : {}),
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
