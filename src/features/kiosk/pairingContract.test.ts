/**
 * pairingContract.test.ts — the pairing code is the ONLY thing that has to match.
 *
 * WHY, IN THE CLIENT'S WORDS
 * -------------------------
 * "The device name shouldn't matter; they can put anything for the device name. Only
 *  the pairing code should match, then it should be automatically registered… If
 *  admin generates one particular code, if the code is given, whatever the device
 *  name they can put, and then if they register, then it will be registered."
 *
 * The screen used to demand a DEVICE CODE that had to match a row an admin created,
 * plus the six digits. The guard had no way to know or check the first one, and a
 * typo in it produced the same refusal as a wrong code.
 *
 * WHAT THIS DEFENDS, and why each clause is here rather than in a comment
 * ---------------------------------------------------------------------
 * These are cross-file invariants — client vs server, UI vs wire — and every one of
 * them has already been broken once in this codebase by an edit that looked local:
 *
 *   1. The client must NOT send `device_code`. Sending it narrows the server's
 *      candidate lookup, so a stale or mistyped value turns a good code into a
 *      refusal.
 *   2. The client must send the name as `device.proposed_name`, which is the key the
 *      server's `.strict()` schema accepts. Any other key is a 422 and loses the
 *      pairing.
 *   3. The server must APPLY that name to `kiosk_devices.label`. It used to accept it
 *      and deliberately discard it, reporting it in `ignored_fields` — so a guard
 *      could name a device and watch the name vanish.
 *   4. The server must NOT list `proposed_name` as ignored any more, or the kiosk is
 *      told its name was dropped at the same moment it was saved.
 *   5. Activation must NOT re-pin `allowed_ip_cidrs` from the pairing IP. It did,
 *      which is how TT-GATE-01 ended up locked to a mobile IP and refusing every
 *      guard sign-in the next morning. Migration 073 cleared it; without this
 *      assertion the next pairing would silently re-create the problem.
 *   6. The button must be enabled by the CODE alone — no name required.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ACTIVATE = readFileSync(
  join(ROOT, "supabase/functions/kiosk-device-activate/index.ts"),
  "utf8",
);
const PROVISION = readFileSync(join(ROOT, "supabase/functions/kiosk-provision/index.ts"), "utf8");
const DEVICE_AUTH = readFileSync(join(ROOT, "src/features/kiosk/lib/deviceAuth.ts"), "utf8");
const SCREEN = readFileSync(join(ROOT, "src/features/kiosk/screens/PairingScreen.tsx"), "utf8");

/** Comments discuss `device_code` at length; only code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const AUTH_CODE = stripComments(DEVICE_AUTH);
const SCREEN_CODE = stripComments(SCREEN);
const ACTIVATE_CODE = stripComments(ACTIVATE);

describe("kiosk pairing contract", () => {
  it("read the files at all", () => {
    expect(ACTIVATE.length).toBeGreaterThan(1000);
    expect(AUTH_CODE).toContain("pairDevice");
  });

  /**
   * Just `pairDevice`'s body. Scoped deliberately: `device_code` legitimately
   * appears elsewhere in this module as part of the RESPONSE type (`PairResponse`)
   * and of `KioskDeviceState`, and asserting over the whole file would fail on those
   * — a false positive that would get the assertion deleted rather than fixed.
   */
  const PAIR_FN = (() => {
    const start = AUTH_CODE.indexOf("export async function pairDevice");
    expect(start, "pairDevice not found").toBeGreaterThan(-1);
    const next = AUTH_CODE.indexOf("\nexport ", start + 1);
    return AUTH_CODE.slice(start, next === -1 ? undefined : next);
  })();

  it("the client sends NO device_code in the pairing request", () => {
    // The server keeps accepting it (another installer may exist), but this client
    // must not send one — a wrong value refuses a perfectly good code.
    expect(PAIR_FN).not.toMatch(/device_code\s*:/);
  });

  it("the client sends the chosen name as device.proposed_name", () => {
    expect(PAIR_FN).toMatch(/proposed_name/);
  });

  it("the server still accepts proposed_name in its schema", () => {
    expect(ACTIVATE_CODE).toMatch(/proposed_name:\s*z\.string\(\)/);
  });

  it("the server APPLIES proposed_name to the device label", () => {
    // The whole point. Accepting it and dropping it is what used to happen.
    expect(ACTIVATE_CODE).toMatch(/label\s*=\s*COALESCE\(\$\{body\.device\.proposed_name/);
  });

  it("the server no longer reports proposed_name as ignored", () => {
    expect(ACTIVATE_CODE).not.toMatch(/ignoredFields\.push\(\s*["']device\.proposed_name["']/);
  });

  it("activation does not re-pin allowed_ip_cidrs from the pairing IP", () => {
    // `set_masklen` was the tell: it built a /32 from the request IP and wrote it
    // into the device's allowlist, locking the gate to one network for good.
    expect(ACTIVATE_CODE).not.toMatch(/allowed_ip_cidrs\s*=\s*CASE/);
    expect(ACTIVATE_CODE).not.toMatch(/set_masklen/);
  });

  it("the pairing button is gated by the CODE alone", () => {
    // A name requirement here would put back exactly the friction that was removed.
    expect(SCREEN_CODE).toMatch(/disabled=\{busy \|\| activationCode\.length < 4\}/);
    expect(SCREEN_CODE).not.toMatch(/deviceName\.trim\(\)\s*===\s*""/);
  });

  it("the admin can create a device, and does not have to invent a device_code", () => {
    expect(PROVISION).toMatch(/op:\s*z\.literal\("add_device"\)/);
    expect(PROVISION).toMatch(/INSERT INTO public\.kiosk_devices/);
    // `device_code` must NOT be an input on that op — the server generates it.
    const addDeviceSchema = PROVISION.slice(
      PROVISION.indexOf('const AddDevice = z.object('),
      PROVISION.indexOf('const Body = z.discriminatedUnion'),
    );
    expect(addDeviceSchema.length).toBeGreaterThan(50);
    expect(addDeviceSchema).not.toMatch(/device_code/);
    // And the label must be optional, since the person pairing supplies it.
    expect(addDeviceSchema).toMatch(/label:.*\.optional\(\)/);
  });

  it("add_device issues its code with the same scope the activator looks for", () => {
    // Two different scope strings would mean a code that can never be redeemed.
    expect(PROVISION).toMatch(/ACTIVATION_SCOPE\s*=\s*"kiosk\.activate"/);
    expect(ACTIVATE).toMatch(/ACTIVATION_SCOPE\s*=\s*"kiosk\.activate"/);
  });
});
