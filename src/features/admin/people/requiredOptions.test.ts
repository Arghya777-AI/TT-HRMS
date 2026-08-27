/**
 * A required field must have options a person can actually choose.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `attendance_policy_id` was marked required while `usePeople` hardcoded its option list to an
 * empty array — under a comment saying no loader existed, which had been true once and had
 * stopped being true. Three active policies were in the database the whole time and
 * `useRefOptions` had been serving them to another screen for months.
 *
 * The result was not a cosmetic gap. A required select with no options is a wizard that cannot
 * be completed AT ALL: the one thing it demands can never be supplied, and the admin is left
 * clicking a dropdown that opens onto nothing. Requiring a field and supplying its choices are
 * two halves of one change, and nothing linked them.
 *
 * So this asserts the link: every required select in the employee form must be fed from a ref
 * that `usePeople` actually populates, and no ref may be hardcoded empty while something
 * requires it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const fields = readFileSync(join(ROOT, "src/features/admin/people/fields.ts"), "utf8");
const usePeople = readFileSync(join(ROOT, "src/features/admin/hooks/usePeople.ts"), "utf8");

/** Every field marked `required: true` that draws its options from `refs.<name>`. */
function requiredSelectRefs(): string[] {
  const found: string[] = [];
  // Fields are object literals; scan each `name:` block for a required flag and an options ref.
  const blocks = fields.split(/\n\s*\{\s*\n/);
  for (const block of blocks) {
    if (!/required:\s*true/.test(block)) continue;
    const ref = /options:\s*refs\.([A-Za-z0-9_]+)/.exec(block);
    if (ref !== null) found.push(ref[1]!);
  }
  return [...new Set(found)];
}

describe("a required select can actually be answered", () => {
  const refs = requiredSelectRefs();

  it("finds the required selects at all — an empty list would prove nothing", () => {
    expect(refs.length).toBeGreaterThan(2);
    // The four the client asked to be mandatory.
    for (const expected of ["shifts", "weeklyOffRules", "attendancePolicies", "departments"]) {
      expect(refs, `${expected} should feed a required field`).toContain(expected);
    }
  });

  it.each(requiredSelectRefs())("refs.%s is populated, not hardcoded empty", (ref) => {
    /*
      The exact shape of the bug: `attendancePolicies: [],` in the returned object. A required
      field pointed at that can never be satisfied.
    */
    const hardcodedEmpty = new RegExp(`${ref}:\\s*\\[\\s*\\]`);
    expect(
      hardcodedEmpty.test(usePeople),
      `usePeople returns ${ref} as a hardcoded empty list, but a required field depends on it`,
    ).toBe(false);
  });

  it("loads every required ref from a real query", () => {
    for (const ref of requiredSelectRefs()) {
      // Either a dedicated hook result spread through `opts(...)`, or an explicit map.
      const wired = new RegExp(`${ref}:\\s*(opts\\(|\\(.*\\)\\.map|${ref}\\b)`).test(usePeople);
      expect(wired, `usePeople does not populate ${ref} from a query`).toBe(true);
    }
  });
});
