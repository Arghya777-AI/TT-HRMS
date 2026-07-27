/**
 * useLeave.ts — TanStack Query hooks over leave.api.
 *
 * Keys come from `qk.leave.*` / `qk.compOff.*` only. After any leave mutation,
 * invalidate the widest correct prefix — `qk.leave.all` — because a request
 * decision moves the balance, the ledger AND the list.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery, type Cursor, type Page } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import {
  fetchCompOffBalance,
  fetchCompOffCredits,
  fetchLeaveBalanceForType,
  fetchLeaveBalances,
  fetchLeaveLedgerPage,
  fetchLeaveRequest,
  fetchLeaveRequestsPage,
  fetchMyLeaveCalendar,
  fetchOpenLeaveRequests,
  type CompOffBalance,
  type CompOffCredit,
  type LeaveBalance,
  type LeaveCalendarDay,
  type LeaveLedgerEntry,
  type LeaveRequest,
  type LeaveRequestStatus,
} from "../api/leave.api";

const NO_EMPLOYEE = "no-employee";

/**
 * Balances for the current leave year, one row per eligible type.
 *
 * `available_days` / `available_after_pending` are GENERATED columns — the card
 * renders them directly. Spec E-05 says ineligible types are NOT rendered; the
 * view only returns rows that exist in `leave_balances`, so absence of a type is
 * the eligibility signal.
 */
export function useLeaveBalances(): UseQueryResult<LeaveBalance[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.leave.balances(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchLeaveBalances(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** One type's balance — the apply form's "after this request" panel. */
export function useLeaveBalanceForType(
  leaveTypeId: string | undefined,
): UseQueryResult<LeaveBalance | null, Error> {
  const employeeId = useEmployeeId();
  const typeId = leaveTypeId ?? "";
  return useQuery({
    queryKey: qk.leave.balanceForType(employeeId ?? NO_EMPLOYEE, typeId),
    queryFn: ({ signal }) => fetchLeaveBalanceForType(requireEmployeeId(employeeId), typeId, signal),
    enabled: employeeId !== null && typeId.length > 0,
    retry: shouldRetryQuery,
  });
}

export interface LedgerPageParams {
  readonly leaveTypeId?: string;
  readonly leaveYear?: number;
  readonly from?: string;
  readonly to?: string;
  readonly pageSize?: number;
  readonly cursor?: Cursor | null;
}

/**
 * One keyset page of the ledger statement, newest first.
 *
 * Keyset, not OFFSET: the ledger is written by the nightly accrual job and by
 * every approval, so an OFFSET page can skip or repeat an entry mid-scroll.
 * `data.nextCursor` drives the next call; `null` means the last page.
 */
export function useLeaveLedger(
  params: LedgerPageParams = {},
): UseQueryResult<Page<LeaveLedgerEntry>, Error> {
  const employeeId = useEmployeeId();
  const pageSize = params.pageSize ?? 25;
  const cursor = params.cursor ?? null;
  return useQuery({
    queryKey: qk.leave.ledger(employeeId ?? NO_EMPLOYEE, {
      leaveTypeId: params.leaveTypeId ?? null,
      leaveYear: params.leaveYear ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
      pageSize,
      cursor,
    }),
    queryFn: ({ signal }) =>
      fetchLeaveLedgerPage(
        {
          employeeId: requireEmployeeId(employeeId),
          ...(params.leaveTypeId !== undefined ? { leaveTypeId: params.leaveTypeId } : {}),
          ...(params.leaveYear !== undefined ? { leaveYear: params.leaveYear } : {}),
          ...(params.from !== undefined ? { from: params.from } : {}),
          ...(params.to !== undefined ? { to: params.to } : {}),
        },
        pageSize,
        cursor,
        signal,
      ),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

export interface RequestPageParams {
  readonly statuses?: readonly LeaveRequestStatus[];
  readonly from?: string;
  readonly to?: string;
  readonly pageSize?: number;
  readonly cursor?: Cursor | null;
}

/** One keyset page of my leave requests, most recent leave first. */
export function useLeaveRequests(
  params: RequestPageParams = {},
): UseQueryResult<Page<LeaveRequest>, Error> {
  const employeeId = useEmployeeId();
  const pageSize = params.pageSize ?? 20;
  const cursor = params.cursor ?? null;
  return useQuery({
    queryKey: qk.leave.requests(employeeId ?? NO_EMPLOYEE, {
      statuses: params.statuses ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
      pageSize,
      cursor,
    }),
    queryFn: ({ signal }) =>
      fetchLeaveRequestsPage(
        {
          employeeId: requireEmployeeId(employeeId),
          ...(params.statuses !== undefined ? { statuses: params.statuses } : {}),
          ...(params.from !== undefined ? { from: params.from } : {}),
          ...(params.to !== undefined ? { to: params.to } : {}),
        },
        pageSize,
        cursor,
        signal,
      ),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** Live (balance-holding) requests — the home "in flight" line. */
export function useOpenLeaveRequests(): UseQueryResult<LeaveRequest[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.leave.openRequests(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchOpenLeaveRequests(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** One request by id. `null` = not yours (RLS) or gone. */
export function useLeaveRequest(
  requestId: string | undefined,
): UseQueryResult<LeaveRequest | null, Error> {
  const id = requestId ?? "";
  return useQuery({
    queryKey: qk.leave.request(id),
    queryFn: ({ signal }) => fetchLeaveRequest(id, signal),
    enabled: id.length > 0,
    retry: shouldRetryQuery,
  });
}

/** My own leave days over a window — the calendar grid. */
export function useMyLeaveCalendar(range: {
  readonly from: string;
  readonly to: string;
}): UseQueryResult<LeaveCalendarDay[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.leave.myCalendar(employeeId ?? NO_EMPLOYEE, range.from, range.to),
    queryFn: ({ signal }) => fetchMyLeaveCalendar(requireEmployeeId(employeeId), range, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Aggregated comp-off balance. `null` = no live credits at all, which is an
 * action-phrased empty state ("Work a weekly off and it appears here"), not a
 * zero.
 */
export function useCompOffBalance(): UseQueryResult<CompOffBalance | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.compOff.balance(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchCompOffBalance(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** Individual credits, soonest expiry first — the E-06 "MY CREDITS" grid. */
export function useCompOffCredits(): UseQueryResult<CompOffCredit[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.compOff.credits(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchCompOffCredits(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}
