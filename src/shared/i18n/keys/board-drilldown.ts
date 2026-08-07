/**
 * i18n keys for the department subtotals drill-down.
 *
 * THE ON-SITE NOTE IS NOT DECORATION. Two time figures sit side by side and they legitimately
 * disagree: the ticking one is wall-clock since the first scan (breaks included), the other is
 * the engine's paid `worked_minutes` with the unpaid break deducted. Somebody comparing them
 * will notice, and a dashboard that shows two different numbers for "how long have they worked"
 * without saying why reads as a bug. So it says why.
 */
/**
 * Colour names for chart legends, so a legend never relies on the swatch alone. Named rather
 * than derived: the token is `--destructive`, and "destructive (red)" is not what a reader
 * wants to see under a pie chart of attendance.
 */
export const keysChartColours = {
  "chart.colour.green": "green",
  "chart.colour.red": "red",
  "chart.colour.amber": "amber",
  "chart.colour.grey": "grey",
  "chart.colour.paleGrey": "pale grey",
  "chart.colour.gold": "gold",
  "chart.colour.terracotta": "terracotta",
  "chart.colour.plum": "plum",
  "chart.colour.iris": "iris",
  /* Not a hue: this slice is drawn as a 45-degree hatch precisely so it reads as
     different-in-kind rather than as one more colour. */
  "chart.colour.hatched": "hatched",
} as const;

export const keysBoardDrilldown = {
  "admin.board.drill.heading": "{n} {what} · {where}",
  "admin.board.drill.nobody": "Nobody in this group for the dates shown.",
  "admin.board.drill.person": "Employee",
  "admin.board.drill.firstScan": "First scan",
  "admin.board.drill.lastScan": "Last scan",
  "admin.board.drill.onSite": "On site now",
  "admin.board.drill.worked": "Paid worked",
  "admin.board.drill.lateBy": "Late by",
  "admin.board.drill.onSiteNote":
    "“On site now” counts from the first scan and keeps running while the person is still in, breaks included. “Paid worked” is the attendance engine's figure with the shift's unpaid break deducted — which is why the two differ.",
  "admin.board.drill.leaveType": "Leave",
  "admin.board.drill.leaveSpan": "From → to",
  "admin.board.drill.leaveReason": "Reason",
  "admin.board.drill.leaveFailed": "Could not load the leave details. The counts above are still correct.",
  "admin.board.drill.open": "Show who",
  "admin.board.drill.close": "Hide",
} as const;
