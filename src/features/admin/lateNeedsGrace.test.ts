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
const api = strip(read("src", "features", "admin", "api", "todayRoster.api.ts"));
const cell = strip(read("src", "features", "admin", "components", "TodayRoster.tsx"));

describe("a part-minute floors", () => {
  it("floors rather than casting, because the cast rounded", () => {
    // THE REGRESSION: `(EXTRACT(EPOCH ...) / 60)::integer` rounds 0.9 up to 1.
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
