/**
 * The dashboard roster — the two things about it that fail silently.
 *
 * 1. THE DRILL-DOWN TARGET. `/admin/people/:code/attendance` looks the person up by
 *    `employee_code`. The first draft of the roster navigated to
 *    `/admin/people/${employeeId}?tab=attendance` — a uuid, and a query parameter no route
 *    reads. It compiles, it lints, it renders a clickable row, and every click lands on "no
 *    such employee". Nothing but opening the page catches it, so it is asserted here.
 *
 * 2. ABSENT IS DERIVED, NOT A STATUS. The engine leaves most days `pending` until it closes
 *    them, so counting rows whose status is literally "absent" would show almost nobody as
 *    absent on a day that has barely started — the phantom-present twin of the phantom-absent
 *    defect this repo already has rules about. Absent must be computed as "expected today, has
 *    not scanned, not off".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES } from "@/app/route-manifest";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const roster = read("src", "features", "admin", "components", "TodayRoster.tsx");
const api = read("src", "features", "admin", "api", "todayRoster.api.ts");

describe("the roster's drill-down", () => {
  it("navigates by employee CODE, to a route that exists", () => {
    expect(roster).toContain("/admin/people/${encodeURIComponent(row.employeeCode)}/attendance");
    // The exact regression: a uuid where the route wants a code.
    expect(roster).not.toContain("row.employeeId}?tab=");
    expect(roster).not.toMatch(/admin\/people\/\$\{row\.employeeId\}/);

    const paths = ROUTES.map((r) => r.path);
    expect(paths).toContain("/admin/people/:code/attendance");
  });

  it("lands on a page that shows the whole log AND the period's over/under", () => {
    /*
      The click was promised both. The log was already there; the total was not, and adding it
      to that page rather than re-deriving it here is what keeps one set of variance rules.
    */
    const page = read("src", "features", "admin", "pages", "EmployeeAttendance.page.tsx");
    expect(page).toContain("PeriodVariancePanel");
    expect(page).toContain("periodVariance(");
    // Summed over the UNNARROWED range, or the total would describe the pressed chip.
    expect(page).toContain("useDayRecords(breakdownFilters, VARIANCE_PAGE_SIZE)");
  });

  it("reuses the employee-facing variance rules rather than its own copy", () => {
    const page = read("src", "features", "admin", "pages", "EmployeeAttendance.page.tsx");
    expect(page).toContain('from "@/features/attendance/lib/variance"');
  });
});

describe("the roster's counts", () => {
  it("derives absent instead of trusting a status called absent", () => {
    // Expected today, has not scanned, not off.
    expect(api).toContain("!r.attended && !r.offToday");
    expect(api).not.toMatch(/status === "absent"/);
  });

  it("keeps leave out of absent, because only one of them is a problem", () => {
    expect(api).toContain('"on_leave"');
    expect(api).toContain('"comp_off_availed"');
  });

  it("expects nothing of an off day, so leave never reads as a shortfall", () => {
    // `row.off_today ? 0 : shift duration` — the single most misleading thing this table
    // could otherwise say about somebody on approved leave.
    expect(api).toContain("row.off_today ? 0 :");
    expect(api).toContain("expected > 0 ? row.worked_minutes - expected : null");
  });

  it("groups on DEPARTMENT, not on designation flags", () => {
    /*
      THE REGRESSION THIS REPLACED. Grouping on `designations.is_managerial / is_executive` read
      "management first" as "the managers first". The live data: of 20 people in the Management
      DEPARTMENT only 2 carry the flag, while Johar Lal Ree (Ground) does — so the dashboard
      headed a block "Management" that contained him and omitted most of Management.

      Asserted on the CODE, not on the file text: an earlier version of this test grepped for
      "is_managerial" and kept passing after the flags were removed, because the header comment
      explains why they went. A grep that a comment can satisfy is not a guard.
    */
    const code = api.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    expect(code).toContain("row.departmentId");
    expect(code).not.toContain("is_managerial");
    expect(code).not.toContain("is_executive");
  });

  it("builds the groups from the data instead of a fixed list", () => {
    /*
      Four of twenty-one departments have people. A hardcoded list would render seventeen empty
      tables and would silently omit a department created later.
    */
    const code = api.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    expect(code).toMatch(/new Map<string, RosterRow\[\]>\(\)/);
    expect(code).toContain("byDepartment");
  });

  it("gives every group its own present/absent/on-leave numbers", () => {
    // A venue-wide pair of totals cannot answer "is Restaurant short today".
    expect(api).toContain("counts: countRows(groupRows)");
    expect(api).toContain("counts: countRows(rows)");
  });

  it("pins Management first and puts no-department last", () => {
    expect(api).toContain('const LEAD_DEPARTMENT = "Management"');
    // Headcount then name, so the order is stable rather than dependent on row arrival.
    expect(api).toContain("b.counts.onRoll - a.counts.onRoll");
    expect(api).toContain("a.name.localeCompare(b.name)");
  });
});

describe("where a punch was taken", () => {
  it("prefers a WEB fix over a gate fix for the same person", () => {
    /*
      Not "the latest punch". Somebody who punches from home in the morning and at the gate in
      the afternoon would show 0 m, and the 4 km reading — the one an admin actually needs — is
      the one that vanishes. A gate fix is barely information anyway: the tablet is bolted to a
      known wall.
    */
    expect(api).toContain('existing.via === "web" && via === "gate"');
  });

  it("coerces Postgres numerics, because null is a real coordinate", () => {
    /*
      PostgREST serialises `numeric` as a STRING to preserve precision. `Number(null)` is 0, and
      (0, 0) is a point in the Gulf of Guinea — so a missing latitude would render as a punch
      taken 1,700 km off the coast of Africa rather than as no fix at all.
    */
    expect(api).toContain("function num(");
    expect(api).toContain("value === null || value === undefined) return null");
  });

  it("needs BOTH halves of the venue point, or it has none", () => {
    // A latitude with no longitude is not half a position.
    expect(api).toContain("venueLat === null || venueLng === null");
  });

  it("shares one haversine with the functions that enforce the fences", () => {
    /*
      A second copy is how this dashboard ends up disagreeing with the `geofence_ok` stored on
      the very row it is describing.
    */
    const helper = read("src", "lib", "venueDistance.ts");
    expect(helper).toContain('from "../../supabase/functions/_shared/geofence"');
  });
});

describe("the dashboard no longer opens on the six tiles", () => {
  it("shows the roster where the overlapping counts were", () => {
    const overview = read("src", "features", "admin", "components", "AnalyticsOverview.tsx");
    expect(overview).toContain("<TodayRoster");
    /*
      The old tiles overlapped — somebody late was also counted as arrived — so they could not be
      read as a whole. Asserting they are gone stops them being restored beside the roster, which
      would put two answers to "how many are here" on one screen.
    */
    expect(overview).not.toContain("overview.yetToReach");
    expect(overview).not.toContain("overview.attended");
  });
});
