/**
 * refusalCopy.ts — one place that turns a typed refusal into a sentence.
 *
 * Two rules, and they pull in opposite directions on purpose:
 *
 *   PREFER THE SERVER'S WORDS. `webauthn-login` and `face-login` write
 *   deliberate, already-anti-enumeration copy into `problem.detail`
 *   ("Fingerprint sign-in isn't available for that account. Use your password
 *     instead."). Replacing that with something vaguer loses information the
 *   employee needs.
 *
 *   EXCEPT FOR PASSWORDS. GoTrue's own message ("Invalid login credentials")
 *   distinguishes a wrong password from a non-existent user across enough
 *   surfaces to be an enumeration oracle, and spec-employee E-01 specifies ONE
 *   generic string for this screen. So the password path never shows the
 *   provider's text.
 */
import { t } from "@/shared/i18n/en";
import type { Refused, SignInMethod } from "../api/signin.api";

export function refusalMessage(refusal: Refused, method: SignInMethod): string {
  const serverSaid = refusal.message !== null && refusal.message.trim() !== "" ? refusal.message : null;

  switch (refusal.reason) {
    case "cancelled":
      return method === "face" ? t("auth.login.face.refused") : t("auth.login.passkey.cancelled");

    /**
     * The browser refused to open the platform prompt, not the employee. Never
     * shown for face or password: only the WebAuthn ceremony has a transient
     * user activation to lose (`signin.api.ts#classifyCeremonyError`).
     */
    case "activation_lost":
      return method === "passkey"
        ? t("auth.login.passkey.activationLost")
        : t("auth.login.genericError");

    case "unsupported":
      return method === "face" ? t("auth.login.face.unsupported") : t("auth.login.passkey.unsupported");

    /**
     * This device produced something the server's contract cannot accept — a
     * descriptor of the wrong length, or a metric outside 0–1. It is a property of
     * the device, so it is not phrased as a failed match: nothing was compared.
     */
    case "incompatible":
      return method === "face"
        ? t("auth.login.face.incompatible")
        : t("auth.login.passkey.notReady");

    case "not_available":
      if (serverSaid !== null) return serverSaid;
      return method === "face" ? t("auth.login.face.refused") : t("auth.login.passkey.notEnrolled");

    case "not_deployed":
      return method === "face" ? t("auth.login.face.notReady") : t("auth.login.passkey.notReady");

    case "rate_limited":
      return serverSaid ?? t("auth.login.error.rateLimited");

    case "offline":
      return t("auth.login.error.offline");

    case "session":
      return t("auth.login.error.sessionFailed");

    case "credentials":
      if (method === "password") return t("auth.login.genericError");
      if (serverSaid !== null) return serverSaid;
      return method === "face" ? t("auth.login.face.refused") : t("auth.login.passkey.failed");

    case "server":
      if (method === "password") return t("auth.login.genericError");
      return serverSaid ?? t("auth.login.genericError");
  }
}

/** Which method a completed sign-in used, for the confirmation line. */
export function methodName(method: SignInMethod): string {
  switch (method) {
    case "password":
      return t("auth.login.methodName.password");
    case "passkey":
      return t("auth.login.methodName.passkey");
    case "face":
      return t("auth.login.methodName.face");
  }
}

/** The success line, which always names the method and its standing. */
export function signedInMessage(method: SignInMethod): string {
  switch (method) {
    case "password":
      return t("auth.login.signedInWith.password");
    case "passkey":
      return t("auth.login.signedInWith.passkey");
    case "face":
      return t("auth.login.signedInWith.face");
  }
}
