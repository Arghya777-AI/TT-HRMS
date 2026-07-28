/**
 * analyticsFilterBar.ts — every state transition the shared analytics filter bar
 * can make, as pure functions over {@link AnalyticsFilters} and `URLSearchParams`.
 *
 * WHY THIS IS NOT INSIDE THE .tsx
 * -------------------------------
 * The bar keeps NO copy of the filter: it reads `useSearchParams`, and every
 * control writes the URL back. That leaves the whole of its behaviour as data —
 * "what does Next mean on a fortnight", "does Clear filters move the dates",
 * "what happens to July when you switch to Day" — and those are exactly the
 * answers that go quietly wrong. Keeping them here means `analyticsFilterBar.test.ts`
 * can pin them without a router, a DOM or a single render.
 *
 * TWO RULES ENCODED BELOW, BOTH LEARNED THE HARD WAY
 * --------------------------------------------------
 *  * CLEARING FILTERS NEVER MOVES THE DATES. `clearDimensions` already guarantees
 *    it; the URL writer here must not undo that by rebuilding the period. A user
 *    who clears a department and silently lands in a different month stops
 *    trusting every number on the page.
 *  * NEXT STOPS AT TODAY (DR-30, the phantom-absent defect in its calendar form).
 *    An empty August grid in July reads as an outage, not as the future.
 *
 * PARAMS THIS MODEL DOES NOT OWN ARE PRESERVED. A drill-through carries things
 * like `?status=late` alongside the filter; rewriting the query string from
 * scratch would drop them and change the question being asked.
 */
import {
  addDays,
  isIsoDate,
  periodFor,
  periodLengthDays,
  shiftPeriod,
  type Granularity,
  type Period,
} from "@/lib/period";
import {
  FILTER_PARAM_KEYS,
  filtersToParams,
  type AnalyticsFilters,
  type SourceFilter,
} from "@/lib/analyticsFilters";
import { fmtCivilDate, fmtMonthLong, istToday } from "@/lib/datetime";
import type { MessageKey } from "@/shared/i18n/en";

/** A narrowing the bar can show a control for. `employee` arrives by drill-down. */
export type AnalyticsDimension = "department" | "location" | "source" | "employee";

/** The three id-valued dimensions — `source` is an enum and is set separately. */
type DimensionKey = "departmentId" | "locationId" | "employeeId";

/** `AnalyticsFilters` with its `readonly` stripped, so a key can be deleted. */
type MutableFilters = { -readonly [K in keyof AnalyticsFilters]: AnalyticsFilters[K] };

// ─────────────────────────────────────────────────────────────────────────────
// The URL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The params to navigate to: `current` with every filter key replaced by
 * `filters`, and everything else left exactly as it was.
 *
 * Delete-then-set rather than set-only: a dimension that has just been cleared
 * has NO entry in `filtersToParams`, so without the delete pass it would survive
 * in the URL and keep narrowing the view that the user just widened.
 */
export function filterParams(
  current: URLSearchParams,
  filters: AnalyticsFilters,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of FILTER_PARAM_KEYS) next.delete(key);
  for (const [k, v] of Object.entries(filtersToParams(filters))) next.set(k, v);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Period transitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Change granularity, keeping the user roughly where they were looking.
 *
 * The anchor is TODAY when today is inside the period on screen, and the
 * period's first day otherwise. So narrowing this month to Day gives you today,
 * while narrowing March gives you 1 March — never "1 January" because the year
 * happened to be selected, and never a jump to today out of a period the user
 * deliberately navigated to.
 *
 * Switching to Custom keeps both ends of what is already showing, so the two
 * date inputs open on the month you were reading rather than collapsing to a
 * single day the moment you reach for them.
 */
export function withGranularity(
  filters: AnalyticsFilters,
  granularity: Granularity,
): AnalyticsFilters {
  const { period } = filters;
  if (granularity === period.granularity) return filters;
  if (granularity === "range") {
    return { ...filters, period: { granularity: "range", from: period.from, to: period.to } };
  }
  // ISO civil dates sort lexicographically, so a string compare IS the ordering.
  const today = istToday();
  const inside = today >= period.from && today <= period.to;
  return { ...filters, period: periodFor(granularity, inside ? today : period.from) };
}

/** Move one period back (`-1`) or forward (`+1`). A custom range steps by its own length. */
export function steppedFilters(filters: AnalyticsFilters, delta: number): AnalyticsFilters {
  return { ...filters, period: shiftPeriod(filters.period, delta) };
}

/**
 * The "Today" / "This month" reset: the current period of the same granularity,
 * dimensions untouched.
 *
 * A custom range resets to the same NUMBER OF DAYS ending today — "the last
 * fortnight", not a one-day window still labelled Custom, which is what
 * `periodFor("range", …)` alone would give.
 */
export function resetFilters(filters: AnalyticsFilters): AnalyticsFilters {
  const today = istToday();
  const { period } = filters;
  if (period.granularity !== "range") {
    return { ...filters, period: periodFor(period.granularity, today) };
  }
  const span = periodLengthDays(period);
  return {
    ...filters,
    period: { granularity: "range", from: addDays(today, -(span - 1)), to: today },
  };
}

/**
 * True when the reset button would land on the period already showing, so it can
 * be disabled rather than offering a click that does nothing. Compared against
 * `resetFilters` itself, because "the current period" differs by granularity —
 * a custom range is at present when it ENDS today, not when it contains today.
 */
export function isAtPresent(filters: AnalyticsFilters): boolean {
  const reset = resetFilters(filters).period;
  return reset.from === filters.period.from && reset.to === filters.period.to;
}

/**
 * Forward stepping stops once the period reaches today: the next one would be
 * entirely in the future, and a grid of blank days reads as a broken feed.
 */
export function canStepForward(period: Period): boolean {
  return period.to < istToday();
}

/** Backward stepping stops at the earliest date the caller has data for, if it knows one. */
export function canStepBack(period: Period, minDate?: string): boolean {
  return minDate === undefined || period.from > minDate;
}

/**
 * Move the start of a custom range. The end FOLLOWS rather than the edit being
 * refused: an inverted range matches no rows, and "no data" is indistinguishable
 * on screen from a genuinely empty period. A value that is not a civil date
 * (a cleared input) leaves the filter alone.
 */
export function withRangeStart(filters: AnalyticsFilters, from: string): AnalyticsFilters {
  if (!isIsoDate(from)) return filters;
  const to = filters.period.to < from ? from : filters.period.to;
  return { ...filters, period: { granularity: "range", from, to } };
}

/** Move the end of a custom range; the start follows if it would be left behind. */
export function withRangeEnd(filters: AnalyticsFilters, to: string): AnalyticsFilters {
  if (!isIsoDate(to)) return filters;
  const from = to < filters.period.from ? to : filters.period.from;
  return { ...filters, period: { granularity: "range", from, to } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimension transitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set or clear one id-valued dimension. An empty string is a cleared `<select>`,
 * not a filter on the empty id — it removes the key entirely, because
 * `activeDimensionCount` and `filtersToParams` both test for `undefined`.
 */
export function withDimension(
  filters: AnalyticsFilters,
  key: DimensionKey,
  id: string | null,
): AnalyticsFilters {
  const next: MutableFilters = { ...filters };
  if (id === null || id === "") delete next[key];
  else next[key] = id;
  return next;
}

export function withSource(filters: AnalyticsFilters, source: SourceFilter): AnalyticsFilters {
  return { ...filters, source };
}

// ─────────────────────────────────────────────────────────────────────────────
// Labels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one human sentence for a period.
 *
 * Dates go through `fmtCivilDate` ('01-Jul-2026'), not a prettier local spelling:
 * §8 fixes ONE date format for the whole product, and a banner reading
 * "1 Jul 2026" above a grid of "01-Jul-2026" rows is DR-21 in miniature.
 *
 * A period whose ends do not match its granularity — `?g=month` with half a
 * month in it, which a hand-edited URL can produce — is labelled by its actual
 * days. The banner must describe what was queried, never what the granularity
 * promises.
 */
export function periodLabel(period: Period): string {
  const span = `${fmtCivilDate(period.from)} – ${fmtCivilDate(period.to)}`;
  if (period.granularity === "range") {
    return period.from === period.to ? fmtCivilDate(period.from) : span;
  }
  const canonical = periodFor(period.granularity, period.from);
  if (canonical.from !== period.from || canonical.to !== period.to) return span;
  switch (period.granularity) {
    case "day":
      return fmtCivilDate(period.from);
    case "week":
      return span;
    case "month":
      return fmtMonthLong(period.from.slice(0, 7));
    case "year":
      return period.from.slice(0, 4);
  }
}

export const GRANULARITY_LABEL_KEY: Readonly<Record<Granularity, MessageKey>> = {
  day: "analytics.filter.granularity.day",
  week: "analytics.filter.granularity.week",
  month: "analytics.filter.granularity.month",
  year: "analytics.filter.granularity.year",
  range: "analytics.filter.granularity.range",
};

/** The noun for one step — 'Previous week', 'Next month'. */
export const GRANULARITY_UNIT_KEY: Readonly<Record<Granularity, MessageKey>> = {
  day: "analytics.filter.unit.day",
  week: "analytics.filter.unit.week",
  month: "analytics.filter.unit.month",
  year: "analytics.filter.unit.year",
  range: "analytics.filter.unit.range",
};

/** 'Today' / 'This month' / 'Ending today' — what the reset button actually does. */
export const RESET_LABEL_KEY: Readonly<Record<Granularity, MessageKey>> = {
  day: "analytics.filter.reset.day",
  week: "analytics.filter.reset.week",
  month: "analytics.filter.reset.month",
  year: "analytics.filter.reset.year",
  range: "analytics.filter.reset.range",
};

/**
 * `punch_source` labels, reused from the punch console's own catalogue rather
 * than re-worded here — the same enum value must read the same on every screen.
 */
export const SOURCE_LABEL_KEY: Readonly<Record<SourceFilter, MessageKey>> = {
  all: "analytics.filter.source.all",
  web: "admin.punch.source.web",
  kiosk_face: "admin.punch.source.kioskFace",
  mobile: "admin.punch.source.mobile",
  import: "admin.punch.source.import",
  manual: "admin.punch.source.manualAdmin",
};
