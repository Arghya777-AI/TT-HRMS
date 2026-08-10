/**
 * claims.ts — the reimbursement portal's strings.
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`,
 * so two people appending to one catalogue silently lose each other's keys.
 *
 * A note on the refusal copy below. Every one of these messages has a database
 * rule behind it (migration 040400's date guards, `ck_claim_lines__travel_mode`,
 * `documents__self__insert`), and the wording is deliberately the same on both
 * sides — the employee should not get one sentence from the form and a different
 * one from the server for the same rule.
 */
export const keysClaims = {
  // ── The travel dropdowns ────────────────────────────────────────────────────
  "claim.purpose.label": "Reason for travel",
  "claim.purpose.placeholder": "Select one",
  "claim.purpose.sales": "Sales",
  "claim.purpose.support": "Support",
  "claim.purpose.management": "Management",

  "claim.mode.label": "Mode",
  "claim.mode.placeholder": "Select one",
  "claim.mode.taxi": "Taxi",
  "claim.mode.auto": "Auto",
  "claim.mode.bus": "Bus",
  "claim.mode.bike": "Bike",
  "claim.mode.car": "Car",
  "claim.mode.company_bike": "Company bike",
  "claim.mode.company_car": "Company car",
  "claim.mode.train": "Train",
  "claim.mode.flight": "Flight",
  "claim.mode.other": "Other",

  // ── The receipt ─────────────────────────────────────────────────────────────
  "claim.receipt.lead": "Upload the bill — the details fill in automatically",
  "claim.receipt.label": "Bill or invoice",
  "claim.receipt.hint": "Any file up to 10 MB. A photo or PDF can also be read automatically.",
  "claim.receipt.choose": "Choose a file",
  "claim.receipt.attached": "{name} attached",
  "claim.receipt.uploading": "Attaching the bill…",
  "claim.receipt.tooLarge": "That file is over 10 MB. A photo of the bill is usually well under it.",
  "claim.receipt.notReadable":
    "Attached. This file type cannot be read automatically, so type the details in.",
  "claim.receipt.typeMissing":
    "Receipts cannot be attached on this deployment yet, so file the claim and hand the bill to HR quoting the claim number.",
  "claim.receipt.required": "Attach the bill before filing this claim.",

  // ── Reading the receipt ─────────────────────────────────────────────────────
  "claim.ocr.reading": "Reading the bill…",
  "claim.ocr.title": "Here is what the bill says",
  "claim.ocr.lead": "Check these against the bill. Anything it could not read clearly is left blank.",
  "claim.ocr.use": "Use these details",
  "claim.ocr.manual": "I'll type it myself",
  "claim.ocr.nothing":
    "The bill could not be read clearly enough to fill the form. Type the details in — it is still attached to the claim.",
  "claim.ocr.unavailable":
    "Reading bills automatically is not available right now, so type the details in. The bill you attached is still saved with the claim.",
  "claim.ocr.field.amount": "Amount",
  "claim.ocr.field.date": "Date of bill",
  "claim.ocr.field.vendor": "Billed by",
  "claim.ocr.field.gst": "GST number",
  "claim.ocr.field.description": "Description",
  "claim.ocr.field.mode": "Mode",
  "claim.ocr.confident": "Read clearly",
  "claim.ocr.unsure": "Check this one",

  // ── The dashboard ───────────────────────────────────────────────────────────
  "claim.slice.awaiting_submission": "Waiting for submission",
  "claim.slice.pending": "Pending",
  "claim.slice.approved": "Approved",
  "claim.slice.rejected": "Rejected",
  "claim.slice.paid": "Settled",
  "claim.slice.awaiting_submission.hint": "Started and not yet sent",
  "claim.slice.pending.hint": "With your manager or an administrator",
  "claim.slice.approved.hint": "Approved, not yet paid",
  "claim.slice.rejected.hint": "Sent back or withdrawn",
  "claim.slice.paid.hint": "Paid out",
  "claim.slice.all": "All claims",
  "claim.filter.title": "Filter by status",
  "claim.filter.hint": "Choose a view that matches the claim stage",

  // ── Rules the form mirrors from the database ────────────────────────────────
  "claim.window.hint":
    "Claims are accepted only for bills dated within the last {days} days.",
  "claim.blocked.window":
    "That bill is outside the {days} day claim window. Ask HR if it still needs to be paid.",
  "claim.blocked.notADate": "Enter the date printed on the bill.",
  "claim.blocked.purpose": "Choose the reason for the journey.",
  "claim.blocked.mode": "Choose how the journey was made.",

  // ── Payment, on the admin side ──────────────────────────────────────────────
  "claim.pay.action": "Record payment",
  "claim.pay.title": "Record payment for {ref}",
  "claim.pay.mode": "Paid by",
  "claim.pay.date": "Paid on",
  "claim.pay.reference": "Reference",
  "claim.pay.referenceHint": "UTR, cheque number or transaction id. Not needed for cash.",
  "claim.pay.mode.bank_transfer": "Bank transfer",
  "claim.pay.mode.cash": "Cash",
  "claim.pay.mode.cheque": "Cheque",
  "claim.pay.mode.upi": "UPI",
  "claim.pay.done": "Payment recorded against {ref}.",
  "claim.pay.col.payment": "Payment",
  "claim.pay.unpaid": "Not yet paid",

  // ── Taking over an overdue claim ────────────────────────────────────────────
  "claim.override.badge": "Deciding as super administrator",
  "claim.override.overdue": "Manager has not decided since {on} — deciding as administrator",

  // ── The org-chart gap this feature depends on ───────────────────────────────
  "claim.noManager.title": "{n} employees have no reporting manager",
  "claim.noManager.hint":
    "Their claims skip the manager check and go straight to an administrator. Set a reporting manager on each record to route them properly.",

  // ── Web punch (migration 040900 gave it a table; this is the form) ──────────
  "apply.webpunch.form.title": "Ask for a punch to be recorded",
  "apply.webpunch.form.hint":
    "For a shift you worked away from the gate. Your manager sees the time you give and the reason.",
  "apply.webpunch.field.when": "When you punched",
  "apply.webpunch.field.direction": "In or out",
  "apply.webpunch.field.reason": "Why it was not at the gate",
  "apply.webpunch.field.reason.placeholder":
    "At the Coorg site all day for the handover; no camera there.",
  "apply.webpunch.field.reason.hint": "At least ten characters. Your approver reads this first.",
  "apply.webpunch.direction.in": "Punch in",
  "apply.webpunch.direction.out": "Punch out",
  "apply.webpunch.direction.break_start": "Break start",
  "apply.webpunch.direction.break_end": "Break end",
  "apply.webpunch.send": "Send the request",
  "apply.webpunch.sending": "Sending…",
  "apply.webpunch.done": "Sent. It is with your approver now and appears below.",
  "apply.webpunch.blocked.title": "Before you can send this",
  "apply.webpunch.blocked.when": "Give the time you punched.",
  "apply.webpunch.blocked.future": "A punch cannot be dated in the future.",
  "apply.webpunch.blocked.reason": "Explain why it was not at the gate, in at least ten characters.",

  // ── Resignation (migration 040800 gave it a table; this is the form) ────────
  "apply.resign.form.title": "File your resignation",
  "apply.resign.form.hint":
    "It goes to your reporting manager, then to HR. Your notice period is the one on your employment record.",
  "apply.resign.field.lastDay": "Intended last working day",
  "apply.resign.field.lastDay.hint": "Your notice period is {days} days.",
  "apply.resign.field.category": "Main reason",
  "apply.resign.field.reason": "In your own words",
  "apply.resign.field.reason.hint": "At least ten characters. Your manager and HR read this.",
  "apply.resign.category.better_opportunity": "A better opportunity",
  "apply.resign.category.higher_studies": "Higher studies",
  "apply.resign.category.relocation": "Relocating",
  "apply.resign.category.health": "Health",
  "apply.resign.category.family": "Family",
  "apply.resign.category.compensation": "Compensation",
  "apply.resign.category.work_environment": "Work environment",
  "apply.resign.category.career_change": "Change of career",
  "apply.resign.category.personal": "Personal",
  "apply.resign.category.other": "Something else",
  "apply.resign.send": "File the resignation",
  "apply.resign.sending": "Filing…",
  "apply.resign.done": "Filed. It is with your manager now.",
  "apply.resign.blocked.title": "Before you can file this",
  "apply.resign.blocked.past": "The last working day cannot be in the past.",
  "apply.resign.blocked.reason": "Say why, in at least ten characters.",
  "apply.resign.blocked.notice":
    "Your notice period is not on your record yet — ask HR to set it before filing.",
} as const;
