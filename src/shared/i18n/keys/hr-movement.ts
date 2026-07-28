/**
 * i18n keys owned EXCLUSIVELY by the Movement & Risk panel — joiners, exits,
 * attrition and the four watchlists (`components/MovementPanel.tsx` and the
 * modules under it).
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`,
 * so two people appending to one catalogue silently lose each other's keys.
 *
 * A LOT of the copy below is load-bearing rather than decorative, and it is
 * worth saying why, because a reviewer trimming it would break the panel's whole
 * claim to be trustworthy:
 *
 *   * EVERY HR TEAM DEFINES ATTRITION DIFFERENTLY. `attrition.formula` puts the
 *     definition on the screen next to the number, and `attrition.window` says
 *     how many days it is over. An unlabelled percentage here starts an argument
 *     that a label would have ended.
 *   * ANNUALISING A SHORT WINDOW MANUFACTURES A CRISIS. One exit in a seven-day
 *     period is ×52 a year. `attrition.tooShort` refuses the multiplication and
 *     says so, rather than printing a number nobody should act on.
 *   * THE SNAPSHOT IS NOT LIVE. The headcount series comes from a matview
 *     refreshed nightly; the watchlists are read live. When the two disagree the
 *     panel says which is which (`recon.*`, `asOf`) instead of picking a winner.
 *   * A DENOMINATOR IS NEVER SILENT. Every rate below names what it divided by.
 */
export const keysHrMovement = {
  // ── Panel chrome ──────────────────────────────────────────────────────────
  "admin.movement.title": "Movement & risk",
  "admin.movement.subtitle":
    "Who joined, who left, and who needs a decision before the period is out.",

  // ── Headline tiles ────────────────────────────────────────────────────────
  "admin.movement.kpi.joiners": "Joiners",
  "admin.movement.kpi.joinersHint":
    "People whose joining date falls inside the selected period. Counted live on the employee master.",
  "admin.movement.kpi.exits": "Exits",
  "admin.movement.kpi.exitsHint":
    "People whose last working day falls inside the selected period. Counted live on the employee master.",
  "admin.movement.kpi.net": "Net change",
  "admin.movement.kpi.netHint": "Joiners minus exits. A negative number means the venue shrank.",
  "admin.movement.kpi.avgHeadcount": "Average headcount",
  "admin.movement.kpi.avgHeadcountHint":
    "Mean of the daily headcount over the {days} days the nightly snapshot covers in this period. Days it does not cover are left out of the mean, not counted as zero.",
  "admin.movement.kpi.opening": "Opening headcount",
  "admin.movement.kpi.closing": "Closing headcount",
  "admin.movement.kpi.attrition": "Attrition",
  "admin.movement.kpi.attritionAnnualised": "Attrition, annualised",

  // ── Attrition, spelled out ────────────────────────────────────────────────
  "admin.movement.attrition.title": "How this attrition rate is calculated",
  "admin.movement.attrition.formula":
    "Attrition = exits in the period ÷ average headcount over the period × 100",
  "admin.movement.attrition.numbers":
    "{exits} exits ÷ {avg} average headcount = {pct} over {days} days.",
  "admin.movement.attrition.window": "over {days} days",
  "admin.movement.attrition.annualisedLabel":
    "Annualised: × {factor} (365 ÷ {days} days). This assumes the rest of the year leaves at the same rate — it is a projection, not a measurement.",
  "admin.movement.attrition.tooShort":
    "Not annualised. Scaling {days} days up to a year multiplies every exit by {factor}, which turns one leaver into a double-digit annual rate. Select a month or longer to see an annualised figure.",
  "admin.movement.attrition.noDenominator":
    "No average headcount for this period, so no rate can be calculated. The nightly snapshot holds no rows for these dates.",
  "admin.movement.attrition.sourceNote":
    "Exits and average headcount both come from the same nightly snapshot, so the numerator and the denominator are measured the same way. The live exit count beside it may differ — see below.",

  // ── Charts ────────────────────────────────────────────────────────────────
  "admin.movement.chart.levelTitle": "Headcount, day by day",
  "admin.movement.chart.movementTitle": "Joiners and exits, day by day",
  "admin.movement.chart.movementHint":
    "Joiners rise above the line, exits fall below it. Plotted on their own axis rather than against headcount: a handful of movements against two hundred heads would be invisible on a shared scale.",
  "admin.movement.chart.headcount": "Headcount",
  "admin.movement.chart.joiners": "Joiners",
  "admin.movement.chart.exits": "Exits",
  "admin.movement.chart.noSeries":
    "The nightly headcount snapshot holds no rows for these dates, so there is no series to draw.",

  // ── By department ─────────────────────────────────────────────────────────
  "admin.movement.dept.title": "By department",
  "admin.movement.dept.hint":
    "Average headcount treats a department with nobody on a given day as a real zero — the snapshot covers the whole organisation for every date it holds, so an absent row means empty, not unknown.",
  "admin.movement.dept.col.department": "Department",
  "admin.movement.dept.col.joiners": "Joiners",
  "admin.movement.dept.col.exits": "Exits",
  "admin.movement.dept.col.net": "Net",
  "admin.movement.dept.col.avgHeadcount": "Avg headcount",
  "admin.movement.dept.col.attrition": "Attrition",
  "admin.movement.dept.unassigned": "No department",

  // ── Watchlists, shared ────────────────────────────────────────────────────
  "admin.movement.watch.heading": "Watchlists",
  "admin.movement.watch.headingHint":
    "These are decisions somebody owes, not figures to admire. Every row opens that person's record.",
  "admin.movement.watch.col.person": "Employee",
  "admin.movement.watch.col.department": "Department",
  "admin.movement.watch.col.designation": "Designation",
  "admin.movement.watch.col.manager": "Manager",
  "admin.movement.watch.col.location": "Location",
  "admin.movement.watch.col.status": "Status",
  "admin.movement.watch.truncated":
    "Showing the first {shown} of {total}. Narrow the period or filter by department to see the rest.",
  "admin.movement.watch.openRecord": "Open employee record",

  // ── Watchlist: probation confirmations ────────────────────────────────────
  "admin.movement.probation.title": "Probation confirmations due",
  "admin.movement.probation.hint":
    "Confirmation due on or before {to} with no confirmation recorded. The due date is the database's own generated column (joining date + probation months) — it is never calculated here. People who have already left are excluded: confirming a leaver is not work.",
  "admin.movement.probation.col.dueOn": "Confirmation due",
  "admin.movement.probation.col.overdue": "Overdue by",
  "admin.movement.probation.col.joined": "Joined",
  "admin.movement.probation.col.probation": "Probation",
  "admin.movement.probation.months": "{months} months",
  "admin.movement.probation.overdueDays": "{days} days",
  "admin.movement.probation.dueInDays": "in {days} days",
  "admin.movement.probation.dueToday": "today",
  "admin.movement.probation.empty":
    "No confirmation is due in this period. Widen the period to look further ahead.",

  // ── Watchlist: contract expiry ────────────────────────────────────────────
  "admin.movement.contract.title": "Contracts ending",
  "admin.movement.contract.hint":
    "Contract end date between {from} and {to} — the selected period plus {lookahead} days, so a renewal is visible before the last week. Already-exited people are excluded.",
  "admin.movement.contract.col.endsOn": "Contract ends",
  "admin.movement.contract.col.remaining": "Time left",
  "admin.movement.contract.expired": "expired {days} days ago",
  "admin.movement.contract.expiresToday": "today",
  "admin.movement.contract.inDays": "in {days} days",
  "admin.movement.contract.empty":
    "No contract ends in this window. Only employees with a contract end date recorded can appear here.",

  // ── Watchlist: serving notice ─────────────────────────────────────────────
  "admin.movement.notice.title": "Serving notice",
  "admin.movement.notice.hint":
    "A resignation is recorded and the last working day is still ahead of {today}. Notice served is last working day minus resignation date; the shortfall compares that with the notice period on their record.",
  "admin.movement.notice.col.resigned": "Resigned",
  "admin.movement.notice.col.lastDay": "Last working day",
  "admin.movement.notice.col.remaining": "Days left",
  "admin.movement.notice.col.policy": "Notice period",
  "admin.movement.notice.col.served": "Notice served",
  "admin.movement.notice.col.shortfall": "Shortfall",
  "admin.movement.notice.days": "{days} days",
  "admin.movement.notice.shortfallDays": "{days} days short",
  "admin.movement.notice.noShortfall": "Full notice",
  "admin.movement.notice.empty": "Nobody is serving notice with a future last working day.",

  // ── Exits in the period + exit quality ────────────────────────────────────
  "admin.movement.exits.title": "Exits in this period",
  "admin.movement.exits.hint":
    "Last working day between {from} and {to}. Every figure below is over these {exits} exits and nothing else.",
  "admin.movement.exits.col.lastDay": "Last working day",
  "admin.movement.exits.col.type": "Exit type",
  "admin.movement.exits.col.reason": "Reason",
  "admin.movement.exits.col.interview": "Exit interview",
  "admin.movement.exits.col.rehire": "Rehire",
  "admin.movement.exits.col.settlement": "Full & final",
  "admin.movement.exits.empty": "Nobody left in this period.",

  "admin.movement.quality.title": "Exit quality",
  "admin.movement.quality.denominator": "All shares below are of {exits} exits in this period.",
  "admin.movement.quality.typeTitle": "By exit type",
  "admin.movement.quality.typeUnrecorded": "Not recorded",
  "admin.movement.quality.interviewDone": "Exit interviews done",
  "admin.movement.quality.interviewHint": "{done} of {exits} exits. The rest are outstanding.",
  "admin.movement.quality.rehire": "Rehire eligible",
  // The three-state field is the whole point of this string: a nullable boolean
  // means "nobody has ruled", and folding that into "not eligible" would libel
  // people who simply have not been assessed.
  "admin.movement.quality.rehireHint":
    "{yes} eligible · {no} not eligible · {undecided} not yet decided, out of {exits}. Undecided is a real third state on the record, not a no.",
  "admin.movement.quality.settled": "Full & final settled",
  "admin.movement.quality.settledHint": "{settled} of {exits} settled · {pending} still pending.",
  "admin.movement.quality.settlementPending": "Pending",
  "admin.movement.quality.interviewPending": "Not done",
  "admin.movement.quality.rehireYes": "Eligible",
  "admin.movement.quality.rehireNo": "Not eligible",
  "admin.movement.quality.rehireUndecided": "Not decided",

  // ── Provenance, staleness and disagreement ────────────────────────────────
  "admin.movement.asOf":
    "Headcount series from the nightly snapshot {relation}, covering dates up to {through} and last refreshed {refreshed}. The watchlists and the joiner/exit counts are read live.",
  "admin.movement.asOfUnknown":
    "The nightly headcount snapshot returned no refresh stamp, so how current the series is cannot be established.",
  "admin.movement.snapshotBehind":
    "The snapshot only reaches {through}, so the last {days} days of this period are missing from the headcount series and from the attrition denominator. The watchlists below are unaffected — they are read live.",
  "admin.movement.recon.disagree":
    "The snapshot counts {snapshotJoiners} joiners and {snapshotExits} exits; the live employee master counts {liveJoiners} and {liveExits}. The difference is movement recorded since the snapshot was taken — the live figures are the current ones.",
  "admin.movement.basis":
    "Series counted from {relation} over {rows} snapshot rows; watchlists read from {employeeRelation}.",

  // ── Caveats returned by the data layer ────────────────────────────────────
  "admin.movement.caveat.employeeNotInSnapshot":
    "An employee filter is active. The headcount series and the attrition rate are aggregated per department and cannot be narrowed to one person, so they still cover the whole department selection; the watchlists below are narrowed.",
  "admin.movement.caveat.locationNotInSnapshot":
    "A location filter is active. The nightly headcount snapshot carries no location, so the series and the attrition rate ignore it; the watchlists below honour it.",
  "admin.movement.caveat.seriesTruncated":
    "The headcount snapshot read hit its row cap, so the earliest part of the series is present and the rest is missing. Narrow the period or filter by department.",
  "admin.movement.caveat.listTruncated":
    "At least one watchlist hit its row cap. Each table says how many of its rows are shown.",

  // ── Empty and loading ─────────────────────────────────────────────────────
  "admin.movement.empty.title": "No movement in this period",
  "admin.movement.empty.hint":
    "Nobody joined or left between these dates, and nothing is on a watchlist. Widen the period, or clear a filter.",
} as const;
