/**
 * A recognised face at the gate must produce a punch — the two things that stopped that.
 *
 * ── WHAT HAPPENED ────────────────────────────────────────────────────────────
 * `employment_status` defaults to `pre_joining`, in the table (migration 008) and in this
 * wizard's own seed values. It was absent from `PUNCHABLE_STATUSES` in BOTH `kiosk-punch` and
 * `attendance-self-punch`, so it was the one status an employee both STARTS in and cannot punch
 * from.
 *
 * Nothing could move them off it either. The only route is a `joined` lifecycle event, which
 * `ele_status_projection` maps to `active`, and NO SCREEN COULD WRITE ONE: between them the app
 * could record `confirmed`, `rehired`, `promoted`, `transferred`, `department_changed` and
 * `manager_changed`, and nothing else. `employee_lifecycle_events` was empty in production. The
 * 78 employees who could punch got their status from the bulk import, which sets the column
 * directly and bypasses the stream — which is why the hole stayed invisible until somebody was
 * added through the wizard.
 *
 * Four were. Each had their face recognised at 0.85–0.92 confidence against a 0.62 threshold,
 * and every punch was refused with `employment_status=pre_joining`. Zero punches were written.
 * From the outside it looked like a broken camera.
 *
 * ── BOTH HALVES ARE FIXED, AND BOTH ARE GUARDED HERE ─────────────────────────
 * `pre_joining` now punches — the venue's decision, on the same reasoning that already admitted
 * `absconding` and `on_long_leave`: somebody at the door is a fact HR needs, and a paperwork
 * discrepancy reconciles better from a recorded scan than from a missing one.
 *
 * And `joined` is now reachable, so the record can be corrected rather than left wrong forever.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEW_EMPLOYEE_DEFAULTS, employeeFormError } from "./fields";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const TODAY = "2026-08-27";
const PUNCH_PATHS = ["kiosk-punch", "attendance-self-punch"] as const;

/** The statuses in a function's `PUNCHABLE_STATUSES`, read from its source. */
function punchableIn(fn: string): readonly string[] {
  const source = read("supabase", "functions", fn, "index.ts");
  const block = /PUNCHABLE_STATUSES[^[]*\[([^\]]*)\]/.exec(source);
  expect(block, `${fn} has no PUNCHABLE_STATUSES literal`).not.toBeNull();
  return [...(block?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
}

describe("the status an employee starts in can punch", () => {
  it.each(PUNCH_PATHS)("%s accepts pre_joining", (fn) => {
    /*
      THE REGRESSION THIS EXISTS FOR. `pre_joining` is the wizard default and the column
      default, so excluding it here does not gate an edge case — it gates the state every new
      employee is created in.
    */
    expect(punchableIn(fn)).toContain("pre_joining");
  });

  it("keeps the two paths in exact agreement", () => {
    /*
      Which door somebody used must not decide whether they may punch. An employee refused at
      the gate but accepted on the portal (or the reverse) is a bug found by a person standing
      in front of a camera, not by us.
    */
    const gate = punchableIn("kiosk-punch");
    const web = punchableIn("attendance-self-punch");
    expect([...gate].sort()).toEqual([...web].sort());
  });

  it.each(PUNCH_PATHS)("%s still refuses the statuses with a decision behind them", (fn) => {
    // Someone told not to come in, and people who have left. Those refusals are the point.
    const punchable = punchableIn(fn);
    for (const status of ["suspended", "exited", "retired"]) {
      expect(punchable, status).not.toContain(status);
    }
  });

  it("does not also block the wizard on the state it just made work", () => {
    /*
      A guard here briefly refused a past joining date left on `pre_joining`, on the grounds
      that such an employee could not punch. They can now, so the guard would refuse a save for
      a state that works — a barrier with nothing behind it.
    */
    const values = { work_email: "someone@example.com", ...NEW_EMPLOYEE_DEFAULTS };
    expect(NEW_EMPLOYEE_DEFAULTS["employment_status"]).toBe("pre_joining");
    expect(employeeFormError({ ...values, date_of_join: TODAY }, TODAY)).toBeNull();
    expect(employeeFormError({ ...values, date_of_join: "2026-08-17" }, TODAY)).toBeNull();
  });

  it("still forces a FUTURE joining date to pre_joining", () => {
    // Untouched, and the one direction that was always right: they have not started.
    expect(
      employeeFormError(
        { work_email: "a@b.co", date_of_join: "2026-09-15", employment_status: "active" },
        TODAY,
      ),
    ).not.toBeNull();
  });
});

describe("the app can record that somebody joined", () => {
  it("writes the `joined` event, so a wrong status can be corrected", () => {
    const onboarding = read("src", "features", "admin", "pages", "Onboarding.page.tsx");
    // Offered on the rows that need it, and nowhere else.
    expect(onboarding).toContain('prompt.ask({ employee: r, action: "joined" })');
    expect(onboarding).toContain('r.employment_status === "pre_joining"');
    expect(onboarding).toContain("eventType: target.action");
  });

  it("dates the joining from the record, not from the day somebody noticed", () => {
    const onboarding = read("src", "features", "admin", "pages", "Onboarding.page.tsx");
    /*
      Stamping today would claim somebody who has been at work for ten days joined this
      morning. `date_of_join` is already on the record; today is only the fallback.
    */
    expect(onboarding).toContain(
      'target.action === "joined" ? (target.employee.date_of_join ?? today) : today',
    );
  });

  it("maps `joined` to a status both punch paths accept", () => {
    /*
      Three files that have to agree: the projection decides the status, and the two punch paths
      decide whether it may punch. If a migration ever remaps `joined`, this fails here rather
      than at the gate.
    */
    const migration = read("supabase", "migrations", "20260801001100_employee_lifecycle.sql");
    expect(migration).toMatch(/WHEN 'joined'\s+THEN 'active'/);
    for (const fn of PUNCH_PATHS) expect(punchableIn(fn), fn).toContain("active");
  });
});
