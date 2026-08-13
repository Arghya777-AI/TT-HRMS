/**
 * i18n keys owned EXCLUSIVELY by the admin-changequeue work. One file per author — `t()` is
 * typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Screen: /admin/people/changes — the HR/admin maker-checker queue over
 * `employee_change_requests`.
 */
export const keysAdminChangequeue = {
  // Cross-link from the section landing (/admin/people) — the rail only carries
  // section landings, so a sibling screen needs a door on the one above it.
  "admin.chq.navFromDirectory": "Change requests",

  // Header ------------------------------------------------------------------
  "admin.chq.title": "Change Requests",
  "admin.chq.subtitle":
    "{n} waiting on a decision — the value on the record beside the value that was asked for.",
  "admin.chq.subtitlePlain":
    "Every field change an employee has proposed, with the value on the record beside it.",

  // Triage tiles ------------------------------------------------------------
  "admin.chq.mix.title": "What the backlog is made of",
  "admin.chq.mix.hint":
    "Only requests still needing something. One waiting on approval needs a decision, one waiting on manual entry has already been agreed, and a failed one is broken — three different people fix these.",
  "admin.chq.mix.total": "{n} request(s) outstanding — applied and rejected ones are not counted",
  "admin.chq.tile.pending": "Waiting",
  "admin.chq.tile.pendingHint": "Proposed changes nobody has decided yet.",
  "admin.chq.tile.pendingDrill": "Open the requests still waiting",
  "admin.chq.tile.pendingSource": "change requests still marked waiting",
  "admin.chq.tile.sensitive": "Sensitive",
  "admin.chq.tile.sensitiveHint": "Waiting requests flagged as sensitive when submitted.",
  "admin.chq.tile.sensitiveDrill": "Open the sensitive requests still waiting",
  "admin.chq.tile.sensitiveSource": "waiting change requests marked sensitive",
  "admin.chq.tile.manual": "Approved, not written",
  "admin.chq.tile.manualHint": "Approved, but the server could not write the field.",
  "admin.chq.tile.manualDrill": "Open the approvals awaiting a manual entry",
  "admin.chq.tile.manualSource": "approved change requests with no applied timestamp",
  "admin.chq.tile.failed": "Apply failed",
  "admin.chq.tile.failedHint": "The write was attempted and the database refused it.",
  "admin.chq.tile.failedDrill": "Open the requests whose apply failed",
  "admin.chq.tile.failedSource": "change requests the applier marked failed",

  // Filters -----------------------------------------------------------------
  "admin.chq.filter.view": "Show",
  "admin.chq.view.pending": "Waiting on a decision",
  "admin.chq.view.awaitingEntry": "Approved, not written",
  "admin.chq.view.failed": "Apply failed",
  "admin.chq.view.decided": "Already decided",
  "admin.chq.view.all": "Everything",
  "admin.chq.filter.table": "Part of the record",
  "admin.chq.filter.anyTable": "Any part of the record",
  "admin.chq.filter.sensitivity": "Sensitivity",
  "admin.chq.sensitivity.any": "Every field",
  "admin.chq.sensitivity.only": "Sensitive fields only",
  "admin.chq.filter.clear": "Clear filters",
  "admin.chq.matching": "{n} matching",
  "admin.chq.matchingUnknown": "Counting…",
  "admin.chq.cap": "Showing the {n} oldest matching requests. Narrow the filters to reach the rest.",

  // Which part of the record a request targets (ck_ecr__entity_table) --------
  "admin.chq.table.employees": "Employee record",
  "admin.chq.table.addresses": "Address",
  "admin.chq.table.contacts": "Contact",
  "admin.chq.table.dependents": "Dependent",
  "admin.chq.table.qualifications": "Qualification",
  "admin.chq.table.identityDocuments": "Identity document",
  "admin.chq.table.statutory": "Statutory details",
  "admin.chq.table.bankAccounts": "Bank account",
  "admin.chq.table.customFields": "Custom field",

  // Status vocabulary -------------------------------------------------------
  "admin.chq.status.draft": "Draft",
  "admin.chq.status.pending": "Waiting",
  "admin.chq.status.inProgress": "In progress",
  "admin.chq.status.approved": "Approved",
  "admin.chq.status.rejected": "Rejected",
  "admin.chq.status.cancelled": "Cancelled",
  "admin.chq.status.withdrawn": "Withdrawn",
  "admin.chq.status.expired": "Expired",
  "admin.chq.status.autoApproved": "Auto-approved",
  "admin.chq.status.escalated": "Escalated",
  "admin.chq.status.applied": "Applied",
  "admin.chq.status.failed": "Apply failed",

  // A row -------------------------------------------------------------------
  "admin.chq.raisedBy": "Asked by {who} · {at}",
  "admin.chq.actorUnknown": "an account outside this admin's view",
  "admin.chq.sensitiveChip": "Sensitive field",
  "admin.chq.effectiveFrom": "Asked to take effect {date}",
  "admin.chq.onRecord": "On the record now",
  "admin.chq.proposed": "Asked for",
  "admin.chq.notSet": "Not set",
  "admin.chq.theirReason": "Their reason",
  "admin.chq.noReason":
    "No sentence came with this request — it was submitted without a workflow note, and this table has no reason column of its own.",
  "admin.chq.decisionComment": "Decision comment",
  "admin.chq.decidedBy": "Decided by {who} · {at}",
  "admin.chq.appliedAt": "Written to the record {at}",
  "admin.chq.applyError": "The write was refused: {error}",
  "admin.chq.openRecord": "Open employee record",

  // The governing approval chain -------------------------------------------
  "admin.chq.chain.open":
    "Governed by approval {number} — {status}, level {level} of {levels}. That chain decides it; this screen will refuse until it closes.",
  "admin.chq.chain.settled": "Approval {number} ended {status}.",
  "admin.chq.chain.inbox": "Open the approval inbox",

  // The applier's structural limit -----------------------------------------
  "admin.chq.manual.warn":
    "Approving this will not write the field: {table} is keyed on the employee alone, so the applier has no row to update. It will be marked approved and someone has to record the value on the employee's record.",

  // Actions -----------------------------------------------------------------
  "admin.chq.approve": "Approve",
  "admin.chq.reject": "Reject",

  // Outcome of a decision ---------------------------------------------------
  "admin.chq.outcome.applied": "{field} is now on {who}'s record.",
  "admin.chq.outcome.approvedNotApplied":
    "{field} approved for {who}. The server did not write it — record it on their {table} yourself.",
  "admin.chq.outcome.failed": "{field} was approved but the write was refused: {error}",
  "admin.chq.outcome.rejected":
    "{field} rejected for {who}. They read your comment on their own record history.",
  "admin.chq.dismiss": "Dismiss",

  // Decision dialog ---------------------------------------------------------
  "admin.chq.dialog.approveTitle": "Approve {field} for {name}",
  "admin.chq.dialog.approveDescription":
    "{from} → {to}. Your sentence is recorded against your name and travels with the change into the audit trail.",
  "admin.chq.dialog.approveConfirm": "Approve and apply",
  "admin.chq.dialog.approveConfirmManual": "Approve without writing",
  "admin.chq.dialog.rejectTitle": "Reject {field} for {name}",
  "admin.chq.dialog.rejectDescription":
    "They asked for {to}. Say what would make the request acceptable — the employee reads this sentence on their record history, and at least ten characters are required.",
  "admin.chq.dialog.rejectConfirm": "Reject the change",

  // Empty states ------------------------------------------------------------
  "admin.chq.empty.pendingTitle": "Nothing waiting",
  "admin.chq.empty.pendingHint":
    "Every proposed change has been decided. New ones land here the moment an employee submits one from their own profile.",
  "admin.chq.empty.title": "Nothing matches these filters",
  "admin.chq.empty.hint": "Widen the view, or clear the field and sensitivity filters.",

  // Footnote ----------------------------------------------------------------
  "admin.chq.footnote":
    "Approving calls apply_change_request in the same transaction as the decision, so “applied” means the employee's record already carries the value. Rejecting needs a comment of at least ten characters. Either way the decision, your reason and the exact before-and-after are written to the audit trail under your name.",
} as const;
