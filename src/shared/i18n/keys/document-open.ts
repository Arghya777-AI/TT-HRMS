/**
 * i18n keys owned EXCLUSIVELY by the document opener — `DocumentOpenButtons` and
 * `documentAccess.api.ts`.
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`, so
 * two people appending to one catalogue silently lose each other's keys.
 *
 * MOST OF THIS COPY IS REFUSALS, and each says something DIFFERENT on purpose. A
 * single "couldn't open that" would collapse four situations that call for four
 * different actions: re-upload it, ask HR, leave it alone, or try again. The one
 * that matters most here is `fileMissing` — this deployment has seeded records whose
 * bytes were never stored, and calling that a system error makes people retry
 * forever instead of uploading the file.
 */
export const keysDocumentOpen = {
  "docs.open.view": "View",
  "docs.open.download": "Download",
  "docs.open.viewAria": "View {name} in a new tab",
  "docs.open.downloadAria": "Download {name}",
  "docs.open.thisDocument": "this document",

  // ── Refusals, each with its own next step ─────────────────────────────────
  // The record is real; the file behind it is not. Re-upload is the fix.
  "docs.open.error.fileMissing":
    "This record has no file stored against it, so there is nothing to open. Upload the file to fix it.",
  "docs.open.error.noFile": "No file has been attached to this record yet.",
  // Never openable, by anyone. Not phrased as a permission problem, because it is not.
  "docs.open.error.infected":
    "The virus scanner flagged this file, so it cannot be opened. Ask HR to replace it.",
  // Deliberately the same sentence whether it is absent or not visible to you —
  // the caller must not learn that a document they cannot see exists.
  "docs.open.error.notFound": "That document is not available to you.",
  "docs.open.error.generic": "We could not open that document just now. Try again shortly.",

  // ── The review decision (Approval Queue) ─────────────────────────────────
  // Two words, not "Verify"/"Decline": the status values are approved/rejected and
  // the button should say what the row will say afterwards.
  "admin.docs.pend.approve": "Approve",
  "admin.docs.pend.reject": "Reject",
  // The prompt names the audience, because this sentence is shown to the EMPLOYEE
  // and is the only thing telling them what to fix.
  "admin.docs.pend.rejectPrompt":
    "Why is this being rejected? The employee will see this, so say what they need to fix (at least 10 characters).",

  // ── The topbar bell ───────────────────────────────────────────────────────
  // Spoken as well as shown: a coloured dot is not information to a screen reader.
  "shell.topbar.notificationsUnread": "Notifications, {n} unread",

  // ── Role assignment (People directory) ────────────────────────────────────
  "admin.roles.title": "Access level",
  "admin.roles.subtitle.ok":
    "Who can see what. A manager sees their own team; an admin sees the whole organisation.",
  "admin.roles.subtitle.mismatch":
    "{n} to check — the org chart and the access level disagree for these people.",
  "admin.roles.empty": "Nobody to show.",
  "admin.roles.col.person": "Person",
  "admin.roles.col.access": "Access",
  "admin.roles.col.reportees": "Reports to them",
  "admin.roles.col.check": "Check",
  "admin.roles.col.set": "Change to",
  // HR and admin are deliberately the same role, as asked.
  "admin.roles.role.employee": "Employee",
  "admin.roles.role.manager": "Manager",
  "admin.roles.role.admin": "HR / Admin",
  "admin.roles.role.superAdmin": "Super admin",
  "admin.roles.role.noLogin": "No login yet",
  "admin.roles.adminOnly": "Only an admin can change this",
  "admin.roles.noAccount": "No login yet, so no access level to set",
  // Each mismatch names its own fix, because they are different fixes.
  "admin.roles.check.teamNoRole": "People report to them but they have no manager access",
  "admin.roles.check.managerNoTeam": "Has manager access but nobody reports to them",
  "admin.roles.check.ok": "Consistent",
  "admin.roles.reasonPrompt":
    "Why is {name}'s access level changing? At least 10 characters — this is kept in the audit trail.",

  // ── Assistant history (/me/ask/history) ───────────────────────────────────
  // ── Voice ─────────────────────────────────────────────────────────────────
  "ai.voice.start": "Dictate your question",
  "ai.voice.stop": "Stop dictating",
  "ai.voice.listening": "Listening — say your question, then check it before sending.",
  // Chromium sends the audio to Google; Safari and iOS do it on the device. Said
  // plainly, because the audio is somebody talking about their own pay.
  "ai.voice.cloudHint":
    "Dictate your question. On this browser the audio is transcribed by Google, not on your device.",
  "ai.voice.localHint": "Dictate your question. The audio is transcribed on your device.",
  "ai.voice.readAloud": "Read aloud",
  "ai.voice.stopReading": "Stop reading",
  "ai.history.link": "Past conversations",
  "ai.history.title": "Your conversations",
  "ai.history.subtitle":
    "Everything you have asked the assistant, kept so you can read it back. Open one to see the whole exchange, or download it.",
  "ai.history.askNew": "Ask something new",
  "ai.history.untitled": "Untitled conversation",
  "ai.history.you": "You",
  "ai.history.assistant": "Assistant",
  "ai.history.meta": "{turns} messages · last activity {when}",
  "ai.history.archived": "archived",
  "ai.history.archiveAria": "Archive the conversation \u201c{name}\u201d",
  "ai.history.restoreAria": "Restore the conversation \u201c{name}\u201d",
  "ai.history.showArchived": "Show {n} archived",
  "ai.history.hideArchived": "Hide archived",
  "ai.history.empty.title": "No conversations yet",
  "ai.history.empty.hint": "Ask the assistant something and it will appear here.",
  "ai.history.emptyTranscript": "This conversation has no messages to show.",
  // Never silent about a gap: a transcript missing a turn must not read as complete.
  "ai.history.redacted":
    "{n} message(s) are not shown here because their content was removed.",
  "ai.history.export.title": "Assistant conversation",
  "ai.history.col.when": "When",
  "ai.history.col.who": "Who",
  "ai.history.col.said": "Message",

  // ── Punch card ────────────────────────────────────────────────────────────
  // A disclosure, not a deletion: the mechanics stay in the page for search and for
  // a screen reader. The biometric honesty sentence is NOT behind this.
  "me.punch.howItWorks": "How this works",
} as const;
