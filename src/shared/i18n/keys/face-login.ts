/**
 * i18n keys owned EXCLUSIVELY by `shared/ui/FaceLoginSwitch.tsx` and the face-login
 * switch hooks.
 *
 * The copy here does real work. "Enabled" on this switch does NOT mean "will work" —
 * a live consented template must exist and the account must not be privileged — so
 * most of these strings exist to say which condition is unmet, in words the reader
 * can act on. A green toggle over a sign-in that keeps refusing is worse than no
 * toggle at all.
 */
export const keysFaceLogin = {
  // ── The control ───────────────────────────────────────────────────────────
  "faceLogin.title.self": "Sign in with your face",
  "faceLogin.title.other": "Face sign-in",
  "faceLogin.hint.self":
    "Use your enrolled face instead of your password to sign in. Your password keeps working either way, and this does not affect punching at the gate.",
  "faceLogin.hint.other":
    "Whether this person may use their enrolled face to sign in. It does not affect their punching at the gate, and it does not withdraw their biometric consent.",
  "faceLogin.state.on": "Enabled",
  "faceLogin.state.off": "Disabled",
  "faceLogin.action.enable": "Enable face sign-in",
  "faceLogin.action.disable": "Disable face sign-in",

  // ── Why an enabled switch may still not sign you in ───────────────────────
  /**
   * The one a reader cannot discover any other way: `face-login` refuses privileged
   * accounts and returns the SAME generic message as "no template", so the sign-in
   * screen can never explain it. This is the only place it can be said.
   */
  "faceLogin.block.privilegedSelf":
    "Your account holds a manager, admin or super-admin role, and face sign-in is not offered to privileged accounts — a stolen face would open too much. Use your password or a passkey.",
  "faceLogin.block.privileged":
    "This account holds a manager, admin or super-admin role. Face sign-in is not offered to privileged accounts, whatever this switch says.",
  "faceLogin.block.notEnrolledSelf":
    "You have not enrolled a face yet. Ask HR to start enrolment, then this will begin working.",
  "faceLogin.block.notEnrolled":
    "This person has not enrolled a face yet, so there is nothing to match against.",
  "faceLogin.block.templateGoneSelf":
    "You enrolled before, but there is no active face template now — it may have been retired, purged, or your consent withdrawn. Enrol again to use this.",
  "faceLogin.block.templateGone":
    "They enrolled before, but no active template remains — retired, purged, or consent withdrawn.",

  // ── Failure ───────────────────────────────────────────────────────────────
  "faceLogin.noPermission":
    "You may see this setting but not change it. An admin, or this person's reporting manager, can.",
  "faceLogin.error": "The setting could not be changed. Try again.",
  /** A profile with no employee row — a rare state, but it must not render blank. */
  "faceLogin.noEmployee":
    "Your account is not linked to an employee record yet, so there is no face sign-in setting to show. HR can link it.",

  // ── The admin list ────────────────────────────────────────────────────────
  "faceLogin.admin.title": "Face sign-in",
  "faceLogin.admin.hint":
    "Who may open a session with their face. Employees can set their own; a reporting manager can set their team's; you can set anyone in your scope.",
  "faceLogin.admin.col.person": "Employee",
  "faceLogin.admin.col.state": "Face sign-in",
  "faceLogin.admin.col.enrolled": "Enrolled",
  "faceLogin.admin.col.action": "",
  "faceLogin.admin.privileged": "Privileged account — refused regardless",
  "faceLogin.admin.template.live": "Face enrolled and active",
  "faceLogin.admin.template.gone": "Enrolled, but no active template",
  "faceLogin.admin.template.none": "Not enrolled",
  "faceLogin.admin.empty": "Nobody in your scope has an employee record yet.",
} as const;
