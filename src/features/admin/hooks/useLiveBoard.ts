/**
 * useLiveBoard — the today board behind /admin/attendance/live.
 *
 * The presence counts are NOT computed from the loaded rows. Each one is a server
 * `count=exact` over `v_attendance_today_board` using the same predicate as the
 * grid it drills into (`boardSliceFilters`), which is the same function the
 * Command Centre's chips use. So the chip on the home screen, the tile here and
 * the rows below cannot disagree — and the number does not change depending on
 * how many rows happened to load.
 *
 * The board refetches on an interval because it is a live operations screen, and
 * `dataUpdatedAt` is surfaced so the page can say when it last heard from the
 * server rather than implying the number is current to the second.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  fetchTodayBoard,
  type TodayBoardFilters,
  type TodayBoardRow,
} from "../api/attendance.api";

/** How often the live board asks again. Operations screen, not a report. */
export const LIVE_BOARD_REFETCH_MS = 45_000;

export function useTodayBoard(
  filters: TodayBoardFilters,
  istDate: string,
): UseQueryResult<TodayBoardRow[], Error> {
  return useQuery({
    queryKey: qk.admin.todayBoard({
      date: istDate,
      state: filters.state ?? "all",
      departments: [...(filters.departmentIds ?? [])].sort(),
      list: true,
    }),
    queryFn: ({ signal }) => fetchTodayBoard(filters, signal),
    refetchInterval: LIVE_BOARD_REFETCH_MS,
    retry: shouldRetryQuery,
  });
}
