/**
 * useTeamReview.ts — the query layer behind /team/performance, and the review
 * period's own vocabulary.
 *
 * Three rules this file holds, the same three the rest of the manager surface
 * holds, restated for a window that is not a calendar month:
 *
 *  1. THE PERIOD IS AGGREGATED BY POSTGRES, ONCE. `f_attendance_period_summary`
 *     takes an arbitrary inclusive range, so a quarter is one call with
 *     `p_from`/`p_to` — never three monthly rows added together here. Adding
 *     server aggregates in a browser is how a quarter's "late days" ends up
 *     disagreeing with the month views it was built from.
 *  2. EVERY TILE IS A `count=exact` OVER THE SAME PREDICATE THE LIST USES
 *     (`teamRangeDayFilters`, `teamConfirmationFilters`). Nothing here reads
 *     `rows.length`.
 *  3. THE WINDOW IS DATE CONSTRUCTION, NOT ARITHMETIC. `reviewRange` picks two
 *     civil dates out of the IST calendar with the shared helpers; it does not
 *     compute a business figure, and the numbers that come back are stamped with
 *     the server's own `from_date`/`to_date`/`total_days`.
 *
 * A manager with no reportees keeps every query disabled and gets an empty
 * screen that says so — not a read whose empty result would be ambiguous.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { addIstDays, addIstMonths, istMonthOfDate, istMonthRange } from "@/lib/datetime";
import {
  countTeamConfirmations,
  countTeamRangeDays,
  fetchTeamConfirmations,
  fetchTeamReviewSummaries,
  type ConfirmationSlice,
  type TeamDaySlice,
  type TeamMember,
  type TeamReviewRange,
  type TeamReviewSummary,
} from "../api/team.api";

// -----------------------------------------------------------------------------
// 1. The review period
// -----------------------------------------------------------------------------

/**
 * The windows a review is actually held over. Each one ENDS on today's IST
 * business date and STARTS at a month boundary, because a period that began on
 * the 14th would make `working_days` incomparable between two reportees read a
 * week apart.
 */
export const reviewWindows = ["1m", "3m", "6m", "12m"] as const;
export type ReviewWindow = (typeof reviewWindows)[number];

/** A quarter — the shortest span anybody calls a review, and the default. */
export const DEFAULT_REVIEW_WINDOW: ReviewWindow = "3m";

/** How many whole months BEFORE the current one each window reaches back. */
const WINDOW_MONTHS_BACK: Readonly<Record<ReviewWindow, number>> = {
  "1m": 0,
  "3m": 2,
  "6m": 5,
  "12m": 11,
};

export function isReviewWindow(value: string | null): value is ReviewWindow {
  return value !== null && (reviewWindows as readonly string[]).includes(value);
}

/**
 * The window as two inclusive IST civil dates.
 *
 * `to` is TODAY and never the end of the month: a period that ran to the 31st in
 * mid-July would put fourteen days that have not happened into
 * `attendance_pct`'s denominator, which is the phantom-absent defect (DR-30) in
 * its calendar form.
 */
export function reviewRange(window: ReviewWindow, today: string): TeamReviewRange {
  const startMonth = addIstMonths(istMonthOfDate(today), -WINDOW_MONTHS_BACK[window]);
  return { from: istMonthRange(startMonth).from, to: today };
}

/** How far ahead "confirmation due soon" looks — spec-manager §11 unlocks at T-30. */
export const CONFIRMATION_HORIZON_DAYS = 30;

// -----------------------------------------------------------------------------
// 2. The review record
// -----------------------------------------------------------------------------

/** One metric-dictionary row per reportee for the whole period. */
export function useTeamReviewSummaries(
  range: TeamReviewRange,
  employeeIds: readonly string[],
): UseQueryResult<TeamReviewSummary[], Error> {
  return useQuery({
    queryKey: qk.team.list({
      view: "review-summary",
      from: range.from,
      to: range.to,
      employees: [...employeeIds].sort(),
    }),
    enabled: employeeIds.length > 0,
    queryFn: ({ signal }) => fetchTeamReviewSummaries(range, employeeIds, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * One exception tile for the period. The slice is the same predicate
 * `/team/attendance` uses, so the two screens count the same day rows.
 */
export function useTeamRangeDayCount(
  range: TeamReviewRange,
  employeeIds: readonly string[],
  slice: TeamDaySlice,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.team.list({
      view: "review-day-count",
      from: range.from,
      to: range.to,
      slice,
      employees: [...employeeIds].sort(),
    }),
    enabled: employeeIds.length > 0,
    queryFn: ({ signal }) => countTeamRangeDays({ range, employeeIds, slice }, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 3. Confirmation duties
// -----------------------------------------------------------------------------

/** The shape both confirmation hooks key and filter on, built in one place. */
function confirmationInput(
  employeeIds: readonly string[],
  slice: ConfirmationSlice,
  today: string,
) {
  return {
    employeeIds,
    slice,
    today,
    horizon: addIstDays(today, CONFIRMATION_HORIZON_DAYS),
  } as const;
}

function confirmationKey(
  employeeIds: readonly string[],
  slice: ConfirmationSlice,
  today: string,
): Record<string, unknown> {
  return {
    view: "confirmations",
    slice,
    today,
    employees: [...employeeIds].sort(),
  };
}

/** Reportees on probation in this slice, soonest due first. */
export function useTeamConfirmations(
  employeeIds: readonly string[],
  slice: ConfirmationSlice,
  today: string,
): UseQueryResult<TeamMember[], Error> {
  return useQuery({
    queryKey: qk.team.list(confirmationKey(employeeIds, slice, today)),
    enabled: employeeIds.length > 0,
    queryFn: ({ signal }) => fetchTeamConfirmations(confirmationInput(employeeIds, slice, today), signal),
    retry: shouldRetryQuery,
  });
}

/** The same predicate, counted by Postgres. */
export function useTeamConfirmationCount(
  employeeIds: readonly string[],
  slice: ConfirmationSlice,
  today: string,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.team.list({ ...confirmationKey(employeeIds, slice, today), agg: "count" }),
    enabled: employeeIds.length > 0,
    queryFn: ({ signal }) => countTeamConfirmations(confirmationInput(employeeIds, slice, today), signal),
    retry: shouldRetryQuery,
  });
}
