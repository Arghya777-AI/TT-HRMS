/**
 * i18n keys owned EXCLUSIVELY by the auth-login work. One file per author — `t()` is
 * typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * SCOPE: the sign-in screen (`src/pages/Login.tsx`) and everything under
 * `src/features/auth/`. The fourteen `auth.login.*` keys that already live in
 * en.ts (title, identifier, continue, back, password, submit, signingInAs,
 * useEmailHint, invalidIdentifier, failed, genericError, noSignup, forgot,
 * identifierPlaceholder) are NOT repeated here — they are reused as they are.
 *
 * Copy rules applied throughout: say which method is being used, never claim a
 * protection that is not there, and never imply that a refused permission
 * blocked anything.
 */
export const keysAuthLogin = {
  // ── Step 1 · identify ──────────────────────────────────────────────────────
  "auth.login.identifyHint": "One field: your employee code (TT0042) or your work email.",
  "auth.login.startAgain": "Start again",

  // ── Step 2 · choose a method ───────────────────────────────────────────────
  "auth.login.chooseTitle": "Choose how to sign in",
  "auth.login.chooseHint":
    "All of these open the same account. Which one you used is recorded with the sign-in.",
  "auth.login.onFile": "Work email on file: {masked}",
  "auth.login.notYou": "Not you?",

  // ── Passkey / fingerprint ──────────────────────────────────────────────────
  "auth.login.passkey.button": "Fingerprint or device unlock",
  "auth.login.passkey.badge": "Strongest",
  "auth.login.passkey.hintPlatform":
    "Your fingerprint or face-unlock never leaves this device — only a signed proof is sent.",
  "auth.login.passkey.hintRoaming":
    "Use your security key. The key never leaves your hand — only a signed proof is sent.",
  "auth.login.passkey.unsupported":
    "This browser cannot do fingerprint sign-in, so it is not offered here.",
  "auth.login.passkey.notEnrolled":
    "No passkey is registered on this account yet. Add one from Profile → Security once you are signed in.",
  "auth.login.passkey.prompting": "Follow your device's prompt — touch the sensor or unlock as usual.",
  "auth.login.passkey.verifying": "Checking the signature with the server…",
  "auth.login.passkey.preparing": "Getting the fingerprint prompt ready, so it opens the instant you tap.",
  // NOT "you cancelled it": `NotAllowedError` is one name for both the user
  // dismissing the prompt and the browser refusing to open it, and this screen
  // cannot tell them apart. It must not accuse the employee of something the
  // browser may have done.
  "auth.login.passkey.cancelled":
    "The fingerprint prompt did not complete — it was either dismissed or refused by this browser. Nothing was sent. Try again, or use your password.",
  // Safari (and any browser enforcing transient user activation strictly) refuses
  // `navigator.credentials.get()` when a network round trip happened between the
  // tap and the call. The second tap uses the request prepared in the background,
  // so it opens immediately — that is a true statement about what happens next.
  "auth.login.passkey.activationLost":
    "This browser would not open the fingerprint prompt because the request had to reach the server first. Nothing was sent. Tap it once more — the prompt is ready now and will open straight away — or use your password.",
  "auth.login.passkey.notReady":
    "Fingerprint sign-in is not reachable right now. Use your password instead.",
  "auth.login.passkey.failed": "That passkey could not be verified. Try again, or use your password.",

  // ── Face ───────────────────────────────────────────────────────────────────
  "auth.login.face.button": "Face sign-in",
  "auth.login.face.badge": "Convenience",
  "auth.login.face.hint": "Convenience only — weaker than a password or a passkey.",
  "auth.login.face.unsupported":
    "This device has no camera the browser can use, so face sign-in is not offered here.",
  "auth.login.face.title": "Face sign-in",
  "auth.login.face.security":
    "Face is a convenience factor and it is weaker than a password or a passkey: a face can be held up to a camera. The match is made on the server, never here, and the sign-in is recorded as a face sign-in so HR can see it.",
  "auth.login.face.frameRule":
    "{total} frames must agree with each other before anything is sent. Nothing leaves this device until they do.",
  /**
   * The exact scope of the movement check, in the employee's words. It says what
   * the number IS (measured change between the frames) and what it is NOT (proof
   * of a live person). Overstating this would be worse than having no check.
   */
  "auth.login.face.motionRule":
    "This device also measures how much the picture actually changes between those frames, and sends that measurement with your face reading. It stops a still image being fed to the camera; it does NOT stop someone holding a photograph of you up to it, because a held photograph moves. That is why face sign-in stays a convenience factor and why your password remains the stronger way in.",
  "auth.login.face.step.motion": "Movement check",
  "auth.login.face.state.motion": "{score} measured",
  "auth.login.face.incompatible":
    "Face sign-in cannot run in this browser: it produced a face reading in a format the server does not accept. Use your password or your fingerprint.",
  "auth.login.face.cancel": "Cancel",
  "auth.login.face.retry": "Try again",
  "auth.login.face.usePassword": "Use my password instead",
  "auth.login.face.step.engine": "Face engine",
  "auth.login.face.step.camera": "Camera",
  "auth.login.face.step.frames": "Matching frames",
  "auth.login.face.step.verify": "Server match",
  "auth.login.face.state.waiting": "Waiting",
  "auth.login.face.state.engine": "Loading — about a megabyte, once per device",
  "auth.login.face.state.engineReady": "Ready",
  "auth.login.face.state.cameraAsking": "Asking permission…",
  "auth.login.face.state.cameraOn": "On",
  "auth.login.face.state.frames": "{count} of {total}",
  "auth.login.face.state.verifying": "Checking…",
  "auth.login.face.cameraDenied":
    "Camera permission was refused, so face sign-in cannot run. Use your password or your fingerprint.",
  "auth.login.face.engineFailed":
    "The face engine could not be loaded on this device. Use your password or your fingerprint.",
  "auth.login.face.looking": "Look straight at the camera.",
  "auth.login.face.oneFace": "More than one face in view — face sign-in needs you on your own.",
  "auth.login.face.stepCloser": "Come a little closer to the camera.",
  "auth.login.face.tooDark": "Too dark — move to better light.",
  "auth.login.face.holdStill": "Hold still.",
  "auth.login.face.faceCamera": "Face the camera squarely.",
  "auth.login.face.inconsistent":
    "Those frames did not agree with one another, so nothing was sent. Hold still and keep looking at the camera.",
  "auth.login.face.timedOut":
    "Could not get {total} frames that agree. Nothing was sent — try again in better light, or use your password.",
  "auth.login.face.unusable":
    "This device produced an unusable face reading, so nothing was sent. Use your password or your fingerprint.",
  "auth.login.face.verifying": "Matching your face on the server…",
  "auth.login.face.refusedTitle": "Face sign-in did not work",
  "auth.login.face.refused": "Face sign-in did not work. Use your password or your fingerprint.",
  "auth.login.face.notReady":
    "Face sign-in is not switched on yet. It needs the face-login service deployed; use your password or your fingerprint.",

  // ── Password ───────────────────────────────────────────────────────────────
  "auth.login.password.button": "Use my password",
  "auth.login.password.badge": "Strong",
  "auth.login.password.hint": "Always available, on any device.",
  "auth.login.emailLabel": "Work email",
  "auth.login.emailPlaceholder": "you@tamarindtree.co",
  "auth.login.emailNeeded":
    "Password sign-in needs your full work email. For security the employee-code lookup only ever returns a masked address ({masked}).",
  "auth.login.emailNeededNoMask": "Password sign-in needs your full work email.",

  // ── Which method was used ──────────────────────────────────────────────────
  "auth.login.signedInWith.password": "Signed in with your password.",
  "auth.login.signedInWith.passkey": "Signed in with your fingerprint — a passkey on this device.",
  "auth.login.signedInWith.face": "Signed in with your face — a convenience factor, weaker than a password.",
  "auth.login.usingMethod": "Using: {method}",
  "auth.login.methodName.password": "password",
  "auth.login.methodName.passkey": "fingerprint (passkey)",
  "auth.login.methodName.face": "face",

  // ── Sign-in location ───────────────────────────────────────────────────────
  "auth.login.location.title": "Sign-in location",
  /**
   * Rewritten because the old copy was false. It promised that "your sign-in
   * location is recorded" on a screen where no route could send it, and that
   * "only face sign-in can carry the location", which was the exact opposite of
   * the truth. These two strings now describe the one route that has a sink
   * (`auth-session-record`, called with the new session's own token after a
   * password sign-in) and say plainly that the other two routes send nothing.
   */
  "auth.login.location.reason":
    "If you share it, your location is recorded with a successful PASSWORD sign-in — next to the time, the network address, the device and the method — so you can recognise your own sign-ins on your Security screen. It is never used for attendance, and it is only ever what this browser reported.",
  "auth.login.location.scope":
    "Only password sign-in carries a location today. Fingerprint and face sign-ins are recorded by the server itself, which records the time, network address, device and method but has no field for coordinates — so nothing is sent on those two routes.",
  "auth.login.location.asking": "Asking this browser for the location…",
  "auth.login.location.granted": "Location captured, accurate to about {metres} m.",
  "auth.login.location.denied":
    "Location refused. Sign-in still works — your sign-in is recorded without coordinates.",
  "auth.login.location.unavailable":
    "This browser cannot share a location. Sign-in still works — your sign-in is recorded without coordinates.",
  "auth.login.location.error":
    "The location could not be read. Sign-in still works — your sign-in is recorded without coordinates.",
  "auth.login.location.share": "Share my location",

  // ── Portal state refusals (spec-employee E-01) ─────────────────────────────
  "auth.login.kioskOnly.title": "Gate attendance only",
  "auth.login.kioskOnly.body":
    "This employee code is set up for the gate scanner, not the portal. Your attendance is recorded when you scan at the gate.",
  "auth.login.kioskOnly.hint":
    "For payslips, leave or anything else, HR will help you in person — ask at the HR desk.",
  "auth.login.blocked.title": "This account is not active",
  "auth.login.blocked.body": "Sign-in is closed for this account. Please contact HR.",

  // ── Errors and progress ────────────────────────────────────────────────────
  "auth.login.busy": "Signing you in…",
  "auth.login.degraded":
    "The employee-code lookup is not reachable right now. Fingerprint and face sign-in still work from your employee code; password sign-in needs your full work email.",
  "auth.login.error.offline": "The server could not be reached. Check the connection and try again.",
  "auth.login.error.rateLimited": "Too many attempts. Wait a few minutes, then try again.",
  "auth.login.error.sessionFailed":
    "Your identity was verified but the session could not be opened. Try again, or use your password.",

  // ── The comparison the screen states out loud ───────────────────────────────
  "auth.login.security.title": "How these compare",
  "auth.login.security.passkeyLine":
    "Fingerprint (passkey) — strongest. Bound to this device and to this site; nothing reusable is ever sent.",
  "auth.login.security.passwordLine":
    "Password — strong while it is yours alone. Ten failed attempts deactivate the account.",
  "auth.login.security.faceLine":
    "Face — convenience only, and the weakest of the three: a face can be shown to a camera. The camera also measures how much the picture moves between frames, which stops a still image but not a held photograph.",
  // Was: "Every attempt, successful or not, is written to the sign-in audit."
  // That is not true of a refused PASSWORD attempt: it never reaches a function
  // of ours, so nothing of ours can record it.
  "auth.login.security.audit":
    "A sign-in that succeeds is recorded with the time, the network address, the device and the method — you can read your own record under Profile → Security. Refused fingerprint and face attempts are recorded for the security team. A refused password attempt is handled by the sign-in service itself and does not appear in that record.",
} as const;
