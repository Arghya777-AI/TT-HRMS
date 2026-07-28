/**
 * i18n keys owned EXCLUSIVELY by `components/AnalyticsOverview.tsx` — the filtered,
 * charted block above the measure directory on /admin/analytics.
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`, so two
 * people appending to one catalogue silently lose each other's keys. Three agents
 * appended to `keys/analytics.ts` during this build alone.
 *
 * The copy here does real work. Several of these strings exist to stop a reader
 * drawing a conclusion the data does not support — the hints on the averages name
 * their denominator, and `truncated` admits the read was capped rather than letting a
 * short tail look like a collapse in attendance.
 */
export const keysAnalyticsOverview = {
  // ── Live board ────────────────────────────────────────────────────────────
  "admin.analytics.overview.todayTitle": "On site today",
  "admin.analytics.overview.onRoll": "On roll",
  "admin.analytics.overview.attended": "Arrived",
  "admin.analytics.overview.yetToReach": "Yet to arrive",
  "admin.analytics.overview.lateIn": "Late",
  "admin.analytics.overview.overdue": "Overdue",
  "admin.analytics.overview.webPunches": "Web / mobile",
  "admin.analytics.overview.webPunchesHint":
    "Days with at least one punch taken from the web or a phone rather than the gate.",

  // ── Selected period ───────────────────────────────────────────────────────
  "admin.analytics.overview.periodTitle": "Selected period",
  "admin.analytics.overview.employees": "People",
  "admin.analytics.overview.avgWorked": "Average worked",
  // The denominator, said out loud. An average over "days with a first AND last
  // scan" is a different number from one over every calendar day, and a reader who
  // does not know which is looking at a statistic they cannot check.
  "admin.analytics.overview.avgWorkedHint":
    "Mean over {days} complete days — days with both a first and a last scan. Weekly offs, holidays and absences are excluded, not counted as zero.",
  "admin.analytics.overview.avgInOffice": "Average in office",
  "admin.analytics.overview.avgArrival": "Average arrival",
  "admin.analytics.overview.avgArrivalHint":
    "Mean first scan, over days somebody actually scanned.",
  "admin.analytics.overview.lateDays": "Late days",
  "admin.analytics.overview.lateDaysHint":
    "Averaging {avg} when late. Punctual days are not averaged in — that would dilute the number to meaninglessness.",
  "admin.analytics.overview.overtime": "Overtime",

  // ── Statuses ──────────────────────────────────────────────────────────────
  "admin.analytics.overview.present": "Present",
  "admin.analytics.overview.absent": "Absent",
  "admin.analytics.overview.leave": "Leave",
  "admin.analytics.overview.holiday": "Holiday",
  "admin.analytics.overview.weeklyOff": "Weekly off",

  // ── Charts ────────────────────────────────────────────────────────────────
  "admin.analytics.overview.trendTitle": "Day by day",
  "admin.analytics.overview.workedHours": "Worked hours",
  "admin.analytics.overview.statusTitle": "Where the days went",
  "admin.analytics.overview.daysCounted": "day records",
  "admin.analytics.overview.deptTitle": "By department — click a bar to drill in",

  // ── Export ────────────────────────────────────────────────────────────────
  "admin.analytics.overview.exportExcel": "Excel",
  "admin.analytics.overview.exportPdf": "PDF",
  "admin.analytics.overview.exportTitle": "Attendance by department",
  "admin.analytics.overview.col.department": "Department",

  // ── Honesty about the read ────────────────────────────────────────────────
  "admin.analytics.overview.truncated":
    "This period is larger than one read can cover, so the figures stop after {rows} days of records — the end of the range is missing. Narrow the period for a complete answer.",
  "admin.analytics.overview.basis":
    "Counted from {relation} · {rows} day records in this period.",
  "admin.analytics.overview.empty.title": "No attendance records in this period",
  "admin.analytics.overview.empty.hint":
    "Nothing has been recorded for the dates and filters selected. Widen the period, or clear a filter.",
} as const;
