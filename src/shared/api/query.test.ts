/**
 * query.test.ts — guards the shared read layer every feature api depends on.
 * Pure decoders and error mapping only; no network.
 */
import { describe, expect, it } from "vitest";
import {
  QueryError,
  dbDate,
  dbInt,
  dbNumeric,
  dbPercent,
  eq,
  inList,
  isNoPermissionError,
  isNull,
  paginate,
  shouldRetryQuery,
} from "./query";
import { z } from "zod";

describe("db wire decoders", () => {
  it("accepts numeric as a JSON number or a string, landing on number", () => {
    expect(dbNumeric.parse(7.5)).toBe(7.5);
    expect(dbNumeric.parse("7.50")).toBe(7.5);
    expect(dbNumeric.parse("-0.5")).toBe(-0.5);
  });

  it("rejects a non-numeric string rather than yielding NaN", () => {
    expect(dbNumeric.safeParse("7h 50m").success).toBe(false);
    expect(dbInt.safeParse("7.5").success).toBe(false);
  });

  it("requires a bare YYYY-MM-DD for a Postgres date", () => {
    expect(dbDate.parse("2026-07-25")).toBe("2026-07-25");
    // A timestamp is NOT a business date — that conflation is the reference
    // product's attendance bug.
    expect(dbDate.safeParse("2026-07-25T00:00:00Z").success).toBe(false);
  });

  it("refuses a percentage outside [0,100] instead of clamping it", () => {
    expect(dbPercent.parse(100)).toBe(100);
    expect(dbPercent.parse("0").valueOf()).toBe(0);
    // The 1,700.00% defect: the view must clamp, so a breach is a real failure.
    expect(dbPercent.safeParse(1700).success).toBe(false);
    expect(dbPercent.safeParse(-1).success).toBe(false);
  });
});

describe("QueryError", () => {
  it("classifies a privilege failure as no-permission and does not retry it", () => {
    const e = new QueryError("v_payslip_detail", "no_permission", "denied", { code: "42501" });
    expect(e.isNoPermission).toBe(true);
    expect(e.isRetryable).toBe(false);
    expect(e.errorRef).toBe("v_payslip_detail/42501");
    expect(shouldRetryQuery(0, e)).toBe(false);
  });

  it("treats an absent row that must exist as a permission problem", () => {
    const e = new QueryError("v_my_employee", "not_found", "no row");
    expect(isNoPermissionError(e)).toBe(true);
    expect(shouldRetryQuery(0, e)).toBe(false);
  });

  it("flags a missing view as our bug, not a retryable blip", () => {
    const e = new QueryError("v_nope", "schema", "undefined table", { code: "42P01" });
    expect(e.isOurBug).toBe(true);
    expect(shouldRetryQuery(0, e)).toBe(false);
  });

  it("retries offline twice, then gives up", () => {
    const e = new QueryError("v_x", "offline", "network down");
    expect(shouldRetryQuery(0, e)).toBe(true);
    expect(shouldRetryQuery(1, e)).toBe(true);
    expect(shouldRetryQuery(2, e)).toBe(false);
  });
});

describe("filters", () => {
  it("builds a closed vocabulary of filter descriptors", () => {
    expect(eq("employee_id", "abc")).toEqual({ op: "eq", column: "employee_id", value: "abc" });
    expect(isNull("deleted_at")).toEqual({ op: "is", column: "deleted_at", value: null });
    expect(inList("status", ["pending", "approved"])).toEqual({
      op: "in",
      column: "status",
      values: ["pending", "approved"],
    });
  });
});

describe("paginate", () => {
  it("refuses a cursor value that would break out of the PostgREST predicate", async () => {
    // A comma or paren in an `or=` value silently changes the predicate's
    // meaning, so it is rejected rather than escaped-and-hoped.
    await expect(
      paginate("v_leave_ledger_statement", z.object({ id: z.string() }), {
        orderBy: "effective_date",
        tiebreak: "id",
        pageSize: 10,
        cursor: { key: "2026-07-25", tiebreak: "a,b" },
      }),
    ).rejects.toBeInstanceOf(QueryError);
  });
});
