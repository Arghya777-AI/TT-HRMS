/**
 * i18n keys owned EXCLUSIVELY by the me-apply screens.
 *
 * Split out of en.ts deliberately: `t()` is typed on `keyof typeof en`, so every
 * new screen must add keys, and when several authors append to one 10k-line file
 * concurrently the last writer silently wins — that is how 297 keys were lost
 * once already. One file per author, spread into `en`, removes the race.
 *
 * Scope: the three P2 request screens — `/me/apply/travel`,
 * `/me/apply/resignation` and `/me/apply/tax`. The shared `apply.*` copy those
 * screens reuse (`apply.back`, `apply.routing.*`, `apply.mine.title`,
 * `apply.type.*`, `apply.claim.col.*`, `apply.claim.status.*`) already lives in
 * en.ts and is NOT restated here — one sentence, one home.
 */
export const keysMeApply = {
  // ---------------------------------------------------------------------------
  // E-10.5 /me/apply/travel — the requisition the schema cannot hold, and the
  // claim route travel money actually takes.
  // ---------------------------------------------------------------------------
  "apply.travel.title": "Travel requisition",
  "apply.travel.subtitle": "Trip request with advance and estimated cost.",

  /*
    Shown only when `approval_chains` comes back empty for this type — which,
    since migration 041100 seeded AC-TRAVEL, means somebody has deactivated it
    rather than that the feature was never built. Worded as a live fault to
    report, not as a permanent gap to accept.
  */
  "apply.travel.gap.chain":
    "No active approval chain is configured for Travel Requisition right now, so the workflow engine has nobody to route the trip to and will refuse the request. Tell an administrator — AC-TRAVEL should be active.",

  "apply.travel.alt.title": "Claim the money once the trip is done",
  "apply.travel.alt.hint":
    "An approved requisition is permission to travel, not a payment. Keep the receipts, and once you are back claim the actual spend under Travel — it can now be settled against this trip rather than filed loose.",
  "apply.travel.alt.cta": "Claim travel expense",

  "apply.travel.caps.title": "Three figures this screen will not make up",
  "apply.travel.caps.policy":
    "The maximum advance. It would live on a travel policy table, and there is no travel policy table.",
  "apply.travel.caps.grade":
    "The per-grade estimated-cost cap. No column in the schema holds a travel cap for a grade.",
  "apply.travel.caps.advance":
    "The second approval above ₹10,000. That threshold is an approval-chain band, and this request type has no chain to band.",

  "apply.travel.kind.local": "Expense claim",
  "apply.travel.kind.settlement": "Requisition settlement",
  "apply.travel.col.kind": "Kind",
  "apply.travel.col.travelled": "Travelled",
  "apply.travel.col.requisition": "Requisition",

  "apply.travel.ledger.title": "Your travel claims",
  "apply.travel.ledger.hint":
    "Every claim you have raised under the Travel head. The Requisition column stays empty for all of them — a settlement claim needs a requisition id, and requisitions have nowhere to live.",
  "apply.travel.ledger.empty.title": "No travel claims yet",
  "apply.travel.ledger.empty.hint":
    "Claim a trip's fares, hotel or cab under the Travel head and it will appear here with the reference the server issues.",

  "apply.travel.mine.empty.title": "No travel requisition in flight",
  "apply.travel.mine.empty.hint":
    "Nothing is waiting on anybody — and nothing can be, until the requisition table and its approval chain exist.",

  "apply.travel.ready.title": "What a migration has to add",
  "apply.travel.ready.hint": "In this order. Nothing on this screen is guessing at it.",
  "apply.travel.ready.item1":
    "The travel_requisitions table itself — purpose, trip type, cities, dates, mode, estimated cost and advance — with a self-insert policy and a server-minted reference number.",
  "apply.travel.ready.item2":
    "An approval chain for Travel Requisition with its levels, plus the amount bands that decide when a second approver is engaged.",
  "apply.travel.ready.item3":
    "A travel policy table for the advance ceiling, and a per-grade cost cap, so a screen can quote a limit instead of omitting one.",
  "apply.travel.ready.item4":
    "The settlement link: a real foreign key from reimbursement_claims.travel_requisition_id, which today is a loose uuid pointing at nothing.",

  // ---------------------------------------------------------------------------
  // E-10.3 /me/apply/resignation — notice facts that are real, a submission
  // that is not.
  // ---------------------------------------------------------------------------
  "apply.resign.title": "Resignation",
  "apply.resign.subtitle": "Notice period, last working day and clearance.",

  "apply.resign.gap.title": "A resignation cannot be submitted from here yet",
  "apply.resign.gap.table":
    "The request type points at a table called resignations, and no migration creates it — the name exists only inside a CHECK constraint and the seed row. Every approval request must name a detail row.",
  "apply.resign.gap.chain":
    "No approval chain is configured for Resignation, so the workflow engine has nobody to route it to and refuses the request outright.",
  "apply.resign.gap.clearance":
    "Clearance checklists and the exit interview have no tables either. What the database does hold is one boolean for the interview, shown below exactly as it is.",

  "apply.resign.alt.title": "Tell HR, and it becomes a record",
  "apply.resign.alt.hint":
    "A resignation is filed as a lifecycle event, which is what moves you to On notice and stamps your resignation date. Only HR can write that event — so speak to HR, and watch it appear in your lifecycle record below.",
  "apply.resign.alt.cta": "See what you can raise today",

  "apply.resign.notice.title": "Your notice period",
  "apply.resign.notice.empty.title": "No employee record on this account",
  "apply.resign.notice.empty.hint":
    "Notice period, joining date and exit status all hang off an employee record, and this sign-in has none. HR links the two.",
  "apply.resign.days": "{days} days",

  "apply.resign.fact.mine": "On your record",
  "apply.resign.fact.grade": "For your grade, {grade}",
  "apply.resign.fact.gradeNone": "For your grade — none assigned",
  "apply.resign.fact.gradeHidden": "For your grade — retired, so not readable",
  "apply.resign.fact.contract": "In your signed contract {ref}",
  "apply.resign.fact.contractNone": "In your signed contract — none signed",
  "apply.resign.fact.earliest": "Earliest last working day",
  "apply.resign.fact.earliest.source": "today in IST + the notice on your record",

  "apply.resign.notice.disagree.title": "These figures do not agree",
  "apply.resign.notice.disagree.hint":
    "The number on your own record is the one HR and payroll read. The grade's and the contract's are shown beside it so the difference is yours to raise, not something a screen quietly picked for you.",
  "apply.resign.notice.binding":
    "The figure on your own record is the one HR and payroll read. The other two are shown so you can see they agree.",

  "apply.resign.exit.title": "Where your exit stands",
  "apply.resign.exit.none":
    "Nothing is on file: no resignation date, no last working day and no exit type. That is the expected state while you are still employed.",

  "apply.resign.fact.joined": "Joined",
  "apply.resign.fact.resignationDate": "Resignation date",
  "apply.resign.fact.lwd": "Last working day",
  "apply.resign.fact.exitType": "Exit type",
  "apply.resign.fact.interview": "Exit interview done",
  "apply.resign.fact.fnf": "Full and final settled",
  "apply.resign.fact.gratuity": "Gratuity eligible from",
  "apply.resign.fact.exitReason": "Reason on file:",
  "apply.resign.yes": "Yes",
  "apply.resign.no": "No",

  "apply.resign.col.effective": "Effective",
  "apply.resign.col.event": "Event",
  "apply.resign.col.reason": "Reason recorded",
  "apply.resign.col.recorded": "Filed",
  "apply.resign.event.reversed": "Reversed",

  "apply.resign.events.title": "Your lifecycle record",
  "apply.resign.events.hint":
    "The append-only stream your employment status is derived from. A resignation appears here as its own event, and corrections arrive as new events rather than edits.",
  "apply.resign.events.empty.title": "No lifecycle events on file",
  "apply.resign.events.empty.hint":
    "Joining, confirmation, transfers and exits are all filed here by HR. An empty list means none has been recorded against you yet.",

  "apply.resign.mine.empty.title": "No resignation in flight",
  "apply.resign.mine.empty.hint":
    "Nothing is waiting on anybody — and nothing can be, until the resignation table and its approval chain exist.",

  "apply.resign.ready.title": "What a migration has to add",
  "apply.resign.ready.hint": "In this order. Nothing on this screen is guessing at it.",
  "apply.resign.ready.item1":
    "The resignations table — intended last working day, reason, notice served and any waiver sought — with a self-insert policy and a server-minted reference.",
  "apply.resign.ready.item2":
    "An approval chain for Resignation with its levels, so a manager and HR are named rather than assumed.",
  "apply.resign.ready.item3":
    "Clearance templates and clearance items, so departments can sign off in the system instead of on paper.",
  "apply.resign.ready.item4":
    "An exit interview table. Today there is one boolean, which can record that an interview happened but nothing of what was said.",

  // ---------------------------------------------------------------------------
  // E-10.6 /me/apply/tax — the regime election really submits; the full
  // declaration is a named gap.
  // ---------------------------------------------------------------------------
  "apply.tax.title": "Income tax",
  "apply.tax.subtitle": "Regime election; full declarations arrive in a later phase.",

  "apply.tax.regime.old": "Old regime",
  "apply.tax.regime.new": "New regime",
  "apply.tax.regime.old.hint":
    "Narrower zero-tax band, but deductions such as 80C, 80D and HRA are allowed.",
  "apply.tax.regime.new.hint":
    "Wider zero-tax band and a larger standard deduction, with most deductions given up.",

  "apply.tax.status.draft": "Draft",
  "apply.tax.status.pending": "Waiting for HR",
  "apply.tax.status.approved": "Approved by HR",
  "apply.tax.status.applied": "Applied to your record",
  "apply.tax.status.rejected": "Declined",
  "apply.tax.status.cancelled": "Withdrawn",
  "apply.tax.status.failed": "Could not be applied",

  "apply.tax.current.title": "Your regime today",
  "apply.tax.current.hint":
    "Read from your statutory record — the same value payroll pins when it projects your monthly TDS.",
  "apply.tax.current.fy": "FY {fy}",
  "apply.tax.current.open": "Election open",
  "apply.tax.current.locked": "Locked for FY {fy}",
  "apply.tax.current.empty.title": "No statutory record yet",
  "apply.tax.current.empty.hint":
    "Your regime, PAN and PF details live on a statutory record HR creates. Until it exists there is no regime to change.",

  "apply.tax.flag.pfYes": "PF applicable",
  "apply.tax.flag.pfNo": "PF not applicable",
  "apply.tax.flag.esiYes": "ESI applicable",
  "apply.tax.flag.esiNo": "ESI not applicable",
  "apply.tax.flag.ptYes": "Professional tax · {state}",
  "apply.tax.flag.ptNo": "Professional tax not applicable",
  "apply.tax.flag.lwfYes": "Labour welfare fund applicable",
  "apply.tax.flag.lwfNo": "Labour welfare fund not applicable",

  "apply.tax.form.title": "Elect your regime",
  "apply.tax.field.regime": "Which regime should payroll use?",
  "apply.tax.field.regime.hint":
    "Two values, and only two — the database allows old or new and nothing else.",
  "apply.tax.field.isCurrent": "This is what payroll uses for you today.",
  "apply.tax.field.note": "Why you are changing it",
  "apply.tax.field.note.placeholder":
    "e.g. I have no 80C investments this year, so the new regime leaves me better off.",
  "apply.tax.field.note.hint":
    "At least 10 characters. HR reads this on the approval, so say enough to make the election obvious.",

  "apply.tax.route.title": "How this is routed",
  "apply.tax.route.hint":
    "The election is filed as a per-field change request against your statutory record and sent to HR for approval — the same maker-checker path a bank-account change takes. HR sets the value once it is approved; the approval itself is the record of your election.",

  "apply.tax.refused.title": "The election was not accepted",

  "apply.tax.blocked.title": "Before this can be sent",
  "apply.tax.blocked.noStatutory":
    "You have no statutory record yet, so there is no regime to change. HR creates it.",
  "apply.tax.blocked.locked":
    "Your regime is locked for FY {fy}. A locked election is changed by HR, not from here.",
  "apply.tax.blocked.pick": "Choose a regime.",
  "apply.tax.blocked.same": "That is already your regime — pick the other one.",
  "apply.tax.blocked.note": "Say why you are changing it, in at least 10 characters.",
  "apply.tax.blocked.chain":
    "No approval chain is configured for Profile Change, so the workflow engine has nobody to send this to and would refuse it.",

  "apply.tax.submit": "Send the election to HR",
  "apply.tax.submitting": "Sending…",
  "apply.tax.submit.hint":
    "The reference is issued by the server when the request is created. Nothing is numbered in your browser.",

  "apply.tax.done.title": "Election sent — {ref}",
  "apply.tax.done.hint":
    "It is now with HR. Your regime changes when HR approves and sets it; until then payroll keeps using the value on your record.",

  "apply.tax.ladders.title": "What each regime looks like",
  "apply.tax.ladders.hint":
    "The rate set in force today, read from the statutory settings payroll computes TDS against. Annual figures. Nothing here is applied to your salary — this screen projects no tax.",
  "apply.tax.ladders.empty.title": "No rate set on file",
  "apply.tax.ladders.empty.hint":
    "The statutory rate set carries the slabs, the standard deduction and the cess. Until one is effective there is nothing to compare.",
  "apply.tax.ladders.source": "Rate set effective from {from}.",

  "apply.tax.ladder.yours": "Yours today",
  "apply.tax.ladder.undecodable":
    "The stored rate ladder is not in the shape this screen knows how to read, so it is not shown rather than shown wrongly.",
  "apply.tax.ladder.standardDeduction": "Standard deduction",
  "apply.tax.ladder.rebateThreshold": "Section 87A up to",
  "apply.tax.ladder.rebateAmount": "Section 87A rebate",
  "apply.tax.ladder.cess": "Health and education cess",
  "apply.tax.ladder.caption": "Annual slabs and rates for the {regime}.",
  "apply.tax.ladder.slab": "Annual income",
  "apply.tax.ladder.rate": "Rate",
  "apply.tax.ladder.above": "and above",

  "apply.tax.col.raised": "Raised",
  "apply.tax.col.change": "Change asked for",
  "apply.tax.col.state": "State",
  "apply.tax.col.effective": "Effective from",
  "apply.tax.col.applyNote": "Applied",

  "apply.tax.ledger.title": "Your regime elections",
  "apply.tax.ledger.hint":
    "Every election you have raised, straight from the change-request table. The Applied column shows when your record was updated, or what stopped it.",
  "apply.tax.ledger.empty.title": "No election on file",
  "apply.tax.ledger.empty.hint":
    "Your regime is whatever HR set when your statutory record was created. Elect a different one above and it will appear here.",

  "apply.tax.mine.hint":
    "Elections travel as profile changes, so a bank-account or profile request you raised appears in the same list.",
  "apply.tax.mine.empty.title": "Nothing waiting on HR",
  "apply.tax.mine.empty.hint":
    "No profile or statutory change of yours is undecided. An election you send above shows up here within seconds.",

  "apply.tax.declaration.title": "Full investment declaration",
  /*
    THE THREE GAP BULLETS ARE GONE, and they were wrong. Migration 041300 created
    `income_tax_declarations` with all eleven section columns, a GENERATED total,
    `proof_document_ids`, the self RLS policies AND the approval chain. The notice
    predated it and was never revisited.
  */
  "apply.tax.decl.hint":
    "Declare what you intend to claim this year. Amounts are DECLARED, not verified — HR checks them against your proofs and the Act when they approve, so nothing here is a limit on what you may enter.",
  "apply.tax.decl.section.80c": "80C — PF, ELSS, insurance, tuition",
  "apply.tax.decl.section.80ccd1b": "80CCD(1B) — NPS",
  "apply.tax.decl.section.80d": "80D — health insurance",
  "apply.tax.decl.section.80dd": "80DD — dependant with disability",
  "apply.tax.decl.section.80ddb": "80DDB — specified illness",
  "apply.tax.decl.section.80e": "80E — education loan interest",
  "apply.tax.decl.section.80eeb": "80EEB — electric vehicle loan",
  "apply.tax.decl.section.80g": "80G — donations",
  "apply.tax.decl.section.80tta": "80TTA — savings interest",
  "apply.tax.decl.section.24b": "24B — home loan interest",
  "apply.tax.decl.section.hraRent": "HRA — rent paid this year",
  "apply.tax.decl.landlordPan": "Landlord's PAN",
  "apply.tax.decl.landlordPanHint":
    "Required once the rent you claim passes ₹1,00,000 for the year — that rule is in the Act, not a setting here.",
  "apply.tax.decl.otherHeading": "Income from elsewhere",
  "apply.tax.decl.otherHint":
    "These ADD to your taxable income rather than reducing it, which is why they sit apart from the deductions above.",
  "apply.tax.decl.otherIncome": "Other income",
  "apply.tax.decl.prevIncome": "Previous employer's income",
  "apply.tax.decl.prevTds": "Previous employer's TDS",
  "apply.tax.decl.note": "Anything HR should know",
  "apply.tax.decl.mix": "What you have declared",
  "apply.tax.decl.total": "{total} declared in total — added up by the database, not by this page.",
  "apply.tax.decl.saveDraft": "Save as draft",
  "apply.tax.decl.send": "Send to HR",
  "apply.tax.decl.sending": "Sending…",
  "apply.tax.decl.saved": "Draft saved",
  "apply.tax.decl.savedDetail": "{total} declared so far. It is not with HR until you send it.",
  "apply.tax.decl.sent": "Declaration sent to HR",
  "apply.tax.decl.sentDetail": "You can follow it under Approvals. HR checks it against your proofs.",
  "apply.tax.decl.reason.submit": "Filing my investment declaration for {fy}.",
  "apply.tax.decl.reason.draft": "Saving a draft of my investment declaration for {fy}.",
  "apply.tax.decl.blockers": "This declaration cannot be sent yet",
  "apply.tax.decl.need.fy": "The financial year could not be read, so there is nothing to file against.",
  "apply.tax.decl.need.something": "Declare at least one amount before sending it.",
  "apply.tax.decl.need.pan": "Rent above ₹1,00,000 for the year needs your landlord's PAN.",
  "apply.tax.decl.locked":
    "This declaration is {status} and can no longer be edited. Ask HR if something needs to change.",
  "apply.tax.declaration.gap.title": "Declarations and proofs are not switched on yet",
  "apply.tax.declaration.gap.table":
    "The IT Declaration request type points at a table called income_tax_declarations, and no migration creates it — the name exists only inside a CHECK constraint and the seed row.",
  "apply.tax.declaration.gap.chain":
    "No approval chain is configured for IT Declaration either, so even with a table the request could not be routed.",
  "apply.tax.declaration.gap.proofs":
    "There is nowhere to declare a section-wise amount (80C, 80D, 80CCD(1B), 24B, HRA, LTA) and nowhere to attach a proof against it. Until those land, payroll computes TDS on the regime alone.",
} as const;
