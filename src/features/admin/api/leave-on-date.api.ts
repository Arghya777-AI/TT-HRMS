/**
 * leave-on-date.api.ts — for the people the board says are on leave, WHICH leave, from when to
 * when, and why.
 *
 * ── WHY THIS IS A SEPARATE, LAZY QUERY ───────────────────────────────────────
 * Everything else the drill-down panels show is already in memory: the board fetched name, code,
 * department, status, both scan times, worked minutes, lateness and overtime for every visible
 * row, so opening a "Present" or "Late" or "Absent" list costs nothing and appears instantly.
 *
 * Leave is the exception. `v_attendance_today_board` knows somebody's status is `on_leave` but
 * carries no leave request with it, and the request is where the dates and the reason live. The
 * two honest options were to widen that view for every caller — it is the hottest view in the
 * console and it is read on every board load — or to ask for the leave rows only when somebody
 * actually opens an on-leave list. This is the second: the panel is opened rarely, the query is
 * scoped to the handful of employees in that one bucket, and react-query caches it.
 *
 * ── SCOPED TO THE EMPLOYEES IN THE BUCKET, NOT TO EVERYONE ───────────────────
 * The `in` filter is what keeps it small: a department with two people on leave asks about two
 * employees, not eighty. RLS still decides what comes back — this narrows the question, it does
 * not grant anything.
 */
import { z } from "zod";
import { dbDate, dbUuid, gte, inList, lte, selectMany } from "@/shared/api/query";

export const LEAVE_REQUESTS_TABLE = "leave_requests";

/** The statuses that mean somebody is actually away — a draft or a rejection is not leave. */
export const AWAY_STATUSES = ["pending", "approved", "partially_approved", "cancellation_pending"];

export const leaveOnDateSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  request_number: z.string().nullable(),
  from_date: dbDate,
  to_date: dbDate,
  total_days: z.coerce.number().nullable(),
  status: z.string(),
  reason: z.string().nullable(),
  portion: z.string().nullable(),
  leave_types: z.object({ name: z.string(), code: z.string() }).nullable(),
});

export type LeaveOnDate = z.infer<typeof leaveOnDateSchema>;

/**
 * Every live leave request covering `istDate` for the given employees.
 *
 * The date test is `from_date <= istDate <= to_date` rather than a join onto `leave_request_days`
 * — the request is what carries the span and the reason, and the board has already established
 * that the day itself counts as leave.
 */
export async function fetchLeaveOnDate(
  employeeIds: readonly string[],
  istDate: string,
  signal?: AbortSignal,
): Promise<LeaveOnDate[]> {
  // Nothing to ask about. Returning early keeps an empty bucket from issuing `in.()`, which
  // PostgREST rejects.
  if (employeeIds.length === 0) return [];

  return selectMany(LEAVE_REQUESTS_TABLE, leaveOnDateSchema, {
    columns:
      "id, employee_id, request_number, from_date, to_date, total_days, status, reason, portion, leave_types(name, code)",
    filters: [
      inList("employee_id", employeeIds),
      inList("status", AWAY_STATUSES),
      lte("from_date", istDate),
      gte("to_date", istDate),
    ],
    order: [{ column: "from_date", ascending: true }],
    ...(signal ? { signal } : {}),
  });
}
