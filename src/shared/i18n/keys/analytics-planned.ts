/**
 * i18n keys owned EXCLUSIVELY by the planned-metric mechanism
 * (`src/features/admin/analyticsCapabilities.ts` and `components/PlannedMetricCard.tsx`).
 *
 * A SEPARATE FILE from `keys/analytics.ts` on purpose: `t()` is typed on
 * `keyof typeof en`, and two authors appending to the same catalogue silently lose each
 * other's keys — 297 went missing that way once. One file per author, each spread into
 * `en`, is the rule that fixed it.
 */
export const keysAnalyticsPlanned = {
  /** Screen-reader suffix, so the card is announced as a note and not as a figure. */
  "admin.analytics.planned.aria": "not collected yet — this is not a measurement",
  "admin.analytics.planned.notCollected": "Not collected yet",
  "admin.analytics.planned.awaiting": "No data yet",
  "admin.analytics.planned.awaitingHint":
    "The {relation} table exists but has no rows yet. This will start reporting as soon as the first record is entered — nothing else needs switching on.",
} as const;
