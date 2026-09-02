/**
 * What a colleague can see of somebody else's day.
 *
 * The venue asked for "is my colleague inside or outside the office". That is a narrow question
 * and `attendance_days` answers a much wider one: late_minutes, early_exit_minutes,
 * payable_worked_minutes, day_fraction_paid, anomaly_flags. A peer must not be able to
 * reconstruct a punctuality record, so the view exposes presence and arrival and nothing else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RAW = readFileSync(
  join(process.cwd(), "supabase/migrations/20260902080000_colleagues_can_see_who_is_on_site.sql"),
  "utf8",
);
/** Comments discuss the columns the assertions forbid, so they are stripped first. */
const SQL = RAW.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("v_presence_roster stays narrow", () => {
  it.each([
    "late_minutes",
    "is_late",
    "early_exit_minutes",
    "payable_worked_minutes",
    "total_worked_minutes",
    "day_fraction_paid",
    "anomaly_flags",
    "overtime_minutes",
  ])("does not expose %s", (column) => {
    expect(SQL).not.toContain(column);
  });

  it("exposes presence, arrival and the day status", () => {
    for (const wanted of ["presence", "first_in_hm", "day_status", "display_name"]) {
      expect(SQL).toContain(wanted);
    }
  });
});

describe("inside vs outside is decided by the gate, not by a fence", () => {
  it("calls a gate scan the venue", () => {
    expect(SQL).toContain("bool_or(p.source = 'kiosk_face')");
    expect(SQL).toContain("'on_campus'");
  });

  it("does not use geofence_ok", () => {
    /*
      A web punch from the car park is inside the fence and still not somebody at their desk.
      And `geofence_ok` was NULL on every punch until the venue's coordinates were set, so it
      would report "outside" for history that merely predates a setting.
    */
    expect(SQL).not.toContain("geofence_ok");
  });

  it("counts voided punches as no punch", () => {
    // A punch an admin voided is not evidence anybody was here.
    expect(SQL).toContain("p.is_voided = false");
  });
});

describe("who may read it", () => {
  it("is not readable by anon", () => {
    // Supabase's default privileges grant the full set to anon on every new object in `public`,
    // and REVOKE ... FROM PUBLIC does not touch a grant made to a named role.
    expect(SQL).toContain("REVOKE ALL ON public.v_presence_roster FROM anon;");
  });

  it("grants SELECT only, to signed-in users only", () => {
    expect(SQL).toContain("GRANT SELECT ON public.v_presence_roster TO authenticated;");
    expect(SQL).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)\s+ON public\.v_presence_roster/);
  });

  it("changes no policy", () => {
    expect(SQL).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/);
  });
});

describe("the panels are on the screen people actually open", () => {
  const home = readFileSync(join(process.cwd(), "src/features/home/pages/Home.page.tsx"), "utf8");

  it.each(["WhoIsInPanel", "ColleaguesOnLeavePanel", "UpcomingHolidaysPanel"])(
    "renders %s on the home page",
    (panel) => {
      /*
        THE MISS THIS PINS. All three were built on `/me/leave/calendar` first, and reported as
        "still can't see it" — correctly, because that is not the page anybody opens. A feature
        nobody can find is indistinguishable from one that was never built.
      */
      expect(home).toContain(`<${panel} />`);
    },
  );

  it("keeps them on the leave calendar too, off the same views", () => {
    // Two places, one source. A second query would eventually disagree with the first.
    const cal = readFileSync(
      join(process.cwd(), "src/features/leave/pages/LeaveCalendar.page.tsx"),
      "utf8",
    );
    expect(cal).toContain("<WhoIsInPanel />");
    expect(cal).toContain("useLeaveRoster");
  });
});

describe("the holiday calendar is resolved, not read off the row", () => {
  it("falls back to resolve_policy when the column is null", () => {
    /*
      80 of 83 employees have `holiday_calendar_id` NULL. `useHolidaysInWindow` is
      `enabled: calendarId.length > 0`, so the holiday query never ran for them and the calendar
      showed none of the nineteen defined holidays.
    */
    const api = readFileSync(
      join(process.cwd(), "src/features/leave/api/leave-apply.api.ts"),
      "utf8",
    );
    expect(api).toContain('"resolve_policy"');
    expect(api).toContain('p_kind: "holiday_calendar"');
    // The row's own value still wins, so a per-employee override keeps working.
    expect(api).toContain("row.holiday_calendar_id !== null) return row");
  });
});
