/**
 * self-edit.test.ts — pins the two things about employee self-service editing
 * that a comment cannot enforce.
 *
 * 1. THE CATALOGUE AGREES WITH THE SERVER. Every field this build offers an
 *    editor for must be inside `public.employee_changeable_fields()`, and every
 *    field it marks as an immediate save must be inside the column-level
 *    `GRANT UPDATE (about, photo_path, cover_photo_path, food_preference)`. Get
 *    either wrong and the employee meets a 42501 instead of a saved record.
 *
 * 2. THE APPROVAL ROW WINS. `employee_change_requests.status` is frozen at
 *    'pending' from a browser (no UPDATE grant), so a withdrawn or rejected
 *    request still reads 'pending' on the detail row. Driving the field note off
 *    that row is what would leave "awaiting HR approval" on screen forever.
 *
 * Pure functions only; no network, no React.
 */
import { describe, expect, it } from "vitest";
import {
  ABOUT_MAX_LENGTH,
  EMPLOYEE_CHANGEABLE_FIELDS,
  SELF_DIRECT_FIELDS,
  asDirectField,
  displayFieldValue,
  fieldOptions,
  isDirectField,
  validateFieldInput,
  type EditableField,
} from "./self-edit";
import { buildFieldStates } from "./hooks/useSelfEdit";
import type { ChangeRequest } from "./api/history.api";
import type { FieldChangeApproval } from "./api/self-edit.api";

/** Every column the pages render an editor for. */
const RENDERED: readonly EditableField[] = [
  "title",
  "first_name",
  "middle_name",
  "last_name",
  "display_name",
  "preferred_name",
  "name_in_local_script",
  "personal_email",
  "mobile",
  "date_of_birth",
  "gender",
  "marital_status",
  "marriage_anniversary",
  "father_or_spouse_name",
  "father_or_spouse_relation",
  "mother_name",
  "nationality",
  "religion",
  "category",
  "is_differently_abled",
  "disability_type",
  "mode_of_transport",
  "uniform_size",
  "food_preference",
  "blood_group",
  "about",
];

describe("the catalogue agrees with the server whitelist", () => {
  it("mirrors employee_changeable_fields() with all 29 names", () => {
    expect(EMPLOYEE_CHANGEABLE_FIELDS).toHaveLength(29);
    // The three the function carries that this build deliberately does not
    // render: two storage paths and the shadow DOB (DR-51).
    expect(EMPLOYEE_CHANGEABLE_FIELDS).toContain("photo_path");
    expect(EMPLOYEE_CHANGEABLE_FIELDS).toContain("cover_photo_path");
    expect(EMPLOYEE_CHANGEABLE_FIELDS).toContain("date_of_birth_actual");
  });

  it("offers an editor only for whitelisted columns", () => {
    for (const column of RENDERED) {
      expect(EMPLOYEE_CHANGEABLE_FIELDS).toContain(column);
    }
  });

  it("marks as an immediate save only the columns carrying a GRANT UPDATE", () => {
    for (const column of RENDERED) {
      if (isDirectField(column)) {
        expect(SELF_DIRECT_FIELDS).toContain(column);
      }
    }
    // The four that previously claimed "You can edit" without a column grant.
    for (const column of [
      "blood_group",
      "marital_status",
      "marriage_anniversary",
      "preferred_name",
    ] as const) {
      expect(isDirectField(column)).toBe(false);
    }
  });

  it("has a typed direct writer for every field it marks as an immediate save", () => {
    for (const column of RENDERED) {
      if (isDirectField(column)) expect(asDirectField(column)).toBe(column);
      else expect(asDirectField(column)).toBeNull();
    }
  });
});

describe("validation mirrors the employees CHECK constraints", () => {
  it("enforces ck_employees__mobile_in", () => {
    expect(validateFieldInput("mobile", "9876543210", null).ok).toBe(true);
    expect(validateFieldInput("mobile", "5876543210", null).ok).toBe(false);
    expect(validateFieldInput("mobile", "987654321", null).ok).toBe(false);
    expect(validateFieldInput("mobile", "+919876543210", null).ok).toBe(false);
  });

  it("enforces ck_employees__personal_email", () => {
    expect(validateFieldInput("personal_email", "asha@example.com", null).ok).toBe(true);
    expect(validateFieldInput("personal_email", "asha@example", null).ok).toBe(false);
    expect(validateFieldInput("personal_email", "asha example@x.com", null).ok).toBe(false);
  });

  it("enforces ck_employees__category", () => {
    expect(validateFieldInput("category", "OBC", null).ok).toBe(true);
    expect(validateFieldInput("category", "obc", null).ok).toBe(false);
    expect(validateFieldInput("category", "OTHER", null).ok).toBe(false);
  });

  it("enforces ck_employees__food_preference", () => {
    expect(validateFieldInput("food_preference", "jain", null).ok).toBe(true);
    expect(validateFieldInput("food_preference", "vegan", null).ok).toBe(false);
  });

  it("enforces ck_employees__relation", () => {
    expect(validateFieldInput("father_or_spouse_relation", "spouse", null).ok).toBe(true);
    expect(validateFieldInput("father_or_spouse_relation", "mother", null).ok).toBe(false);
  });

  it("refuses a date in the future and a sentinel year", () => {
    expect(validateFieldInput("date_of_birth", "2099-01-01", null).ok).toBe(false);
    expect(validateFieldInput("date_of_birth", "1899-01-01", null).ok).toBe(false);
    expect(validateFieldInput("date_of_birth", "1990-06-15", null).ok).toBe(true);
  });

  it("refuses an empty value, because new_value is NOT NULL", () => {
    const outcome = validateFieldInput("religion", "   ", "Hindu");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).not.toBe("");
  });

  it("refuses a value identical to the record's, rather than queueing a no-op", () => {
    expect(validateFieldInput("nationality", "Indian", "Indian").ok).toBe(false);
    expect(validateFieldInput("is_differently_abled", "false", false).ok).toBe(false);
    expect(validateFieldInput("is_differently_abled", "true", false).ok).toBe(true);
  });

  it("caps About at the length the profile card is designed for", () => {
    expect(validateFieldInput("about", "x".repeat(ABOUT_MAX_LENGTH), null).ok).toBe(true);
    expect(validateFieldInput("about", "x".repeat(ABOUT_MAX_LENGTH + 1), null).ok).toBe(false);
  });

  it("returns a boolean, not the string 'true', for a boolean column", () => {
    const outcome = validateFieldInput("is_differently_abled", "true", false);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value).toBe(true);
  });
});

describe("values render as words, never as internal codes", () => {
  it("labels enum and CHECK values", () => {
    expect(displayFieldValue("food_preference", "non_veg")).toBe("Non-vegetarian");
    expect(displayFieldValue("is_differently_abled", false)).not.toBe("false");
    expect(displayFieldValue("marital_status", "married")).not.toBe("married");
  });

  it("renders an unset value as the universal em dash, never as a blank", () => {
    expect(displayFieldValue("religion", null)).toBe("—");
  });

  it("never offers 'unknown' as a blood group an employee can choose", () => {
    expect(fieldOptions("blood_group").map((o) => o.value)).not.toContain("unknown");
  });
});

// -----------------------------------------------------------------------------
// The approval row wins
// -----------------------------------------------------------------------------

function request(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: "cr-1",
    entity_table: "employees",
    field_name: "mobile",
    field_label: "Mobile number",
    old_value: "9876543210",
    new_value: "9812345678",
    is_sensitive: false,
    status: "pending",
    requested_by: "profile-1",
    requested_at: "2026-07-20T04:30:00Z",
    decided_at: null,
    decision_comment: null,
    applied_at: null,
    apply_error: null,
    effective_from: null,
    ...overrides,
  };
}

function approval(overrides: Partial<FieldChangeApproval> = {}): FieldChangeApproval {
  return {
    id: "ar-1",
    request_number: "PROFILE_CHANGE-000007",
    detail_id: "cr-1",
    status: "pending",
    submitted_at: "2026-07-20T04:30:00Z",
    sla_due_at: "2026-07-23T04:30:00Z",
    decided_at: null,
    decision_comment: null,
    cancelled_at: null,
    cancellation_reason: null,
    ...overrides,
  };
}

describe("buildFieldStates", () => {
  it("reports an open request with its server-minted reference", () => {
    const states = buildFieldStates([request()], [approval()]);
    const state = states.get("mobile");
    expect(state?.stage).toBe("open");
    expect(state?.reference).toBe("PROFILE_CHANGE-000007");
    expect(state?.canWithdraw).toBe(true);
  });

  it("reads a withdrawn approval as withdrawn even though the detail row still says pending", () => {
    const states = buildFieldStates(
      [request({ status: "pending" })],
      [approval({ status: "withdrawn", decided_at: "2026-07-21T05:00:00Z" })],
    );
    expect(states.get("mobile")?.stage).toBe("withdrawn");
    expect(states.get("mobile")?.canWithdraw).toBe(false);
  });

  it("reads a rejection off the approval row, comment included", () => {
    const states = buildFieldStates(
      [request()],
      [approval({ status: "rejected", decision_comment: "Aadhaar shows a different number." })],
    );
    expect(states.get("mobile")?.stage).toBe("rejected");
    expect(states.get("mobile")?.comment).toBe("Aadhaar shows a different number.");
  });

  it("says approved-but-not-applied, because the engine never writes the detail row", () => {
    const states = buildFieldStates([request()], [approval({ status: "approved" })]);
    expect(states.get("mobile")?.stage).toBe("approved_not_applied");
  });

  it("surfaces a failed apply rather than letting it disappear", () => {
    const states = buildFieldStates(
      [request({ status: "failed", apply_error: "invalid input syntax" })],
      [approval({ status: "approved" })],
    );
    expect(states.get("mobile")?.stage).toBe("failed");
    expect(states.get("mobile")?.applyError).toBe("invalid input syntax");
  });

  it("says nothing at all once the change has landed on the record", () => {
    const states = buildFieldStates(
      [request({ status: "applied", applied_at: "2026-07-21T05:00:00Z" })],
      [approval({ status: "approved" })],
    );
    expect(states.has("mobile")).toBe(false);
  });

  it("falls back to the detail row when no approval was routed", () => {
    const states = buildFieldStates([request()], []);
    const state = states.get("mobile");
    expect(state?.stage).toBe("open");
    expect(state?.reference).toBeNull();
    // Nothing to recall: there is no approval to act on.
    expect(state?.canWithdraw).toBe(false);
  });

  it("keeps only the newest request per field and ignores other entity tables", () => {
    const states = buildFieldStates(
      [
        request({ id: "cr-new", new_value: "9800000000", requested_at: "2026-07-22T04:30:00Z" }),
        request({ id: "cr-old", new_value: "9700000000", requested_at: "2026-07-01T04:30:00Z" }),
        request({ id: "cr-stat", entity_table: "employee_statutory", field_name: "tax_regime" }),
      ],
      [approval({ detail_id: "cr-new" })],
    );
    expect(states.size).toBe(1);
    expect(states.get("mobile")?.changeRequestId).toBe("cr-new");
  });
});
