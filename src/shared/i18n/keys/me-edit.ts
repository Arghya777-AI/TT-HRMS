/**
 * i18n keys owned EXCLUSIVELY by the me-edit work. One file per author — `t()` is
 * typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Scope: employee self-service editing on /me/profile/basic and
 * /me/profile/personal — the field editor, the change-request path, the pending /
 * declined / withdrawn notes shown against each field, and the plain-English
 * explanation of who owns a field the employee cannot touch.
 *
 * Copy rules followed here (docs/build/spec-employee.md §8, §9):
 *  - Never a column name, never a SQLSTATE, never "Not Available".
 *  - Every refusal names the actual route out (Help Desk), because a dead end is
 *    what generates the support ticket this feature exists to prevent.
 *  - Interpolation with {placeholders}; no string concatenation.
 */
export const keysMeEdit = {
  // ---------------------------------------------------------------------------
  // Row affordances
  // ---------------------------------------------------------------------------
  "me.edit.action.request": "Request change",
  "me.edit.action.edit": "Change",
  "me.edit.action.withdraw": "Take it back",
  "me.edit.action.withdrawing": "Taking it back…",
  "me.edit.action.requestAria": "Request a change to {field}",
  "me.edit.action.editAria": "Change your {field}",
  "me.edit.action.withdrawAria": "Take back your request to change {field}",

  // ---------------------------------------------------------------------------
  // What is happening to this field right now
  // ---------------------------------------------------------------------------
  "me.edit.state.open": "Change to {value} awaiting HR approval · submitted {when}",
  "me.edit.state.openRef": "Reference {reference}",
  "me.edit.state.openBlocks":
    "You already have a request waiting on this field, so it cannot be sent twice.",
  "me.edit.state.openNoRecall":
    "This request is with HR and cannot be taken back from here. Ask the Help Desk to close it if you sent it by mistake.",
  "me.edit.state.approved":
    "HR approved the change to {value} on {when}. Your record still shows the old value until HR applies it.",
  "me.edit.state.rejected": "HR declined your request to change this to {value} on {when}.",
  "me.edit.state.rejectedComment": "HR said: {comment}",
  "me.edit.state.withdrawn": "You took back your request to change this to {value}.",
  "me.edit.state.expired":
    "Your request to change this to {value} timed out without a decision. Send it again if it is still wrong.",
  "me.edit.state.failed":
    "HR approved the change to {value}, but applying it to your record failed, so the old value still stands. HR can see the problem.",
  "me.edit.state.failedDetail": "Reported problem: {error}",
  "me.edit.state.unknown":
    "We could not check whether a request is already waiting on this field.",

  // ---------------------------------------------------------------------------
  // Read-only fields — who owns them, in words
  // ---------------------------------------------------------------------------
  "me.edit.readOnly.hr": "HR changes this. Raise a Help Desk ticket if it is wrong.",
  "me.edit.readOnly.employeeCode":
    "Your employee number is fixed for the life of your record — nobody can change it.",
  "me.edit.readOnly.workEmail":
    "IT and HR own your work email address. Ask the Help Desk if it needs to change.",
  "me.edit.readOnly.manager":
    "HR sets your reporting line when your role, department or manager changes.",

  // ---------------------------------------------------------------------------
  // How the whole thing works — stated once per card
  // ---------------------------------------------------------------------------
  "me.edit.note.howItWorks":
    "A field marked “Needs HR approval” does not change when you send it. HR checks it against your documents and applies it; until then you see your request on the field itself.",
  "me.edit.note.noEdit":
    "A request cannot be edited once sent. Take it back and send a new one if you got it wrong.",
  "me.edit.note.selfImmediate":
    "A field marked “You can edit” changes on your record the moment you save it, and the change is written to your record history.",

  // ---------------------------------------------------------------------------
  // The editor
  // ---------------------------------------------------------------------------
  "me.edit.sheet.title.request": "Request a change to {field}",
  "me.edit.sheet.title.direct": "Change your {field}",
  "me.edit.sheet.desc.request":
    "HR checks this against your documents before your record changes. Nothing changes until they approve it.",
  "me.edit.sheet.desc.direct":
    "This changes on your record as soon as you save, and is recorded in your record history.",
  "me.edit.sheet.current": "On your record now",
  "me.edit.sheet.new": "What it should be",
  "me.edit.sheet.choose": "Choose a value",
  "me.edit.sheet.reason.request": "Why it needs to change",
  "me.edit.sheet.reason.direct": "Note for your record history",
  "me.edit.sheet.reason.requestHint":
    "HR reads this when they decide. Say what is wrong and which document proves the new value.",
  "me.edit.sheet.reason.directHint":
    "Optional. Leave it blank and we record that you updated it yourself.",
  "me.edit.sheet.reason.count": "{count} of {min} characters",
  "me.edit.sheet.reason.enough": "{count} characters",
  "me.edit.sheet.submit.request": "Send to HR",
  "me.edit.sheet.submit.direct": "Save",
  "me.edit.sheet.submitting.request": "Sending…",
  "me.edit.sheet.submitting.direct": "Saving…",
  "me.edit.sheet.cancel": "Cancel",
  "me.edit.sheet.close": "Close",
  "me.edit.sheet.noClear":
    "A change request has to carry a value — it cannot empty a field. Ask HR at the Help Desk to remove a value.",
  "me.edit.sheet.done.request":
    "Sent to HR as {reference}. It stays on this field as awaiting approval until they decide.",
  "me.edit.sheet.done.requestNoRef":
    "Sent to HR. It stays on this field as awaiting approval until they decide.",
  "me.edit.sheet.done.direct": "Saved to your record.",
  "me.edit.sheet.done.title": "Done",
  "me.edit.sheet.withdrawn": "Request taken back. You can send a new one now.",

  // ---------------------------------------------------------------------------
  // Validation — every message says what to type, not what was wrong
  // ---------------------------------------------------------------------------
  "me.edit.invalid.required": "Enter the value your record should hold.",
  "me.edit.invalid.unchanged": "That is already the value on your record.",
  "me.edit.invalid.tooLong": "Keep this to {max} characters or fewer.",
  "me.edit.invalid.email": "Enter an email address in the form name@example.com.",
  "me.edit.invalid.mobile":
    "Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9 — no country code, no spaces.",
  "me.edit.invalid.date": "Choose a date.",
  "me.edit.invalid.dateFuture": "This date cannot be in the future.",
  "me.edit.invalid.dateTooEarly": "Choose a date from {min} onwards.",
  "me.edit.invalid.option": "Choose one of the listed values.",
  "me.edit.invalid.reason": "Tell HR why this needs to change — at least {min} characters.",

  // ---------------------------------------------------------------------------
  // Field labels this build adds (the rest reuse profile.field.*)
  // ---------------------------------------------------------------------------
  "me.edit.field.firstName": "First name",
  "me.edit.field.middleName": "Middle name",
  "me.edit.field.lastName": "Last name",
  "me.edit.field.nameInLocalScript": "Name in local script",
  "me.edit.field.about": "About you",
  "me.edit.field.personalEmail": "Personal email",
  "me.edit.field.mobile": "Mobile number",
  "me.edit.field.religion": "Religion",
  "me.edit.field.category": "Category",
  "me.edit.field.differentlyAbled": "Differently abled",
  "me.edit.field.disabilityType": "Nature of disability",
  "me.edit.field.modeOfTransport": "How you travel to work",
  "me.edit.field.uniformSize": "Uniform size",
  "me.edit.field.foodPreference": "Food preference",
  "me.edit.field.relation": "The person named above is your",

  // Field help lines
  "me.edit.field.legalName.parts":
    "Built from the three name fields below. HR checks a document before any of them change.",
  "me.edit.field.about.hint":
    "Two or three lines your colleagues see on your profile. Up to {max} characters.",
  "me.edit.field.personalEmail.hint":
    "Where payslips and any salary or bank-change alert are sent.",
  "me.edit.field.mobile.hint": "The number HR and payroll use to reach you.",
  "me.edit.field.nameInLocalScript.hint":
    "Optional. Used on documents printed in Kannada or Hindi.",
  "me.edit.field.category.hint": "As recorded for statutory reporting.",
  "me.edit.field.disabilityType.hint":
    "Recorded only when you have told HR you are differently abled.",
  "me.edit.field.modeOfTransport.hint":
    "Helps HR plan the shuttle and late-shift transport.",
  "me.edit.field.uniformSize.hint": "Stores uses this when issuing your uniform.",
  "me.edit.field.foodPreference.hint":
    "Used for staff meals on event days. Yours to change at any time.",

  // ---------------------------------------------------------------------------
  // Option vocabularies (employees CHECK constraints, verbatim value sets)
  // ---------------------------------------------------------------------------
  "me.edit.category.gen": "General",
  "me.edit.category.obc": "Other Backward Class",
  "me.edit.category.sc": "Scheduled Caste",
  "me.edit.category.st": "Scheduled Tribe",
  "me.edit.category.ews": "Economically Weaker Section",
  "me.edit.food.veg": "Vegetarian",
  "me.edit.food.nonVeg": "Non-vegetarian",
  "me.edit.food.jain": "Jain",
  "me.edit.food.eggetarian": "Eggetarian",

  // ---------------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------------
  "me.edit.card.own.title": "Your own details",
  "me.edit.card.own.desc":
    "The contact details and personal facts HR keeps on your employee record. Most need HR to check a document first; food preference is yours.",
  "me.edit.card.own.scope":
    "These are fields on your employee record. Any extra venue-specific fields HR has defined for your role live on the Additional details tab.",

  // ---------------------------------------------------------------------------
  // What HR sees in the approval queue (approval_requests.title) and the
  // sentence recorded against a direct self-edit (audit_log.reason)
  // ---------------------------------------------------------------------------
  "me.edit.approval.title": "{field} · {from} → {to}",
  "me.edit.audit.selfDefault": "Employee updated their own {field} from My Profile.",
  "me.edit.audit.selfWithNote":
    "Employee updated their own {field} from My Profile. Their note: {note}",
  "me.edit.audit.withdraw": "Taken back by the employee from My Profile.",

  // ---------------------------------------------------------------------------
  // Failure sentences
  // ---------------------------------------------------------------------------
  "me.edit.error.noApproval":
    "Your request was recorded, but the approval could not be routed to HR. Tell the Help Desk and quote this field.",
  "me.edit.error.noProfile":
    "This account is not linked to a signed-in profile, so it cannot raise a change request.",
  "me.edit.partial.requests": "Requests already waiting on your fields",

  // ===========================================================================
  // THE SELF-PUNCH CARD — /me and /me/attendance
  //
  // In this file because a key file has exactly one owner: `t()` is typed on
  // `keyof typeof en`, so two authors appending to en.ts lose each other's keys.
  // The `me.punch.` prefix keeps it a separate vocabulary from `me.edit.`.
  //
  // Copy rules, on top of the three above:
  //  - The face guidance sentences are NOT redefined here. The card renders
  //    `auth.login.face.looking / stepCloser / tooDark / holdStill / faceCamera /
  //    inconsistent` verbatim, so the words the pipeline's verdicts produce are
  //    the same words at the gate kiosk and on the sign-in screen.
  //  - A refused location is never phrased as an error: it is a supported
  //    outcome, and the sentence says what happens instead (recorded, flagged).
  //  - Nothing here claims the face check proves a live person. It says what it
  //    is: a match against the enrolled template plus a motion heuristic.
  // ===========================================================================
  "me.punch.title": "Attendance",
  "me.punch.lead": "Record your attendance here with your face, without going to the gate.",

  // The button, and the direction it will record
  /*
    "Punch to log out", not "Punch out". Asked for in those words, and it is the clearer pair:
    "Punch out" beside the sentence "You are logged in" reads as a label for a state, where
    "Punch to log out" reads as the thing pressing it will do.
  */
  "me.punch.action.in": "Punch to log in",
  "me.punch.action.out": "Punch to log out",
  "me.punch.action.checking": "Checking your last scan…",
  // Used only when the punch-log read failed: the button must not invent a
  // direction the server has not been asked for.
  "me.punch.action.scan": "Punch attendance",
  "me.punch.action.inAria": "Punch in with your face",
  "me.punch.action.outAria": "Punch out with your face",
  "me.punch.action.scanAria": "Punch attendance with your face",
  "me.punch.action.cancel": "Cancel",
  "me.punch.action.again": "Try again",
  "me.punch.action.done": "Close",
  "me.punch.action.viewPunches": "See today's punches",

  /*
    ── THE STATE, SAID PLAINLY ────────────────────────────────────────────────
    Asked for: the card should say the employee IS logged in, and offer the opposite action.
    It used to lead with "Nothing recorded yet today" and, after a punch, "Last scan 09:28 ·
    1 recorded today" — a fact about scans, not about work. These two lead now; the scan count
    stays underneath as detail.
  */
  /*
    ── THE OFF-HOURS NOTE ────────────────────────────────────────────────────
    Shown only when a punch now would fall outside the employee's shift window. Worded to say
    what happens next — the hours DO count immediately — because a box that only says "reason
    required" reads as a refusal and people abandon it.
  */
  "me.punch.offHours.label": "This is outside your shift hours",
  "me.punch.offHours.hint":
    "Say briefly why, in at least 15 characters. Your hours are recorded straight away; an administrator is asked to approve them, and they count towards your month once approved.",
  "me.punch.offHours.placeholder": "e.g. Stayed for the evening banquet setup",
  "me.punch.offHours.counter": "{n} of {min} characters",

  "me.punch.state.loggedIn": "You are logged in — since {time}.",
  "me.punch.state.loggedOut": "You are logged out — last out at {time}.",
  /*
    The fragmented total. A 09:00-13:00 then 19:00-21:00 day is six hours in two sessions, and
    the session count is what makes the number make sense. Singular form omits the count,
    because "1 session" on an ordinary day is noise.
  */
  "me.punch.state.sessionsTotal": "{total} today, across {n} sessions.",
  "me.punch.state.oneSessionTotal": "{total} today.",

  // What the punch log already says
  "me.punch.state.expectIn": "This will be recorded as an arrival.",
  "me.punch.state.expectOut": "This will be recorded as a departure.",
  "me.punch.state.lastScan": "Last scan {time} · {count} recorded today.",
  // A night shift's scans are filed under the day the shift STARTED, so after
  // midnight "today" would be the wrong word for them. The date is named instead.
  "me.punch.state.lastScanCarried":
    "Last scan {time} · {count} recorded against {date}, the day your shift started.",
  "me.punch.state.noneToday": "Nothing recorded yet today.",
  "me.punch.state.direction":
    "The direction comes from your own punch log; the server decides it again when it stores the punch, and the confirmation below shows what it decided.",
  "me.punch.state.unknownDirection":
    "We could not read your punches just now, so the button records a scan and the server decides the direction.",

  // Location — the reason is on screen before the browser's prompt
  "me.punch.location.title": "Your location",
  /** The one-line summary; the paragraph above sits behind a disclosure. */
  "me.punch.location.short": "We ask for your location when you tap",
  // NOTE ON "marked for review": the function flags a punch (`needs_review`)
  // when it can SEE something to flag — outside the geofence, outside the venue
  // network, no liveness attestation. A punch with NO coordinates is recorded
  // with `geofence_ok = NULL`, which means NOT EVALUATED, and is not flagged for
  // that reason alone. So none of these sentences promises a review; they say
  // what is true, that the punch is recorded without a location. The review
  // sentence is `me.punch.done.review`, rendered only when the server says so.
  /*
    ── THESE FOUR USED TO SAY THE OPPOSITE ────────────────────────────────────
    "Your punch will be recorded without one" was true, and is not any more:
    `attendance-self-punch` refuses a request with no coordinates. Leaving the old wording would
    have promised a punch the server was about to reject — the worst kind of stale copy, because
    the person acts on it and then sees a failure they were told would not happen.

    A punch away from the gate is the one route where nobody watched the person arrive, so the
    location is not decoration on the record, it is the record. The gate camera is named in each
    one, because it is the route that needs none of this.
  */
  "me.punch.location.reason":
    "When you tap the button we ask your browser for your location, so your punch shows where it was taken. Attendance from the web needs it — if you say no, use the gate camera instead.",
  "me.punch.location.asking": "Waiting for your answer to the browser's location prompt…",
  "me.punch.location.granted": "Location shared, accurate to about {metres} m.",
  "me.punch.location.denied": "No location shared, so this punch cannot be recorded from the web.",
  "me.punch.location.unavailable":
    "This browser cannot share a location, so it cannot record a punch. Use the gate camera.",
  "me.punch.location.error":
    "Your location could not be read in time, so this punch was not recorded. Tap again.",
  /*
    Still needed, and still true — for the PAST. Punches taken before location became mandatory
    have no fix, and this is what their detail line says. It is not reachable for a new punch.
  */
  "me.punch.location.dropped":
    "No location was stored with this punch. Punches taken before location became mandatory do not have one.",
  /*
    Why the punch STOPPED, before the camera was ever opened. One per outcome, because the fixes
    are genuinely different: a permission the person can grant, a device setting they must turn
    on, or a weak signal where moving is the only remedy. A single "location is required" leaves
    most people stuck.
  */
  "me.punch.locationRequired.denied":
    "Attendance from the web needs your location, and this browser has it blocked for this site. Allow location from the icon in the address bar (or your browser's site settings), then tap again. The gate camera does not need this.",
  "me.punch.locationRequired.unavailable":
    "Attendance from the web needs your location, and this device cannot provide it — location services are off, or the page is not on a secure connection. Turn location on for your browser and tap again, or use the gate camera instead.",
  "me.punch.locationRequired.error":
    "Your location could not be read just now — the signal is often weak indoors. Move near a window or step outside and tap again. The gate camera does not need a location.",

  // The face check, and its honest limits
  "me.punch.face.title": "Face check",
  "me.punch.face.honesty":
    "This confirms your face matches the photo you enrolled. It also measures movement between frames, which rules out a still photograph held to the camera — that is a heuristic, not a certified liveness test, and it does not prove you are physically present.",
  "me.punch.face.frameRule":
    "Nothing is sent until {total} frames in a row agree with each other. The clearest of those frames is the one that goes to the server.",
  "me.punch.face.oneFace": "More than one face in view — a punch needs you on your own.",

  // Live states
  "me.punch.step.warming": "Getting the face check ready…",
  "me.punch.step.ready": "Ready when you are.",
  "me.punch.step.engine": "Loading the face check…",
  "me.punch.step.camera": "Asking for the camera…",
  "me.punch.step.frames": "{count} of {total} frames agree",
  "me.punch.step.sending": "Recording your punch…",

  // What was recorded
  "me.punch.done.in": "Punched in at {time}",
  "me.punch.done.out": "Punched out at {time}",
  "me.punch.done.scan": "Punch recorded at {time}",
  "me.punch.done.noTime": "Your punch was recorded.",
  "me.punch.done.who": "Matched to {name}.",
  "me.punch.done.insideFence": "Taken inside your work location.",
  "me.punch.done.outsideFence":
    "Taken outside your work location's fence, so this punch is marked for review.",
  "me.punch.done.noFence": "Recorded without a location, so it was not checked against your work location.",
  // Rendered ONLY from the server's `needsReview`. The card never deduces it.
  "me.punch.done.review": "Your manager will see this punch flagged for review.",
  "me.punch.done.elapsed": "Took {seconds}s from the first frame to the server's answer.",
  "me.punch.done.alreadyRecorded":
    "This punch is already recorded — it was not sent twice. Open today's punches to see it.",

  // Refusals and failures
  "me.punch.refusedTitle": "Not recorded",
  "me.punch.error.engine":
    "The face check could not load on this device. Use the gate kiosk, and tell the Help Desk you saw this.",
  "me.punch.error.camera":
    "We could not open the camera. Allow camera access for this site in your browser, or use the gate kiosk.",
  "me.punch.error.noCamera":
    "This browser cannot use a camera, so a face punch is not possible here. Use the gate kiosk.",
  "me.punch.error.unusable":
    "The frames we captured could not be used, so nothing was sent. Try again in better light.",
  "me.punch.error.timedOut":
    "We could not get {total} frames that agree, so nothing was sent. Move into better light, hold still, and try again.",
  "me.punch.error.signedOut": "Your session has expired. Sign in again and punch from the new session.",
  "me.punch.error.notEntitled":
    "Punching from the web is not enabled for your account, so this punch was refused. Use the gate kiosk, or ask HR to enable it.",
  "me.punch.error.notDeployed":
    "Web punch is not switched on for this site yet. Use the gate kiosk, and tell the Help Desk you saw this.",
  "me.punch.error.rejected": "Your punch was not recorded.",
  "me.punch.error.tooMany": "Too many attempts in a row. Wait a minute, then try again.",
  "me.punch.error.server":
    "Something failed on our side and your punch was not recorded. Try again, or use the gate kiosk.",
  "me.punch.error.serverWithRef":
    "Something failed on our side and your punch was not recorded. Try again, or quote reference {ref} to the Help Desk.",
  "me.punch.error.offline":
    "Your punch never reached us — this device is offline. Nothing was recorded; try again once you have a connection.",
  "me.punch.error.unreadable":
    "Your punch was sent, but we could not read the answer. It may already be recorded — open today's punches before you send another.",
  "me.punch.error.stateUnknown": "We could not read your recent punches.",

  // Not for this account / not possible here
  "me.punch.unavailable.notEntitled":
    "Punching from the web is not enabled for your account. Use the gate kiosk, or ask HR to switch it on.",
} as const;
