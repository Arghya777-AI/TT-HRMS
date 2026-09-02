/**
 * What a colleague can see of somebody else's leave — pinned, because it is a privacy boundary.
 *
 * The venue decided that every employee may see who is on leave AND the leave type, knowing that
 * discloses Sick Leave and Maternity Leave to colleagues. That decision is implemented by ONE
 * view. What it must never grow is the rest of the leave request: the free-text reason, the
 * address and contact number somebody left for their absence, the handover notes, and the
 * pointer to a supporting document — a medical certificate.
 *
 * Those columns sit on `leave_requests`, one join away. A future edit that "just adds the
 * reason so people know why" is a plausible, well-meant change and is exactly what this file
 * exists to stop.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260902070000_everyone_can_see_who_is_on_leave.sql"),
  "utf8",
);

/**
 * The migration with its `--` comments stripped.
 *
 * Needed because the comments discuss the very things the assertions forbid — the file explains
 * at length why `leave_requests__scope_read` is NOT being relaxed, and a whole-file grep read
 * that explanation as the thing it warns against. A test a comment can fail is a test that
 * punishes documenting the decision.
 */
const SQL = MIGRATION.split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/** Everything on `leave_requests` that must not reach a colleague. */
const NEVER_EXPOSED = [
  "reason",
  "contact_during_leave",
  "address_during_leave",
  "handover_notes",
  "decision_comment",
  "cancellation_reason",
  "supporting_document_id",
];

describe("v_leave_roster exposes only what was agreed", () => {
  /** The SELECT list, so a column named in a comment does not count as exposed. */
  const selectList = (() => {
    const body = SQL.slice(SQL.indexOf("CREATE OR REPLACE VIEW"));
    return body.slice(0, body.indexOf("FROM public.leave_request_days"))
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
  })();

  it.each(NEVER_EXPOSED)("does not select %s", (column) => {
    expect(selectList).not.toContain(column);
  });

  it("selects the fields that were asked for", () => {
    for (const wanted of ["display_name", "department_name", "leave_type_name", "portion"]) {
      expect(selectList).toContain(wanted);
    }
  });
});

describe("who may read it", () => {
  it("is not readable by anon", () => {
    /*
      THE MISTAKE THIS CAUGHT ONCE. Supabase ships ALTER DEFAULT PRIVILEGES granting the full set
      to `anon` and `authenticated` on every new object in `public`. `REVOKE ALL FROM PUBLIC`
      does not touch a grant made to a named role, so the view was created readable by the
      UNAUTHENTICATED role — the venue's whole leave roster, including who is on sick leave,
      available to anyone holding the publishable anon key.
    */
    expect(SQL).toContain("REVOKE ALL ON public.v_leave_roster FROM anon;");
  });

  it("grants SELECT and nothing else, and only to signed-in users", () => {
    expect(SQL).toContain("GRANT SELECT ON public.v_leave_roster TO authenticated;");
    expect(SQL).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)\s+ON public\.v_leave_roster/);
  });

  it("leaves leave_requests' own row scope alone", () => {
    /*
      The widening is the view, not the policy. Relaxing `leave_requests__scope_read` would have
      delivered the same names and every column beside them, including the ones above.
    */
    expect(SQL).not.toContain("leave_requests__scope_read");
    expect(SQL).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/);
  });
});

describe("what it counts as being on leave", () => {
  it("shows approved leave only", () => {
    // A pending request is not a fact. "Ravi is on leave" for a day nobody granted is wrong
    // information on a screen people plan around.
    expect(SQL).toContain("lr.status IN ('approved', 'partially_approved')");
    expect(SQL).not.toMatch(/'pending'/);
  });

  it("omits people who are outside leave tracking", () => {
    expect(SQL).toContain("NOT e.exclude_from_leave_tracking");
  });
});
