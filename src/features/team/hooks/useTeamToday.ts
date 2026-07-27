/**
 * useTeamToday.ts — every TanStack query the manager surface makes.
 *
 * Three rules this file exists to hold:
 *
 *  1. EVERY TILE IS ITS OWN QUERY, and every tile's number is a server
 *     `count=exact` over the SAME predicate as the rows it filters to
 *     (`teamPresenceFilters`). Nothing here reads `rows.length`. One tile
 *     failing must not blank the other five — each renders its own state.
 *  2. KEYS ARE KEYED ON THE IST BUSINESS DATE. The cache then rolls over at IST
 *     midnight instead of serving yesterday's gate until somebody reloads.
 *  3. THE MANAGER'S OWN EMPLOYEE ID IS A PRECONDITION, NOT AN ASSUMPTION. A
 *     signed-in user with no employee record (a kiosk-only login) has no team;
 *     the hierarchy queries stay `enabled: false` and the page says so rather
 *     than firing a read that would return an ambiguous empty set.
 *
 * Keys come from `qk.team.*` only (frontend-contract §5). No key is invented
 * inline, and no key is added to the shared factory for this surface — the
 * existing `qk.team` entries cover all three screens.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { nowIstDate } from "@/lib/datetime";
import { useAuth } from "@/app/auth/AuthProvider";
import {
  countMyApprovalInbox,
  countTeamEdges,
  countTeamPresence,
  countTeamPunches,
  fetchShiftRefsByIds,
  fetchTeamCustomFields,
  fetchTeamEdge,
  fetchTeamEdges,
  fetchTeamMemberByCode,
  fetchTeamMembersByIds,
  fetchTeamPunches,
  fetchTeamToday,
  fetchTeamTodayForEmployee,
  type ShiftRef,
  type TeamCustomField,
  type TeamEdge,
  type TeamMember,
  type TeamPresenceSlice,
  type TeamPunch,
  type TeamTodayRow,
} from "../api/team.api";

/** How often the gate board asks again. An operations screen, not a report. */
export const TEAM_BOARD_REFETCH_MS = 45_000;
/** Slower cadences for facts that change on a human timescale. */
export const TEAM_SLOW_REFETCH_MS = 300_000;

type Count = UseQueryResult<number, Error>;

/** The IST business date every board key is keyed on. */
export function useIstToday(): string {
  return nowIstDate();
}

/**
 * The caller's own employee id. `null` for a signed-in login with no employee
 * record — a real state (kiosk-only staff), not an error.
 */
export function useMyEmployeeId(): string | null {
  return useAuth().employee?.employeeId ?? null;
}

// -----------------------------------------------------------------------------
// 1. Team Today
// -----------------------------------------------------------------------------

/** The board rows for the selected slice (or the whole team when none). */
export function useTeamToday(
  slice: TeamPresenceSlice | null,
  istDate: string,
): UseQueryResult<TeamTodayRow[], Error> {
  return useQuery({
    queryKey: qk.team.today({ date: istDate, slice: slice ?? "all", list: true }),
    queryFn: ({ signal }) => fetchTeamToday(slice, signal),
    refetchInterval: TEAM_BOARD_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** One tile. `slice: null` is the denominator — everyone on the board today. */
export function useTeamPresenceCount(slice: TeamPresenceSlice | null, istDate: string): Count {
  return useQuery({
    queryKey: qk.team.today({ date: istDate, slice: slice ?? "all", agg: "count" }),
    queryFn: ({ signal }) => countTeamPresence(slice, signal),
    refetchInterval: TEAM_BOARD_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** How many requests are waiting on this manager's decision, right now. */
export function useMyApprovalCount(): Count {
  return useQuery({
    queryKey: qk.team.approvals({ agg: "count", mine: true }),
    queryFn: ({ signal }) => countMyApprovalInbox(signal),
    refetchInterval: TEAM_SLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 2. My Team — the closure, then the key facts for exactly those people
// -----------------------------------------------------------------------------

/** The reporting edges: who reports to me, at what depth, directly or not. */
export function useTeamEdges(
  managerEmployeeId: string | null,
  directOnly: boolean,
): UseQueryResult<TeamEdge[], Error> {
  return useQuery({
    queryKey: qk.team.list({ edges: true, manager: managerEmployeeId, directOnly }),
    queryFn: ({ signal }) => fetchTeamEdges(managerEmployeeId ?? "", directOnly, signal),
    enabled: managerEmployeeId !== null,
    refetchInterval: TEAM_SLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** The header total: Postgres's count over the identical predicate. */
export function useTeamEdgeCount(managerEmployeeId: string | null, directOnly: boolean): Count {
  return useQuery({
    queryKey: qk.team.list({ edges: true, manager: managerEmployeeId, directOnly, agg: "count" }),
    queryFn: ({ signal }) => countTeamEdges(managerEmployeeId ?? "", directOnly, signal),
    enabled: managerEmployeeId !== null,
    refetchInterval: TEAM_SLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** Key facts for a known id set. Keyed on the SORTED set so order cannot split the cache. */
export function useTeamMembers(
  employeeIds: readonly string[],
): UseQueryResult<TeamMember[], Error> {
  const ids = useMemo(() => [...employeeIds].sort(), [employeeIds]);
  return useQuery({
    queryKey: qk.team.list({ members: ids }),
    queryFn: ({ signal }) => fetchTeamMembersByIds(ids, signal),
    enabled: ids.length > 0,
    staleTime: TEAM_SLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** Shift master rows behind the shift column. Same sorted-set keying. */
export function useShiftRefs(shiftIds: readonly string[]): UseQueryResult<ShiftRef[], Error> {
  const ids = useMemo(() => [...shiftIds].sort(), [shiftIds]);
  return useQuery({
    queryKey: qk.team.list({ shifts: ids }),
    queryFn: ({ signal }) => fetchShiftRefsByIds(ids, signal),
    enabled: ids.length > 0,
    staleTime: TEAM_SLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** id → shift, for a grid column that must never render a uuid. */
export function useShiftMap(shiftIds: readonly string[]): {
  map: ReadonlyMap<string, ShiftRef>;
  error: Error | null;
} {
  const query = useShiftRefs(shiftIds);
  const map = useMemo(() => {
    const m = new Map<string, ShiftRef>();
    for (const shift of query.data ?? []) m.set(shift.id, shift);
    return m;
  }, [query.data]);
  return { map, error: query.error };
}

// -----------------------------------------------------------------------------
// 3. Reportee profile
// -----------------------------------------------------------------------------

/** One reportee, by the employee code in the URL. */
export function useReportee(employeeCode: string): UseQueryResult<TeamMember, Error> {
  return useQuery({
    queryKey: qk.team.detail(employeeCode),
    queryFn: ({ signal }) => fetchTeamMemberByCode(employeeCode, signal),
    enabled: employeeCode !== "",
    staleTime: TEAM_SLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** How this reportee reports to me — the depth the profile states in words. */
export function useReporteeEdge(
  managerEmployeeId: string | null,
  employeeId: string | null,
): UseQueryResult<TeamEdge | null, Error> {
  return useQuery({
    queryKey: qk.team.list({ edge: true, manager: managerEmployeeId, employee: employeeId }),
    queryFn: ({ signal }) => fetchTeamEdge(managerEmployeeId ?? "", employeeId ?? "", signal),
    enabled: managerEmployeeId !== null && employeeId !== null,
    staleTime: TEAM_SLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** Today's gate row for one reportee — first scan, last scan, status. */
export function useReporteeToday(
  employeeId: string | null,
  istDate: string,
): UseQueryResult<TeamTodayRow | null, Error> {
  return useQuery({
    queryKey: qk.team.today({ date: istDate, employee: employeeId }),
    queryFn: ({ signal }) => fetchTeamTodayForEmployee(employeeId ?? "", signal),
    enabled: employeeId !== null,
    refetchInterval: TEAM_BOARD_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/**
 * How many business days of scans the profile shows.
 *
 * Not "today": one day's card would be blank for anybody on a weekly off, and a
 * blank card is read as a broken gate rather than as a day off. A week of the
 * log answers the question a manager actually has — "is this person scanning,
 * and when" — while staying small enough to read without paging.
 */
export const REPORTEE_SCAN_WINDOW_DAYS = 7;

/**
 * One reportee's raw scans over a business-date window, newest first.
 *
 * Keyed on the window, so the cache rolls over at IST midnight with the rest of
 * this file. Voided scans are in the result on purpose — the view includes and
 * flags them, and the screen strikes them through.
 */
export function useReporteePunches(
  employeeId: string | null,
  from: string,
  to: string,
): UseQueryResult<TeamPunch[], Error> {
  return useQuery({
    queryKey: qk.team.list({ view: "punches", employee: employeeId, from, to }),
    queryFn: ({ signal }) => fetchTeamPunches(employeeId ?? "", from, to, signal),
    enabled: employeeId !== null,
    refetchInterval: TEAM_BOARD_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/** The scan total: Postgres's count over the SAME window predicate as the list. */
export function useReporteePunchCount(
  employeeId: string | null,
  from: string,
  to: string,
): Count {
  return useQuery({
    queryKey: qk.team.list({ view: "punch-count", employee: employeeId, from, to }),
    queryFn: ({ signal }) => countTeamPunches(employeeId ?? "", from, to, signal),
    enabled: employeeId !== null,
    refetchInterval: TEAM_BOARD_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}

/**
 * A reportee's venue-specific fields, already joined to their definitions.
 *
 * An empty array from a SUCCESSFUL read is ambiguous in exactly one direction —
 * either nothing is recorded, or every field that is recorded is marked as
 * personal data and the view withheld it — so the screen states both rather than
 * claiming the record is blank.
 */
export function useReporteeCustomFields(
  employeeId: string | null,
): UseQueryResult<TeamCustomField[], Error> {
  return useQuery({
    queryKey: qk.team.list({ view: "custom-fields", employee: employeeId }),
    queryFn: ({ signal }) => fetchTeamCustomFields(employeeId ?? "", signal),
    enabled: employeeId !== null,
    staleTime: TEAM_SLOW_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}
