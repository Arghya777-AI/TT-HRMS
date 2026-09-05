/**
 * Lateness is a verdict, not a subtraction — and a part-minute is not a minute.
 *
 * ── TWO SEPARATE THINGS WERE WRONG ───────────────────────────────────────────
 * 1. `util.minutes_between` divided seconds by sixty and CAST to integer, and a cast to
 *    integer in Postgres rounds half away from zero. 54 seconds became one minute; 1m 32s
 *    became two. So somebody scanning at 09:30:54 against a 09:30:00 shift was recorded a
 *    minute late for fifty-four seconds.
 *
 * 2. The roster rendered "late" whenever `lateMinutes > 0`, ignoring the engine's own
 *    verdict. The engine measures lateness from shift start and lets GRACE decide whether it
 *    counts — `is_late = late_minutes > grace_in_minutes` — so Trisha K, in at 09:31:09
 *    against a 09:30 shift with ten minutes of grace, stores one minute and is NOT late. The
 *    dashboard announced "+0h 01m late" over her anyway.
 *
 * A warning nobody has earned is worse than no warning: it teaches people to ignore the
 * column. Twenty-six days this month were being flagged inside the grace.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/*
  Comments stripped before asserting. The header prose quotes the very expressions under test —
  "GREATEST(0, ...) stays" — so an unstripped `toContain` was satisfied by the explanation
  rather than the code, and a mutation that deleted the real clamp still passed.
*/
const sql = strip(read("supabase", "migrations", "20260906150000_a_part_minute_is_not_a_minute.sql"));
const split = strip(
  read("supabase", "migrations", "20260906230000_worked_time_rounds_lateness_floors.sql"),
);
const ticker = strip(read("src", "features", "home", "hooks", "useHomeUi.ts"));
const api = strip(read("src", "features", "admin", "api", "todayRoster.api.ts"));
const cell = strip(read("src", "features", "admin", "components", "TodayRoster.tsx"));

describe("a part-minute floors", () => {
  it("floors rather than casting, because the cast rounded", () => {
    /*
      THE ORIGINAL REGRESSION: `(EXTRACT(EPOCH ...) / 60)::integer` rounds 0.9 up to 1. This
      migration introduced the floor; the LATER one splits it — durations went back to
      rounding, and only punctuality kept the floor. See the split describe below.
    */
    expect(sql).toContain("floor(EXTRACT(EPOCH FROM (p_to - p_from)) / 60)::integer");
    /*
      A lookbehind, because the FLOORED expression contains the old one as a substring —
      "floor(EXTRACT(...)/60)::integer" — so a plain absence check would fail on correct code.
      What must not exist is a cast whose opening paren is NOT floor's.
    */
    expect(sql).not.toMatch(/(?<!floor)\(EXTRACT\(EPOCH FROM \(p_to - p_from\)\) \/ 60\)::integer/);
  });

  it("still clamps a negative interval to zero", () => {
    // Two instants in the wrong order is not minus four minutes of work.
    expect(sql).toContain("GREATEST(0, floor(EXTRACT(EPOCH FROM (p_to - p_from)) / 60)::integer)");
  });

  it("fixes it in ONE place, where every duration passes through", () => {
    /*
      The span, the late and early figures, a break and a session length all call this. Fixing
      it per call site would let two figures on the same row disagree about what a minute is.
    */
    expect(sql).toContain("CREATE OR REPLACE FUNCTION util.minutes_between");
  });
});

describe("grace decides whether lateness counts", () => {
  it("carries the engine's verdict to the roster, not just the minutes", () => {
    expect(api).toContain("is_late: z.boolean(),");
    expect(api).toContain("isLate: row.is_late,");
    expect(api).toContain("readonly isLate: boolean;");
  });

  it("selects it on the per-day path too, not only today's board", () => {
    // A past date reads a different view; missing it there would flag late only on history.
    expect(api).toContain('"late_minutes, is_late, shift_id"');
  });

  it("renders the warning on the VERDICT, never on the minutes alone", () => {
    // THE REGRESSION THIS EXISTS FOR: it was `{row.lateMinutes > 0 ? (`.
    expect(cell).toContain("{row.isLate && row.lateMinutes > 0 ? (");
    expect(cell).not.toContain("{row.lateMinutes > 0 ? (");
  });

  it("still shows a real lateness rather than hiding all of it", () => {
    // The fix is to respect grace, not to stop reporting lateness.
    expect(cell).toContain('t("admin.roster.lateBy"');
  });
});

describe("a part-minute never counts against the employee", () => {
  it("rounds a DURATION, because flooring it only ever fell one way", () => {
    /*
      THE REGRESSION THIS EXISTS FOR, reported as "why are you deducting 1 minute from each
      employee". Measured: Anuj S worked 512.99 minutes and was paid 512; across 230 closed
      days the floor cost 115 minutes, always in the same direction. Rounding averages to
      nothing — the same 230 days now net +1.5.
    */
    expect(split).toContain("round(EXTRACT(EPOCH FROM (p_to - p_from)) / 60.0)::integer");
  });

  it("keeps the FLOOR for punctuality, in a function of its own", () => {
    // 54 seconds past the shift start is not a minute late, and 1m 32s is one, not two.
    expect(split).toContain("CREATE OR REPLACE FUNCTION util.minutes_late");
    expect(split).toContain("floor(EXTRACT(EPOCH FROM (p_to - p_from)) / 60.0)::integer");
  });

  it("clamps both to zero on a reversed interval", () => {
    expect(split.match(/GREATEST\(0,/g) ?? []).toHaveLength(2);
  });
});

describe("the clock on screen is the clock in your hand", () => {
  it("wakes at the minute boundary rather than on a fixed period", () => {
    /*
      THE REGRESSION THIS EXISTS FOR. It fired every 30s from whenever the component mounted,
      which is not the same as being right to the minute: mount at 09:02:59 and the ticks land
      at 09:03:29 and 09:03:59, so between 09:03:00 and 09:03:29 the header still said 09:02.
      Reported as the app running a minute behind a phone.
    */
    expect(ticker).toContain("60_000 - (now % 60_000)");
    expect(ticker).not.toContain("intervalMs = 30_000");
  });

  it("re-arms from the new clock each time, so drift and sleep both heal", () => {
    expect(ticker).toContain("setTick(Date.now());\n        arm();");
  });

  it("still repaints once a minute, not once a second", () => {
    // The display unit is whole minutes; a per-second timer repaints sixty times for nothing.
    expect(ticker).not.toContain("setInterval(() => setTick");
  });
});
