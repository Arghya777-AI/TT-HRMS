/**
 * weekOffSuggestion.ts — how many week-offs last month's extra work has earned.
 *
 * WHAT IT IS AND IS NOT
 * ---------------------
 * A SUGGESTION. It fills a number in beside the current balance and the
 * administrator accepts, edits or ignores it. Nothing here writes anything, and the
 * sheet never applies a suggestion the reader has not looked at — the whole point of
 * putting it next to the balance is that a person decides.
 *
 * WHICH MONTH IT LOOKS AT
 * -----------------------
 * Granting is done in arrears, and the venue described the rule precisely: before
 * the 15th you are still settling the month that just ended, and from the 15th you
 * are settling the month you are in. So
 *
 *   1–14 September   → August
 *   15–30 September  → September
 *   31 August        → August (the 31st is after the 15th, so it is "this month")
 *
 * The cutover exists because a month's attendance is not final on the 1st: punches
 * are still being regularised and the recompute queue is still draining. By the 15th
 * the month you are in has enough recorded days to be worth reading, and the month
 * before it has been settled already.
 *
 * WHAT COUNTS AS EXTRA WORK, AND HOW THAT CHANGED
 * -----------------------------------------------
 * BOTH `extra_work_minutes` (worked on a weekly off or holiday) and
 * `overtime_minutes` (extra time on a normal working day).
 *
 * The first version of this used `extra_work_minutes` alone, on the semantic
 * argument that a week-off in lieu compensates a rest day worked. The argument was
 * tidy and the feature was useless: across August this venue has 0 minutes of
 * rest-day work and 15,525 minutes — 258 hours — of overtime across 51 people. The
 * extra work is real; it is simply recorded as overtime, because the venue's rest
 * days come from a roster and the engine never marked a worked day as a rest day.
 * A suggestion column that reads 0 for all 83 employees is worse than no column.
 *
 * They are summed rather than one chosen, and the double-count worry that motivated
 * the first version was checked rather than assumed: across August, ZERO days have
 * both figures non-zero. On a rest day there is no shift to be "over", so the engine
 * records one or the other, never both.
 */

/** The month a suggestion is drawn from, and how to say it. */
export interface ReferenceMonth {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  /** "August 2026" — for the sheet's own explanation of where the number came from. */
  readonly label: string;
  /** True when it is the month the reader is currently in. */
  readonly isCurrentMonth: boolean;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** The day of the month from which "this month" becomes the reference. */
export const REFERENCE_CUTOVER_DAY = 15;

/**
 * Which month to read, given today.
 *
 * Takes an ISO date (`YYYY-MM-DD`) rather than reading the clock, so a test is not
 * racing midnight and the caller passes the IST date the rest of the app uses —
 * deriving it from a browser `Date` would put a reader in Dubai on a different month
 * from the venue.
 */
export function referenceMonth(istDate: string): ReferenceMonth {
  const [yearRaw, monthRaw, dayRaw] = istDate.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  if (day >= REFERENCE_CUTOVER_DAY) {
    return {
      year,
      month,
      label: `${MONTH_NAMES[month - 1] ?? ""} ${String(year)}`,
      isCurrentMonth: true,
    };
  }
  /* Before the cutover: the month that just ended, rolling the year in January. */
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return {
    year: prevYear,
    month: prevMonth,
    label: `${MONTH_NAMES[prevMonth - 1] ?? ""} ${String(prevYear)}`,
    isCurrentMonth: false,
  };
}

/**
 * A standard working day, in minutes.
 *
 * The venue's shift G is 09:30–17:30 with no unpaid break — 480 minutes
 * (20260817110000). One named constant rather than a literal in the arithmetic, so
 * a venue on a different day length changes it here and the suggestion follows.
 */
export const STANDARD_DAY_MINUTES = 480;

/**
 * Week-offs earned by a month's rest-day work.
 *
 * FLOORED TO A HALF DAY, NEVER ROUNDED UP. A suggestion that over-grants is worse
 * than one that under-grants: the first is money out of the door on the strength of
 * a rounding rule nobody agreed to, the second is a number an administrator can
 * raise by hand. So 1.9 days of extra work suggests 1.5, not 2.
 */
export function suggestWeekOffs(
  extraWorkMinutes: number,
  dayMinutes: number = STANDARD_DAY_MINUTES,
): number {
  if (!Number.isFinite(extraWorkMinutes) || extraWorkMinutes <= 0) return 0;
  if (!Number.isFinite(dayMinutes) || dayMinutes <= 0) return 0;
  const halves = Math.floor((extraWorkMinutes / dayMinutes) * 2);
  return halves / 2;
}

/** One employee's extra work in the reference month, as the sheet needs it. */
export interface ExtraWork {
  readonly employeeId: string;
  /** Worked on a weekly off or holiday. */
  readonly extraWorkMinutes: number;
  /** Extra time on normal working days. */
  readonly overtimeMinutes: number;
}

/**
 * The minutes a suggestion is calculated from.
 *
 * Summed, safely: no day carries both figures — verified across the venue's August,
 * where 93 days have overtime and none have rest-day work. Kept as its own function
 * so the sheet, the export and the tests all mean the same thing by "extra work".
 */
export function extraWorkMinutesOf(row: ExtraWork): number {
  return Math.max(0, row.extraWorkMinutes) + Math.max(0, row.overtimeMinutes);
}

/**
 * Suggested week-offs per employee, keyed by employee id.
 *
 * Employees with no row in the month get no entry rather than a zero: "no
 * attendance recorded" and "recorded, and nothing extra" are different facts, and
 * the sheet says so differently.
 */
export function suggestionsByEmployee(
  rows: readonly ExtraWork[],
  dayMinutes: number = STANDARD_DAY_MINUTES,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(row.employeeId, suggestWeekOffs(extraWorkMinutesOf(row), dayMinutes));
  }
  return out;
}
