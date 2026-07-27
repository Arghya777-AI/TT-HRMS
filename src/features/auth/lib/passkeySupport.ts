/**
 * passkeySupport.ts — can this browser actually do a WebAuthn assertion?
 *
 * The fingerprint button is only offered when the answer is yes. Offering it
 * anywhere else produces the worst possible sign-in screen: a prominent button
 * that throws `NotSupportedError` on the tap.
 *
 * Two independent facts, in this order:
 *   `supported`  — `window.PublicKeyCredential` exists AND `navigator.credentials.get`
 *                  exists AND we are in a secure context. This is the gate.
 *   `platform`   — `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`
 *                  says the device has a built-in authenticator (Touch ID, Windows
 *                  Hello, an Android fingerprint sensor). We PREFER these: the
 *                  venue's staff have phones and laptops, not USB keys. It only
 *                  changes the wording — a security key still works.
 *
 * `@simplewebauthn/browser` ships both probes and they are the same two checks;
 * they are called through here so the login screen has ONE place that decides,
 * and so the reason each one exists is written down next to it.
 */
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from "@simplewebauthn/browser";

export interface PasskeyCapability {
  /** WebAuthn assertions are possible in this browser. */
  supported: boolean;
  /** A built-in fingerprint/face authenticator is available on this device. */
  platform: boolean;
  /** False until the async platform probe has answered. */
  checked: boolean;
}

export const PASSKEY_CAPABILITY_UNKNOWN: PasskeyCapability = {
  supported: false,
  platform: false,
  checked: false,
};

/** Synchronous half — safe during render. */
export function browserCanUsePasskeys(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.PublicKeyCredential !== "function") return false;
  if (navigator.credentials === undefined || typeof navigator.credentials.get !== "function") {
    return false;
  }
  // WebAuthn is refused outright off a secure origin; the check keeps the button
  // away from an http:// preview rather than letting the ceremony fail.
  if (!window.isSecureContext) return false;
  return browserSupportsWebAuthn();
}

/** Full probe. Never throws — an unavailable probe reads as "no platform sensor". */
export async function detectPasskeyCapability(): Promise<PasskeyCapability> {
  const supported = browserCanUsePasskeys();
  if (!supported) return { supported: false, platform: false, checked: true };
  try {
    const platform = await platformAuthenticatorIsAvailable();
    return { supported: true, platform, checked: true };
  } catch {
    return { supported: true, platform: false, checked: true };
  }
}
