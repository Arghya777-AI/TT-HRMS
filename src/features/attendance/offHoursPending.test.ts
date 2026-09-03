/**
 * Only the off-hours minutes wait for approval — not the day they are attached to.
 *
 * ── THE RULE THE VENUE STATED ────────────────────────────────────────────────
 * "If they're punching in at 8 am, then they can directly come to the office and log out from
 * the office itself. There is no need to break it. From 8 am to 5:30 or 6:30 pm, whatever it
 * will be, it will be counted directly. But when there is overtime work happening after the
 * working hours, like at 8-9 pm, then they should log in and log out."
 *
 * ── WHAT THE ENGINE DID INSTEAD ──────────────────────────────────────────────
 * Step 8b computed `pending_approval_minutes` by recomputing the whole day over the punches
 * that were NOT awaiting approval and taking the difference. On the commonest off-hours shape
 * — an 08:00 web punch-in awaiting approval, then out at the gate at 17:30 — filtering the
 * pending punch left ONE surviving scan. One scan is no span, so the approved pass returned 0
 * and `pending` became the ENTIRE 9h30m day. A full day's pay waited on somebody accepting
 * eighty minutes.
 *
 * Measured in a rolled-back transaction against live data before the fix shipped:
 *   08:00 web unapproved -> 17:30 gate   worked 570   pending 80   (was 570)
 *   the same day once approved           worked 570   pending  0
 *   gate day + 20:00-21:30 unapproved    worked 581   pending 90
 *   ordinary day, two gate punches       worked 491   pending  0
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = "20260903150000_only_the_off_hours_minutes_wait.sql";
const sql = readFileSync(join(process.cwd(), "supabase", "migrations", MIGRATION), "utf8");
/** Comments are not code — tests here have passed on a word inside one. */
const code = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

describe("the old whole-day rule is gone", () => {
  it("no longer recomputes the day over approved punches only", () => {
    /*
      THE BUG. `NOT (requires_approval AND approved_at IS NULL)` in the punch scan is what
      dropped the pending punch and collapsed the span to nothing.
    */
    expect(code).not.toContain("NOT (requires_approval AND approved_at IS NULL)");
    expect(code).not.toContain("NOT (p.requires_approval AND p.approved_at IS NULL)");
  });

  it("keeps none of the variables that rule needed", () => {
    for (const v of ["v_a_first", "v_a_last", "v_a_count", "v_a_break", "v_a_worked"]) {
      expect(code, v).not.toContain(v);
    }
  });
});

describe("what is withheld now", () => {
  it("clips each session to the shift window", () => {
    expect(code).toContain("v_win_from := v_shift_start - make_interval(mins => v_grace_in)");
    expect(code).toContain("v_win_to   := v_shift_end   + make_interval(mins => v_grace_out)");
    expect(code).toContain("GREATEST(s.starts_at, v_win_from)");
    expect(code).toContain("LEAST(s.ends_at, v_win_to)");
  });

  it("uses the same session parity as the break rule, so the two cannot disagree", () => {
    /*
      Work happens across the ODD gaps (p1-p2, p3-p4); the even ones are the gaps between,
      which step 7 deducts as breaks. Two different parities here would double-count or
      silently drop a session.
    */
    expect(code).toContain("AND s.rn % 2 = 1");
    expect(code).toContain("OR (g.rn % 2 = 0 AND g.rn < g.n)");
  });

  it("withholds only a session an administrator has still to accept", () => {
    expect(code).toContain("(p.requires_approval AND p.approved_at IS NULL)     AS open_start");
    expect(code).toContain("AND (s.open_start OR s.open_end)");
  });

  it("ignores a session with no closing punch", () => {
    // A dangling in-punch has no span to measure, so it can withhold nothing.
    expect(code).toContain("WHERE s.ends_at IS NOT NULL");
  });

  it("treats a day with no shift as having no off-hours at all", () => {
    /*
      `punch_within_shift` returns true with no shift for the same reason: absent
      configuration must never make somebody's hours provisional.
    */
    expect(code).toContain("IF sh.id IS NULL OR v_shift_start IS NULL OR v_shift_end IS NULL THEN");
    expect(code).toMatch(/v_pending := 0;/);
  });

  it("never reports more pending than the day worked", () => {
    // `ck_ad__pending_within_worked` enforces the same thing at the table.
    expect(code).toContain("v_pending := GREATEST(0, LEAST(v_worked, COALESCE(v_pending, 0)));");
  });

  it("clamps a session that fell entirely outside the window at zero", () => {
    // The clipped interval inverts there, and its length must read 0, not negative.
    expect(code).toContain("- GREATEST(0, util.minutes_between(");
  });
});

describe("everything else in the engine is untouched", () => {
  it("still deducts alternate interior gaps as breaks", () => {
    /*
      Matched on the lines the engine actually has. The first version asserted
      `v_break := GREATEST`, which appears nowhere — I invented it, and the test failed,
      which is the assertion working rather than the code being wrong.
    */
    expect(code).toContain("v_break := COALESCE(v_break, 0);");
    expect(code).toContain("v_worked  := GREATEST(0, v_span - v_break);");
    expect(code).toContain("v_break := sh.unpaid_break_minutes;");
  });

  it("still computes overtime from payable minutes against the shift", () => {
    expect(code).toContain("v_ot := v_payable - v_shift_mins - sh.ot_threshold_minutes;");
  });

  it("still writes pending_approval_minutes to the day", () => {
    expect(code).toContain("pending_approval_minutes");
  });

  it("recomputes the month so a silent difference would surface here", () => {
    expect(code).toContain("WHERE ist_date >= '2026-09-01' AND ist_date <= util.ist_today()");
  });
});
