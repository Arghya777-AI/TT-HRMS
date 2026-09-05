/**
 * leaveRange.ts — reading a from–to range as leave: what it costs, and what it does not.
 *
 * WHY THIS EXISTS. The apply screen used to take a single start date and send
 * `to_date = from_date`, so a three-day allocation filed three ONE-DAY requests. The range is
 * the fix, and a range immediately raises the question the user asked about: "respect the week
 * off rules". Saturday to Monday is three calendar days and — for somebody whose weekly off is
 * Sunday — two days of leave.
 *
 * ── THE SERVER DECIDES WHICH DATES COUNT, NOT THIS FILE ──────────────────────
 * Every judgement about weekly offs and holidays arrives from `leave_countable_dates`
 * (migration 040000), a read-only mirror of the engine's own day loop. This module is only
 * ARITHMETIC over that answer: count, summarise, compare with what the employee allocated, deal
 * the dates out across leave types. Nothing here knows what a Sunday is, and that is the point.
 *
 * The live proof that it must be this way: TT0013's `employees.weekly_off_rule_id` says
 * WO-SUN-ALTSAT (Sunday + alternate Saturday), while `resolve_policy` — which the engine
 * follows — says WO-MIDWEEK-TUE. A browser reading the employee column would have marked
 * Sunday free and Tuesday chargeable, and been wrong about both.
 *
 * ── HALF DAYS ARE THE REASON THE TOTAL STAYS EDITABLE ────────────────────────
 * A counted range is always a whole number of days; a half day never is. So the counted total
 * SEEDS the number the employee allocates against and does not replace it — and when the two
 * disagree by something other than a half day, `rangeMismatch` says so rather than silently
 * overriding one with the other.
 */
import { civilDayOffset } from "@/lib/datetime";
import type { CountableDate } from "./api/leave-apply.api";
import type { HalfPortion, LeavePortion } from "./leavePortion";

/** Why a date in the chosen range costs nothing. */
export type FreeDayReason = "weekly_off" | "holiday";

export interface RangeSummary {
  /** Dates that cost leave balance. */
  readonly countedDays: number;
  /** Dates inside the range that cost nothing, with the reason. */
  readonly freeDays: number;
  /** Every date in the range, in order, as the server judged it. */
  readonly dates: readonly CountableDate[];
  readonly weeklyOffs: number;
  readonly holidays: number;
}

/**
 * Why a date is free. Weekly off wins when a holiday falls on one: the employee was not
 * working that day either way, and reporting it as a holiday would imply a holiday was
 * consumed. The server marks both flags; this decides which to SHOW.
 */
export function freeDayReason(date: CountableDate): FreeDayReason | null {
  if (date.would_count) return null;
  return date.is_weekly_off ? "weekly_off" : "holiday";
}

export function summariseRange(dates: readonly CountableDate[]): RangeSummary {
  let counted = 0;
  let weeklyOffs = 0;
  let holidays = 0;
  for (const date of dates) {
    if (date.would_count) {
      counted += 1;
      continue;
    }
    if (freeDayReason(date) === "weekly_off") weeklyOffs += 1;
    else holidays += 1;
  }
  return {
    countedDays: counted,
    freeDays: dates.length - counted,
    dates,
    weeklyOffs,
    holidays,
  };
}

/**
 * Is the range itself usable? Answered WITHOUT the server, so the screen can refuse an
 * inverted range before spending a round trip on it — and so the 366-day guard in
 * `leave_countable_dates` is never hit as an error the employee has to read.
 */
export type RangeProblem =
  | { readonly kind: "incomplete" }
  | { readonly kind: "inverted" }
  | { readonly kind: "tooLong"; readonly days: number };

export const MAX_RANGE_DAYS = 366;

export function rangeProblem(fromDate: string, toDate: string): RangeProblem | null {
  if (fromDate === "" || toDate === "") return { kind: "incomplete" };
  if (toDate < fromDate) return { kind: "inverted" };
  const span = civilDayOffset(fromDate, toDate) + 1;
  if (span > MAX_RANGE_DAYS) return { kind: "tooLong", days: span };
  return null;
}

/**
 * Does the allocated total match what the range actually costs?
 *
 * `null` means they agree — including the legitimate half-day case, where the employee asks
 * for 0.5 of a single counted day. Anything else is a real disagreement worth showing, because
 * the server stamps `total_days` from the RANGE: allocate 3 days across a range that counts 2
 * and the balance check will refuse a number the screen never displayed.
 */
export type RangeMismatch =
  | { readonly kind: "allocatedMore"; readonly counted: number; readonly allocated: number }
  | { readonly kind: "allocatedLess"; readonly counted: number; readonly allocated: number };

export function rangeMismatch(countedDays: number, allocatedTotal: number): RangeMismatch | null {
  if (allocatedTotal <= 0) return null;
  if (countedDays === allocatedTotal) return null;
  // A half day of a single counted day is the one intended difference.
  if (countedDays === 1 && allocatedTotal === 0.5) return null;
  return allocatedTotal > countedDays
    ? { kind: "allocatedMore", counted: countedDays, allocated: allocatedTotal }
    : { kind: "allocatedLess", counted: countedDays, allocated: allocatedTotal };
}

// -----------------------------------------------------------------------------
// Splitting one range across several leave types
// -----------------------------------------------------------------------------

/**
 * WHY A SPLIT IS NOT OPTIONAL. `leave_requests_no_overlap` is a BEFORE trigger that refuses a
 * pending or approved request whose `daterange(from_date, to_date, '[]')` overlaps another for
 * the same employee:
 *
 *   leave request overlaps existing request LR-… for the same employee   (23P01)
 *
 * A combined application is N rows, one per leave type. Giving every row the SAME range — which
 * is what this screen did — makes the second row overlap the first and the whole application is
 * refused. There is nowhere else to put the distinction: `leave_requests` carries ONE
 * `leave_type_id`, so "1 day of Earned Leave and 2 of Week-off" can only mean *these* dates from
 * one and *those* dates from the other.
 *
 * So the counted dates are dealt out in order: the first type takes the first dates, the next
 * takes the dates after them. Disjoint by construction, and in the order the employee listed
 * their types.
 *
 * ── WHY A HALF DAY BECOMES ITS OWN SEGMENT ───────────────────────────────────
 * The engine honours `portion` only when `from_date = to_date`:
 *
 *   v_portion := CASE WHEN p_from = p_to THEN p_portion ELSE 'full_day' END
 *
 * So 2.5 days of one type cannot be one request — a 2.5-day range would be stamped as 3. It
 * becomes two segments of the same type: a two-day full-day request and a one-day half-day
 * request. Same type, same application, disjoint dates, and `total_days` adds up to 2.5.
 */
export interface LeaveSegment {
  readonly typeId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly portion: LeavePortion;
  /** What this segment should cost — for checking the server's answer against, not for writing. */
  readonly expectedDays: number;
}

/** The split could not be made, with the reason and enough numbers to act on it. */
export type SplitProblem = {
  readonly kind: "notEnoughDates";
  readonly datesNeeded: number;
  readonly datesAvailable: number;
};

export interface SplitResult {
  readonly segments: readonly LeaveSegment[];
  readonly problem: SplitProblem | null;
}

/**
 * Deal the counted dates out across the allocations, in the order given.
 *
 * `countedDates` must be the dates the server said WOULD count, in ascending order — free days
 * are skipped rather than consumed, so a weekly off in the middle of a five-day absence lands
 * inside somebody's span and costs nothing, exactly as the engine prices it.
 *
 * `notEnoughDates` is reachable and is not a defensive nicety: two half-day allocations of
 * different types both need a whole date of their own, so 0.5 + 0.5 over a single counted day
 * needs two dates and has one. A date CAN now hold two requests, but only as opposite halves
 * (migration 20260907090000), and this deal gives every allocation the same `halfPortion` —
 * so two of them on one date would be the same half twice, which the guard still refuses.
 */
export function splitAllocationsAcrossDates(
  countedDates: readonly string[],
  allocations: readonly { readonly typeId: string; readonly days: number }[],
  /*
    WHICH HALF, when an allocation ends in .5. It used to be hardcoded to `first_half`, which
    is what made a date unshareable: somebody holding an approved first half could only ever
    file another first half, and `leave_requests_no_overlap` refused it against its own
    complement. Reported as HD-2026-000007 — "Not able to mark an other half day week off".
  */
  halfPortion: HalfPortion = "first_half",
): SplitResult {
  const segments: LeaveSegment[] = [];
  let cursor = 0;

  // How many whole dates the whole application needs, computed up front so the problem names
  // the shortfall rather than reporting whichever allocation happened to run out.
  const needed = allocations
    .filter((a) => a.days > 0)
    .reduce((sum, a) => sum + Math.ceil(a.days), 0);
  if (needed > countedDates.length) {
    return {
      segments: [],
      problem: { kind: "notEnoughDates", datesNeeded: needed, datesAvailable: countedDates.length },
    };
  }

  for (const allocation of allocations) {
    if (allocation.days <= 0) continue;
    const whole = Math.floor(allocation.days);
    const hasHalf = allocation.days - whole >= 0.5;

    if (whole > 0) {
      const first = countedDates[cursor];
      const last = countedDates[cursor + whole - 1];
      if (first === undefined || last === undefined) break;
      segments.push({
        typeId: allocation.typeId,
        fromDate: first,
        toDate: last,
        portion: "full_day",
        expectedDays: whole,
      });
      cursor += whole;
    }

    if (hasHalf) {
      const only = countedDates[cursor];
      if (only === undefined) break;
      segments.push({
        typeId: allocation.typeId,
        fromDate: only,
        toDate: only,
        portion: halfPortion,
        expectedDays: 0.5,
      });
      cursor += 1;
    }
  }

  return { segments, problem: null };
}

/** The dates that cost something, in order — the input `splitAllocationsAcrossDates` expects. */
export function countedDatesOf(dates: readonly CountableDate[]): string[] {
  return dates.filter((date) => date.would_count).map((date) => date.leave_date);
}
