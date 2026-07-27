/**
 * i18n keys owned EXCLUSIVELY by the me-misc screens.
 *
 * Split out of en.ts deliberately: `t()` is typed on `keyof typeof en`, so every
 * new screen must add keys, and when several authors append to one 10k-line file
 * concurrently the last writer silently wins — that is how 297 keys were lost
 * once already. One file per author, spread into `en`, removes the race.
 *
 * Three screens live here:
 *   `meTicket.*`       — /me/helpdesk/:id  (one request thread + its SLA clock)
 *   `meSettingsHome.*` — /me/settings      (the settings landing)
 *   `meActivity.*`     — /me/activity      (my own audit trail)
 */
export const keysMeMisc = {
  // ===========================================================================
  // /me/helpdesk/:id — one thread, its conversation and its SLA clock
  // ===========================================================================
  "meTicket.title": "Ticket",
  "meTicket.subtitle": "The conversation on this request, and the clock the approver is answering against.",
  "meTicket.back": "All my requests",
  "meTicket.source":
    "There is no ticket table in this database — no helpdesk_tickets, no ticket_messages, no ticket_slas. What this screen opens is the thing that IS deployed and that carries a conversation and a service-level clock: the request you raised, its approval thread, and the SLA hours its request type sets. Nothing here is renamed to look like a help-desk queue.",
  "meTicket.notFound.title": "No thread with this reference",
  "meTicket.notFound.hint":
    "Either the reference is wrong, or the request belongs to someone else — row-level security only returns requests you raised or that name you as the subject.",
  "meTicket.notFound.action": "Open my requests",

  "meTicket.facts.title": "This request",
  "meTicket.facts.reference": "Reference",
  "meTicket.facts.type": "Request type",
  "meTicket.facts.level": "Approval level",
  "meTicket.facts.levelValue": "Level {level} of {total}",
  "meTicket.facts.submitted": "Raised",
  "meTicket.facts.firstAction": "First response",
  "meTicket.facts.decided": "Decided",
  "meTicket.facts.escalated": "Escalated",
  "meTicket.facts.waitingOn": "Waiting on",
  "meTicket.facts.raisedForMe": "Raised for you by HR",
  "meTicket.facts.amount": "Amount",
  "meTicket.facts.days": "Days",
  "meTicket.facts.decisionComment": "Decision note",
  "meTicket.facts.cancellationReason": "Withdrawal note",
  "meTicket.facts.noApprover": "Nobody is named as the current approver on this request.",

  "meTicket.sla.title": "Service level",
  "meTicket.sla.window": "{hours}h from the moment it was raised — set by the request type, not by this screen.",
  "meTicket.sla.due": "Answer due {when}",
  "meTicket.sla.escalation": "Escalates after {hours}h without an answer.",
  "meTicket.sla.noEscalation": "This type has no automatic escalation configured.",
  "meTicket.sla.settled": "The clock stopped when the request was decided.",
  "meTicket.sla.hint":
    "The due instant is the server's own sla_due_at column. The half-hourly SLA sweep is what marks a breach and escalates — this screen only reads.",

  "meTicket.thread.title": "Conversation",
  "meTicket.thread.hint":
    "Every entry is an append-only approval_actions row: nobody can edit or delete one, including the person who wrote it.",
  "meTicket.thread.empty.title": "Nothing has been said yet",
  "meTicket.thread.empty.hint": "The first reply on this request will appear here.",
  "meTicket.thread.system": "Recorded by the system",
  "meTicket.thread.atLevel": "At level {level}",
  "meTicket.thread.asDelegate": "acting as delegate",
  "meTicket.thread.asEscalation": "acting on escalation",
  "meTicket.thread.asAdmin": "administrator override",
  "meTicket.thread.you": "You",

  "meTicket.action.submit": "Raised the request",
  "meTicket.action.approve": "Approved",
  "meTicket.action.reject": "Rejected",
  "meTicket.action.request_info": "Asked you for more information",
  "meTicket.action.provide_info": "Answered the question",
  "meTicket.action.delegate": "Handed it to a delegate",
  "meTicket.action.reassign": "Reassigned it",
  "meTicket.action.escalate": "Escalated it",
  "meTicket.action.recall": "Withdrew the request",
  "meTicket.action.cancel": "Cancelled the request",
  "meTicket.action.comment": "Commented",
  "meTicket.action.auto_approve": "Approved automatically",
  "meTicket.action.skip_level": "Skipped a level",

  "meTicket.reply.title": "Add to the conversation",
  "meTicket.reply.answerTitle": "Answer the question",
  "meTicket.reply.hint":
    "Your reply is written to the trail under your own name and is readable by every approver on this request.",
  "meTicket.reply.answerHint":
    "An approver has asked you for more information. Your reply is recorded as the answer, not as a side comment.",
  "meTicket.reply.label": "Your reply",
  "meTicket.reply.placeholder": "Say what changed, or what you were asked for…",
  "meTicket.reply.send": "Post reply",
  "meTicket.reply.sending": "Posting…",
  "meTicket.reply.min": "At least {min} characters — the trail is permanent, so a reply has to say something.",
  "meTicket.reply.posted": "Your reply is on the trail.",
  "meTicket.reply.closed": "This request is closed to replies",
  "meTicket.reply.closedHint":
    "The approval function only accepts a comment while a request is pending, in progress or escalated. Raise a fresh request instead of reopening a settled one.",

  "meTicket.withdraw.action": "Withdraw this request",
  "meTicket.withdraw.title": "Withdraw {reference}?",
  "meTicket.withdraw.description":
    "The request stops here and nobody decides it. Your reason goes on the trail under your own name.",
  "meTicket.withdraw.confirm": "Withdraw",
  "meTicket.withdraw.done": "Withdrawn. The trail records who withdrew it and why.",
  "meTicket.withdraw.unavailable": "This request type does not allow withdrawal once it has been raised.",

  "meTicket.detail.title": "What this request is about",
  "meTicket.detail.hint": "The request routes a row in another table; open it for the full detail.",
  "meTicket.detail.openRow": "Open this record",
  "meTicket.detail.openScreen": "Open the screen that owns it",
  "meTicket.detail.noLink":
    "This request type has no self-service screen of its own yet, so the summary above is the whole of what you can see.",
  "meTicket.detail.summary": "Summary the server recorded",

  "meTicket.priority.low": "Low",
  "meTicket.priority.normal": "Normal",
  "meTicket.priority.high": "High",
  "meTicket.priority.urgent": "Urgent",

  "meTicket.status.draft": "Draft",
  "meTicket.status.pending": "Waiting for a first look",
  "meTicket.status.in_progress": "Being worked on",
  "meTicket.status.escalated": "Escalated",
  "meTicket.status.approved": "Approved",
  "meTicket.status.rejected": "Rejected",
  "meTicket.status.cancelled": "Cancelled",
  "meTicket.status.withdrawn": "Withdrawn",
  "meTicket.status.expired": "Expired",
  "meTicket.status.auto_approved": "Auto-approved",
  "meTicket.status.applied": "Applied",
  "meTicket.status.failed": "Failed to apply",

  // ===========================================================================
  // /me/settings — the settings landing
  // ===========================================================================
  "meSettingsHome.title": "Settings",
  "meSettingsHome.subtitle": "Your channels, your account security, and everything the system has recorded about you.",
  "meSettingsHome.notice":
    "Every number on this page is a server count over your own rows, so a card and the screen behind it cannot disagree.",

  "meSettingsHome.notif.title": "Notification preferences",
  "meSettingsHome.notif.hint": "Choose channels; some notices can't be switched off.",
  "meSettingsHome.notif.enabled": "{enabled} of {total} switched on",
  "meSettingsHome.notif.none": "No preference rows yet",
  "meSettingsHome.notif.noneHint":
    "Nothing has been created against your profile, so every notice follows the company default.",
  "meSettingsHome.notif.action": "Open preferences",

  "meSettingsHome.security.title": "Security",
  "meSettingsHome.security.hint": "Password, authenticator, passkeys, face enrolment and sign-in history.",
  "meSettingsHome.security.passkeys": "{count} passkeys registered",
  "meSettingsHome.security.noPasskeys": "No passkeys registered",
  "meSettingsHome.security.mfaOn": "Authenticator app verified",
  "meSettingsHome.security.mfaOff": "No authenticator app",
  "meSettingsHome.security.lastSignIn": "Last recorded sign-in {when}",
  "meSettingsHome.security.noSignIn": "No sign-in events recorded",
  "meSettingsHome.security.faceActive": "Face enrolled for the kiosk",
  "meSettingsHome.security.faceInactive": "No active face template",
  "meSettingsHome.security.faceNoConsent": "No biometric consent recorded",
  "meSettingsHome.security.action": "Open security",

  "meSettingsHome.activity.title": "My activity",
  "meSettingsHome.activity.hint": "Every change to your record, every read of it, and every sign-in.",
  "meSettingsHome.activity.counts":
    "{changes} change requests · {events} employment events · {reads} reads · {signIns} sign-in events",
  "meSettingsHome.activity.action": "Open my activity",

  "meSettingsHome.notifications.title": "Notification centre",
  "meSettingsHome.notifications.hint": "Everything the system has told you, newest first.",
  "meSettingsHome.notifications.unread": "{count} unread",
  "meSettingsHome.notifications.allRead": "Nothing unread",
  "meSettingsHome.notifications.action": "Open notifications",

  "meSettingsHome.profile.title": "Your profile",
  "meSettingsHome.profile.hint": "Identity, employment, payment and personal details — some fields need HR approval.",
  "meSettingsHome.profile.action": "Open my profile",

  "meSettingsHome.partial": "your account security state",
  "meSettingsHome.footnote":
    "Language and theme are not account settings yet: the catalogue ships English only, and the theme follows the switch in the top bar, which is remembered per device rather than per account.",

  // ===========================================================================
  // /me/activity — my own audit trail
  // ===========================================================================
  "meActivity.title": "My activity",
  "meActivity.subtitle": "Every change to your record, who made it and why — plus who read it, and how you signed in.",
  "meActivity.source":
    "The company audit log itself (audit_log, and the v_audit_trail_employee view over it) is readable by administrators only, so querying it here would return an empty screen that looked like “nothing happened”. This trail is assembled instead from the four relations you genuinely own: your change requests, your employment events, the register of reads of your data, and your own sign-in events.",

  "meActivity.kpi.changes": "Record changes",
  "meActivity.kpi.events": "Employment events",
  "meActivity.kpi.reads": "Reads of your data",
  "meActivity.kpi.signIns": "Sign-in events",
  "meActivity.kpi.hint": "Server count over your own rows",

  "meActivity.tabs.label": "Kinds of activity",
  "meActivity.tab.record": "Record changes",
  "meActivity.tab.reads": "Who read my data",
  "meActivity.tab.signIns": "Sign-ins",

  "meActivity.open.title": "Requested, not yet applied",
  "meActivity.open.hint": "A change request that has not been applied is a promise, not a change.",
  "meActivity.open.decision": "Decision: {comment}",

  "meActivity.record.title": "Changes that landed",
  "meActivity.record.hint":
    "Newest first. A field change shows the value before and after; an employment event shows what HR recorded, with the reason the database made them type.",
  "meActivity.record.empty.title": "No changes recorded yet",
  "meActivity.record.empty.hint":
    "When a field on your record changes, or HR records an employment event, it appears here.",
  "meActivity.record.notSet": "(not set)",
  "meActivity.record.reversed": "later reversed",
  "meActivity.record.because": "because: {reason}",

  "meActivity.actor.you": "You",
  "meActivity.actor.hrForYou": "HR, on your behalf",
  "meActivity.actor.hr": "HR",
  "meActivity.actor.system": "The system",

  "meActivity.reads.title": "Who read your details, and why",
  "meActivity.reads.hint":
    "Every reveal, export or report that touched your sensitive fields, with the actor's name and the written purpose they had to give first.",
  "meActivity.reads.empty.title": "Nobody has revealed your sensitive fields",
  "meActivity.reads.empty.hint":
    "A masked value on a screen is not a read. This register fills only when someone unmasks, exports or reports on your record.",
  "meActivity.reads.col.when": "When",
  "meActivity.reads.col.who": "Who",
  "meActivity.reads.col.what": "What",
  "meActivity.reads.col.kind": "How",
  "meActivity.reads.col.purpose": "Stated purpose",
  "meActivity.reads.fields": "{count} fields",
  "meActivity.reads.records": "{count} records",
  "meActivity.reads.noPurpose": "No purpose recorded",

  "meActivity.signIns.title": "Sign-ins and account events",
  "meActivity.signIns.hint":
    "Written by the server-side sign-in paths only, so this list can be shorter than the number of times you have signed in. A sign-in you do not recognise is worth a password change.",
  "meActivity.signIns.empty.title": "No sign-in events recorded",
  "meActivity.signIns.empty.hint": "Sign in from the kiosk or with a passkey and the event will be recorded here.",
  "meActivity.signIns.col.when": "When",
  "meActivity.signIns.col.event": "Event",
  "meActivity.signIns.col.method": "Method",
  "meActivity.signIns.col.ip": "From",
  "meActivity.signIns.col.device": "Device",
  "meActivity.signIns.action": "Manage your account security",

  "meActivity.event.loginSuccess": "Signed in",
  "meActivity.event.loginFailed": "Sign-in failed",
  "meActivity.event.logout": "Signed out",
  "meActivity.event.tokenRefresh": "Session refreshed",
  "meActivity.event.resetRequested": "Password reset requested",
  "meActivity.event.passwordChanged": "Password changed",
  "meActivity.event.passkeyRegistered": "Passkey registered",
  "meActivity.event.passkeyUsed": "Signed in with a passkey",
  "meActivity.event.mfaChallenge": "Second factor challenged",
  "meActivity.event.sessionRevoked": "Session revoked",

  "meActivity.partial.open": "your open change requests",
} as const;
