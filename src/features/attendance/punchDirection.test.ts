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
 *   2. THE DIRECTION WAS PARITY. `count % 2 === 0 ? "in" : "out"` alternates, so a
 *      third scan in one day offered "Punch in" again — a day with three scans has
 *      one arrival, not two, and the attendance engine reads it that way (§3.1:
 *      first scan is the arrival, last is the departure).
 *
 * WHAT IT GUARDS
 * --------------
 *   · `nextDirectionAfter` — the rule itself, including the counts where parity and
 *     the rule DISAGREE. Those cases are the whole point: at 0 and 1 the two agree,
 *     so a test that only checked those would have passed against the bug.
 *   · That the parity idiom has not returned to the source. Cheap, and it is the
 *     specific line that was wrong.
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

/** What the old implementation would have said, for the disagreement cases. */
function parity(count: number): NextDirection {
  return count % 2 === 0 ? "in" : "out";
}

describe("nextDirectionAfter — first scan in, every later scan out", () => {
  it("offers an arrival when the day in progress has nothing on it", () => {
    expect(nextDirectionAfter(0)).toBe("in");
  });

  it("offers a departure once anything is recorded", () => {
    for (const count of [1, 2, 3, 4, 5, 9, 40]) {
      expect(nextDirectionAfter(count)).toBe("out");
    }
  });

  it("never offers a second arrival on the same day", () => {
    const arrivals = Array.from({ length: 30 }, (_, i) => nextDirectionAfter(i)).filter(
      (d) => d === "in",
    );
    expect(arrivals).toHaveLength(1);
  });

  it("disagrees with parity exactly where parity was wrong", () => {
    // 0 and 1 agree — which is why the bug survived casual use. It shows up on the
    // even counts from 2 up, where parity restarts the day.
    expect(nextDirectionAfter(0)).toBe(parity(0));
    expect(nextDirectionAfter(1)).toBe(parity(1));
    for (const count of [2, 4, 6, 8]) {
      expect(parity(count)).toBe("in");
      expect(nextDirectionAfter(count)).toBe("out");
    }
  });
});

describe("the source no longer decides either question for itself", () => {
  it("contains no parity test on the punch count", () => {
    expect(code(SOURCE)).not.toMatch(/%\s*2/);
  });

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
