/**
 * The unattended gate's server-side invariants, asserted against `kiosk-punch` source.
 *
 * These are text assertions, which is a real compromise — there is no Deno runtime in this
 * suite, so the function cannot be executed here. They are worth having anyway, because each
 * one pins a line whose failure mode is silent and expensive, and all three were live defects
 * rather than hypotheticals:
 *
 *   1. A DEBOUNCED DUPLICATE WROTE A COUNTED PUNCH. `ck_ap__void_fields` demands `voided_by`
 *      on a voided row; with no guard there was no profile to name, so the code wrote the
 *      duplicate LIVE. `compute_attendance_day` filters on `is_voided = false` alone, so it
 *      counted — one person scanning twice inside the debounce window became two punches.
 *   2. LIVENESS WAS WAIVED ON A DEVICE FLAGGED ATTENDED. The waiver was correct while a guard
 *      stood at the gate. With the guard screen gone it meant a printed photograph passed on
 *      any device whose row still said `require_operator = true`, which was all of them.
 *   3. THE PUNCH REQUIRED AN OPERATOR SESSION THE TERMINAL CANNOT MINT. A branch on the
 *      device row demanded a session that no screen can open, so the device refused
 *      every punch.
 *
 * A refactor that reintroduces any of them compiles, deploys, and looks fine.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PUNCH = readFileSync(
  join(process.cwd(), "supabase/functions/kiosk-punch/index.ts"),
  "utf8",
);

/**
 * `kiosk-punch` with every comment removed.
 *
 * Required, not tidiness: that file documents each of these defects by QUOTING the code that
 * caused it, so a negative assertion run over the raw text matches the explanation and fails
 * on a file that is actually correct. Negative assertions read this; positive ones may read
 * either. Block comments go first so a `//` inside one cannot survive.
 */
const CODE = PUNCH.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("a debounced duplicate never becomes an attendance fact", () => {
  it("skips the punch insert entirely when the scan is a duplicate", () => {
    expect(PUNCH).toContain("const insertedRows = isDuplicate\n        ? []");
  });

  it("decides duplicate from the lookup alone, never from who is on the door", () => {
    expect(PUNCH).toContain("const isDuplicate = duplicateOf !== null;");
    // The old form gated the duplicate verdict on having a profile to blame the void on.
    expect(CODE).not.toMatch(/isDuplicate\s*=\s*duplicateOf\s*!==\s*null\s*&&/);
    expect(CODE).not.toMatch(/const voidAttribution\s*=/);
  });

  it("answers from the original punch, so the screen shows the real check-in time", () => {
    expect(PUNCH).toContain("const punch = isDuplicate && duplicateOf !== null");
    expect(PUNCH).toContain("id: duplicateOf.id,");
  });

  it("still records the attempt — INV-4 is the match log, not the punch row", () => {
    expect(PUNCH).toContain('outcome: isDuplicate ? "duplicate_suppressed" : "matched"');
    // Claiming a produced punch that was never inserted would corrupt the audit trail.
    expect(PUNCH).toContain("producedPunchId: isDuplicate ? null : punchId,");
  });

  it("never voids a row at insert, so the CHECK constraint cannot be tripped", () => {
    // The duplicate was the only row this endpoint ever voided.
    expect(CODE).not.toMatch(/\$\{isDuplicate\}::boolean,\s*\n\s*\$\{isDuplicate \? voidAttribution/);
    expect(PUNCH).toContain("false::boolean,");
  });
});

describe("the gate stands unattended", () => {
  it("treats the operator session as optional on every punch", () => {
    expect(PUNCH).toContain(
      "const operator = await requireOperatorSession(req, deviceAuth, client).catch(() => null);",
    );
    // The branch that demanded a session no screen can open.
    expect(CODE).not.toMatch(/device\.requireOperator\s*\n?\s*\?\s*await requireOperatorSession/);
  });

  it("requires liveness unconditionally, with no exemption for a flagged device", () => {
    expect(PUNCH).toContain("const livenessRequired = true;");
    expect(CODE).not.toContain("device.requireOperator !== true");
  });

  it("reads the device row for nothing that could turn a control down", () => {
    // `requireOperator` may still be SELECTed and logged; it must not drive behaviour.
    const behavioural = CODE.split("\n").filter((line) =>
      line.includes("device.requireOperator"),
    );
    expect(behavioural).toEqual([]);
  });
});
