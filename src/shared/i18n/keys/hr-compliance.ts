/**
 * i18n keys owned EXCLUSIVELY by the Compliance & Operations panel —
 * `components/CompliancePanel.tsx`, `api/hr-compliance.api.ts` (the caveat keys)
 * and `hrComplianceAggregate.ts`.
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`,
 * so two people appending to one catalogue silently lose each other's keys.
 *
 * MOST OF THE COPY HERE IS LOAD-BEARING. A compliance panel fails not by showing
 * a wrong pixel but by showing a plausible number nobody can trace, so the hints
 * on this screen do three specific jobs and are not decoration:
 *
 *   1. THEY NAME THE DENOMINATOR. "62.5%" is unfalsifiable; "134 of 214 required
 *      documents" can be checked against the list underneath it.
 *   2. THEY NAME THE POPULATION. Statutory applicability is counted over the
 *      people on payroll and biometric stamps over the people on the gate, and
 *      those are different numbers on the same screen.
 *   3. THEY ADMIT WHAT THE DATA CANNOT SAY. There is no biometric coverage
 *      percentage, no pooled p95 and no organisation-wide pending-approval
 *      count, because no deployed relation supports one — and each of those
 *      absences is written out rather than filled with an approximation.
 */
export const keysHrCompliance = {
  // ── Panel chrome ──────────────────────────────────────────────────────────
  "admin.hrcomp.title": "Compliance & operations",
  "admin.hrcomp.subtitle":
    "Where the paperwork, the gate, the approvals and the kit actually stand. Every figure names the rows it was counted over.",

  // ── Caveats emitted by hr-compliance.api.ts ───────────────────────────────
  // These are the sentences behind `AnalyticsProvenance.caveats`. A filter the
  // data physically cannot honour is said out loud; silently dropping it is how
  // whole-venue numbers end up printed under one department's heading.
  "admin.hrcomp.caveat.snapshotNotPeriod":
    "This section is a snapshot of right now. It has no date column, so the period on the filter bar does not narrow it.",
  "admin.hrcomp.caveat.noDepartment":
    "The department filter is not applied here — this relation carries no department, so narrowing it would have to match on a renameable label.",
  "admin.hrcomp.caveat.noLocation":
    "The location filter is not applied here — this relation carries no location.",
  "admin.hrcomp.caveat.noEmployee":
    "The employee filter is not applied here — this relation is not per employee.",
  "admin.hrcomp.caveat.noSource":
    "The capture-source filter is not applied anywhere on this panel. Punch source is recorded per scan, and nothing here is at scan grain.",
  "admin.hrcomp.caveat.truncated":
    "The read stopped at its {cap}-row cap, so the breakdown below describes part of the set. The headline counts came from the database and are still complete.",
  "admin.hrcomp.caveat.gapRowsOnly":
    "This list holds gaps only — a fully enrolled employee is not a row in it. It can count who is blocked, and it cannot produce a coverage percentage.",
  "admin.hrcomp.caveat.gateDevicesSeenOnly":
    "Only devices that logged at least one attempt in this period appear. A tablet that was switched off has no row here at all.",
  "admin.hrcomp.caveat.slaAllTime":
    "Approval SLA figures cover every decision ever recorded. The view carries no date column, so the period on the filter bar cannot narrow them.",
  "admin.hrcomp.caveat.ownQueueOnly":
    "This is your own approval queue. The database scopes it to you by design and publishes no organisation-wide equivalent.",
  "admin.hrcomp.caveat.stampNotTemplate":
    "The enrolment stamps below are dates on the employee record. Whether the gate will actually recognise someone is the separate consent-and-template test above, and the two can disagree.",
  "admin.hrcomp.caveat.holderIdsCapped":
    "More asset holders than one lookup can resolve. The unresolved ones are marked unknown rather than assumed to be still employed.",

  // ── Headline ──────────────────────────────────────────────────────────────
  "admin.hrcomp.headline": "Where compliance stands",
  "admin.hrcomp.kpi.docComplete": "Documents in order",
  "admin.hrcomp.kpi.docCompleteHint":
    "{valid} of {total} required employee-document pairs are on file and in date. A person with no document at all is counted as missing, never as zero.",
  "admin.hrcomp.kpi.docExpiring": "Expiring soon",
  "admin.hrcomp.kpi.docExpiringHint":
    "Documents that lapse within {days} days. The window is the database's, not this screen's. This is the action list.",
  "admin.hrcomp.kpi.docMissing": "Never supplied",
  "admin.hrcomp.kpi.docMissingHint":
    "A required document with nothing on file at all. Counted over the same {total} employee-document pairs as the tile on the left, so the four counts add up to it.",
  "admin.hrcomp.kpi.docExpired": "Already expired",
  "admin.hrcomp.kpi.docExpiredHint":
    "Past its expiry date and still required. This is a breach rather than a deadline, which is why it is counted apart from the lapsing list below.",
  "admin.hrcomp.kpi.policyRate": "Policies acknowledged",
  "admin.hrcomp.kpi.policyRateHint":
    "{ack} of {assigned} policy assignments. Pooled across people, so a policy given to two people cannot outweigh one given to two hundred.",
  "admin.hrcomp.kpi.gateBlocked": "Blocked at the gate",
  "admin.hrcomp.kpi.gateBlockedHint":
    "People with no consent or no active face template, so the gate cannot identify them. Withdrawn consents are counted separately and are nobody's to chase.",
  // The gap list is bucketed in the browser from a capped page, so when the cap
  // bites this tile is a FLOOR. Said on the tile itself, because the whole queue
  // size sits one line below it and a reader comparing the two deserves the reason.
  "admin.hrcomp.kpi.gateBlockedPartial":
    "Counted over {scanned} of {total} gap rows the database holds — the read was capped, so this is at least this many, not exactly.",
  "admin.hrcomp.kpi.slaBreaches": "Approval SLA breaches",
  "admin.hrcomp.kpi.slaBreachesHint":
    "{breached} of {decided} decisions were made after their deadline, over all time. Volume on its own says nothing about whether anyone was kept waiting.",
  "admin.hrcomp.kpi.exceptions": "Open exceptions",
  "admin.hrcomp.kpi.exceptionsHint":
    "Everything the engine has flagged and nobody has cleared: punches to review, anomalies, missing bank accounts, expired documents, offline gates.",
  "admin.hrcomp.kpi.assetsExited": "Kit with leavers",
  "admin.hrcomp.kpi.assetsExitedHint":
    "Assets still booked out to people who have exited, retired or absconded. Matched by employee id against the employee record.",
  "admin.hrcomp.kpi.ownOverdue": "Your overdue approvals",
  "admin.hrcomp.kpi.ownOverdueHint":
    "{overdue} of your {pending} pending decisions are past their deadline. The database decides what is late, on its own clock.",

  // ── Documents ─────────────────────────────────────────────────────────────
  "admin.hrcomp.doc.title": "Documents lapsing next",
  "admin.hrcomp.doc.caption":
    "Soonest expiry first — the order the work gets done in. Already-expired documents are a breach rather than a deadline and have their own tile above.",
  "admin.hrcomp.doc.col.person": "Person",
  "admin.hrcomp.doc.col.department": "Department",
  "admin.hrcomp.doc.col.document": "Document",
  "admin.hrcomp.doc.col.expires": "Expires",
  "admin.hrcomp.doc.col.status": "Status",
  // No `doc.status.*` labels here on purpose. `compliance_status` is a server enum
  // that four other screens already render through `documents/labels.COMPLIANCE_CHIP`,
  // and a chip needs a TONE as well as a word — inventing a second spelling of
  // "expiring_soon" on this panel is exactly the drift D-10 exists to stop.
  "admin.hrcomp.doc.empty.title": "Nothing lapses in the next {days} days",
  "admin.hrcomp.doc.empty.hint":
    "No required document expires inside the window. Check the missing and expired tiles above — those need work of a different kind.",
  "admin.hrcomp.doc.drift":
    "{n} required-document rows fall into none of the four statuses this panel knows about. The view has grown a case this screen was not told about; the tiles below it under-count by that many.",

  // ── Policies ──────────────────────────────────────────────────────────────
  "admin.hrcomp.pol.title": "Policy acknowledgement",
  "admin.hrcomp.pol.rate": "Acknowledged",
  "admin.hrcomp.pol.rateHint":
    "Pooled over {assigned} assignments across {policies} policies.",
  "admin.hrcomp.pol.meanPolicy": "Average per policy",
  "admin.hrcomp.pol.meanPolicyHint":
    "The mean of each policy's own acknowledged share, over {policies} policies that have at least one assignee. Shown beside the pooled figure on purpose: when the two disagree, a heavily-assigned policy is dragging one of them.",
  "admin.hrcomp.pol.outstanding": "Still owed",
  "admin.hrcomp.pol.outstandingHint":
    "Assigned, neither acknowledged nor waived. A waiver is a decision, not an omission.",
  "admin.hrcomp.pol.overdue": "Past due",
  "admin.hrcomp.pol.overdueHint":
    "Assignments the database itself has marked overdue. Its clock decides what is late, not this browser.",
  "admin.hrcomp.pol.worstTitle": "Least acknowledged policies",
  "admin.hrcomp.pol.worstCaption":
    "Lowest acknowledged share first. Policies with nobody assigned have no share and sort last — they are not at 0%.",
  "admin.hrcomp.pol.col.policy": "Policy",
  "admin.hrcomp.pol.col.assigned": "Assigned",
  "admin.hrcomp.pol.col.acknowledged": "Acknowledged",
  "admin.hrcomp.pol.col.share": "Share",
  "admin.hrcomp.pol.col.overdue": "Past due",
  "admin.hrcomp.pol.col.due": "Earliest due",
  "admin.hrcomp.pol.openTitle": "Who has not acknowledged",
  "admin.hrcomp.pol.openCaption":
    "One row per person per policy, soonest deadline first. Names are resolved from the employee directory — the assignment table stores only the id.",
  "admin.hrcomp.pol.col.person": "Person",
  "admin.hrcomp.pol.col.state": "State",
  "admin.hrcomp.pol.col.opened": "Opened",
  "admin.hrcomp.pol.opened.yes": "Opened",
  "admin.hrcomp.pol.opened.no": "Never opened",
  "admin.hrcomp.pol.empty.title": "No policy needs acknowledging",
  "admin.hrcomp.pol.empty.hint":
    "No document is marked as requiring an acknowledgement, or none is visible to you.",
  "admin.hrcomp.pol.openEmpty.title": "Everyone is up to date",
  "admin.hrcomp.pol.openEmpty.hint": "Every assigned policy has been acknowledged or waived.",

  // ── Biometric coverage ────────────────────────────────────────────────────
  "admin.hrcomp.bio.title": "Who cannot use the gate",
  "admin.hrcomp.bio.chartTitle": "Why the gate cannot identify them",
  "admin.hrcomp.bio.chartCaption":
    "The reason is the database's own classification, not this screen's. A withdrawn consent is a lawful choice and is shown for completeness, never as a problem to chase.",
  "admin.hrcomp.bio.series": "People",
  "admin.hrcomp.bio.gap.no_consent": "No consent on file",
  "admin.hrcomp.bio.gap.consented_not_enrolled": "Consented, not enrolled",
  "admin.hrcomp.bio.gap.consent_withdrawn": "Consent withdrawn",
  "admin.hrcomp.bio.gap.unclassified": "Reason not classified",
  "admin.hrcomp.bio.chaseable": "To enrol",
  "admin.hrcomp.bio.chaseableHint":
    "No consent, or consented but never enrolled. These are the people to book in.",
  "admin.hrcomp.bio.withdrawn": "Withdrawn",
  "admin.hrcomp.bio.withdrawnHint":
    "Consent withdrawn. They use the alternative punch method and are never chased for this.",
  "admin.hrcomp.bio.col.person": "Person",
  "admin.hrcomp.bio.col.department": "Department",
  "admin.hrcomp.bio.col.reason": "Reason",
  "admin.hrcomp.bio.col.joined": "Joined",
  "admin.hrcomp.bio.empty.title": "Everybody can use the gate",
  "admin.hrcomp.bio.empty.hint":
    "No active, attendance-tracked employee is missing a consent or a face template.",

  // ── Gate health ───────────────────────────────────────────────────────────
  "admin.hrcomp.gate.title": "Gate health",
  "admin.hrcomp.gate.matchRate": "Match rate",
  "admin.hrcomp.gate.matchRateHint":
    "{matched} of {attempts} identification attempts matched, pooled across every device-day in the period. Not an average of the daily percentages — a tablet with four attempts would move that as much as one with four hundred.",
  "admin.hrcomp.gate.p95": "Worst p95 latency",
  "admin.hrcomp.gate.p95Hint":
    "The highest single device-day p95 in the period, observed on {device} on {date}. There is no p95 of the whole window: percentiles do not pool, and the raw latency series is not readable from here.",
  "admin.hrcomp.gate.p95None":
    "No device-day in this period reported a p95 latency, so there is no worst one to name.",
  "admin.hrcomp.gate.meanP95": "Mean device-day p95",
  "admin.hrcomp.gate.meanP95Hint":
    "The mean of the per-device-day p95 column, over {n} device-days that reported one. It is a summary of a column of percentiles — not the period's p95.",
  "admin.hrcomp.gate.meanP50": "Mean device-day p50",
  "admin.hrcomp.gate.meanP50Hint": "The mean of the per-device-day median, over {n} device-days.",
  "admin.hrcomp.gate.replays": "Offline replays",
  "admin.hrcomp.gate.replaysHint":
    "Punches a tablet buffered while it had no network and sent later. Summed over {n} device-days.",
  "admin.hrcomp.gate.devices": "Devices seen",
  "admin.hrcomp.gate.devicesHint":
    "{devices} devices across {deviceDays} device-days. A device that logged nothing in this period does not appear.",
  "admin.hrcomp.gate.worstTitle": "Worst device-days",
  "admin.hrcomp.gate.worstCaption":
    "Lowest match rate first. The attempt count is shown beside every rate because a rate without its denominator ranks the tablet nobody used.",
  "admin.hrcomp.gate.col.device": "Device",
  "admin.hrcomp.gate.col.date": "Date",
  "admin.hrcomp.gate.col.attempts": "Attempts",
  "admin.hrcomp.gate.col.matched": "Matched",
  "admin.hrcomp.gate.col.rate": "Match rate",
  "admin.hrcomp.gate.col.p95": "p95",
  "admin.hrcomp.gate.lowVolume":
    "{n} device-days saw fewer than {min} attempts and are left out of the ranking. At that volume one miss is a large percentage and would top the list every time.",
  "admin.hrcomp.gate.inactive":
    "{n} of the devices below are marked inactive but still logged attempts in this period.",
  "admin.hrcomp.gate.empty.title": "No identification attempts in this period",
  "admin.hrcomp.gate.empty.hint":
    "No gate tablet logged a face match between these dates. Widen the period, or check that the devices are online.",

  // ── Approval SLA ──────────────────────────────────────────────────────────
  "admin.hrcomp.sla.title": "Approval SLA breaches",
  "admin.hrcomp.sla.breached": "Late decisions",
  "admin.hrcomp.sla.breachedHint":
    "Decisions recorded after the request's deadline. This is the measure — a queue can be busy and perfectly on time.",
  "admin.hrcomp.sla.rate": "Breach rate",
  "admin.hrcomp.sla.rateHint": "{breached} of {decided} decisions, pooled over approvers.",
  "admin.hrcomp.sla.approvers": "Approvers late",
  "admin.hrcomp.sla.approversHint":
    "{breaching} of {approvers} people who have decided anything have breached at least once.",
  "admin.hrcomp.sla.hours": "Time to decide",
  "admin.hrcomp.sla.hoursHint":
    "The mean over all {n} decisions, weighted by how many each approver made — not an average of averages, which would let two decisions outweigh two hundred.",
  "admin.hrcomp.sla.worstTitle": "Where the delay is",
  "admin.hrcomp.sla.worstCaption":
    "Most breaches first, then the largest share of their own workload. Both columns are shown: three late out of four is a different problem from three out of three hundred.",
  "admin.hrcomp.sla.col.approver": "Approver",
  "admin.hrcomp.sla.col.type": "Request type",
  "admin.hrcomp.sla.col.decided": "Decided",
  "admin.hrcomp.sla.col.breached": "Late",
  "admin.hrcomp.sla.col.onTime": "On time",
  "admin.hrcomp.sla.col.avgHours": "Avg hours",
  "admin.hrcomp.sla.byTypeTitle": "Late decisions by request type",
  "admin.hrcomp.sla.byTypeCaption":
    "The same breaches rolled up to the request type — this is how you tell a slow person from a slow process.",
  "admin.hrcomp.sla.series": "Late decisions",
  "admin.hrcomp.sla.empty.title": "No decisions recorded yet",
  "admin.hrcomp.sla.empty.hint":
    "Nobody has approved or rejected a request that you can see, so there is no SLA record to report.",
  "admin.hrcomp.sla.clean.title": "No SLA breach on record",
  "admin.hrcomp.sla.clean.hint":
    "All {decided} recorded decisions were made inside their deadline.",

  // ── Exceptions ────────────────────────────────────────────────────────────
  "admin.hrcomp.exc.title": "Open exceptions",
  "admin.hrcomp.exc.critical": "Critical",
  // Severity is bucketed in the browser from the capped page, so unlike the total
  // beside it this one is a FLOOR whenever the read came back full. Said on the
  // tile, because the two numbers sit next to each other and invite comparison.
  "admin.hrcomp.exc.criticalHint":
    "Counted over the {scanned} rows the breakdown was computed from. Severity is not something the database totalled, so when the read is capped this is at least this many.",
  "admin.hrcomp.exc.warning": "Warning",
  "admin.hrcomp.exc.info": "Information",
  "admin.hrcomp.exc.unclassified": "Unclassified",
  "admin.hrcomp.exc.total": "Total open",
  "admin.hrcomp.exc.totalHint":
    "Counted by the database over the whole queue, so it keeps rising even when the breakdown below is capped.",
  "admin.hrcomp.exc.people": "People involved",
  "admin.hrcomp.exc.peopleHint":
    "Distinct employees named by an exception in the rows read. Some kinds — an offline gate — name no employee at all.",
  "admin.hrcomp.exc.severityTitle": "By severity",
  "admin.hrcomp.exc.col.kind": "Kind",
  "admin.hrcomp.exc.byKindTitle": "What is going wrong",
  "admin.hrcomp.exc.byKindCaption":
    "Open exceptions by kind, biggest first. Each is a row in the queue the morning list works through.",
  "admin.hrcomp.exc.series": "Exceptions",
  "admin.hrcomp.exc.sample":
    "The breakdown was computed over {scanned} of {total} open exceptions. The totals above came from the database and are complete.",
  // No `exc.kind.*` labels here either. `command-vocab.alertKindLabel()` already
  // names every `v_exception_queue.exception_kind` for the alert feed AND humanises
  // a kind it does not know — which is precisely the case `groupExceptions` warns
  // about when the view unions a ninth branch. Two catalogues for one enum would
  // let the same row read differently on two screens.
  "admin.hrcomp.exc.empty.title": "The queue is clear",
  "admin.hrcomp.exc.empty.hint": "Nothing is flagged and waiting. This is the state to aim for.",

  // ── Statutory coverage ────────────────────────────────────────────────────
  "admin.hrcomp.stat.title": "Statutory coverage",
  "admin.hrcomp.stat.caption":
    "Counted over the {n} people on payroll — anybody excluded from payroll has no statutory story and is left out of the denominator entirely.",
  "admin.hrcomp.stat.flag.pf": "Provident fund",
  "admin.hrcomp.stat.flag.esi": "ESI",
  "admin.hrcomp.stat.flag.pt": "Professional tax",
  "admin.hrcomp.stat.flag.lwf": "Labour welfare fund",
  "admin.hrcomp.stat.col.head": "Deduction",
  "admin.hrcomp.stat.col.applicable": "Applicable",
  "admin.hrcomp.stat.col.notApplicable": "Not applicable",
  "admin.hrcomp.stat.col.notRecorded": "Not recorded",
  "admin.hrcomp.stat.col.share": "Share",
  "admin.hrcomp.stat.notRecorded":
    "{n} people on payroll have no statutory record at all. They are excluded from every share above, because “we never filed it” is not the same finding as “it does not apply”.",
  "admin.hrcomp.stat.regimeTitle": "Tax regime",
  "admin.hrcomp.stat.regime.old": "Old regime",
  "admin.hrcomp.stat.regime.new": "New regime",
  "admin.hrcomp.stat.regime.not_recorded": "Not recorded",
  // The ring's centre carries the denominator, never a percentage — the slices
  // are already the proportions, and what a reader cannot infer from them is
  // what they are a proportion OF.
  "admin.hrcomp.stat.regimeCentre": "on payroll",
  "admin.hrcomp.stat.regimeCaption":
    "One slice per declared regime, over the same payroll population as the table beside it. “Not recorded” is a slice rather than a gap — it is the count with no statutory record at all.",

  // ── Profile completeness ──────────────────────────────────────────────────
  "admin.hrcomp.comp.title": "Profile completeness",
  "admin.hrcomp.comp.chartCaption":
    "How complete each employee record is, across all {n} people in scope. The score is computed by the database when the row is saved.",
  "admin.hrcomp.comp.series": "People",
  "admin.hrcomp.comp.col.band": "Completeness band",
  "admin.hrcomp.comp.band.under50": "Under 50%",
  "admin.hrcomp.comp.band.b50to74": "50–74%",
  "admin.hrcomp.comp.band.b75to89": "75–89%",
  "admin.hrcomp.comp.band.b90to99": "90–99%",
  "admin.hrcomp.comp.band.complete": "Complete",
  "admin.hrcomp.comp.band.not_recorded": "Not scored",
  "admin.hrcomp.comp.mean": "Average completeness",
  "admin.hrcomp.comp.meanHint":
    "Mean over {n} records that carry a score. A record with no score is not averaged in as a zero.",
  "admin.hrcomp.comp.done": "Fully complete",
  "admin.hrcomp.comp.doneHint": "{n} of {total} records need nothing further.",

  // ── Biometric enrolment stamps ────────────────────────────────────────────
  "admin.hrcomp.stamp.title": "Enrolment on record",
  "admin.hrcomp.stamp.face": "Face enrolled",
  "admin.hrcomp.stamp.fingerprint": "Fingerprint enrolled",
  "admin.hrcomp.stamp.none": "Neither",
  "admin.hrcomp.stamp.hint":
    "Dates stamped on the employee record, across the {n} people the gate applies to. Whether the gate will actually recognise someone is the consent-and-template test above; a withdrawn consent leaves this stamp behind.",

  // ── Asset custody ─────────────────────────────────────────────────────────
  "admin.hrcomp.asset.title": "Asset custody",
  "admin.hrcomp.asset.open": "Out on loan",
  "admin.hrcomp.asset.openHint": "Open allocations, counted by the database.",
  "admin.hrcomp.asset.overdue": "Return overdue",
  "admin.hrcomp.asset.overdueHint":
    "Past the expected return date. The database decides that, not this screen.",
  "admin.hrcomp.asset.exited": "Held by leavers",
  "admin.hrcomp.asset.exitedHint":
    "The holder has exited, retired or absconded. Absconded counts here on purpose — it is the most urgent version of this finding, not a milder one.",
  "admin.hrcomp.asset.unknown": "Holder unknown",
  "admin.hrcomp.asset.unknownHint":
    "The holder is outside your admin scope, so their employment status could not be read. Counted separately rather than assumed to be still employed.",
  "admin.hrcomp.asset.findingTitle": "Kit still booked out to people who have left",
  "admin.hrcomp.asset.findingCaption":
    "The custody view carries no employment status, so each holder's id was looked up on the employee record. A holder your scope cannot see is marked unknown, never current.",
  "admin.hrcomp.asset.col.asset": "Asset",
  "admin.hrcomp.asset.col.holder": "Holder",
  "admin.hrcomp.asset.col.department": "Department",
  "admin.hrcomp.asset.col.state": "Holder state",
  "admin.hrcomp.asset.col.days": "Days held",
  "admin.hrcomp.asset.col.lastDay": "Last working day",
  "admin.hrcomp.asset.verdict.current": "Employed",
  "admin.hrcomp.asset.verdict.exited": "Left",
  "admin.hrcomp.asset.verdict.unknown": "Unknown",
  "admin.hrcomp.asset.clean.title": "Nothing is held by a leaver",
  "admin.hrcomp.asset.clean.hint":
    "Every open allocation belongs to somebody still employed, as far as your scope can see.",
  "admin.hrcomp.asset.empty.title": "Nothing is out on loan",
  "admin.hrcomp.asset.empty.hint": "No asset is currently allocated to anybody.",

  // ── The workforce read behind statutory / completeness / stamps ───────────
  // One relation feeds three blocks, so it gets one empty state rather than
  // three that each read as a separate outage.
  "admin.hrcomp.wf.empty.title": "Nobody is in scope",
  "admin.hrcomp.wf.empty.hint":
    "No active employee matches these filters, so there is no statutory, completeness or enrolment figure to report. Widen the department or location.",

  // ── Shared ────────────────────────────────────────────────────────────────
  "admin.hrcomp.ofTotal": "{n} of {d}",
  "admin.hrcomp.unassigned": "Unassigned",
  // The accessible name of a chart bar's drill-through. `RankedBarsChart` offers
  // every bar as a real <button> in its table fallback, and a button whose only
  // name is a number is unusable with a screen reader.
  "admin.hrcomp.drill": "Open {name}",
  // Appended to a chart's caption when buckets were left off the figure. A top-N
  // that does not say it is a top-N is the same defect class as a capped read that
  // looks complete — the reader believes they are seeing the whole distribution.
  "admin.hrcomp.bars.more": "Showing the {shown} largest of {total}.",
  "admin.hrcomp.basis": "Counted from {relation} · {rows} rows read.",
  "admin.hrcomp.partial":
    "Showing {scanned} of {total}. The read was capped; the total came from the database.",
} as const;
