/**
 * analyticsAggregate.ts — the ONLY place an analytics number is computed in the
 * browser, deliberately kept in a module that imports no network client at all.
 *
 * WHY THIS FILE IS SEPARATE FROM analytics.api.ts
 * -----------------------------------------------
 * PostgREST cannot GROUP BY. `v_attendance_day_enriched` is one row per employee
 * per IST day and there is no deployed view that rolls it up by department, by
 * employee or by date over an arbitrary period — `v_attendance_monthly_summary`
 * is a matview pinned to (year, month), and `f_attendance_period_summary` is per
 * employee. So a filterable, drill-through analytics surface has exactly two
 * honest options: ship new SQL, or fetch the day rows and add them up here.
 *
 * This is the second option, with the arithmetic quarantined:
 *
 *   * NOTHING in this file touches the network, a clock or a locale. Every
 *     function is pure and takes its rows as an argument, so the whole of the
 *     analytics maths is exercised by `analyticsAggregate.test.ts` with literals.
 *   * Every number produced here is CLIENT-AGGREGATED and is labelled as such by
 *     `AnalyticsProvenance` in analytics.api.ts. The per-day inputs — worked
 *     minutes, late minutes, the anomaly flags, the status — are all the
 *     engine's, computed by Postgres and merely added up here.
 *   * AVERAGES NEVER DIVIDE BY ZERO AND NEVER SWALLOW A NULL. Every mean goes
 *     through {@link MeanAcc}, which counts only finite samples and returns
 *     `null` — not `0` — when there were none. Zero worked minutes and "we have
 *     no idea how long they worked" are different facts and a dashboard that
 *     prints them the same way is lying.
 *
 * DENOMINATORS ARE NAMED, NOT ASSUMED. Averaging worked minutes over every row
 * in the period drags the figure toward zero with every weekly off, holiday and
 * absence, which is how "average day 4h 10m" appears under a team that never
 * works less than eight hours. The late average is therefore over LATE days, and
 * the three duration averages are over COMPLETE days. Every denominator ships
 * alongside its average in {@link AttendanceMeasures} so a screen can state it.
 *
 * WHY COMPLETE AND NOT MERELY ATTENDED. `punch_count > 0` is the wrong gate for a
 * DURATION, and the engine is what makes it wrong: on a day with exactly one scan
 * it sets `last_out_at := NULL` (attendance_engine.sql, the `v_count = 1` branch)
 * and `util.minutes_between(first, NULL)` returns 0, so the row reaches us with
 * `punch_count = 1`, `gross_span_minutes = 0` and `total_worked_minutes = 0`.
 * Those zeroes are NOT "they worked no time" — they are "nobody recorded when
 * they left", the `single_punch_only` anomaly this page counts on its own tile.
 * Sampling them halves a fortnight's average for one forgotten scan-out. So a
 * duration is sampled only from a row that carries BOTH ends of the day, and
 * `attendedDays` survives as the honest count it always was — just not as the
 * denominator of a duration.
 */
import { addDays, daysBetween, type Period } from "@/lib/period";

// -----------------------------------------------------------------------------
// The row shape this module was written against
// -----------------------------------------------------------------------------

/**
 * `public.attendance_status` (migration 003). Declared here, rather than
 * imported from `attendance.api.ts`, so this module stays free of the supabase
 * client — but analytics.api.ts hands it rows typed by that module's
 * `attendanceStatusSchema`, so if the deployed enum ever gains a value the
 * assignment at the call site stops compiling and {@link classifyDayStatus}
 * has to be updated. That is the drift guard; there is no runtime fallback.
 */
export type DayStatus =
  | "present"
  | "half_day"
  | "absent"
  | "weekly_off"
  | "holiday"
  | "on_leave"
  | "on_leave_half"
  | "weekly_off_worked"
  | "holiday_worked"
  | "comp_off_availed"
  | "on_duty"
  | "work_from_home"
  | "suspended"
  | "not_yet_joined"
  | "post_exit"
  | "pending";

/**
 * The projection of `v_attendance_day_enriched` the aggregation needs, in the
 * view's own snake_case so a reader can check a measure against the SQL without
 * translating names. Structural: analytics.api.ts's zod-parsed row satisfies it,
 * and dropping a column from that schema breaks the call site at compile time.
 */
export interface AnalyticsDayRow {
  readonly employee_id: string;
  readonly employee_code: string;
  readonly display_name: string;
  readonly ist_date: string;
  readonly status: DayStatus;
  readonly department_name: string | null;
  readonly location_name: string | null;
  /** Server-rendered IST wall clock 'HH:MM'. Null when there was no scan. */
  readonly first_in_hm: string | null;
  readonly last_out_hm: string | null;
  readonly punch_count: number;
  readonly gross_span_minutes: number;
  readonly break_minutes: number;
  readonly break_count: number;
  readonly total_worked_minutes: number;
  readonly is_late: boolean;
  readonly late_minutes: number;
  readonly is_early_exit: boolean;
  readonly early_exit_minutes: number;
  readonly overtime_minutes: number;
  readonly approved_overtime_minutes: number;
  readonly leave_type_name: string | null;
  readonly leave_day_fraction: number;
  readonly is_holiday: boolean;
  readonly is_weekly_off: boolean;
  readonly is_working_day: boolean;
  readonly has_anomalies: boolean;
}

// -----------------------------------------------------------------------------
// Means that refuse to lie
// -----------------------------------------------------------------------------

/** Running mean over finite samples only. O(1) memory over 10k rows. */
interface MeanAcc {
  sum: number;
  n: number;
}

function newMean(): MeanAcc {
  return { sum: 0, n: 0 };
}

/** Nulls, undefineds, NaN and ±Infinity are NOT samples — they are absences. */
function addSample(m: MeanAcc, value: number | null | undefined): void {
  if (value === null || value === undefined || !Number.isFinite(value)) return;
  m.sum += value;
  m.n += 1;
}

/** `null` when nothing was sampled — the only division-by-zero guard needed. */
function meanOf(m: MeanAcc): number | null {
  return m.n === 0 ? null : m.sum / m.n;
}

/**
 * Mean of a list, ignoring absent values, `null` when none remain.
 *
 * Exported because it is the contract the rest of this file is built on and the
 * one a test can pin directly. Results are NOT rounded: rounding is the
 * formatter's job (`fmtDuration`), and rounding twice is how a column of minutes
 * stops adding up to its own total.
 */
export function meanIgnoringNulls(
  values: readonly (number | null | undefined)[],
): number | null {
  const m = newMean();
  for (const v of values) addSample(m, v);
  return meanOf(m);
}

// -----------------------------------------------------------------------------
// Clock arithmetic on the server's wall-clock strings
// -----------------------------------------------------------------------------

const HM = /^(\d{1,2}):(\d{2})$/;

/**
 * 'HH:MM' IST wall clock → minutes since IST midnight. `null` for absent or
 * malformed input — never `0`, which is a real time (00:00).
 *
 * The view already rendered these in IST (`to_char(util.ist_ts(...), 'HH24:MI')`),
 * which is exactly why the average is computed from the STRING and not from the
 * timestamptz: re-deriving a wall clock in the browser would read the host zone.
 */
export function hmToMinutes(hm: string | null | undefined): number | null {
  if (hm === null || hm === undefined) return null;
  const m = HM.exec(hm);
  if (m === null) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** First-in and last-out of one day, as minutes from IST midnight. */
export interface DayClock {
  readonly firstIn: number | null;
  /**
   * Minutes from IST midnight OF THE BUSINESS DATE — so a night shift that
   * clocks out at 07:00 the next morning reads 1860, not 420.
   */
  readonly lastOut: number | null;
}

/**
 * The day's clock pair, with the midnight crossing resolved.
 *
 * This venue runs a night shift (`SEC-N — 07:00 PM to 07:00 AM`), and its last
 * scan lands on the FOLLOWING calendar day while still belonging to this
 * business date. Averaging the raw wall clock would put "average leaving time"
 * at 07:00 for a team that leaves at seven in the morning after starting at
 * seven at night — the average would sit before the average start. Adding a day
 * when the out-time precedes the in-time keeps the pair ordered and the mean
 * meaningful; the formatter takes it modulo 24h if it wants a clock face.
 */
export function dayClockMinutes(row: {
  readonly first_in_hm: string | null;
  readonly last_out_hm: string | null;
}): DayClock {
  const firstIn = hmToMinutes(row.first_in_hm);
  const rawOut = hmToMinutes(row.last_out_hm);
  if (rawOut === null) return { firstIn, lastOut: null };
  if (firstIn !== null && rawOut < firstIn) return { firstIn, lastOut: rawOut + 1440 };
  return { firstIn, lastOut: rawOut };
}

// -----------------------------------------------------------------------------
// Status classification
// -----------------------------------------------------------------------------

/**
 * What one day counts as in a headline. Mirrors the buckets
 * `v_attendance_today_board` uses server-side, so the analytics page and the
 * live board cannot disagree about what "present" means.
 */
export type DayClass =
  | "present"
  | "absent"
  | "leave"
  | "holiday"
  | "weekly_off"
  | "pending"
  | "not_counted";

/**
 * Exhaustive by construction: every arm returns, there is no `default`, so a new
 * value in `public.attendance_status` fails to compile here rather than being
 * silently dropped into a bucket nobody chose.
 *
 * `pending` is its own class and is NEVER folded into absent — the engine has
 * simply not processed that day yet, and an unprocessed day shown as an absence
 * is the single most damaging thing an attendance dashboard can do to a person.
 */
export function classifyDayStatus(status: DayStatus): DayClass {
  switch (status) {
    // Worked, in one form or another. Working a weekly off or a holiday counts
    // as present AND leaves `extra_work_minutes` on the row for the OT line.
    case "present":
    case "half_day":
    case "weekly_off_worked":
    case "holiday_worked":
    case "on_duty":
    case "work_from_home":
      return "present";
    case "absent":
      return "absent";
    case "on_leave":
    case "on_leave_half":
    case "comp_off_availed":
      return "leave";
    case "holiday":
      return "holiday";
    case "weekly_off":
      return "weekly_off";
    case "pending":
      return "pending";
    // Not the employee's day to attend: outside employment, or suspended.
    case "suspended":
    case "not_yet_joined":
    case "post_exit":
      return "not_counted";
  }
}

// -----------------------------------------------------------------------------
// The measure set
// -----------------------------------------------------------------------------

/**
 * Every headline measure, over whatever set of day rows was handed in. The same
 * shape is returned for the whole period, for one department, for one employee
 * and for one date, so a bar, a row and a tile are computed by the same code and
 * cannot drift apart.
 */
export interface AttendanceMeasures {
  /** Day rows counted — the denominator of nothing, the size of the answer. */
  readonly daysCounted: number;
  /** Distinct employees appearing in those rows. */
  readonly employeeCount: number;

  readonly presentDays: number;
  readonly absentDays: number;
  /** Rows whose status is a leave status (whole rows, not fractions). */
  readonly leaveDayRows: number;
  /** Sum of `leave_day_fraction` — a half day counts 0.5, not 1. */
  readonly leaveDays: number;
  readonly holidayDays: number;
  readonly weeklyOffDays: number;
  /** Engine has not processed the day yet. Never folded into absents. */
  readonly pendingDays: number;
  /** Suspended / not yet joined / after exit — not anybody's attendance. */
  readonly notCountedDays: number;
  /** Server-computed `is_working_day` — the denominator for attendance rates. */
  readonly workingDays: number;

  /** Rows with at least one surviving scan. A COUNT, never a duration denominator. */
  readonly attendedDays: number;
  /**
   * Rows carrying both a first and a last scan — the denominator of the three
   * duration averages. Strictly ≤ `attendedDays`; the gap is the single-scan days,
   * which the engine writes with a zero span (see this module's header).
   */
  readonly completedDays: number;
  readonly totalWorkedMinutes: number;
  /** Mean `total_worked_minutes` over COMPLETE days. Null when there are none. */
  readonly avgWorkedMinutes: number | null;
  /** Mean `gross_span_minutes` (in to out, breaks included) over complete days. */
  readonly avgGrossSpanMinutes: number | null;
  readonly avgBreakMinutes: number | null;
  readonly totalBreakMinutes: number;

  readonly lateDays: number;
  readonly totalLateMinutes: number;
  /** Mean lateness over LATE days only — never diluted by the punctual ones. */
  readonly avgLateMinutes: number | null;
  readonly earlyExitDays: number;
  readonly totalEarlyExitMinutes: number;

  readonly overtimeMinutes: number;
  readonly approvedOvertimeMinutes: number;
  /** Rows the engine flagged (`anomaly_flags` non-empty). */
  readonly anomalyDays: number;

  /** Mean first scan, minutes from IST midnight. Null when nobody scanned. */
  readonly avgFirstInMinutes: number | null;
  /** Rows that carried a readable first scan — the denominator of the mean above. */
  readonly firstInDays: number;
  /** Mean last scan; ≥ 1440 means the shift typically ends after midnight. */
  readonly avgLastOutMinutes: number | null;
  /** Rows that carried a readable last scan. Its own denominator, because a
   *  single-scan day has a first time and no last one. */
  readonly lastOutDays: number;
}

/** The honest answer for an empty row set: zero counts, null averages. */
export const EMPTY_MEASURES: AttendanceMeasures = {
  daysCounted: 0,
  employeeCount: 0,
  presentDays: 0,
  absentDays: 0,
  leaveDayRows: 0,
  leaveDays: 0,
  holidayDays: 0,
  weeklyOffDays: 0,
  pendingDays: 0,
  notCountedDays: 0,
  workingDays: 0,
  attendedDays: 0,
  completedDays: 0,
  totalWorkedMinutes: 0,
  avgWorkedMinutes: null,
  avgGrossSpanMinutes: null,
  avgBreakMinutes: null,
  totalBreakMinutes: 0,
  lateDays: 0,
  totalLateMinutes: 0,
  avgLateMinutes: null,
  earlyExitDays: 0,
  totalEarlyExitMinutes: 0,
  overtimeMinutes: 0,
  approvedOvertimeMinutes: 0,
  anomalyDays: 0,
  avgFirstInMinutes: null,
  firstInDays: 0,
  avgLastOutMinutes: null,
  lastOutDays: 0,
};

/** Mutable accumulator; never leaves this module. */
interface MeasureAcc {
  days: number;
  employees: Set<string>;
  present: number;
  absent: number;
  leaveRows: number;
  leaveFraction: number;
  holiday: number;
  weeklyOff: number;
  pending: number;
  notCounted: number;
  working: number;
  attended: number;
  completed: number;
  workedTotal: number;
  breakTotal: number;
  lateTotal: number;
  earlyExitTotal: number;
  late: number;
  earlyExit: number;
  overtime: number;
  approvedOvertime: number;
  anomalies: number;
  worked: MeanAcc;
  span: MeanAcc;
  breaks: MeanAcc;
  lateMean: MeanAcc;
  firstIn: MeanAcc;
  lastOut: MeanAcc;
}

function newAcc(): MeasureAcc {
  return {
    days: 0,
    employees: new Set<string>(),
    present: 0,
    absent: 0,
    leaveRows: 0,
    leaveFraction: 0,
    holiday: 0,
    weeklyOff: 0,
    pending: 0,
    notCounted: 0,
    working: 0,
    attended: 0,
    completed: 0,
    workedTotal: 0,
    breakTotal: 0,
    lateTotal: 0,
    earlyExitTotal: 0,
    late: 0,
    earlyExit: 0,
    overtime: 0,
    approvedOvertime: 0,
    anomalies: 0,
    worked: newMean(),
    span: newMean(),
    breaks: newMean(),
    lateMean: newMean(),
    firstIn: newMean(),
    lastOut: newMean(),
  };
}

function accumulate(acc: MeasureAcc, row: AnalyticsDayRow): void {
  acc.days += 1;
  acc.employees.add(row.employee_id);

  switch (classifyDayStatus(row.status)) {
    case "present":
      acc.present += 1;
      break;
    case "absent":
      acc.absent += 1;
      break;
    case "leave":
      acc.leaveRows += 1;
      break;
    case "holiday":
      acc.holiday += 1;
      break;
    case "weekly_off":
      acc.weeklyOff += 1;
      break;
    case "pending":
      acc.pending += 1;
      break;
    case "not_counted":
      acc.notCounted += 1;
      break;
  }

  if (row.is_working_day) acc.working += 1;

  // Summed off the row rather than off the status, because a `half_day` row can
  // legitimately carry 0.5 of leave — the fraction is where the truth is.
  if (Number.isFinite(row.leave_day_fraction)) acc.leaveFraction += row.leave_day_fraction;

  // Totals are over EVERY row (a non-late row contributes 0 and that is correct);
  // the means below are over the named denominator only.
  acc.workedTotal += row.total_worked_minutes;
  acc.breakTotal += row.break_minutes;
  acc.lateTotal += row.late_minutes;
  acc.earlyExitTotal += row.early_exit_minutes;
  acc.overtime += row.overtime_minutes;
  acc.approvedOvertime += row.approved_overtime_minutes;

  if (row.punch_count > 0) acc.attended += 1;

  const clock = dayClockMinutes(row);
  addSample(acc.firstIn, clock.firstIn);
  addSample(acc.lastOut, clock.lastOut);

  // A duration needs BOTH ends of the day. `last_out_hm` is the engine's own
  // marker that the pair closed: it nulls `last_out_at` on a single-scan day and
  // writes the span as 0, so gating on `punch_count > 0` would sample that 0 as
  // if the person had worked no time. See this module's header.
  if (row.punch_count > 0 && clock.lastOut !== null) {
    acc.completed += 1;
    addSample(acc.worked, row.total_worked_minutes);
    addSample(acc.span, row.gross_span_minutes);
    addSample(acc.breaks, row.break_minutes);
  }

  if (row.is_late) {
    acc.late += 1;
    addSample(acc.lateMean, row.late_minutes);
  }
  if (row.is_early_exit) acc.earlyExit += 1;
  if (row.has_anomalies) acc.anomalies += 1;
}

function finalise(acc: MeasureAcc): AttendanceMeasures {
  return {
    daysCounted: acc.days,
    employeeCount: acc.employees.size,
    presentDays: acc.present,
    absentDays: acc.absent,
    leaveDayRows: acc.leaveRows,
    leaveDays: acc.leaveFraction,
    holidayDays: acc.holiday,
    weeklyOffDays: acc.weeklyOff,
    pendingDays: acc.pending,
    notCountedDays: acc.notCounted,
    workingDays: acc.working,
    attendedDays: acc.attended,
    completedDays: acc.completed,
    totalWorkedMinutes: acc.workedTotal,
    avgWorkedMinutes: meanOf(acc.worked),
    avgGrossSpanMinutes: meanOf(acc.span),
    avgBreakMinutes: meanOf(acc.breaks),
    totalBreakMinutes: acc.breakTotal,
    lateDays: acc.late,
    totalLateMinutes: acc.lateTotal,
    avgLateMinutes: meanOf(acc.lateMean),
    earlyExitDays: acc.earlyExit,
    totalEarlyExitMinutes: acc.earlyExitTotal,
    overtimeMinutes: acc.overtime,
    approvedOvertimeMinutes: acc.approvedOvertime,
    anomalyDays: acc.anomalies,
    avgFirstInMinutes: meanOf(acc.firstIn),
    firstInDays: acc.firstIn.n,
    avgLastOutMinutes: meanOf(acc.lastOut),
    lastOutDays: acc.lastOut.n,
  };
}

/** Every headline measure over one set of day rows. Single pass, no sorting. */
export function aggregateMeasures(rows: readonly AnalyticsDayRow[]): AttendanceMeasures {
  if (rows.length === 0) return EMPTY_MEASURES;
  const acc = newAcc();
  for (const row of rows) accumulate(acc, row);
  return finalise(acc);
}

// -----------------------------------------------------------------------------
// Grouped breakdowns
// -----------------------------------------------------------------------------

/**
 * `null` department/location is a real bucket, not a rounding error: employees
 * exist before they are placed. It sorts last and the screen labels it with
 * `analytics.label.unassignedDepartment` — dropping it would make the bars stop
 * adding up to the headline, which is the classic "why is the total bigger than
 * the chart" complaint.
 */
export interface DepartmentBreakdownRow {
  readonly departmentName: string | null;
  readonly measures: AttendanceMeasures;
}

/** Ordinal string sort with nulls last. Deliberately not locale-aware: a chart
 *  must order the same way in every browser, and `localeCompare` does not. */
function compareNullableName(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function groupBy<K>(
  rows: readonly AnalyticsDayRow[],
  keyOf: (row: AnalyticsDayRow) => K,
): Map<K, MeasureAcc> {
  const groups = new Map<K, MeasureAcc>();
  for (const row of rows) {
    const key = keyOf(row);
    let acc = groups.get(key);
    if (acc === undefined) {
      acc = newAcc();
      groups.set(key, acc);
    }
    accumulate(acc, row);
  }
  return groups;
}

/** The same measures, grouped by `department_name`. */
export function groupByDepartment(
  rows: readonly AnalyticsDayRow[],
): DepartmentBreakdownRow[] {
  const groups = groupBy(rows, (row) => row.department_name);
  const out: DepartmentBreakdownRow[] = [];
  for (const [departmentName, acc] of groups) {
    out.push({ departmentName, measures: finalise(acc) });
  }
  out.sort((a, b) => compareNullableName(a.departmentName, b.departmentName));
  return out;
}

/** The same measures, grouped by `location_name`. */
export function groupByLocation(rows: readonly AnalyticsDayRow[]): LocationBreakdownRow[] {
  const groups = groupBy(rows, (row) => row.location_name);
  const out: LocationBreakdownRow[] = [];
  for (const [locationName, acc] of groups) {
    out.push({ locationName, measures: finalise(acc) });
  }
  out.sort((a, b) => compareNullableName(a.locationName, b.locationName));
  return out;
}

export interface LocationBreakdownRow {
  readonly locationName: string | null;
  readonly measures: AttendanceMeasures;
}

/** One employee's slice of the period — the row you click to drill in. */
export interface EmployeeBreakdownRow {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly displayName: string;
  /** From the employee's LAST day in the period — a transfer mid-period shows
   *  where they ended up, which is what a filter bar's department means. */
  readonly departmentName: string | null;
  readonly locationName: string | null;
  readonly measures: AttendanceMeasures;
}

/**
 * The same measures, grouped by employee. Sorted by name then code so the list
 * is stable when two people share a display name.
 */
export function groupByEmployee(rows: readonly AnalyticsDayRow[]): EmployeeBreakdownRow[] {
  const groups = new Map<string, { latest: AnalyticsDayRow; acc: MeasureAcc }>();
  for (const row of rows) {
    const existing = groups.get(row.employee_id);
    if (existing === undefined) {
      const acc = newAcc();
      accumulate(acc, row);
      groups.set(row.employee_id, { latest: row, acc });
      continue;
    }
    accumulate(existing.acc, row);
    // `>=` so equal dates keep the later-arriving row; the fetch is date-ordered,
    // so this settles on the last day of the period deterministically.
    if (row.ist_date >= existing.latest.ist_date) existing.latest = row;
  }

  const out: EmployeeBreakdownRow[] = [];
  for (const [employeeId, { latest, acc }] of groups) {
    out.push({
      employeeId,
      employeeCode: latest.employee_code,
      displayName: latest.display_name,
      departmentName: latest.department_name,
      locationName: latest.location_name,
      measures: finalise(acc),
    });
  }
  out.sort((a, b) => {
    const byName = compareNullableName(a.displayName, b.displayName);
    return byName !== 0 ? byName : compareNullableName(a.employeeCode, b.employeeCode);
  });
  return out;
}

// -----------------------------------------------------------------------------
// Daily trend
// -----------------------------------------------------------------------------

export interface DailyTrendPoint {
  readonly istDate: string;
  /** True when no day row exists for this date — a gap, not a zero-work day. */
  readonly isEmpty: boolean;
  readonly measures: AttendanceMeasures;
}

/**
 * Guard against a hand-edited URL asking for a ten-year "daily" chart. 1500
 * points is four years — past that the caller wanted a monthly series and the
 * screen should say so rather than freezing on 3,650 SVG nodes.
 */
export const MAX_TREND_POINTS = 1500;

/**
 * One point per IST date in the period, gaps included.
 *
 * Gaps are emitted rather than skipped: a line chart that silently closes over a
 * missing Sunday reads as "the same as the days either side", and a period the
 * engine has not computed yet reads as a flat line instead of an absence. The
 * `isEmpty` flag lets the chart break the line there.
 *
 * Dates found in `rows` but OUTSIDE the period are appended rather than dropped.
 * They should be impossible — the fetch filters on the same period — and if one
 * ever appears it is counted in the headline summary, so hiding it from the
 * chart would make the two disagree with no way to see why.
 */
export function aggregateDailyTrend(
  rows: readonly AnalyticsDayRow[],
  period: Period,
): DailyTrendPoint[] {
  const byDate = groupBy(rows, (row) => row.ist_date);

  const dates: string[] = [];
  const seen = new Set<string>();
  const span = daysBetween(period.from, period.to);
  if (span >= 0) {
    const points = Math.min(span + 1, MAX_TREND_POINTS);
    for (let i = 0; i < points; i += 1) {
      const date = addDays(period.from, i);
      dates.push(date);
      seen.add(date);
    }
  }
  const strays: string[] = [];
  for (const date of byDate.keys()) if (!seen.has(date)) strays.push(date);
  strays.sort();
  dates.push(...strays);
  // The cap has to bind the OUTPUT, not just the generated span. A ten-year
  // "daily" range generates 1500 dates and then finds every later date that
  // holds rows sitting outside `seen`, so without this the strays walk the cap
  // straight back up to one point per day with data — the freeze this guards.
  if (dates.length > MAX_TREND_POINTS) dates.length = MAX_TREND_POINTS;

  return dates.map((istDate) => {
    const acc = byDate.get(istDate);
    return acc === undefined
      ? { istDate, isEmpty: true, measures: EMPTY_MEASURES }
      : { istDate, isEmpty: false, measures: finalise(acc) };
  });
}

// -----------------------------------------------------------------------------
// One employee, one period
// -----------------------------------------------------------------------------

export interface EmployeeDetailAggregate {
  readonly employeeId: string | null;
  readonly employeeCode: string | null;
  readonly displayName: string | null;
  readonly departmentName: string | null;
  readonly locationName: string | null;
  /** The per-day rows themselves, oldest first — the drill-down's table body. */
  readonly days: readonly AnalyticsDayRow[];
  readonly measures: AttendanceMeasures;
}

/**
 * One employee's period: their day rows in date order plus their own averages.
 *
 * Identity comes off the rows, not off the filter, so a detail screen cannot
 * print a name for an employee whose days the caller is not allowed to see —
 * with no visible rows there is no name, and the screen renders its empty state.
 */
export function aggregateEmployeeDetail(
  rows: readonly AnalyticsDayRow[],
  employeeId: string | null,
): EmployeeDetailAggregate {
  const mine = employeeId === null ? rows : rows.filter((r) => r.employee_id === employeeId);
  const days = [...mine].sort((a, b) =>
    a.ist_date === b.ist_date ? 0 : a.ist_date < b.ist_date ? -1 : 1,
  );
  const last = days[days.length - 1];
  return {
    employeeId: employeeId ?? last?.employee_id ?? null,
    employeeCode: last?.employee_code ?? null,
    displayName: last?.display_name ?? null,
    departmentName: last?.department_name ?? null,
    locationName: last?.location_name ?? null,
    days,
    measures: aggregateMeasures(days),
  };
}

/**
 * One leave type's share of a period — the client's "any leave or not, and which".
 *
 * `days` sums `leave_day_fraction`, NOT rows: a half-day of casual leave is 0.5,
 * and counting it as 1 would make the panel disagree with
 * {@link AttendanceMeasures.leaveDays}, which is the same sum over the same rows.
 * `dayRows` is kept beside it because "3 occasions totalling 2.5 days" and "2.5
 * days" answer different questions about the same person.
 */
export interface LeaveTypeDays {
  readonly leaveTypeName: string;
  readonly days: number;
  readonly dayRows: number;
}

/**
 * Leave in the period, grouped by type, biggest first.
 *
 * Keyed on `leave_type_name` because that is what the day view carries — the type
 * id is not projected. Rows with no leave type are skipped rather than bucketed as
 * "unknown": a working day is not an absence of a leave type, it is not leave.
 */
export function groupLeaveDaysByType(rows: readonly AnalyticsDayRow[]): LeaveTypeDays[] {
  const byType = new Map<string, { days: number; dayRows: number }>();
  for (const row of rows) {
    const name = row.leave_type_name;
    if (name === null || name === "") continue;
    const acc = byType.get(name) ?? { days: 0, dayRows: 0 };
    // A leave row with a NULL/NaN fraction still counts as an occasion; only the
    // day total ignores it, exactly as `addSample` ignores a non-finite sample.
    if (Number.isFinite(row.leave_day_fraction)) acc.days += row.leave_day_fraction;
    acc.dayRows += 1;
    byType.set(name, acc);
  }
  const out: LeaveTypeDays[] = [];
  for (const [leaveTypeName, acc] of byType) out.push({ leaveTypeName, ...acc });
  // Descending by days, name as the tiebreak so the order is stable across
  // browsers and across two renders of the same period.
  out.sort((a, b) => (b.days !== a.days ? b.days - a.days : compareNullableName(a.leaveTypeName, b.leaveTypeName)));
  return out;
}

// -----------------------------------------------------------------------------
// Today board tiles
// -----------------------------------------------------------------------------

/**
 * The board's OWN state flags. Every one of these booleans was decided by
 * Postgres in `v_attendance_today_board` (grace period, shift start, punch
 * count, status set); the only thing done here is counting the trues, which is
 * why the tiles cannot disagree with the rows they open.
 */
export interface TodayBoardFlags {
  readonly employee_id: string;
  readonly attended: boolean;
  readonly off_today: boolean;
  readonly yet_to_reach: boolean;
  readonly late_in: boolean;
  readonly on_time: boolean;
  readonly overdue: boolean;
  readonly web_punch_count: number;
}

export interface TodayTiles {
  /** Employees on the board — active, attendance-tracked, visible to the caller. */
  readonly onRoll: number;
  readonly attended: number;
  readonly offToday: number;
  readonly yetToReach: number;
  readonly lateIn: number;
  readonly onTime: number;
  readonly overdue: number;
  /** Days with at least one web/mobile punch — the client's "web login" tile. */
  readonly webPunchDays: number;
}

export const EMPTY_TODAY_TILES: TodayTiles = {
  onRoll: 0,
  attended: 0,
  offToday: 0,
  yetToReach: 0,
  lateIn: 0,
  onTime: 0,
  overdue: 0,
  webPunchDays: 0,
};

/**
 * Count the board's flags. The tiles are NOT mutually exclusive by design —
 * `late_in` and `attended` are both true for someone who arrived late — so they
 * are counted independently and must never be presented as a pie.
 */
export function summariseTodayBoard(rows: readonly TodayBoardFlags[]): TodayTiles {
  if (rows.length === 0) return EMPTY_TODAY_TILES;
  let attended = 0;
  let offToday = 0;
  let yetToReach = 0;
  let lateIn = 0;
  let onTime = 0;
  let overdue = 0;
  let webPunchDays = 0;
  for (const row of rows) {
    if (row.attended) attended += 1;
    if (row.off_today) offToday += 1;
    if (row.yet_to_reach) yetToReach += 1;
    if (row.late_in) lateIn += 1;
    if (row.on_time) onTime += 1;
    if (row.overdue) overdue += 1;
    if (row.web_punch_count > 0) webPunchDays += 1;
  }
  return {
    onRoll: rows.length,
    attended,
    offToday,
    yetToReach,
    lateIn,
    onTime,
    overdue,
    webPunchDays,
  };
}
