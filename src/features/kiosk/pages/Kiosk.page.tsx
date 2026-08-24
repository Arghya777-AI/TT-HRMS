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
 *       → BUILT, THEN WITHDRAWN AT THE CLIENT'S INSTRUCTION. `GuardSignInScreen.tsx`
 *         still exists and is still covered by `kioskContract.test.ts`, because the
 *         endpoints it speaks to are deployed and used elsewhere — but nothing routes
 *         to it. The gate no longer asks who is on duty; see THE GUARD SIGN-IN
 *         DECISION below, which records what that trade cost and what replaced it.
 *   "Then for the rest of the people, he scans using the back camera or the front
 *    camera, whichever is possible. It should recognize very quickly and record
 *    attendance at the gate."
 *       → `screens/GateScanScreen.tsx` and `lib/gateScanner.ts`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE GUARD SIGN-IN DECISION, AND ITS SECURITY TRADE-OFF
 * ═════════════════════════════════════════════════════════════════════════════
 * SUPERSEDED — READ THIS FIRST. There is no guard sign-in at all any more. The
 * client asked for it removed, repeatedly and unambiguously: the gate is a wall
 * terminal that employees walk up to, and nobody is on the door to key a PIN.
 *
 * The reasoning below is kept because it is still the record of WHY a PIN was
 * required in the first place, and every one of its four objections still stands
 * against handing session authority to a face. What changed is that no session is
 * minted at all — the device HMAC alone authorises a punch, and the defence against
 * a held-up photograph moved to liveness, which is now mandatory on every punch and
 * enforced in `kiosk-punch` before the 1:N runs. Point 3 below ("there is no
 * liveness check in this build") is the sentence that is no longer true, and it was
 * the load-bearing one.
 *
 * What was lost with the guard, stated plainly: a punch no longer names a human who
 * was present, and an ambiguous match is no longer resolved at the door — it fails
 * to `/admin/kiosk/match-review` instead.
 *
 * ── THE ORIGINAL DECISION, FOR THE RECORD ────────────────────────────────────
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
 *   Mounted by src/kiosk/main.tsx, its OWN Vite entry — outside the shell, the
 *   router and the capability-gated tree, so it is deliberately NOT in
 *   PAGE_REGISTRY. The gate is a separate installable app that happens to live in
 *   this repo; it shares the face engine and nothing else.
 */
import { useCallback, useState } from "react";
import {
  clearDeviceState,
  clearSession,
  loadDeviceState,
  type KioskDeviceState,
} from "../lib/deviceAuth";
import { useFaceEngine } from "../hooks/useFaceEngine";
import { InstallGateApp } from "../components/InstallGateApp";
import { PairingScreen } from "../screens/PairingScreen";
import { GateScanScreen } from "../screens/GateScanScreen";

/*
  TWO PHASES. THERE IS NO GUARD PHASE.

  The gate is a wall-mounted terminal: it is paired once by whoever installs it, and from
  then on it scans. The third phase — "who is on duty at the gate?", a face identification
  followed by a PIN — is gone, along with the `require_operator` branch that chose it.
*/
type Phase =
  | { name: "pairing" }
  | { name: "scan"; device: KioskDeviceState };

export default function KioskPage() {
  // Started here, at the root, so the 6.4 MB recognition net downloads while the
  // guard pairs the phone or keys a PIN.
  const engine = useFaceEngine();

  /**
   * PAIRED MEANS READY. NOTHING ELSE IS ASKED.
   *
   * A stored pairing is the whole of the gate's setup, and it is stored until an admin
   * revokes the device or the secret is rotated out from under it — so a terminal that was
   * paired once boots straight into scanning, on this reload and every reload after it.
   *
   * This used to branch on `requireOperator` and send an attended device to the guard
   * screen. Three separate things had to be true for that branch to ever produce a working
   * gate — the row, the client's cached copy of the row, and a guard with a PIN — and the
   * failure of any one of them showed up as a terminal that would not scan.
   */
  const [phase, setPhase] = useState<Phase>(() => {
    const device = loadDeviceState();
    return device === null ? { name: "pairing" } : { name: "scan", device };
  });

  /**
   * A LEFTOVER SESSION IS DISCARDED, AND THE GATE KEEPS SCANNING.
   *
   * Both of these used to end a guard's shift and return to the sign-in screen. Neither
   * can be triggered from the terminal any more — the "End shift" button went with the
   * guard, and no session is ever opened to expire. They survive as the landing point for
   * a token left in localStorage by a build that did open sessions: it is cleared, and the
   * gate carries on scanning rather than dead-ending on a screen that no longer exists.
   */
  const dropSession = useCallback(() => {
    setPhase((prev) =>
      prev.name === "scan" ? { name: "scan", device: clearSession(prev.device) } : prev,
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

  /*
    The install bar rides alongside every phase rather than being placed on one of them.
    A tablet is installed BEFORE it is paired as often as after — whoever mounts it on the
    wall wants the home-screen icon first — so offering it only on the scan screen would
    hide it during exactly the setup it belongs to. It renders nothing once the gate is
    running as an installed app, which is the state a wall terminal spends its life in.
  */
  const screen =
    phase.name === "pairing" ? (
      <PairingScreen
        // Paired is ready. Straight to the viewfinder.
        onPaired={(device) => setPhase({ name: "scan", device })}
      />
    ) : (
      <GateScanScreen
        device={phase.device}
        engine={engine}
        onDeviceState={updateDevice}
        onSignOut={dropSession}
        onSessionExpired={dropSession}
        onUnpaired={unpaired}
      />
    );

  return (
    <>
      {screen}
      <InstallGateApp />
    </>
  );
}
