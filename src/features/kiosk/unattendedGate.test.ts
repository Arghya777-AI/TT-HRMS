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
    // Now also true when the minimum-dwell rule fires. What matters, and what the old form got
    // wrong, is that no term here depends on an operator being present.
    expect(PUNCH).toContain("const isDuplicate = duplicateOf !== null || dwellSuppressed;");
    // The old form gated the duplicate verdict on having a profile to blame the void on.
    expect(CODE).not.toMatch(/isDuplicate\s*=\s*duplicateOf\s*!==\s*null\s*&&/);
    expect(CODE).not.toMatch(/const voidAttribution\s*=/);
  });

  it("answers from the original punch, so the screen shows the real check-in time", () => {
    // Generalised to `standIn` when the minimum-dwell rule arrived: the stand-in is the punch
    // this scan collided with, or the check-in it was too soon after. Same guarantee either
    // way — the screen and the spoken line describe a punch that actually exists.
    expect(PUNCH).toContain("const punch = isDuplicate && standIn !== null");
    expect(PUNCH).toContain("id: standIn.id,");
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

describe("standing in front of the gate does not check you out", () => {
  /*
    THE EDGE CASE THIS EXISTS FOR
    Somebody checks in and then stands there — reading the card, waiting for a colleague. The
    camera keeps scanning. Once the 120-second debounce lapses the terminal records their next
    scan, the engine reads the day's second punch as the check-OUT, and a person who has just
    arrived is recorded as having left after two minutes.

    The debounce cannot fix it and is not meant to: it is an anti-double-scan guard, and
    widening it to cover loitering would swallow every legitimate scan in those minutes.
  */
  it("has a minimum dwell, separate from the debounce", () => {
    expect(PUNCH).toContain("const DEFAULT_MIN_DWELL_SECONDS = 300;");
    // Two rules, two numbers. Collapsing them would reintroduce the trade-off above.
    expect(PUNCH).toContain("const DEFAULT_DEBOUNCE_SECONDS = 120;");
  });

  it("suppresses only the scan that would become the check-out", () => {
    // Exactly one live punch so far means this scan is the one the engine reads as the out.
    expect(PUNCH).toContain("const first = existing.length === 1 ? existing[0] : undefined;");
    expect(PUNCH).toContain("dwellSuppressed = true;");
  });

  it("measures the gap against the DATABASE clock, not the edge runtime's", () => {
    /*
      `punched_at` is stamped by Postgres, so comparing it with an isolate's own clock compares
      two different clocks — and an edge runtime drifted by a minute would silently widen or
      narrow the dwell window with nothing to show why. The same `now()` that stamps the punch
      decides whether it is too soon, and a replayed queue item measures from its captured
      instant instead.
    */
    expect(PUNCH).toContain("< make_interval(secs => ");
    expect(PUNCH).toContain("AS too_soon");
    expect(PUNCH).toContain("first.too_soon === true");
    // The JS arithmetic this replaced, which the edge-function guard also now forbids.
    expect(CODE).not.toContain("Date.now()");
  });

  it("folds the dwell suppression into the same no-write path as a debounce", () => {
    // It must write no punch row, exactly as a debounced duplicate does — otherwise it lands
    // live and IS the spurious check-out this was written to prevent.
    expect(PUNCH).toContain("const isDuplicate = duplicateOf !== null || dwellSuppressed;");
    expect(PUNCH).toContain("const insertedRows = isDuplicate\n        ? []");
  });

  it("answers from the check-in, so the screen shows the punch that exists", () => {
    expect(PUNCH).toContain("const standIn = duplicateOf ?? dwellReference;");
  });

  it("measures the gap in the SETTING, not a hard-coded number", () => {
    // A venue with a different rhythm can change it without a deploy, and one value applies
    // everywhere at once rather than being copied into a client that then drifts.
    expect(PUNCH).toContain("attendance.min_dwell_seconds");
    expect(PUNCH).toContain("resolveMinDwellSeconds");
  });

  it("tells the client the scan wrote nothing", () => {
    /*
      This was missing and it mattered: the terminal decides what to SAY from this flag, so
      without it every suppressed scan announced itself as a successful punch — confidently
      wrong, and an invitation to keep scanning.
    */
    expect(PUNCH).toContain('"duplicateSuppressed"');
    expect(PUNCH).toContain("duplicateSuppressed: written.isDuplicate,");
  });
});

describe("a device hint may break a tie, never make a match", () => {
  /*
    Asked for directly: when the server cannot match a face, do not lose the attendance of
    somebody the terminal had already recognised. Granting that safely turns on one line — the
    hinted employee must ALREADY be in the shortlist this search produced.

    That is what keeps the server in charge. A device's copy of the templates is stale by
    construction, so if a hint could introduce somebody the search had not considered, a
    week-old bundle could write attendance for a person who has since been re-enrolled, had
    consent withdrawn, or left. Narrowing is safe; deciding is not.
  */
  it("only ever considers a candidate the server already shortlisted", () => {
    expect(PUNCH).toContain("candidates.find((c) => c.employeeId === item.localEmployeeId)");
    // Never a fresh lookup by the hinted id — that would be the server trusting the device.
    expect(CODE).not.toMatch(/WHERE[\s\S]{0,80}employee_id = \$\{item\.localEmployeeId/);
  });

  it("holds the hint to a STRICTER bar than the ordinary match", () => {
    const hint = /const LOCAL_HINT_MIN_CONFIDENCE = ([\d.]+);/.exec(PUNCH);
    const floor = /const DEFAULT_MIN_CONFIDENCE = ([\d.]+);/.exec(PUNCH);
    expect(hint).not.toBeNull();
    expect(floor).not.toBeNull();
    /*
      Stricter, not looser. The hint is used precisely where the evidence is weakest — two
      enrolled faces within the margin of each other — so a lower bar there would be the worst
      possible place to relax.
    */
    expect(Number(hint![1])).toBeGreaterThan(Number(floor![1]));
  });

  it("is reached only after the ordinary match has failed", () => {
    expect(PUNCH).toContain("if (!accepted && item.localEmployeeId !== undefined)");
    expect(PUNCH).toContain("if (!accepted && hintAccepted === null)");
  });

  it("flags every hint-verified punch for review", () => {
    // Recorded, which is the point — but recorded as worth a look, not as a clean match.
    expect(PUNCH).toContain("hintAccepted !== null ||");
  });

  it("writes the punch against the shortlisted candidate, not a device-supplied id", () => {
    expect(PUNCH).toContain("const matched = hintAccepted ?? (best as Candidate);");
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

describe("once a punch is recorded, the gate records nothing else for five minutes", () => {
  /*
    Migration 072 took the SHARED debounce to 60 seconds for the web button ("after 1 minute
    only, they can log out"). A camera is not a button: nobody decides to scan, so at 60s a
    person standing by the door collected a punch a minute. The gate therefore floors its own
    window at the five minutes it already reasons in for MINIMUM DWELL.
  */
  it("floors the gate debounce at five minutes", () => {
    expect(PUNCH).toContain("const GATE_MIN_DEBOUNCE_SECONDS = 300;");
  });

  it("raises a shorter policy window without ever lowering a longer one", () => {
    expect(PUNCH).toContain("debounceSeconds: Math.max(resolvedDebounce, GATE_MIN_DEBOUNCE_SECONDS),");
    // A `min` here would cap every policy at five minutes instead of lifting the short ones.
    expect(CODE).not.toMatch(/debounceSeconds:\s*Math\.min\(/);
  });

  it("applies the same floor when no policy row resolves", () => {
    // The fallback path used the bare 120s default, so an employee on no policy got a
    // shorter window at the gate than everyone else.
    expect(PUNCH).toContain(
      "debounceSeconds: Math.max(DEFAULT_DEBOUNCE_SECONDS, GATE_MIN_DEBOUNCE_SECONDS)",
    );
    expect(CODE).not.toMatch(/debounceSeconds:\s*DEFAULT_DEBOUNCE_SECONDS\s*\}/);
  });
});
