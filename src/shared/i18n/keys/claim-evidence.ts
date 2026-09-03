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
