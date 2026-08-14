/**
 * scheduled-reports.ts — strings for /admin/analytics/scheduled.
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`,
 * so two people appending to one catalogue silently lose each other's keys.
 *
 * The wording below is careful about one thing above all: this screen records a
 * decision, it does not send anything. Every sentence that could be read as
 * "and then it emails them" has been written not to be.
 */
export const keysScheduledReports = {
  "admin.asched.reg.title": "Scheduled reports",
  "admin.asched.reg.hint":
    "What should go out, to whom, and how often. Recording a schedule writes the decision down — it does not send anything yet.",
  "admin.asched.reg.empty.title": "Nothing is scheduled",
  "admin.asched.reg.empty.hint":
    "Add one below. Even before delivery is built, a schedule written down here is one that does not live only in somebody's head.",

  "admin.asched.col.name": "Report",
  "admin.asched.col.subject": "What it contains",
  "admin.asched.col.when": "How often",
  "admin.asched.col.recipients": "Recipients",
  "admin.asched.col.lastSent": "Last sent",
  "admin.asched.col.download": "Get it now",
  "admin.asched.dl.now": "Download",
  "admin.asched.dl.working": "Building…",
  "admin.asched.dl.failed": "The file could not be built. Nothing was downloaded.",
  "admin.asched.dl.pii":
    "Payroll reports leave the system through a governed export that records what left and to whom — not through a browser download.",
  "admin.asched.dl.unbuilt": "No renderer for this subject yet.",
  "admin.asched.col.state": "State",

  "admin.asched.never": "Never sent",
  "admin.asched.noRecipients": "Nobody yet",
  "admin.asched.recipients.n": "{n} recipient(s)",
  "admin.asched.state.on": "Enabled",
  "admin.asched.state.off": "Paused",
  "admin.asched.action.pause": "Pause",
  "admin.asched.action.resume": "Resume",

  // ── The standing fact about delivery ────────────────────────────────────────
  "admin.asched.undelivered":
    "Nothing dispatches these yet. The schedules and their recipients are recorded, but no function renders a report and hands it to the mailer, so every row below reads \"never sent\" and will keep reading that until one is built. This is stated rather than hidden because an enabled schedule that silently never fires is worse than no schedule at all.",

  // ── Adding one ──────────────────────────────────────────────────────────────
  "admin.asched.new.title": "Schedule a report",
  "admin.asched.new.hint":
    "The subject is what gets rendered. Only reports the system can already produce on screen are offered — scheduling something nobody can generate would be a promise with nothing behind it.",
  "admin.asched.new.code": "Short code",
  "admin.asched.new.code.hint": "For example MUSTER-WEEKLY. One per company.",
  "admin.asched.new.name": "Name",
  "admin.asched.new.description": "What it is for",
  "admin.asched.new.subject": "What it contains",
  "admin.asched.new.format": "Format",
  "admin.asched.new.when": "How often",
  "admin.asched.new.submit": "Record this schedule",
  "admin.asched.new.submitting": "Recording…",
  "admin.asched.new.done": "The schedule is recorded",
  "admin.asched.new.doneDetail":
    "Add recipients to it below. Nothing will be sent until the delivery function is built.",
  "admin.asched.new.blocked.title": "Before this can be recorded",
  "admin.asched.new.blocked.code": "Give it a short code.",
  "admin.asched.new.blocked.name": "Give it a name.",
  "admin.asched.new.blocked.company": "No company could be read, so there is nothing to attach this to.",

  // ── Recipients ──────────────────────────────────────────────────────────────
  "admin.asched.rec.title": "Recipients of {name}",
  "admin.asched.rec.hint":
    "An employee recipient follows the person — if they leave, the report stops going to them. A plain address does not, which is why it is the second choice and not the default.",
  "admin.asched.rec.empty": "Nobody receives this yet.",
  "admin.asched.rec.addEmployee": "Add an employee",
  "admin.asched.rec.addEmail": "Or an email address",
  "admin.asched.rec.emailHint": "For somebody with no login — an auditor, the accountant.",
  "admin.asched.rec.add": "Add",
  "admin.asched.rec.pick": "Select somebody",
  "admin.asched.rec.close": "Done",

  // ── Subjects ────────────────────────────────────────────────────────────────
  "admin.asched.subject.attendance_muster": "Attendance muster",
  "admin.asched.subject.attendance_exceptions": "Attendance exceptions",
  "admin.asched.subject.leave_balances": "Leave balances",
  "admin.asched.subject.leave_taken": "Leave taken",
  "admin.asched.subject.payroll_register": "Payroll register",
  "admin.asched.subject.payroll_statutory": "Statutory deductions",
  "admin.asched.subject.document_compliance": "Document compliance",
  "admin.asched.subject.asset_custody": "Asset custody",
  "admin.asched.subject.approvals_pending": "Approvals waiting",
  "admin.asched.subject.headcount": "Headcount",
} as const;
