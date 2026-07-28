/**
 * i18n keys owned EXCLUSIVELY by the analytics realtime layer
 * (`features/admin/analyticsLive.ts` + `hooks/useAnalyticsLive.ts`).
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`, so two
 * people appending to one catalogue silently lose each other's keys.
 *
 * Every string here exists to stop the screen over-claiming. "Live" is a promise about
 * how old the numbers are, and a dashboard that keeps making it after the socket has
 * died is how a stale figure gets acted on. So the unavailable copy says what is still
 * true (the numbers are as at the last read) rather than apologising, and the live copy
 * names what actually triggers a refresh — a reader who thinks "live" includes the
 * payroll register will misread a flat line.
 */
export const keysAnalyticsLive = {
  "admin.analytics.live.live": "Live",
  "admin.analytics.live.liveHint":
    "Figures refresh within about two seconds of a scan, a leave decision or a payroll run. Rapid scans are grouped into one refresh so the dashboard stays responsive at shift change.",

  "admin.analytics.live.connecting": "Connecting…",
  "admin.analytics.live.connectingHint":
    "Joining the live feed. The figures below are as at the last read until it connects.",

  "admin.analytics.live.unavailable": "Not live",
  "admin.analytics.live.unavailableHint":
    "The live feed is unavailable, so nothing on this page is updating on its own. The figures are as at the last read — reload, or change a filter, for the current position.",

  "admin.analytics.live.off": "Live updates off",
  "admin.analytics.live.offHint":
    "This view is not subscribed to changes. The figures are as at the last read.",
} as const;
