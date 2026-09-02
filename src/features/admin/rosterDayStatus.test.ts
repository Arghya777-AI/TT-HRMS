/**
 * The roster's "present" must mean the same thing on every date.
 *
 * `v_attendance_today_board` publishes `attended` and `off_today` as SQL. A roster for a past
 * date reads `v_attendance_day_enriched`, which has neither, so TypeScript derives them — and
 * the moment those two definitions drift, today's roster and yesterday's roster disagree about
 * the same person on the same evidence.
 *
 * So this test reads the migration that defines the board view and asserts the status lists
 * still match, name for name. It is the reason `rosterDayStatus.ts` is a module and not two
 * inline conditions.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTENDED_STATUSES, OFF_STATUSES, attendedOn, offOn } from "./rosterDayStatus";

/** The board view's SQL, wherever it was last defined. */
function boardViewSql(): string {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  // Latest definition wins, the same way Postgres applied them.
  let found = "";
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    if (text.includes("v_attendance_today_board") && text.includes("AS attended")) found = text;
  }
  return found;
}

/** Status names inside the ARRAY[...] that produces one boolean column. */
function statusesFor(sql: string, column: string): string[] {
  const at = sql.indexOf(`AS ${column}`);
  if (at === -1) return [];
  const before = sql.slice(0, at);
  const open = before.lastIndexOf("ARRAY[");
  if (open === -1) return [];
  const close = before.indexOf("]", open);
  return [...before.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

describe("the derived booleans match the board view", () => {
  const sql = boardViewSql();

  it("found the board view's definition to compare against", () => {
    // If this fails the rest proves nothing, so it is asserted rather than assumed.
    expect(sql).not.toBe("");
  });

  it("attended uses the same statuses", () => {
    const inSql = statusesFor(sql, "attended");
    expect(inSql.length).toBeGreaterThan(0);
    expect([...inSql].sort()).toEqual([...ATTENDED_STATUSES].sort());
  });

  it("off_today uses the same statuses", () => {
    const inSql = statusesFor(sql, "off_today");
    expect(inSql.length).toBeGreaterThan(0);
    expect([...inSql].sort()).toEqual([...OFF_STATUSES].sort());
  });
});

describe("attendedOn", () => {
  it("needs a scan, not just a status", () => {
    /*
      The engine can mark a day `present` from a regularisation or an admin override with no
      scan behind it. A roster records who turned up, so that is not an attendance.
    */
    expect(attendedOn({ status: "present", punchCount: 0 })).toBe(false);
    expect(attendedOn({ status: "present", punchCount: 1 })).toBe(true);
  });

  it("counts a half day and a worked day off", () => {
    for (const status of ["half_day", "weekly_off_worked", "holiday_worked"]) {
      expect(attendedOn({ status, punchCount: 2 })).toBe(true);
    }
  });

  it("is false for a day the engine has not computed", () => {
    expect(attendedOn({ status: null, punchCount: 0 })).toBe(false);
    // Even with scans: `pending` is not a verdict, and treating it as presence is the
    // phantom-present twin of the phantom-absent defect.
    expect(attendedOn({ status: "pending", punchCount: 2 })).toBe(false);
  });
});

describe("offOn", () => {
  it("is true for leave, a weekly off and a holiday", () => {
    for (const status of ["weekly_off", "holiday", "on_leave", "on_leave_half", "comp_off_availed"]) {
      expect(offOn({ status, punchCount: 0 })).toBe(true);
    }
  });

  it("is false for absent, so absent stays derivable as what is left", () => {
    expect(offOn({ status: "absent", punchCount: 0 })).toBe(false);
    expect(offOn({ status: null, punchCount: 0 })).toBe(false);
  });
});
