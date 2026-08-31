/**
 * directoryColumns.test.ts — the directory's column list must exist in the view.
 *
 * WHAT HAPPENED
 * -------------
 * `exclude_from_leave_tracking` was added to `public.employees` and to
 * `DIRECTORY_COLUMNS` in the same change. The directory does not read `employees`;
 * it reads `v_admin_employee`, which enumerates its columns. So the browser asked a
 * view for a column it did not have, PostgREST refused the request, and the employee
 * label map came back empty — every row on the leave balances grid rendered with NO
 * NAME.
 *
 * The failure mode is what makes this worth a test. A rejected read does not throw
 * anywhere visible: it degrades to missing labels, and missing labels degrade to
 * blank cells. Nothing was red. Someone had to notice that names had stopped
 * appearing.
 *
 * WHAT THIS CHECKS
 * ----------------
 * Every name in `DIRECTORY_COLUMNS` is a column the migrations actually give
 * `v_admin_employee`. It reads the SQL rather than the database, so it runs in CI
 * with no connection — and that is also its limit: it proves the migrations define
 * the column, not that the live view has been rebuilt. A migration that has not been
 * run is a deployment question, not something a unit test can see.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DIRECTORY_COLUMNS } from "./employees.api";

/**
 * `DIRECTORY_COLUMNS` is a comma-joined STRING, not an array — it is passed
 * straight to PostgREST as `columns`. Split here rather than assuming: the first
 * version of this test called `.filter` on it and threw, and its companion
 * "not vacuous" check passed anyway on the string's `.length`. That is the exact
 * trap the companion check exists to catch, so it now counts names.
 */
function directoryColumnNames(): string[] {
  return String(DIRECTORY_COLUMNS)
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/**
 * The column names the LAST definition of `v_admin_employee` selects.
 *
 * Migrations are replayed in filename order, so the last file that redefines the
 * view is the one that wins — the same rule Postgres applies.
 */
function viewColumns(): Set<string> {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let latest: string | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const at = sql.lastIndexOf("VIEW public.v_admin_employee");
    if (at === -1) continue;
    const body = sql.slice(at);
    const end = body.indexOf(";");
    latest = end === -1 ? body : body.slice(0, end);
  }
  expect(latest, "no migration defines v_admin_employee").not.toBeNull();

  const select = latest as string;
  const names = new Set<string>();
  /* `x.column AS alias` — the alias is the name the client sees. */
  for (const m of select.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)) names.add((m[1] as string).toLowerCase());
  /* `e.column` with no alias keeps its own name. */
  for (const m of select.matchAll(/\b[a-z]+\.([a-z_][a-z0-9_]*)\s*(?:,|\n)/gi)) {
    names.add((m[1] as string).toLowerCase());
  }
  return names;
}

describe("DIRECTORY_COLUMNS against v_admin_employee", () => {
  it("selects only columns the view provides", () => {
    const available = viewColumns();
    const missing = directoryColumnNames().filter((c) => !available.has(c.toLowerCase()));
    expect(
      missing,
      `the directory selects ${String(missing.length)} column(s) v_admin_employee does not have: ` +
        `${missing.join(", ")}. PostgREST refuses the whole read, the employee label map comes back ` +
        "empty, and every name on screen goes blank with nothing logged. Add the column to the view " +
        "in a migration, or stop selecting it.",
    ).toEqual([]);
  });

  it("parsed a real view and a real column list, not two empty sets", () => {
    // Without this the check above passes silently the moment a regex stops matching.
    expect(viewColumns().size).toBeGreaterThan(20);
    expect(directoryColumnNames().length).toBeGreaterThan(15);
  });

  it("knows about the column that caused this", () => {
    expect(viewColumns()).toContain("exclude_from_leave_tracking");
  });
});
