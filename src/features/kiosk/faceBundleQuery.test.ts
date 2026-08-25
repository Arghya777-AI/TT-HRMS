/**
 * faceBundleQuery.test.ts — the bundle query may only name columns that exist.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `kiosk-face-bundle` referenced `secure.face_templates.created_at`. There is no such column —
 * the timestamp is `enrolled_at` — so every call errored, the client recorded a refusal, and the
 * gate's footer said "offline recognition not ready" with no indication of why. It looked
 * exactly like a bundle that had not downloaded yet.
 *
 * Nothing could have caught it. `tsc` does not read SQL, the edge-function discipline rules are
 * about JavaScript, and the query only runs against a real database — which this suite has no
 * access to. A typo in a column name is invisible until a device fails in the field, and then
 * it presents as a feature that silently does not work.
 *
 * So the column names are checked against the migration that creates the table. Crude, and it
 * would have turned a day of confusion into a failing test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const fn = read("supabase", "functions", "kiosk-face-bundle", "index.ts");
const migration = read("supabase", "migrations", "20260801001200_biometrics_secure.sql");

/** Column names declared by a CREATE TABLE block in the migration. */
function columnsOf(table: string): Set<string> {
  const start = migration.search(new RegExp(`CREATE TABLE[^;]*?${table}\\s*\\(`));
  expect(start, `no CREATE TABLE for ${table}`).toBeGreaterThan(-1);
  const body = migration.slice(start, migration.indexOf("\n);", start));
  const names = new Set<string>();
  for (const line of body.split("\n").slice(1)) {
    // `  column_name  type ...` — skip CONSTRAINT/CHECK/PRIMARY lines.
    const match = /^\s{2,}([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(line);
    if (match === null) continue;
    const name = match[1]!.toLowerCase();
    if (["constraint", "check", "primary", "unique", "foreign", "exclude"].includes(name)) continue;
    names.add(name);
  }
  return names;
}

describe("the bundle query", () => {
  const templateColumns = columnsOf("face_templates");

  it("found the table definition at all — an empty set would pass everything below", () => {
    expect(templateColumns.size).toBeGreaterThan(15);
    expect(templateColumns.has("descriptor")).toBe(true);
    expect(templateColumns.has("enrolled_at")).toBe(true);
    // The column that did not exist, asserted absent so this test cannot rot into a tautology.
    expect(templateColumns.has("created_at")).toBe(false);
  });

  it("names only real columns of secure.face_templates", () => {
    /*
      Every `t.<name>` in the function, where `t` is the alias this file uses for
      face_templates. Deliberately simple: the value is in catching a typo, and a full SQL
      parser here would be a project of its own.
    */
    const referenced = new Set(
      [...fn.matchAll(/\bt\.([a-z_][a-z0-9_]*)/g)].map((m) => m[1]!.toLowerCase()),
    );
    expect(referenced.size, "no t.<column> references found — the regex has stopped matching")
      .toBeGreaterThan(4);

    const unknown = [...referenced].filter((c) => !templateColumns.has(c));
    expect(unknown, `columns not on secure.face_templates: ${unknown.join(", ")}`).toEqual([]);
  });

  it("matches kiosk-punch's eligibility rules, so the gate and the server agree", () => {
    /*
      A bundle assembled by different rules would make the device name somebody the server
      would refuse, or refuse somebody the server would name. These four conditions are the
      whole of `eligible` in kiosk-punch.
    */
    for (const clause of ["purged_at IS NULL", "c.granted", "c.withdrawn_at IS NULL", "a.is_active"]) {
      expect(fn, `missing eligibility clause: ${clause}`).toContain(clause);
    }
  });

  it("casts every parameter it interpolates into a function call", () => {
    // A bare parameter arrives as text: `round(numeric, text)` does not exist and fails the
    // whole query, which is the second way this endpoint managed to return nothing.
    expect(fn).toContain("::int)::real");
    expect(fn).toContain("::double precision");
  });
});
