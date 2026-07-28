/**
 * useTeamDecisions.ts — the query layer behind /team/approvals, /team/attendance
 * and /team/leave.
 *
 * Three rules this file exists to hold in ONE place rather than in three pages:
 *
 *  1. EVERY TOTAL IS POSTGRES'S. Each count hook is a `count=exact` over the SAME
 *     filter array as the list hook beside it (`teamDayFilters`,
 *     `teamLeaveFilters`, `APPROVAL_SLICE_FILTERS`). A tile therefore cannot
 *     disagree with the grid it opens, because the number IS the cardinality of
 *     those rows — not `rows.length` after a cap, a page or a slow fetch.
 *  2. THE SCOPE IS RESOLVED ONCE. All three screens need "who is my team", and
 *     `useTeamRoster` is the single answer: the reporting closure from
 *     `v_team_hierarchy`, hydrated through the manager column allow-list. Nobody
 *     re-derives it, and a manager with no reportees produces an EMPTY list with
 *     no error — which is a real state, not a failure.
 *  3. NO OPTIMISTIC WRITES. `useDecideApproval` invalidates and re-reads. Leave
 *     days, balances and attendance figures are computed by database triggers
 *     inside the decision's own transaction; a client-side guess at the
 *     post-decision state is exactly how a screen starts lying.
 *
 * Nothing here computes a business number. Every hook moves server rows.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import { useAuditedMutation, type AuditedMutationResult } from "@/shared/hooks/useAuditedMutation";
import { useAuth } from "@/app/auth/AuthProvider";
import {
  countApprovalInboxSlice,
  countTeamDays,
  countTeamLeaveDays,
  decideApproval,
  fetchApprovalDetailRefs,
  fetchApprovalInbox,
  fetchApprovalTrail,
  fetchTeamDays,
  fetchTeamEdges,
  fetchTeamLeaveBalances,
  fetchTeamLeaveDays,
  fetchTeamLeaveRequestsByIds,
  fetchTeamMembersByIds,
  fetchTeamPeriodSummaries,
  LEAVE_REQUESTS_TABLE,
  type ApprovalDecisionInput,
  type ApprovalDecisionResult,
  type ApprovalDetailRef,
  type ApprovalInboxRow,
  type ApprovalSlice,
  type ApprovalTrail,
  type TeamDay,
  type TeamDayFilters,
  type TeamLeaveBalance,
  type TeamLeaveDay,
  type TeamLeaveFilters,
  type TeamLeaveRequest,
  type TeamMember,
  type TeamPeriodSummary,
} from "../api/team.api";

/** The inbox is a live queue; a manager should not have to reload the page. */
export const APPROVAL_REFETCH_MS = 60_000;

// -----------------------------------------------------------------------------
// 1. Who is my team
// -----------------------------------------------------------------------------

export interface TeamRoster {
  readonly members: readonly TeamMember[];
  /** The ids every other read on these screens is narrowed to. */
  readonly employeeIds: readonly string[];
  /** True when the closure resolved and this manager genuinely has nobody. */
  readonly isEmpty: boolean;
}

/**
 * The reporting closure, hydrated.
 *
 * Two reads in one query function because they are one fact: `v_team_hierarchy`
 * says WHO reports to this manager (recursively, `is_direct` distinguishing the
 * two), and `v_team_employee_basic` says what a manager may know about them. Both
 * are scoped in Postgres; passing the manager's own employee id narrows the
 * hierarchy view to its DOWNWARD half (it legitimately serves both directions)
 * and is a correctness filter, not a security claim.
 */
export function useTeamRoster(): UseQueryResult<TeamRoster, Error> {
  const { employee } = useAuth();
  const managerEmployeeId = employee?.employeeId ?? null;

  return useQuery({
    queryKey: qk.team.list({ view: "roster", manager: managerEmployeeId ?? "none" }),
    enabled: managerEmployeeId !== null,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }): Promise<TeamRoster> => {
      if (managerEmployeeId === null) return { members: [], employeeIds: [], isEmpty: true };
      const edges = await fetchTeamEdges(managerEmployeeId, false, signal);
      const ids = [...new Set(edges.map((e) => e.employee_id))];
      if (ids.length === 0) return { members: [], employeeIds: [], isEmpty: true };
      const members = await fetchTeamMembersByIds(ids, signal);
      return { members, employeeIds: members.map((m) => m.id), isEmpty: members.length === 0 };
    },
  });
}

/** `<SelectField>` options for the employee filter every team screen carries. */
export function useTeamMemberOptions(
  members: readonly TeamMember[] | undefined,
): { value: string; label: string }[] {
  return useMemo(
    () => (members ?? []).map((m) => ({ value: m.id, label: m.display_name })),
    [members],
  );
}

// -----------------------------------------------------------------------------
// 2. The approval queue
// -----------------------------------------------------------------------------

/**
 * Everything awaiting THIS manager's decision.
 *
 * No scope filter is passed: `v_approval_inbox` ends in
 * `app.current_employee_id() = ANY (ar.current_approver_ids)`, so the view is the
 * scope. An empty array from a successful read means "nothing is waiting on you"
 * and the page must render it as exactly that.
 */
export function useApprovalInbox(): UseQueryResult<ApprovalInboxRow[], Error> {
  return useQuery({
    queryKey: qk.team.approvals({ view: "inbox" }),
    queryFn: ({ signal }) => fetchApprovalInbox(signal),
    refetchInterval: APPROVAL_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** One tile's number, counted by Postgres over the tile's own predicate. */
export function useApprovalCount(slice: ApprovalSlice): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.team.approvals({ view: "count", slice }),
    queryFn: ({ signal }) => countApprovalInboxSlice(slice, signal),
    refetchInterval: APPROVAL_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

export interface ApprovalContext {
  /** approval_request_id → the polymorphic pointer + the submitted payload. */
  readonly refs: ReadonlyMap<string, ApprovalDetailRef>;
  /** leave_requests.id → the request, for the sentence the employee typed. */
  readonly leave: ReadonlyMap<string, TeamLeaveRequest>;
}

const EMPTY_CONTEXT: ApprovalContext = { refs: new Map(), leave: new Map() };

/**
 * The two facts the inbox view does not carry: what the request POINTS AT
 * (`detail_table` / `detail_id` / `summary`) and, for leave, the requester's own
 * reason.
 *
 * Deliberately a SEPARATE query from the queue. If this enrichment fails the
 * queue still renders and the extra columns show an em dash under a partial
 * banner — a manager can still decide on "3 days of Casual Leave" without the
 * free-text reason, and blanking the whole screen because a secondary read failed
 * would be the worse trade.
 */
export function useApprovalContext(
  rows: readonly ApprovalInboxRow[],
): UseQueryResult<ApprovalContext, Error> {
  const ids = useMemo(
    () => [...new Set(rows.map((r) => r.approval_request_id))].sort(),
    [rows],
  );

  return useQuery({
    queryKey: qk.team.approvals({ view: "context", ids }),
    enabled: ids.length > 0,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }): Promise<ApprovalContext> => {
      if (ids.length === 0) return EMPTY_CONTEXT;
      const refs = await fetchApprovalDetailRefs(ids, signal);
      const refMap = new Map<string, ApprovalDetailRef>();
      for (const ref of refs) refMap.set(ref.id, ref);

      const leaveIds = [
        ...new Set(
          refs.filter((r) => r.detail_table === LEAVE_REQUESTS_TABLE).map((r) => r.detail_id),
        ),
      ];
      const leaveRows = await fetchTeamLeaveRequestsByIds(leaveIds, signal);
      const leaveMap = new Map<string, TeamLeaveRequest>();
      for (const row of leaveRows) leaveMap.set(row.id, row);

      return { refs: refMap, leave: leaveMap };
    },
  });
}

/** The append-only trail of one request. Only fetched once a row is opened. */
export function useApprovalTrail(
  approvalRequestId: string | null,
): UseQueryResult<ApprovalTrail, Error> {
  return useQuery({
    queryKey: qk.team.approvals({ view: "trail", id: approvalRequestId ?? "none" }),
    enabled: approvalRequestId !== null,
    retry: shouldRetryQuery,
    queryFn: ({ signal }) => fetchApprovalTrail(approvalRequestId ?? "", signal),
  });
}

/**
 * Approve or reject, with a typed reason of at least 15 characters.
 *
 * `SENSITIVE_REASON_LENGTH` rather than the database's floor of 10: a decision
 * that moves somebody's leave balance and their pay is a D-21 action, and
 * "approved" is not a reason. The sentence becomes the decision comment on the
 * permanent trail as well as the `x-reason` on the write.
 *
 * On success EVERY affected surface is invalidated rather than patched: the queue,
 * the team leave board, the team attendance month, the employee's own leave
 * screens and the home "awaiting your action" tile all read rows that a database
 * trigger has just rewritten.
 */
export function useDecideApproval(
  onDone: (result: ApprovalDecisionResult, input: ApprovalDecisionInput) => void,
): AuditedMutationResult<ApprovalDecisionResult, ApprovalDecisionInput> {
  return useAuditedMutation<ApprovalDecisionResult, ApprovalDecisionInput>({
    mutationFn: (input, reason) => decideApproval(input, reason),
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.team.all, qk.approvals.all, qk.leave.all, qk.home.all, qk.attendance.all],
    onSuccess: (result, input) => onDone(result, input),
  });
}

// -----------------------------------------------------------------------------
// 3. Team attendance
// -----------------------------------------------------------------------------

/** One employee-day per row for the month, exception columns and all. */
export function useTeamDays(f: TeamDayFilters): UseQueryResult<TeamDay[], Error> {
  return useQuery({
    queryKey: qk.team.list({
      view: "days",
      from: f.from,
      to: f.to,
      slice: f.slice ?? "all",
      employees: [...f.employeeIds].sort(),
    }),
    enabled: f.employeeIds.length > 0,
    queryFn: ({ signal }) => fetchTeamDays(f, signal),
    retry: shouldRetryQuery,
  });
}

/** A tile: the same predicate as the grid, counted by the database. */
export function useTeamDayCount(
  f: TeamDayFilters,
  slice: TeamDayFilters["slice"],
): UseQueryResult<number, Error> {
  const withSlice: TeamDayFilters = {
    from: f.from,
    to: f.to,
    employeeIds: f.employeeIds,
    ...(slice !== undefined ? { slice } : {}),
  };
  return useQuery({
    queryKey: qk.team.list({
      view: "day-count",
      from: f.from,
      to: f.to,
      slice: slice ?? "all",
      employees: [...f.employeeIds].sort(),
    }),
    enabled: f.employeeIds.length > 0,
    queryFn: ({ signal }) => countTeamDays(withSlice, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * The month roll-up per employee, straight out of the §9.2 metric function.
 * This is the ONLY legitimate source of a per-employee monthly figure on a
 * manager screen — `late_pct` arrives already clamped, and `paid_days` arrives
 * with the half-days and leave fractions already applied.
 */
export function useTeamPeriodSummaries(
  from: string,
  to: string,
  employeeIds: readonly string[],
): UseQueryResult<TeamPeriodSummary[], Error> {
  return useQuery({
    queryKey: qk.team.list({
      view: "period-summary",
      from,
      to,
      employees: [...employeeIds].sort(),
    }),
    enabled: employeeIds.length > 0,
    queryFn: ({ signal }) => fetchTeamPeriodSummaries(from, to, employeeIds, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 4. Team leave
// -----------------------------------------------------------------------------

/** One employee-date per row: who is off, when, on what, in what state. */
export function useTeamLeaveDays(f: TeamLeaveFilters): UseQueryResult<TeamLeaveDay[], Error> {
  return useQuery({
    queryKey: qk.team.list({
      view: "leave-days",
      from: f.from,
      to: f.to,
      slice: f.slice ?? "all",
      employees: [...f.employeeIds].sort(),
    }),
    enabled: f.employeeIds.length > 0,
    queryFn: ({ signal }) => fetchTeamLeaveDays(f, signal),
    retry: shouldRetryQuery,
  });
}

export function useTeamLeaveCount(
  f: TeamLeaveFilters,
  slice: TeamLeaveFilters["slice"],
): UseQueryResult<number, Error> {
  const withSlice: TeamLeaveFilters = {
    from: f.from,
    to: f.to,
    employeeIds: f.employeeIds,
    ...(slice !== undefined ? { slice } : {}),
  };
  return useQuery({
    queryKey: qk.team.list({
      view: "leave-count",
      from: f.from,
      to: f.to,
      slice: slice ?? "all",
      employees: [...f.employeeIds].sort(),
    }),
    enabled: f.employeeIds.length > 0,
    queryFn: ({ signal }) => countTeamLeaveDays(withSlice, signal),
    retry: shouldRetryQuery,
  });
}

/** Generated balance columns per employee × leave type, current leave year. */
export function useTeamLeaveBalances(
  employeeIds: readonly string[],
): UseQueryResult<TeamLeaveBalance[], Error> {
  return useQuery({
    queryKey: qk.team.list({ view: "leave-balances", employees: [...employeeIds].sort() }),
    enabled: employeeIds.length > 0,
    queryFn: ({ signal }) => fetchTeamLeaveBalances(employeeIds, signal),
    retry: shouldRetryQuery,
  });
}
