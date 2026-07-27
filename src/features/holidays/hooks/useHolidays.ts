/**
 * useHolidays.ts — hooks for E-15. Keys from `qk.holidays.*`.
 *
 * `today` is part of the query key on purpose: the calendar is resolved by
 * `resolve_policy(..., p_date)` and "the next holiday" is picked relative to the
 * same IST date, so a session left open across midnight must not keep showing
 * yesterday's answer from cache.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import { nowIstDate } from "@/lib/datetime";
import { fetchHolidayYear, type HolidayYearPayload } from "../api/holidays.api";

const NO_EMPLOYEE = "no-employee";

/** My calendar for one year, plus the engine's row for each holiday date. */
export function useHolidayYear(year: number | null): UseQueryResult<HolidayYearPayload, Error> {
  const employeeId = useEmployeeId();
  const today = nowIstDate();
  return useQuery({
    queryKey: qk.holidays.list({ employeeId: employeeId ?? NO_EMPLOYEE, year, today }),
    queryFn: ({ signal }) =>
      fetchHolidayYear(requireEmployeeId(employeeId), year, today, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}
