/**
 * i18n keys owned EXCLUSIVELY by the admin-face-enrol work. One file per author — `t()` is
 * typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Surface: the per-employee face-enrolment console inside `/admin/kiosk/enrolment`
 * (`FaceEnrolmentConsole`), plus the two strings the shared `EnrolCapture` needed
 * once it could be pointed at one employee and had to survive an MFA step-up.
 */
export const keysAdminFaceEnrol = {
  // ── Console shell ─────────────────────────────────────────────────────────
  "admin.faceEnrol.title": "Per-employee enrolment console",
  "admin.faceEnrol.subtitle":
    "Pick a person to see exactly where their face enrolment stands, and act on it: consent, invitation, capture, approval, revocation.",
  "admin.faceEnrol.dpdp":
    "Biometric processing under the DPDP Act 2023. Consent at the current notice version is a precondition the server enforces — no consent row, no template. Nothing here ever shows or logs a face descriptor.",
  "admin.faceEnrol.ceremony.title": "The order of ceremony",
  "admin.faceEnrol.ceremony.body":
    "1 · record consent · 2 · invite the employee, or capture straight away · 3 · capture five guided poses · 4 · a second administrator approves the set before the gate will match it.",

  // ── Loading the audited biometric detail ──────────────────────────────────
  "admin.faceEnrol.load": "Load biometric detail",
  "admin.faceEnrol.loadHint":
    "Template metadata comes from the face-template-admin function, which records a data-access row against your name for every read. It is loaded for the person you open, when you ask for it — never on navigation.",
  "admin.faceEnrol.loaded": "{count} template version(s) loaded for the person on screen.",
  "admin.faceEnrol.stepUp.title": "A second factor is needed",
  "admin.faceEnrol.stepUp.hint":
    "Managing face templates carries a step-up in the capability table. Verify your authenticator code and the read will run.",
  "admin.faceEnrol.stepUp.verify": "Verify and continue",

  // ── Roster list ───────────────────────────────────────────────────────────
  "admin.faceEnrol.search": "Search name or code",
  "admin.faceEnrol.filter.label": "Show",
  "admin.faceEnrol.filter.all": "Everyone",
  "admin.faceEnrol.filter.enrolled": "Enrolled",
  "admin.faceEnrol.filter.awaiting": "Awaiting approval",
  "admin.faceEnrol.filter.notEnrolled": "Not enrolled",
  "admin.faceEnrol.filter.noConsent": "Consent missing",
  "admin.faceEnrol.filter.withdrawn": "Consent withdrawn",
  "admin.faceEnrol.filter.excluded": "Off the gate",
  "admin.faceEnrol.list.count": "{shown} of {total} people",
  "admin.faceEnrol.list.empty.title": "Nobody matches this filter",
  "admin.faceEnrol.list.empty.hint": "Clear the search, or choose a different state.",
  "admin.faceEnrol.roster.empty.title": "No enrollable employees",
  "admin.faceEnrol.roster.empty.hint":
    "A face can only be enrolled for an employee who is joining or in service. Add the person first.",

  // ── Status vocabulary ─────────────────────────────────────────────────────
  "admin.faceEnrol.status.enrolled": "Enrolled",
  "admin.faceEnrol.status.awaiting_approval": "Awaiting approval",
  "admin.faceEnrol.status.not_enrolled": "Not enrolled",
  "admin.faceEnrol.status.no_consent": "Consent missing",
  "admin.faceEnrol.status.consent_withdrawn": "Consent withdrawn",
  "admin.faceEnrol.status.excluded": "Off the gate",

  // ── KPIs ──────────────────────────────────────────────────────────────────
  "admin.faceEnrol.kpi.enrolled": "Enrolled",
  "admin.faceEnrol.kpi.enrolledHint": "An active template the gate can match.",
  "admin.faceEnrol.kpi.awaiting": "Awaiting approval",
  "admin.faceEnrol.kpi.notEnrolled": "Not enrolled",
  "admin.faceEnrol.kpi.notEnrolledHint":
    "No template on file. Consent may not be known until the biometric detail is loaded for the person.",
  "admin.faceEnrol.kpi.noConsent": "Consent missing",
  "admin.faceEnrol.kpi.withdrawn": "Consent withdrawn",
  "admin.faceEnrol.kpi.withdrawnHint":
    "A lawful choice, never chased. These people punch by the alternative method.",

  // ── Detail header ─────────────────────────────────────────────────────────
  "admin.faceEnrol.pick.title": "Pick a person",
  "admin.faceEnrol.pick.hint":
    "Choose someone on the left to see their consent, their template and what you may do next.",
  "admin.faceEnrol.detail.department": "Department",
  "admin.faceEnrol.detail.joined": "Joined",
  "admin.faceEnrol.detail.status": "Employment",
  "admin.faceEnrol.detail.email": "Work email",
  "admin.faceEnrol.detail.noEmail": "None on file",
  "admin.faceEnrol.detail.excluded":
    "This employee is excluded from gate attendance, so a face template would never be used. Enrol only if that exclusion is about to be lifted.",

  // ── Consent block ─────────────────────────────────────────────────────────
  "admin.faceEnrol.consent.heading": "Biometric consent",
  "admin.faceEnrol.consent.granted": "Granted",
  "admin.faceEnrol.consent.withdrawn": "Withdrawn",
  "admin.faceEnrol.consent.none": "Not on file",
  "admin.faceEnrol.consent.unknown": "Not known here",
  "admin.faceEnrol.consent.unknownHint":
    "There is no consent view an admin browser may read. Load the biometric detail above and the notice version arrives with the template.",
  "admin.faceEnrol.consent.grantedAt": "Given",
  "admin.faceEnrol.consent.withdrawnAt": "Withdrawn",
  "admin.faceEnrol.consent.notice": "Notice version",
  "admin.faceEnrol.consent.record": "Record consent",
  "admin.faceEnrol.consent.recordTitle": "Record biometric consent for {name}",
  "admin.faceEnrol.consent.recordDescription":
    "You are attesting that this employee read the current biometric notice and accepted it. Consent at a newer notice version withdraws the earlier row with your reason attached — it is never deleted.",
  "admin.faceEnrol.consent.recorded": "Consent recorded at notice version {version}.",
  "admin.faceEnrol.consent.already": "Consent was already on file at notice version {version}.",
  "admin.faceEnrol.consent.withdrawnNote":
    "This employee withdrew consent. Do not enrol them; re-taking consent is their decision to make, not an administrator's.",

  // ── Template block ────────────────────────────────────────────────────────
  "admin.faceEnrol.template.heading": "Face template",
  "admin.faceEnrol.template.none": "No template on file.",
  "admin.faceEnrol.template.notLoaded":
    "The employee record says a template was activated. Load the biometric detail above for its version, quality and age.",
  "admin.faceEnrol.template.version": "Version",
  "admin.faceEnrol.template.state": "State",
  "admin.faceEnrol.template.quality": "Quality",
  "admin.faceEnrol.template.samples": "{count} samples",
  "admin.faceEnrol.template.enrolledAt": "Captured",
  "admin.faceEnrol.template.approvedAt": "Approved",
  "admin.faceEnrol.template.enrolledBy": "by {name}",
  "admin.faceEnrol.template.ageLabel": "Age",
  "admin.faceEnrol.template.age": "{days} days old",
  "admin.faceEnrol.template.ageToday": "Captured today",
  "admin.faceEnrol.template.ageUnknown": "Age unknown",
  // `employees.face_enrolled_at` is the APPROVAL instant, not the capture — a set
  // captured last week and approved this morning is not "captured today". These
  // three keys exist so the summary line above the audited read cannot contradict
  // the capture age shown on the set card once that read lands.
  "admin.faceEnrol.template.approvedAgeLabel": "Age since approval",
  "admin.faceEnrol.template.approvedAge": "approved {days} days ago",
  "admin.faceEnrol.template.approvedAgeToday": "approved today",
  "admin.faceEnrol.template.history": "Earlier versions",

  // ── Reference photo reveal ────────────────────────────────────────────────
  "admin.faceEnrol.reveal.button": "Show reference photo",
  "admin.faceEnrol.reveal.title": "Reveal the enrolment photo for {name}",
  "admin.faceEnrol.reveal.description":
    "A signed link is minted for 60 seconds and one data-access row is written against your name for this employee. Say why you need to see the face.",
  "admin.faceEnrol.reveal.expiry": "This link expires in about a minute. Reveal again if it lapses.",
  "admin.faceEnrol.reveal.none":
    "No reference photo could be signed — the template has none, or it has been purged.",
  "admin.faceEnrol.reveal.alt": "Enrolment reference photo for {name}",
  "admin.faceEnrol.reveal.noCap":
    "Revealing a face needs the biometric.template.manage capability, which your role does not hold.",
  "admin.faceEnrol.reveal.hide": "Hide photo",

  // ── Invitation (admin-initiated request) ──────────────────────────────────
  "admin.faceEnrol.invite.heading": "Enrolment request",
  "admin.faceEnrol.invite.button": "Initiate enrolment",
  "admin.faceEnrol.invite.title": "Ask {name} to enrol",
  "admin.faceEnrol.invite.description":
    "This records an enrolment request against this employee, visible to them in their own security settings and to every administrator here. It captures nothing by itself.",
  "admin.faceEnrol.invite.created": "Enrolment request recorded.",
  "admin.faceEnrol.invite.open": "Invited {when} — no capture yet",
  "admin.faceEnrol.invite.pending": "Captured {when} — awaiting approval",
  "admin.faceEnrol.invite.none": "No open request.",
  "admin.faceEnrol.invite.exists": "An enrolment request is already open for this employee.",
  "admin.faceEnrol.invite.noConsentHint":
    "Record consent first — the enrolment function refuses a capture without it.",
  "admin.faceEnrol.invite.captureless":
    "An invitation carries no reference photo. That column is NOT NULL because the table was designed for employee-initiated, capture-first requests, so a reserved placeholder is stored and shown here as absent.",
  "admin.faceEnrol.invite.fulfil": "Mark fulfilled",
  "admin.faceEnrol.invite.fulfilTitle": "Close the invitation for {name}",
  "admin.faceEnrol.invite.fulfilDescription":
    "The capture happened, so the invitation is spent. This closes the request; it does not approve the template.",
  "admin.faceEnrol.invite.fulfilled": "Invitation closed.",
  "admin.faceEnrol.invite.cancel": "Cancel request",
  "admin.faceEnrol.invite.cancelTitle": "Cancel the enrolment request for {name}",
  "admin.faceEnrol.invite.cancelDescription":
    "The employee is no longer being asked to enrol. The row stays as evidence, marked cancelled with your reason.",
  "admin.faceEnrol.invite.cancelled": "Enrolment request cancelled.",
  "admin.faceEnrol.invite.history": "Earlier requests",
  "admin.faceEnrol.request.draft": "Invited",
  "admin.faceEnrol.request.pending": "Awaiting approval",
  "admin.faceEnrol.request.applied": "Fulfilled",
  "admin.faceEnrol.request.cancelled": "Cancelled",
  "admin.faceEnrol.request.approved": "Approved",
  "admin.faceEnrol.request.rejected": "Rejected",

  // ── Notifying the employee ────────────────────────────────────────────────
  "admin.faceEnrol.notify.button": "Send the notice",
  "admin.faceEnrol.notify.title": "Notify {name} that enrolment is required",
  "admin.faceEnrol.notify.description":
    "Sends the seeded FACE_ENROLMENT_REQUIRED notice to this employee's work email through the communications function. One recipient, transactional, audited.",
  "admin.faceEnrol.notify.sent": "Notice accepted for {name}: {count} recipient(s), {sent} sent.",
  "admin.faceEnrol.notify.noEmail":
    "No work email on file, so there is nothing to send to. Tell them at the HR desk; the request itself is already recorded and visible in their own security settings.",
  "admin.faceEnrol.notify.unconfigured":
    "No email transport is configured on this project (RESEND_API_KEY is unset), so the notice could not leave the system. The enrolment request is recorded regardless.",
  "admin.faceEnrol.notify.inAppGap":
    "In-app notifications are inserted by the service role only — the table is partitioned and no browser-callable producer exists — so the employee learns of this from their security settings and this email, not from a bell badge.",

  // ── Register now ──────────────────────────────────────────────────────────
  "admin.faceEnrol.register.heading": "Register now",
  "admin.faceEnrol.register.hint":
    "Five guided poses on this console's camera. The set is stored as pending and matches nobody until it is approved.",
  "admin.faceEnrol.register.open": "Open the camera for {name}",
  "admin.faceEnrol.register.close": "Close the camera",
  "admin.faceEnrol.register.needConsent":
    "Consent has to be on file before the camera is any use — the server refuses the capture otherwise.",
  "admin.faceEnrol.register.noCap":
    "Capturing a face needs the biometric.enrol capability, which your role does not hold.",
  "admin.faceEnrol.register.blockedPending":
    "A captured set is already awaiting approval for this employee. Approve or reject it before capturing another.",

  // ── Template decisions ────────────────────────────────────────────────────
  "admin.faceEnrol.action.approve": "Approve",
  "admin.faceEnrol.action.approveTitle": "Activate v{version} for {name}",
  "admin.faceEnrol.action.approveDescription":
    "Activating makes this face matchable at the gate and retires the previous version. Quality is {band} across {samples} samples.",
  "admin.faceEnrol.action.approved": "Template activated for {name}.",
  "admin.faceEnrol.action.reject": "Reject",
  "admin.faceEnrol.action.rejectTitle": "Reject the pending set for {name}",
  "admin.faceEnrol.action.rejectDescription":
    "The set is retired unused. The employee stays unenrolled and can be captured again.",
  "admin.faceEnrol.action.retire": "Revoke",
  "admin.faceEnrol.action.retireTitle": "Revoke v{version} for {name}",
  "admin.faceEnrol.action.retireDescription":
    "The gate stops matching this face immediately. The row and its history are kept; nothing is deleted.",
  "admin.faceEnrol.action.retired": "Template revoked for {name}.",
  "admin.faceEnrol.action.reenrol": "Revoke all and re-enrol",
  "admin.faceEnrol.action.reenrolTitle": "Force re-enrolment for {name}",
  "admin.faceEnrol.action.reenrolDescription":
    "Every version this employee has is retired and the enrolment flag on their record is cleared, so the coverage list picks them up again. Use this when the face on file is no longer trustworthy.",
  "admin.faceEnrol.action.reenrolled": "All templates revoked for {name}.",
  "admin.faceEnrol.action.purgeElsewhere":
    "Irreversible erasure is not here: it lives on the Template Purge screen, super-admin only.",

  // ── EnrolCapture additions ────────────────────────────────────────────────
  "admin.faceEnrol.capture.forEmployee": "Enrolling {name}",
  "admin.faceEnrol.capture.stepUpNeeded":
    "Enrolment needs a fresh second factor. Verify the code and the capture is submitted as it stands.",
  "shell.nav.admin.faceKiosk": "Face & kiosk",
  "admin.emp360.enrolFace": "Enrol face",
  "admin.emp360.enrolFace.hint": "Register or review this employee's face on this device.",
  "admin.enrolCap.poseTooFarYaw": "Turn back towards the camera a little — that is too far to the side.",
  "admin.enrolCap.poseTooFarPitch": "Lift your chin a little — that is tilted too far.",
  "admin.enrolCap.poseTooFarRoll": "Straighten your head a little — it is tilted to one side.",
  "admin.faceEnrol.inlineConsent.heading": "First, the biometric notice",
  "admin.faceEnrol.inlineConsent.body": "{name} needs to have signed the biometric notice before a face can be registered. They are with you now — confirm they have signed it and the camera opens straight away.",
  "admin.faceEnrol.inlineConsent.button": "They have signed — continue",
  "admin.faceEnrol.inlineConsent.confirm": "Records consent against the current notice version, witnessed by you, then opens the camera. Required by law before biometric data is processed.",
  "me.faceAsk.draft.title": "HR has asked you to register your face",
  "me.faceAsk.draft.body": "Attendance at the gate can then recognise you, and you can mark yourself in and out from this portal. Registration is done by an administrator on their own device, with you present — see HR or the security desk. You will be asked to confirm you have signed the biometric notice first.",
  "me.faceAsk.pending.title": "Your face registration is awaiting approval",
  "me.faceAsk.pending.body": "The capture has been taken. An administrator has to approve it before it can be used at the gate or in this portal. Nothing more is needed from you.",
  "me.faceAsk.asked": "Asked {at}",
  "admin.enrolCap.tooFar": "Come a little closer — your face needs to fill more of the frame.",
  "admin.enrolCap.tooDark": "It is too dark. Face a window or turn on a light.",
  "admin.enrolCap.tooBright": "Too bright — move out of direct light or away from the window.",
  "admin.enrolCap.tooBlurry": "Hold still for a moment — the image is not sharp enough.",
  "admin.enrolCap.lowContrast": "The picture is washed out. Try a different background or more even light.",
  "admin.enrolCap.lowScore": "Looking for a clear view of your face…",
  "admin.faceEnrol.waiting.title": "{count} capture(s) are registered but not yet active",
  "admin.faceEnrol.waiting.body": "A face does not work at the gate or in the portal until its capture is activated. Admin-led captures now activate themselves, so these are either kiosk captures (which queue for review on purpose) or ones whose activation did not complete. Pick a name to open it and activate.",
  "admin.punch.col.location": "Location",
  "admin.punch.location.none": "Not shared",
  "admin.punch.location.inside": "Inside the venue",
  "admin.punch.location.outside": "Outside the venue — flagged",
  "admin.punch.location.notChecked": "Not checked — venue coordinates not set",
} as const;
