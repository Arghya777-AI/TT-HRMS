/**
 * certification.ts — the strings for /me/apply/certification.
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`,
 * so two people appending to one catalogue silently lose each other's keys.
 *
 * Every refusal below has a database rule behind it — `ck_certclaim__reason`,
 * `ck_certclaim__not_more_than_fee`, `ck_certclaim__dates`,
 * `uq_certclaim__one_open` — and the wording is deliberately the same on both
 * sides. An employee should not get one sentence from the form and a different
 * one from the server for the same rule.
 */
export const keysCertification = {
  // ── The form ────────────────────────────────────────────────────────────────
  "apply.cert.form.title": "Ask the venue to fund a certification",
  "apply.cert.form.hint":
    "Your manager decides whether it helps in the job; HR holds the training budget. Both see everything you enter here.",

  "apply.cert.field.catalogue": "Which certification",
  "apply.cert.field.catalogue.none": "Something else — not on this list",
  "apply.cert.field.catalogue.pick": "Select one",
  "apply.cert.field.catalogue.empty":
    "Nobody has listed a funded certification yet, so tell us what you want to do and it will be judged on its own merits.",
  "apply.cert.field.name": "Name of the certification",
  "apply.cert.field.name.hint": "Exactly as the certificate will read.",
  "apply.cert.field.body": "Who issues it",
  "apply.cert.field.body.hint": "The institute, board or awarding body.",
  "apply.cert.field.fee": "What the course costs (₹)",
  "apply.cert.field.fee.hint": "The full fee, before anything the venue might pay.",
  "apply.cert.field.ask": "What you are asking the venue for (₹)",
  "apply.cert.field.ask.hint":
    "Never more than the fee. Ask for less if you are funding part of it yourself.",
  "apply.cert.field.starts": "Starts on",
  "apply.cert.field.completes": "Finishes on",
  "apply.cert.field.dates.hint": "Leave blank if the dates are not fixed yet.",
  "apply.cert.field.reason": "Why it is worth funding",
  "apply.cert.field.reason.hint":
    "What the certification lets you do that you cannot do today. At least {n} characters — this is the part your manager actually reads.",

  // ── The cap, shown and never enforced ───────────────────────────────────────
  "apply.cert.cap.line": "The venue funds up to {cap} for this one.",
  "apply.cert.cap.over":
    "You are asking for {ask}, which is above the {cap} listed for this certification. That is allowed — the approver decides — but say why in the box below.",
  "apply.cert.cap.pass": "A pass is required before this is reimbursed.",
  "apply.cert.cap.eligibility": "Who it is for: {note}",
  "apply.cert.notListed":
    "This is not on the funded list, so it is a request rather than a claim against an agreed offer. Nothing is wrong with that — say clearly below what it is for.",

  // ── The funding picture ─────────────────────────────────────────────────────
  "apply.cert.chart.split": "Who pays what",
  "apply.cert.chart.venue": "Asked of the venue",
  "apply.cert.chart.self": "You would fund",
  "apply.cert.chart.shortfall":
    "You would be paying {self} of this yourself. Ask for more if that is not what you intended.",
  "apply.cert.chart.whole": "You are asking the venue to fund the whole course.",
  "apply.cert.chart.agreed": "Agreed against asked",
  "apply.cert.chart.agreedHint":
    "Across {n} decided claim(s). Requests still waiting are not counted — a queue is not a refusal.",

  // ── Refusals, in the server's own terms ─────────────────────────────────────
  "apply.cert.blocked.title": "Before this can be sent",
  "apply.cert.blocked.name": "Name the certification.",
  "apply.cert.blocked.fee": "Enter what the course costs, in rupees.",
  "apply.cert.blocked.ask": "Enter what you are asking the venue for, in rupees.",
  "apply.cert.blocked.askOverFee":
    "You cannot ask for more than the course costs. Lower the amount, or correct the fee.",
  "apply.cert.blocked.reason": "Say why it is worth funding — at least {n} characters.",
  "apply.cert.blocked.dates": "The finish date cannot be before the start date.",
  "apply.cert.blocked.duplicate":
    "You already have an open claim for this certification. Wait for that one to be decided, or withdraw it first.",

  "apply.cert.send": "Send for approval",
  "apply.cert.sending": "Sending…",
  "apply.cert.done": "Your certification request has been sent",
  "apply.cert.doneDetail":
    "It goes to your reporting manager first, then to HR. You can follow it under My Approvals.",

  // ── The catalogue, as a list ────────────────────────────────────────────────
  "apply.cert.cat.title": "What the venue funds",
  "apply.cert.cat.hint":
    "Each one carries a ceiling — the most the venue will pay. A course that costs more is still worth asking about.",
  "apply.cert.cat.empty.title": "No certifications are listed yet",
  "apply.cert.cat.empty.hint":
    "The list is maintained by HR. Until it has rows, ask for what you need in the form above and it will be judged on its own.",
  "apply.cert.cat.cap": "up to {cap}",

  "apply.cert.category.professional": "Professional",
  "apply.cert.category.safety": "Safety",
  "apply.cert.category.hospitality": "Hospitality",
  "apply.cert.category.culinary": "Culinary",
  "apply.cert.category.compliance": "Compliance",
  "apply.cert.category.language": "Language",
  "apply.cert.category.other": "Other",

  // ── My own claims ───────────────────────────────────────────────────────────
  "apply.cert.mine.title": "What you have asked for",
  "apply.cert.mine.hint": "Newest first. A decision shows the amount actually agreed.",
  "apply.cert.mine.empty.title": "You have not asked for one yet",
  "apply.cert.mine.empty.hint": "Anything you send appears here with its decision.",
  "apply.cert.col.name": "Certification",
  "apply.cert.col.fee": "Course fee",
  "apply.cert.col.asked": "Asked for",
  "apply.cert.col.approved": "Agreed",
  "apply.cert.col.state": "State",
  "apply.cert.col.sent": "Sent",
  "apply.cert.col.paid": "Reimbursed",

  /*
    ── WHEN SOMETHING IS STILL MISSING ──────────────────────────────────────────
    Kept from the version of this screen that could do nothing but explain
    itself. They are not dead copy: `RequestRoutingCard` reads `approval_chains`
    live, so if anybody deactivates AC-CERTIFICATION the chain line below is what
    appears — and the fallback actions are what an employee does in the meantime.
  */
  "apply.cert.gap.chain":
    "No approval route is configured for this request, so nothing could be sent for a decision. Ask HR to switch the certification chain back on.",
  "apply.cert.alt.cta": "Make a local claim instead",
  "apply.cert.alt.ticket": "Ask HR",

  // ── When the request type is genuinely absent ───────────────────────────────
  "apply.cert.absent.title": "This request is not switched on for your company yet",
  "apply.cert.absent.hint":
    "The tables and the approval route exist, but no CERTIFICATION request type is active — so nothing could be routed. HR turns it on; until then a local claim under Miscellaneous is the honest route.",
} as const;
