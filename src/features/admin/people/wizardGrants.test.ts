/**
 * wizardGrants.test.ts — the form and the column grants must not drift apart.
 *
 * WHAT HAPPENED, AND WHY THIS FILE EXISTS
 * ---------------------------------------
 * A super-admin pressing "Create employee" was told "You do not have permission
 * to make this change. Ask a super admin if you believe you should." Their role
 * was never the problem.
 *
 * `employees` is guarded twice. The RLS policy (`app.is_admin()`) passed. The
 * COLUMN privileges did not: migration 005100 granted INSERT on a named list of
 * 51 columns, the wizard collects 48, and six of the wizard's were missing —
 * every "how this person punches" toggle. Postgres refuses the whole statement
 * with 42501 when an INSERT touches one ungranted column, so EVERY creation
 * through the wizard failed, for everybody, from the day 005100 shipped. The
 * venue's existing employees all arrived through service_role, which holds
 * table-wide grants, so nothing ever surfaced it.
 *
 * It stayed invisible because two lists that must agree lived in two languages
 * and nothing compared them. This compares them.
 *
 * If it fails: either add the column to the GRANT in a new migration, or take the
 * field off the wizard. Both are fine. Silently shipping a form that cannot save
 * is not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Every column named in a `GRANT INSERT (...) ON public.employees`, any migration. */
function grantedInsertColumns(): Set<string> {
  const files = [
    "supabase/migrations/20260801005100_admin_employee_write_access.sql",
    "supabase/migrations/20260801043800_add_employee_needs_its_own_columns.sql",
  ];
  const granted = new Set<string>();
  for (const file of files) {
    const sql = readFileSync(join(ROOT, file), "utf8");
    for (const m of sql.matchAll(/GRANT INSERT\s*\(([^)]*)\)\s*ON public\.employees/gs)) {
      for (const raw of (m[1] ?? "").split(",")) {
        const col = raw.trim();
        if (col !== "") granted.add(col);
      }
    }
  }
  return granted;
}

/**
 * The columns the wizard collects.
 *
 * Read from the six group builders `wizardStepGroups` actually calls — not every
 * field in the file, because `fields.ts` also serves the employee EDIT screens
 * (exit dates, payroll exclusions) which are legitimately not insertable.
 */
function wizardColumns(): Set<string> {
  const src = readFileSync(join(ROOT, "src/features/admin/people/fields.ts"), "utf8");
  const builders = [
    "nameGroup",
    "contactGroup",
    "personalGroups",
    "employmentTermsGroup",
    "orgPlacementGroup",
    "timePolicyGroups",
  ];
  const columns = new Set<string>();
  for (const fn of builders) {
    const start = new RegExp(`function ${fn}\\s*\\([^)]*\\)[^{]*\\{`).exec(src);
    expect(start, `${fn} not found in fields.ts`).not.toBeNull();
    let i = start!.index + start![0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") depth -= 1;
      i += 1;
    }
    for (const m of src.slice(start!.index, i).matchAll(/\bname:\s*"([a-z_0-9]+)"/g)) {
      columns.add(m[1] as string);
    }
  }
  return columns;
}

describe("Add Employee wizard column grants", () => {
  it("can write every column it collects", () => {
    const granted = grantedInsertColumns();
    const wizard = wizardColumns();
    const missing = [...wizard].filter((c) => !granted.has(c)).sort();
    expect(
      missing,
      `The wizard collects ${String(missing.length)} column(s) with no INSERT grant. ` +
        "Postgres refuses the whole statement with 42501, which the admin reads as " +
        "\"you do not have permission\". Grant them in a new migration, or drop the fields.",
    ).toEqual([]);
  });

  it("found a real wizard and a real grant, rather than passing on two empty sets", () => {
    // A regex that silently stops matching would make the test above vacuous —
    // which is exactly the failure mode of comparing two things you parsed.
    expect(wizardColumns().size).toBeGreaterThan(30);
    expect(grantedInsertColumns().size).toBeGreaterThan(40);
  });

  it("still refuses the columns that are not creation-time facts", () => {
    /*
      The fix was six named columns, not `GRANT INSERT ON employees`. An exit date
      or a payroll exclusion is not something you state while hiring somebody, and
      the enumerated list is what keeps that true.
    */
    const granted = grantedInsertColumns();
    for (const col of [
      "exit_type",
      "exit_reason",
      "last_working_day",
      "resignation_date",
      "full_and_final_settled_on",
      "is_rehire_eligible",
      "exclude_from_payroll",
      "primary_bank_account_id",
      "employee_code",
    ]) {
      expect(granted.has(col), `${col} should not be insertable by authenticated`).toBe(false);
    }
  });
});
