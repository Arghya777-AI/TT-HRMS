/**
 * analyticsHome.ts — the decisions the analytics dashboard makes before it draws
 * anything, as pure functions. No React, no network, no clock.
 *
 * THE ONE THAT MATTERS: WHEN A TILE MAY LINK TO THE DAY RECORDS SCREEN
 * --------------------------------------------------------------------
 * DR-29 in one sentence: a tile must be the cardinality of exactly the row set
 * its drill-through opens. The dashboard counts over `AnalyticsFilters` — a
 * period of ANY shape, plus department, location, employee and capture source.
 * `/admin/attendance/days` answers a narrower vocabulary, verified by reading
 * that screen rather than assumed:
 *
 *      ?date=YYYY-MM-DD   one IST day        ?status=<attendance_status>
 *      ?m=YYYY-MM         one calendar month ?late=true      ?exceptions=true
 *      ?department=<NAME> (it filters `department_name`, exactly as our scope
 *                          resolver does — same predicate, same rows)
 *      ?employee=<uuid>
 *
 * There is NO location filter and no arbitrary date range. So a fortnight, or
 * any period narrowed by location, CANNOT be expressed there — and a link that
 * silently widened the answer would be worse than no link at all: the tile would
 * say 41 and the screen it opened would list 300.
 *
 * {@link dayRecordsHref} therefore returns `null` for exactly those cases, and
 * the caller falls back to the analytics screen that owns the measure. Refusing
 * to build the URL is the whole point of the function; every caller must handle
 * the null rather than coercing it.
 *
 * `withFilters` is still applied on top, so the full filter state rides along in
 * the query string for any screen that learns to read it later.
 */
import { istMonthRange } from "@/lib/datetime";
import { withFilters, type AnalyticsFilters } from "@/lib/analyticsFilters";
import type { MessageKey } from "@/shared/i18n/en";
import type { AttendanceStatus } from "./api/attendance.api";
import {
  hmToMinutes,
  type AnalyticsDayRow,
  type AttendanceMeasures,
  type DayClass,
} from "./analyticsAggregate";

// -----------------------------------------------------------------------------
// Drill-through targets
// -----------------------------------------------------------------------------

export const DAY_RECORDS_PATH = "/admin/attendance/days";

/** The one extra predicate a tile narrows the day records by. */
export interface DayRecordsSelector {
  readonly status?: AttendanceStatus;
  readonly late?: boolean;
  readonly exceptions?: boolean;
}

/**
 * A link to the day records that opens EXACTLY the rows a figure was computed
 * over — or `null` when this period and these dimensions cannot be said in that
 * screen's vocabulary. See the header for why null is a feature.
 *
 * `departmentName` is the name the scope resolved the department id to; passing
 * `null` while `filters.departmentId` is set means the id resolved to nothing,
 * which is also unlinkable (the figures behind it are empty by design).
 */
export function dayRecordsHref(
  filters: AnalyticsFilters,
  departmentName: string | null,
  selector: DayRecordsSelector = {},
): string | null {
  // No location predicate exists there; a location-scoped figure cannot link.
  if (filters.locationId !== undefined) return null;
  if (filters.departmentId !== undefined && departmentName === null) return null;

  const params = new URLSearchParams();
  const { period } = filters;
  if (period.from === period.to) {
    params.set("date", period.from);
  } else {
    const month = period.from.slice(0, 7);
    const whole = istMonthRange(month);
    if (whole.from !== period.from || whole.to !== period.to) return null;
    params.set("m", month);
  }

  if (departmentName !== null) params.set("department", departmentName);
  // `emp` (the analytics param) and `employee` (that screen's param) are the same
  // uuid under two names; both are set so either reader is satisfied.
  if (filters.employeeId !== undefined) params.set("employee", filters.employeeId);
  if (selector.status !== undefined) params.set("status", selector.status);
  if (selector.late === true) params.set("late", "true");
  if (selector.exceptions === true) params.set("exceptions", "true");

  return withFilters(`${DAY_RECORDS_PATH}?${params.toString()}`, filters);
}

// -----------------------------------------------------------------------------
// The status ring
// -----------------------------------------------------------------------------

/**
 * The ring, in drawing order. Adjacent slices are kept apart in hue as well as
 * in label, and the colours are the app's semantic tokens so a slice and its
 * status chip agree — the same rule `MonthDonut` follows.
 *
 * `status` is the SINGLE `attendance_status` a class maps to, where there is
 * one. Four classes group several statuses (present covers six, leave three,
 * "outside employment" three) and the day records screen filters one status at
 * a time, so those slices have no honest drill-through and say so instead of
 * opening a wider list.
 */
export interface DayClassSlice {
  readonly key: DayClass;
  readonly labelKey: MessageKey;
  readonly color: string;
  /** Draw as a hatch rather than a hue — reserved for "not processed yet". */
  readonly texture?: true;
  readonly status: AttendanceStatus | null;
}

export const DAY_CLASS_SLICES: readonly DayClassSlice[] = [
  {
    key: "present",
    labelKey: "admin.analytics.dash.class.present",
    color: "hsl(var(--success))",
    status: null,
  },
  {
    key: "leave",
    labelKey: "admin.analytics.dash.class.leave",
    color: "hsl(var(--chart-4))",
    status: null,
  },
  {
    key: "weekly_off",
    labelKey: "admin.analytics.dash.class.weeklyOff",
    color: "hsl(var(--chart-3))",
    status: "weekly_off",
  },
  {
    key: "holiday",
    labelKey: "admin.analytics.dash.class.holiday",
    color: "hsl(var(--chart-6))",
    status: "holiday",
  },
  {
    key: "absent",
    labelKey: "admin.analytics.dash.class.absent",
    color: "hsl(var(--destructive))",
    status: "absent",
  },
  {
    key: "not_counted",
    labelKey: "admin.analytics.dash.class.notCounted",
    color: "hsl(var(--chart-8))",
    status: null,
  },
  {
    key: "pending",
    labelKey: "admin.analytics.dash.class.pending",
    color: "hsl(var(--muted))",
    texture: true,
    status: "pending",
  },
];

/**
 * The measure behind one slice. Exhaustive over {@link DayClass}, and the seven
 * values sum to `daysCounted` exactly — which is what lets the ring's centre
 * state the total without adding anything up.
 *
 * Leave is counted in ROWS, not in `leaveDays`: a ring is a composition of days,
 * and a half-day's 0.5 would leave the slices short of the centre figure. The
 * fractional total is a tile of its own.
 */
export function dayClassValue(measures: AttendanceMeasures, key: DayClass): number {
  switch (key) {
    case "present":
      return measures.presentDays;
    case "absent":
      return measures.absentDays;
    case "leave":
      return measures.leaveDayRows;
    case "holiday":
      return measures.holidayDays;
    case "weekly_off":
      return measures.weeklyOffDays;
    case "pending":
      return measures.pendingDays;
    case "not_counted":
      return measures.notCountedDays;
  }
}

/** Narrow a legend key back to a slice identity without an `as` cast. */
export function toDayClass(key: string): DayClass | null {
  return DAY_CLASS_SLICES.find((slice) => slice.key === key)?.key ?? null;
}

// -----------------------------------------------------------------------------
// Arrival-time distribution
// -----------------------------------------------------------------------------

export interface ArrivalBucket {
  /** IST hour of the first scan, 0–23. */
  readonly hour: number;
  /** Day rows whose first scan fell in this hour. */
  readonly dayCount: number;
}

/**
 * When people actually arrive: day rows counted by the IST hour of their FIRST
 * scan.
 *
 * Every input is the server's — `first_in_hm` is rendered by the view as
 * `to_char(util.ist_ts(first_in_at), 'HH24:MI')`, so the hour is IST by
 * construction and nothing here re-derives a wall clock from an instant. All
 * this does is count rows into 24 boxes.
 *
 * Rows with no scan (absences, weekly offs, a day the engine has not processed)
 * are NOT bucketed: they are not late arrivals and they are not 00:00 arrivals.
 * The count of what was skipped is returned alongside, because a histogram over
 * 40 of 900 rows that does not say so is a lie about the shape of the day.
 *
 * The result runs from the earliest to the latest hour that actually occurred,
 * INCLUDING the empty hours in between. Those zeroes are real — nobody arrived
 * at 11:00 — and dropping them would compress a two-shift venue's twin peaks
 * into one solid block.
 */
export interface ArrivalDistribution {
  readonly buckets: readonly ArrivalBucket[];
  /** Rows that carried a first scan and were counted. */
  readonly scannedRows: number;
  /** Rows with no first scan at all — never bucketed, always stated. */
  readonly unscannedRows: number;
}

export const EMPTY_ARRIVALS: ArrivalDistribution = {
  buckets: [],
  scannedRows: 0,
  unscannedRows: 0,
};

export function bucketArrivals(rows: readonly AnalyticsDayRow[]): ArrivalDistribution {
  const counts = new Map<number, number>();
  let scannedRows = 0;
  let unscannedRows = 0;

  for (const row of rows) {
    const minutes = hmToMinutes(row.first_in_hm);
    if (minutes === null) {
      unscannedRows += 1;
      continue;
    }
    scannedRows += 1;
    const hour = Math.floor(minutes / 60);
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }

  if (counts.size === 0) return { buckets: [], scannedRows, unscannedRows };

  const hours = [...counts.keys()];
  const first = Math.min(...hours);
  const last = Math.max(...hours);
  const buckets: ArrivalBucket[] = [];
  for (let hour = first; hour <= last; hour += 1) {
    buckets.push({ hour, dayCount: counts.get(hour) ?? 0 });
  }
  return { buckets, scannedRows, unscannedRows };
}

/**
 * Minutes from IST midnight → a 24-hour wall clock string the datetime module
 * can format ('9:05' → '09:05').
 *
 * Deliberately not `fmtDuration`: '9:05' as a DURATION is nine hours and five
 * minutes, and the average arrival time is not a duration. Minutes past 24h (a
 * night shift's departure) wrap, so the caller must know which end it is
 * formatting — this is only ever used on arrivals, which by construction fall
 * inside the business date.
 */
export function clockOfMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour)}:${minute < 10 ? `0${String(minute)}` : String(minute)}`;
}

// -----------------------------------------------------------------------------
// Department id resolution
// -----------------------------------------------------------------------------

export interface NamedRef {
  readonly id: string;
  readonly name: string;
}

/**
 * The department id behind a bar, or `null` when clicking it could not narrow
 * the view honestly.
 *
 * The day view records the department NAME (migration 034 selects `d.name`, not
 * `d.id`), so the bars are keyed by name. Two active departments may share one.
 * When they do, no single id can stand for that bar — filtering to either would
 * quietly drop half the days the bar was drawn from — so the bar is left inert
 * and the ambiguity is already reported by the scope resolver's caveat.
 */
export function departmentIdFor(
  name: string | null,
  departments: readonly NamedRef[],
): string | null {
  if (name === null) return null;
  const matches = departments.filter((d) => d.name === name);
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}
