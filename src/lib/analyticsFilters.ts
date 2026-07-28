/**
 * analyticsFilters.ts — the ONE filter state every analytics surface shares.
 *
 * WHAT THE CLIENT ASKED FOR
 * -------------------------
 *   "Department-wise and employee-wise (and any other filter they can apply),
 *    everything can be filtered… On every details page, the same filters should
 *    apply… It's kind of like Power BI: first the dashboard is shown, then you click
 *    'more data', click 'more data'."
 *
 * That last sentence is the whole design constraint. A drill-down is only coherent if
 * the filter travels with the click — otherwise the number on the tile and the rows
 * on the screen it opens are answering different questions, which is the single most
 * common way a dashboard loses people's trust.
 *
 * THE MODEL
 * ---------
 * `AnalyticsFilters` = a {@link Period} (day / week / month / year / custom range)
 * plus a set of DIMENSION narrowings. Every field is optional except the period, and
 * every field is URL-backed, so:
 *
 *   * a filtered view can be bookmarked and sent to somebody;
 *   * a reload keeps what you were looking at;
 *   * `withFilters(path, filters)` turns any link into a drill-through that inherits
 *     the exact question being asked.
 *
 * WHY DIMENSIONS ARE IDs, NOT NAMES. `departmentId`, not "Banquet": a department can
 * be renamed and two locations can hold departments with the same name. The label is
 * looked up for display; the filter is the key.
 *
 * WHY `source` IS HERE. The client wants web and on-premise punches told apart —
 * "if there is web login or on-premise login, everything will be captured". That is
 * `attendance_punches.source`, already recorded on every row, and it is a first-class
 * filter rather than a checkbox buried in one screen.
 *
 * TOTAL PARSING, like {@link periodFromParams}: a hand-trimmed URL degrades to the
 * default rather than throwing. An analytics screen that white-screens because
 * somebody edited the address bar is worse than one that shows this month.
 */
import {
  type Period,
  defaultPeriod,
  periodFromParams,
  periodToParams,
} from "@/lib/period";

/**
 * How a punch was recorded. Mirrors `public.punch_source`; `all` is the absence of a
 * filter rather than a value, so it is never sent to the server.
 */
export type SourceFilter = "all" | "web" | "kiosk_face" | "mobile" | "import" | "manual";

export const SOURCE_FILTERS: readonly SourceFilter[] = [
  "all",
  "web",
  "kiosk_face",
  "mobile",
  "import",
  "manual",
];

export interface AnalyticsFilters {
  readonly period: Period;
  /** `public.departments.id`. Undefined = every department. */
  readonly departmentId?: string;
  /** `public.locations.id`. Undefined = every location. */
  readonly locationId?: string;
  /** `public.employees.id`. Undefined = everybody. Set by the employee drill-down. */
  readonly employeeId?: string;
  /** How the attendance was captured. `all` = no narrowing. */
  readonly source: SourceFilter;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Every query-string key this model owns, so a caller can strip or preserve them. */
export const FILTER_PARAM_KEYS = ["g", "from", "to", "dept", "loc", "emp", "src"] as const;

export function defaultFilters(): AnalyticsFilters {
  return { period: defaultPeriod(), source: "all" };
}

export function filtersFromParams(params: URLSearchParams): AnalyticsFilters {
  const dept = params.get("dept");
  const loc = params.get("loc");
  const emp = params.get("emp");
  const src = params.get("src");
  return {
    period: periodFromParams(params),
    // A malformed id is DROPPED, not passed through: sending "undefined" to a uuid
    // column is a 400 from PostgREST and an error card the user cannot act on.
    ...(dept !== null && UUID.test(dept) ? { departmentId: dept } : {}),
    ...(loc !== null && UUID.test(loc) ? { locationId: loc } : {}),
    ...(emp !== null && UUID.test(emp) ? { employeeId: emp } : {}),
    source:
      src !== null && (SOURCE_FILTERS as readonly string[]).includes(src)
        ? (src as SourceFilter)
        : "all",
  };
}

export function filtersToParams(filters: AnalyticsFilters): Record<string, string> {
  return {
    ...periodToParams(filters.period),
    // Omitted rather than empty: a bare `?dept=` in a shared URL is noise, and an
    // empty string is not a uuid.
    ...(filters.departmentId === undefined ? {} : { dept: filters.departmentId }),
    ...(filters.locationId === undefined ? {} : { loc: filters.locationId }),
    ...(filters.employeeId === undefined ? {} : { emp: filters.employeeId }),
    ...(filters.source === "all" ? {} : { src: filters.source }),
  };
}

/**
 * Put these filters onto a path — the primitive that makes every tile, bar and row a
 * drill-through that keeps the question intact.
 *
 * Anything already in the target's query string is preserved, so a caller can write
 * `withFilters("/admin/attendance/days?status=late", filters)` and get both.
 */
export function withFilters(path: string, filters: AnalyticsFilters): string {
  const [base, existing] = path.split("?");
  const params = new URLSearchParams(existing ?? "");
  for (const key of FILTER_PARAM_KEYS) params.delete(key);
  for (const [k, v] of Object.entries(filtersToParams(filters))) params.set(k, v);
  const qs = params.toString();
  return qs === "" ? (base ?? path) : `${base ?? path}?${qs}`;
}

/** Narrow to one employee, keeping period and every other dimension. The drill-down. */
export function forEmployee(filters: AnalyticsFilters, employeeId: string): AnalyticsFilters {
  return { ...filters, employeeId };
}

/** Narrow to one department, keeping the period. */
export function forDepartment(filters: AnalyticsFilters, departmentId: string): AnalyticsFilters {
  return { ...filters, departmentId };
}

/**
 * How many dimensions are narrowing the view right now.
 *
 * Drives the "N filters active · clear" affordance. Without it the commonest support
 * question on any dashboard is "why is this number so small" when a filter three
 * clicks ago is still applied and nothing on screen says so.
 */
export function activeDimensionCount(filters: AnalyticsFilters): number {
  return (
    (filters.departmentId === undefined ? 0 : 1) +
    (filters.locationId === undefined ? 0 : 1) +
    (filters.employeeId === undefined ? 0 : 1) +
    (filters.source === "all" ? 0 : 1)
  );
}

/** Drop every dimension, keep the period. "Clear filters" never resets the dates. */
export function clearDimensions(filters: AnalyticsFilters): AnalyticsFilters {
  return { period: filters.period, source: "all" };
}
