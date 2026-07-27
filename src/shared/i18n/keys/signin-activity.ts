/**
 * i18n keys owned EXCLUSIVELY by the signin-activity work. One file per author — `t()` is
 * typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Voice rules used throughout: the employee is addressed as "you", every event reads as a
 * finished sentence rather than a code, and no string claims a fact the row does not carry
 * — a missing location says so, a device we cannot name says so.
 */
export const keysSigninActivity = {
  // --- The one-sentence contract, plus the three honest caveats -------------
  "signIn.recorded":
    "Every sign-in, refused attempt and security change on your account is recorded with the time in IST, the method used, the network address it came from and the device — so you can recognise your own activity and report anything that is not yours.",
  "signIn.recorded.notWritten":
    "Signing in with your email and password is handled by the sign-in service itself and is not written to this record yet. What is written here: passkey sign-ins, face sign-ins, kiosk PIN sign-ins, passkeys added, and password changes made when your account was set up. The session you are using now is shown above, so a short list is never mistaken for a quiet account.",
  "signIn.recorded.face":
    "A face sign-in on the web IS recorded here, as a sign-in whose method is your face. What is recorded is that it happened and when — never the face measurement itself, which stays in the security system's own restricted log and cannot be read from this screen. Face scans at the attendance kiosk are a different thing: those are attendance punches, not sign-ins, and they are on your attendance screens.",
  "signIn.recorded.passkeyPair":
    "A passkey sign-in is recorded as two rows at the same moment — the passkey being used, and the sign-in it granted. Two rows one second apart with the same method are one sign-in, not two.",
  "signIn.recorded.notYours":
    "Attempts that never matched an account cannot be linked to you, so they are not listed here — only the security administrators can see those.",

  // --- The session in the browser you are reading this on ------------------
  "signIn.session.title": "The session you are using now",
  "signIn.session.hint":
    "Read from the sign-in service for this browser, not from the record below.",
  "signIn.session.account": "Signed in as",
  "signIn.session.since": "This session started",
  "signIn.session.sinceUnknown": "The sign-in service did not report a start time.",
  "signIn.session.device": "This browser",

  // --- Server counts -------------------------------------------------------
  "signIn.kpi.signIns": "Sign-ins recorded",
  "signIn.kpi.signInsFormula":
    "Rows against your profile whose event is a successful sign-in (login_success).",
  "signIn.kpi.failures": "Refused attempts",
  "signIn.kpi.failuresFormula":
    "Rows against your profile whose event is a refused sign-in (login_failed).",
  "signIn.kpi.security": "Security changes",
  "signIn.kpi.securityFormula":
    "Password changes and resets, passkeys added, second-step challenges and revoked sessions.",
  "signIn.kpi.total": "Everything recorded",
  "signIn.kpi.totalFormula":
    "Every row recorded against your profile, background session renewals included.",
  "signIn.kpi.numbers": "Counted by the database over your own rows, never from the list below.",
  "signIn.lastSuccess": "Last recorded sign-in: {when} · {method}.",
  "signIn.lastSuccessNone": "No successful sign-in has been recorded against your profile yet.",

  // --- Filters over the loaded trail ---------------------------------------
  "signIn.filter.label": "Show",
  "signIn.filter.activity": "Everything",
  "signIn.filter.signIns": "Sign-ins & sign-outs",
  "signIn.filter.failures": "Refused attempts",
  "signIn.filter.security": "Security changes",
  "signIn.filter.renewals": "Background renewals",
  "signIn.filter.scope":
    "These buttons filter the {n} events loaded below. The four numbers above are counted over your whole record.",

  // --- The trail itself ----------------------------------------------------
  "signIn.showing": "Showing {shown} of {loaded} loaded events.",
  "signIn.showMore": "Show older events",
  "signIn.truncated":
    "The {limit} most recent events are loaded, out of {total} recorded against your profile. Older events are not shown here, and the new-device and new-location notes are left off, because both need your whole history to be true.",
  "signIn.empty.title": "Nothing has been recorded against your account yet",
  "signIn.empty.hint":
    "Passkey sign-ins, kiosk PIN sign-ins and password changes appear here as they happen. An email-and-password sign-in is not recorded yet, so an empty list does not mean you have never signed in.",
  "signIn.emptyFiltered.title": "No events of this kind in the loaded list",
  "signIn.emptyFiltered.hint":
    "Switch back to Everything to see the rest, or read the counts above — they cover your whole record, not only the events loaded here.",
  "signIn.renewals.hint":
    "Background renewals keep you signed in without asking for your password again. Nothing writes them in this build, so this list is expected to be empty.",

  // --- One sentence per event, in the employee's own voice -----------------
  "signIn.event.signedInPassword": "You signed in with your password",
  "signIn.event.signedInPasskey": "You signed in with a passkey",
  "signIn.event.signedInEmailLink": "You signed in from an email link",
  "signIn.event.signedInCode": "You signed in with a one-time code",
  "signIn.event.signedInKiosk": "You were signed in at a kiosk with your PIN",
  "signIn.event.signedInFace": "You signed in with your face",
  "signIn.event.signedIn": "You signed in",
  "signIn.event.refused": "A sign-in attempt on your account was refused",
  "signIn.event.signedOut": "You signed out",
  "signIn.event.renewed": "Your session was renewed in the background — not a new sign-in",
  "signIn.event.resetRequested": "A password reset was requested for your account",
  "signIn.event.passwordChanged": "Your password was changed",
  "signIn.event.passkeyAdded": "A passkey was added to your account",
  "signIn.event.passkeyUsed": "A passkey on your account was used",
  "signIn.event.secondStep": "A second step was asked for before letting you in",
  "signIn.event.sessionRevoked": "A session on your account was signed out",
  "signIn.event.other": "Recorded against your account: {event}",

  // --- Methods (ck_sessions_audit__auth_method, all SIX permitted values:
  //     password | passkey | magic_link | otp | kiosk_pin — plus `face`, added
  //     to the CHECK by migration 20260801012200 and written by `face-login`) --
  "signIn.method.password": "Password",
  "signIn.method.passkey": "Passkey",
  "signIn.method.magicLink": "Email link",
  "signIn.method.otp": "One-time code",
  "signIn.method.kioskPin": "Kiosk PIN",
  "signIn.method.face": "Face",
  "signIn.method.none": "Method not recorded",

  // --- Where from ----------------------------------------------------------
  "signIn.place.none": "Location was not shared",
  "signIn.place.coords": "Near {lat}, {lon}",
  "signIn.place.accuracy": "to within {metres} m",

  // --- Which device --------------------------------------------------------
  "signIn.device.none": "Device not recorded",
  "signIn.device.kiosk": "Kiosk device at the venue",
  "signIn.device.browserOn": "{browser} on {platform}",
  "signIn.device.tagged": "Device {id}",

  // --- The notes worth looking at -----------------------------------------
  "signIn.flag.failed": "Refused",
  "signIn.flag.newDevice": "New device",
  "signIn.flag.newPlace": "New location",
  "signIn.flag.outOfHours": "Outside 07:00–21:00",
  "signIn.flag.thisBrowser": "This browser",
  "signIn.legend.title": "What the notes mean",
  "signIn.legend.failed":
    "Refused — the credential did not match. Ten refusals in a row lock the account until an administrator reopens it.",
  "signIn.legend.newDevice":
    "New device — the first time this device appears anywhere in your recorded history.",
  "signIn.legend.newPlace":
    "New location — a place not recorded for you before. It only appears when the sign-in carried a location, and most do not.",
  "signIn.legend.outOfHours":
    "Outside 07:00–21:00 IST — an unusual hour for this venue. Odd, not wrong by itself.",
  "signIn.legend.thisBrowser":
    "This browser — the same browser you are reading this screen on, so that row is you.",
  "signIn.legend.action":
    "If a row is not you, change your password on the Security screen and tell HR. Every one of these rows is kept whether you look at it or not.",

  // --- Per-row technical detail (shown on request, never by default) -------
  "signIn.detail.summary": "Technical detail",
  "signIn.detail.ip": "Network address",
  "signIn.detail.deviceId": "Device id",
  "signIn.detail.userAgent": "Browser reported",
  "signIn.detail.place": "Location recorded",
  "signIn.detail.email": "Address tried",
  "signIn.detail.event": "Event code",
  "signIn.detail.reason": "Reason given",
  "signIn.detail.none": "not recorded",

  // --- The card on /me/settings/security ----------------------------------
  "signIn.card.title": "Recent sign-in activity",
  "signIn.card.hint": "The most recent events recorded against your account, in IST.",
  "signIn.card.full": "See the full trail",

  // --- Admin register (/admin/audit/sessions) ------------------------------
  "signIn.admin.col.from": "Location",
  "signIn.admin.place.none": "Not recorded",
} as const;
