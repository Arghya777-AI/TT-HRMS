/**
 * The gate's sound control cannot silence the gate by accident, and says which silence it is.
 *
 * ── THE REPORT ───────────────────────────────────────────────────────────────
 * "The confirmation sound and the denial sound are not coming on the Official TT gate device,
 * offline and online." The audio code turned out to be right: `announcePunch` is called on
 * every outcome including the debounced one, `chimeForOutcome` maps it to the `duplicate`
 * voice, and the 5-minute rule is firing — 249 `duplicate_suppressed` rows on that device,
 * the most recent the morning it was reported.
 *
 * So the silence was the DEVICE's state, and there are exactly three of those:
 *
 *   muted        somebody tapped the speaker icon; it persists in localStorage forever
 *   locked       the browser is waiting for a gesture before it will make any sound
 *   ready        audio works, and the tablet's own volume is down
 *
 * ── WHAT WAS WRONG WITH THE CONTROL ──────────────────────────────────────────
 * It was a plain toggle, which made it a trap. A guard investigating "the gate makes no
 * noise" taps the speaker — and the tap MUTES it, persistently, across reloads. The one action
 * somebody takes to diagnose the fault was the action that caused it, and the only feedback
 * was a 16px glyph gaining a cross, read from across a foyer.
 *
 * Now a tap always makes a noise: it unlocks, un-mutes, and plays the tone. Muting takes a
 * deliberate press-and-hold. And the state is a WORD, with `chimeStatus()` — which existed and
 * was rendered nowhere — shown in the log sheet so it can be read out over the phone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chimeForOutcome } from "@/shared/audio/chime";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const header = strip(read("src", "features", "kiosk", "components", "GateLiveHeader.tsx"));
const sheet = strip(read("src", "features", "kiosk", "components", "LocalLogSheet.tsx"));
const scan = strip(read("src", "features", "kiosk", "screens", "GateScanScreen.tsx"));
const punchFn = strip(read("supabase", "functions", "kiosk-punch", "index.ts"));

describe("a tap tests the sound; it cannot silence the gate", () => {
  it("never mutes from a click", () => {
    /*
      The whole bug. `setMuted(true)` must not be reachable from the click handler — only from
      the hold timer.
    */
    const click = header.slice(header.indexOf("onClick={() => {"));
    expect(click.slice(0, click.indexOf("aria-label"))).not.toContain("setMuted(true)");
  });

  it("un-mutes, unlocks and plays on every tap", () => {
    const fn = header.slice(header.indexOf("const testOrEnable"));
    const body = fn.slice(0, fn.indexOf("const startHold"));
    expect(body).toContain("setMuted(false)");
    expect(body).toContain("primeChime()");
    expect(body).toContain('playChime("recorded")');
  });

  it("puts muting behind a deliberate press and hold", () => {
    expect(header).toContain("onPointerDown={startHold}");
    expect(header).toContain("setMuted(true)");
    expect(header).toContain("}, 700)");
    // Releasing must cancel, or a scroll would mute the gate.
    for (const off of ["onPointerUp={endHold}", "onPointerLeave={endHold}", "onPointerCancel={endHold}"]) {
      expect(header).toContain(off);
    }
  });

  it("does not let the click that follows a hold undo the mute", () => {
    expect(header).toContain("if (held.current) {");
  });
});

describe("the state is a word, not a glyph", () => {
  it("labels all three states", () => {
    expect(header).toContain('locked ? "Enable sound" : muted ? "Sound off" : "Sound on"');
  });

  it("renders a muted gate as a fault, in the destructive colour", () => {
    const cls = header.slice(header.indexOf("className={cn("), header.indexOf("</button>"));
    expect(cls).toContain("bg-destructive/20");
  });

  it("shows the diagnostic that existed and was displayed nowhere", () => {
    expect(sheet).toContain("chimeStatus()");
    expect(sheet).toContain("kiosk.gate.log.sound");
    const en = read("src", "shared", "i18n", "keys", "kiosk-admin.ts");
    expect(en).toContain('"kiosk.gate.log.sound"');
  });
});

describe("the outcomes that must make a noise", () => {
  it("gives a debounced re-scan its own voice, not the success one", () => {
    expect(chimeForOutcome({ matched: true, duplicateSuppressed: true })).toBe("duplicate");
    expect(chimeForOutcome({ matched: true })).toBe("recorded");
  });

  it("gives an unrecognised face the error voice", () => {
    expect(chimeForOutcome({ matched: false })).toBe("error");
  });

  it("gives an offline hold its own voice, so an outage cannot sound like success", () => {
    expect(chimeForOutcome({ matched: true, queued: true })).toBe("queued");
  });

  it("announces EVERY outcome from the scan screen, duplicate included", () => {
    expect(scan).toContain("announcePunch(kind, spoken)");
    expect(scan).toContain("kiosk.gate.say.duplicate");
    expect(scan).toContain('announcePunch("error"');
    expect(scan).toContain("chimeForOutcome(result.data)");
  });
});

describe("the five-minute rule the sound is meant to announce", () => {
  it("floors the gate's debounce at 300 seconds whatever the policy says", () => {
    expect(punchFn).toContain("const GATE_MIN_DEBOUNCE_SECONDS = 300;");
    expect(punchFn).toContain("Math.max(resolvedDebounce, GATE_MIN_DEBOUNCE_SECONDS)");
  });

  it("reports the suppression to the client, so it can be heard and shown", () => {
    expect(punchFn).toContain("duplicateSuppressed");
  });
});
