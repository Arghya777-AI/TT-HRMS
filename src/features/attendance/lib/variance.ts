/**
 * variance.ts — how much more or less than the shift somebody actually worked.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────
 * These numbers get argued about. "You were short forty minutes last month" has to survive
 * somebody checking it day by day, so the arithmetic lives in one place, is pure, and is tested
 * — rather than being spread across a table cell, a summary card and a tooltip that quietly
 * disagree with each other.
 *
 * ── WHAT COUNTS AS "EXPECTED" ────────────────────────────────────────────────
 * `shift_duration_minutes` on a WORKING day, and nothing on any other kind of day. That
 * distinction is the whole of the correctness here:
 *
 *   · A holiday or a weekly off expects nothing, so an hour worked on one is an hour of
 *     SURPLUS — not "an hour against a nine-hour day", which would read as a huge shortfall.
 *   · A full day of approved leave expects nothing either: the day is paid and the person was
 *     not meant to be there. Counting it as a shortfall would punish somebody for taking leave
 *     that was granted.
 *   · A HALF day of leave expects half the shift, which is what `leave_day_fraction` is for.
 *   · A day the engine has not resolved yet expects nothing and contributes nothing. It is not
 *     a shortfall; it is an unknown, and folding unknowns into a total is how a summary becomes
 *     a source of arguments rather than a source of answers.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * Not payroll. `overtime_minutes` and `approved_overtime_minutes` remain the payable figures
 * and are already computed server-side by the attendance engine; nothing here changes what
 * anybody is paid. This is the plain-English "did I make my hours" number, and where it differs
 * from approved overtime, both are shown rather than one being quietly presented as the other.
 */
import type {
  AttendanceDay,
  AttendancePeriodSummary,
  AttendanceStatus,
} from "../api/attendance.api";

/** Why a day expects nothing, when it expects nothing. */
export type NoExpectationReason =
  | "holiday"
  | "weekly_off"
  | "on_leave"
  | "not_working_day"
  | "unresolved";

export interface DayVariance {
  /** Minutes the shift asked for. 0 when the day expects nothing. */
  expectedMinutes: number;
  /** Minutes actually worked, from the engine. */
  workedMinutes: number;
  /**
   * worked − expected. Positive is surplus, negative is shortfall.
   *
   * Zero both when they balance and when nothing was expected AND nothing worked, which is why
   * `counts` exists rather than callers inferring meaning from a zero.
   */
  varianceMinutes: number;
  /** False when this day must not contribute to a total — see the header. */
  counts: boolean;
  /** Present when `counts` is false, so a UI can say why rather than showing a blank. */
  reason?: NoExpectationReason;
}

/**
 * The one status the engine has not resolved. Never folded into a total.
 *
 * Taken from `attendanceStatusValues`, not guessed: an earlier draft also listed
 * "not_processed" and "unknown", neither of which exists. A membership test against invented
 * names silently matches nothing, so every pending day would have been counted as a full
 * shortfall — the screenshot that prompted this feature has nineteen of them.
 */
const UNRESOLVED: ReadonlySet<AttendanceStatus> = new Set<AttendanceStatus>(["pending"]);

/**
 * Statuses where the person was not employed, or not expected, at all.
 *
 * These contribute NOTHING — not a shortfall, and not a surplus either. A day before somebody
 * joined is not a day they were ahead or behind on; it is a day that has nothing to do with
 * them, and including it in either column would be wrong in both directions.
 */
const OUTSIDE_EMPLOYMENT: ReadonlySet<AttendanceStatus> = new Set<AttendanceStatus>([
  "not_yet_joined",
  "post_exit",
  "suspended",
]);

/**
 * One day's surplus or shortfall.
 *
 * Deliberately tolerant of nulls: every minute field on the view is nullable, and a day with no
 * computation yet must produce a defined answer rather than NaN. `payable_worked_minutes` is
 * preferred over `total_worked_minutes` because it is the figure the engine has already adjusted
 * for breaks and policy — the same number the WORKED column shows.
 */
export function dayVariance(day: AttendanceDay): DayVariance {
  const worked = day.payable_worked_minutes ?? day.total_worked_minutes ?? 0;

  if (UNRESOLVED.has(day.status)) {
    // Not a shortfall — an unknown. Folding unknowns into a total makes it indefensible.
    return { expectedMinutes: 0, workedMinutes: worked, varianceMinutes: 0, counts: false, reason: "unresolved" };
  }

  if (OUTSIDE_EMPLOYMENT.has(day.status)) {
    // Nothing expected and nothing credited: the day is not theirs to be ahead or behind on.
    return {
      expectedMinutes: 0,
      workedMinutes: worked,
      varianceMinutes: 0,
      counts: false,
      reason: "not_working_day",
    };
  }

  /*
    Comp-off availed is a day OFF that a previous surplus paid for. Crediting the surplus again
    here would count the same extra work twice — once when it was earned and once when it was
    spent.
  */
  if (day.status === "comp_off_availed") {
    return {
      expectedMinutes: 0,
      workedMinutes: worked,
      varianceMinutes: 0,
      counts: false,
      reason: "on_leave",
    };
  }

  if (day.is_holiday) {
    return { expectedMinutes: 0, workedMinutes: worked, varianceMinutes: worked, counts: true, reason: "holiday" };
  }
  if (day.is_weekly_off) {
    return { expectedMinutes: 0, workedMinutes: worked, varianceMinutes: worked, counts: true, reason: "weekly_off" };
  }
  if (!day.is_working_day) {
    return { expectedMinutes: 0, workedMinutes: worked, varianceMinutes: worked, counts: true, reason: "not_working_day" };
  }

  const shift = day.shift_duration_minutes ?? 0;

  /*
    Leave reduces what the day asks for, in proportion. A full day of approved leave expects
    nothing; a half day expects half. `leave_day_fraction` is the granted fraction, so the
    fraction still owed is 1 − that.
  */
  const leaveFraction = day.leave_type_id !== null ? Number(day.leave_day_fraction ?? 1) : 0;
  const owedFraction = Math.max(0, Math.min(1, 1 - (Number.isFinite(leaveFraction) ? leaveFraction : 0)));
  const expected = Math.round(shift * owedFraction);

  if (expected === 0) {
    return {
      expectedMinutes: 0,
      workedMinutes: worked,
      varianceMinutes: worked,
      counts: true,
      reason: "on_leave",
    };
  }

  return {
    expectedMinutes: expected,
    workedMinutes: worked,
    varianceMinutes: worked - expected,
    counts: true,
  };
}

export interface PeriodVariance {
  /** Days that contributed. */
  countedDays: number;
  /** Days skipped because the engine has not resolved them. */
  unresolvedDays: number;
  expectedMinutes: number;
  workedMinutes: number;
  /** worked − expected across every counted day. */
  varianceMinutes: number;
  /** Sum of the positive days only — the surplus, before any approval. */
  surplusMinutes: number;
  /** Sum of the negative days, as a POSITIVE number. */
  shortfallMinutes: number;
  /** Days that ended ahead, and days that ended behind. */
  surplusDays: number;
  shortfallDays: number;
}

/**
 * Roll a month up.
 *
 * Surplus and shortfall are tracked SEPARATELY as well as netted. A month that is forty minutes
 * up overall may be four hours ahead on some days and nearly four behind on others, and netting
 * that to "+40" hides the thing a manager would actually want to look at.
 */
export function periodVariance(days: readonly AttendanceDay[]): PeriodVariance {
  let countedDays = 0;
  let unresolvedDays = 0;
  let expectedMinutes = 0;
  let workedMinutes = 0;
  let surplusMinutes = 0;
  let shortfallMinutes = 0;
  let surplusDays = 0;
  let shortfallDays = 0;

  for (const day of days) {
    const v = dayVariance(day);
    if (!v.counts) {
      unresolvedDays += 1;
      continue;
    }
    countedDays += 1;
    expectedMinutes += v.expectedMinutes;
    workedMinutes += v.workedMinutes;
    if (v.varianceMinutes > 0) {
      surplusMinutes += v.varianceMinutes;
      surplusDays += 1;
    } else if (v.varianceMinutes < 0) {
      shortfallMinutes += -v.varianceMinutes;
      shortfallDays += 1;
    }
  }

  return {
    countedDays,
    unresolvedDays,
    expectedMinutes,
    workedMinutes,
    varianceMinutes: workedMinutes - expectedMinutes,
    surplusMinutes,
    shortfallMinutes,
    surplusDays,
    shortfallDays,
  };
}

export interface Consequences {
  /**
   * Comp-off days the month's surplus is worth, as the engine has ALREADY granted them.
   *
   * Read from the period summary, not derived from minutes. Comp-off is granted by policy — a
   * full day worked on a holiday or a weekly off, not "every eight hours of surplus" — so
   * computing it here from a variance would invent a number the payroll does not recognise and
   * put it on an employee's screen next to real ones.
   */
  compOffDays: number;
  /**
   * Leave days already deducted for lateness, from the engine.
   *
   * Again read, not derived: the late-deduction rule lives in `attendance_policies` and is
   * applied server-side. This is the figure that will actually appear against them.
   */
  lateDeductionLeaveDays: number;
  /** Payable overtime the engine recognises, and how much of it is approved. */
  overtimeMinutes: number;
  approvedOvertimeMinutes: number;
  /**
   * Surplus the engine did NOT count as overtime.
   *
   * The honest gap between "I worked longer" and "I will be paid for it". Shown as its own
   * figure rather than folded into either, because presenting unapproved surplus as overtime
   * would promise something payroll has not agreed to.
   */
  unrecognisedSurplusMinutes: number;
}

/**
 * What the month's numbers actually mean for the person.
 *
 * Everything here is READ from the engine's own summary except the one derived figure, which is
 * labelled as a gap rather than as an entitlement. Deriving entitlements in a UI is how an
 * employee ends up being shown a number nobody in payroll will honour.
 */
export function consequences(
  summary: AttendancePeriodSummary,
  variance: PeriodVariance,
): Consequences {
  const overtime = summary.overtime_minutes;
  const unrecognised = Math.max(0, variance.surplusMinutes - overtime);
  return {
    compOffDays: Number(summary.comp_off_days ?? 0),
    lateDeductionLeaveDays: Number(summary.late_deduction_leave_days ?? 0),
    overtimeMinutes: overtime,
    approvedOvertimeMinutes: summary.approved_overtime_minutes,
    unrecognisedSurplusMinutes: unrecognised,
  };
}

/**
 * Signed duration for display: `+1h 20m`, `−45m`, or `0m`.
 *
 * The sign is explicit on the positive side too. "1h 20m" in a column that can hold either
 * direction is ambiguous at a glance, and this column exists to be read at a glance. A true
 * minus sign rather than a hyphen, because it sits next to digits.
 */
export function fmtSignedMinutes(minutes: number): string {
  if (minutes === 0) return "0m";
  const sign = minutes > 0 ? "+" : "−";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  if (hours === 0) return `${sign}${mins}m`;
  if (mins === 0) return `${sign}${hours}h`;
  return `${sign}${hours}h ${mins}m`;
}
