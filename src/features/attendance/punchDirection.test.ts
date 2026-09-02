/**
 * punchDirection.test.ts — the punch button must say "Punch in" first and
 * "Punch out" after, and it must reset at the start of the business day.
 *
 * WHY THIS EXISTS
 * ---------------
 * Reported from the live app at 00:37, on a day with nothing recorded: the card
 * offered "Punch out" and explained itself with "5 recorded against 28-Jul-2026,
 * the day your shift started". Two independent defects produced that one screen,
 * and nothing in the suite objected to either.
 *
 *   1. THE DAY DID NOT RESET. `fetchSelfPunchState` took the business date off the
 *      LATEST punch in a two-day window. Just after midnight that is last night's
 *      punch, so the card adopted yesterday as the day in progress.
 *
 *   2. THE DIRECTION WAS PARITY, AND WAS CHANGED AWAY FROM IT — THEN BACK.
 *      `count % 2` was replaced by "first scan in, every later scan out", on the
 *      grounds that a day with three scans has one arrival, not two.
 *
 *      THE VENUE HAS SINCE REVERSED THAT, and parity is correct again, because the
 *      premise changed: a day here can be 09:00-13:00 and then 19:00-21:00, and the
 *      third scan of such a day genuinely IS a second arrival. The old rule's
 *      failure was visible on the card — somebody back for an evening shift, having
 *      punched out at lunch, was offered "Punch out" of a day they had left.
 *
 *      The engine agrees: it deducts the INTERIOR gap between the second and third
 *      scans as a break, so 09:00/13:00/19:00/21:00 is six hours whether you take
 *      span-minus-break or pair the punches up. Parity is not a second opinion
 *      about paid time; it is the same day, described so a person recognises it.
 *
 *      What has NOT changed is the stored column. Every punch is written
 *      `direction = 'undetermined'` and the server decides the response's direction
 *      itself, so this rule feeds the button's words and nothing else. Writing real
 *      labels into that column is the change that would be dangerous: the engine
 *      matches `undetermined` gaps specifically, so labelled punches would stop the
 *      interior gap counting as a break and turn that six-hour day into twelve.
 *
 * WHAT IT GUARDS
 * --------------
 *   · `nextDirectionAfter` — the rule itself, at the counts that matter. 0 and 1
 *     cannot distinguish the two rules, so the assertions below go past them.
 *   · That the OTHER half of the original report has not regressed: the business
 *     date still comes from the server, not from a punch row. That fix stands
 *     regardless of which direction rule is in force, and it is what made the card
 *     say "5 recorded against 28-Jul" at 00:37 on an empty day.
 *   · That the business date is asked of the server rather than derived from a
 *     punch row — the fix for (1) is a call to `my_punch_business_date`, and
 *     re-deriving it client-side is how this regresses.
 *
 * WHY THE BUSINESS DATE IS NOT COMPUTED HERE
 * ------------------------------------------
 * Because it must not be computed in the client at all. `set_punch_business_date`
 * back-dates an early-morning scan when the previous day's shift crosses midnight,
 * and this venue has two such shifts (EVT 16:00–01:30, SEC-N 19:00–07:00) with an
 * employee on SEC-N by default. For that person a 00:37 scan really does belong to
 * yesterday, so "always today" would tell a guard mid-shift they are punching IN.
 * Migration 085 put that rule in `public.punch_business_date` and had the trigger
 * call it; the card asks the same function. Re-implementing it in TypeScript would
 * be a second copy that drifts the first time a cutover changes — so the test
 * asserts the CALL, not a re-derivation.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextDirectionAfter, type NextDirection } from "./api/selfPunch.api";

const SOURCE = readFileSync(
  join(process.cwd(), "src/features/attendance/api/selfPunch.api.ts"),
  "utf8",
);

/** Strip comments: the prose above explains the parity bug and names it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The superseded rule, kept so the assertions can name what changed. */
function firstInEverythingElseOut(count: number): NextDirection {
  return count === 0 ? "in" : "out";
}

describe("nextDirectionAfter — parity, so a fragmented day reads correctly", () => {
  it("offers an arrival when the day in progress has nothing on it", () => {
    expect(nextDirectionAfter(0)).toBe("in");
  });

  it("offers a departure while they are on the clock", () => {
    for (const count of [1, 3, 5, 9, 41]) {
      expect(nextDirectionAfter(count)).toBe("out");
    }
  });

  it("offers a SECOND arrival after they have punched out", () => {
    /*
      THE VENUE'S OWN SCENARIO. Two punches recorded (in at 09:00, out at 13:00) and they come
      back at 19:00. The superseded rule said "out" — of a day they had already left.
    */
    expect(nextDirectionAfter(2)).toBe("in");
    expect(firstInEverythingElseOut(2)).toBe("out");
    for (const count of [4, 6, 8]) {
      expect(nextDirectionAfter(count)).toBe("in");
    }
  });

  it("alternates, so the button always describes the next real event", () => {
    const rule = Array.from({ length: 8 }, (_, i) => nextDirectionAfter(i));
    expect(rule).toEqual(["in", "out", "in", "out", "in", "out", "in", "out"]);
  });
});

describe("the business-date fix still stands", () => {
  it("asks the server which business date is in progress", () => {
    expect(SOURCE).toContain("my_punch_business_date");
  });

  it("does not take the business date from a punch row", () => {
    // The exact line that caused the report.
    expect(code(SOURCE)).not.toMatch(/businessDate\s*=\s*\w*\.?latest[?.]/i);
    expect(code(SOURCE)).not.toMatch(/const\s+businessDate\s*=\s*\w+\.effective_date/);
  });

  it("reports no last scan when the day in progress is empty", () => {
    // Guards the other half of the screenshot: a count of 0 printed beside "last
    // scan 22:15" from the night before.
    expect(code(SOURCE)).toContain("lastPunchAt: null");
    expect(code(SOURCE)).not.toMatch(/lastPunchAt:\s*latest\./);
  });
});

describe("migration 085 keeps one implementation of the business-date rule", () => {
  const MIGRATION = readFileSync(
    join(process.cwd(), "supabase/migrations/20260801038000_punch_business_date_fn.sql"),
    "utf8",
  );

  it("has the INSERT trigger call the shared function rather than repeat it", () => {
    const trigger = MIGRATION.slice(MIGRATION.indexOf("FUNCTION public.set_punch_business_date()"));
    expect(trigger).toContain("public.punch_business_date(NEW.employee_id, NEW.punched_at)");
    // The night rule must NOT appear a second time inside the trigger body.
    expect(trigger.slice(0, trigger.indexOf("$$;"))).not.toContain("crosses_midnight");
  });

  it("keeps an explicitly attributed punch untouched", () => {
    expect(MIGRATION).toContain("IF NEW.business_date IS NOT NULL THEN");
  });

  it("refuses the browser wrapper for an employee the caller cannot see", () => {
    expect(MIGRATION).toContain("app.can_see_employee");
    expect(MIGRATION).toContain("GRANT EXECUTE ON FUNCTION public.my_punch_business_date(uuid) TO authenticated");
    // The unguarded definer function must not be reachable from a JWT.
    expect(MIGRATION).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.punch_business_date\(uuid, timestamptz\) TO authenticated/,
    );
  });
});
