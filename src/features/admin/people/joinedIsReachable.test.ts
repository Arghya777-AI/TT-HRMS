/**
 * An employee who has joined must be able to punch — the two defects that stopped that.
 *
 * ── WHAT HAPPENED ────────────────────────────────────────────────────────────
 * `employment_status` defaults to `pre_joining`, in the table (migration 008) and in this
 * wizard's own seed values. `pre_joining` is absent from `PUNCHABLE_STATUSES` in BOTH
 * `kiosk-punch` and `attendance-self-punch` — correctly, since somebody who has not started
 * has no business punching.
 *
 * The only route out of it is a `joined` lifecycle event, which `ele_status_projection` maps to
 * `active`. NO SCREEN COULD WRITE ONE. Between them the app could record `confirmed`,
 * `rehired`, `promoted`, `transferred`, `department_changed` and `manager_changed`, and nothing
 * else; `employee_lifecycle_events` was empty in production. The 78 employees who could punch
 * got their status from the bulk import, which sets the column directly and bypasses the stream
 * — so the hole stayed invisible until somebody was added through the wizard.
 *
 * Four were. Every one of them had their face recognised at the gate at 0.85–0.92 confidence
 * against a 0.62 threshold, and every punch was refused with `employment_status=pre_joining`.
 * Zero punches were written. From the outside it looked like a broken camera.
 *
 * Two guards, because either one alone leaves the trap open: the wizard must not create the
 * state, and the app must be able to leave it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEW_EMPLOYEE_DEFAULTS, employeeFormError } from "./fields";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const TODAY = "2026-08-27";

/** Enough of the form to reach the rule under test — every earlier check passes. */
function form(over: Record<string, string>): Record<string, string> {
  return { work_email: "someone@example.com", ...over };
}

describe("the wizard cannot create an employee who is unable to punch", () => {
  it("rejects a joining date already past while the status is still Pre-joining", () => {
    const error = employeeFormError(
      form({ date_of_join: "2026-08-17", employment_status: "pre_joining" }),
      TODAY,
    );
    expect(error).not.toBeNull();
    // The message must name the consequence — an admin cannot act on "inconsistent status".
    expect(error).toMatch(/attendance/i);
  });

  it("rejects it on the joining day itself", () => {
    // The boundary is the whole point: somebody starting TODAY must be able to punch today.
    expect(
      employeeFormError(form({ date_of_join: TODAY, employment_status: "pre_joining" }), TODAY),
    ).not.toBeNull();
  });

  it("still accepts Pre-joining for somebody who has not started", () => {
    expect(
      employeeFormError(
        form({ date_of_join: "2026-09-15", employment_status: "pre_joining" }),
        TODAY,
      ),
    ).toBeNull();
  });

  it("accepts a past joining date with a punchable status", () => {
    for (const status of ["active", "on_probation", "confirmed"]) {
      expect(
        employeeFormError(form({ date_of_join: "2026-08-17", employment_status: status }), TODAY),
        status,
      ).toBeNull();
    }
  });

  it("catches the exact production case: the seed defaults, joining today", () => {
    /*
      This is what an admin clicking through the wizard produced. The defaults are deliberately
      not changed — they match the table's own — so the validation is what has to catch it.
    */
    expect(NEW_EMPLOYEE_DEFAULTS["employment_status"]).toBe("pre_joining");
    expect(
      employeeFormError(form({ ...NEW_EMPLOYEE_DEFAULTS, date_of_join: TODAY }), TODAY),
    ).not.toBeNull();
  });
});

describe("the app can record that somebody joined", () => {
  it("writes the `joined` event, which is the only route to a punchable status", () => {
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
      morning — and ten days of silence is exactly what this action exists to end. `date_of_join`
      is already on the record; today is only the fallback when it is not.
    */
    expect(onboarding).toContain(
      'target.action === "joined" ? (target.employee.date_of_join ?? today) : today',
    );
  });

  it("maps `joined` to a status both punch paths accept", () => {
    /*
      The three files that have to agree, asserted together — the projection decides the status,
      and the two punch paths decide whether that status may punch. If a migration ever remaps
      `joined`, this fails here rather than at the gate.
    */
    const migration = read(
      "supabase",
      "migrations",
      "20260801001100_employee_lifecycle.sql",
    );
    expect(migration).toMatch(/WHEN 'joined'\s+THEN 'active'/);

    for (const fn of ["kiosk-punch", "attendance-self-punch"]) {
      const source = read("supabase", "functions", fn, "index.ts");
      const set = /PUNCHABLE_STATUSES[^[]*\[([^\]]*)\]/.exec(source);
      expect(set, fn).not.toBeNull();
      expect(set?.[1], fn).toContain('"active"');
      // And the status the wizard leaves behind must stay refused — the refusal is correct.
      expect(set?.[1], fn).not.toContain("pre_joining");
    }
  });
});
