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

export function useTodayRoster(
  enabled = true,
  /** The IST date to show. Defaults to today, which is the live board. */
  date?: string,
): UseQueryResult<TodayRoster, Error> {
  const day = date ?? istToday();
  const isToday = day === istToday();
  return useQuery({
    // Keyed on the date so the roster rolls over at midnight rather than at UTC, and so
    // stepping to yesterday and back does not re-fetch what is already cached.
    queryKey: qk.attendance.detail(`roster:${day}`),
    queryFn: ({ signal }) => fetchTodayRoster({ signal, date: day }),
    enabled,
    staleTime: 30_000,
    /*
      Only today polls. A past day cannot change while somebody looks at it, so refetching it
      every minute would be a query a minute for a settled answer — and on a dashboard left
      open on a wall, all night.
    */
    ...(isToday ? { refetchInterval: 60_000 } : {}),
    retry: shouldRetryQuery,
  });
}
