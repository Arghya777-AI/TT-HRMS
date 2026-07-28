/**
 * hrMovementAggregate.ts — every number the Movement & Risk panel shows, computed
 * in a module that imports no network client, no clock and no locale.
 *
 * WHY IT IS SEPARATE, AND WHY IT IS PURE
 * --------------------------------------
 * Same reason as `analyticsAggregate.ts`, whose discipline this file follows:
 * PostgREST cannot GROUP BY, and no deployed relation rolls
 * `analytics.mv_headcount_daily` up over an ARBITRARY period —
 * `v_headcount_monthly` is pinned to (year, month, department) and has no
 * organisation-wide rollup row at all. So the snapshot rows are fetched (bounded,
 * see `MOVEMENT_HEADCOUNT_ROW_CAP` in hr-movement.api.ts) and added up here, in
 * functions that take their rows as arguments and can therefore be pinned to
 * hand-computed literals in `hrMovementAggregate.test.ts`.
 *
 * TODAY IS ALWAYS AN ARGUMENT. Three of the four watchlists are relative to the
 * current IST date ("overdue by", "days left", "still ahead of today"). Reading a
 * clock in here would make the whole module untestable and would read the HOST
 * zone, which for an IST-only product is a defect. Callers pass `today` from
 * `nowIstDate()`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE JUDGEMENT CALLS, MADE EXPLICITLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. THE AVERAGE-HEADCOUNT DENOMINATOR IS COVERED DAYS, NOT CALENDAR DAYS.
 *    `analytics.mv_headcount_daily` is generated from MIN(date_of_join) to
 *    `util.ist_today()` AS AT ITS LAST REFRESH (nightly, 02:00 IST). A period
 *    that runs into the future, or past the last refresh, therefore has dates the
 *    snapshot simply does not hold. Those dates are EXCLUDED from the mean rather
 *    than contributing zero — a day with no snapshot row is a day we do not know
 *    the headcount for, and averaging in a zero would drag the attrition
 *    denominator down and the attrition rate up. {@link MovementSeries} carries
 *    `coveredDays` alongside `periodDays` so the screen can state which it used.
 *
 * 2. WITHIN A COVERED DAY, A MISSING DEPARTMENT IS A REAL ZERO. The matview's
 *    JOIN emits a row only for (date × department × employment_type) combinations
 *    that actually held somebody, so a department that was empty on Tuesday has no
 *    Tuesday row. That is different in kind from case 1: for a date the snapshot
 *    covers, it covers the WHOLE organisation, so the absence means "nobody",
 *    not "unknown". Per-department means therefore divide by the same
 *    `coveredDays` as the organisation-wide mean, zero-filling the gaps — which is
 *    also what makes the department rows add up to the headline.
 *
 * 3. ATTRITION IS NOT ANNUALISED BELOW {@link MIN_ANNUALISE_DAYS}. Scaling a
 *    period to a year multiplies by 365/days: at 28 days that is ×13, at 7 days it
 *    is ×52. One leaver in a quiet week becomes "52% annual attrition", which is
 *    not a statistic, it is an alarm nobody can silence. Below the floor
 *    {@link AttritionRate.annualisedPct} is null and the screen says why.
 *
 * NOTHING HERE INVENTS A NUMBER. Every field traces to a named column:
 * `headcount`, `joiners`, `exits` on the snapshot; `date_of_join`,
 * `confirmation_due_date`, `confirmed_on`, `contract_end_date`,
 * `resignation_date`, `last_working_day`, `notice_period_days`, `exit_type`,
 * `exit_interview_done`, `is_rehire_eligible`, `full_and_final_settled_on` on the
 * employee master. The only arithmetic is counting, summing, averaging and
 * calendar-day differences.
 */
import { addDays, daysBetween, periodLengthDays, type Period } from "@/lib/period";

// -----------------------------------------------------------------------------
// The row shapes this module was written against
// -----------------------------------------------------------------------------

/**
 * One row of `public.v_headcount_daily` (the admin-gated wrapper over
 * `analytics.mv_headcount_daily`, migration 036 §4/§6), in the view's own
 * snake_case so a measure can be checked against the SQL without translating
 * names. Structural: the zod-parsed row in hr-movement.api.ts satisfies it.
 *
 * Grain: (as_of_date, department_key, employment_type). `department_id` is NULL
 * for unassigned employees — `department_key` is the zero-uuid sentinel the
 * matview uses FOR INDEXING ONLY and is deliberately not modelled here.
 */
export interface HeadcountDayRow {
  readonly as_of_date: string;
  readonly department_id: string | null;
  readonly department_name: string | null;
  readonly employment_type: string;
  /** Active on that date: date_of_join <= d AND (last_working_day IS NULL OR >= d). */
  readonly headcount: number;
  /** date_of_join = d. */
  readonly joiners: number;
  /** last_working_day = d. Note they are still IN `headcount` on their last day. */
  readonly exits: number;
}

/**
 * The projection of `v_admin_employee` the watchlists need. Structural, for the
 * same reason: dropping a column from the api module's zod schema breaks the call
 * site at compile time instead of producing `undefined` in a table cell.
 */
export interface MovementEmployeeRow {
  readonly id: string;
  readonly employee_code: string;
  readonly display_name: string;
  readonly employment_status: string;
  readonly employment_type: string;
  readonly date_of_join: string | null;
  readonly probation_months: number;
  /** GENERATED STORED: date_of_join + probation_months. Never derived here. */
  readonly confirmation_due_date: string | null;
  readonly confirmed_on: string | null;
  readonly contract_end_date: string | null;
  readonly notice_period_days: number;
  readonly resignation_date: string | null;
  readonly last_working_day: string | null;
  readonly exit_type: string | null;
  readonly exit_reason: string | null;
  readonly exit_interview_done: boolean;
  /** THREE-STATE: true / false / NULL = nobody has ruled. Never collapse to a boolean. */
  readonly is_rehire_eligible: boolean | null;
  readonly full_and_final_settled_on: string | null;
  readonly department_name: string | null;
  readonly designation_name: string | null;
  readonly location_name: string | null;
  readonly reporting_manager_name: string | null;
}

// -----------------------------------------------------------------------------
// The headcount / movement series
// -----------------------------------------------------------------------------

/** One IST date of the period, as the nightly snapshot saw it. */
export interface HeadcountPoint {
  readonly istDate: string;
  /**
   * False when the snapshot holds NO row for this date. Every measure below is
   * then null — a gap the chart must break the line at, never a zero it can plot.
   */
  readonly isCovered: boolean;
  /** Total active heads across every department and employment type that day. */
  readonly headcount: number | null;
  readonly joiners: number | null;
  readonly exits: number | null;
}

export interface MovementSeries {
  readonly points: readonly HeadcountPoint[];
  /** Calendar days in the selected period, inclusive of both ends. */
  readonly periodDays: number;
  /** Days the snapshot actually holds — THE DENOMINATOR of `avgHeadcount`. */
  readonly coveredDays: number;
  /** Sum of `joiners` over covered days. Zero when nothing is covered. */
  readonly joiners: number;
  readonly exits: number;
  /** joiners − exits. Negative means the venue shrank over the covered days. */
  readonly netChange: number;
  /** Mean daily headcount over COVERED days. Null when there are none. */
  readonly avgHeadcount: number | null;
  /** Headcount on the FIRST covered day — the level the period started at. */
  readonly openingHeadcount: number | null;
  /** Headcount on the LAST covered day. */
  readonly closingHeadcount: number | null;
  readonly firstCoveredDate: string | null;
  readonly lastCoveredDate: string | null;
}

export const EMPTY_MOVEMENT_SERIES: MovementSeries = {
  points: [],
  periodDays: 0,
  coveredDays: 0,
  joiners: 0,
  exits: 0,
  netChange: 0,
  avgHeadcount: null,
  openingHeadcount: null,
  closingHeadcount: null,
  firstCoveredDate: null,
  lastCoveredDate: null,
};

/** Per-date totals, before they are laid out against the period's calendar. */
interface DayTotals {
  headcount: number;
  joiners: number;
  exits: number;
}

function totalsByDate(rows: readonly HeadcountDayRow[]): Map<string, DayTotals> {
  const byDate = new Map<string, DayTotals>();
  for (const row of rows) {
    const acc = byDate.get(row.as_of_date) ?? { headcount: 0, joiners: 0, exits: 0 };
    acc.headcount += row.headcount;
    acc.joiners += row.joiners;
    acc.exits += row.exits;
    byDate.set(row.as_of_date, acc);
  }
  return byDate;
}

/**
 * Guard against a hand-edited URL asking for a ten-year daily series. Same
 * reasoning and same figure as `MAX_TREND_POINTS` in analyticsAggregate.ts: past
 * ~4 years the caller wanted a monthly series and the browser should not be
 * asked to lay out 3,650 marks.
 */
export const MAX_MOVEMENT_POINTS = 1500;

/**
 * The day-by-day series for a period, gaps preserved.
 *
 * Dates in `rows` that fall OUTSIDE the period are ignored rather than appended:
 * unlike the attendance trend, the totals here (`joiners`, `exits`,
 * `avgHeadcount`) feed an attrition rate whose window is stated on screen as the
 * period, so counting a stray date would make the rate cover a window the label
 * denies. The fetch filters on the same period, so a stray should be impossible;
 * ignoring it keeps the number and its label honest if one ever appears.
 */
export function aggregateMovementSeries(
  rows: readonly HeadcountDayRow[],
  period: Period,
): MovementSeries {
  const span = daysBetween(period.from, period.to);
  if (span < 0) return EMPTY_MOVEMENT_SERIES;

  const byDate = totalsByDate(rows);
  const periodDays = periodLengthDays(period);
  const pointCount = Math.min(periodDays, MAX_MOVEMENT_POINTS);

  const points: HeadcountPoint[] = [];
  let headcountSum = 0;
  let coveredDays = 0;
  let joiners = 0;
  let exits = 0;
  let firstCoveredDate: string | null = null;
  let lastCoveredDate: string | null = null;
  let openingHeadcount: number | null = null;
  let closingHeadcount: number | null = null;

  for (let i = 0; i < pointCount; i += 1) {
    const istDate = addDays(period.from, i);
    const totals = byDate.get(istDate);
    if (totals === undefined) {
      points.push({ istDate, isCovered: false, headcount: null, joiners: null, exits: null });
      continue;
    }
    points.push({
      istDate,
      isCovered: true,
      headcount: totals.headcount,
      joiners: totals.joiners,
      exits: totals.exits,
    });
    headcountSum += totals.headcount;
    coveredDays += 1;
    joiners += totals.joiners;
    exits += totals.exits;
    if (firstCoveredDate === null) {
      firstCoveredDate = istDate;
      openingHeadcount = totals.headcount;
    }
    lastCoveredDate = istDate;
    closingHeadcount = totals.headcount;
  }

  return {
    points,
    periodDays,
    coveredDays,
    joiners,
    exits,
    netChange: joiners - exits,
    // Never `sum / periodDays`: see judgement call 1 in this module's header.
    avgHeadcount: coveredDays === 0 ? null : headcountSum / coveredDays,
    openingHeadcount,
    closingHeadcount,
    firstCoveredDate,
    lastCoveredDate,
  };
}

// -----------------------------------------------------------------------------
// Attrition — the number that starts arguments
// -----------------------------------------------------------------------------

/**
 * The shortest window this module will annualise. 28 days ≈ ×13; below it the
 * multiplier runs away (7 days is ×52) and a single exit reads as a crisis. See
 * judgement call 3 in the header.
 */
export const MIN_ANNUALISE_DAYS = 28;

/** Days in a year, for the annualisation factor. Not 365.25 — the label says "×N". */
const DAYS_PER_YEAR = 365;

export interface AttritionRate {
  /** Numerator: exits over the window. */
  readonly exits: number;
  /** Denominator: mean daily headcount over the window. Null = not computable. */
  readonly avgHeadcount: number | null;
  /** The days the rate is over. Print it — an unwindowed rate means nothing. */
  readonly windowDays: number;
  /** exits ÷ avgHeadcount × 100. Null when there is no denominator. */
  readonly periodPct: number | null;
  /** 365 ÷ windowDays, or null when the window is too short to annualise. */
  readonly annualiseFactor: number | null;
  /** periodPct × annualiseFactor. Null whenever `annualiseFactor` is. */
  readonly annualisedPct: number | null;
}

export const NO_ATTRITION: AttritionRate = {
  exits: 0,
  avgHeadcount: null,
  windowDays: 0,
  periodPct: null,
  annualiseFactor: null,
  annualisedPct: null,
};

/**
 * ATTRITION = exits ÷ average headcount × 100, over an explicitly stated window.
 *
 * Both arguments must come from the SAME source measured the same way — this
 * panel takes both from the nightly snapshot, so the numerator and the
 * denominator cannot be a live count divided by a stale mean.
 *
 * A zero (or negative, which cannot happen but is guarded anyway) average
 * headcount yields null rather than Infinity: "everybody left a team of nobody"
 * is not a percentage.
 */
export function attritionOf(
  exits: number,
  avgHeadcount: number | null,
  windowDays: number,
): AttritionRate {
  const usable = avgHeadcount !== null && Number.isFinite(avgHeadcount) && avgHeadcount > 0;
  const periodPct = usable && avgHeadcount !== null ? (exits / avgHeadcount) * 100 : null;
  const canAnnualise = windowDays >= MIN_ANNUALISE_DAYS && periodPct !== null;
  const annualiseFactor = canAnnualise ? DAYS_PER_YEAR / windowDays : null;
  return {
    exits,
    avgHeadcount: usable ? avgHeadcount : null,
    windowDays,
    periodPct,
    annualiseFactor,
    annualisedPct:
      annualiseFactor !== null && periodPct !== null ? periodPct * annualiseFactor : null,
  };
}

/**
 * What the factor WOULD be for a window too short to annualise — so the screen
 * can say "×52" as the reason it refused, rather than just refusing.
 */
export function hypotheticalAnnualiseFactor(windowDays: number): number | null {
  return windowDays > 0 ? DAYS_PER_YEAR / windowDays : null;
}

/** The whole period's attrition, from a series. One call, one source. */
export function seriesAttrition(series: MovementSeries): AttritionRate {
  // The window is COVERED days, not calendar days: the rate is exits observed
  // over the days we actually observed, and labelling it with a longer window
  // than the data covers would understate it.
  return attritionOf(series.exits, series.avgHeadcount, series.coveredDays);
}

// -----------------------------------------------------------------------------
// By department
// -----------------------------------------------------------------------------

export interface MovementDepartmentRow {
  /** `departments.id`, so a drill-through carries the KEY, not a renameable name. */
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly joiners: number;
  readonly exits: number;
  readonly netChange: number;
  readonly avgHeadcount: number | null;
  readonly attrition: AttritionRate;
}

/** Ordinal compare with nulls last — deliberately not locale-aware, so a chart
 *  orders the same way in every browser (`localeCompare` does not). */
function compareNullableName(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

interface DeptAcc {
  departmentId: string | null;
  departmentName: string | null;
  headcountSum: number;
  joiners: number;
  exits: number;
}

/**
 * The same measures per department, over the same period.
 *
 * The denominator of every departmental mean is the series' `coveredDays`, NOT
 * the days that department happened to have rows — see judgement call 2 in the
 * header. That is what makes the department column add up to the headline
 * average instead of drifting above it.
 *
 * Rows outside the period are ignored, matching {@link aggregateMovementSeries},
 * so the two cannot disagree about what "this period" means.
 */
export function groupMovementByDepartment(
  rows: readonly HeadcountDayRow[],
  period: Period,
  coveredDays: number,
): MovementDepartmentRow[] {
  const groups = new Map<string, DeptAcc>();
  for (const row of rows) {
    if (row.as_of_date < period.from || row.as_of_date > period.to) continue;
    // Keyed on the id, with a sentinel for unassigned: two departments can share
    // a name, and merging them under one bar would misattribute every exit.
    const key = row.department_id ?? " unassigned";
    const acc = groups.get(key) ?? {
      departmentId: row.department_id,
      departmentName: row.department_name,
      headcountSum: 0,
      joiners: 0,
      exits: 0,
    };
    acc.headcountSum += row.headcount;
    acc.joiners += row.joiners;
    acc.exits += row.exits;
    groups.set(key, acc);
  }

  const out: MovementDepartmentRow[] = [];
  for (const acc of groups.values()) {
    const avgHeadcount = coveredDays === 0 ? null : acc.headcountSum / coveredDays;
    out.push({
      departmentId: acc.departmentId,
      departmentName: acc.departmentName,
      joiners: acc.joiners,
      exits: acc.exits,
      netChange: acc.joiners - acc.exits,
      avgHeadcount,
      attrition: attritionOf(acc.exits, avgHeadcount, coveredDays),
    });
  }
  // Busiest first — a movement table is read for where the churn is — with the
  // name as a stable tiebreak so two renders of one period never reorder.
  out.sort((a, b) => {
    const byMovement = b.joiners + b.exits - (a.joiners + a.exits);
    if (byMovement !== 0) return byMovement;
    return compareNullableName(a.departmentName, b.departmentName);
  });
  return out;
}

// -----------------------------------------------------------------------------
// Watchlists — work somebody owes, not numbers to admire
// -----------------------------------------------------------------------------

/**
 * Statuses a watchlist ignores. Confirming, renewing a contract for, or chasing
 * notice from somebody who has already left is not work — it is noise that pushes
 * the real rows off the first page.
 *
 * `absconding` is deliberately NOT here: an absconder has no last working day and
 * their probation confirmation genuinely is an open decision (usually a
 * termination), so HR needs to see them.
 */
export const TERMINAL_EMPLOYMENT_STATUSES: readonly string[] = ["exited", "retired"];

function isTerminal(row: MovementEmployeeRow): boolean {
  return TERMINAL_EMPLOYMENT_STATUSES.includes(row.employment_status);
}

export interface ProbationWatchRow {
  readonly employee: MovementEmployeeRow;
  /** `confirmation_due_date` — non-null by construction of the predicate. */
  readonly dueOn: string;
  /** Negative when the date has passed. `0` is "due today". */
  readonly daysUntilDue: number;
  readonly isOverdue: boolean;
}

/**
 * Confirmations that need a decision: `confirmation_due_date <= dueBy` with
 * `confirmed_on IS NULL`.
 *
 * The due date is the database's GENERATED STORED column
 * (`date_of_join + probation_months`, migration 008). It is read, never
 * recomputed — recomputing it here would silently disagree with the row the
 * Employee 360 screen shows the moment somebody's probation months change.
 *
 * Sorted most overdue first: the top of this list is the oldest unmade decision.
 */
export function probationWatchlist(
  rows: readonly MovementEmployeeRow[],
  dueBy: string,
  today: string,
): ProbationWatchRow[] {
  const out: ProbationWatchRow[] = [];
  for (const employee of rows) {
    const dueOn = employee.confirmation_due_date;
    if (dueOn === null || employee.confirmed_on !== null) continue;
    if (dueOn > dueBy) continue;
    if (isTerminal(employee)) continue;
    const daysUntilDue = daysBetween(today, dueOn);
    out.push({ employee, dueOn, daysUntilDue, isOverdue: daysUntilDue < 0 });
  }
  out.sort((a, b) => (a.dueOn === b.dueOn ? compareCode(a, b) : a.dueOn < b.dueOn ? -1 : 1));
  return out;
}

function compareCode(
  a: { employee: MovementEmployeeRow },
  b: { employee: MovementEmployeeRow },
): number {
  return compareNullableName(a.employee.employee_code, b.employee.employee_code);
}

export interface ContractWatchRow {
  readonly employee: MovementEmployeeRow;
  readonly endsOn: string;
  /** Negative when the contract has already lapsed with nobody acting on it. */
  readonly daysUntilEnd: number;
  readonly hasExpired: boolean;
}

/**
 * Contracts ending in `[from, to]` — the caller widens `to` by a lookahead so a
 * renewal is visible before its last week rather than on it.
 *
 * Only employees with a `contract_end_date` recorded can appear; a permanent
 * employee has NULL there and is correctly absent. The screen says so, because an
 * empty contract watchlist could otherwise be read as "every contract is safe".
 */
export function contractWatchlist(
  rows: readonly MovementEmployeeRow[],
  from: string,
  to: string,
  today: string,
): ContractWatchRow[] {
  const out: ContractWatchRow[] = [];
  for (const employee of rows) {
    const endsOn = employee.contract_end_date;
    if (endsOn === null || endsOn < from || endsOn > to) continue;
    if (isTerminal(employee)) continue;
    const daysUntilEnd = daysBetween(today, endsOn);
    out.push({ employee, endsOn, daysUntilEnd, hasExpired: daysUntilEnd < 0 });
  }
  out.sort((a, b) => (a.endsOn === b.endsOn ? compareCode(a, b) : a.endsOn < b.endsOn ? -1 : 1));
  return out;
}

export interface NoticeWatchRow {
  readonly employee: MovementEmployeeRow;
  readonly resignedOn: string;
  readonly lastWorkingDay: string;
  /** Calendar days from `today` to the last working day. Always > 0 by predicate. */
  readonly daysRemaining: number;
  /** last_working_day − resignation_date: the notice actually being served. */
  readonly noticeServedDays: number;
  /**
   * `notice_period_days` − `noticeServedDays`. Positive = leaving early against
   * policy; NEGATIVE = serving longer than required, which is real information
   * and is not clamped away.
   */
  readonly noticeShortfallDays: number;
}

/**
 * People on their way out: a resignation date is recorded and the last working
 * day is still ahead of `today`.
 *
 * Both halves matter. `resignation_date IS NOT NULL` alone would pick up
 * terminations with a future last day and call them resignations; a future
 * `last_working_day` alone would pick up rows where only a leaving date was
 * pencilled in. Together they are exactly "notice is running".
 *
 * Sorted by last working day ascending — whoever leaves soonest is the most
 * urgent handover.
 */
export function noticeWatchlist(
  rows: readonly MovementEmployeeRow[],
  today: string,
): NoticeWatchRow[] {
  const out: NoticeWatchRow[] = [];
  for (const employee of rows) {
    const resignedOn = employee.resignation_date;
    const lastWorkingDay = employee.last_working_day;
    if (resignedOn === null || lastWorkingDay === null) continue;
    if (lastWorkingDay <= today) continue;
    const noticeServedDays = daysBetween(resignedOn, lastWorkingDay);
    out.push({
      employee,
      resignedOn,
      lastWorkingDay,
      daysRemaining: daysBetween(today, lastWorkingDay),
      noticeServedDays,
      noticeShortfallDays: employee.notice_period_days - noticeServedDays,
    });
  }
  out.sort((a, b) =>
    a.lastWorkingDay === b.lastWorkingDay
      ? compareCode(a, b)
      : a.lastWorkingDay < b.lastWorkingDay
        ? -1
        : 1,
  );
  return out;
}

// -----------------------------------------------------------------------------
// Exit quality
// -----------------------------------------------------------------------------

/** One exit type's share. `exitType` is null for exits with nothing recorded. */
export interface ExitTypeCount {
  readonly exitType: string | null;
  readonly exits: number;
}

export interface ExitQuality {
  /** THE denominator of every share below. Stated on screen, never implied. */
  readonly exits: number;
  /** `exit_type` breakdown, biggest first, with the unrecorded bucket last. */
  readonly byType: readonly ExitTypeCount[];
  readonly interviewDone: number;
  readonly interviewPending: number;
  /** `is_rehire_eligible = true`. */
  readonly rehireEligible: number;
  /** `is_rehire_eligible = false` — an actual ruling, not an absence of one. */
  readonly rehireNotEligible: number;
  /** `is_rehire_eligible IS NULL` — nobody has ruled. NEVER folded into "no". */
  readonly rehireUndecided: number;
  readonly settled: number;
  readonly settlementPending: number;
}

export const EMPTY_EXIT_QUALITY: ExitQuality = {
  exits: 0,
  byType: [],
  interviewDone: 0,
  interviewPending: 0,
  rehireEligible: 0,
  rehireNotEligible: 0,
  rehireUndecided: 0,
  settled: 0,
  settlementPending: 0,
};

/**
 * The quality of a period's exits, over the exit rows themselves.
 *
 * `exit_type` is deliberately NOT folded into "voluntary" and "involuntary".
 * `employees.exit_type` is a six-value CHECK constraint and every HR team draws
 * that line somewhere different (is `end_of_contract` involuntary? is
 * `absconding` voluntary?). Collapsing six recorded facts into two invented ones
 * is exactly the unlabelled judgement this panel exists to avoid — the six are
 * shown as they are.
 *
 * The three rehire counts sum to `exits` by construction, which is the check
 * that the NULL state was not quietly dropped.
 */
export function exitQualityOf(rows: readonly MovementEmployeeRow[]): ExitQuality {
  if (rows.length === 0) return EMPTY_EXIT_QUALITY;

  const byType = new Map<string | null, number>();
  let interviewDone = 0;
  let rehireEligible = 0;
  let rehireNotEligible = 0;
  let rehireUndecided = 0;
  let settled = 0;

  for (const row of rows) {
    // A blank string is not a recorded exit type — normalise it to the same
    // "unrecorded" bucket as NULL so the breakdown has one gap, not two.
    const type = row.exit_type === null || row.exit_type === "" ? null : row.exit_type;
    byType.set(type, (byType.get(type) ?? 0) + 1);
    if (row.exit_interview_done) interviewDone += 1;
    if (row.is_rehire_eligible === true) rehireEligible += 1;
    else if (row.is_rehire_eligible === false) rehireNotEligible += 1;
    else rehireUndecided += 1;
    if (row.full_and_final_settled_on !== null) settled += 1;
  }

  const types: ExitTypeCount[] = [];
  for (const [exitType, exits] of byType) types.push({ exitType, exits });
  types.sort((a, b) => {
    // Unrecorded sorts last whatever its size: it is an absence of data, and
    // letting it head the chart would read as the commonest reason people leave.
    if (a.exitType === null) return 1;
    if (b.exitType === null) return -1;
    return b.exits !== a.exits ? b.exits - a.exits : compareNullableName(a.exitType, b.exitType);
  });

  return {
    exits: rows.length,
    byType: types,
    interviewDone,
    interviewPending: rows.length - interviewDone,
    rehireEligible,
    rehireNotEligible,
    rehireUndecided,
    settled,
    settlementPending: rows.length - settled,
  };
}

// -----------------------------------------------------------------------------
// Reconciliation — where the two sources disagree, and why
// -----------------------------------------------------------------------------

export interface MovementReconciliation {
  /** From `v_headcount_daily` — nightly, and therefore possibly behind. */
  readonly snapshotJoiners: number;
  readonly snapshotExits: number;
  /** From `v_admin_employee` — live, and therefore the current truth. */
  readonly liveJoiners: number;
  readonly liveExits: number;
  readonly joinersDelta: number;
  readonly exitsDelta: number;
  readonly agrees: boolean;
}

/**
 * Compare the snapshot's movement with the live employee master's.
 *
 * They SHOULD agree and usually will. When they do not, the reason is almost
 * always that somebody joined or left since the nightly refresh — which is
 * ordinary, and which the screen explains rather than hides. The alternative
 * (showing one figure and quietly discarding the other) is how a dashboard and
 * the register it links to start telling two different stories about the same
 * fortnight.
 */
export function reconcileMovement(
  series: MovementSeries,
  liveJoiners: number,
  liveExits: number,
): MovementReconciliation {
  const joinersDelta = liveJoiners - series.joiners;
  const exitsDelta = liveExits - series.exits;
  return {
    snapshotJoiners: series.joiners,
    snapshotExits: series.exits,
    liveJoiners,
    liveExits,
    joinersDelta,
    exitsDelta,
    agrees: joinersDelta === 0 && exitsDelta === 0,
  };
}
