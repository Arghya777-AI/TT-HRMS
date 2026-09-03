/**
 * An approved regularisation has to actually change the attendance day.
 *
 * ── WHAT HAPPENED, REPORTED AS "I APPROVED IT AND NOTHING IS UPDATED" ────────
 * Two employees attended an 8 pm client meeting on 2 Sep 2026, could not punch for it, and
 * filed regularisations for 20:00–21:37 and 20:00–21:19 IST. HR approved both, and nothing
 * moved — not the times, not the hours, not the overtime.
 *
 * Nothing was refused and the engine was fine. There were simply TWO routes to a decision and
 * only one performed the effect:
 *
 *   /admin/regularisations -> decide_regularization(), which creates the correction punches,
 *                             sets status='applied', stamps applied_at and created_punch_ids,
 *                             and recomputes the day.
 *   /admin/approvals       -> act_on_approval() settles the request; the generic settle path
 *                             writes status='approved' on the detail row and stops there.
 *
 * HR used the second. Both live rows sat at status='approved' with applied_at NULL and
 * created_punch_ids NULL. Worse, they were stuck: decide_regularization() refuses anything not
 * 'pending', so the correct function could no longer be aimed at them.
 *
 * ── WHY THE FIX IS A TRIGGER AND NOT A CALL ON THE SECOND SCREEN ─────────────
 * Adding the missing call to /admin/approvals would leave the next screen free to make the
 * same mistake. The effect belongs to the ROW: any route that marks a regularisation approved
 * now applies it, including routes nobody has written yet.
 *
 * Verified against the live database before shipping: the two stuck rows repaired (Monalisa
 * 489 -> 586 worked minutes with overtime 0 -> 75; Deepesh 0 -> 79), a second apply returned
 * `already_applied` with no duplicate punches, an inbox-style UPDATE to 'approved' recomputed
 * the day 491 -> 581, and decide_regularization() still produced exactly two punches rather
 * than four.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MIGRATION = "20260903090000_an_approved_regularisation_applies_itself.sql";
const sql = readFileSync(join(ROOT, "supabase", "migrations", MIGRATION), "utf8");

/** Comments are not code. Tests in this repo have passed on a word inside a comment. */
const code = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

describe("every approval route applies the effect", () => {
  it("fires on the transition into approved", () => {
    expect(code).toMatch(/CREATE TRIGGER trg_attendance_regularizations__apply_on_approve/);
    expect(code).toContain("AFTER UPDATE OF status ON public.attendance_regularizations");
    expect(code).toContain("NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved'");
  });

  it("does not fire on a row that is already approved", () => {
    /*
      `OLD.status IS DISTINCT FROM 'approved'` is what makes re-saving an approved row inert.
      Without it, any later UPDATE on an approved row would try to apply it again.
    */
    expect(code).toContain("OLD.status IS DISTINCT FROM 'approved'");
  });

  it("leaves decide_regularization alone, so the other route cannot double-apply", () => {
    /*
      That function goes pending -> 'applied' directly, so the trigger's `= 'approved'` test
      never matches its row. Redefining it here would be the way to break that.
    */
    expect(code).not.toMatch(/FUNCTION public\.decide_regularization/);
  });
});

describe("the apply step is idempotent", () => {
  it("returns early for a row already applied", () => {
    // Reachable from a trigger, a backfill and by hand. A second pair of punches would widen
    // the day's span with scans nobody made.
    expect(code).toContain("IF r.status = 'applied' OR r.created_punch_ids IS NOT NULL THEN");
    expect(code).toContain("'already_applied'");
  });

  it("refuses to act on a row that is not approved", () => {
    expect(code).toContain("IF r.status <> 'approved' THEN");
    expect(code).toContain("'not_approved'");
  });

  it("takes the row FOR UPDATE, so two approvals cannot race", () => {
    expect(code).toMatch(/WHERE id = p_regularization_id\s+FOR UPDATE/);
  });
});

describe("what it writes", () => {
  it("creates an in punch and an out punch from the requested times", () => {
    expect(code).toContain("r.requested_first_in_at, 'in', 'system_regularization'");
    expect(code).toContain("r.requested_last_out_at, 'out', 'system_regularization'");
  });

  it("records the punches it created and stamps applied_at", () => {
    expect(code).toContain("SET status            = 'applied'");
    expect(code).toContain("applied_at        = now()");
    expect(code).toContain("created_punch_ids = CASE WHEN array_length(v_punch_ids, 1) IS NULL");
  });

  it("recomputes the day in the same transaction", () => {
    // Otherwise the approver refreshes and still sees the old hours, which is the complaint.
    expect(code).toContain("public.compute_attendance_day(r.employee_id, r.ist_date, v_reason)");
  });

  it("credits the approver, not whoever ran a backfill", () => {
    expect(code).toContain("v_actor := coalesce(r.decided_by, app.ctx_actor_id())");
  });

  it("names the request in the punch reason", () => {
    // `ck_ap__reason_required` wants >= 10 characters on a system_regularization punch, and
    // the punch log should read as evidence without a join.
    expect(code).toContain("format('regularization %s approved%s'");
  });
});

describe("the refusals it keeps", () => {
  it("will not reopen a hard-locked period", () => {
    expect(code).toContain("al.lock_kind = 'hard'");
    expect(code).toContain("RAISE EXCEPTION");
  });

  it("does not silently swallow a malformed request", () => {
    /*
      Neither times nor a requested status means there is nothing to apply. It is left at
      'approved' and reported, rather than raised — raising would roll back an approval
      somebody already made over a row they cannot fix from that screen.
    */
    expect(code).toContain("'nothing_to_apply'");
  });

  it("is not callable from a browser", () => {
    // The two decision screens go through act_on_approval / decide_regularization.
    expect(code).toContain("REVOKE ALL ON FUNCTION public.apply_approved_regularization(uuid) FROM authenticated");
    expect(code).toContain("REVOKE ALL ON FUNCTION public.apply_approved_regularization(uuid) FROM anon");
  });
});

describe("the backfill repairs the rows that were already stuck", () => {
  it("targets exactly approved-but-unapplied", () => {
    expect(code).toContain("WHERE status = 'approved' AND applied_at IS NULL");
  });
});
