/**
 * The shapes `v_approval_inbox` actually returns, asserted against the schemas
 * that parse it.
 *
 * THE BUG THIS EXISTS FOR: /admin/tasks showed
 *
 *     Row from v_approval_inbox does not match its schema:
 *     summary: Expected string, received object
 *
 * `approval_requests.summary` is `jsonb NOT NULL DEFAULT '{}'` (workflow.sql:263)
 * and the view selects it unchanged (`ar.summary`, views_governance.sql:137).
 * `adminTaskSchema` declared it `z.string().nullable()`, so EVERY row failed and
 * the whole screen errored — not one bad cell, the entire administrator queue.
 *
 * It is the third of its kind: `teamDaySchema.manual_override_status` was
 * declared a string against a `boolean NOT NULL` column and crashed Team
 * Attendance, and two files reading THIS view disagreed about this column while
 * one of them was right the whole time.
 *
 * A row parsed here is written to match the view's own SELECT list, so the test
 * fails if either the view or the schema moves without the other.
 */
import { describe, expect, it } from "vitest";
import { adminTaskSchema } from "./command.api";

/**
 * One row as PostgREST serialises it. `summary` is an OBJECT because the column
 * is jsonb — that is the whole point of the test.
 */
const ROW = {
  approval_request_id: "6f1a8f4e-1f6e-4a6b-9a2e-0d2a4f0c1b23",
  request_number: "ASSET_REQUEST-000024",
  request_type_code: "ASSET_REQUEST",
  request_type_name: "Asset Request",
  title: "Asset · Laptops",
  summary: { reason: "for testing purpose", quantity: 1 },
  priority: "normal",
  status: "pending",
  current_level: 2,
  total_levels: 2,
  subject_employee_id: "0f7d1b2c-3e4f-4a5b-8c9d-1e2f3a4b5c6d",
  subject_employee_code: "TT0018",
  subject_display_name: "Testing Kumar",
  subject_department_name: "Management",
  submitted_at: "2026-08-11T12:09:00.000Z",
  sla_due_at: "2026-08-13T12:09:00.000Z",
  sla_remaining_hours: 12.5,
  is_overdue: false,
  age_hours: 36,
  escalated_at: null,
};

describe("adminTaskSchema against what the view returns", () => {
  it("accepts a summary that is a jsonb object", () => {
    const parsed = adminTaskSchema.safeParse(ROW);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it("accepts the empty object the column defaults to", () => {
    // `DEFAULT '{}'` means most rows look exactly like this.
    expect(adminTaskSchema.safeParse({ ...ROW, summary: {} }).success).toBe(true);
  });

  it("accepts a null summary, since the view may outer-join", () => {
    expect(adminTaskSchema.safeParse({ ...ROW, summary: null }).success).toBe(true);
  });

  it("still REFUSES a summary that is a bare string", () => {
    /*
      Not pedantry. If a string were accepted here the schema would once again be
      describing something the database cannot produce, and the next reader would
      write `summary.slice(...)` against an object.
    */
    expect(adminTaskSchema.safeParse({ ...ROW, summary: "for testing purpose" }).success).toBe(
      false,
    );
  });

  it("reads the numeric SLA fields whichever way PostgREST sends them", () => {
    // `numeric` may arrive as a string; dbNumeric accepts both by design.
    expect(adminTaskSchema.safeParse({ ...ROW, sla_remaining_hours: "12.5" }).success).toBe(true);
  });
});
