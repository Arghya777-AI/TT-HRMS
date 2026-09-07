/**
 * A day still in progress is not a deficit.
 *
 * ── THE REPORT ───────────────────────────────────────────────────────────────
 * An in-scan at 08:29 with no out-scan yet produced, on the person-attendance screen:
 *
 *     Over / under worked   −4h 51m       Worked extra  3h 09m      Worked short  8h 00m
 *
 * The whole of that 8h shortfall was one unfinished day, and it flipped a month genuinely
 * 3h 09m AHEAD into 4h 51m behind. Employees read the red number, concluded their hours had
 * been lost, and raised it — repeatedly. The row also showed a bare em dash in the OVER/UNDER
 * column, which beside a red total reads as "broken", not as "not yet".
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * A day is measured after it has ended, at 23:59:59 IST. Before that it does not contribute to
 * any total and says which of two things it is:
 *
 *     clocked in, no out-scan yet  →  "Processing"
 *     an out-scan exists           →  "Tentative", final after 11:59 pm IST
 *
 * The second is not pedantry: the engine pairs scans by ORDER, so somebody who steps out at
 * 16:00 and back in at 17:00 has a last-out-scan that is not their last scan of the day.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * Purely presentational. `variance.ts` is a browser-side display module — the header has always
 * said "this is not payroll" — so nothing here changes what the engine computes, what
 * `attendance_days` stores, or what anybody is paid. No migration accompanies it. The engine
 * still resolves today as it always did; the screen just stops reporting a verdict early.
 *
 * EVERY OTHER RULE IS UNCHANGED, and that is asserted below rather than assumed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dayVariance,
  expectedMinutesFor,
  periodVariance,
  type VarianceDay,
} from "./lib/variance";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const TODAY = "2026-09-07";
const base: VarianceDay = {
  ist_date: TODAY,
  status: "present",
  is_holiday: false,
  is_weekly_off: false,
  is_working_day: true,
  shift_duration_minutes: 480,
  leave_type_id: null,
  leave_day_fraction: null,
  total_worked_minutes: 0,
  payable_worked_minutes: 0,
  first_in_at: null,
  last_out_at: null,
};
const d = (over: Partial<VarianceDay> = {}): VarianceDay => ({ ...base, ...over });

const varianceSrc = strip(read("src", "features", "attendance", "lib", "variance.ts"));
const adminGrid = strip(read("src", "features", "admin", "pages", "EmployeeAttendance.page.tsx"));
const myGrid = strip(read("src", "features", "attendance", "pages", "MyAttendance.page.tsx"));
const panel = strip(read("src", "features", "admin", "components", "PeriodVariancePanel.tsx"));
const live = strip(read("src", "features", "attendance", "components", "TodayLive.tsx"));

describe("the reported case", () => {
  it("no longer books a full shift against an in-scan with no out-scan", () => {
    const v = dayVariance(
      d({ status: "half_day", first_in_at: `${TODAY}T02:59:00Z`, last_out_at: null }),
      TODAY,
    );
    expect(v.reason).toBe("in_progress");
    expect(v.counts).toBe(false);
    expect(v.varianceMinutes).toBe(0);
  });

  it("reproduces the screenshot's arithmetic and shows the shortfall was the open day", () => {
    /* 4 days that ran long totalling +3h 09m, plus today's unfinished 8h shift. */
    const long = [50, 47, 46, 46].map((extra, i) =>
      d({
        ist_date: `2026-09-0${i + 1}`,
        shift_duration_minutes: 480,
        total_worked_minutes: 480 + extra,
        payable_worked_minutes: 480 + extra,
        last_out_at: `2026-09-0${i + 1}T12:00:00Z`,
      }),
    );
    const openToday = d({
      status: "half_day",
      first_in_at: `${TODAY}T02:59:00Z`,
      last_out_at: null,
    });

    const p = periodVariance([...long, openToday], TODAY);
    expect(p.surplusMinutes).toBe(189); // 3h 09m, as displayed
    expect(p.shortfallMinutes).toBe(0); // was 480 — the entire "Worked short 8h 00m"
    expect(p.varianceMinutes).toBe(189); // was −291 (−4h 51m)
    expect(p.openDays).toBe(1);
  });
});

describe("processing versus tentative", () => {
  it("is PROCESSING while clocked in", () => {
    expect(dayVariance(d({ first_in_at: `${TODAY}T03:00:00Z` }), TODAY).reason)
      .toBe("in_progress");
  });

  it("is TENTATIVE once an out-scan lands, even after the shift end", () => {
    // The day can still gain a return session, and scans pair by order.
    expect(
      dayVariance(
        d({ first_in_at: `${TODAY}T03:00:00Z`, last_out_at: `${TODAY}T13:00:00Z` }),
        TODAY,
      ).reason,
    ).toBe("provisional");
  });

  it("is TENTATIVE for today with no scans at all, not a shortfall", () => {
    expect(dayVariance(d(), TODAY).reason).toBe("provisional");
    expect(dayVariance(d(), TODAY).varianceMinutes).toBe(0);
  });

  it("counts open days apart from days the engine genuinely stalled on", () => {
    const p = periodVariance(
      [d({ first_in_at: `${TODAY}T03:00:00Z` }), d({ ist_date: "2026-09-01", status: "pending" })],
      TODAY,
    );
    expect(p.openDays).toBe(1);
    expect(p.unresolvedDays).toBe(1);
  });
});

describe("every other rule is unchanged", () => {
  const past = { ist_date: "2026-09-01", last_out_at: "2026-09-01T12:00:00Z" } as const;

  it("a finished day is still judged, in both directions", () => {
    expect(
      dayVariance(d({ ...past, total_worked_minutes: 586, payable_worked_minutes: 586 }), TODAY)
        .varianceMinutes,
    ).toBe(106);
    expect(
      dayVariance(d({ ...past, total_worked_minutes: 300, payable_worked_minutes: 300 }), TODAY)
        .varianceMinutes,
    ).toBe(-180);
  });

  it("a holiday and a weekly off still expect nothing and credit the work as surplus", () => {
    for (const key of ["is_holiday", "is_weekly_off"] as const) {
      const v = dayVariance(
        d({ ...past, [key]: true, total_worked_minutes: 120, payable_worked_minutes: 120 }),
        TODAY,
      );
      expect(v.expectedMinutes).toBe(0);
      expect(v.varianceMinutes).toBe(120);
      expect(v.counts).toBe(true);
    }
  });

  it("half a day of leave still expects half the shift", () => {
    const v = dayVariance(
      d({ ...past, leave_type_id: "lt", leave_day_fraction: 0.5,
          total_worked_minutes: 240, payable_worked_minutes: 240 }),
      TODAY,
    );
    expect(v.expectedMinutes).toBe(240);
    expect(v.varianceMinutes).toBe(0);
  });

  it("a future day, a stalled day, comp-off and pre-joining are all still excluded", () => {
    expect(dayVariance(d({ ist_date: "2026-09-30" }), TODAY).reason).toBe("future");
    expect(dayVariance(d({ ...past, status: "pending" }), TODAY).reason).toBe("unresolved");
    expect(dayVariance(d({ ...past, status: "comp_off_availed" }), TODAY).reason).toBe("on_leave");
    expect(dayVariance(d({ ...past, status: "not_yet_joined" }), TODAY).reason)
      .toBe("not_working_day");
  });

  it("changes nothing about payroll — it is a display module and says so", () => {
    expect(varianceSrc).not.toMatch(/overtime_minutes\s*=/);
    expect(varianceSrc).not.toMatch(/day_fraction_paid/);
    // The only date comparison that decides counting is against the IST civil day.
    expect(varianceSrc).toContain("day.ist_date === today");
  });
});

describe("the screens say which it is instead of a bare dash", () => {
  it("the live countdown reads the expectation, not the variance", () => {
    expect(live).toContain("expectedMinutesFor(today)");
    expect(live).not.toContain("dayVariance(today).expectedMinutes");
  });

  it("the expectation is 0 on a day that asks for nothing, so no countdown appears", () => {
    /*
      `dayVariance` short-circuits on these before it ever reaches `expectedMinutesFor`, so
      going through it does NOT exercise this — a mutation removing the guard survived until
      this test called it directly. `TodayLive` calls it directly, and a "7h 30m left" on a
      holiday would be nonsense.
    */
    const past = { ist_date: "2026-09-01" } as const;
    expect(expectedMinutesFor(d({ ...past, is_holiday: true }))).toBe(0);
    expect(expectedMinutesFor(d({ ...past, is_weekly_off: true }))).toBe(0);
    expect(expectedMinutesFor(d({ ...past, is_working_day: false }))).toBe(0);
    expect(expectedMinutesFor(d({ ...past, status: "comp_off_availed" }))).toBe(0);
    expect(expectedMinutesFor(d({ ...past, status: "not_yet_joined" }))).toBe(0);
    // A plain working day still asks for its shift.
    expect(expectedMinutesFor(d({ ...past }))).toBe(480);
    // And half a day of leave still halves it.
    expect(expectedMinutesFor(d({ ...past, leave_type_id: "lt", leave_day_fraction: 0.5 })))
      .toBe(240);
  });

  it("the expectation survives today being excluded", () => {
    const today = d({ status: "half_day", first_in_at: `${TODAY}T02:59:00Z` });
    expect(dayVariance(today, TODAY).expectedMinutes).toBe(0);
    expect(expectedMinutesFor(today)).toBe(480);
  });

  it("the admin grid labels the open day and dashes everything else", () => {
    expect(adminGrid).toContain('v.reason === "in_progress" || v.reason === "provisional"');
    expect(adminGrid).toContain("attendance.variance.cell.inProgress");
    expect(adminGrid).toContain("attendance.variance.cell.provisional");
    // A holiday or granted leave keeps the em dash — only today gets a word.
    expect(adminGrid).toContain('if (!open) return <span className="text-muted-foreground">');
  });

  it("the employee grid labels it too, from the same keys", () => {
    expect(myGrid).toContain("VARIANCE_CELL_KEY");
    expect(myGrid).toContain("attendance.variance.cell.inProgress");
    expect(myGrid).toContain("attendance.variance.cell.provisional");
    /*
      The RENDER, not just the lookup table. Asserting only that the keys exist let a mutation
      that reverted the cell to a bare `dash(null)` pass — the map was still there, unused.
    */
    expect(myGrid).toContain("cell === undefined ? dash(null) : ");
    expect(myGrid).toContain("{t(cell)}");
  });

  it("the period panel says today is not counted yet, separately from stalled days", () => {
    expect(panel).toContain("variance.openDays > 0");
    expect(panel).toContain("admin.pAtt.variance.openToday");
  });

  it("every message names the 11:59 pm IST boundary", () => {
    const en = read("src", "shared", "i18n", "en.ts");
    for (const key of [
      "attendance.variance.reason.inProgress",
      "attendance.variance.reason.provisional",
      "admin.pAtt.variance.openToday",
    ]) {
      const at = en.indexOf(`"${key}"`);
      expect(at).toBeGreaterThan(-1);
      expect(en.slice(at, at + 260)).toContain("11:59 pm IST");
    }
  });
});
