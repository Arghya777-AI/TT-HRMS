/**
 * custom-edit.test.ts — pins the four conventions in /me/profile/custom and
 * /me/profile/documents that the DATABASE enforces and TypeScript cannot.
 *
 * Each of these breaks silently if edited: the code still compiles, the screen
 * still renders, and the write is refused at run time by a constraint written in
 * SQL. The harness test (`supabase/tests/harness/self-service-custom-fields-test.mjs`)
 * proves the policies; this pins the CLIENT half of the same four contracts.
 *
 *  1. `ck_ecfv__one_value` — EXACTLY ONE of the six value_* columns is non-null.
 *  2. `substring(field_name FROM 8)` in `apply_change_request` — the prefix is
 *     exactly seven characters, so `custom:` and nothing else.
 *  3. `documents__own_write` — `(storage.foldername(name))[2]` must be the
 *     employee id, i.e. the id is the SECOND folder segment, never the first.
 *  4. `trg_ecfv__validate` reads a single_select option as `o->>'value'`, so the
 *     value half of `[{value,label}]` is what may be sent.
 *
 * Pure functions only; no network, no React.
 */
import { describe, expect, it } from "vitest";
import {
  authorityOf,
  customFieldCodeOf,
  customFieldOptions,
  customFieldRequestFieldName,
  defApplies,
  draftColumns,
  draftKindFor,
  validateCustomFieldDraft,
  type CustomFieldDef,
} from "./api/custom-fields.api";
import { storagePathFor } from "./api/documents.api";
import type { ChangeRequest } from "./api/history.api";

function def(over: Partial<CustomFieldDef> = {}): CustomFieldDef {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    code: "UNIFORM_SIZE",
    label: "Uniform size",
    help_text: null,
    field_type: "single_select",
    options: [
      { value: "S", label: "S" },
      { value: "M", label: "M" },
    ],
    is_required: false,
    is_employee_editable: true,
    requires_approval: false,
    is_pii: false,
    section: "additional",
    sort_order: 10,
    applies_to_employment_types: null,
    applies_to_department_ids: null,
    validation_regex: null,
    min_value: null,
    max_value: null,
    ...over,
  };
}

describe("the definition's two booleans decide the write path", () => {
  it("maps the three authorities the way the seeded venue fields expect", () => {
    // UNIFORM_SIZE / SHOE_SIZE / TRANSPORT_ROUTE / FOOD_PREFERENCE / TWO_WHEELER
    expect(authorityOf(def({ is_employee_editable: true, requires_approval: false }))).toBe("self");
    // BLOOD_GROUP
    expect(authorityOf(def({ is_employee_editable: true, requires_approval: true }))).toBe(
      "maker_checker",
    );
    // LOCKER_NUMBER / EVENT_CERTIFIED — requires_approval must not rescue it.
    expect(authorityOf(def({ is_employee_editable: false, requires_approval: false }))).toBe(
      "admin_only",
    );
    expect(authorityOf(def({ is_employee_editable: false, requires_approval: true }))).toBe(
      "admin_only",
    );
  });

  it("treats a null targeting array as 'everyone', not as 'nobody'", () => {
    expect(defApplies(def(), "permanent", null)).toBe(true);
    expect(defApplies(def({ applies_to_employment_types: [] }), "permanent", null)).toBe(true);
    expect(defApplies(def({ applies_to_employment_types: ["contract"] }), "permanent", null)).toBe(
      false,
    );
  });
});

describe("ck_ecfv__one_value: exactly one typed column, always", () => {
  it("populates one column and explicitly nulls the other five", () => {
    const drafts = [
      { as: "text", value: "M" },
      { as: "number", value: 9 },
      { as: "date", value: "2026-07-01" },
      { as: "boolean", value: false },
    ] as const;
    for (const draft of drafts) {
      const columns = draftColumns(draft);
      expect(Object.keys(columns)).toHaveLength(6);
      const populated = Object.entries(columns).filter(([, v]) => v !== null);
      expect(populated).toHaveLength(1);
      expect(populated[0]?.[0]).toBe(`value_${draft.as}`);
    }
  });

  it("keeps `false` as a value, not as an absence", () => {
    // The trap: `boolean` false is falsy, and a truthiness test here would send
    // six nulls and trip the constraint.
    expect(draftColumns({ as: "boolean", value: false }).value_boolean).toBe(false);
    expect(draftColumns({ as: "number", value: 0 }).value_number).toBe(0);
  });

  it("routes single_select into value_text, the column the trigger checks", () => {
    expect(draftKindFor("single_select")).toBe("text");
    expect(draftKindFor("text")).toBe("text");
    // No control is offered for these, so no draft may exist for them.
    expect(draftKindFor("multi_select")).toBeNull();
    expect(draftKindFor("employee_ref")).toBeNull();
    expect(draftKindFor("file")).toBeNull();
  });
});

describe("field_name = 'custom:<CODE>' — the convention ecr_insert_guard demands", () => {
  it("round-trips a code through the exact seven-character prefix", () => {
    // apply_change_request recovers the code with substring(field_name FROM 8),
    // which is only correct while the prefix is 'custom:' — 7 characters.
    const fieldName = customFieldRequestFieldName("BLOOD_GROUP");
    expect(fieldName).toBe("custom:BLOOD_GROUP");
    expect(fieldName.slice(7)).toBe("BLOOD_GROUP");
  });

  it("recognises only custom-field requests on the values table", () => {
    const base = {
      id: "22222222-2222-4222-8222-222222222222",
      field_label: "Blood group",
      old_value: null,
      new_value: "O+",
      is_sensitive: true,
      status: "pending",
      requested_by: "33333333-3333-4333-8333-333333333333",
      requested_at: "2026-07-01T04:30:00.000Z",
      decided_at: null,
      decision_comment: null,
      applied_at: null,
      apply_error: null,
      effective_from: null,
    } satisfies Omit<ChangeRequest, "entity_table" | "field_name">;

    expect(
      customFieldCodeOf({
        ...base,
        entity_table: "employee_custom_field_values",
        field_name: "custom:BLOOD_GROUP",
      }),
    ).toBe("BLOOD_GROUP");
    // An `employees` request that happens to carry the prefix is not one of ours.
    expect(
      customFieldCodeOf({ ...base, entity_table: "employees", field_name: "custom:BLOOD_GROUP" }),
    ).toBeNull();
    // The guard would raise 22023 for this one, so it must never be matched.
    expect(
      customFieldCodeOf({
        ...base,
        entity_table: "employee_custom_field_values",
        field_name: "BLOOD_GROUP",
      }),
    ).toBeNull();
  });
});

describe("the pre-flight mirrors trg_ecfv__validate, never replaces it", () => {
  it("refuses a single_select value that is not an option's `value`", () => {
    expect(validateCustomFieldDraft(def(), { as: "text", value: "M" })).toBeNull();
    expect(validateCustomFieldDraft(def(), { as: "text", value: "XXXL" })).toEqual({
      code: "option",
    });
    // The LABEL is not sendable — the trigger compares o->>'value'.
    const labelled = def({ options: [{ value: "M", label: "Medium" }] });
    expect(validateCustomFieldDraft(labelled, { as: "text", value: "Medium" })).toEqual({
      code: "option",
    });
    expect(validateCustomFieldDraft(labelled, { as: "text", value: "M" })).toBeNull();
  });

  it("applies min_value/max_value only to numbers, inclusively", () => {
    const shoe = def({ field_type: "number", min_value: 4, max_value: 13, options: null });
    expect(validateCustomFieldDraft(shoe, { as: "number", value: 4 })).toBeNull();
    expect(validateCustomFieldDraft(shoe, { as: "number", value: 13 })).toBeNull();
    expect(validateCustomFieldDraft(shoe, { as: "number", value: 3.5 })).toEqual({
      code: "min",
      min: 4,
    });
    expect(validateCustomFieldDraft(shoe, { as: "number", value: 14 })).toEqual({
      code: "max",
      max: 13,
    });
  });

  it("applies validation_regex to `text` only, unanchored like Postgres `!~`", () => {
    const locker = def({ field_type: "text", validation_regex: "^L-[0-9]{2}$", options: null });
    expect(validateCustomFieldDraft(locker, { as: "text", value: "L-14" })).toBeNull();
    expect(validateCustomFieldDraft(locker, { as: "text", value: "14" })).toEqual({
      code: "pattern",
    });
  });

  it("never blocks a save on a pattern JavaScript cannot compile", () => {
    // An admin may author a regex Postgres accepts and RegExp rejects. The
    // trigger still checks it; the screen must not invent a refusal.
    const odd = def({ field_type: "text", validation_regex: "(?<incomplete", options: null });
    expect(validateCustomFieldDraft(odd, { as: "text", value: "anything" })).toBeNull();
  });

  it("demands a civil date, not a timestamp", () => {
    const cert = def({ field_type: "date", options: null });
    expect(validateCustomFieldDraft(cert, { as: "date", value: "2026-07-01" })).toBeNull();
    expect(
      validateCustomFieldDraft(cert, { as: "date", value: "2026-07-01T00:00:00.000Z" }),
    ).toEqual({ code: "date" });
  });
});

describe("options tolerate the two shapes the jsonb column can hold", () => {
  it("reads {value,label} pairs and falls back to a bare string's own value", () => {
    expect(customFieldOptions(def())).toEqual([
      { value: "S", label: "S" },
      { value: "M", label: "M" },
    ]);
    expect(customFieldOptions(def({ options: ["M", "L"] }))).toEqual([
      { value: "M", label: "M" },
      { value: "L", label: "L" },
    ]);
  });

  it("drops an entry with no usable value rather than offering [object Object]", () => {
    expect(
      customFieldOptions(def({ options: [{ label: "No value" }, null, 42, { value: "M" }] })),
    ).toEqual([{ value: "M", label: "M" }]);
    expect(customFieldOptions(def({ options: null }))).toEqual([]);
    expect(customFieldOptions(def({ options: { value: "M" } }))).toEqual([]);
  });
});

describe("documents__own_write: the employee id is the SECOND folder segment", () => {
  const EMPLOYEE = "44444444-4444-4444-8444-444444444444";

  it("puts the id at foldername[2], never at [1]", () => {
    const path = storagePathFor(EMPLOYEE, "EDU_CERT", "degree.pdf");
    // storage.foldername() drops the object name and returns the folders.
    const folders = path.split("/").slice(0, -1);
    expect(folders[1]).toBe(EMPLOYEE);
    expect(folders[0]).not.toBe(EMPLOYEE);
    expect(folders[2]).toBe("EDU_CERT");
  });

  it("keeps the extension and never reuses a name", () => {
    expect(storagePathFor(EMPLOYEE, "PAN", "card.PDF").endsWith(".pdf")).toBe(true);
    expect(storagePathFor(EMPLOYEE, "PAN", "noextension").endsWith(".bin")).toBe(true);
    expect(storagePathFor(EMPLOYEE, "PAN", "odd.name.tar.gz").endsWith(".gz")).toBe(true);
    // `upsert: false` turns a collision into an error, so uniqueness matters.
    expect(storagePathFor(EMPLOYEE, "PAN", "card.pdf")).not.toBe(
      storagePathFor(EMPLOYEE, "PAN", "card.pdf"),
    );
  });
});
