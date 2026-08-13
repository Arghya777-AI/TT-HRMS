/**
 * useHome.ts — TanStack Query hooks for the `/me` dashboard.
 *
 * Keys come from `qk.home.*` (plus `qk.pay.latestPayslip` re-used as-is via
 * `usePay`), so a leave approval invalidating `qk.leave.all` and a home card
 * reading balances stay in step.
 *
 * The month strip, balances and comp-off hooks call the SAME api functions the
 * detail screens call. A home tile and its detail screen therefore read one
 * server row and cannot disagree.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { QueryError, shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import { resolveMyCalendar } from "@/features/holidays/api/holidays.api";
import { nowIstDate } from "@/lib/datetime";
import { istToday } from "@/lib/datetime";
import type { AttendanceDay, AttendancePeriodSummary } from "@/features/attendance/api/attendance.api";
import {
  fetchAnnouncements,
  fetchAttentionNotifications,
  fetchHomeBalances,
  fetchHomeMonthStrip,
  fetchMyEmployeeForHome,
  fetchTodayAttendance,
  fetchTodayShiftContext,
  fetchUpcomingHolidays,
  fetchUrgentAnnouncements,
  fetchWeeklyOffRule,
  subscribeToMyAttendanceDays,
  type Announcement,
  type Holiday,
  type HomeBalances,
  type MyEmployeeHome,
  type NotificationItem,
  type TodayShiftContext,
  type WeeklyOffRule,
} from "../api/home.api";

const NO_EMPLOYEE = "no-employee";

/**
 * The caller's own employee row (greeting band, holiday calendar pointer).
 * `null` = a signed-in account with no employee record (kiosk-only staff).
 */
export function useMyEmployee(): UseQueryResult<MyEmployeeHome | null, Error> {
  return useQuery({
    queryKey: qk.home.myEmployee(),
    queryFn: ({ signal }) => fetchMyEmployeeForHome(signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Today's attendance row, via `v_attendance_day_enriched` so shift and
 * leave-type labels come with it.
 *
 * Keyed on the IST business date so the entry rolls over at midnight IST, not at
 * the browser's midnight. `null` = the engine has not written today's row yet:
 * render "No punches yet today", never a zero-filled card.
 *
 * Region B of E-02 also subscribes to realtime `attendance_days` filtered to the
 * caller's own `employee_id`; on an event, invalidate `qk.home.today(...)`.
 */
export function useTodayAttendance(): UseQueryResult<AttendanceDay | null, Error> {
  const employeeId = useEmployeeId();
  const today = istToday();
  return useQuery({
    queryKey: qk.home.today(employeeId ?? NO_EMPLOYEE, today),
    queryFn: ({ signal }) => fetchTodayAttendance(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** Region D — the my-month strip. THE summary row, month-to-date. */
export function useHomeMonthStrip(): UseQueryResult<AttendancePeriodSummary | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.home.monthStrip(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchHomeMonthStrip(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Regions E + F — leave balances and the comp-off balance in one entry, so the
 * two cards cannot render a torn pair (one fresh, one stale).
 */
export function useHomeBalances(): UseQueryResult<HomeBalances, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.home.balances(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchHomeBalances(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * WHICH CALENDAR THIS PERSON'S HOLIDAYS COME FROM.
 *
 * Was `me.holiday_calendar_id` and nothing else — one source, on the employee
 * row. Reported as "for admin and manager can't see holiday list but employee
 * can": that column is NULL for every seeded employee, and the venue staff who
 * did see holidays were getting them from their SITE, a source this card never
 * consulted.
 *
 * `resolveMyCalendar` is the chain the /me/holidays screen uses — assignment,
 * then the employee override, then the site default, then the company calendar.
 * Shared rather than reimplemented, so the card and the screen it links to can
 * never disagree about which holidays are yours.
 */
export function useMyHolidayCalendarId(): UseQueryResult<string | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.home.upcomingHolidays(`calendar:${employeeId ?? NO_EMPLOYEE}`),
    queryFn: async ({ signal }) => {
      const resolved = await resolveMyCalendar(
        employeeId ?? "",
        nowIstDate(),
        signal,
      );
      return resolved?.calendarId ?? null;
    },
    /*
      Runs even with no employee id: an administrator account without an employee
      row still has the company calendar to read, and that is the case this fixes.
    */
    staleTime: 10 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/**
 * Region H — the next few holidays on the calendar that applies to this person.
 */
export function useUpcomingHolidays(limit = 5): UseQueryResult<Holiday[], Error> {
  const { data: calendarId = null } = useMyHolidayCalendarId();
  return useQuery({
    queryKey: qk.home.upcomingHolidays(calendarId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => {
      if (calendarId === null) {
        throw new QueryError(
          "holidays",
          "not_found",
          "No holiday calendar could be resolved — not on this employee, their site, or as a company default.",
        );
      }
      return fetchUpcomingHolidays({ holidayCalendarId: calendarId, limit }, signal);
    },
    enabled: calendarId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Region I — announcements, pinned first. Audience filtering is RLS
 * (`app.announcement_visible`), so this returns exactly what the employee may
 * see; there is no client-side audience check to get wrong.
 */
export function useAnnouncements(limit = 5): UseQueryResult<Announcement[], Error> {
  return useQuery({
    queryKey: qk.home.announcements(),
    queryFn: ({ signal }) => fetchAnnouncements(limit, signal),
    retry: shouldRetryQuery,
  });
}

/** High/critical notices only — the banner above the greeting band. */
export function useUrgentAnnouncements(): UseQueryResult<Announcement[], Error> {
  return useQuery({
    queryKey: qk.home.urgentAnnouncements(),
    queryFn: ({ signal }) => fetchUrgentAnnouncements(signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Region A — today's shift window (dated assignment overrides the employee's
 * default, spec §3.3).
 *
 * Keyed on the IST business date so it rolls over at midnight IST. Stays
 * disabled until `useMyEmployee()` resolves, because the fallback needs
 * `employees.shift_id`. Uses `qk.home.detail(...)` rather than a new entry in
 * the shared key factory.
 */
export function useTodayShiftContext(): UseQueryResult<TodayShiftContext, Error> {
  const employeeId = useEmployeeId();
  const meQuery = useMyEmployee();
  const me = meQuery.data ?? null;
  const today = istToday();
  const defaultShiftId = me?.shift_id ?? null;
  return useQuery({
    queryKey: qk.home.detail(`shift:${employeeId ?? NO_EMPLOYEE}:${today}:${defaultShiftId ?? "none"}`),
    queryFn: ({ signal }) =>
      fetchTodayShiftContext(
        { employeeId: requireEmployeeId(employeeId), defaultShiftId, date: today },
        signal,
      ),
    enabled: employeeId !== null && me !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Region A — the employee's weekly-off rule. `weekly_off_rules.name` is already
 * the sentence form ("Sunday + Alternate Saturday"), so nothing is assembled
 * client-side from the dow/weeks arrays (DR-60).
 */
export function useWeeklyOffRule(): UseQueryResult<WeeklyOffRule | null, Error> {
  const { data: me } = useMyEmployee();
  const ruleId = me?.weekly_off_rule_id ?? null;
  return useQuery({
    queryKey: qk.home.detail(`weekly-off-rule:${ruleId ?? "none"}`),
    queryFn: ({ signal }) => fetchWeeklyOffRule(ruleId ?? "", signal),
    enabled: ruleId !== null,
    // Reference data: a rule changes when HR reassigns it, not during a session.
    staleTime: 60 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/**
 * Region C — "Needs your attention".
 *
 * Reads the server-written notification feed (see `fetchAttentionNotifications`
 * for why: `rpc_my_pending_actions()` is not deployed). Ranking and the max-5
 * truncation happen in the component; severity comes from the row's own
 * `priority`.
 */
export function useAttentionItems(): UseQueryResult<NotificationItem[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    // `qk.home.pendingActions()` carries no employee id, and sign-out does not
    // clear the cache — on a shared device that would serve one employee's queue
    // to the next. Scoped through the factory's own `detail(...)` instead; both
    // still sit under the `qk.home.all` invalidation prefix.
    queryKey: qk.home.detail(`attention:${employeeId ?? NO_EMPLOYEE}`),
    queryFn: ({ signal }) => fetchAttentionNotifications(requireEmployeeId(employeeId), 20, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Region B realtime: a gate scan invalidates today's row and the month strip, so
 * the card and the strip move together and cannot disagree (spec §10: punch →
 * home within 2s). Subscribes only to the caller's own `attendance_days` rows.
 */
export function useAttendanceRealtime(): void {
  const employeeId = useEmployeeId();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (employeeId === null) return;
    return subscribeToMyAttendanceDays(employeeId, () => {
      void queryClient.invalidateQueries({ queryKey: qk.home.today(employeeId, istToday()) });
      void queryClient.invalidateQueries({ queryKey: qk.home.monthStrip(employeeId) });
      void queryClient.invalidateQueries({ queryKey: qk.attendance.all });
    });
  }, [employeeId, queryClient]);
}
