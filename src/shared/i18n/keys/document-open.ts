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
  // ── Provisioning a portal login ───────────────────────────────────────────
  // Adding somebody in People never created an account, so this turns a dead-end
  // ("no login yet") into the action that fixes it.
  // ── Add Employee: the login created alongside the employee ────────────────
  "admin.people.add.done.loginCreated":
    "Portal login created for {email}. They start with the Employee role and must change this password on first sign-in.",
  "admin.people.add.done.tempLabel": "Temporary password",
  // The only moment it exists to be read: the function returns it once.
  "admin.people.add.done.tempOnce":
    "Shown once only — copy it now and give it to them with their employee code. If it is lost, issue a password reset; it cannot be read again.",
  "admin.people.add.done.loginPending": "The employee was created, but the login was not",
  "admin.people.add.done.loginWhere":
    "Finish it from People › Access level, where you can type a login email and confirm with your authenticator.",
  "admin.roles.login.create": "Create login",
  "admin.roles.login.creating": "Creating…",
  "admin.roles.login.emailPlaceholder": "Login email (optional)",
  "admin.roles.login.created": "Login created for {email}. They must change this on first sign-in.",
  "admin.roles.login.copy": "Copy password",
  "admin.roles.login.copied": "Copied",
  // No second chance, so it says so rather than letting somebody navigate away.
  "admin.roles.login.onceOnly":
    "Shown once only — copy it now and hand it over. If it is lost, issue a password reset; it cannot be read again.",
  "admin.roles.login.replayed":
    "This login already existed, so no new password was issued. Use a password reset if they need one.",
  // Each mismatch names its own fix, because they are different fixes.
  "admin.roles.check.teamNoRole": "People report to them but they have no manager access",
  "admin.roles.check.managerNoTeam": "Has manager access but nobody reports to them",
  "admin.roles.check.ok": "Consistent",
  "admin.roles.reasonPrompt":
    "Why is {name}'s access level changing? At least 10 characters — this is kept in the audit trail.",

  // ── Assistant history (/me/ask/history) ───────────────────────────────────
  // ── Voice ─────────────────────────────────────────────────────────────────
  "ai.voice.start": "Dictate your question",
  // Each failure needs a different action, so each says something different. "blocked" is
  // only shown after the browser has actually been asked and refused — it used to appear
  // when nothing had been asked at all, pointing people at a setting that did not exist yet.
  "ai.voice.err.unsupported": "This browser cannot listen. Type the question instead.",
  // ONE SENTENCE PER CAUSE, because each needs a different action and the old single
  // "allow it in your browser settings" sent people to a page with nothing wrong in it.
  // The padlock, not Settings: a site-level block is cleared from the address bar.
  "ai.voice.err.blockedSite":
    "This site is blocked from using the microphone. Click the padlock in the address bar, set Microphone to Allow, then reload the page.",
  // Covers both "they dismissed the prompt" and "the operating system is refusing Chrome",
  // which cannot be told apart from inside the page — so both next steps are given, the
  // second keyed to the symptom that identifies it (no prompt appeared at all).
  "ai.voice.err.dismissed":
    "The microphone was not allowed. Press the microphone button again and choose Allow. If no prompt appeared at all, your computer is blocking the browser — on a Mac, open System Settings › Privacy & Security › Microphone and switch your browser on.",
  "ai.voice.err.noDevice": "No microphone was found on this device.",
  "ai.voice.err.busy":
    "Another app is using the microphone. Close it and try again.",
  "ai.voice.err.insecure":
    "Dictation needs a secure (https) connection.",
  // The speech SERVICE declining is not a permission problem and must not be described as
  // one — there is nothing in browser settings to change.
  "ai.voice.err.service":
    "Dictation is not available in this browser. Type the question instead.",
  "ai.voice.err.silence": "I did not hear anything. Try again, a little closer to the microphone.",
  "ai.voice.err.network": "Speech recognition needs a network connection and could not reach it.",
  "ai.voice.err.generic": "Dictation stopped unexpectedly. Type the question instead.",
  "ai.voice.stop": "Stop dictating",
  // "Keeps listening" is the promise the continuous session now makes; the reader needs to
  // know nothing will cut them off mid-sentence and that stopping is their job.
  "ai.voice.listening":
    "Listening — keep talking, then press the microphone again when you have finished.",
  // Shown when the meter reads zero: the session is open and hearing nothing.
  "ai.voice.listeningSilent":
    "Listening, but not picking anything up yet — check your microphone is not muted.",
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

  // ── The equal-height card row on Home ─────────────────────────────────────
  // "Show everything" rather than "Expand": what the button does is release the
  // height cap, and that is what somebody pressing it wants named.
  "home.row.expand": "Show everything",
  "home.row.collapse": "Fit to one row",

  // ── Assistant failures, in sentences ──────────────────────────────────────
  // A zod dump used to be printed verbatim here. These say what happened and what to
  // do; the issue list goes to the console for whoever can act on it.
  "ai.error.shape":
    "The assistant built an answer this screen could not read, so nothing is shown rather than something wrong. Ask again — it usually succeeds on a second attempt.",
  "ai.error.server": "The assistant could not answer that just now. Try again shortly.",
  "ai.error.unknown": "Something went wrong while answering. Try again shortly.",
} as const;
