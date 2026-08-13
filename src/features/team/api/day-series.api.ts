/**
 * day-series.api.ts — a day run a bar chart can be drawn from.
 *
 * ── WHY THE EXISTING QUERY COULD NOT BE USED ───────────────────────────────
 *
 * A per-person day run on Team Attendance was declined when the charts went in,
 * and the reason was not laziness: `useTeamDays` is SLICE-FILTERED. Choose the
 * "late" slice and it returns only late days, so a run built from it would show
 * an otherwise normal fortnight as a fortnight of gaps. It is also capped at
 * `TEAM_DAY_ROW_CAP = 1200`, so on a large team a missing day could equally mean
 * "truncated".
 *
 * A gap in a bar means one thing to a reader: nothing was recorded. Three
 * possible meanings for one gap is a chart that misinforms, which is worse than
 * no chart.
 *
 * Migration 042900 added `f_team_day_fractions`: unfiltered, uncapped, and
 * bounded by the employees ASKED FOR rather than by a row limit — so the result
 * is proportional to what is on screen and an absent date means exactly what it
 * appears to mean. `attendance_days` RLS still decides whose days come back.
 */
import { z } from "zod";
import { dbDate, dbInt, dbNumeric, dbUuid, rpcMany } from "@/shared/api/query";

export const DAY_SERIES_FN = "f_team_day_fractions";

export const teamDayPointSchema = z.object({
  employee_id: dbUuid,
  ist_date: dbDate,
  /** `attendance_status` as text — the vocabulary the day badges already use. */
  status: z.string(),
  /** `numeric(4,3)`: 0.5 on a half day, so never an integer. */
  day_fraction_paid: dbNumeric,
  worked_minutes: dbInt,
});

export type TeamDayPoint = z.infer<typeof teamDayPointSchema>;

/**
 * One point per employee per day that HAS a record, for the people passed in.
 *
 * The caller passes the page of employees it is drawing — not the whole team —
 * so the cost tracks what is visible. An employee with no rows in the window
 * genuinely has no records in it.
 */
export function fetchTeamDaySeries(
  employeeIds: readonly string[],
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<TeamDayPoint[]> {
  return rpcMany(
    DAY_SERIES_FN,
    { p_employee_ids: [...employeeIds], p_from: from, p_to: to },
    teamDayPointSchema,
    signal ? { signal } : {},
  );
}

/**
 * Group the flat series by employee, keyed for O(1) lookup while rendering rows.
 *
 * Grouping, not aggregating: no sums, no averages, no derived percentages. The
 * points are the server's and stay the server's.
 */
export function byEmployee(points: readonly TeamDayPoint[]): Map<string, TeamDayPoint[]> {
  const out = new Map<string, TeamDayPoint[]>();
  for (const point of points) {
    const list = out.get(point.employee_id);
    if (list === undefined) out.set(point.employee_id, [point]);
    else list.push(point);
  }
  return out;
}

/**
 * Fill the window so a date with no record becomes an explicit `null` bar.
 *
 * This is the whole point of the exercise: the chart must distinguish "worked
 * nothing" from "nothing recorded", and only an entry that is present-but-null
 * can say the second thing. Dates are walked as civil strings — no Date
 * arithmetic, no timezone to get wrong.
 */
export function fillWindow(
  points: readonly TeamDayPoint[],
  from: string,
  to: string,
): readonly { readonly date: string; readonly point: TeamDayPoint | null }[] {
  const found = new Map(points.map((p) => [p.ist_date, p]));
  const out: { date: string; point: TeamDayPoint | null }[] = [];
  /*
    `from` and `to` are 'YYYY-MM-DD' and the window is a handful of weeks, so a
    lexical walk over the days between them is both correct and cheap. The loop
    is bounded at 400 so a malformed range cannot spin.
  */
  let cursor = from;
  for (let guard = 0; guard < 400 && cursor <= to; guard += 1) {
    out.push({ date: cursor, point: found.get(cursor) ?? null });
    cursor = nextDay(cursor);
  }
  return out;
}

/** The next civil date, computed on the string rather than through a Date. */
function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map((part) => Number.parseInt(part, 10));
  if (y === undefined || m === undefined || d === undefined) return iso;
  const daysInMonth = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const last = daysInMonth[m - 1] ?? 31;
  if (d < last) return `${pad4(y)}-${pad2(m)}-${pad2(d + 1)}`;
  if (m < 12) return `${pad4(y)}-${pad2(m + 1)}-01`;
  return `${pad4(y + 1)}-01-01`;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}
