/**
 * i18n keys owned EXCLUSIVELY by the kiosk-admin screens.
 *
 * Split out of en.ts deliberately: `t()` is typed on `keyof typeof en`, so every
 * new screen must add keys, and when several authors append to one 10k-line file
 * concurrently the last writer silently wins — that is how 297 keys were lost
 * once already. One file per author, spread into `en`, removes the race.
 *
 * Scope of this file: the three kiosk GOVERNANCE screens
 * (`/admin/kiosk/{abuse,policy,purge}`) and the link-based GATE SCANNER at
 * `/kiosk` (the `kiosk.gate.*` block at the end). The six older kiosk screens
 * keep their strings in en.ts; nothing here re-declares one of those keys,
 * because a duplicate would be silently overridden by the spread order — which
 * is why the scanner's keys are namespaced `kiosk.gate.*` and reuse the existing
 * `kiosk.pair.*`, `kiosk.keypad.*` and `kiosk.scan.*` guidance lines rather than
 * restating them in a second voice.
 *
 * House rules followed by every sentence below (spec-screens D-10/DR-53):
 *   * No raw enum, column or SQLSTATE ever reaches a reader. `spoof_rejected`
 *     becomes "Spoof rejected", `kiosk_manual` becomes "Guard-assisted".
 *   * Every empty state names the action or the reassurance, never just "None".
 *   * Every destructive sentence says what is destroyed and that it cannot be
 *     undone, in the same breath.
 */
export const keysKioskAdmin = {
  // ---------------------------------------------------------------------------
  // /admin/kiosk/abuse — Abuse Review Queue
  // ---------------------------------------------------------------------------
  "admin.kiosk.abuse.title": "Abuse Review Queue",
  "admin.kiosk.abuse.subtitle":
    "Scans the gate flagged, refused or filed as suspicious — and the guard-assisted punches worth watching.",
  "admin.kiosk.abuse.evidenceNotice":
    "A void is a correction, never a deletion: the scan stays exactly where it was with four extra columns saying who voided it, when and why. There is no un-void — a scan voided in error is fixed by recording a manual punch. Voided scans are invisible on the Punch Log, so this is the only screen that shows them.",
  "admin.kiosk.abuse.partial": "employee, device and guard names",
  "admin.kiosk.abuse.tabs": "Abuse signal",
  "admin.kiosk.abuse.tab.withCount": "{label} · {count}",
  "admin.kiosk.abuse.tab.flagged": "Flagged, undecided",
  "admin.kiosk.abuse.tab.spoof": "Spoof rejected",
  "admin.kiosk.abuse.tab.duplicate": "Duplicate suppressed",
  "admin.kiosk.abuse.tab.dayLimit": "Beyond day limit",
  "admin.kiosk.abuse.tab.guard": "Guard-assisted",
  "admin.kiosk.abuse.showing": "Showing {shown} of {total} scans in {month}.",
  "admin.kiosk.abuse.showing.unknown": "Showing the scans recorded in {month}.",

  "admin.kiosk.abuse.kpi.flagged": "Flagged, undecided",
  "admin.kiosk.abuse.kpi.flaggedHint": "The gate wrote the punch and asked for a human.",
  "admin.kiosk.abuse.kpi.spoof": "Spoof rejected",
  "admin.kiosk.abuse.kpi.spoofHint": "Voided as a presentation attack — a photo, a screen, a mask.",
  "admin.kiosk.abuse.kpi.duplicate": "Duplicate suppressed",
  "admin.kiosk.abuse.kpi.duplicateHint": "Same person again inside the duplicate window.",
  "admin.kiosk.abuse.kpi.dayLimit": "Beyond day limit",
  "admin.kiosk.abuse.kpi.dayLimitHint": "More accepted scans than one employee-day allows.",
  "admin.kiosk.abuse.kpi.guard": "Guard-assisted",
  "admin.kiosk.abuse.kpi.guardHint": "Punched by the guard, not by a face. The buddy-punch route.",

  "admin.kiosk.abuse.gate.title": "Refused at the gate",
  "admin.kiosk.abuse.gate.hint":
    "These attempts never became punches at all, so they are not in the queue below — they are counted from the device-day health rows.",
  "admin.kiosk.abuse.kpi.liveness": "Liveness failures",
  "admin.kiosk.abuse.kpi.livenessFormula":
    "Sum of liveness_failures over every device-day health row in the month.",
  "admin.kiosk.abuse.kpi.suppressed": "Duplicates suppressed at the gate",
  "admin.kiosk.abuse.kpi.suppressedFormula":
    "Sum of duplicates_suppressed over every device-day health row in the month.",
  "admin.kiosk.abuse.kpi.gateNumbers": "{value} across {rows} device-day rows in {month}.",

  "admin.kiosk.abuse.col.when": "Scanned at (IST)",
  "admin.kiosk.abuse.col.employee": "Identified as",
  "admin.kiosk.abuse.col.signals": "What the gate flagged",
  "admin.kiosk.abuse.col.device": "Gate",
  "admin.kiosk.abuse.col.operator": "Guard on duty",
  "admin.kiosk.abuse.col.confidence": "Confidence",
  "admin.kiosk.abuse.col.state": "State",
  "admin.kiosk.abuse.col.actions": "Action",

  "admin.kiosk.abuse.signal.needsReview": "Marked for review",
  "admin.kiosk.abuse.signal.duplicate": "Linked to an earlier scan",
  "admin.kiosk.abuse.signal.guardAssisted": "Guard-assisted",
  "admin.kiosk.abuse.signal.offlineReplay": "Synced from the offline queue",
  "admin.kiosk.abuse.signal.clockSkew": "Device clock drifted",
  "admin.kiosk.abuse.signal.none": "No flag on this scan",

  "admin.kiosk.abuse.state.live": "Counted",
  "admin.kiosk.abuse.state.voided": "Voided",
  "admin.kiosk.abuse.state.voidedAt": "Voided {at}",
  "admin.kiosk.abuse.state.voidedNoTime": "Voided (time not recorded)",
  "admin.kiosk.abuse.alreadyVoided": "Already voided",

  "admin.kiosk.abuse.action.void": "Void scan",
  "admin.kiosk.abuse.voidCode.label": "File the next void under",
  "admin.kiosk.abuse.voidCode.hint":
    "This is the machine-readable code the void is filed under, not a filter. Spoof rejected is the default here because this is the screen where a presentation attack gets recorded.",
  "admin.kiosk.abuse.dialog.title": "Void {name}'s scan at {at}",
  "admin.kiosk.abuse.dialog.description":
    "Filed as {code}. The scan stays in the log, the day is recomputed, and this sentence goes into the audit trail with your name.",
  "admin.kiosk.abuse.dialog.confirm": "Void this scan",
  "admin.kiosk.abuse.done.voided": "Scan voided and filed as {code}. The day recomputes on its own.",

  "admin.kiosk.abuse.empty.title": "Nothing under “{label}” in {month}",
  "admin.kiosk.abuse.empty.hint.flagged":
    "Every flagged scan for this month has been decided. New flags appear here as the gate raises them.",
  "admin.kiosk.abuse.empty.hint.spoof":
    "No presentation attack was recorded this month. Liveness failures refused at the gate are counted above.",
  "admin.kiosk.abuse.empty.hint.duplicate":
    "No repeat scan was voided this month. The duplicate window is set on the Matching & Liveness Policy screen.",
  "admin.kiosk.abuse.empty.hint.dayLimit":
    "Nobody exceeded the accepted-scan ceiling for a single day this month.",
  "admin.kiosk.abuse.empty.hint.guard":
    "Every punch this month came from a face, not from a guard tapping a name.",

  "admin.kiosk.abuse.footnote.title": "What is not on this screen.",
  "admin.kiosk.abuse.footnote.hint":
    "No face, and no frame. A punch photo is a sixty-second signed URL that writes its own access record, so it is never opened from a list. Low-confidence and ambiguous identifications live on Match Review, which shows the engine's decision and the threshold in force at the time.",

  // ---------------------------------------------------------------------------
  // /admin/kiosk/policy — Matching & Liveness Policy
  // ---------------------------------------------------------------------------
  "admin.kiosk.policy.title": "Matching & Liveness Policy",
  "admin.kiosk.policy.subtitle":
    "The thresholds the gate reads before it accepts a face, and the limits the tablets run under.",
  "admin.kiosk.policy.governance":
    "Changing a threshold changes who the gate lets in without a guard. The three matching rows are super-admin only, every change needs a typed reason, and the reason lands in the audit trail with your name against it.",
  "admin.kiosk.policy.adminHint":
    "You can read every value here. Confidence, margin and liveness are locked to a super admin — the row itself says so, so nothing is typed and then refused.",
  "admin.kiosk.policy.empty.title": "No kiosk settings on this company",
  "admin.kiosk.policy.empty.hint":
    "The nine kiosk rows are seeded with the company. If none exist, the gate is running on its built-in defaults and the seed needs re-checking.",

  "admin.kiosk.policy.kpi.confidence": "Minimum confidence",
  "admin.kiosk.policy.kpi.confidenceHint": "Below this, the guard decides — the gate will not.",
  "admin.kiosk.policy.kpi.margin": "Minimum runner-up margin",
  "admin.kiosk.policy.kpi.marginHint": "How far ahead the best match must be from the second.",
  "admin.kiosk.policy.kpi.liveness": "Liveness check",
  "admin.kiosk.policy.kpi.livenessHint": "Whether a live face is required, or a photo would pass.",
  "admin.kiosk.policy.kpi.livenessOn": "Required",
  "admin.kiosk.policy.kpi.livenessOff": "Not required",
  "admin.kiosk.policy.kpi.debounce": "Duplicate window",
  "admin.kiosk.policy.kpi.debounceHint": "A second scan inside this window is voided, not counted.",
  "admin.kiosk.policy.seconds": "{n}s",

  "admin.kiosk.policy.rule.title": "What the gate does with these numbers",
  "admin.kiosk.policy.rule.accept":
    "A scan is accepted on its own only when confidence reaches {confidence} AND the gap to the second-best face reaches {margin}. The gate applies the tablet's own floor when it has one, and this company floor otherwise.",
  "admin.kiosk.policy.rule.ambiguous":
    "Anything short of that is recorded as ambiguous or unmatched and waits for the guard. Every attempt is kept with the threshold that was in force at that moment, so a later policy change cannot rewrite a past decision.",
  "admin.kiosk.policy.rule.livenessOn":
    "Liveness is required: a phone screen or a printed photo is refused before any identity is considered, and the refusal is counted on the Abuse Review Queue.",
  "admin.kiosk.policy.rule.livenessOff":
    "Liveness is NOT required. A photograph held to the camera can be accepted as the person. Turn this on before the gate runs unattended.",
  "admin.kiosk.policy.rule.debounce":
    "A second accepted scan for the same person within {seconds} seconds is written and immediately voided as a duplicate, so nothing is lost and the day is not double-counted.",
  "admin.kiosk.policy.rule.history":
    "Every change to these values is a reason-required audit row. The Audit Timeline is the history of this screen.",
  "admin.kiosk.policy.action.matchReview": "Match Review",
  "admin.kiosk.policy.action.analytics": "Kiosk Analytics",
  "admin.kiosk.policy.action.audit": "Audit Timeline",

  "admin.kiosk.policy.section.matching": "Matching",
  "admin.kiosk.policy.section.matchingHint":
    "The two numbers that decide whether a face is accepted without a human. Super-admin only.",
  "admin.kiosk.policy.section.liveness": "Liveness",
  "admin.kiosk.policy.section.livenessHint":
    "Whether the camera must satisfy itself that the face in front of it is alive.",
  "admin.kiosk.policy.section.duplicates": "Duplicate scans",
  "admin.kiosk.policy.section.duplicatesHint":
    "How close together two scans of the same person have to be before the second is treated as a repeat.",
  "admin.kiosk.policy.section.fleet": "Offline and health limits",
  "admin.kiosk.policy.section.fleetHint":
    "What a tablet may queue while it has no network, how often it reports in, and when silence becomes an alert.",
  "admin.kiosk.policy.section.evidence": "Scan evidence",
  "admin.kiosk.policy.section.evidenceHint":
    "How long a punch photo is kept, and how briefly a signed link to one stays valid.",
  "admin.kiosk.policy.section.other": "Other kiosk settings",
  "admin.kiosk.policy.section.otherHint":
    "Kiosk rows this screen does not group yet. Shown rather than hidden, because an unlisted setting still changes the gate.",

  "admin.kiosk.policy.devices.title": "Per-gate floors",
  "admin.kiosk.policy.devices.hint":
    "Each tablet carries its own accept floor. It is changed on Kiosk Devices, which is the one super-admin write path to that column — this screen reads it so a gate cannot quietly sit below the company policy.",
  "admin.kiosk.policy.devices.looseWarning":
    "{count} gate(s) accept faces below the company floor of {floor}: {codes}. Those tablets are letting through matches this policy wanted a guard to confirm.",
  "admin.kiosk.policy.devices.empty.title": "No gates registered",
  "admin.kiosk.policy.devices.empty.hint":
    "Register a tablet on Kiosk Devices and pair it before these thresholds mean anything at the door.",
  "admin.kiosk.policy.col.device": "Gate",
  "admin.kiosk.policy.col.floor": "Accept floor",
  "admin.kiosk.policy.col.against": "Against company policy",
  "admin.kiosk.policy.col.operator": "Guard required",
  "admin.kiosk.policy.col.queue": "Offline queue cap",
  "admin.kiosk.policy.col.state": "Pairing",
  "admin.kiosk.policy.floor.matches": "Matches policy",
  "admin.kiosk.policy.floor.stricter": "Stricter than policy",
  "admin.kiosk.policy.floor.looser": "Looser than policy",
  "admin.kiosk.policy.floor.unset": "No floor set",
  "admin.kiosk.policy.floor.unknown": "Company floor unreadable",
  "admin.kiosk.policy.operator.required": "Guard required",
  "admin.kiosk.policy.operator.unattended": "Unattended",
  "admin.kiosk.policy.device.live": "Paired",
  "admin.kiosk.policy.device.revoked": "Revoked",

  "admin.kiosk.policy.limits.title": "Two things this build does not have.",
  "admin.kiosk.policy.limits.hint":
    "There is no per-employee threshold override — the schema has no such column, so a twin cannot be given a private floor here. And a threshold change does not draw a marker on the analytics chart; the audit trail is where the change is proved.",

  // ---------------------------------------------------------------------------
  // /admin/kiosk/purge — Template Purge (super admin)
  // ---------------------------------------------------------------------------
  "admin.kiosk.purge.title": "Template Purge",
  "admin.kiosk.purge.subtitle":
    "Destroy an employee's face templates for good — the DPDP erasure path, fully audited.",
  "admin.kiosk.purge.warning.title": "This cannot be undone.",
  "admin.kiosk.purge.warning.body":
    "A purge overwrites the stored face measurements with zeros, overwrites the archived copies of them, deletes the enrolment photos, and takes the employee off the gate. Nothing can rebuild them: the person has to enrol again from scratch, with fresh consent.",
  "admin.kiosk.purge.fourEyes.title": "Two people, one record.",
  "admin.kiosk.purge.fourEyes.hint":
    "Name the second super admin who authorised this erasure. No endpoint takes a second approver for a purge, so their name is written into the audited reason itself — that is where a second pair of eyes can actually be proved. Both of you should be looking at this screen.",

  "admin.kiosk.purge.superOnly.title": "Only a super admin may purge a biometric",
  "admin.kiosk.purge.superOnly.hint":
    "This is the one action an administrator can never hold. Ask a super admin, or manage template versions on Face Templates, where retiring a version stops the gate matching it without destroying anything.",

  "admin.kiosk.purge.load.title": "Load the enrolment register",
  "admin.kiosk.purge.load.hint":
    "Reading template metadata is itself an audited biometric access, so it does not happen just because you opened this screen. Loading records that you looked — nothing more; no face measurement can reach a browser.",
  "admin.kiosk.purge.load.action": "Load register",
  "admin.kiosk.purge.stepUp.title": "Confirm your authenticator first",
  "admin.kiosk.purge.stepUp.hint":
    "Biometric access needs a fresh second factor. Enter your six-digit code and the register loads.",
  "admin.kiosk.purge.stepUp.action": "Enter code",
  "admin.kiosk.purge.partial": "the second-super-admin list",
  "admin.kiosk.purge.empty.title": "Nobody is enrolled",
  "admin.kiosk.purge.empty.hint":
    "There is no face template on file, so there is nothing to erase. The Enrolment Queue is where templates begin.",

  "admin.kiosk.purge.kpi.enrolled": "People with templates",
  "admin.kiosk.purge.kpi.enrolledHint": "Everyone who has ever been enrolled, purged or not.",
  "admin.kiosk.purge.kpi.versions": "Template versions on file",
  "admin.kiosk.purge.kpi.versionsHint": "Counted by the server across every state.",
  "admin.kiosk.purge.kpi.peers": "Super admins who can counter-sign",
  "admin.kiosk.purge.kpi.peersHint": "Live grants, excluding you. Zero means a purge must wait.",

  "admin.kiosk.purge.step1.title": "1 · Choose the person",
  "admin.kiosk.purge.step1.hint":
    "Only people with a template appear here. The number after the code is how many versions still hold face measurements.",
  "admin.kiosk.purge.field.subject": "Employee",
  "admin.kiosk.purge.field.subjectPlaceholder": "Select an enrolled employee",
  "admin.kiosk.purge.field.subjectHint":
    "Changing the person clears the confirmation below, so a code typed for one employee can never authorise another.",
  "admin.kiosk.purge.subject.option": "{name} · {code} — {live} live",

  "admin.kiosk.purge.step2.title": "2 · Exactly what will be destroyed for {code}",
  "admin.kiosk.purge.step2.hint":
    "Read this list against the person in front of you before you type anything below.",
  "admin.kiosk.purge.preview.live": "Versions to be destroyed",
  "admin.kiosk.purge.preview.liveHint": "Face measurements still stored for this person.",
  "admin.kiosk.purge.preview.purged": "Already destroyed",
  "admin.kiosk.purge.preview.purgedHint": "Purged earlier; the row survives as evidence.",
  "admin.kiosk.purge.preview.gate": "At the gate today",
  "admin.kiosk.purge.preview.gateOpen": "Recognised",
  "admin.kiosk.purge.preview.gateShut": "Not recognised",
  "admin.kiosk.purge.preview.gateHint":
    "After a purge the gate stops recognising them and they need another way to punch.",
  "admin.kiosk.purge.preview.consent": "Biometric consent",
  "admin.kiosk.purge.preview.consentOnFile": "On file",
  "admin.kiosk.purge.preview.consentWithdrawn": "Withdrawn",
  "admin.kiosk.purge.preview.consentHint":
    "The consent record is NOT deleted — it is the proof the enrolment was lawful.",

  "admin.kiosk.purge.col.version": "Version",
  "admin.kiosk.purge.col.state": "State",
  "admin.kiosk.purge.col.samples": "Samples",
  "admin.kiosk.purge.col.enrolled": "Enrolled",
  "admin.kiosk.purge.col.purged": "Face measurements",
  "admin.kiosk.purge.col.actions": "Action",
  "admin.kiosk.purge.state.present": "Still stored",
  "admin.kiosk.purge.alreadyPurged": "Already purged",

  "admin.kiosk.purge.effect.descriptors":
    "{versions} stored face measurement(s) are overwritten with zeros. The version row stays, as evidence that a template existed and was destroyed.",
  "admin.kiosk.purge.effect.archive":
    "Every archived copy of those measurements is overwritten too — a purge that leaves the archive intact is not a purge.",
  "admin.kiosk.purge.effect.captures":
    "The enrolment photos are deleted from the private bucket, and the paths on the rows are cleared.",
  "admin.kiosk.purge.effect.enrolledAt":
    "The employee's enrolment date is cleared once nothing active remains, so the gate and the coverage reports agree.",
  "admin.kiosk.purge.effect.pendingCancelled":
    "This person has an enrolment request waiting; it is cancelled with the purge reason against it.",
  "admin.kiosk.purge.effect.noPending": "There is no pending enrolment request to cancel.",
  "admin.kiosk.purge.effect.survives":
    "What survives: the consent record (notice version {version}), the audit chain, and the attendance already recorded from these scans. Attendance is never touched by a purge.",
  "admin.kiosk.purge.effect.audit":
    "Two records are written before the call returns: a biometric-purge entry in the tamper-evident chain, and a data-access entry naming the employee as the subject.",

  "admin.kiosk.purge.step3.title": "3 · Authorise",
  "admin.kiosk.purge.step3.hint":
    "Every field is required. The employee code must be typed exactly as {code} — the server compares it and refuses a mismatch, so a slip cannot destroy the wrong person's biometrics.",
  "admin.kiosk.purge.field.basis": "Legal basis",
  "admin.kiosk.purge.field.basisHint":
    "Recorded as a code in front of your reason, so erasures stay searchable.",
  "admin.kiosk.purge.basis.dpdp": "DPDP erasure request from the employee",
  "admin.kiosk.purge.basis.exit": "Exited — biometric retention period elapsed",
  "admin.kiosk.purge.basis.error": "Enrolled in error / duplicate record",
  "admin.kiosk.purge.field.code": "Type the employee code to confirm",
  "admin.kiosk.purge.field.codeHint": "Exactly {code}, including case.",
  "admin.kiosk.purge.field.codeMismatch":
    "That is not this employee's code. Purge stays disabled until it matches.",
  "admin.kiosk.purge.field.counter": "Second super admin authorising",
  "admin.kiosk.purge.field.counterHint":
    "Live super-admin grants, excluding you. The chosen name is written into the audited reason.",
  "admin.kiosk.purge.field.counterPlaceholder": "Select the counter-signing super admin",
  "admin.kiosk.purge.field.counterNone":
    "There is no second super admin to counter-sign. Grant the role to a second person first — a single holder is refused by policy anyway.",
  "admin.kiosk.purge.field.counterUnreadable":
    "The role register could not be read, so a second super admin cannot be confirmed. The purge stays disabled rather than proceeding on one pair of eyes.",
  "admin.kiosk.purge.counter.unnamed": "Super admin (name unavailable)",
  "admin.kiosk.purge.field.attest":
    "I confirm {counter} authorised this erasure and that the person and the legal basis above are correct.",

  "admin.kiosk.purge.block.superOnly": "Only a super admin may purge a biometric.",
  "admin.kiosk.purge.block.noSubject": "Choose the employee first.",
  "admin.kiosk.purge.block.nothingLeft": "Nothing is left to purge for this person.",
  "admin.kiosk.purge.block.code": "Type the employee code exactly to confirm.",
  "admin.kiosk.purge.block.peersUnreadable":
    "The role register could not be read, so the second super admin cannot be confirmed.",
  "admin.kiosk.purge.block.noPeer": "There is no second super admin available to counter-sign.",
  "admin.kiosk.purge.block.counter": "Name the second super admin authorising this.",
  "admin.kiosk.purge.block.attest": "Tick the confirmation to enable the purge.",

  "admin.kiosk.purge.action.all": "Purge all {versions} version(s)",
  "admin.kiosk.purge.action.version": "Purge this version",
  "admin.kiosk.purge.action.retention": "Retention Jobs",
  "admin.kiosk.purge.confirmLabel": "Purge permanently",
  "admin.kiosk.purge.reasonFloor":
    "The reason must be at least {min} characters and should name the request or incident.",
  "admin.kiosk.purge.all.title": "Purge every face template for {name} ({code})",
  "admin.kiosk.purge.all.description":
    "{versions} version(s) will be destroyed under “{basis}”, counter-authorised by {counter}. This cannot be undone.",
  "admin.kiosk.purge.version.title": "Purge version {version} for {code}",
  "admin.kiosk.purge.version.description":
    "Only this version is destroyed, under “{basis}”, counter-authorised by {counter}. Other versions stay until they are purged too.",
  "admin.kiosk.purge.done": "Purged {versions} template version(s) for {code}.",

  "admin.kiosk.purge.receipt.title": "Biometrics destroyed for {code} — {name}",
  "admin.kiosk.purge.receipt.body":
    "{versions} version(s) purged (version {numbers}); {archive} archived copy/copies overwritten; {captures} enrolment photo(s) removed. The employee is off the gate until they enrol again.",
  "admin.kiosk.purge.receipt.capturesLeft":
    "The enrolment photos could not be deleted from storage. The measurements are gone; ask an engineer to sweep the leftover objects.",
  "admin.kiosk.purge.receipt.audit":
    "A biometric-purge entry and a data-access entry were written with your name, the legal basis and the counter-signature.",

  // ===========================================================================
  // /kiosk — the link-based gate scanner (mobile-first, guard signed in by face)
  //
  // House rules, on top of the three above:
  //   * Every sentence has to be readable at arm's length, in daylight, by
  //     somebody who is also watching a queue. Short lines, no jargon, no enum.
  //   * A failure says what to DO, not what went wrong internally. "The camera is
  //     blocked" is useless without "tap the padlock and allow the camera".
  //   * Nothing here ever claims a scan was recorded unless the server said so.
  // ===========================================================================
  "kiosk.gate.title": "Gate scanner",
  "kiosk.gate.tagline": "Face attendance at the gate",

  // ── Camera choice ───────────────────────────────────────────────────────────
  "kiosk.gate.camera.legend": "Camera",
  "kiosk.gate.camera.front": "Front",
  "kiosk.gate.camera.back": "Back",
  "kiosk.gate.camera.frontHint": "Facing you — use this for your own sign-in.",
  "kiosk.gate.camera.backHint": "Facing away — use this to scan the queue.",
  "kiosk.gate.camera.single":
    "This device has one camera, so there is nothing to switch between.",
  "kiosk.gate.camera.starting": "Starting the camera…",
  "kiosk.gate.camera.switching": "Switching camera…",
  "kiosk.gate.camera.noBack":
    "This device has no back camera. Staying on the front one.",
  "kiosk.gate.camera.noFront":
    "This device has no front camera. Staying on the back one.",
  "kiosk.gate.camera.retry": "Try the camera again",
  "kiosk.gate.camera.denied": "The camera is blocked",
  "kiosk.gate.camera.deniedHint":
    "Tap the padlock in the address bar, allow the camera for this page, then reload. Nothing can be scanned until you do.",
  "kiosk.gate.camera.noCamera": "No camera on this device",
  "kiosk.gate.camera.noCameraHint":
    "The gate scanner needs a camera. Open this link on the phone or tablet at the gate.",
  "kiosk.gate.camera.inUse": "The camera is busy",
  "kiosk.gate.camera.inUseHint":
    "Another app or tab is holding the camera. Close it and tap Try the camera again.",
  "kiosk.gate.camera.insecure": "This link is not on a secure connection",
  "kiosk.gate.camera.insecureHint":
    "Browsers only hand over a camera over https. Open the https address of this page.",
  "kiosk.gate.camera.unsupported": "This browser cannot open a camera",
  "kiosk.gate.camera.unsupportedHint":
    "Use Chrome or Safari on the phone at the gate. A browser in private or embedded mode often blocks the camera outright.",
  "kiosk.gate.camera.unavailable": "The camera did not start",
  "kiosk.gate.camera.unavailableHint":
    "Tap Try the camera again. If it keeps failing, reload the page.",

  // ── The face engine ─────────────────────────────────────────────────────────
  "kiosk.gate.engine.loading": "Loading the face engine…",
  "kiosk.gate.engine.loadingHint":
    "About 6 MB, from this site — once per visit, and it is already downloading while you sign in.",
  "kiosk.gate.engine.failed": "The face engine did not load",
  "kiosk.gate.engine.failedHint": "Check the connection and reload the page.",

  // ── Guard sign-in: face names you, PIN starts the shift ─────────────────────
  "kiosk.gate.guard.title": "Who is on duty at the gate?",
  "kiosk.gate.guard.subtitle":
    "Scan your own face with the front camera. Then key your PIN to start the shift.",
  "kiosk.gate.guard.security":
    "Your face names you. Your PIN starts the shift. A face is an identifier, not a secret — a photograph of you must not be enough to open a gate session that records everyone else's attendance.",
  "kiosk.gate.guard.scan": "Scan my face",
  "kiosk.gate.guard.scanning": "Looking for your face…",
  "kiosk.gate.guard.scanningHint": "Hold the phone at eye level, straight on.",
  "kiosk.gate.guard.identified": "You are {name}",
  "kiosk.gate.guard.identifiedHint": "{code} · key your PIN to start the shift.",
  "kiosk.gate.guard.notRecognised": "Not recognised as a guard on this gate",
  "kiosk.gate.guard.notRecognisedHint":
    "Only guards enrolled for this gate can be recognised by face. Type your employee code instead — the PIN is the same.",
  "kiosk.gate.guard.unavailable": "Face sign-in is not live on this gate yet",
  "kiosk.gate.guard.unavailableHint":
    "Type your employee code and PIN. That path is unchanged and works now.",
  "kiosk.gate.guard.typeInstead": "Type my code instead",
  "kiosk.gate.guard.faceInstead": "Scan my face instead",
  "kiosk.gate.guard.notYou": "Not you? Start again",
  "kiosk.gate.guard.code": "Your employee code",
  "kiosk.gate.guard.pin": "Your PIN",
  "kiosk.gate.guard.start": "Start shift",
  "kiosk.gate.guard.starting": "Checking…",
  "kiosk.gate.guard.lockNote":
    "Five wrong PINs lock the account for fifteen minutes. The lock is on the server, not this phone.",

  // ── The scan loop ───────────────────────────────────────────────────────────
  "kiosk.gate.scan.prompt": "Look at the camera",
  "kiosk.gate.scan.promptHint": "First scan of the day is IN. Last scan is OUT.",
  "kiosk.gate.scan.tracking": "Hold it…",
  "kiosk.gate.scan.capturing": "Reading the face…",
  "kiosk.gate.scan.sending": "Recording…",
  "kiosk.gate.scan.kindIn": "IN",
  "kiosk.gate.scan.kindOut": "OUT",
  "kiosk.gate.scan.kindScan": "SCANNED",
  "kiosk.gate.scan.at": "{time} IST",
  "kiosk.gate.scan.codeAt": "{code} · {time} IST",
  "kiosk.gate.scan.noMatch": "Not recognised",
  "kiosk.gate.scan.noMatchHint":
    "Not enrolled yet, or too far from the camera. Step closer and scan again.",
  "kiosk.gate.scan.ambiguousHint":
    "Two enrolled faces were almost equally close, so the gate refused to guess. Scan again, straight on and closer.",
  "kiosk.gate.scan.failed": "That scan did not go through",
  "kiosk.gate.scan.ready": "Ready for the next person",
  "kiosk.gate.scan.next": "Next person, please",

  // ── Footer: recent scans + measured speed ───────────────────────────────────
  "kiosk.gate.recent.title": "Last few scans",
  "kiosk.gate.recent.empty":
    "Nothing scanned yet on this shift. The last five appear here so you can see it working.",
  "kiosk.gate.recent.note":
    "On this screen only, from this shift, and gone when the page reloads — a gate device holds no HR records.",
  "kiosk.gate.speed.label": "Face to result",
  "kiosk.gate.speed.value": "{last} ms now · {median} ms typical",
  "kiosk.gate.speed.samples": "over {n} scan(s)",
  "kiosk.gate.speed.waiting": "Measured on the first scan",
  "kiosk.gate.speed.detector": "Detector {size}px",
  "admin.kiosk.sectionNav.label": "Face and kiosk screens",
  "admin.kiosk.link.title": "Gate link — send this to the person on the door",
  "admin.kiosk.link.blurb":
    "Open this on any laptop, tablet or phone to turn it into a gate scanner. It is safe to send: on its own the link cannot mark anybody's attendance — the device still has to be paired with a one-time code from this screen, and a guard still has to sign in with their PIN.",
  "admin.kiosk.link.copy": "Copy link",
  "admin.kiosk.link.copied": "Copied",
  "admin.kiosk.link.open": "Open in a new tab",
  "admin.kiosk.link.step1": "Send the link to the guard, or open it on the gate device yourself.",
  "admin.kiosk.link.step2":
    "Issue an activation code below and enter it on that device once — it pairs the device and never has to be done again.",
  "admin.kiosk.link.step3":
    "The guard signs in with their employee code and PIN, then scans faces. First scan of the day is in, last is out.",
  "admin.kiosk.link.insecure":
    "This page is not on a secure connection, so the camera and location will not work on the gate device either. Serve the app over HTTPS (or open it on the same machine as localhost) before the demo.",
  "kiosk.gate.rule": "First scan = in · last scan = out · every scan is logged",
  // The guard can see at a glance whether the gate is recording where it is. Every
  // one of these is a NON-blocking state: a scan is recorded in all five.
  "kiosk.gate.location.granted": "Location on · ±{metres} m",
  // A fix WITHOUT a usable accuracy number. Not the same as "finding": the
  // coordinates are in hand and being recorded, the browser just did not say how
  // precise they are. Showing "±0 m" would claim pinpoint accuracy we never had.
  "kiosk.gate.location.grantedNoAccuracy": "Location on",
  "kiosk.gate.location.asking": "Finding location…",
  "kiosk.gate.location.denied": "Location off — scans still recorded",
  "kiosk.gate.location.unavailable": "No location on this device — scans still recorded",
  "kiosk.gate.location.error": "Location unavailable — scans still recorded",
  "kiosk.gate.location.retry": "Try location again",
  "kiosk.gate.endShift": "End shift",
  "kiosk.gate.guardChip": "Guard: {name}",
  "kiosk.gate.deviceChip": "{device}",
} as const;
