/**
 * The "Other…" resolver's pure parts. The insert itself belongs to PostgREST; what is
 * worth pinning here is the row each table gets, the code derivation, and the two
 * refusals that exist because the schema demands a parent or a level.
 */
import { describe, expect, it } from "vitest";
import {
  OTHER_VALUE,
  applyResolvedOthers,
  buildOtherRow,
  deriveCode,
  otherNameKey,
} from "./orgOther";

describe("deriveCode", () => {
  it("upper-snakes a name", () => {
    expect(deriveCode("Front Office")).toBe("FRONT_OFFICE");
  });

  it("collapses punctuation and runs into single underscores", () => {
    expect(deriveCode("Food & Beverage — Service")).toBe("FOOD_BEVERAGE_SERVICE");
  });

  it("trims leading and trailing separators", () => {
    expect(deriveCode("  (Banquets)  ")).toBe("BANQUETS");
  });

  it("keeps digits", () => {
    expect(deriveCode("Kitchen 2")).toBe("KITCHEN_2");
  });

  it("caps at 30 characters and never ends on an underscore", () => {
    const code = deriveCode("A very long departmental name that will certainly overflow");
    expect(code.length).toBeLessThanOrEqual(30);
    expect(code.endsWith("_")).toBe(false);
  });

  it("returns empty for a name with nothing usable in it", () => {
    expect(deriveCode("—  —")).toBe("");
    expect(deriveCode("")).toBe("");
  });
});

describe("buildOtherRow", () => {
  const ctx = { companyId: "co-1", departmentId: "dept-1", existingGradeCount: 4 };

  it("gives a department its company", () => {
    expect(buildOtherRow("departments", "Front Office", ctx)).toEqual({
      code: "FRONT_OFFICE",
      name: "Front Office",
      is_active: true,
      company_id: "co-1",
    });
  });

  it("gives a section its DEPARTMENT, not a company — the column the table actually has", () => {
    const row = buildOtherRow("sections", "Reception", ctx);
    expect(row).toEqual({
      code: "RECEPTION",
      name: "Reception",
      is_active: true,
      department_id: "dept-1",
    });
    expect(row).not.toHaveProperty("company_id");
  });

  it("appends a new grade at the bottom of the ladder rather than inventing a level", () => {
    expect(buildOtherRow("grades", "Band E", ctx)).toMatchObject({ level: 5 });
  });

  it("gives the first grade level 1", () => {
    expect(
      buildOtherRow("grades", "Band A", { ...ctx, existingGradeCount: 0 }),
    ).toMatchObject({ level: 1 });
  });

  it("trims the stored name but derives the code from the untrimmed input", () => {
    expect(buildOtherRow("designations", "  Sous Chef  ", ctx)).toMatchObject({
      name: "Sous Chef",
      code: "SOUS_CHEF",
    });
  });
});

describe("applyResolvedOthers", () => {
  it("swaps the sentinel for the created id", () => {
    const out = applyResolvedOthers(
      { department_id: OTHER_VALUE, first_name: "Asha" },
      { department_id: "new-dept" },
    );
    expect(out["department_id"]).toBe("new-dept");
    expect(out["first_name"]).toBe("Asha");
  });

  it("drops the __otherName companions — they are form state, not columns", () => {
    const out = applyResolvedOthers(
      {
        department_id: OTHER_VALUE,
        [otherNameKey("department_id")]: "Front Office",
        last_name: "Rao",
      },
      { department_id: "new-dept" },
    );
    expect(out).not.toHaveProperty(otherNameKey("department_id"));
    expect(Object.keys(out).sort()).toEqual(["department_id", "last_name"]);
  });

  it("leaves ordinary selections untouched when nothing was resolved", () => {
    const out = applyResolvedOthers({ department_id: "existing-dept" }, {});
    expect(out["department_id"]).toBe("existing-dept");
  });

  it("never leaves a sentinel in the payload for a field it resolved", () => {
    const out = applyResolvedOthers(
      { department_id: OTHER_VALUE, grade_id: OTHER_VALUE },
      { department_id: "d1", grade_id: "g1" },
    );
    expect(Object.values(out)).not.toContain(OTHER_VALUE);
  });
});
