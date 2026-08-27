/**
 * selfPunchVisibility.test.ts — the form must not offer a toggle the trigger overrules.
 *
 * WHY THIS EXISTS
 * ---------------
 * The venue's Ground staff scan at the gate; they do not punch from a phone.
 * `departments.self_service_punch_allowed = false` (20260817120000) enforces that
 * with a BEFORE INSERT OR UPDATE trigger, which means a ticked box in a restricted
 * department is silently forced back to false on save.
 *
 * Silently is the problem. The first report of this was "as u can see Testing is
 * ground but still punch option is visible" — someone reading a form that asks a
 * question and then ignores the answer. The fix is that the form stops asking.
 *
 * These tests pin the honest behaviour: restricted → no toggles, unrestricted →
 * toggles, and nothing else about the form changes either way.
 */
import { describe, expect, it } from "vitest";

import type { FieldGroup, FieldSpec } from "../masters/fields";
import { SELF_PUNCH_FIELDS, timePolicyGroups, withoutForbiddenSelfPunch } from "./fields";

const NO_REFS = {
  companies: [],
  departments: [],
  designations: [],
  locations: [],
  shifts: [],
  weeklyOffRules: [],
  holidayCalendars: [],
  leavePolicies: [],
  managers: [],
  grades: [],
  costCentres: [],
  salaryStructures: [],
  banks: [],
} as unknown as Parameters<typeof timePolicyGroups>[0];

const GROUND = "11111111-1111-1111-1111-111111111111";
const OFFICE = "22222222-2222-2222-2222-222222222222";
const RESTRICTED = new Set([GROUND]);

const fieldNames = (groups: readonly FieldGroup[]): string[] =>
  groups.flatMap((g) => g.fields.map((f: FieldSpec) => f.name));

describe("withoutForbiddenSelfPunch", () => {
  const policy = timePolicyGroups(NO_REFS);

  it("finds the punch toggles in the real policy groups", () => {
    // If this fails the rest of the file is vacuous — the fields were renamed or
    // moved, and the filter is quietly removing nothing.
    for (const name of SELF_PUNCH_FIELDS) {
      expect(fieldNames(policy), `${name} is no longer on the policy tab`).toContain(name);
    }
  });

  it("removes both toggles for a department that forbids self-service punching", () => {
    const kept = fieldNames(withoutForbiddenSelfPunch(policy, GROUND, RESTRICTED));
    for (const name of SELF_PUNCH_FIELDS) expect(kept).not.toContain(name);
  });

  it("removes nothing else", () => {
    const before = fieldNames(policy);
    const after = fieldNames(withoutForbiddenSelfPunch(policy, GROUND, RESTRICTED));
    expect(after).toEqual(before.filter((n) => !SELF_PUNCH_FIELDS.includes(n)));
  });

  it("keeps the toggles for a department that allows them", () => {
    const kept = fieldNames(withoutForbiddenSelfPunch(policy, OFFICE, RESTRICTED));
    expect(kept).toEqual(fieldNames(policy));
  });

  it("keeps the toggles when no department has been chosen yet", () => {
    /*
      A wizard on step one has no department. Hiding the toggles then would make
      them appear later, which reads as a glitch — and the trigger has nothing to
      enforce until a department exists.
    */
    for (const empty of ["", null, undefined]) {
      expect(fieldNames(withoutForbiddenSelfPunch(policy, empty, RESTRICTED)))
        .toEqual(fieldNames(policy));
    }
  });

  it("keeps the toggles when no department is restricted", () => {
    expect(fieldNames(withoutForbiddenSelfPunch(policy, GROUND, new Set())))
      .toEqual(fieldNames(policy));
  });

  it("drops a group that held nothing but punch toggles", () => {
    const only: readonly FieldGroup[] = [
      { title: "How they punch", fields: policy.flatMap((g) =>
        g.fields.filter((f) => SELF_PUNCH_FIELDS.includes(f.name))) },
      { title: "Something else", fields: [{ name: "shift_id", label: "Shift", kind: "text" }] },
    ];
    const out = withoutForbiddenSelfPunch(only, GROUND, RESTRICTED);
    expect(out.map((g) => g.title)).toEqual(["Something else"]);
  });

  it("returns the same array when nothing is filtered, so memoised consumers do not rerender", () => {
    expect(withoutForbiddenSelfPunch(policy, OFFICE, RESTRICTED)).toBe(policy);
  });
});
