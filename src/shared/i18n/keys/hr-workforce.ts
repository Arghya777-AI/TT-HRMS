/**
 * i18n keys owned EXCLUSIVELY by the Workforce & Org panel —
 * `components/WorkforcePanel.tsx`, `hr-workforce.api.ts` and
 * `hrWorkforceAggregate.ts`.
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`,
 * so two people appending to one catalogue silently lose each other's keys.
 * Prefix `admin.hrwf.` — deliberately distinct from `admin.analytics.wf.`,
 * which belongs to `AnalyticsWorkforce.page.tsx`.
 *
 * A LOT OF THE COPY HERE IS THE PRODUCT. These strings are what stop a reader
 * drawing a conclusion the data does not support:
 *   * `asOf.*` says which single date a headcount describes, because a headcount
 *     over a range is not a thing;
 *   * `definition` explains why this figure can differ from the "on roll" tile
 *     one screen away — two honest definitions, named;
 *   * `kpi.withReporteesHint` and `kpi.roleGrantsHint` keep two populations
 *     apart that every HR dashboard eventually conflates;
 *   * every band and every ring states its denominator;
 *   * `dpdp.*` explains a deliberate absence — no drill-through — rather than
 *     leaving it looking like an unfinished feature.
 *
 * Gender and marital-status VALUE labels are not redefined here: they already
 * exist as `admin.people.gender.*` / `admin.people.marital.*` and the same enum
 * value must read the same on every screen.
 */
export const keysHrWorkforce = {
  // ── Panel frame ───────────────────────────────────────────────────────────
  "admin.hrwf.title": "Workforce & org",
  "admin.hrwf.subtitle":
    "Who is on the roll, how they are distributed, and how the reporting lines are shaped.",

  "admin.hrwf.asOf": "Headcount as at {date}",
  "admin.hrwf.asOfClamped":
    "The selected period has not finished, so this is a snapshot as at today. Counting to the end of the period would include people who have not started.",
  "admin.hrwf.asOfHistorical":
    "This is a past date, reconstructed from today's employee records. Joining and leaving dates are historical, but department, designation, grade and location are as they are NOW — somebody who transferred since {date} is counted where they sit today.",
  "admin.hrwf.definition":
    "On roll means joined on or before this date and not yet left — the same rule the headcount matview uses, so this figure and the trend below agree by construction. The People directory counts by employment status instead, so the two can differ; where they do, the mis-stated rows tile below says by how many.",
  "admin.hrwf.stamp": "Trend as of {at}, covering dates up to {date}.",
  "admin.hrwf.stampUnknown":
    "The headcount matview has never been refreshed, so the trend has no dates to cover yet.",

  // ── Headline tiles ────────────────────────────────────────────────────────
  "admin.hrwf.kpi.headcount": "Headcount",
  "admin.hrwf.kpi.headcountHint": "People on roll on {date}, counted from {rows} employee records.",
  "admin.hrwf.kpi.withReportees": "People with reportees",
  // The trap, named on the tile itself.
  "admin.hrwf.kpi.withReporteesHint":
    "Distinct people named as a reporting manager by somebody in this view. This is NOT the count of manager role grants — that is the tile beside it, and the two measure different things.",
  "admin.hrwf.kpi.roleGrants": "Hold the manager role",
  "admin.hrwf.kpi.roleGrantsHint":
    "Live manager role grants in user_roles, organisation-wide and not narrowed by the filters. Manager status here is derived from reporting lines rather than granted, so zero is the expected reading — not a missing number.",
  "admin.hrwf.kpi.span": "Span of control",
  "admin.hrwf.kpi.spanHint":
    "Headcount ÷ people with reportees. Averaging {mean} reportees per manager — the two differ by the {orphans} people who report to nobody in this view.",
  "admin.hrwf.kpi.widestSpan": "Widest span",
  "admin.hrwf.kpi.widestSpanHint": "Direct reportees carried by {name}.",
  "admin.hrwf.kpi.widestSpanUnknown": "Nobody in this view has a reportee.",
  "admin.hrwf.kpi.wideSpans": "Spans over {threshold}",
  "admin.hrwf.kpi.wideSpansHint":
    "Managers carrying more than {threshold} direct reportees. A wide span is a finding to act on, not a statistic to record.",
  "admin.hrwf.kpi.anomalies": "Mis-stated records",
  "admin.hrwf.kpi.anomaliesHint":
    "Counted as on roll on this date, yet carrying a status that says otherwise — usually an exit recorded without a last working day. Fix these and the two headcounts agree.",

  // ── Breakdown charts ──────────────────────────────────────────────────────
  "admin.hrwf.bars.measure": "People",
  "admin.hrwf.bars.category": "Group",
  "admin.hrwf.bars.department": "Headcount by department",
  "admin.hrwf.bars.departmentCaption":
    "One bar per department, counted from the employee records. Click a bar to narrow the whole panel to that department.",
  "admin.hrwf.bars.location": "Headcount by location",
  "admin.hrwf.bars.locationCaption":
    "One bar per location. Click a bar to narrow the whole panel to that location.",
  "admin.hrwf.bars.designation": "Headcount by designation",
  "admin.hrwf.bars.designationCaption":
    "One bar per designation on the employee record. Not clickable: the shared analytics filter has no designation dimension, and no screen would honour the link.",
  "admin.hrwf.bars.grade": "Headcount by grade",
  "admin.hrwf.bars.gradeCaption":
    "One bar per grade. Not clickable, for the same reason as designation.",
  "admin.hrwf.bars.type": "Headcount by employment type",
  "admin.hrwf.bars.typeCaption":
    "One bar per employment type. Not clickable: the shared analytics filter has no employment-type dimension.",
  "admin.hrwf.bars.drill": "Narrow this panel to {name}",
  "admin.hrwf.bars.more": "Showing the {shown} largest of {total} groups.",
  "admin.hrwf.label.unassigned": "Not assigned",
  "admin.hrwf.label.notRecorded": "Not recorded",

  // ── Tenure ────────────────────────────────────────────────────────────────
  "admin.hrwf.tenure.title": "Tenure",
  "admin.hrwf.tenure.centre": "on roll",
  "admin.hrwf.tenure.caption":
    "Completed service at {date}, from the recorded joining date. Every person on roll has one, so the bands account for all {total}.",
  "admin.hrwf.tenure.band.lt3m": "Under 3 months",
  "admin.hrwf.tenure.band.m3to12": "3–12 months",
  "admin.hrwf.tenure.band.y1to3": "1–3 years",
  "admin.hrwf.tenure.band.y3plus": "3 years and over",

  // ── Age ───────────────────────────────────────────────────────────────────
  "admin.hrwf.age.title": "Age",
  "admin.hrwf.age.centre": "with a date of birth",
  "admin.hrwf.age.caption":
    "Age at {date}, for the {counted} of {total} people whose date of birth is recorded. {excluded} are excluded — a missing birth date is not an age of zero, and folding it in would move every band.",
  "admin.hrwf.age.none":
    "No date of birth is recorded for anybody in this view, so no age distribution can be shown.",
  "admin.hrwf.age.band.lt25": "Under 25",
  "admin.hrwf.age.band.a25to34": "25–34",
  "admin.hrwf.age.band.a35to44": "35–44",
  "admin.hrwf.age.band.a45to54": "45–54",
  "admin.hrwf.age.band.a55plus": "55 and over",

  // ── Span of control ───────────────────────────────────────────────────────
  "admin.hrwf.span.title": "Reporting lines",
  "admin.hrwf.span.hint":
    "Direct reportees counted within the current filters. A manager who sits outside them still appears, carrying only the part of their team this view admits.",
  "admin.hrwf.span.col.manager": "Manager",
  "admin.hrwf.span.col.reportees": "Direct reportees",
  "admin.hrwf.span.col.inScope": "In this view",
  "admin.hrwf.span.inScopeYes": "Counted here",
  "admin.hrwf.span.inScopeOut": "Outside the filters",
  "admin.hrwf.span.unnamed": "Manager record not readable",
  "admin.hrwf.span.wide": "Over {threshold}",
  "admin.hrwf.span.empty.title": "No reporting lines in this view",
  "admin.hrwf.span.empty.hint":
    "Nobody here names a reporting manager. Set reporting lines on the employee records and the span figures become meaningful.",

  // ── Diversity (DPDP) ──────────────────────────────────────────────────────
  "admin.hrwf.div.title": "Workforce composition",
  "admin.hrwf.div.dpdp":
    "Aggregate counts only. Category and disability are special-category personal data under the DPDP Act, so nothing here drills through to named people — deliberately, and unlike every other chart on this panel. Any group of fewer than {min} is withheld, together with a second group, so its size cannot be recovered by subtracting the rest from the headcount.",
  "admin.hrwf.div.gender": "Gender",
  "admin.hrwf.div.category": "Category",
  "admin.hrwf.div.disability": "Differently abled",
  "admin.hrwf.div.nationality": "Nationality",
  "admin.hrwf.div.marital": "Marital status",
  "admin.hrwf.div.withheld": "Withheld",
  "admin.hrwf.div.withheldHint":
    "{people} people across {buckets} groups, each too small to publish on its own.",
  "admin.hrwf.div.allWithheld":
    "Every group here is too small to publish, or would be recoverable from the ones that are. Nothing is shown for this attribute at these filters.",
  "admin.hrwf.div.total": "of {total}",
  "admin.hrwf.div.value.yes": "Yes",
  "admin.hrwf.div.value.no": "No",
  "admin.hrwf.div.category.GEN": "General",
  "admin.hrwf.div.category.OBC": "Other Backward Class",
  "admin.hrwf.div.category.SC": "Scheduled Caste",
  "admin.hrwf.div.category.ST": "Scheduled Tribe",
  "admin.hrwf.div.category.EWS": "Economically Weaker Section",

  // ── Trend ─────────────────────────────────────────────────────────────────
  "admin.hrwf.trend.title": "Headcount over the period",
  "admin.hrwf.trend.caption":
    "One point per day from the headcount matview. Each point is the SUM of that day's department × employment-type rows — the matview has no organisation-wide row to read instead. A day the matview does not cover is drawn as a gap, never as zero.",
  "admin.hrwf.trend.headcount": "On roll",
  "admin.hrwf.trend.flowTitle": "Joiners and leavers",
  "admin.hrwf.trend.flowCaption":
    "Daily joiners and last working days, summed the same way. Plotted apart from the headcount line on purpose: a level and a flow on one axis make the flow invisible.",
  "admin.hrwf.trend.joiners": "Joined",
  "admin.hrwf.trend.exits": "Left",
  "admin.hrwf.trend.date": "Date",
  "admin.hrwf.trend.noLocation":
    "The headcount matview is grouped by date, department and employment type — it has no location column. With a location filter applied there is no honest line to draw, so none is drawn rather than showing the whole organisation under one location's heading.",
  "admin.hrwf.trend.empty.title": "The matview covers none of these dates",
  "admin.hrwf.trend.empty.hint":
    "The nightly refresh has not reached this period, or nobody was employed during it. Pick a period ending on or before the date the stamp below names.",

  // ── Honesty about the read ────────────────────────────────────────────────
  "admin.hrwf.basis":
    "Counted in this browser from {relation} · {rows} employee records read for this view.",
  "admin.hrwf.basisTrend": "Trend counted in this browser from {relation} · {rows} matview rows.",
  "admin.hrwf.empty.title": "Nobody was on roll on this date",
  "admin.hrwf.empty.hint":
    "No employee record has a joining date on or before {date} within these filters. Widen the period, or clear a filter.",

  "admin.hrwf.caveat.truncated":
    "More employee records match than one read can return, so every figure on this panel is understated. Narrow by department or location for a complete answer.",
  "admin.hrwf.caveat.sourceNotApplicable":
    "The capture-method filter does not apply here. Punch source is recorded on a scan; an employee roster has no such thing.",
  "admin.hrwf.caveat.employeeIgnored":
    "An employee filter is set in the address bar and is ignored on this panel — a headcount of one person is not a measure.",
  "admin.hrwf.caveat.asOfClamped":
    "The period ends in the future, so the snapshot was taken as at today.",
  "admin.hrwf.caveat.dimensionsCurrent":
    "A past snapshot uses today's department, designation, grade and location for each person; only the joining and leaving dates are historical.",
  "admin.hrwf.caveat.trendNoLocation":
    "The headcount trend cannot be narrowed by location — the matview has no location column.",
  "admin.hrwf.caveat.roleGrantScope":
    "Manager role grants are organisation-wide; the department and location filters do not narrow them.",
} as const;
