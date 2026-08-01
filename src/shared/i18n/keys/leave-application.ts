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
    "Half days are allowed. Weekly offs and holidays inside your dates are worked out by the system, not counted against you here.",

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
  "leave.app.reason": "Reason",
  "leave.app.reasonPlaceholder": "e.g. family function out of town",
  "leave.app.reasonHint": "At least 10 characters.",
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
