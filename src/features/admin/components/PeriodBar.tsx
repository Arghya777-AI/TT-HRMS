/**
 * PeriodBar — day / week / month / year / custom-range period selection for the
 * screens that used to offer a month and nothing else.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A WRAPPER AND NOT A NEW CONTROL
 *
 * It IS `AnalyticsFilterBar`, with every dimension hidden. That matters for one
 * specific reason: the bar reads and writes the period through
 * `useAnalyticsFilters`, which stores it in the URL under the SAME parameter names
 * the analytics dashboard uses. So a period chosen on `/admin/analytics` survives
 * the click into `/admin/attendance/days` — the drill-down keeps the question.
 * That is the whole point, and a bespoke month-or-range control would have got the
 * behaviour without the shared state and quietly reset the period on navigation.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * WHY THE DIMENSIONS ARE HIDDEN RATHER THAN OFFERED
 *
 * These pages already have their own employee / department / status pickers, and
 * those write to their OWN url parameters (`employee`, `department`, `status`) —
 * not to the analytics bar's (`emp`, `dept`, `loc`). Rendering the full bar here
 * would put a SECOND employee dropdown on the screen, bound to a different
 * parameter, silently disagreeing with the first. Two controls for one concept is
 * worse than one narrow control, so this exposes only the period, which is the
 * part these screens genuinely lacked.
 *
 * Pages built on a month-grained relation must NOT use this: offering a day or a
 * range while the data can only answer by calendar month is a filter applied and
 * denied in the same breath. `MonthStepper` is still the honest control there.
 */
import { AnalyticsFilterBar } from "./AnalyticsFilterBar";
import type { AnalyticsDimension } from "../analyticsFilterBar";

/** Every dimension. Listed once here rather than at each of the call sites. */
const ALL_DIMENSIONS: readonly AnalyticsDimension[] = [
  "department",
  "location",
  "source",
  "employee",
];

export interface PeriodBarProps {
  /** Earliest civil date the caller has data for; below it "previous" is disabled. */
  readonly minDate?: string;
  readonly className?: string;
}

export function PeriodBar({ minDate, className }: PeriodBarProps) {
  return (
    <AnalyticsFilterBar
      hide={ALL_DIMENSIONS}
      {...(minDate !== undefined ? { minDate } : {})}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
