/**
 * holidays.api.ts — the E-15 reads.
 *
 * Two sources, deliberately kept apart:
 *  - `holiday_calendars` + `holidays` are the CALENDAR: what the company
 *    published for a year.
 *  - `v_attendance_day_enriched` is what the attendance engine actually made of
 *    that date FOR THIS EMPLOYEE. The "For you" column reads the engine's row —
 *    the same row `/me/attendance` renders — so a holiday cannot say "Holiday"
 *    here and "Working" there.
 *
 * spec-employee §5 E-15 also asks for optional-holiday ELECTION
 * (`employee_optional_holiday_elections`). No such table is deployed, and
 * `holidays.is_optional` is the only optional-ness in the schema, so this module
 * exposes no election write. The screen says so rather than offering a button
 * that silently does nothing.
 *
 * WHICH CALENDAR (verified against the live project, not assumed):
 *   `employees.holiday_calendar_id` is NULL for every seeded employee, yet the
 *   attendance engine still treats 26-Jan as a holiday. It does that through
 *   `public.resolve_policy('holiday_calendar', employee, date)` (migration 018
 *   line 283), which reads the effective-dated `policy_assignments` row — live,
 *   that is one company-scoped assignment of KA-2026. Reading only the employee
 *   column, as the first version of this module did, therefore rendered "no
 *   calendar assigned" on a screen whose own attendance rows say otherwise.
 *   So resolution here is the SERVER's, in the engine's own order:
 *     1. resolve_policy(...)                      — the assignment table
 *     2. employees.holiday_calendar_id            — the per-employee override
 *        (migration 019 line 773 uses exactly this COALESCE)
 *     3. locations.default_holiday_calendar_id    — the site default (seeded)
 *   Nothing is guessed in the browser; step 1 is a Postgres function call and
 *   the screen names which step answered.
 */
import { z } from "zod";
import {
  dbDate,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  lte,
  rpcOne,
  selectCount,
  selectMany,
  selectOne,
} from "@/shared/api/query";
import {
  DAY_ENRICHED_VIEW,
  attendanceDaySchema,
  type AttendanceDay,
} from "@/features/attendance/api/attendance.api";

export const MY_EMPLOYEE_VIEW = "v_my_employee";
export const HOLIDAY_CALENDARS_TABLE = "holiday_calendars";
export const HOLIDAYS_TABLE = "holidays";
export const LOCATIONS_TABLE = "locations";
export const RESOLVE_POLICY_FN = "resolve_policy";

/** `public.holiday_type` (migration 003). */
export const holidayTypeSchema = z.enum([
  "national",
  "state",
  "festival",
  "restricted",
  "optional",
  "company",
  "venue_closure",
]);
export type HolidayType = z.infer<typeof holidayTypeSchema>;

// -----------------------------------------------------------------------------
// 1. Which calendar am I on?
// -----------------------------------------------------------------------------

export const myCalendarRefSchema = z.object({
  id: dbUuid,
  holiday_calendar_id: dbUuidNullable,
  department_id: dbUuidNullable,
  location_id: dbUuidNullable,
});

export type MyCalendarRef = z.infer<typeof myCalendarRefSchema>;

/** `v_my_employee` is pinned to `app.current_employee_id()` by its own WHERE. */
export async function fetchMyCalendarRef(signal?: AbortSignal): Promise<MyCalendarRef | null> {
  return selectOne(MY_EMPLOYEE_VIEW, myCalendarRefSchema, [], {
    columns: "id, holiday_calendar_id, department_id, location_id",
    ...(signal ? { signal } : {}),
  });
}

/** Which of the three server sources named in the header answered. */
export type CalendarSource = "assignment" | "employee" | "location" | "default";

export interface ResolvedCalendarRef {
  readonly calendarId: string;
  readonly source: CalendarSource;
}

/**
 * `public.resolve_policy(kind, employee, date)` — the SAME function the
 * attendance engine calls. Returns the calendar id, or null when no assignment
 * covers the date.
 */
export async function resolveAssignedCalendarId(
  employeeId: string,
  isoDate: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return rpcOne(
    RESOLVE_POLICY_FN,
    { p_kind: "holiday_calendar", p_employee_id: employeeId, p_date: isoDate },
    dbUuid,
    signal ? { signal } : {},
  );
}

const locationDefaultSchema = z.object({
  id: dbUuid,
  name: z.string(),
  default_holiday_calendar_id: dbUuidNullable,
});

/** The site default (`locations.default_holiday_calendar_id`), seeded live. */
export async function fetchLocationDefaultCalendarId(
  locationId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const row = await selectOne(LOCATIONS_TABLE, locationDefaultSchema, [eq("id", locationId)], {
    columns: "id, name, default_holiday_calendar_id",
    ...(signal ? { signal } : {}),
  });
  return row?.default_holiday_calendar_id ?? null;
}

/**
 * THE COMPANY DEFAULT — the fourth source, and the one that was missing.
 *
 * Reported: "for admin and manager can't see holiday list but employee can".
 * Exactly right, and the reason is that all three sources above are keyed to the
 * caller's OWN employee row: an assignment, an override on the row, or the
 * default of the LOCATION they are posted to. An administrator or a manager who
 * is not posted to a site has none of the three and got an empty screen — while
 * a venue employee, who has a location, got the list.
 *
 * The public holidays of the company are not private to whoever happens to have
 * a location on their record. `holidays__ref_read` has always allowed any
 * authenticated caller to read the active ones; nothing but this resolution
 * chain was stopping them.
 *
 * `is_default` picks the calendar, and the year is matched to the date being
 * viewed so January does not silently show last year's list.
 */
export async function fetchDefaultCalendarId(
  isoDate: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const year = Number.parseInt(isoDate.slice(0, 4), 10);
  const rows = await selectMany(HOLIDAY_CALENDARS_TABLE, holidayCalendarSchema, {
    columns: CALENDAR_COLUMNS,
    filters: [eq("is_default", true), eq("is_active", true)],
    order: [{ column: "year", ascending: false }],
    limit: 20,
    ...(signal ? { signal } : {}),
  });
  if (rows.length === 0) return null;
  // The year being viewed, else the most recent — never nothing when a calendar
  // exists, because "no calendar" reads as "the company has no holidays".
  const match = rows.find((row) => row.year === year) ?? rows[0];
  return match?.id ?? null;
}

/** Resolution in the engine's own order — see the module header. */
export async function resolveMyCalendar(
  employeeId: string,
  isoDate: string,
  signal?: AbortSignal,
): Promise<ResolvedCalendarRef | null> {
  const assigned = await resolveAssignedCalendarId(employeeId, isoDate, signal);
  if (assigned !== null) return { calendarId: assigned, source: "assignment" };

  const me = await fetchMyCalendarRef(signal);
  if (me === null) {
    // No employee row at all — a pure administrator account. The company
    // calendar is still theirs to read.
    const fallback = await fetchDefaultCalendarId(isoDate, signal);
    return fallback === null ? null : { calendarId: fallback, source: "default" };
  }
  if (me.holiday_calendar_id !== null) {
    return { calendarId: me.holiday_calendar_id, source: "employee" };
  }
  if (me.location_id !== null) {
    const fromLocation = await fetchLocationDefaultCalendarId(me.location_id, signal);
    if (fromLocation !== null) return { calendarId: fromLocation, source: "location" };
  }
  /*
    Last: the company default. Deliberately last, so anybody who HAS a calendar
    of their own still sees theirs — this widens who sees a list without changing
    which list an employee sees.
  */
  const fallback = await fetchDefaultCalendarId(isoDate, signal);
  if (fallback !== null) return { calendarId: fallback, source: "default" };
  return null;
}

export const holidayCalendarSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  year: z.number().int(),
  state: z.string(),
  optional_holiday_quota: z.number().int(),
  is_default: z.boolean(),
});

export type HolidayCalendar = z.infer<typeof holidayCalendarSchema>;

const CALENDAR_COLUMNS = "id, code, name, year, state, optional_holiday_quota, is_default";

export async function fetchHolidayCalendar(
  calendarId: string,
  signal?: AbortSignal,
): Promise<HolidayCalendar | null> {
  return selectOne(HOLIDAY_CALENDARS_TABLE, holidayCalendarSchema, [eq("id", calendarId)], {
    columns: CALENDAR_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The other years of the SAME calendar. A `holiday_calendars` row is scoped to
 * one `year`, so "next year" is a different row with the same `code` — that is
 * the year switcher, read from the data instead of guessed from the clock.
 */
export async function fetchCalendarYears(
  code: string,
  signal?: AbortSignal,
): Promise<HolidayCalendar[]> {
  return selectMany(HOLIDAY_CALENDARS_TABLE, holidayCalendarSchema, {
    columns: CALENDAR_COLUMNS,
    filters: [eq("code", code), eq("is_active", true)],
    order: [{ column: "year", ascending: true }],
    limit: 20,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. The calendar itself
// -----------------------------------------------------------------------------

export const holidaySchema = z.object({
  id: dbUuid,
  holiday_calendar_id: dbUuid,
  holiday_date: dbDate,
  name: z.string(),
  local_name: z.string().nullable(),
  holiday_type: holidayTypeSchema,
  is_paid: z.boolean(),
  is_optional: z.boolean(),
  applies_to_department_ids: z.array(dbUuid).nullable(),
  applies_to_location_ids: z.array(dbUuid).nullable(),
  working_if_event_booked: z.boolean(),
  compensatory_off_if_worked: z.boolean(),
  description: z.string().nullable(),
});

export type Holiday = z.infer<typeof holidaySchema>;

const HOLIDAY_COLUMNS =
  "id, holiday_calendar_id, holiday_date, name, local_name, holiday_type, is_paid, is_optional, " +
  "applies_to_department_ids, applies_to_location_ids, working_if_event_booked, " +
  "compensatory_off_if_worked, description";

/**
 * Every published holiday on one calendar, in date order.
 *
 * `applies_to_department_ids` / `applies_to_location_ids` are NOT filtered here:
 * NULL means "everyone", and deciding applicability for a given employee is
 * engine work — `attendance_days.is_holiday` is the authoritative per-employee
 * answer, which is exactly what the "For you" column reads.
 */
export async function fetchHolidaysForCalendar(
  calendarId: string,
  year: number,
  signal?: AbortSignal,
): Promise<Holiday[]> {
  return selectMany(HOLIDAYS_TABLE, holidaySchema, {
    columns: HOLIDAY_COLUMNS,
    filters: yearFilters(calendarId, year),
    order: [{ column: "holiday_date", ascending: true }],
    limit: 80,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. What the engine made of those dates, for me
// -----------------------------------------------------------------------------

/**
 * The engine's own rows for a handful of dates.
 *
 * Reads `v_attendance_day_enriched` with the attendance domain's own schema, so
 * this is literally the row `/me/attendance` shows — not a second interpretation
 * of it. Dates with no row (future, or not yet rolled up) simply have no entry.
 */
export async function fetchDayRowsForDates(
  employeeId: string,
  dates: readonly string[],
  signal?: AbortSignal,
): Promise<AttendanceDay[]> {
  if (dates.length === 0) return [];
  return selectMany(DAY_ENRICHED_VIEW, attendanceDaySchema, {
    filters: [eq("employee_id", employeeId), inList("ist_date", dates)],
    order: [{ column: "ist_date", ascending: true }],
    limit: dates.length,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. The screen's payload
// -----------------------------------------------------------------------------

/** The filter array shared by the list read and every count of it. */
function yearFilters(calendarId: string, year: number) {
  return [
    eq("holiday_calendar_id", calendarId),
    eq("is_active", true),
    gte("holiday_date", `${year}-01-01`),
    lte("holiday_date", `${year}-12-31`),
  ] as const;
}

/**
 * Published-holiday counts for the year, counted by Postgres over the SAME
 * filters the list uses (`count=exact`, HEAD). The tiles cannot disagree with
 * the table below them, and no `rows.length` is involved.
 */
export interface HolidayCounts {
  readonly total: number;
  readonly optional: number;
  readonly paid: number;
}

export async function fetchHolidayCounts(
  calendarId: string,
  year: number,
  signal?: AbortSignal,
): Promise<HolidayCounts> {
  const base = yearFilters(calendarId, year);
  const opts = signal ? { signal } : {};
  const [total, optional, paid] = await Promise.all([
    selectCount(HOLIDAYS_TABLE, base, opts),
    selectCount(HOLIDAYS_TABLE, [...base, eq("is_optional", true)], opts),
    selectCount(HOLIDAYS_TABLE, [...base, eq("is_paid", true)], opts),
  ]);
  return { total, optional, paid };
}

/**
 * The next holiday on or after `isoDate` — picked by Postgres (`ORDER BY
 * holiday_date LIMIT 1`), not by scanning the loaded page in the browser, so it
 * stays right even when the year read is capped.
 */
export async function fetchNextHoliday(
  calendarId: string,
  isoDate: string,
  signal?: AbortSignal,
): Promise<Holiday | null> {
  return selectOne(
    HOLIDAYS_TABLE,
    holidaySchema,
    [eq("holiday_calendar_id", calendarId), eq("is_active", true), gte("holiday_date", isoDate)],
    {
      columns: HOLIDAY_COLUMNS,
      order: [{ column: "holiday_date", ascending: true }],
      ...(signal ? { signal } : {}),
    },
  );
}

export interface HolidayYearPayload {
  readonly calendar: HolidayCalendar | null;
  /** Which server source named the calendar — null when nothing resolved. */
  readonly source: CalendarSource | null;
  readonly years: readonly HolidayCalendar[];
  readonly holidays: readonly Holiday[];
  /** ist_date → the engine's row for that date. */
  readonly dayRows: Readonly<Record<string, AttendanceDay>>;
  readonly counts: HolidayCounts | null;
  readonly next: Holiday | null;
}

const EMPTY_PAYLOAD: HolidayYearPayload = {
  calendar: null,
  source: null,
  years: [],
  holidays: [],
  dayRows: {},
  counts: null,
  next: null,
};

/**
 * One read for the whole screen: my calendar (server-resolved), its sibling
 * years, the holidays of the chosen year, the engine's rows for exactly those
 * dates, and the server counts.
 *
 * `year === null` means "whatever year my resolved calendar covers", so a first
 * visit never asks the employee to pick a year that may not exist.
 */
export async function fetchHolidayYear(
  employeeId: string,
  year: number | null,
  today: string,
  signal?: AbortSignal,
): Promise<HolidayYearPayload> {
  const resolved = await resolveMyCalendar(employeeId, today, signal);
  if (resolved === null) return EMPTY_PAYLOAD;

  const assigned = await fetchHolidayCalendar(resolved.calendarId, signal);
  if (assigned === null) return EMPTY_PAYLOAD;

  const years = await fetchCalendarYears(assigned.code, signal);
  const calendar = year === null ? assigned : (years.find((c) => c.year === year) ?? assigned);

  const [holidays, counts, next] = await Promise.all([
    fetchHolidaysForCalendar(calendar.id, calendar.year, signal),
    fetchHolidayCounts(calendar.id, calendar.year, signal),
    fetchNextHoliday(calendar.id, today, signal),
  ]);

  const rows = await fetchDayRowsForDates(
    employeeId,
    holidays.map((h) => h.holiday_date),
    signal,
  );

  const dayRows: Record<string, AttendanceDay> = {};
  for (const row of rows) dayRows[row.ist_date] = row;

  return { calendar, source: resolved.source, years, holidays, dayRows, counts, next };
}
