/**
 * /kiosk — THE GATE SCANNER. A link you open on the phone at the gate.
 *
 * The client's description, and what each sentence became:
 *
 *   "There will be a kiosk thing, which is basically a link."
 *       → this route, standalone: no app shell, no nav, no HR data, no login.
 *   "Opening the link on a device should allow using the front or back camera…
 *    There should be an option like Front and Back Camera."
 *       → `components/CameraChoice.tsx`, `hooks/useCamera.ts`. Front by default
 *         for the guard's own scan, back for the queue, the choice kept for the
 *         session, and an honest "this device has one camera" instead of a dead
 *         toggle.
 *   "First, it can ask: Who is at the duty of the security gate? Kindly log in.
 *    The security guy scans his face first with the front camera."
 *       → `screens/GuardSignInScreen.tsx`, front camera forced.
 *   "Then for the rest of the people, he scans using the back camera or the front
 *    camera, whichever is possible. It should recognize very quickly and record
 *    attendance at the gate."
 *       → `screens/GateScanScreen.tsx` and `lib/gateScanner.ts`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE GUARD SIGN-IN DECISION, AND ITS SECURITY TRADE-OFF
 * ═════════════════════════════════════════════════════════════════════════════
 * OPTION (b), CHOSEN: THE FACE IDENTIFIES THE GUARD; THE PIN AUTHORISES THE SHIFT.
 * The front camera names whoever is standing there — searched against the OPERATOR
 * ROSTER for this device only — and the keypad then opens the session with that
 * guard's code already filled in. One new backend op does the naming
 * (`supabase/functions/kiosk-guard-identify`, auth model D, device HMAC, grants
 * nothing); `kiosk-operator-auth` is untouched, so the PIN path that works today
 * keeps working byte for byte.
 *
 * Option (a) — face identifies and the device HMAC authorises, no PIN — was
 * rejected, for four reasons that are all already written down in this codebase:
 *
 *   1. A FACE IS AN IDENTIFIER, NOT A SECRET. `face-login/index.ts` says so at
 *      length and refuses on principle to let a 1:N face match hand over session
 *      authority. An open operator session IS authority: `kiosk-punch` accepts it
 *      for every person who walks through the gate for the rest of the shift.
 *   2. THE DEVICE HMAC IS POSSESSION, NOT KNOWLEDGE. `lib/deviceAuth.ts` states
 *      plainly that the secret sits in this browser's localStorage on a device
 *      left in a public place, and that the defence is admin revocation. So
 *      "face + device" reduces to "hold the gate phone and hold up a photo of the
 *      guard" — that is one photograph away from a stranger opening a shift.
 *   3. THERE IS NO LIVENESS CHECK IN THIS BUILD. `admin.kiosk.policy` can turn
 *      liveness off entirely and its own copy admits a printed photo would then
 *      pass. Until liveness is real, a printed photo must not start a shift.
 *   4. THE COST OF KEEPING THE PIN IS ~5 SECONDS PER SHIFT. It is typed ONCE, not
 *      per person. The face still removes the thing the client actually
 *      complained about: keying an employee code on a phone at a gate.
 *
 * WHAT THE TRADE-OFF COSTS: the guard must still remember a PIN, and a forgotten
 * PIN still needs a supervisor. WHAT IT BUYS: a photograph cannot open a shift,
 * and every punch recorded afterwards is attributable to a human who proved a
 * secret — which is what makes a disputed punch defensible.
 *
 * ENFORCED BOTH WAYS, SERVER-SIDE, TWICE: the signer-in must be an employee with
 * an ACTIVE `public.kiosk_operators` row for this device.
 * `kiosk-guard-identify` will not even NAME a face that is not on that roster, and
 * `kiosk-operator-auth` re-reads the row before it mints a token. A face match is
 * identification; the roster row plus the PIN is authorisation.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SPEED — MEASURED, NOT ASSERTED
 * ═════════════════════════════════════════════════════════════════════════════
 * Per-net cost, this repo's own weights, tfjs CPU backend, 1280×720 input, p50 of
 * 12 runs: detector 320 → 270 ms, detector 224 → 117 ms, detector 160 → 62 ms,
 * landmarks (tiny) → 35 ms, 128-D descriptor → 204 ms.
 *
 * The kiosk this replaces ran `readFrame` on a 650 ms interval, and `readFrame`
 * runs the detector TWICE — so every frame cost ≈780 ms whether or not anybody was
 * there. Four changes, in the order they matter:
 *   1. TWO PHASES. Tracking is detector-only (117 ms); the 204 ms descriptor is
 *      spent once, on the frame that is about to be sent.
 *   2. ONE DETECTOR PASS on that capture frame (`singlePass`), removing the second
 *      270 ms detection.
 *   3. inputSize 224 for the TRACKING pass only. The capture frame stays at
 *      `DESCRIPTOR_INPUT_SIZE` (320): a smaller detector input moves the bounding
 *      box, which moves the aligned crop, which changes the descriptor — so a
 *      cheaper capture frame would be a descriptor nothing else could match. The
 *      saving is taken where it is free (a frame that is thrown away) and not
 *      where it would silently break recognition.
 *   4. MODELS LOAD AT MOUNT, not when the scan screen appears, and exactly one
 *      frame is ever in flight (the loop awaits itself; no interval).
 * Compute from face-in-frame to descriptor-on-the-wire is therefore
 * 2×117 + 356 ≈ 590 ms against ≈2.3 s before. The screen then measures the REAL
 * end-to-end number on the device it is running on — face-in-frame to result card,
 * including the round trip — and shows it in the footer, last and median.
 *
 * @route-standalone /kiosk
 *   Mounted directly by src/app/routes.tsx, outside the shell and outside the
 *   capability-gated tree — so it is deliberately NOT in PAGE_REGISTRY.
 */
import { useCallback, useState } from "react";
import {
  clearDeviceState,
  clearSession,
  closeOperatorSession,
  loadDeviceState,
  type KioskDeviceState,
} from "../lib/deviceAuth";
import { useFaceEngine } from "../hooks/useFaceEngine";
import { PairingScreen } from "../screens/PairingScreen";
import { GuardSignInScreen } from "../screens/GuardSignInScreen";
import { GateScanScreen } from "../screens/GateScanScreen";

type Phase =
  | { name: "pairing" }
  | { name: "guard"; device: KioskDeviceState }
  | { name: "scan"; device: KioskDeviceState };

export default function KioskPage() {
  // Started here, at the root, so the 6.4 MB recognition net downloads while the
  // guard pairs the phone or keys a PIN.
  const engine = useFaceEngine();

  const [phase, setPhase] = useState<Phase>(() => {
    const device = loadDeviceState();
    if (device === null) return { name: "pairing" };
    return device.session !== undefined ? { name: "scan", device } : { name: "guard", device };
  });

  /** End of shift, deliberate: tell the server, then wipe the token locally. */
  const signOut = useCallback(() => {
    setPhase((prev) => {
      if (prev.name !== "scan") return prev;
      void closeOperatorSession(prev.device);
      return { name: "guard", device: clearSession(prev.device) };
    });
  }, []);

  /** The session died on its own (expiry, idle timeout, guard deactivated). Same
   * destination, but nothing is sent — there is nothing left to close. */
  const sessionExpired = useCallback(() => {
    setPhase((prev) =>
      prev.name === "scan" ? { name: "guard", device: clearSession(prev.device) } : prev,
    );
  }, []);

  const updateDevice = useCallback((device: KioskDeviceState) => {
    setPhase((prev) => (prev.name === "scan" ? { name: "scan", device } : prev));
  }, []);

  /**
   * THE PAIRING ITSELF IS DEAD — forget it and start over.
   *
   * `kiosk-device-activate` rotates the device secret with no grace window, so the
   * moment an admin re-issues a pairing code and anybody redeems it, every other
   * browser holding the old secret is bricked. Without this the kiosk showed
   * "Request signature does not verify" over the viewfinder and offered "Type my code
   * instead", which posts through the same dead signature — a screen with no exit
   * except clearing site data. Re-pairing is the only recovery, so the kiosk goes
   * there by itself.
   *
   * `clearDeviceState()` first: leaving the dead secret in localStorage would restore
   * this same trap on the next reload.
   */
  const unpaired = useCallback(() => {
    clearDeviceState();
    setPhase({ name: "pairing" });
  }, []);

  if (phase.name === "pairing") {
    return <PairingScreen onPaired={(device) => setPhase({ name: "guard", device })} />;
  }
  if (phase.name === "guard") {
    return (
      <GuardSignInScreen
        device={phase.device}
        engine={engine}
        onOpen={(device) => setPhase({ name: "scan", device })}
        onUnpaired={unpaired}
      />
    );
  }
  return (
    <GateScanScreen
      device={phase.device}
      engine={engine}
      onDeviceState={updateDevice}
      onSignOut={signOut}
      onSessionExpired={sessionExpired}
      onUnpaired={unpaired}
    />
  );
}
