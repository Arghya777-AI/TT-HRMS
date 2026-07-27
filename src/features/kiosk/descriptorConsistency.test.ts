/**
 * descriptorConsistency.test.ts — every descriptor in this product must be
 * produced the same way, or none of the distances mean anything.
 *
 * THE DEFECT THIS LOCKS OUT
 * ------------------------
 * Face matching compares a 128-D descriptor taken at the portal (or the gate)
 * against one taken at the enrolment desk. `readFrame`'s `inputSize` sets the
 * detector's input square, which decides the bounding box, which decides
 * face-api's aligned crop, which decides the descriptor. Two call sites on
 * different `inputSize` values do not produce comparable numbers for the same
 * face — the person drifts away from their own template and the punch is refused
 * with nothing visible to explain it.
 *
 * It had drifted three ways at once:
 *
 *   enrolment (EnrolCapture)   inputSize 224   ← a speed change
 *   gate loop (gateScanner)    inputSize 224
 *   portal punch (SelfPunch)   inputSize 320   ← the default
 *   web face sign-in           inputSize 320   ← the default
 *
 * So the desk enrolled at one resolution and the portal matched at another. The
 * gate scanner's own header asserted "the descriptor is identical to the one
 * enrolment produced" while being one of the two that disagreed — a comment
 * cannot hold this invariant, which is why it is a test.
 *
 * WHAT IS ALLOWED
 * ---------------
 *   * `readFrame(video)` — the default, which IS `DESCRIPTOR_INPUT_SIZE`.
 *   * `readFrame(video, { inputSize: DESCRIPTOR_INPUT_SIZE, … })` — explicit.
 *   * `singlePass: true` anywhere. It removes the duplicate detector pass and
 *     reuses the same aligned crop, so it is descriptor-neutral. This is where
 *     speed is supposed to come from.
 *
 * WHAT IS NOT
 * -----------
 *   * A NUMERIC LITERAL for `inputSize` at any `readFrame` call site.
 *
 * A detect-only tracking pass may use any size it likes — it produces no
 * descriptor — so `TinyFaceDetectorOptions` is deliberately not policed here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETECTOR_INPUT_SIZE,
  DESCRIPTOR_INPUT_SIZE,
} from "./lib/facePipeline";

const SRC = join(process.cwd(), "src");
const PIPELINE = join("features", "kiosk", "lib", "facePipeline.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comments mention `inputSize 224` freely and must not be matched. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const FILES = walk(SRC)
  .map((path) => ({ rel: path.slice(SRC.length + 1), code: stripComments(readFileSync(path, "utf8")) }))
  // Not the pipeline (it DEFINES readFrame) and not tests — this very file names
  // `readFrame(` inside its own regexes, which would count as two call sites with
  // no options object and fail every rule below.
  .filter((f) => f.rel !== PIPELINE && !/\.test\.tsx?$/.test(f.rel));

/**
 * Every `readFrame(` call outside the pipeline itself, with the argument text
 * that follows it. Balanced-paren scan rather than a regex, because the options
 * object contains its own braces and a lazy `[^)]*` would stop at the first one.
 */
function readFrameCalls(): { rel: string; args: string }[] {
  const calls: { rel: string; args: string }[] = [];
  for (const file of FILES) {
    let from = 0;
    for (;;) {
      const at = file.code.indexOf("readFrame(", from);
      if (at === -1) break;
      let depth = 0;
      let end = at + "readFrame".length;
      for (; end < file.code.length; end += 1) {
        const ch = file.code[end];
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      calls.push({ rel: file.rel, args: file.code.slice(at + "readFrame(".length, end) });
      from = end;
    }
  }
  return calls;
}

const CALLS = readFrameCalls();

describe("descriptor consistency across every face path", () => {
  it("finds the call sites at all — a silent zero would pass every rule below", () => {
    // Enrolment, portal punch, web face sign-in, gate capture. If a path is added
    // or removed this number moves, and the new one must be checked by hand.
    expect(CALLS.length).toBeGreaterThanOrEqual(4);
  });

  it("passes no numeric inputSize literal at any readFrame call site", () => {
    const offenders = CALLS.filter((c) => /inputSize\s*:\s*\d/.test(c.args)).map((c) => c.rel);
    expect(offenders).toEqual([]);
  });

  it("uses the shared constant wherever inputSize is given explicitly", () => {
    const offenders = CALLS.filter(
      (c) => /inputSize\s*:/.test(c.args) && !/inputSize\s*:\s*DESCRIPTOR_INPUT_SIZE/.test(c.args),
    ).map((c) => c.rel);
    expect(offenders).toEqual([]);
  });

  it("keeps the shared constant equal to the pipeline default, so an omitted option is still correct", () => {
    // Three of the four call sites pass it explicitly and any future one may omit
    // it. Both spellings have to mean the same thing or this test would pass while
    // the descriptors still disagreed.
    expect(DESCRIPTOR_INPUT_SIZE).toBe(DEFAULT_DETECTOR_INPUT_SIZE);
  });

  it("the gate loop captures at the descriptor size, not at its tracking size", () => {
    const gate = readFileSync(join(SRC, "features/kiosk/lib/gateScanner.ts"), "utf8");
    const code = stripComments(gate);
    // The tracking pass may use its own size — it produces no descriptor.
    expect(code).toMatch(/inputSize:\s*options\.trackInputSize\s*\?\?\s*GATE_TRACK_INPUT_SIZE/);
    // The capture pass may not.
    expect(code).toMatch(/inputSize:\s*DESCRIPTOR_INPUT_SIZE/);
    expect(code).not.toMatch(/readFrame\([\s\S]{0,80}GATE_TRACK_INPUT_SIZE/);
  });

  it("still takes its speed from singlePass on every descriptor path", () => {
    // The point of pinning inputSize is that the cheap win is available elsewhere.
    // If a path quietly drops singlePass it pays 270 ms extra per frame for nothing.
    const withoutSinglePass = CALLS.filter((c) => !/singlePass\s*:\s*true/.test(c.args)).map(
      (c) => c.rel,
    );
    expect(withoutSinglePass).toEqual([]);
  });
});
