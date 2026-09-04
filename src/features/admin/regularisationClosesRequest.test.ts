/**
 * Deciding a regularisation at the queue must also close the request it was raised for.
 *
 * ── REPORTED, AGAIN, AS "APPROVED AND NOTHING UPDATED" ───────────────────────
 * The previous round (see regularisationApplies.test.ts) fixed the INBOX door: marking a
 * regularisation approved anywhere now applies it. This is the other door, and it had the
 * mirror-image defect.
 *
 * `decide_regularization()` — the /admin/attendance/regularisations queue — created the
 * punches, recomputed the day, and NEVER TOUCHED `approval_requests`. So the correction
 * landed and the request stayed `pending`. Read in the live database on 4 Sep 2026:
 *
 *     employee 125   regularisation applied 05:07:42   approval request STILL PENDING
 *
 * Two consequences, and the second is the one that was reported to us:
 *   · the request sits in every approver's inbox with nothing left to decide;
 *   · the EMPLOYEE'S OWN requests list reads `approval_requests`, so it still said
 *     "pending" hours after the day had been corrected. "It was approved and nothing
 *     updated" was an accurate description of what they could see.
 *
 * And the queue door carried a second defect: it inserted its punches with no
 * near-duplicate check. That is the bug that put a second 09:19 scan on Vishnuprasad's day
 * and turned a full shift into "absent, 2 minutes". The guard had been added to
 * `apply_approved_regularization` and never here, because nobody had noticed there were two
 * implementations to keep in step.
 *
 * ── WHY THE FIX DELETES CODE RATHER THAN ADDING THE GUARD TWICE ──────────────
 * Pasting the guard into the second copy leaves two copies to drift apart again. The queue
 * door now RECORDS the decision and lets the same triggers the inbox door uses do the work,
 * so there is one apply implementation, with one guard and one lock check, reached from
 * both screens.
 *
 * Verified against the live database, both doors, in rolled-back transactions: a request
 * asking for an in-time the day already had produced ONE punch and not two (2 -> 3 scans),
 * the regularisation reached 'applied', the approval request reached 'approved' with a
 * submit -> approve trail, and the day recomputed in the same round trip. 0 rows left
 * stranded afterwards.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const MIGRATION = "20260905150000_a_decided_regularisation_closes_its_request.sql";
const sql = read("supabase", "migrations", MIGRATION);

/** The body of one CREATE FUNCTION in the migration, so assertions cannot match a neighbour. */
function functionBody(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} is not defined in ${MIGRATION}`).toBeGreaterThan(-1);
  const end = sql.indexOf("$function$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("the queue door stops having its own apply implementation", () => {
  const decide = functionBody("decide_regularization");

  it("no longer writes punches itself", () => {
    /*
      THE REGRESSION THIS EXISTS FOR. An INSERT here is a second apply path, and a second
      apply path is what let the near-duplicate guard exist on only one of them.
    */
    expect(decide).not.toContain("INSERT INTO public.attendance_punches");
  });

  it("records the decision and lets the row's own trigger carry it out", () => {
    expect(decide).toContain("SET status           = 'approved'");
    expect(decide).toContain("decided_by       = v_actor");
  });

  it("refuses to leave a request half-decided", () => {
    /*
      'approved' but not 'applied' means the apply path found nothing to do. Returning
      success there would report a decision that changed nothing, so it raises and the
      whole statement rolls back.
    */
    expect(decide).toContain("IF v_after.status <> 'applied' THEN");
    expect(decide).toContain("nothing to apply");
  });

  it("keeps the authorisation that genuinely belongs to this door", () => {
    // Delegating the EFFECT must not delegate away the permission checks.
    expect(decide).toContain("app.is_admin() AND app.admin_scope_covers(r.employee_id)");
    expect(decide).toContain("app.is_manager_of(r.employee_id)");
    expect(decide).toContain("you cannot decide your own regularization");
  });

  it("still demands a comment before rejecting", () => {
    // The requester reads it; a bare "rejected" is not a decision they can act on.
    expect(decide).toContain("length(v_comment) < 10");
  });

  it("returns the shape the client already parses", () => {
    // decisionResultSchema is strict about these; a renamed key fails as a zod error.
    for (const key of [
      "regularization_id",
      "decision",
      "punch_ids",
      "day_status_after",
      "first_in_after",
      "last_out_after",
      "worked_minutes_after",
    ]) {
      expect(decide, key).toContain(`'${key}'`);
    }
  });
});

describe("a decided regularisation closes its approval request", () => {
  const settle = functionBody("settle_approval_for_decided_detail");

  it("fires on every decided state, and only when the status actually moved", () => {
    expect(sql).toContain("NEW.status IN ('approved', 'applied', 'rejected')");
    expect(sql).toContain("OLD.status IS DISTINCT FROM NEW.status");
  });

  it("only touches a request still on somebody's desk", () => {
    /*
      This is also what stops the two triggers calling each other in a circle: by the time
      the INBOX door's regularisation reaches 'applied', its request is already 'approved',
      so this returns without writing.
    */
    expect(settle).toContain("v_request.status NOT IN ('pending', 'in_progress', 'escalated')");
  });

  it("maps the outcome without inventing one", () => {
    expect(settle).toContain("WHEN 'rejected' THEN 'rejected'");
    expect(settle).toContain("ELSE 'approved'");
  });

  it("credits the decision to whoever made it", () => {
    // Not to whichever session happens to trip the trigger.
    expect(settle).toContain("COALESCE(NEW.decided_by, app.ctx_actor_id())");
  });

  it("files an approve/reject action, not a recall", () => {
    /*
      The pre-existing `settle_approval_for_detail` files 'cancel'/'recall' because it is for
      the subject WITHDRAWING. Reusing it for a decision would put the wrong verb in the
      permanent trail.
    */
    expect(settle).toContain("THEN 'reject' ELSE 'approve' END::public.approval_action");
    expect(settle).not.toContain("'recall'");
  });

  it("takes the answered request off the approver's feed", () => {
    expect(settle).toContain("SET dismissed_at = now()");
    // 'cancelled', not 'dismissed' — notification_status has no such label.
    expect(settle).toContain("'cancelled'::public.notification_status");
  });
});

describe("a projection never walks a detail row backwards", () => {
  const project = functionBody("apply_approval_to_detail");

  it("leaves a row that is already 'applied' alone when told 'approved'", () => {
    /*
      Once the settle trigger closes the request, this fires and projects 'approved' onto a
      regularisation that is by then 'applied'. Unguarded it overwrites the terminal state
      with the earlier one and re-arms apply_on_approve. 'applied' means approved AND carried
      out; it supersedes 'approved'.
    */
    expect(project).toContain("v_target = 'approved' AND 'applied' = ANY (v_labels)");
    expect(project).toContain("ARRAY['applied']");
    expect(project).toContain("status::text <> ALL (%L::text[])");
  });

  it("still reads the allowed labels from the catalogue rather than a constant", () => {
    // The original reason: `regularization_status` gained 'applied' in a later migration.
    expect(project).toContain("JOIN pg_catalog.pg_enum e");
  });

  it("still distinguishes 'already said this' from 'no such row'", () => {
    expect(project).toContain("no %I row with id %s");
  });
});

describe("the rows the old behaviour already stranded are repaired", () => {
  it("sweeps every decided regularisation whose request stayed open", () => {
    expect(sql).toContain("WHERE r.status IN ('approved', 'applied', 'rejected')");
    expect(sql).toContain("AND ar.status IN ('pending', 'in_progress', 'escalated')");
  });

  it("leaves a trail entry rather than silently flipping a status", () => {
    expect(sql).toContain("request closed retrospectively");
  });
});

describe("both dashboards see it without a manual refresh", () => {
  it("routes an approval_requests change to the attendance screens", () => {
    /*
      An APPROVED regularisation also rewrites attendance_days, which already invalidates
      qk.attendance.all — so this only shows up on a REJECTION, where nothing else changes
      and this is the one message that will ever arrive.
    */
    const realtime = read("src", "shared", "api", "realtime.ts");
    const line = /approval_requests: \[([^\]]*)\]/.exec(realtime)?.[1] ?? "";
    expect(line).toContain("qk.attendance.all");
    expect(line).toContain("qk.approvals.all");
    expect(line).toContain("qk.admin.all");
  });

  it("keeps attendance_days and attendance_punches reaching the employee's own screens", () => {
    // The approved path depends on these, and they are how the day itself updates live.
    const realtime = read("src", "shared", "api", "realtime.ts");
    for (const table of ["attendance_days", "attendance_punches"]) {
      const line = new RegExp(`${table}: \\[([^\\]]*)\\]`).exec(realtime)?.[1] ?? "";
      expect(line, table).toContain("qk.attendance.all");
      expect(line, table).toContain("qk.home.all");
      expect(line, table).toContain("qk.admin.all");
    }
  });

  it("drops the decided row off the deciding admin's own approval inbox", () => {
    /*
      The admin's own session does not wait for a realtime round trip: the mutation
      invalidates directly. It swept only the admin attendance prefix, so the row it had
      just decided stayed on the approvals screen looking undecided.
    */
    const hook = read("src", "features", "admin", "hooks", "useRegularizationQueue.ts");
    const line = /invalidate: \[([^\]]*)\]/.exec(hook)?.[1] ?? "";
    expect(line).toContain("qk.admin.attendanceAll()");
    expect(line).toContain("qk.approvals.all");
  });
});
