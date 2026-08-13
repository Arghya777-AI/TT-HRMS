/**
 * i18n keys owned EXCLUSIVELY by the E-02 `/me` charts. One file per author —
 * `t()` is typed on `keyof typeof en`, so concurrent appends to en.ts silently
 * lose keys.
 *
 * Surfaces: the paid-days ring on the my-month strip (Region D), one ring per
 * leave type on the balances card (Region E), the comp-off expiry ring
 * (Region F), and the worked-hours bars under the month calendar.
 *
 * EVERY STRING NAMES BOTH NUMBERS. A ring is a shape; the caption under it and
 * the screen-reader title are what turn it into a fact — and each one quotes the
 * same two server columns the tile beside it already prints, so the picture and
 * the figure cannot be read as two different claims.
 */
export const keysHomeCharts = {
  // Region D — paid days against the days elapsed so far this month.
  "home.chart.paidDays.title":
    "{paid} paid days of the {total} days elapsed so far this month",
  "home.chart.paidDays.caption": "of {total} elapsed",

  // Region E — one ring per leave type: taken against entitled.
  "home.chart.leave.title": "{type}: {used} taken of {entitlement} entitled this leave year",
  "home.chart.leave.caption": "of {entitlement}",

  // Region F — the slice of the comp-off balance that lapses within 30 days.
  "home.chart.compOff.title":
    "{expiring} of your {available} available comp-off days expire within 30 days",
  "home.chart.compOff.caption": "expiring of {available}",

  // Month calendar — hours worked, day by day.
  "home.chart.worked.heading": "Hours worked each day",
  "home.chart.worked.title": "Hours worked on each day of {month}. A gap means no record.",
} as const;
