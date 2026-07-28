/**
 * i18n keys owned EXCLUSIVELY by the analytics export engine (src/lib/exportReport.ts).
 *
 * One file per author, spread into `en` — `t()` is typed on `keyof typeof en`, so
 * concurrent appends to the 10k-line en.ts silently lose keys (297 were lost once).
 *
 * These strings end up in a FILE somebody prints and carries into a meeting, not on
 * a screen they can re-filter. That is why the period and the active filters have
 * labels of their own rather than being folded into a subtitle: a report page with
 * no stated period is indistinguishable from a wrong one.
 */
export const keysAnalytics = {
  // Report heading — the label column of the block that opens every export.
  "analytics.export.meta.report": "Report",
  "analytics.export.meta.scope": "Scope",
  "analytics.export.meta.period": "Period",
  "analytics.export.meta.rows": "Rows",
  "analytics.export.meta.generated": "Generated",

  // Period labels. A day, a month and a year are self-describing once formatted,
  // so only the two-ended spans need a joining word.
  "analytics.export.period.week": "Week of {from} – {to}",
  "analytics.export.period.range": "{from} – {to}",
  "analytics.export.period.year": "Year {year}",

  // Active dimensions. Absent dimensions are stated once, positively, rather than
  // left out — "no filters" and "filters we forgot to print" look identical on paper.
  "analytics.export.filter.none": "None — all departments, locations and people",
  "analytics.export.filter.filters": "Filters",
  "analytics.export.filter.department": "Department",
  "analytics.export.filter.location": "Location",
  "analytics.export.filter.employee": "Employee",
  "analytics.export.filter.source": "Punch source",

  // `public.punch_source`, in the client's words rather than the enum's.
  "analytics.export.source.web": "Web",
  "analytics.export.source.kiosk_face": "Gate tablet (face)",
  "analytics.export.source.mobile": "Mobile",
  "analytics.export.source.import": "Imported",
  "analytics.export.source.manual": "Entered by hand",

  // An empty report is a finding, not a failure — it must print as one.
  "analytics.export.noRows": "No rows matched this period and filter.",

  "analytics.export.page": "Page {page} of {pages}",

  // ---------------------------------------------------------------------------
  // Data-layer provenance (src/features/admin/api/analytics.api.ts).
  //
  // Not chart labels. Every string below is a CAVEAT the data layer discovered
  // while answering a question, and it exists because of the repo rule that a
  // displayed number must be traceable: if a figure was summed in the browser,
  // computed over a truncated row set, or filtered by department NAME because
  // the day view carries no department id, the screen must be able to say so.
  // `AnalyticsProvenance.caveats` returns these keys; the screen renders them.
  // ---------------------------------------------------------------------------
  "analytics.provenance.serverCounted":
    "Counted by the database over exactly the rows this figure opens.",
  "analytics.provenance.clientAggregated":
    "Totalled in this browser from {rows} day records read from the attendance view. The day records are the database's — nothing here is estimated.",

  "analytics.caveat.truncated":
    "This period holds more than {cap} day records, so these figures cover only the first {cap}, earliest dates first. Narrow the period, the department or the employee for a complete answer.",
  "analytics.caveat.sourceNotApplicable":
    "The punch-source filter does not apply here. It selects individual scans, and this view holds one row per employee per day, so the day figures ignore it.",
  "analytics.caveat.departmentAmbiguous":
    "More than one active department is named “{name}”. The day view records the department name, not its id, so these figures cover every department with that name.",
  "analytics.caveat.locationAmbiguous":
    "More than one active location is named “{name}”. The day view records the location name, not its id, so these figures cover every location with that name.",
  "analytics.caveat.departmentUnknown":
    "That department could not be found, so nothing is shown — rather than showing the whole organisation under one department's heading.",
  "analytics.caveat.locationUnknown":
    "That location could not be found, so nothing is shown — rather than showing every location under one location's heading.",

  "analytics.label.unassignedDepartment": "No department",
  "analytics.label.unassignedLocation": "No location",

  // ---------------------------------------------------------------------------
  // The shared filter bar (src/features/admin/components/AnalyticsFilterBar.tsx).
  //
  // Two wordings here are deliberate rather than obvious:
  //  * "Captured via", not "Source". `attendance_punches.source` is a column
  //    name; the person reading this bar wants to know whether a punch came off
  //    the gate tablet or a browser.
  //  * The reset button names the period it jumps to ("This month", "Ending
  //    today") instead of a generic "Reset", which on a custom range is
  //    genuinely ambiguous — clear it, or move it?
  // ---------------------------------------------------------------------------
  "analytics.filter.region": "Analytics filters",

  "analytics.filter.granularity": "View by",
  "analytics.filter.granularity.day": "Day",
  "analytics.filter.granularity.week": "Week",
  "analytics.filter.granularity.month": "Month",
  "analytics.filter.granularity.year": "Year",
  "analytics.filter.granularity.range": "Custom range",

  "analytics.filter.unit.day": "day",
  "analytics.filter.unit.week": "week",
  "analytics.filter.unit.month": "month",
  "analytics.filter.unit.year": "year",
  "analytics.filter.unit.range": "range",

  "analytics.filter.previous": "Previous {unit}",
  "analytics.filter.next": "Next {unit}",
  "analytics.filter.noFuture": "Nothing has been recorded after today.",

  "analytics.filter.reset.day": "Today",
  "analytics.filter.reset.week": "This week",
  "analytics.filter.reset.month": "This month",
  "analytics.filter.reset.year": "This year",
  "analytics.filter.reset.range": "Ending today",

  "analytics.filter.from": "From",
  "analytics.filter.to": "To",

  "analytics.filter.department": "Department",
  "analytics.filter.allDepartments": "All departments",
  "analytics.filter.location": "Location",
  "analytics.filter.allLocations": "All locations",
  "analytics.filter.source": "Captured via",
  "analytics.filter.source.all": "Any method",
  // Shown for an id the dropdown's own list does not hold — an archived
  // department, or a link shared before the list finished loading. The filter IS
  // applied; the control has to say so rather than reading "All departments".
  "analytics.filter.unlisted": "Selected — not in this list",

  "analytics.filter.activeOne": "1 filter active",
  "analytics.filter.activeMany": "{count} filters active",
  "analytics.filter.clear": "Clear filters",
  "analytics.filter.clearHint":
    "Removes the department, location, employee and capture-method filters. The dates stay exactly as they are.",
  "analytics.filter.employeeOne": "One employee",
  "analytics.filter.employeeRemove": "Remove the employee filter: {name}",

  // ---------------------------------------------------------------------------
  // The drill-down chain: /admin/analytics/employees → …/:employeeCode.
  //
  // Two wordings are load-bearing rather than stylistic:
  //  * "In office", not "Span". `gross_span_minutes` is first scan to last scan
  //    with breaks INSIDE it, and the client asked for "average time being in
  //    office" as a figure distinct from worked time. Calling both "worked" is
  //    how two different numbers end up looking like a bug.
  //  * Every average names its denominator in the hint, because averaging worked
  //    minutes over weekly offs and absences is what produces "average day 4h
  //    10m" for a team that never works less than eight hours.
  // ---------------------------------------------------------------------------
  "admin.analytics.export.csv": "Export CSV",
  "admin.analytics.export.pdf": "Export PDF",
  "admin.analytics.export.busy": "Preparing…",
  "admin.analytics.export.failed":
    "The file could not be produced, so nothing was downloaded. Try again, or narrow the period.",
  "admin.analytics.export.nothing": "Nothing to export in this period.",

  "admin.analytics.emp.title": "Employee analytics",
  "admin.analytics.emp.subtitle": "One row per employee for {period}.",
  "admin.analytics.emp.back": "All analytics",
  "admin.analytics.emp.intro":
    "Open any row for that person's averages, their day-by-day trend and every day in the period. The filters above travel with the click.",

  "admin.analytics.emp.tile.people": "People",
  "admin.analytics.emp.tile.peopleHint": "Employees with at least one computed day in this period.",
  "admin.analytics.emp.tile.attended": "Days attended",
  "admin.analytics.emp.tile.attendedHint": "Employee-days with at least one surviving scan.",
  "admin.analytics.emp.tile.worked": "Average worked",
  "admin.analytics.emp.tile.workedHint": "Per complete day, across everyone in scope.",
  "admin.analytics.emp.tile.late": "Late days",
  "admin.analytics.emp.tile.lateHint": "Employee-days the engine marked a late arrival.",
  "admin.analytics.emp.explainer.count":
    "Counted from the {rows} day records this period returned — not estimated, not sampled.",
  "admin.analytics.emp.explainer.mean":
    "Worked minutes added up over {n} complete days and divided by {n}. Weekly offs, holidays and absences are excluded so they cannot drag it down, and so is a day with a single scan — the engine records no leaving time for one, so its zero is a gap and not a short day.",

  "admin.analytics.emp.col.employee": "Employee",
  /** The export needs name and code in SEPARATE columns; `PersonCell` never glues them. */
  "admin.analytics.emp.col.code": "Employee code",
  "admin.analytics.emp.col.department": "Department",
  "admin.analytics.emp.col.attended": "Attended",
  "admin.analytics.emp.col.avgWorked": "Avg worked",
  "admin.analytics.emp.col.avgInOffice": "Avg in office",
  "admin.analytics.emp.col.avgBreak": "Avg break",
  "admin.analytics.emp.col.late": "Late days",
  "admin.analytics.emp.col.avgLate": "Avg late by",
  "admin.analytics.emp.col.absent": "Absent",
  "admin.analytics.emp.col.leave": "Leave",
  "admin.analytics.emp.col.overtime": "Overtime",
  "admin.analytics.emp.col.flagged": "Flagged",

  "admin.analytics.emp.drill": "Open the attendance detail for {name}",
  "admin.analytics.emp.empty.title": "No computed days in this period",
  "admin.analytics.emp.empty.hint":
    "The attendance engine has produced nothing for these dates and filters. Step the period back, or clear a filter.",
  "admin.analytics.emp.export.title": "Employee attendance — period breakdown",
  "admin.analytics.emp.export.file": "employee-analytics",
  "admin.analytics.emp.footnote":
    "Every per-day figure — worked minutes, lateness, overtime, the status — is the attendance engine's. This screen groups those day records by employee and averages them; it derives nothing else.",

  "admin.analytics.person.back": "Employee analytics",
  "admin.analytics.person.unknown": "Employee",
  "admin.analytics.person.subtitle": "{code} · {period}",

  "admin.analytics.person.tile.firstIn": "Average first scan",
  "admin.analytics.person.tile.firstInHint": "Mean arrival over the days with a scan.",
  "admin.analytics.person.tile.lastOut": "Average last scan",
  "admin.analytics.person.tile.lastOutHint": "Mean departure. A night shift reads past midnight.",
  "admin.analytics.person.tile.worked": "Average worked",
  "admin.analytics.person.tile.workedHint": "Per attended day, breaks excluded.",
  "admin.analytics.person.tile.inOffice": "Average in office",
  "admin.analytics.person.tile.inOfficeHint": "First scan to last scan, breaks included.",
  "admin.analytics.person.tile.break": "Average break",
  "admin.analytics.person.tile.breakHint": "Per attended day.",
  "admin.analytics.person.tile.attended": "Days attended",
  "admin.analytics.person.tile.attendedHint": "Of {working} working days in this period.",
  "admin.analytics.person.tile.late": "Late days",
  "admin.analytics.person.tile.lateHint": "Late by {avg} on average, on those days.",
  "admin.analytics.person.tile.earlyExit": "Early exits",
  "admin.analytics.person.tile.earlyExitHint": "{total} early in total.",
  "admin.analytics.person.tile.overtime": "Overtime",
  "admin.analytics.person.tile.overtimeHint": "{approved} of it approved.",
  "admin.analytics.person.tile.leave": "Leave days",
  "admin.analytics.person.tile.leaveHint": "Half days count as 0.5.",
  "admin.analytics.person.tile.absent": "Absent days",
  "admin.analytics.person.tile.absentHint": "Days the engine settled as an absence.",
  "admin.analytics.person.tile.flagged": "Flagged days",
  "admin.analytics.person.tile.flaggedHint": "Days carrying an anomaly, such as a single scan.",

  // Three denominators, not one: a day with a single scan has an arrival time, no
  // leaving time, and a duration the engine writes as zero. One sentence covering
  // all three would be wrong on two of them.
  "admin.analytics.person.denominator.complete":
    "Averaged over {n} complete days — days with both a first and a last scan. Offs, holidays and absences are excluded, and so is a day with a single scan: no leaving time was recorded, so its zero would be a gap counted as a short day.",
  "admin.analytics.person.denominator.firstIn":
    "Averaged over the {n} days that carry a first scan. Offs, holidays and absences have none and are excluded.",
  "admin.analytics.person.denominator.lastOut":
    "Averaged over the {n} days that carry a last scan. A day with a single scan has no leaving time and is excluded.",
  "admin.analytics.person.denominator.late": "Averaged over {n} late days only, never over the punctual ones.",
  "admin.analytics.person.denominator.none": "No day in this period carries this measure, so there is no average.",
  "admin.analytics.person.formula.count": "Counted from this employee's {rows} day records in the period.",

  "admin.analytics.person.trend.title": "Worked time, day by day",
  "admin.analytics.person.trend.series": "Worked",
  "admin.analytics.person.trend.caption":
    "One point per IST date. A break in the line is a date with no computed day record — not a day of zero work.",
  "admin.analytics.person.trend.empty.title": "Nothing to plot yet",
  "admin.analytics.person.trend.empty.hint": "No day in this period has been computed for this employee.",

  "admin.analytics.person.leave.title": "Leave taken, by type",
  "admin.analytics.person.leave.col.type": "Leave type",
  "admin.analytics.person.leave.col.days": "Days",
  "admin.analytics.person.leave.col.occasions": "Occasions",
  "admin.analytics.person.leave.none": "No leave in this period.",

  "admin.analytics.person.capture.title": "How the scans were captured",
  "admin.analytics.person.capture.hint":
    "Counted over individual scans, not days, and voided scans are excluded. This is the one place the capture method can be answered — the day records hold no punch source.",
  "admin.analytics.person.capture.col.method": "Captured via",
  "admin.analytics.person.capture.col.scans": "Scans",
  "admin.analytics.person.capture.col.share": "Share",
  "admin.analytics.person.capture.total": "All scans",
  "admin.analytics.person.capture.none": "No scans in this period.",

  "admin.analytics.person.days.title": "Every day in the period",
  "admin.analytics.person.col.date": "Date",
  "admin.analytics.person.col.status": "Status",
  "admin.analytics.person.col.in": "First in",
  "admin.analytics.person.col.out": "Last out",
  "admin.analytics.person.col.worked": "Worked",
  "admin.analytics.person.col.inOffice": "In office",
  "admin.analytics.person.col.break": "Break",
  "admin.analytics.person.col.late": "Late by",
  "admin.analytics.person.col.overtime": "Overtime",
  "admin.analytics.person.col.leaveType": "Leave",
  "admin.analytics.person.col.flags": "Flagged",
  "admin.analytics.person.onTime": "On time",
  "admin.analytics.person.flagged": "Yes",

  "admin.analytics.person.empty.title": "No computed days for this employee",
  "admin.analytics.person.empty.hint":
    "Nothing has been computed for these dates. Step the period back, or check that this person was employed then.",
  "admin.analytics.person.export.title": "{name} — attendance detail",
  "admin.analytics.person.export.file": "employee-attendance",
  "admin.analytics.person.footnote":
    "The day figures are the attendance engine's. The averages on this screen are those days added up and divided by the denominator each tile names.",

  // ---------------------------------------------------------------------------
  // /admin/analytics — the dashboard. The landing surface, so the wording carries
  // more weight here than anywhere else in the catalogue:
  //
  //  * Every measure names its DENOMINATOR. "Average worked 7:50" over what? An
  //    average that hides its denominator is how a two-day department outranks a
  //    whole floor.
  //  * Nothing says "0" where the honest answer is "we do not know". The tiles
  //    print an em dash and the reason instead.
  //  * The captions say what a click DOES, because a chart that silently refiles
  //    the whole page is alarming the first time and unfindable the second.
  // ---------------------------------------------------------------------------
  "admin.analytics.dash.subtitle": "{period} · {scope}",
  "admin.analytics.dash.scope.all": "whole organisation",
  "admin.analytics.dash.intro":
    "Every tile, bar and slice below is computed over the filters above and carries them into whatever it opens. Figures come from the attendance engine's day records — one row per employee per IST day — added up in this browser, because no deployed view rolls that grain up over an arbitrary period.",

  // The live band. It reads a relation pinned to `util.ist_today()` and to every
  // employee the viewer may see, so it answers a different question from the rest
  // of the page and the caption says so rather than letting the reader assume the
  // filters applied.
  "admin.analytics.dash.live.title": "Right now",
  "admin.analytics.dash.live.caption":
    "Today, across everybody you can see. This band deliberately ignores the filters above: the live board is pinned to today, and a tile narrowed by a filter its own count did not apply would disagree with the list it opens.",
  "admin.analytics.dash.live.yetToReachHint": "Expected, and still inside their grace period.",
  "admin.analytics.dash.live.lateHint": "Scanned in after the grace period had passed.",
  "admin.analytics.dash.live.offHint": "On leave, a weekly off or a holiday today.",

  // Headline tiles.
  "admin.analytics.dash.tile.presentNow": "In today",
  "admin.analytics.dash.tile.presentNowHint": "Of {onRoll} on the board right now.",
  "admin.analytics.dash.tile.presentNowDrill": "Open the live board",
  "admin.analytics.dash.tile.presentNowFormula":
    "The live board's own flags, counted. Postgres decided each one against that employee's shift and grace period; this tile counts the trues.",
  "admin.analytics.dash.tile.presentNowNumbers":
    "{attended} of {onRoll} employees on the board have a surviving scan today. It answers “right now”, not the period above.",

  "admin.analytics.dash.tile.people": "People in view",
  "admin.analytics.dash.tile.peopleHint": "Employees with at least one computed day here.",
  "admin.analytics.dash.tile.peopleDrill": "Open the workforce analytics",

  "admin.analytics.dash.tile.worked": "Average worked",
  "admin.analytics.dash.tile.workedHint": "Per attended day, breaks excluded.",
  "admin.analytics.dash.tile.workedDrill": "Open attendance analytics",

  "admin.analytics.dash.tile.late": "Late arrivals",
  "admin.analytics.dash.tile.lateHint": "Late by {avg} on average, on those days.",
  "admin.analytics.dash.tile.lateNone": "No late arrival in this period.",
  "admin.analytics.dash.tile.lateDrill": "Open the late days",

  "admin.analytics.dash.tile.absent": "Absences",
  "admin.analytics.dash.tile.absentHint": "Of {working} working days in scope.",
  "admin.analytics.dash.tile.absentDrill": "Open the absent days",

  "admin.analytics.dash.tile.overtime": "Overtime",
  "admin.analytics.dash.tile.overtimeHint": "{approved} of it approved.",
  "admin.analytics.dash.tile.overtimeDrill": "Open the day records behind it",

  "admin.analytics.dash.tile.flagged": "Flagged days",
  "admin.analytics.dash.tile.flaggedHint": "Days carrying an anomaly, such as a single scan.",
  "admin.analytics.dash.tile.flaggedDrill": "Open the flagged days",

  "admin.analytics.dash.explainer.count":
    "Counted from the {rows} day records this period returned. Nothing is estimated or sampled — each record is the engine's.",
  "admin.analytics.dash.explainer.mean":
    "Added up over {n} attended days — days with at least one surviving scan — and divided by {n}. Weekly offs, holidays and absences are excluded so they cannot drag it down.",
  "admin.analytics.dash.explainer.none":
    "No day in this period carries this measure, so there is no figure to show.",

  // Charts.
  "admin.analytics.dash.trend.title": "Attendance, day by day",
  "admin.analytics.dash.trend.caption":
    "One point per IST date. A break in a line is a date with no computed day record — not a day on which nobody worked. Click any day to narrow the whole page to it.",
  "admin.analytics.dash.trend.xHeader": "Date",
  "admin.analytics.dash.trend.present": "Present",
  "admin.analytics.dash.trend.absent": "Absent",
  "admin.analytics.dash.trend.leave": "On leave",
  "admin.analytics.dash.trend.late": "Late",
  "admin.analytics.dash.trend.select": "Narrow the whole page to {name}",

  "admin.analytics.dash.dept.title": "Departments compared",
  "admin.analytics.dash.dept.caption":
    "Mean worked minutes per attended day, so a small department is not flattered by its size. A department with no scan in the period has no average and shows no bar. Click one to narrow the whole page to it.",
  "admin.analytics.dash.dept.xHeader": "Department",
  "admin.analytics.dash.dept.measure": "Average worked",
  "admin.analytics.dash.dept.context": "Attended days",
  "admin.analytics.dash.dept.select": "Narrow the whole page to {name}",
  "admin.analytics.dash.dept.one":
    "One department is in scope, so there is nothing to compare it with. Clear the department filter to see the rest.",

  "admin.analytics.dash.status.title": "How the days settled",
  "admin.analytics.dash.status.centre": "employee-days",
  "admin.analytics.dash.status.value": "Days",
  "admin.analytics.dash.status.hint": "Choose a slice to open the days behind it.",
  "admin.analytics.dash.status.drill": "Open the {label} days",
  "admin.analytics.dash.status.grouped":
    "“{label}” covers several statuses, and the day records screen filters one at a time — so there is no single list this slice can open.",
  "admin.analytics.dash.class.present": "Present",
  "admin.analytics.dash.class.leave": "On leave",
  "admin.analytics.dash.class.weeklyOff": "Weekly off",
  "admin.analytics.dash.class.holiday": "Holiday",
  "admin.analytics.dash.class.absent": "Absent",
  "admin.analytics.dash.class.notCounted": "Outside employment",
  "admin.analytics.dash.class.pending": "Not processed yet",

  "admin.analytics.dash.arrival.title": "When people arrive",
  "admin.analytics.dash.arrival.xHeader": "First scan",
  "admin.analytics.dash.arrival.measure": "Days",
  "admin.analytics.dash.arrival.caption":
    "{scanned} day records counted by the IST hour of their first scan; average arrival {avg}. {unscanned} records had no scan at all — an absence, an off or a day the engine has not processed — and are left out rather than counted as midnight.",
  "admin.analytics.dash.arrival.empty":
    "No day in this period carries a first scan, so there is no arrival pattern to draw.",

  // Sections and states.
  "admin.analytics.dash.empty.title": "No computed days in this period",
  "admin.analytics.dash.empty.hint":
    "The attendance engine has produced nothing for these dates and filters. Step the period back, or clear a filter.",
  "admin.analytics.dash.dir.title": "Every analytics screen",
  "admin.analytics.dash.dir.hint":
    "Whole-organisation counts, each opening the screen that owns it. They are deliberately NOT narrowed by the filters above: those screens do not read this filter yet, and a tile whose number disagrees with the list it opens is worse than one that states its scope.",

  // Export.
  "admin.analytics.dash.export.title": "Attendance day records",
  "admin.analytics.dash.export.file": "attendance-analytics",
  "admin.analytics.dash.col.date": "Date",
  "admin.analytics.dash.col.employee": "Employee",
  "admin.analytics.dash.col.code": "Employee code",
  "admin.analytics.dash.col.department": "Department",
  "admin.analytics.dash.col.location": "Location",
  "admin.analytics.dash.col.status": "Status",
  "admin.analytics.dash.col.in": "First in",
  "admin.analytics.dash.col.out": "Last out",
  "admin.analytics.dash.col.worked": "Worked",
  "admin.analytics.dash.col.late": "Late by",
  "admin.analytics.dash.col.overtime": "Overtime",
  "admin.analytics.dash.col.flagged": "Flagged",
} as const;
