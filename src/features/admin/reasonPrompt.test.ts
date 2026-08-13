/**
 * reasonPrompt.test.ts — routine admin actions must not ask anybody to write a
 * comment, and must still record why they happened.
 *
 * WHY, IN THE CLIENT'S WORDS
 * -------------------------
 * "Every time it asks for a comment to be written while pairing, while adding
 *  devices, and everything — you need to remove that."
 *
 * They are right twice over. It is friction on every single action, and a field that
 * blocks the work gets fed whatever clears it: "asdf", "test", "ok". An audit trail
 * full of "asdf" is worse than no free-text field, because it looks like provenance
 * and carries none.
 *
 * THE TRAP THIS TEST GUARDS
 * -------------------------
 * You cannot simply delete the dialog. `audit.reason_required_tables` enforces
 * `app.reason` on every write to these tables with a DATABASE TRIGGER, so a write
 * with no reason FAILS — the prompt would vanish and every action would start
 * erroring instead. The reason therefore still travels; it is derived from the action
 * rather than typed. Any future edit that removes the derivation while keeping the
 * silent fire would reintroduce that failure, and this is what catches it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const BUTTON = readFileSync(
  join(ROOT, "src/features/admin/components/ReasonActionButton.tsx"),
  "utf8",
);
const PURGE = readFileSync(join(ROOT, "src/features/admin/pages/TemplatePurge.page.tsx"), "utf8");
const PIPELINE = readFileSync(join(ROOT, "src/features/kiosk/lib/facePipeline.ts"), "utf8");

describe("routine admin actions do not prompt for a comment", () => {
  it("fires immediately unless a typed reason is explicitly required", () => {
    // The default must be silent. If this inverts, every admin action starts
    // demanding prose again.
    expect(BUTTON).toMatch(/requireTypedReason\s*=\s*false/);
    expect(BUTTON).toMatch(/if \(requireTypedReason\) \{\s*setOpen\(true\);/);
    expect(BUTTON).toMatch(/void confirm\(derivedReason\)/);
  });

  it("still sends a reason, because a DB trigger rejects a write without one", () => {
    // `audit.reason_required_tables` is not advisory. No reason, no write.
    expect(BUTTON).toMatch(/const derivedReason/);
    // The reason is built from WHERE it happened and WHAT was done, in that order.
    expect(BUTTON).toMatch(/\$\{surface\}: \$\{title\}/);
  });

  it("names the surface truthfully, and defaults to the console", () => {
    /*
      The prefix used to be the literal "admin console", which became a small lie
      the moment a manager published a roster from /team/roster. It is a prop now
      — but the DEFAULT must stay "admin console", or every existing call site
      silently starts writing a different provenance than it did yesterday.
    */
    expect(BUTTON).toMatch(/surface = "admin console"/);
  });

  it("derives a reason long enough for the strictest floor in the product", () => {
    /*
      The DB minimum is 10 characters and several call sites raise it to 15
      (SENSITIVE_REASON_LENGTH). A derived reason that fell under either would be
      rejected by Postgres with an error the admin can do nothing about — so the
      component pads rather than gambling on every title being long.
    */
    expect(BUTTON).toMatch(/length >= 20/);
    expect(BUTTON).toMatch(/recorded from the \$\{surface\}/);
  });

  it("surfaces a failure instead of looking like the button did nothing", () => {
    // With no dialog, a rejected write would set an error nobody renders.
    expect(BUTTON).toMatch(/if \(!ok\) setOpen\(true\)/);
  });

  it("keeps the typed reason ONLY where the circumstance cannot be derived", () => {
    // Erasing a biometric is irreversible, and a DPDP erasure request, a departure
    // and a mistake are the same operation with very different records.
    const purgeButtons = (PURGE.match(/requireTypedReason/g) ?? []).length;
    expect(purgeButtons).toBe(2);
  });
});

describe("face verification is warmed up, not cold on the first face", () => {
  it("asks for the GPU backend explicitly", () => {
    // It was never set at all: whatever tfjs defaulted to was what ran.
    expect(PIPELINE).toMatch(/setBackend\("webgl"\)/);
  });

  it("degrades quietly when there is no WebGL", () => {
    // A gate that refuses to scan on a phone with a blocklisted GPU is far worse
    // than a gate that takes 500 ms, so the failure path must be a no-op.
    const block = PIPELINE.slice(PIPELINE.indexOf('setBackend("webgl")'));
    expect(block.slice(0, 400)).toMatch(/catch\s*\{/);
  });

  it("runs a warm-up inference during load, not on the first real face", () => {
    /*
      THE ACTUAL COMPLAINT: "sometimes it takes a little bit of a long time."
      tfjs compiles WebGL shaders per kernel on FIRST USE, so the first inference of
      a session cost seconds and every later one did not. `loadFaceModels` is already
      called at mount, so paying it there means nobody is waiting on a face.
    */
    expect(PIPELINE).toMatch(/canvas\.width = 64/);
    expect(PIPELINE).toMatch(/withFaceDescriptor\(\)/);
    // And the warm-up must sit INSIDE the memoised loader, or it re-runs per scan.
    const loader = PIPELINE.slice(
      PIPELINE.indexOf("export function loadFaceModels"),
      PIPELINE.indexOf("export interface FrameQuality"),
    );
    expect(loader).toMatch(/faceapiPromise \?\?=/);
    expect(loader).toMatch(/canvas\.width = 64/);
  });

  it("reports which backend actually won, so slowness is answerable", () => {
    expect(PIPELINE).toMatch(/export function faceBackend/);
  });
});
