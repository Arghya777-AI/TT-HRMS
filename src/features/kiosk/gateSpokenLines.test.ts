/**
 * What the gate SAYS OUT LOUD when it has recorded somebody.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────────
 * The gate has four success lines: three from the server (`in`, `out`, `scan`) and one for a
 * scan held on the device during an outage (`queued`). The first three opened with "Thank you."
 * The fourth did not — it read "Your attendance is saved on this device and will be sent
 * shortly."
 *
 * So during an outage the terminal spoke, and the two words people actually listen for were
 * missing. A held scan is a success for the person standing there — they are recorded and can
 * walk on — but it sounded like a machine reporting a problem. Nothing in a build, a typecheck
 * or a screenshot catches a missing courtesy in a line that is never rendered.
 *
 * These assertions read the shipped strings, so a rewrite of any spoken line has to keep the
 * distinction between "you are recorded" and "you are not" deliberate rather than accidental.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keysKioskAdmin } from "@/shared/i18n/keys/kiosk-admin";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** Every line spoken after a punch was actually written — including one held offline. */
const RECORDED = ["kiosk.gate.say.in", "kiosk.gate.say.out", "kiosk.gate.say.scan", "kiosk.gate.say.queued"] as const;

/** Lines where nothing new was recorded. Thanking somebody here would be a lie. */
const NOT_RECORDED = ["kiosk.gate.say.duplicate", "kiosk.gate.say.failed", "kiosk.gate.say.problem"] as const;

describe("a recorded scan is thanked, offline included", () => {
  it.each(RECORDED)("%s opens with the thank you", (key) => {
    expect(keysKioskAdmin[key]).toMatch(/^Thank you\. /);
  });

  it.each(RECORDED)("%s tells them they are registered", (key) => {
    /*
      THE REGRESSION. `queued` said "saved on this device", which is true and which no employee
      recognises as the confirmation they were waiting for. The word people listen for is the
      same one the online lines use.
    */
    expect(keysKioskAdmin[key]).toContain("attendance is registered");
  });

  it("still admits, in the offline line only, that it has not been sent", () => {
    /*
      The courtesy must not cost the honesty. The person is entitled to know the punch is on the
      tablet and not yet at the server — and an outage that sounded exactly like a normal day
      would stay hidden until somebody happened to read the screen.
    */
    expect(keysKioskAdmin["kiosk.gate.say.queued"]).toContain("will be sent shortly");
    for (const key of ["kiosk.gate.say.in", "kiosk.gate.say.out", "kiosk.gate.say.scan"] as const) {
      expect(keysKioskAdmin[key], key).not.toContain("will be sent");
    }
  });

  it("does not make the foyer line any longer than the one it replaced", () => {
    // "Your attendance is saved on this device and will be sent shortly." — 12 words.
    const words = keysKioskAdmin["kiosk.gate.say.queued"].split(/\s+/).length;
    expect(words).toBeLessThanOrEqual(12);
  });

  it("never guesses the direction with no server to ask", () => {
    /*
      `punchKind` is the SERVER's ordinal for the day. Offline there is none, and a local guess
      would eventually contradict the record — the worst outcome for a sentence whose whole job
      is to be believed.
    */
    expect(keysKioskAdmin["kiosk.gate.say.queued"]).not.toMatch(/inwards|outwards/);
  });
});

describe("a scan that recorded nothing is not thanked", () => {
  it.each(NOT_RECORDED)("%s does not open with the thank you", (key) => {
    expect(keysKioskAdmin[key]).not.toMatch(/^Thank you\./);
  });

  it("does not tell a debounced re-scan that it counted", () => {
    // "already registered", never "is registered" — the second scan wrote nothing.
    expect(keysKioskAdmin["kiosk.gate.say.duplicate"]).toContain("already registered");
    expect(keysKioskAdmin["kiosk.gate.say.duplicate"]).not.toContain("attendance is registered");
  });
});

describe("the offline line belongs to the TT Gate app and its link, and nowhere else", () => {
  it("is spoken by the gate scanner", () => {
    expect(read("src", "features", "kiosk", "screens", "GateScanScreen.tsx")).toContain(
      't("kiosk.gate.say.queued")',
    );
  });

  it("is not reachable from the web or mobile punch", () => {
    /*
      Asked for explicitly: the change is for the gate only. `useSelfPunch` has no offline path
      — a web punch needs the network and its location — so if this key ever appears there, the
      wording would be announced in a context where "will be sent shortly" is not true.
    */
    expect(read("src", "features", "attendance", "hooks", "useSelfPunch.ts")).not.toContain(
      "kiosk.gate.say.queued",
    );
  });
});
