/**
 * What a colleague can see of somebody else's leave, and what they must not.
 *
 * ── THE BOUNDARY MOVED, AND THAT IS THE POINT OF THIS FILE ───────────────────
 * A `v_presence_roster` view and a "Who is in today" panel briefly shipped here, showing who was
 * at the venue and since when. The venue then instructed the opposite: colleagues see who is on
 * LEAVE and nothing else — no arrival times, no presence — and that information stays where an
 * admin looks at it.
 *
 * So the view was dropped and the panel deleted. These assertions keep it that way, because the
 * plausible future edit is somebody re-adding "and show who is in" as an obvious convenience.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

describe("employees do not see each other's hours", () => {
  it("has no presence panel on any employee screen", () => {
    for (const page of [
      ["src", "features", "home", "pages", "Home.page.tsx"],
      ["src", "features", "leave", "pages", "LeaveCalendar.page.tsx"],
    ]) {
      expect(read(...page)).not.toContain("WhoIsInPanel");
    }
  });

  it("does not read a presence view anywhere in the client", () => {
    // The view itself is dropped; this catches a client trying to read one that comes back.
    const api = read("src", "features", "leave", "api", "leave-apply.api.ts");
    expect(api).not.toContain("v_presence_roster");
    expect(api).not.toContain("presenceRoster");
  });

  it("the leave roster it DOES read carries no times", () => {
    const api = read("src", "features", "leave", "api", "leave-apply.api.ts");
    const schema = api.slice(api.indexOf("leaveRosterRowSchema"), api.indexOf("fetchLeaveRoster"));
    for (const forbidden of ["first_in", "last_out", "late", "worked", "presence"]) {
      expect(schema).not.toContain(forbidden);
    }
  });
});

describe("who is on leave, by department", () => {
  const panel = read("src", "features", "leave", "components", "ColleaguesOnLeavePanel.tsx");

  it("sections by department with Management first", () => {
    /*
      Asked for directly. The first version grouped by DATE, which is how a calendar thinks; a
      venue thinks in teams — "is anybody from Restaurant off today" is answerable at a glance
      where a flat list of forty names is not.
    */
    expect(panel).toContain('const LEAD_DEPARTMENT = "Management"');
    expect(panel).toContain("row.department_name");
    // Deterministic after that, so the order does not shuffle between renders.
    expect(panel).toContain("a.name.localeCompare(b.name)");
  });

  it("still says half day or full day", () => {
    expect(panel).toContain("isHalfDay(row.portion)");
    expect(panel).toContain("portionShort(row.portion)");
  });
});

describe("v_leave_roster stays narrow", () => {
  const RAW = read("supabase", "migrations", "20260902070000_everyone_can_see_who_is_on_leave.sql");
  /** Comments discuss the columns the assertions forbid, so they are stripped first. */
  const SQL = RAW.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

  it.each([
    "reason",
    "contact_during_leave",
    "address_during_leave",
    "handover_notes",
    "decision_comment",
    "cancellation_reason",
    "supporting_document_id",
  ])("does not expose %s", (column) => {
    const selectList = SQL.slice(
      SQL.indexOf("CREATE OR REPLACE VIEW"),
      SQL.indexOf("FROM public.leave_request_days"),
    );
    expect(selectList).not.toContain(column);
  });

  it("is not readable by anon", () => {
    // Supabase's default privileges grant the full set to anon on every new object in `public`,
    // and REVOKE ... FROM PUBLIC does not touch a grant made to a named role.
    expect(SQL).toContain("REVOKE ALL ON public.v_leave_roster FROM anon;");
    expect(SQL).toContain("GRANT SELECT ON public.v_leave_roster TO authenticated;");
  });

  it("shows approved leave only", () => {
    expect(SQL).toContain("lr.status IN ('approved', 'partially_approved')");
  });

  it("changes no policy", () => {
    expect(SQL).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/);
  });
});

describe("the panels are on the screen people actually open", () => {
  const home = read("src", "features", "home", "pages", "Home.page.tsx");

  it.each(["ColleaguesOnLeavePanel", "UpcomingHolidaysPanel"])(
    "renders %s on the home page",
    (p) => {
      /*
        Reported three times as "still can't see it". The panels were on `/me/leave/calendar`,
        which is not the page anybody opens. A feature nobody can find is indistinguishable from
        one never built.
      */
      expect(home).toContain(`<${p} />`);
    },
  );
});

describe("the holiday calendar is resolved, not read off the row", () => {
  it("falls back to resolve_policy when the column is null", () => {
    /*
      80 of 83 employees have `holiday_calendar_id` NULL. `useHolidaysInWindow` is
      `enabled: calendarId.length > 0`, so the holiday query never ran for them and the calendar
      showed none of the nineteen holidays that exist.
    */
    const api = read("src", "features", "leave", "api", "leave-apply.api.ts");
    expect(api).toContain('"resolve_policy"');
    expect(api).toContain('p_kind: "holiday_calendar"');
    expect(api).toContain("row.holiday_calendar_id !== null) return row");
  });
});
