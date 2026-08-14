/**
 * i18n keys owned EXCLUSIVELY by the team-extra screens.
 *
 * Split out of en.ts deliberately: `t()` is typed on `keyof typeof en`, so every
 * new screen must add keys, and when several authors append to one 10k-line file
 * concurrently the last writer silently wins — that is how 297 keys were lost
 * once already. One file per author, spread into `en`, removes the race.
 *
 * The two screens here are the manager's reportee profile
 * (`/team/people/:employeeCode` — specifically the sections migration 055's two
 * allow-list views made possible) and `/team/performance`. Anything the existing
 * `team.*` catalogue already words correctly is REUSED from en.ts rather than
 * reworded here: a second wording for the same fact is a second thing to keep
 * true.
 */
export const keysTeamExtra = {
  // ---------------------------------------------------------------------------
  // /team/people/:employeeCode — the scan log (v_team_punches)
  // ---------------------------------------------------------------------------
  "teamExtra.reportee.scans.title": "Recent scans at the gate",
  "teamExtra.reportee.scans.desc":
    "Every scan filed against the last {days} business days — {from} to {to} — newest first. Voided scans are shown and struck through, never hidden.",
  "teamExtra.reportee.scans.count": "{n} scans",
  "teamExtra.reportee.scans.partial": "the scan total",
  "teamExtra.reportee.scans.col.date": "Business date",
  "teamExtra.reportee.scans.col.time": "IST time",
  "teamExtra.reportee.scans.col.direction": "Gate said",
  "teamExtra.reportee.scans.col.method": "Captured by",
  "teamExtra.reportee.scans.col.gate": "Device",
  "teamExtra.reportee.scans.col.flags": "Notes",
  "teamExtra.reportee.scans.flag.voided": "Voided",
  "teamExtra.reportee.scans.flag.voidedWhy": "Voided — {reason}",
  "teamExtra.reportee.scans.flag.review": "Flagged for review",
  "teamExtra.reportee.scans.flag.carried": "Scanned on {date}, filed under the shift's day",
  "teamExtra.reportee.scans.empty.title": "No scans in these seven days",
  "teamExtra.reportee.scans.empty.hint":
    "A week of weekly offs, approved leave, or a gate this person never reached all look the same here. The day rows on Team attendance say which of those it was.",
  "teamExtra.reportee.scans.notice":
    "The scan photo, the device location and the face-match score are not on this screen because they are not in the view a manager reads. You are meant to know when your reportee scanned, not to hold their biometric telemetry.",
  "teamExtra.reportee.openAttendance": "Open Team attendance",

  // ---------------------------------------------------------------------------
  // /team/people/:employeeCode — additional details (v_team_custom_fields)
  // ---------------------------------------------------------------------------
  "teamExtra.reportee.custom.title": "Additional details",
  "teamExtra.reportee.custom.desc":
    "Venue-specific fields the organisation defined for its own records — uniform, transport and the like.",
  "teamExtra.reportee.custom.updated": "Recorded {when}",
  "teamExtra.reportee.custom.notCarried":
    "Held as a list or an attached document, which this view does not carry",
  "teamExtra.reportee.custom.empty.title": "Nothing here for you to read",
  "teamExtra.reportee.custom.empty.hint":
    "Either no additional field is recorded against this person, or every one that is has been marked as personal data — the server withholds those from a manager, so an empty list is not proof the record is blank.",
  "teamExtra.reportee.custom.notice":
    "Fields marked as personal data are excluded by the view itself, not hidden by this page. Ask HR if you need one of them for a decision.",
  "teamExtra.reportee.notice.elsewhere":
    "Attendance days, leave and balances for this person live on Team attendance and Team leave, each reading its own server view. A summary invented here could disagree with them, so there isn't one.",

  // ---------------------------------------------------------------------------
  // /team/performance — header, period and scope
  // ---------------------------------------------------------------------------
  "teamExtra.perf.title": "Performance",
  "teamExtra.perf.subtitle.plain": "The review-period record for your reportees.",
  "teamExtra.perf.subtitle.period":
    "{n} reportees · {from} to {to}, aggregated by the database in one pass",
  "teamExtra.perf.window.1m": "This month",
  "teamExtra.perf.window.3m": "3 months",
  "teamExtra.perf.window.6m": "6 months",
  "teamExtra.perf.window.12m": "12 months",
  "teamExtra.perf.noRecord.title": "This login has no employee record",
  "teamExtra.perf.noRecord.hint":
    "Reportees hang off an employee row, so there is no team to review from here. If that looks wrong, HR owns the reporting line.",
  "teamExtra.perf.noTeam.title": "Nobody reports to you right now",
  "teamExtra.perf.noTeam.hint":
    "Managership is derived from the reporting lines rather than granted, so this screen fills in the moment somebody is assigned to you.",
  "teamExtra.perf.openAttendance": "Open Team attendance",

  // Period tiles — each a server count over the same predicate /team/attendance uses
  "teamExtra.perf.tile.late": "Late arrivals",
  "teamExtra.perf.tile.lateHint": "Day rows the engine marked late in this period.",
  "teamExtra.perf.tile.earlyExit": "Early exits",
  "teamExtra.perf.tile.earlyExitHint": "Days where the last scan came before the shift ended.",
  "teamExtra.perf.tile.absent": "Absences",
  "teamExtra.perf.tile.absentHint": "Working days the engine recorded as absent.",
  "teamExtra.perf.tile.exceptions": "Days with an anomaly",
  "teamExtra.perf.tile.exceptionsHint": "Days carrying at least one anomaly flag.",
  "teamExtra.perf.tile.onProbation": "On probation",
  "teamExtra.perf.tile.onProbationHint": "Reportees whose employment status is still probation.",
  "teamExtra.perf.tile.dueSoon": "Confirmation due soon",
  "teamExtra.perf.tile.dueSoonHint": "Probation ending within the next 30 days.",
  "teamExtra.perf.tile.overdue": "Confirmation overdue",
  "teamExtra.perf.tile.overdueHint": "Probation whose confirmation date has already passed.",
  "teamExtra.perf.tile.unreadable": "This count could not be read just now.",

  // ---------------------------------------------------------------------------
  // /team/performance — the scorecard
  // ---------------------------------------------------------------------------
  "teamExtra.perf.scorecard.title": "Review-period record",
  "teamExtra.perf.scorecard.desc":
    "One row per reportee for {from} to {to}. Open a row for the whole metric dictionary behind it.",
  "teamExtra.perf.scorecard.hint":
    "Every figure is a column of the server's period summary for this exact window — nothing on this screen is summed, divided or averaged in your browser.",
  "teamExtra.perf.scorecard.noRecord":
    "{n} of these reportees have no computed day in this period, so their figures read as unknown rather than zero. The attendance engine writes one day row per person per date; a period before somebody joined has none.",
  "teamExtra.perf.scorecard.empty.title": "No reportees to score",
  "teamExtra.perf.scorecard.empty.hint":
    "The reporting closure returned nobody for you. It is refreshed on a schedule, so a change made minutes ago may not be in it yet.",
  "teamExtra.perf.col.employee": "Reportee",
  "teamExtra.perf.col.workingDays": "Working",
  "teamExtra.perf.col.present": "Present",
  "teamExtra.perf.col.paid": "Paid",
  "teamExtra.perf.col.absent": "Absent",
  "teamExtra.perf.col.leave": "Leave",
  "teamExtra.perf.col.late": "Late",
  "teamExtra.perf.col.latePct": "Late %",
  "teamExtra.perf.col.earlyExit": "Early out",
  "teamExtra.perf.col.avgWorked": "Avg / day",
  "teamExtra.perf.col.overtime": "OT approved / recorded",
  "teamExtra.perf.col.department": "Department",
  "teamExtra.perf.col.joined": "Joined",
  "teamExtra.perf.col.confirmationDue": "Confirmation due",
  "teamExtra.perf.col.status": "Status",

  // ---------------------------------------------------------------------------
  // /team/performance — one reportee's record
  // ---------------------------------------------------------------------------
  "teamExtra.perf.detail.pick":
    "Pick a reportee above to read their whole period record — every metric the attendance engine holds for them, and the employment facts a manager may see.",
  "teamExtra.perf.detail.title": "{name} — this period",
  "teamExtra.perf.detail.desc":
    "{from} to {to}, {days} calendar days, as the server counted them.",
  "teamExtra.perf.detail.descNoRecord":
    "The attendance engine has no day for this person in this period.",
  "teamExtra.perf.detail.openProfile": "Open profile",
  "teamExtra.perf.detail.empty.title": "Nothing computed for this period",
  "teamExtra.perf.detail.empty.hint":
    "Try a longer period, or check the day rows on Team attendance. A day the engine never wrote is not an absent one.",

  "teamExtra.perf.field.workingDays": "Working days",
  "teamExtra.perf.field.workingDaysHint": "Days the engine treated as expected working days.",
  "teamExtra.perf.field.present": "Present days",
  "teamExtra.perf.field.halfDays": "Half days",
  "teamExtra.perf.field.absent": "Absent days",
  "teamExtra.perf.field.pending": "Not yet computed",
  "teamExtra.perf.field.pendingHint":
    "Days with a row the engine has not finished. Kept separate from absents on purpose.",
  "teamExtra.perf.field.weeklyOff": "Weekly offs",
  "teamExtra.perf.field.holidays": "Holidays",
  "teamExtra.perf.field.leave": "Leave days",
  "teamExtra.perf.field.compOff": "Comp-off availed",
  "teamExtra.perf.field.paid": "Paid days",
  "teamExtra.perf.field.paidHint": "Half days and leave fractions already applied by the server.",
  "teamExtra.perf.field.attendancePct": "Attendance %",
  "teamExtra.perf.field.attendancePctHint":
    "Paid days ÷ every calendar day in the window: {paid} of {total}. Weekly offs and holidays are in that denominator, so this is not a presence rate.",
  "teamExtra.perf.field.latePct": "Late %",
  "teamExtra.perf.field.latePctHint":
    "Late days ÷ working days, computed and clamped by the server.",
  "teamExtra.perf.field.lateDays": "Late arrivals",
  "teamExtra.perf.field.earlyExit": "Early exits",
  "teamExtra.perf.field.lateDeduction": "Leave deducted for lateness",
  "teamExtra.perf.field.lateDeductionHint":
    "Days the late-coming policy converted into leave. Set by the engine, never by this screen.",
  "teamExtra.perf.field.worked": "Total worked",
  "teamExtra.perf.field.avgWorkingDay": "Average per working day",
  "teamExtra.perf.field.avgWorkingDayHint":
    "Averaged by the database over the working days it decided were working days.",
  "teamExtra.perf.field.avgPresentDay": "Average per day scanned",
  "teamExtra.perf.field.avgPresentDayHint": "Over the days with at least one scan.",
  "teamExtra.perf.field.overtime": "Overtime",
  "teamExtra.perf.field.overtimeHint":
    "Approved first, recorded second. The gap is unapproved overtime — read it, don't subtract it.",
  "teamExtra.perf.field.extraWork": "Extra work",
  "teamExtra.perf.field.extraWorkHint":
    "Time beyond the shift that a comp-off credit can come from.",
  "teamExtra.perf.field.breaks": "Breaks",
  "teamExtra.perf.field.breaksHint": "Unpaid break time the engine removed from worked hours.",
  "teamExtra.perf.field.employmentStatus": "Employment status",
  "teamExtra.perf.field.employmentType": "Employment type",
  "teamExtra.perf.field.joined": "Joined",
  "teamExtra.perf.field.probation": "Probation",
  "teamExtra.perf.field.confirmationDue": "Confirmation due",
  "teamExtra.perf.field.confirmationDueHint": "HR decides the confirmation; you recommend it.",
  "teamExtra.perf.field.otEligible": "Overtime eligibility",
  "teamExtra.perf.field.otEligibleHint": "Set by the designation, not by this screen.",

  "teamExtra.perf.value.overtime": "{approved} of {recorded}",
  "teamExtra.perf.value.lateDays": "{days} · {time}",
  "teamExtra.perf.value.breaks": "{time} · {n} breaks",
  "teamExtra.perf.value.onProbation": "On probation",
  "teamExtra.perf.value.confirmed": "Not on probation",
  "teamExtra.perf.value.otEligible": "Eligible for overtime",
  "teamExtra.perf.value.notOtEligible": "Not eligible for overtime",

  // ---------------------------------------------------------------------------
  // /team/performance — confirmation duties, and the honest gaps
  // ---------------------------------------------------------------------------
  "teamExtra.perf.confirm.title": "Confirmation decisions",
  "teamExtra.perf.confirm.desc":
    "Reportees still on probation, soonest due first. A recommendation unlocks {days} days before the date, and HR makes the decision.",
  "teamExtra.perf.confirm.partial": "the probation counts",
  "teamExtra.perf.confirm.empty.title": "No reportee is on probation",
  "teamExtra.perf.confirm.empty.hint":
    "Everybody reporting to you has been confirmed or sits on another employment status, so there is no confirmation for you to recommend today.",
  "teamExtra.perf.confirm.notice":
    "The recommendation form is not on this screen: this database has no table to record one in, and a form that dropped what you typed would be worse than none. Until it lands, send your recommendation to HR with the dates above.",
  // ── /me/performance ─────────────────────────────────────────────────────────
  "me.perf.title": "My review",
  "me.perf.subtitle": "What your manager wrote about your work, once they have shared it.",
  "me.perf.empty.title": "Nothing has been shared with you yet",
  "me.perf.empty.hint":
    "A review appears here the moment your manager shares it. Until then there may be one being written that you cannot see.",
  "me.perf.whenVisible":
    "A review is only shown here once your manager has shared it. Before that it is a draft, and a draft rating read halfway through is not what anybody decided.",
  "me.perf.overall": "Overall {n} out of {max}",
  "me.perf.sharedAt": "Shared with you on {at}",
  "me.perf.managerWords": "What your manager wrote",
  "me.perf.youSaid": "you said {n}",
  "me.perf.theySaid": "they said {n}",
  "me.perf.ackLabel": "Anything you want on the record",
  "me.perf.ackHint":
    "Optional. Acknowledging means you have read this — not that you agree with it. Whatever you write is kept with the review.",
  "me.perf.ack": "I have read this",
  "me.perf.acking": "Recording…",
  "me.perf.ackDone": "Recorded",
  "me.perf.ackDoneDetail": "Your manager can see that you have read it, along with anything you wrote.",
  "me.perf.acknowledgedAt": "You recorded reading this on {at}.",

  // ── The appraisal cycle (043900) ────────────────────────────────────────────
  "teamExtra.appr.title": "Review",
  "teamExtra.appr.hint":
    "The judgement you make about somebody, in words and a rating. The attendance figures above are evidence for the conversation — nothing here is calculated from them.",
  "teamExtra.appr.pickCycle": "Which cycle",
  "teamExtra.appr.period": "Reviewing {from} to {to}",
  "teamExtra.appr.noCycle.title": "No review cycle is open",
  "teamExtra.appr.noCycle.hint":
    "HR opens a cycle for a period once that period has finished. Until then there is nothing to review against.",
  "teamExtra.appr.none.title": "Nobody to review in this cycle",
  "teamExtra.appr.none.hint":
    "A cycle covers people who were employed at the end of the period. If somebody is missing, their reporting line may have been empty when it opened.",
  "teamExtra.appr.review": "Write the review",
  "teamExtra.appr.close": "Close",
  "teamExtra.appr.noSelf": "No self-assessment yet",
  "teamExtra.appr.selfIn": "Self-assessment in on {at}",
  "teamExtra.appr.self": "They said {n}",
  "teamExtra.appr.theirWords": "In their own words",
  "teamExtra.appr.rate": "Rate {label} as {n} out of 5",
  "teamExtra.appr.overall": "Overall",
  "teamExtra.appr.overallHint":
    "Your own answer, not an average of the lines above. Somebody strong at the job and difficult with colleagues is not a 3.",
  "teamExtra.appr.overallRate": "Overall {n} out of 5",
  "teamExtra.appr.comment": "What you would say to them",
  "teamExtra.appr.commentHint":
    "At least {n} characters. This is what they will read, and what you will be asked about later — a number on its own is unusable in the meeting it is for.",
  "teamExtra.appr.submit": "Submit the review",
  "teamExtra.appr.submitting": "Submitting…",
  "teamExtra.appr.blocked": "Give an overall rating and write a few sentences before submitting.",
  "teamExtra.appr.share": "Share it with them",
  "teamExtra.appr.sharedAt": "Shared on {at}",
  "teamExtra.appr.unknownPerson": "Somebody who has left your team",
  "teamExtra.appr.status.notStarted": "Not started",
  "teamExtra.appr.status.selfDone": "Self-assessment in",
  "teamExtra.appr.status.reviewed": "Reviewed, not shared",
  "teamExtra.appr.status.shared": "Shared",
  "teamExtra.appr.status.acknowledged": "Acknowledged",

  "teamExtra.perf.evidence":
    "The figures above are the attendance record the engine computed — evidence for a review, not a score. No rating below is calculated from them, and nothing multiplies the two together.",
  "teamExtra.perf.footnote.oneSource":
    "Every figure comes from the one period-summary function the payslip and the month views also read, called once for this exact window. That is why a quarter here agrees with the three months on Team analytics.",
  "teamExtra.perf.footnote.excludesMe":
    "Your own record is not in these numbers — the reporting closure only looks downward, and your own month is on My attendance.",
} as const;
