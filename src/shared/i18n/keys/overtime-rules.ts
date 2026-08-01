/**
 * i18n keys owned EXCLUSIVELY by the overtime-rules work. One file per author — `t()` is
 * typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Surface: `OvertimeRulesCard` on /me/comp-off.
 *
 * THE COPY CARRIES THE SHAPE, NEVER THE FIGURES. Every duration and count is interpolated
 * from the policy and shift rows the engine itself reads, so an administrator editing the
 * policy changes this card too. A sentence with "4 hours" baked into it would be correct
 * today and silently wrong afterwards.
 */
export const keysOvertimeRules = {
  "leave.otRules.title": "How overtime and comp-off are worked out",
  "leave.otRules.subtitle":
    "These are the rules actually applied to your days — read from your own shift and attendance policy, not a general description.",

  // ── Overtime ──────────────────────────────────────────────────────────────
  "leave.otRules.ot.heading": "Overtime — on a normal working day",
  "leave.otRules.ot.shiftLine": "Your shift is {name}, {start} to {end} ({hours}).",
  "leave.otRules.ot.noShift":
    "You have no shift assigned, so overtime cannot be calculated for your days. Ask HR to assign one.",
  "leave.otRules.ot.disabled":
    "Overtime is switched off in your attendance policy, so no overtime minutes are recorded.",
  "leave.otRules.ot.step1": "Your shift's paid length",
  "leave.otRules.ot.step2": "Ignored past the shift before overtime starts",
  "leave.otRules.ot.step3": "Smallest amount that counts at all",
  "leave.otRules.ot.step4": "Rounded down to the nearest",
  "leave.otRules.ot.step5": "Most that can count in one day",
  "leave.otRules.ot.roundingValue": "{n} min",
  "leave.otRules.ot.example":
    "So overtime begins once your worked time passes {shift} plus {threshold}. Anything under the minimum is not carried forward — it is not banked for another day.",
  "leave.otRules.ot.grace":
    "Arriving by {minutes} minutes after {start} is not counted late.",

  // ── Comp-off ──────────────────────────────────────────────────────────────
  "leave.otRules.compOff.heading": "Comp-off — for working a weekly off or a holiday",
  "leave.otRules.compOff.intro":
    "Work on a day you were meant to be off and the whole day counts as extra work. What it earns depends only on how long you worked — there is no part-day beyond a half.",
  "leave.otRules.compOff.half": "Half a day once you work at least",
  "leave.otRules.compOff.full": "A full day once you work at least",
  "leave.otRules.compOff.expiry": "A credit expires after",
  "leave.otRules.compOff.expiryValue": "{n} days",
  "leave.otRules.compOff.step1": "1 · You work a weekly off or a holiday.",
  "leave.otRules.compOff.step2":
    "2 · The credit is created for you automatically — you do not have to claim it.",
  "leave.otRules.compOff.step3":
    "3 · It waits for approval before it can be spent, and shows as awaiting approval until then.",
  "leave.otRules.compOff.step4":
    "4 · To take it, apply for comp-off leave like any other leave. Your manager approves it.",
  "leave.otRules.compOff.notOvertime":
    "Comp-off comes from extra work on an off day, never from overtime on a working day. Working late on a weekday earns overtime instead — the two are separate and one is not converted into the other.",

  "leave.otRules.source": "From your attendance policy, {policy}.",
  "leave.otRules.noPolicy":
    "No attendance policy resolves for you, so the system's built-in defaults apply. Ask HR to assign a policy.",
} as const;

/**
 * Per-employee shift override, on the policy resolver.
 *
 * The precedence sentence is the important one: an administrator who does not know a
 * published roster slot outranks this will read an unchanged shift as a bug.
 */
export const keysAssignShift = {
  "timeAudit.assignShift.title": "Put this employee on a different shift",
  "timeAudit.assignShift.hint":
    "{name} is currently on {shift}. A shift set here applies to them alone — it does not change the shift master or anybody else on their designation.",
  "timeAudit.assignShift.hintNoCurrent":
    "{name} has no shift resolving today. A shift set here applies to them alone — it does not change the shift master or anybody else on their designation.",
  "timeAudit.assignShift.rosterWins":
    "A published roster slot already decides this date, and a roster slot outranks a standing assignment. This override will apply on dates the roster does not cover.",
  "timeAudit.assignShift.shift": "Shift",
  "timeAudit.assignShift.shiftHint": "Its timings and grace come from the shift itself.",
  "timeAudit.assignShift.from": "From",
  "timeAudit.assignShift.fromHint": "The first day it applies.",
  "timeAudit.assignShift.to": "Until (optional)",
  "timeAudit.assignShift.toHint": "Leave empty for an open-ended change.",
  "timeAudit.assignShift.action": "Assign this shift",
  "timeAudit.assignShift.done": "Assigned, effective {from}.",
  "timeAudit.assignShift.reasonTitle": "Why is this shift changing?",
  "timeAudit.assignShift.reasonBody":
    "This changes what counts as late, what counts as overtime and what the gate expects of {name}. The reason is recorded against the assignment.",

  // ── Two modes: an existing shift, or new timings ──────────────────────────
  "timeAudit.assignShift.modeAria": "Choose an existing shift or create new timings",
  "timeAudit.assignShift.mode.existing": "An existing shift",
  "timeAudit.assignShift.mode.new": "New timings",
  "timeAudit.assignShift.newName": "Name for these timings",
  "timeAudit.assignShift.newNameHint": "Include the person or the post — the shift is shared and will appear in Time · Shifts.",
  "timeAudit.assignShift.newNamePlaceholder": "e.g. Front Desk late (Asha)",
  "timeAudit.assignShift.newCode": "Will be saved with the code {code}.",
  "timeAudit.assignShift.start": "Starts",
  "timeAudit.assignShift.end": "Ends",
  "timeAudit.assignShift.endHint": "An end before the start means it runs past midnight.",
  "timeAudit.assignShift.break": "Unpaid break (minutes)",
  "timeAudit.assignShift.graceIn": "Late grace (minutes)",
  "timeAudit.assignShift.graceInHint": "Arriving within this is not counted late.",
  "timeAudit.assignShift.graceOut": "Early-out grace (minutes)",
  "timeAudit.assignShift.paid": "Paid length: {hours}.",
  "timeAudit.assignShift.badWindow": "Enter both times as HH:MM.",
  "timeAudit.assignShift.breakTooLong": "The unpaid break is as long as the shift — there would be no paid time left.",
} as const;

/**
 * Grace-period wording, shared by the Shifts and Attendance Policies screens.
 *
 * These sentences exist because the two screens disagreed in practice: a shift's grace
 * was overridden by every policy's, silently, and neither screen said so. Migration
 * 039100 made the policy's grace optional; the copy is what makes the new behaviour
 * discoverable instead of being a second surprise.
 */
export const keysGrace = {
  "admin.time.grace.inOut": "{in} min in / {out} min out",
  "admin.time.grace.precedence":
    "Grace set here applies unless the employee's attendance policy sets its own — a policy's grace overrides the shift's. Clear the policy's grace to hand control back to the shift.",
  "admin.time.grace.policyOptional":
    "Minutes after shift start that are not counted late. Leave EMPTY to use the shift's own grace — that is now the way to control grace shift by shift.",
  "admin.time.grace.policyOptionalOut":
    "Minutes before shift end that are not counted an early exit. Leave EMPTY to use the shift's own grace.",
} as const;

export const keysGraceGrid = {
  "admin.time.grace.fromShift": "From the shift",
} as const;

/**
 * The admin attaching documents to an employee, on the Add Employee success screen.
 *
 * `approvedNote` says out loud that an HR upload is already verified. Leaving that
 * implicit would have HR wondering why their own upload is not in the review queue.
 */
export const keysAttachDocs = {
  "admin.attachDocs.title": "Attach documents",
  "admin.attachDocs.hint":
    "If you were handed anything for {name} — Aadhaar, PAN, a certificate, a photograph — add it now. One file at a time, because each needs its own type and dates.",
  "admin.attachDocs.type": "Document type",
  "admin.attachDocs.typeHint": "Decides where it files and whether an expiry is needed.",
  "admin.attachDocs.docTitle": "Title",
  "admin.attachDocs.docTitlePlaceholder": "e.g. Aadhaar card",
  "admin.attachDocs.issue": "Issued on (optional)",
  "admin.attachDocs.expiry": "Expires on (optional)",
  "admin.attachDocs.expiryRequired": "Expires on",
  "admin.attachDocs.expiryHint":
    "Required for this type — without it the document cannot appear in the expiry report.",
  "admin.attachDocs.note": "Where it came from (optional)",
  "admin.attachDocs.noteHint": "Recorded with the document, so the next person knows.",
  "admin.attachDocs.notePlaceholder": "e.g. original seen at the desk, photocopy taken",
  "admin.attachDocs.pick": "Choose a file",
  "admin.attachDocs.action": "Attach this document",
  "admin.attachDocs.noActor":
    "Your profile could not be read, so an upload cannot be recorded against your name. Sign out and back in.",
  "admin.attachDocs.approvedNote":
    "A document you attach is recorded as verified by you — it does not go into the review queue, because you are the person that queue asks.",
} as const;

/**
 * The manual comp-off route.
 *
 * It points at a REGULARIZATION rather than a comp-off claim form, because the missing
 * thing is the attendance and not the credit — `decide_regularization` recomputes the day
 * on approval and the recompute calls `sync_comp_off_for_day`, so a manually corrected day
 * earns its credit by exactly the same rule as an automatic one. A separate claim form
 * would be a second way to mint a balance with no attendance behind it.
 */
export const keysCompOffManual = {
  "leave.otRules.manual.heading": "Worked an off day and it was never recorded?",
  "leave.otRules.manual.body":
    "Then the missing thing is the attendance, not the credit. Ask for the day to be corrected and the comp-off follows automatically — by the same rule, so nobody has to take your word for the amount.",
  "leave.otRules.manual.step1":
    "1 · Raise a correction for that date, with the hours you actually worked and why it went unrecorded.",
  "leave.otRules.manual.step2":
    "2 · Your manager approves it. The day is recalculated there and then.",
  "leave.otRules.manual.step3":
    "3 · The comp-off credit appears from the corrected day, and waits for approval like any other.",
  "leave.otRules.manual.action": "Request a correction",
} as const;

export const keysStageDocs = {
  "admin.people.add.step.documents": "Documents",
  "admin.people.add.hint.documents":
    "Anything you were handed for this person. Files are held here and attached the moment the record is created — you can also add more afterwards.",
  "admin.stageDocs.title": "Documents to attach",
  "admin.stageDocs.hint":
    "Add each file with its type. Nothing is uploaded until the employee record is created on the next step.",
  "admin.stageDocs.add": "Add to the list",
  "admin.stageDocs.remove": "Remove",
  "admin.stageDocs.empty": "No documents staged. This step is optional — skip it if you have none.",
  "admin.stageDocs.staged": "{n} file(s) ready to attach",
  "admin.stageDocs.needType": "Choose a document type first.",
  "admin.stageDocs.needFile": "Choose a file first.",
  "admin.stageDocs.needExpiry": "This type needs an expiry date.",
  "admin.stageDocs.uploading": "Attaching {n} document(s)…",
  "admin.stageDocs.uploaded": "{n} attached.",
  "admin.stageDocs.failed": "{name} could not be attached: {reason}",
} as const;

/**
 * The missing admin rail entry.
 *
 * Seven screens under /admin/time/* had no nav entry, so the whole section was reachable
 * only by URL — the same defect the Face & kiosk comment in nav-model records, in a second
 * section. "Time & policy" rather than "Shifts" because the group also owns weekly offs,
 * holidays, attendance policies, pay periods and the resolver.
 */
export const keysNavTime = {
  "shell.nav.admin.time": "Time & policy",
  "shell.nav.admin.org": "Organisation",
  "shell.nav.admin.workflow": "Approvals & workflow",
  "shell.nav.admin.comms": "Communications",
  "shell.nav.admin.assets": "Assets",
} as const;
