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

describe("colleague leave lives INSIDE the calendar", () => {
  const home = read("src", "features", "home", "components", "MyMonthCalendar.tsx");
  const cal = read("src", "features", "leave", "pages", "LeaveCalendar.page.tsx");

  it("puts the count in the home calendar's day cells", () => {
    /*
      THE MISTAKE THIS PINS, MADE FOUR TIMES. Every earlier attempt rendered a LIST beside the
      calendar — on the leave page, then on the home page, then grouped by department. The
      instruction each time was "inside the calendar", meaning the day boxes of the month grid,
      the way the admin's org calendar shows it. A list next to a grid is not the same thing.
    */
    /*
      The badge's own render, not just a mention of `cell.onLeave.length` — the first version of
      this assertion matched the `disabled={cell.isFuture && cell.onLeave.length === 0}` line and
      passed with the badge deleted. Confirmed by deleting it and watching the test stay green.
    */
    expect(home).toContain("{cell.onLeave.length === 0 ? null : (");
    expect(home).toContain("home.cal.colleaguesOff");
  });

  it("names them when a home day cell is opened", () => {
    expect(home).toContain("openCell.onLeave.map");
  });

  it("lets a FUTURE day open when a colleague is off then", () => {
    /*
      Future cells were disabled outright, because my own attendance has not happened yet. A
      colleague's approved leave next Friday HAS happened as a fact and is the most useful thing
      on the grid, so the cell has to be reachable.
    */
    expect(home).toContain("cell.isFuture && cell.onLeave.length === 0");
  });

  it("puts it in the leave calendar's cells too, capped", () => {
    expect(cal).toContain("cell.colleagues.length");
    // Three names fit a 5.5rem cell; thirty would make the month ragged.
    expect(cal).toContain("cell.colleagues.slice(0, 3)");
    expect(cal).toContain("leave.cal.colleaguesMore");
  });

  it("has no list panel beside either calendar any more", () => {
    for (const src of [
      read("src", "features", "home", "pages", "Home.page.tsx"),
      cal,
    ]) {
      expect(src).not.toContain("ColleaguesOnLeavePanel");
      expect(src).not.toContain("WhoIsInPanel");
    }
  });

  it("still says half day or full day", () => {
    expect(home).toContain("isHalfDay(row.portion)");
    expect(cal).toContain("isHalfDay(c.portion)");
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

describe("holidays stay a list, on the home page", () => {
  it("renders UpcomingHolidaysPanel there", () => {
    /*
      Deliberately NOT moved into the grid. "What is the next holiday" is a question about dates
      further out than the month on screen, and reading it off a grid one month at a time answers
      it badly.
    */
    expect(read("src", "features", "home", "pages", "Home.page.tsx"))
      .toContain("<UpcomingHolidaysPanel />");
  });
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
