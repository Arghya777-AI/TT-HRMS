/**
 * useTodayRoster — today's roster for the dashboard.
 *
 * A short `staleTime` and a refetch interval, because this is the one panel on the page that is
 * about NOW rather than about a chosen period: somebody watching the door wants the list to
 * catch up on its own. One minute, matching the gate's own flush cadence — often enough to feel
 * live, rare enough that a dashboard left open on a wall is not a load problem.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { istToday } from "@/lib/datetime";
import { fetchTodayRoster, type TodayRoster } from "../api/todayRoster.api";

export function useTodayRoster(enabled = true): UseQueryResult<TodayRoster, Error> {
  return useQuery({
    // Keyed on the IST date so the roster rolls over at midnight rather than at UTC.
    queryKey: qk.attendance.detail(`today-roster:${istToday()}`),
    queryFn: ({ signal }) => fetchTodayRoster({ signal }),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: shouldRetryQuery,
  });
}
