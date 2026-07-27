/**
 * usePasskeyCapability — the async half of the WebAuthn feature detection.
 *
 * The synchronous check (`PublicKeyCredential` + `navigator.credentials.get` +
 * secure context) settles on the first render; the platform-authenticator probe
 * is a promise, so the fingerprint button appears the moment it answers rather
 * than being rendered and then withdrawn.
 */
import { useEffect, useState } from "react";
import {
  browserCanUsePasskeys,
  detectPasskeyCapability,
  type PasskeyCapability,
} from "../lib/passkeySupport";

export function usePasskeyCapability(): PasskeyCapability {
  const [capability, setCapability] = useState<PasskeyCapability>(() => ({
    supported: browserCanUsePasskeys(),
    platform: false,
    checked: false,
  }));

  useEffect(() => {
    let cancelled = false;
    void detectPasskeyCapability().then((next) => {
      if (!cancelled) setCapability(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return capability;
}
