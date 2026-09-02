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

describe("hours worked are shown when there are any", () => {
  const cell = read("src", "features", "admin", "components", "TodayRoster.tsx");

  it("does not hide real hours behind the `attended` flag", () => {
    /*
      THE BUG, WITH ITS REAL ROW. Deepesh (117) punched in 07:59 and out 09:28. The engine
      recorded 88 minutes worked and — correctly, since 88 minutes does not earn a day — a status
      of `absent`. `attended` is false for `absent`, so `row.attended ? worked : "—"` printed a
      dash against 1h 28m of actual work, making the shortest day on the dashboard the one with
      no number on it.
    */
    expect(cell).not.toContain("row.attended ? fmtDurationHm(row.workedMinutes)");
    // The decision moved into `workedDisplay`, which is asserted on its OUTCOMES in
    // workedDisplay.test.ts rather than on the shape of an `if` here.
    expect(cell).toContain("workedDisplay({");
  });

  it("shows a live clock for somebody still in, instead of 0h 00m", () => {
    /*
      `total_worked_minutes` counts COMPLETED intervals, so it is genuinely 0 for the 54 people
      who had scanned in and not out. Correct, and useless next to the word "Present": it reads
      as a whole shift of nothing.
    */
    const decide = read("src", "features", "admin", "workedDisplay.ts");
    expect(decide).toContain("elapsedOnSite({");
    expect(decide).toContain("if (elapsed.running) return { kind: \"running\", elapsed }");
    // And the case that survived the first fix: both scans, nothing credited.
    expect(decide).toContain("if (elapsed.totalSeconds > 0) return { kind: \"span\", elapsed }");
  });

  it("never labels the live clock as worked", () => {
    /*
      They are different measurements. The engine's figure is paid time with the shift's unpaid
      break already subtracted; the clock is wall-clock since the first scan. One label for both
      would make the pair look like a contradiction.
    */
    const en = read("src", "shared", "i18n", "en.ts");
    expect(en).toContain('"admin.roster.onSite": "{value} on site"');
    expect(en).not.toMatch(/"admin\.roster\.onSite[^"]*":\s*"[^"]*worked/i);
  });

  it("runs one clock for the table, and only while somebody is in", () => {
    // Per-row intervals would put eighty timers on the page; an unconditional one would
    // re-render eighty rows every second all night.
    expect(cell).toContain("const nowMs = useTick(anyRunning)");
    expect(cell).toContain("r.firstInAt !== null && r.lastOutAt === null");
  });

  it("keeps one ticker in the codebase, not two", () => {
    const drill = read("src", "features", "admin", "components", "BucketDrillDown.tsx");
    expect(drill).toContain('from "../hooks/useTick"');
    // The local copy is gone — two answers to "what time is it" on one screen eventually differ.
    expect(drill).not.toContain("function useTick(");
  });
});

describe("over/under waits for the day to end", () => {
  const cell = read("src", "features", "admin", "components", "TodayRoster.tsx");

  it("shows nothing while somebody is still on site", () => {
    /*
      It read "−8h 00m" for everybody who had scanned in and not out, because worked was 0
      against an expected 480. Somebody who arrived twenty minutes ago has not failed to work
      eight hours — the day has not finished asking. A figure that is wrong all morning and right
      at closing time is worse than a dash.
    */
    expect(cell).toContain("const open = row.firstInAt !== null && row.lastOutAt === null");
    expect(cell).toContain("if (row.varianceMinutes === null || open)");
  });

  it("no longer gates on `attended`, so a short day still gets its figure", () => {
    // Deepesh: 88 worked against a 480-minute shift is −6h 32m, and that is the row to look at.
    expect(cell).not.toContain("row.varianceMinutes === null || !row.attended");
  });
});

describe("where a punch was taken", () => {
  it("keeps EVERY punch, not one per person", () => {
    /*
      THE REGRESSION THIS REPLACED. It used to keep a single fix, web preferred over the gate —
      which answered "was this person away today" and could not answer "away WHEN". A day of
      09:00 at the gate then 19:00 from home rendered only the 19:00 and lost the arrival.

      A punch timeline is the industry-standard shape for an attendance row, and it is what was
      asked for: the location of the in AND the out, in one column.
    */
    expect(api).toContain("punchesByEmployee");
    expect(api).toContain("readonly punches: readonly PunchOnRoster[]");
    // The old single-fix preference must not come back.
    expect(api).not.toContain('existing.via === "web" && via === "gate"');
  });

  it("preserves punch order, because a timeline that is out of order is a lie", () => {
    // The query orders by `punched_at` ascending and the loop pushes, so order survives.
    expect(api).toContain('order: [{ column: "punched_at", ascending: true }]');
  });

  it("gives a gate punch no distance, and a web punch one", () => {
    /*
      The tablet is bolted to a known wall and its own fixes cluster inside ~17 m x 32 m, so a
      number on a gate chip is GPS noise dressed as a measurement.
    */
    const cell = read("src", "features", "admin", "components", "TodayRoster.tsx");
    expect(cell).toContain('punch.via === "web" && punch.distance !== null');
  });

  it("has one column, not the two it replaced", () => {
    const cell = read("src", "features", "admin", "components", "TodayRoster.tsx");
    expect(cell).toContain("admin.roster.col.punches");
    expect(cell).not.toContain("admin.roster.col.method");
    expect(cell).not.toContain("admin.roster.col.location");
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

describe("the roster follows a selected day", () => {
  const api = read("src", "features", "admin", "api", "todayRoster.api.ts");
  const hook = read("src", "features", "admin", "hooks", "useTodayRoster.ts");
  const page = read("src", "features", "admin", "components", "AnalyticsOverview.tsx");

  it("reads a DIFFERENT view for any date but today", () => {
    /*
      `v_attendance_today_board` is scoped to `util.ist_today()` INSIDE the view, so it cannot
      answer for yesterday. It stays the source for today because it publishes `attended` and
      `off_today` as SQL and carries the live flags that only mean something about a day in
      progress.
    */
    expect(api).toContain("V_DAY_ENRICHED");
    expect(api).toContain("const isToday = date === today");
    expect(api).toContain("? fetchTodayBoard(");
  });

  it("derives attended/off through the SHARED definition, not a second copy", () => {
    // rosterDayStatus.test.ts pins those status lists against the board's own SQL.
    expect(api).toContain("attendedOn({ status: row.status, punchCount: row.punch_count })");
    expect(api).toContain("offOn({ status: row.status, punchCount: row.punch_count })");
  });

  it("groups on the department ID even though the day view has only the name", () => {
    // Two departments can share a display name after a rename; a name key would merge them.
    expect(api).toContain("departmentByEmployee.get(row.employee_id)");
    expect(api).toContain("department_id: z.string().uuid().nullable()");
  });

  it("only polls when it is showing today", () => {
    /*
      A past day cannot change while somebody looks at it. Polling it would be a query a minute
      for a settled answer, all night, on a dashboard left open on a wall.
    */
    expect(hook).toContain("...(isToday ? { refetchInterval: 60_000 } : {})");
  });

  it("follows the DAY granularity and no other", () => {
    /*
      A roster is one row per person for one date. Over a month the useful thing is days present
      and hours per person, which already exists at /admin/analytics/employees on this same
      filter model — thirty days of names here would be a worse version of it.
    */
    expect(page).toContain('filters.period.granularity === "day"');
  });

  it("names the date when it is not today", () => {
    // "On site today" over yesterday's attendance is a label somebody acts on and is wrong about.
    expect(page).toContain("admin.analytics.overview.dayTitle");
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
