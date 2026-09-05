/**
 * i18n keys owned EXCLUSIVELY by the combined-leave-application work. One file per author —
 * `t()` is typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Surface: `/me/leave/apply-combined`.
 *
 * EVERY PROBLEM SENTENCE NAMES THE NUMBER OR THE TYPE. "Insufficient balance" tells an
 * employee nothing; "Week-off has only 0.5 day available" tells them what to change. These
 * mirror refusals the database also makes, so the wording is deliberately close to the
 * server's own messages.
 */
export const keysLeaveApplication = {
  "shell.nav.applyLeave": "Apply for leave",
  "leave.app.title": "Apply for leave",
  "leave.app.subtitle":
    "Say how many days you want, then choose which balances they come from. You can combine types.",
  "leave.app.myLeave": "My leave",

  "leave.app.step1": "1 · How many days do you want?",
  "leave.app.days": "Days",
  "leave.app.startOn": "Starting",
  "leave.app.suggest": "Fill from my balances",
  "leave.app.daysHint":
    "Half days are allowed. Pick your dates below and the weekly offs and holidays inside them are shown and excluded before you submit.",
  "leave.app.whichHalf": "Which half of the day?",
  "leave.app.half.first": "First half",
  "leave.app.half.second": "Second half",
  "leave.app.whichHalfHint":
    "If you already have the other half of this date booked, choosing the opposite half here makes it a full day off.",
  "leave.app.half.firstLower": "first half",
  "leave.app.half.secondLower": "second half",

  "leave.app.booked.takenHalf":
    "You already have the {held} of {date} booked ({number}). Only the {free} is free — apply for that and the day becomes a full day off.",
  "leave.app.booked.makesFullDay":
    "You already have the {held} of {date} booked as {type} ({number}). This application takes the {free}, which makes it a full day off.",
  "leave.app.booked.switchTo": "Apply for the {free}",
  "leave.app.booked.makeItHalf": "Ask for 0.5 instead",
  "leave.app.blocked.halfTaken":
    "You already hold the {held} of this date — choose the {free} instead.",
  "leave.app.blocked.dateFull":
    "{date} is already fully booked ({number}). Pick another date.",
  "leave.app.blocked.onlyHalfFree":
    "Only the {free} of {date} is still free ({number}). Ask for 0.5 of a day to take it.",
  "leave.app.blocked.rangeBooked":
    "You already have leave booked on {date} ({number}). Choose dates that do not include it.",

  "leave.app.step2": "2 · Where should these days come from?",
  "leave.app.allPlaced": "All days placed",
  "leave.app.leftToPlace": "{days} still to place",
  "leave.app.overBy": "{days} too many",
  "leave.app.available": "{days} available",
  "leave.app.unpaid": "Unpaid — no balance needed",
  "leave.app.mustBeAlone": "must be taken on its own",
  "leave.app.daysFrom": "Days from {type}",
  "leave.app.exclusiveLock":
    "{type} has to be taken on its own, so the other types are switched off. Clear it to combine types instead.",

  "leave.app.step3": "3 · Why, and who to contact",
  /*
    Two labels for one field. Migration 041600 put `requires_reason` on the leave
    TYPE — true for Sick Leave, false for everything else — so the form says
    which of the two this application is, rather than demanding a sentence for a
    week-off nobody needs an explanation for.
  */
  "leave.app.monthlyCap": "max {days}/month",
  "leave.app.cap.balance":
    "You have {days} day(s) of {type} left, and a leave balance cannot go negative.",
  "leave.app.cap.monthly": "{type} allows at most {days} day(s) in one month.",
  "leave.app.cap.use": "Ask for {days} day(s) instead",
  "leave.app.blocked.title": "Before you can send this",
  "leave.app.blocked.noDays": "Say how many days you want.",
  "leave.app.blocked.handover":
    "Your department needs someone named to cover for you — pick a colleague under \u201cWho is covering for you\u201d.",
  "leave.app.blocked.reason":
    "Sick leave needs a reason of at least 10 characters — you have typed {n}.",
  "leave.app.blocked.noSegments":
    "These dates cannot carry the split. Change the dates or the amounts.",
  "leave.app.reduce.hint":
    "You asked for {asked} day(s) and only {placed} can be covered by your balances.",
  "leave.app.reduce.action": "Ask for {days} day(s) instead",
  "leave.app.reason": "Reason",
  "leave.app.reason.optional": "Reason (optional)",
  "leave.app.reasonPlaceholder": "e.g. family function out of town",
  "leave.app.reasonHint": "Sick leave needs a reason — at least 10 characters.",
  "leave.app.reasonHint.optional": "Leave it blank if you would rather not say.",
  "leave.app.contact": "Contact while away (optional)",
  "leave.app.handover": "Handover notes (optional)",

  "leave.app.submit": "Send for approval",
  "leave.app.submitHint": "Your approver sees this as one application.",
  "leave.app.done": "Sent for approval — {n} request(s) in this application.",
  "leave.app.refused": "The server refused this application",

  "leave.app.problem.noTotal": "Enter how many days you want first.",
  "leave.app.problem.nothing": "Choose where the days should come from.",
  "leave.app.problem.under": "{days} day(s) still need a leave type.",
  "leave.app.problem.over": "You have allocated {days} day(s) more than you asked for.",
  "leave.app.problem.halfStep": "{type}: use whole or half days only.",
  "leave.app.problem.noHalf": "{type} cannot be taken as a half day.",
  "leave.app.problem.insufficient": "{type} has only {available} day(s) available.",
  "leave.app.problem.minimum": "{type} needs at least {min} day(s) per request.",
  "leave.app.problem.exclusive":
    "{type} must be taken on its own and cannot be combined with another leave type.",
} as const;

/** Added after the first cut: cover, address, and the loss-of-pay escape. */
export const keysLeaveApplicationExtra = {
  "leave.app.takeLwp": "Take the remaining {days} day(s) as loss of pay",
  "leave.app.coveredBy": "Who is covering for you",
  "leave.app.coveredByNone": "— nobody —",
  "leave.app.coveredByHint": "Required in operational departments.",
  "leave.app.address": "Where you will be (optional)",
  "leave.app.handoverPlaceholder": "What your stand-in needs to know",
} as const;

/** Mentioning peers on an application (migration 039800). */
export const keysLeaveMentions = {
  "leave.app.mention": "Mention colleagues (optional)",
  "leave.app.mentionHint":
    "Each person you pick is notified that you named them on this leave. It does not ask them to approve anything.",
} as const;

/**
 * The from–to range picker (migration 039900).
 *
 * EVERY SENTENCE HERE NAMES A DATE OR A NUMBER. "Weekly offs are excluded" is a policy
 * statement; "2 of these days are your weekly offs and cost you nothing" is an answer. The
 * employee is deciding whether to take Friday to Tuesday, and the only useful reply is what
 * that costs them.
 */
export const keysMobileNav = {
  /** Bottom-bar label: "My Attendance" is 91px, and five tabs have 64px each on a 320px phone. */
  "shell.nav.attendanceShort": "Attendance",
} as const;

export const keysLeaveRange = {
  "leave.app.range.title": "Which dates?",
  "leave.app.range.from": "From",
  "leave.app.range.to": "To",
  "leave.app.range.pickEnd": "Pick the last day on the calendar, or type it above.",
  "leave.app.range.gridLabel": "Choose the first and last day of your leave",
  "leave.app.range.prevMonth": "Previous month",
  "leave.app.range.nextMonth": "Next month",
  "leave.app.range.weeklyOff": "Weekly off",
  "leave.app.range.holiday": "Holiday",
  "leave.app.range.loading": "checking your weekly offs…",
  "leave.app.range.paintFailed": "Could not load your weekly offs — the dates below are still checked on submit.",

  "leave.app.range.counted": "{days} day(s) of leave",
  "leave.app.range.countedOf": "{counted} of {span} days count",
  "leave.app.range.freeNone": "Nothing in these dates is free — every day counts.",
  "leave.app.range.freeSome":
    "{free} day(s) inside these dates cost you nothing: {weeklyOffs} weekly off, {holidays} holiday.",
  "leave.app.range.perDate": "Day by day",
  "leave.app.range.perType": "Which dates come from which balance",
  "leave.app.range.perTypeHint":
    "Each of these is filed as its own request under one application, because a request carries one leave type and two requests cannot share a date.",
  "leave.app.range.segmentDays": "{days} day(s)",
  "leave.app.range.notCounted": "not counted",

  "leave.app.range.problem.incomplete": "Choose both a first and a last day.",
  "leave.app.range.problem.inverted": "The last day cannot be before the first day.",
  "leave.app.range.problem.tooLong": "{days} days is too long to apply for in one go.",
  "leave.app.range.problem.notEnoughDates":
    "This split needs {needed} separate dates and these dates give {available}. Two half days of different types each need a date of their own — lengthen the dates, or take one of them as a full day.",

  "leave.app.range.mismatchMore":
    "These dates cost {counted} day(s), but you have placed {allocated}. Change the dates or the split — the server counts the dates.",
  "leave.app.range.mismatchLess":
    "These dates cost {counted} day(s) and you have only placed {allocated}. Place the rest, or shorten the dates.",
  "leave.app.range.useCounted": "Use {days}",
} as const;
