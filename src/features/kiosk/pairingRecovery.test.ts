/**
 * pairingRecovery.test.ts — a kiosk whose secret was rotated must find its own way
 * back to the pairing screen.
 *
 * THE DEAD END THIS CLOSES
 * ------------------------
 * `kiosk-device-activate` rotates the device secret and sets no grace window ("there
 * is no older install to keep alive"). So the instant an admin re-issues a pairing
 * code and anybody redeems it, every other browser holding that device's old secret
 * is finished — and until this existed the kiosk did not know it. It printed
 *
 *     "That scan did not go through — Request signature does not verify."
 *
 * across the viewfinder and offered "Type my code instead", which posts through the
 * SAME dead signature and fails the same way. There was no exit from that screen
 * except clearing site data, which is not something anybody at a gate will do. The
 * client hit it within minutes of a code being re-issued.
 *
 * WHY A TEST AND NOT JUST THE FIX
 * -------------------------------
 * The fix depends on a list of error codes matching what the server throws, in
 * another language, in a file nothing typechecks together with this one. That is a
 * drift risk of exactly the kind that produced the original bug — so the list is
 * PARSED OUT OF `_shared/auth.ts` rather than restated here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDevicePairingDead } from "./lib/deviceAuth";

const ROOT = process.cwd();
const SHARED_AUTH = readFileSync(join(ROOT, "supabase/functions/_shared/auth.ts"), "utf8");
const GUARD_SCREEN = readFileSync(join(ROOT, "src/features/kiosk/screens/GuardSignInScreen.tsx"), "utf8");
const GATE_SCREEN = readFileSync(join(ROOT, "src/features/kiosk/screens/GateScanScreen.tsx"), "utf8");
const PAGE = readFileSync(join(ROOT, "src/features/kiosk/pages/Kiosk.page.tsx"), "utf8");

describe("a dead device pairing sends the kiosk back to pairing", () => {
  it("treats every credential failure verifyDevice can throw as fatal", () => {
    // Parsed from the server, not restated: if `verifyDevice` gains a new code for a
    // broken credential, this fails until the client knows about it.
    const thrown = new Set(
      [...SHARED_AUTH.matchAll(/"(KIOSK_(?:SIGNATURE|DEVICE|SECRET)_[A-Z_]+)"/g)].map((m) => m[1] ?? ""),
    );
    expect(thrown.size).toBeGreaterThan(2);

    // Everything about the DEVICE's identity or signature is unrecoverable.
    for (const code of ["KIOSK_SIGNATURE_INVALID", "KIOSK_SIGNATURE_STALE", "KIOSK_DEVICE_UNKNOWN", "KIOSK_DEVICE_SUSPENDED"]) {
      expect(thrown.has(code), `${code} is no longer thrown by verifyDevice`).toBe(true);
      expect(isDevicePairingDead(code), `${code} must force re-pairing`).toBe(true);
    }
  });

  it("does NOT throw away a good pairing over a transient or policy refusal", () => {
    // `KIOSK_NONCE_REPLAY` is a 409 that the next request fixes by minting a fresh
    // nonce. `KIOSK_DEVICE_NETWORK` is a 403 about WHERE the device is, not about its
    // credential — and clearing the pairing over it would make an admin issue a code
    // to solve a firewall problem.
    expect(isDevicePairingDead("KIOSK_NONCE_REPLAY")).toBe(false);
    expect(isDevicePairingDead("KIOSK_DEVICE_NETWORK")).toBe(false);
    // Operator-level failures belong to the SHIFT, not the device.
    expect(isDevicePairingDead("KIOSK_OPERATOR_PIN_INVALID")).toBe(false);
    expect(isDevicePairingDead("KIOSK_OPERATOR_SESSION_INVALID")).toBe(false);
    expect(isDevicePairingDead("FACE_NOT_ADMIN")).toBe(false);
  });

  it("routes BOTH sign-in paths to re-pairing, not just the face one", () => {
    // "Type my code instead" being a second dead end was the actual trap: the guard
    // was offered an escape that failed identically.
    expect(GUARD_SCREEN).toMatch(/face\.kind === "unpaired"/);
    expect(GUARD_SCREEN).toMatch(/isDevicePairingDead\(result\.error\.code\)/);
    expect(GUARD_SCREEN).toMatch(/onUnpairedRef\.current\(\)/);
  });

  it("routes a punch failure to re-pairing too", () => {
    // A shift can be live when the secret is rotated; the scan screen has to recover
    // as well, and its session-expiry path is NOT the same destination.
    expect(GATE_SCREEN).toMatch(/isDevicePairingDead\(result\.error\.code\)/);
    expect(GATE_SCREEN).toMatch(/unpairedRef\.current\(\)/);
  });

  it("forgets the dead secret, so a reload does not restore the trap", () => {
    // Without `clearDeviceState()` the next page load reads the same dead secret out
    // of localStorage and lands straight back on the broken screen.
    // Sliced to the end of the callback rather than to the next `if`: the render was
    // rewritten from early returns to one expression, so a marker taken from the routing
    // below silently became -1 and this assertion started reading the whole file.
    const start = PAGE.indexOf("const unpaired = useCallback");
    expect(start).toBeGreaterThan(-1);
    const handler = PAGE.slice(start, PAGE.indexOf("}, []);", start));
    expect(handler).toContain("clearDeviceState()");
    expect(handler).toContain('setPhase({ name: "pairing" })');
  });

  /*
    ONE SCREEN, NOT TWO. The guard sign-in screen is no longer routed — the gate is
    unattended and boots from pairing straight to scanning — so the scan screen is the only
    place a dead pairing can now surface. `GuardSignInScreen.tsx` still carries its own
    recovery path (asserted above) and is still worth keeping correct, but the count here
    tracks what the page actually mounts.
  */
  it("passes the handler to the one screen that is mounted", () => {
    expect((PAGE.match(/onUnpaired=\{unpaired\}/g) ?? []).length).toBe(1);
    expect(PAGE).not.toContain("<GuardSignInScreen");
  });
});
