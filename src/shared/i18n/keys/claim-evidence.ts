/**
 * claim-evidence.ts — the bill behind a reimbursement claim, on the admin register.
 *
 * Its own file, per the house rule: `t()` is typed on `keyof typeof en`, and two authors
 * appending to one catalogue silently lose each other's keys.
 *
 * ── WHY THE WORDING IS CAREFUL ABOUT WHAT IT DOES NOT KNOW ───────────────────
 * These strings sit next to money somebody is about to approve, so every one of them has to
 * be exactly as confident as the data behind it:
 *
 *   * "Not scanned" — this deployment runs no virus scanner and every receipt sits at
 *     'pending'. `document-access` serves them on purpose. Saying nothing would imply a clean
 *     bill of health nobody issued.
 *   * "You cannot open this one" — a line holding a document id whose row did not come back
 *     is an ACCESS outcome, not a missing attachment, and must never read as "none attached".
 *   * "No receipt attached" is reserved for a line that genuinely carries none.
 *   * The locations are free text the employee typed. There are no coordinates on a claim
 *     line, so nothing here says "location" in a way that suggests a verified position.
 */
export const keysClaimEvidence = {
  // ── The register column ─────────────────────────────────────────────────────
  "admin.reimb.ev.col": "Bills",
  "admin.reimb.ev.count": "{n} attached",
  "admin.reimb.ev.countOne": "1 attached",
  "admin.reimb.ev.none": "None",
  /** A line that says a receipt is required and carries none. */
  "admin.reimb.ev.missing": "{n} missing",
  /** A line whose receipt row this reader may not see. */
  "admin.reimb.ev.unreadable": "{n} you cannot open",
  "admin.reimb.ev.open": "Bills & trail",
  "admin.reimb.ev.openAria": "Open the bills and audit trail for claim {claim}",

  // ── The sheet ───────────────────────────────────────────────────────────────
  "admin.reimb.ev.title": "Claim {claim}",
  "admin.reimb.ev.subtitle": "Every line, its bill, and everyone who has looked at it.",
  "admin.reimb.ev.loading": "Reading the trail…",
  "admin.reimb.ev.linesTitle": "What is being claimed",
  "admin.reimb.ev.noLines": "This claim has no expense lines.",
  "admin.reimb.ev.lineN": "Line {n}",

  // Line fields
  "admin.reimb.ev.f.date": "Date of expense",
  "admin.reimb.ev.f.head": "Expense head",
  "admin.reimb.ev.f.desc": "What it was for",
  "admin.reimb.ev.f.route": "Route",
  "admin.reimb.ev.f.from": "From",
  "admin.reimb.ev.f.to": "To",
  "admin.reimb.ev.f.distance": "Distance",
  "admin.reimb.ev.f.rate": "Rate per km",
  "admin.reimb.ev.f.claimed": "Claimed",
  "admin.reimb.ev.f.approved": "Approved",
  "admin.reimb.ev.f.tax": "Tax",
  "admin.reimb.ev.f.gst": "GST number",
  "admin.reimb.ev.f.mode": "Mode",
  "admin.reimb.ev.f.purpose": "Purpose",
  "admin.reimb.ev.f.rejected": "Rejected because",
  "admin.reimb.ev.f.filed": "Line filed",
  "admin.reimb.ev.km": "{km} km",
  /*
    The locations are free text the employee typed on the form. There is no geofence and no
    coordinate on a claim line, and this label must not imply one.
  */
  "admin.reimb.ev.routeHint": "As typed by the employee — a claim line carries no coordinates.",

  // The receipt
  "admin.reimb.ev.billTitle": "The bill",
  "admin.reimb.ev.noBill": "No receipt attached to this line.",
  "admin.reimb.ev.noBillRequired": "A receipt is required for this line and none is attached.",
  "admin.reimb.ev.billUnreadable":
    "A receipt is attached, but your access does not extend to it. The claim is not missing a bill.",
  "admin.reimb.ev.b.file": "File",
  "admin.reimb.ev.b.type": "Type",
  "admin.reimb.ev.b.size": "Size",
  "admin.reimb.ev.b.billDate": "Date on the bill",
  "admin.reimb.ev.b.uploaded": "Uploaded",
  "admin.reimb.ev.b.uploadedBy": "Uploaded by",
  "admin.reimb.ev.b.checksum": "SHA-256",
  "admin.reimb.ev.b.checksumHint":
    "Computed in the browser before the upload. It proves the bytes served are the bytes filed.",
  "admin.reimb.ev.b.scan": "Virus scan",
  "admin.reimb.ev.b.scan.pending": "Not scanned",
  "admin.reimb.ev.b.scan.pendingHint": "No scanner runs on this deployment yet.",
  "admin.reimb.ev.b.scan.clean": "Clean",
  "admin.reimb.ev.b.scan.infected": "Flagged — cannot be opened",
  "admin.reimb.ev.b.status": "Document status",

  // ── The trail ───────────────────────────────────────────────────────────────
  "admin.reimb.ev.trailTitle": "Audit trail",
  "admin.reimb.ev.filedTitle": "Filed",
  "admin.reimb.ev.filedAt": "Claim filed {when}",
  "admin.reimb.ev.decidedAt": "Decided {when}",
  "admin.reimb.ev.decidedComment": "Decision note",

  "admin.reimb.ev.approvalsTitle": "Approvals",
  "admin.reimb.ev.noApprovals": "No approval has been acted on yet.",
  "admin.reimb.ev.noChain": "This claim carries no approval request.",
  "admin.reimb.ev.level": "Level {n} of {total}",
  "admin.reimb.ev.levelShort": "Level {n}",

  "admin.reimb.ev.readsTitle": "Who has opened the bill",
  "admin.reimb.ev.noReads": "Nobody has opened this bill yet.",
  /*
    `document-access` writes BOTH a `signed_url_minted` row and the `view`/`download` it was
    minted for, before the URL exists — so a link cannot exist without a record of who asked
    for it. Saying so is what makes the list read as a trail rather than a tally.
  */
  "admin.reimb.ev.readsHint":
    "Every link is recorded before it is created, so a bill cannot be opened without a row here.",
  /*
    `ck_dal__access_kind`, all six of them, verbatim from the deployed constraint. Not a
    guess: an invented value ("share") and two missing real ones (`email_attachment`, `api`)
    is exactly how a trail row renders as a blank cell.
  */
  "admin.reimb.ev.kind.view": "Viewed",
  "admin.reimb.ev.kind.download": "Downloaded",
  "admin.reimb.ev.kind.print": "Printed",
  "admin.reimb.ev.kind.signed_url_minted": "Link created",
  "admin.reimb.ev.kind.email_attachment": "Sent as an email attachment",
  "admin.reimb.ev.kind.api": "Read over the API",
  "admin.reimb.ev.byRole": "as {role}",
  "admin.reimb.ev.fromIp": "from {ip}",
  "admin.reimb.ev.onBehalf": "on behalf of {name}",
  "admin.reimb.ev.unknownActor": "An account that no longer exists",
} as const;

/**
 * The Approval Inbox's evidence block — the request itself, not just its envelope.
 *
 * HR's words, opening the call: "if I go for an approval, I can see only the amount. There is
 * no Excel, no attachment, nothing is there." And on a regularisation: "I'm not able to see
 * any details — just given the request and it is showing nothing. I just approved it."
 *
 * So this block answers one question: WHAT AM I APPROVING. It reads the row named by
 * `approval_requests.detail_table` / `detail_id`, which the panel already carried and never
 * opened.
 */
export const keysApprovalEvidence = {
  "admin.wf.ev.title": "What you are approving",
  "admin.wf.ev.loading": "Opening the request…",
  "admin.wf.ev.none": "This request type has no detail panel yet.",
  /* The row exists and RLS did not return it. Never rendered as "nothing attached". */
  "admin.wf.ev.unreadable":
    "The request's own record is outside what you can read, so its details cannot be shown here.",

  // Regularisations
  "admin.wf.ev.reg.kind": "Correction asked for",
  "admin.wf.ev.reg.date": "Day being corrected",
  "admin.wf.ev.reg.in": "Claimed in",
  "admin.wf.ev.reg.out": "Claimed out",
  "admin.wf.ev.reg.status": "Claimed day status",
  "admin.wf.ev.reg.reason": "Why",
  "admin.wf.ev.reg.proof": "Proof attached",
  "admin.wf.ev.reg.noProof": "No proof attached to this request.",
  "admin.wf.ev.reg.applied": "Applied to attendance",
  "admin.wf.ev.reg.notApplied": "Not yet applied to attendance",
  /*
    Said on the panel because it was silently untrue for two live requests: approving through
    this screen settled the approval and never created the punches, so the hours never moved.
    Fixed in 20260903090000 — an approved regularisation now applies itself — and the line
    stays so an approver can confirm the effect landed rather than assume it.
  */
  "admin.wf.ev.reg.appliedHint":
    "Approving creates the punches for these times and recomputes the day.",
  "admin.wf.ev.reg.quota": "Correction {n} this month",

  // Claims
  "admin.wf.ev.claim.lines": "Expense lines",
  "admin.wf.ev.claim.noLines": "This claim carries no expense lines.",

  // ── The generic panel ─────────────────────────────────────────────────────
  "admin.wf.ev.noFields": "This request carries no details of its own.",
  "admin.wf.ev.unknownTable":
    "This request points at “{table}”, which is not a registered request type. Nothing can be shown until that is corrected.",
  "admin.wf.ev.docs": "Attachments",
  /*
    Stated, never left blank. An approver needs to know a request arrived WITHOUT proof —
    that is a reason to ask for it, and an empty space says nothing.
  */
  "admin.wf.ev.noDocs": "Nothing was attached to this request.",
  "admin.wf.ev.docN": "Attachment {n}",

  /*
    ── FIELD LABELS ────────────────────────────────────────────────────────
    Only the ones worth wording. Anything without a label here is humanised from its column
    name (`employee_reason` -> "Employee reason"), which is why a request type nobody has
    labelled yet is still legible the day it appears instead of after a deploy.
  */
  "admin.wf.ev.f.leave_type": "Leave type",
  "admin.wf.ev.f.reason": "Reason given",
  "admin.wf.ev.f.employee_reason": "Reason given",
  "admin.wf.ev.f.purpose": "Purpose",
  "admin.wf.ev.f.travel_purpose": "Purpose of travel",
  "admin.wf.ev.f.reason_category": "Category",
  "admin.wf.ev.f.from_date": "From",
  "admin.wf.ev.f.to_date": "To",
  "admin.wf.ev.f.ist_date": "Day being corrected",
  "admin.wf.ev.f.period_from": "Period from",
  "admin.wf.ev.f.period_to": "Period to",
  "admin.wf.ev.f.requested_first_in_at": "Claimed in",
  "admin.wf.ev.f.requested_last_out_at": "Claimed out",
  "admin.wf.ev.f.requested_status": "Claimed day status",
  "admin.wf.ev.f.regularization_kind": "Correction asked for",
  "admin.wf.ev.f.portion": "Half or full day",
  "admin.wf.ev.f.total_days": "Days asked for",
  "admin.wf.ev.f.approved_days": "Days approved",
  "admin.wf.ev.f.paid_days": "Paid days",
  "admin.wf.ev.f.unpaid_days": "Unpaid days",
  "admin.wf.ev.f.total_claimed_paise": "Claimed",
  "admin.wf.ev.f.total_approved_paise": "Approved",
  "admin.wf.ev.f.amount_claimed_paise": "Claimed",
  "admin.wf.ev.f.amount_approved_paise": "Approved",
  "admin.wf.ev.f.advance_adjusted_paise": "Advance adjusted",
  "admin.wf.ev.f.tax_amount_paise": "Tax",
  "admin.wf.ev.f.rate_per_km_paise": "Rate per km",
  "admin.wf.ev.f.from_location": "From",
  "admin.wf.ev.f.to_location": "To",
  "admin.wf.ev.f.distance_km": "Distance (km)",
  "admin.wf.ev.f.address_during_leave": "Address while away",
  "admin.wf.ev.f.contact_during_leave": "Contact while away",
  "admin.wf.ev.f.handover_notes": "Handover",
  "admin.wf.ev.f.event_reference": "Event",
  "admin.wf.ev.f.expense_head": "Expense head",
  "admin.wf.ev.f.description": "What it was for",
  "admin.wf.ev.f.gst_number": "GST number",
  "admin.wf.ev.f.line_date": "Date of expense",
  "admin.wf.ev.f.decision_comment": "Decision note",
  "admin.wf.ev.f.decided_comment": "Decision note",
  "admin.wf.ev.f.decided_at": "Decided",
  "admin.wf.ev.f.applied_at": "Applied",
  "admin.wf.ev.f.is_backdated": "Backdated",
  "admin.wf.ev.f.month_quota_counter": "Correction this month",
  "admin.wf.ev.f.is_receipt_required": "Receipt required",
  "admin.wf.ev.f.status": "State",
} as const;

/**
 * The proof photograph on an off-hours punch.
 *
 * The venue's words: "Can we give one small screenshot or something for records, evidence?" —
 * "Mandatory, yes. They should attach. And while checking out also, it's mandatory. Someone
 * will check in and the meeting would have been over long back. They might check out by 10 or
 * 12 o'clock. I don't want to pay so much and I don't want to keep on verifying all that."
 *
 * The copy asks for the thing that proves the CLAIM, not a selfie: the meeting invitation, the
 * call window, the place of work. A picture of a face proves the person exists, which the face
 * capture two steps later already establishes.
 */
export const keysPunchProof = {
  "me.punch.offHours.proof.label": "Attach proof",
  "me.punch.offHours.proof.hint":
    "A screenshot of the meeting or call, or a photo of where you are working. Needed on the way in and on the way out.",
  "me.punch.offHours.proof.uploading": "Attaching…",
  "me.punch.offHours.proof.attached": "Attached: {name}",
  "me.punch.offHours.proof.tooLarge": "That file is over {mb} MB. Attach a smaller one.",
  /*
    Said BEFORE a file is chosen wherever possible: every predicate of
    `documents__self__insert` has to resolve for the upload to be accepted, and finding out
    afterwards wastes the employee's time at the gate.
  */
  "me.punch.offHours.proof.unavailable":
    "Proof cannot be attached on this account yet. Punch anyway — an administrator will be asked to confirm your hours.",
  /*
    NOT a dead end. The punch still goes through: the server records a proofless off-hours
    punch and flags it, because this venue has already lost attendance to a hard gate — people
    concluded the app was broken and stopped punching altogether.
  */
  "me.punch.offHours.proof.failed":
    "That did not upload — the signal may be weak. Try again, or punch without it and an administrator will ask you for it.",
} as const;

/** The proof, on the administrator's off-hours queue. */
export const keysOffHoursProof = {
  "admin.offHours.proof.attached": "Proof attached",
  /*
    In words, not a blank. The form makes the photograph mandatory, so an absent one means the
    upload failed and the punch was recorded anyway rather than costing the employee their
    evening — the approver should ask for it, not assume it is there.
  */
  "admin.offHours.proof.missing": "No proof attached — the upload may have failed. Ask for it before approving.",
} as const;

/**
 * The overtime claim screen.
 *
 * The venue's words: "If they have completed one month attendance, and there are certain days
 * where they have worked extra — it should show summarised. Can they submit it to me saying,
 * okay, the overtime I want to claim? It should come as an approval to me." And on the outcome:
 * "either you can be compensated, or we can give it as a compensatory off."
 *
 * The copy never invites a number. There is no minutes field: `submit_overtime_claim` sums the
 * month itself, so the figure shown is the figure filed and an approver is deciding whether to
 * pay rather than checking arithmetic.
 */
export const keysOvertimeClaim = {
  "apply.ot.title": "Claim overtime",
  "apply.ot.subtitle":
    "A finished month's credited overtime, claimed as pay or as compensatory off. The hours come from your attendance — you do not type a number.",
  "apply.ot.month": "Month",
  "apply.ot.credited": "Credited overtime",
  "apply.ot.creditedHint": "Across {days} day(s) that cleared your policy's overtime minimum.",
  /*
    Said plainly because the employee can see these hours on their own attendance page. If the
    claim is smaller and nothing explains why, the system looks like it lost their time.
  */
  "apply.ot.withheld":
    "A further {held} across {days} day(s) is not claimable yet — those days still have a punch waiting for an administrator. Once approved, it can be claimed.",
  "apply.ot.alreadyClaimed": "You already have a claim in progress for this month.",

  "apply.ot.mode": "What you would like",
  "apply.ot.mode.paid": "Paid",
  "apply.ot.mode.compOff": "Compensatory off",
  "apply.ot.mode.paidHint": "Paid with the month's payroll, once approved.",
  /*
    The rounding is stated up front rather than discovered on refusal: comp-off is credited in
    half-days, so a short claim buys nothing and the function refuses it.
  */
  "apply.ot.mode.compOffHint":
    "Credited as leave you can take later. Rounded down to the nearest half day, so a short claim is better taken as pay.",

  "apply.ot.reason": "What was the extra work?",
  "apply.ot.reasonPlaceholder": "Evening calls with the US client team, and the Sadanand decor review.",
  "apply.ot.reasonCounter": "{n} of {min} characters",
  "apply.ot.file": "Send for approval",
  "apply.ot.filing": "Sending…",
  "apply.ot.filed": "{month} sent for approval.",

  "apply.ot.mineTitle": "Your claims",
  "apply.ot.mineEmpty": "You have not claimed any overtime yet.",
  "apply.ot.applied": "credited",
} as const;

/**
 * The location trail, on an administrator's day panel.
 *
 * ── THE CAVEAT IS THE MOST IMPORTANT STRING HERE ─────────────────────────────
 * A web page cannot sample position in the background, so the trail covers only the time the
 * app was open. Somebody reading this panel to decide whether an employee was where they
 * claimed could otherwise read an absence of dots as an absence of person — and act on it. The
 * caveat is rendered ABOVE the points, every time, full or empty.
 */
export const keysLocationTrail = {
  "admin.trail.title": "Where their device reported being",
  "admin.trail.caveat":
    "Recorded only while the app was open — a phone cannot report its position in the background. A gap means the app was closed, not that the person was elsewhere.",
  "admin.trail.empty": "No points for this day. The app was not open, or location was not granted.",
  "admin.trail.count": "{n} point(s)",
  "admin.trail.window": "{from} to {to}",
  "admin.trail.furthest": "furthest {d} from the venue",
  "admin.trail.fromVenue": "{d} away",
  "admin.trail.accuracy": "±{m} m",
  /* A fix this coarse is usually IP-derived: it names a city, not a place. */
  "admin.trail.coarse": "±{m} m — too vague to place",
  "admin.trail.coarseCount": "{n} too vague to place",
  "admin.trail.outsideShift": "{n} outside shift hours",
  "admin.trail.offShift": "off-shift",
  "admin.trail.noFix": "No coordinates recorded",
} as const;

/**
 * The Reimbursement Admin page.
 *
 * ── THE THREE STATES, IN THE VENUE'S OWN WORDS ───────────────────────────────
 * "Which reimbursements have been processed, which are done, and which are pending?"
 *   pending   → somebody still has to decide it
 *   processed → approved, and not yet paid: what the venue OWES
 *   done      → paid out, with a date and a reference
 *
 * "Processed" is deliberately NOT a synonym for finished. Approved money that nothing is
 * scheduled to pay is the state worth seeing, and the outstanding tile is the figure to read
 * first.
 */
export const keysReimbursementAdmin = {
  "admin.radm.title": "Reimbursements",
  "admin.radm.subtitle":
    "Every claim for a month or a financial year: what was claimed, what is approved, what is paid, and what is still owed.",

  "admin.radm.scope": "Range",
  "admin.radm.scope.month": "One month",
  "admin.radm.scope.fy": "Financial year",
  "admin.radm.month": "Month",
  "admin.radm.inYearOf": "Year containing",
  "admin.radm.type": "Claim type",
  "admin.radm.allTypes": "All types",
  "admin.radm.download": "Download CSV",

  /*
    A claim carries three dates and they disagree — CLM-2026-000003 covers 26-30 August and
    was filed on 2 September. So the basis is chosen, and each hint says which question that
    choice answers.
  */
  "admin.radm.basis": "Count a claim in",
  "admin.radm.basis.period": "the month it was spent",
  "admin.radm.basis.filed": "the month it was filed",
  "admin.radm.basis.paid": "the month it was paid",
  "admin.radm.basis.hint.period":
    "By expense period — what the month cost. The budget question. A claim filed later still counts in the month the money was spent.",
  "admin.radm.basis.hint.filed":
    "By filing date — what landed on HR's desk this month, whenever the spending happened.",
  "admin.radm.basis.hint.paid":
    "By payment date — what actually left the bank. This is what reconciles against a bank statement, and it excludes everything not yet paid.",

  "admin.radm.tile.claimed": "Claimed",
  "admin.radm.tile.claimedCaption": "{n} claim(s) from {people} people",
  "admin.radm.tile.approved": "Approved",
  "admin.radm.tile.approvedCaption": "{n} claim(s) approved",
  "admin.radm.tile.paid": "Paid out",
  "admin.radm.tile.paidCaption": "{n} claim(s) settled",
  "admin.radm.tile.outstanding": "Still owed",
  "admin.radm.tile.outstandingCaption": "{n} approved with no run to pay them",

  "admin.radm.count.pending": "Pending a decision",
  "admin.radm.count.processed": "Processed (approved)",
  "admin.radm.count.done": "Done (paid)",
  "admin.radm.count.rejected": "Rejected or withdrawn",

  /* Only shown when non-zero: `period_to` is nullable and nothing forces it. */
  "admin.radm.undated":
    "{n} claim(s) carry no expense period, so they are not in this total. Switch the basis to “the month it was filed” to include them.",
  "admin.radm.byType": "By claim type",

  "admin.radm.tableTitle": "Every claim in this range",
  "admin.radm.clearSlice": "Show all states",
  /* The server's count over the same filters — so a capped page cannot look like the whole. */
  "admin.radm.rowCount": "Showing {shown} of {total} claim(s) in this range.",
  "admin.radm.partial": "some names, approver rights or expense lines",
  "admin.radm.empty.title": "No claims in this range",
  "admin.radm.empty.hint":
    "Try a different month, or count claims by the month they were filed instead of the month they were spent.",

  "admin.radm.col.who": "Who claimed",
  "admin.radm.col.claim": "Claim",
  "admin.radm.col.type": "Type",
  "admin.radm.col.purpose": "What for",
  "admin.radm.col.period": "Expense period",
  "admin.radm.col.claimed": "Claimed",
  "admin.radm.col.approved": "Approved",
  "admin.radm.col.state": "State",
  "admin.radm.col.paid": "Paid",
  "admin.radm.col.act": "",
  "admin.radm.inRun": "In a payroll run",
  /* Approved and unpaid. Not an error, and not "done" either. */
  "admin.radm.owed": "Owed — no run",

  "admin.radm.view": "Bills & trail",
  "admin.radm.approve": "Approve",
  "admin.radm.reject": "Reject",
  "admin.radm.dialog.approve": "Approve {number}",
  "admin.radm.dialog.reject": "Reject {number}",

  "admin.radm.csv.code": "Employee code",
  "admin.radm.csv.periodFrom": "Period from",
  "admin.radm.csv.periodTo": "Period to",
  "admin.radm.csv.filed": "Filed on",
  "admin.radm.csv.paidOn": "Paid on",
  "admin.radm.csv.reference": "Payment reference",

  "admin.radm.type.local_conveyance": "Local conveyance",
  "admin.radm.type.travel": "Travel",
  "admin.radm.type.food": "Food",
  "admin.radm.type.medical": "Medical",
  "admin.radm.type.telephone": "Telephone",
  "admin.radm.type.uniform": "Uniform",
  "admin.radm.type.fuel": "Fuel",
  "admin.radm.type.guest_hospitality": "Guest hospitality",
  "admin.radm.type.misc": "Miscellaneous",
} as const;

/**
 * The pending queue on the reimbursement page.
 *
 * Reported as "pending bills are not showing". Every figure was correct: the one pending claim
 * had an expense period ending 30 August and was filed on 2 September, so the default
 * September-by-expense-period view excluded it and Pending read 0 while somebody waited for an
 * approval. A total is about a period; a queue is about now.
 */
export const keysReimbursementQueue = {
  /* Under the number, because the figure deliberately is NOT the period's. */
  "admin.radm.count.pendingNote": "Every month — a decision cannot wait on a date filter",
  "admin.radm.pendingOutside":
    "{n} of the {total} claim(s) awaiting a decision fall outside this period, so they are not counted above.",
  "admin.radm.showQueue": "Show everything pending",
  "admin.radm.queueTitle": "Every claim awaiting a decision, any month",
} as const;
