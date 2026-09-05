/**
 * useCommandCentre.ts — TanStack hooks for §1 (Command Centre, Alert Feed,
 * My Admin Tasks).
 *
 * Keys come from `qk.admin.*` only (frontend-contract §5). Every tile is its OWN
 * query on purpose: spec-admin §2.1 gives each tile its own refresh cadence, and
 * one tile failing (a view the caller may not read) must not blank the other
 * eleven — each renders its own honest state.
 *
 * The board slices are keyed by the IST business date so the cache rolls over at
 * IST midnight instead of showing yesterday's gate until someone reloads.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { nowIstDate } from "@/lib/datetime";
import {
  countActiveKioskDevices,
  countAlerts,
  countBoardSlice,
  countBoardTotal,
  countCompOffExpiring,
  countEnrolmentGaps,
  countExpiringDocuments,
  countHeadcount,
  countMyAdminTasks,
  countPunchesNeedingReview,
  fetchAlertFeed,
  fetchGateFeed,
  fetchLatestPayrollRun,
  countFaceAsksAwaitingEmployee,
  countFaceCapturesAwaitingApproval,
  countOpenHelpdeskTickets,
  fetchMyAdminTasks,
  fetchMySlaBreaches,
  type AdminTask,
  type AlertFilters,
  type BoardSlice,
  type ExceptionRow,
  type PunchRow,
} from "../api/command.api";
import { fetchKioskHealth, type KioskHealthRow } from "../api/system.api";
import type { PayrollRun } from "../api/payroll.api";

/** spec-admin §2.1 refresh column. `live` stands in for Realtime: the 12
 *  published tables do not include a board, so the honest version is a short
 *  poll with the interval stated on screen. */
export const REFRESH = {
  live: 30_000,
  minute: 60_000,
  fiveMinutes: 300_000,
  hour: 3_600_000,
} as const;

type Count = UseQueryResult<number, Error>;

/** Tile 1 · Headcount. */
export function useHeadcount(): Count {
  return useQuery({
    queryKey: qk.admin.headcount(),
    queryFn: ({ signal }) => countHeadcount(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.minute,
  });
}

/** Tiles 2–4 and every chip on the live ops band. */
export function useBoardSlice(slice: BoardSlice, istDate: string): Count {
  return useQuery({
    queryKey: qk.admin.todayBoard({ date: istDate, slice }),
    queryFn: ({ signal }) => countBoardSlice(slice, signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.live,
  });
}

/** The denominator the band names out loud ("14 people rostered on the board"). */
export function useBoardTotal(istDate: string): Count {
  return useQuery({
    queryKey: qk.admin.todayBoard({ date: istDate, slice: "all" }),
    queryFn: ({ signal }) => countBoardTotal(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });
}

/** Tile 5 · every open exception, and the header count on `/admin/alerts`. */
export function useAlertCount(filters: AlertFilters): Count {
  return useQuery({
    queryKey: qk.admin.exceptions({ ...filters, agg: "count" }),
    queryFn: ({ signal }) => countAlerts(filters, signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });
}

/** The feed itself — compact on `/admin`, full on `/admin/alerts`. */
export function useAlertFeed(
  filters: AlertFilters,
  limit: number,
): UseQueryResult<ExceptionRow[], Error> {
  return useQuery({
    queryKey: qk.admin.exceptions({ ...filters, limit }),
    queryFn: ({ signal }) => fetchAlertFeed(filters, limit, signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });
}

/** Tile 6 · approvals routed to THIS administrator. */
export function useMyTaskCount(): Count {
  return useQuery({
    queryKey: qk.admin.approvalInboxCount(),
    queryFn: ({ signal }) => countMyAdminTasks(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.minute,
  });
}

export function useMyTasks(): UseQueryResult<AdminTask[], Error> {
  return useQuery({
    queryKey: qk.admin.approvalInbox(),
    queryFn: ({ signal }) => fetchMyAdminTasks(100, signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.minute,
  });
}

/** Service-level breaches recorded against me, not against the organisation. */
export function useMySlaBreaches(employeeId: string | null): UseQueryResult<ExceptionRow[], Error> {
  return useQuery({
    queryKey: qk.admin.approvalSla(),
    queryFn: ({ signal }) => fetchMySlaBreaches(employeeId ?? "", 50, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });
}

/** Tile 7 · scans the kiosk flagged for a human. */
export function usePunchReviewCount(): Count {
  return useQuery({
    queryKey: qk.admin.punches({ review: true, agg: "count" }),
    queryFn: ({ signal }) => countPunchesNeedingReview(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });
}

/** HR asked for a face and the person has not come to the camera yet. */
export function useFaceAskCount(): Count {
  return useQuery({
    queryKey: qk.admin.detail("face-asks-open"),
    queryFn: ({ signal }) => countFaceAsksAwaitingEmployee(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });
}

/** A capture exists and is waiting for an administrator to approve it. */
export function useFaceCaptureCount(): Count {
  return useQuery({
    queryKey: qk.admin.detail("face-captures-pending"),
    queryFn: ({ signal }) => countFaceCapturesAwaitingApproval(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });
}

/** Help tickets nobody has closed, inside this administrator's scope. */
export function useOpenHelpdeskCount(): Count {
  return useQuery({
    queryKey: qk.admin.detail("helpdesk-open"),
    queryFn: ({ signal }) => countOpenHelpdeskTickets(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });
}

/** Tile 8 · required documents expired or inside the server's expiry window. */
export function useExpiringDocumentCount(): Count {
  return useQuery({
    queryKey: qk.admin.documentCompliance({ expiring: true, agg: "count" }),
    queryFn: ({ signal }) => countExpiringDocuments(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.hour,
  });
}

/** Tile 9 · employees holding comp-off that lapses inside 30 days. */
export function useCompOffExpiringCount(): Count {
  return useQuery({
    queryKey: qk.admin.compOffExpiring(),
    queryFn: ({ signal }) => countCompOffExpiring(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.hour,
  });
}

/** Tile 10 · the newest payroll run and its server status. */
export function useLatestPayrollRun(): UseQueryResult<PayrollRun | null, Error> {
  return useQuery({
    queryKey: qk.admin.payrollRuns({ latest: true }),
    queryFn: ({ signal }) => fetchLatestPayrollRun(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });
}

/** Tile 11 · gates registered and live. */
export function useActiveKioskCount(): Count {
  return useQuery({
    queryKey: qk.admin.kioskDevices(),
    queryFn: ({ signal }) => countActiveKioskDevices(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.live,
  });
}

/** Tile 11 · gates the SERVER considers silent (the 15-minute rule is in the view). */
export function useKioskOfflineCount(): Count {
  const filters: AlertFilters = { kinds: ["kiosk_offline"] };
  return useQuery({
    queryKey: qk.admin.exceptions({ ...filters, agg: "count" }),
    queryFn: ({ signal }) => countAlerts(filters, signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.live,
  });
}

/** Tile 12 · employees who cannot use the gate yet. */
export function useEnrolmentGapCount(): Count {
  return useQuery({
    queryKey: qk.admin.enrolmentGaps(),
    queryFn: ({ signal }) => countEnrolmentGaps(signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });
}

/** Live ops · the last scans of the IST business day. */
export function useGateFeed(istDate: string, limit = 30): UseQueryResult<PunchRow[], Error> {
  return useQuery({
    queryKey: qk.admin.punches({ feed: "gate", date: istDate, limit }),
    queryFn: ({ signal }) => fetchGateFeed(istDate, limit, signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.live,
  });
}

/** Live ops · per-device match rate and latency for today, straight from the view. */
export function useKioskHealthToday(istDate: string): UseQueryResult<KioskHealthRow[], Error> {
  return useQuery({
    queryKey: qk.admin.kioskHealth(istDate, istDate),
    queryFn: ({ signal }) => fetchKioskHealth(istDate, istDate, signal),
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.live,
  });
}

/** The IST business date every hook above is keyed on. */
export function useIstToday(): string {
  return nowIstDate();
}
