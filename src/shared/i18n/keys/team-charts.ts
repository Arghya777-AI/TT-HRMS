/**
 * i18n keys for the CHARTS on the two manager screens — /team and
 * /team/attendance.
 *
 * A separate file for the same reason every other `keys/*.ts` is one: `t()` is
 * typed on `keyof typeof en`, so every new visual needs new keys, and appending
 * to the 11k-line en.ts from two branches at once loses whichever landed first.
 *
 * ── WHY THE NOTES BELOW ARE SO INSISTENT ───────────────────────────────────
 *
 * Both charts draw a PART of their screen, not the whole of it, and both say so
 * in words underneath. That is not padding.
 *
 * On Team Today the six presence tiles do NOT partition the board. Two of them
 * are subsets of two others by construction — `late_in` is `is_late`, which only
 * a person who scanned can be, so every late arrival is also counted under "In";
 * and `on_leave` is a status filter inside the wider `off_today` set. Worse,
 * `attendance_days.is_working_day` is a GENERATED column reading
 * `NOT is_holiday AND NOT is_weekly_off AND status NOT IN ('not_yet_joined',
 * 'post_exit')`, so an approved leave day on an ordinary Tuesday is still a
 * working day — which makes a person on leave satisfy BOTH "Off today" and, once
 * the grace expires with no scan, "Not scanned yet". A stacked bar over all six
 * would therefore divide a whole that does not exist, and its widths would be
 * shares of a number the page never prints. The bar takes the three states the
 * view guarantees are mutually exclusive — scanned, still inside grace, past
 * grace — and the caption states what it leaves out.
 *
 * On Team Attendance the three day counts in each roll-up row are disjoint but
 * not exhaustive: weekly offs and holidays are separate columns of
 * `f_attendance_period_summary` that the table does not show. So the bar is
 * described as dividing those three counts, never as dividing the period.
 */
export const keysTeamCharts = {
  // ---------------------------------------------------------------------------
  // /team — the presence picture beside the tiles
  // ---------------------------------------------------------------------------
  "team.today.chart.title": "Where your team is right now",
  "team.today.chart.hint":
    "Drawn from the same counts as the tiles above — the ring against your board total, the bar across the three gate states. Nothing here is added up or worked out in your browser; every figure is one the database counted.",
  "team.today.chart.ring.title": "How much of your board has scanned in",
  "team.today.chart.ring.caption": "in, of {n} on your board",
  "team.today.chart.gate.title": "At the gate: scanned in, still due, and past grace",
  "team.today.chart.note":
    "The bar shows only the three gate states that cannot overlap: scanned in, still inside the grace period, and past grace with no scan. People off today are not in it — an approved leave day is still a working day to the engine, so counting it in both places would show one person twice.",

  // ---------------------------------------------------------------------------
  // /team/attendance — the split inside each roll-up row
  // ---------------------------------------------------------------------------
  "team.att.trend.split": "Present / absent / leave",
  "team.att.trend.splitTitle": "{name}: present, absent and leave days in this period",
  "team.att.trend.splitNote":
    "The bar in each row divides that row's own three counts — present, absent and leave. Weekly offs and holidays are counted separately by the same function and are not shown here, so the bar is a comparison between those three, not a picture of the whole period.",
} as const;
