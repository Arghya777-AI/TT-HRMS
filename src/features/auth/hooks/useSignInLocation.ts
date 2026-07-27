/**
 * useSignInLocation — the sign-in location, asked for once per screen.
 *
 * Deliberately NOT react-query: this is a one-shot browser permission, not a
 * cacheable server read, and a retry loop on a permission prompt would be
 * hostile. The hook holds the outcome so the screen can show what happened, and
 * exposes `ask()` for the "Share my location" retry.
 *
 * A refusal is a settled state, not an error: `status` becomes `denied` and
 * `geo` stays null. Nothing in the sign-in flow branches on this — see
 * `Login.tsx`, where every method proceeds regardless.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  readGeolocationPermission,
  requestSignInLocation,
  supportsGeolocation,
  type SignInGeo,
  type SignInLocationStatus,
} from "../lib/geolocation";

export interface SignInLocation {
  status: SignInLocationStatus;
  geo: SignInGeo | null;
  /** Ask (or re-ask). Resolves with whatever we got, so callers can pass it on. */
  ask: () => Promise<SignInGeo | null>;
}

export function useSignInLocation(): SignInLocation {
  const [status, setStatus] = useState<SignInLocationStatus>(() =>
    supportsGeolocation() ? "idle" : "unavailable",
  );
  const [geo, setGeo] = useState<SignInGeo | null>(null);
  /** Guards against two overlapping prompts if the button is double-tapped. */
  const inFlight = useRef<Promise<SignInGeo | null> | null>(null);

  // A previously refused permission is knowable without prompting. Say so up
  // front instead of firing a prompt the browser will swallow silently.
  useEffect(() => {
    if (!supportsGeolocation()) return;
    let cancelled = false;
    void readGeolocationPermission().then((state) => {
      if (cancelled || state !== "denied") return;
      setStatus((prev) => (prev === "idle" ? "denied" : prev));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const ask = useCallback(async (): Promise<SignInGeo | null> => {
    if (inFlight.current !== null) return inFlight.current;
    if (!supportsGeolocation()) {
      setStatus("unavailable");
      return null;
    }
    setStatus("asking");
    const pending = requestSignInLocation().then((outcome) => {
      setStatus(outcome.status);
      setGeo(outcome.geo);
      inFlight.current = null;
      return outcome.geo;
    });
    inFlight.current = pending;
    return pending;
  }, []);

  return { status, geo, ask };
}
