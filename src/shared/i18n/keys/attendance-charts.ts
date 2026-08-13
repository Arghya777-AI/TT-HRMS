/**
 * i18n keys owned EXCLUSIVELY by the E-03 month-glance charts
 * (`features/attendance/components/MonthGlance.tsx`).
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`, so two
 * people appending to one catalogue silently lose each other's keys.
 *
 * Every string here exists to stop a picture over-claiming. A bar chart is read faster
 * than a table and argued with less, so the two notes say plainly what the height is,
 * what a missing bar means, and where the exact figures are — a reader who takes a gap
 * for a zero has been told the opposite of the truth about a day they were not absent.
 * The split-bar note names the one place its bands overlap, because a worked weekly off
 * is genuinely counted twice by the server and a reader measuring the bands against the
 * month would otherwise think the picture was wrong.
 */
export const keysAttendanceCharts = {
  "attendance.glance.split.title": "The month in one bar",
  "attendance.glance.split.note":
    "Each band is the server's own count — the same figures as the tiles above. A weekly off or holiday you worked is counted both as attended and as its own kind of day, so the bands can add up to more than the month.",

  "attendance.glance.trend.title": "Hours worked, day by day",
  "attendance.glance.trend.note":
    "Bar height is the hours recorded for that day and the colour is its status. A day with no bar has no hours recorded — a weekly off, a holiday, a leave, an absence, or a date still to come. The exact figures are in the register below.",
  "attendance.glance.trend.caption": "{date} · {status}",
};
