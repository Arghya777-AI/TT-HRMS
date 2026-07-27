/**
 * write-audited.test.ts — guards the audited write layer every admin screen
 * depends on. Pure: the client-side refusals happen BEFORE any request is built,
 * so none of these tests touch the network.
 *
 * The server side of the contract was verified against the live project
 * (xfoeudhwxlbkkwetncjb) with the admin persona: a PATCH on `employees` with no
 * `x-reason` header and with a 9-character reason both returned SQLSTATE 22023
 * ('reason_required: UPDATE on public.employees needs app.reason of at least 10
 * characters'), and the same PATCH with a real sentence returned the row. What is
 * asserted here is that the browser never has to hear that from the server.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MIN_REASON_LENGTH,
  MutationError,
  SENSITIVE_REASON_LENGTH,
  assertReason,
  eq,
  insertRow,
  isMutationError,
  isMutationErrorOfKind,
  isReasonValid,
  mutationUserMessage,
  softDelete,
  updateRow,
  upsertRow,
} from "./query";

const schema = z.object({ id: z.string() });

describe("assertReason", () => {
  it("accepts a real sentence and returns it trimmed", () => {
    expect(assertReason("  corrected after the signed revision letter  ")).toBe(
      "corrected after the signed revision letter",
    );
  });

  it("refuses a reason shorter than the database floor", () => {
    expect(() => assertReason("too short")).toThrow(MutationError);
    expect(isReasonValid("too short")).toBe(false);
    expect(isReasonValid("exactly ten")).toBe(true);
    expect(MIN_REASON_LENGTH).toBe(10);
  });

  it("counts length AFTER trimming, so whitespace cannot pad a reason", () => {
    expect(isReasonValid("abc       ")).toBe(false);
  });

  it("refuses null and undefined rather than sending an empty header", () => {
    expect(() => assertReason(null)).toThrow(MutationError);
    expect(() => assertReason(undefined)).toThrow(MutationError);
  });

  it("honours a raised floor for D-21 actions", () => {
    expect(isReasonValid("ten chars.", SENSITIVE_REASON_LENGTH)).toBe(false);
    expect(() => assertReason("ten chars.", { minLength: SENSITIVE_REASON_LENGTH })).toThrow();
    expect(assertReason("fifteen chars ok", { minLength: SENSITIVE_REASON_LENGTH })).toBe(
      "fifteen chars ok",
    );
  });

  it("reports the kind a form branches on, with the floor attached", () => {
    try {
      assertReason("nope", { table: "employees", minLength: 15 });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isMutationError(e)).toBe(true);
      expect(isMutationErrorOfKind(e, "reason_required")).toBe(true);
      const err = e as MutationError;
      expect(err.minReasonLength).toBe(15);
      expect(err.table).toBe("employees");
      // The sentence the dialog shows names the number, not a SQLSTATE.
      expect(err.userMessage).toContain("15");
      expect(err.userMessage).not.toMatch(/22023|SQLSTATE/);
    }
  });
});

describe("MutationError mapping", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["22023", "reason_required"],
    ["23505", "duplicate"],
    ["23514", "check_violation"],
    ["42501", "permission_denied"],
    ["23503", "fk_violation"],
  ];

  it("maps every SQLSTATE the audited tables can raise", () => {
    for (const [code, kind] of cases) {
      const e = new MutationError("employees", kind as never, `raw ${code}`, { code });
      expect(e.mutationKind).toBe(kind);
      expect(e.errorRef).toBe(`employees/${code}`);
    }
  });

  it("renders no permission failure as the no-permission state", () => {
    const e = new MutationError("employees", "permission_denied", "denied", { code: "42501" });
    expect(e.isNoPermission).toBe(true);
    expect(e.isRetryable).toBe(false);
    expect(e.userMessage).toMatch(/permission/i);
  });

  it("gives every kind a plain-English sentence with no SQL in it", () => {
    const kinds = [
      "duplicate",
      "check_violation",
      "fk_violation",
      "locked",
      "not_found",
      "invalid_request",
      "offline",
      "schema",
      "parse",
      "unknown",
    ] as const;
    for (const kind of kinds) {
      const e = new MutationError("t", kind, "raw postgres text");
      expect(e.userMessage.length).toBeGreaterThan(10);
      expect(e.userMessage).not.toMatch(/SQLSTATE|constraint|pg_|null value/i);
    }
  });

  it("appends a guard's own sentence on a rule rejection, but not internal SQL", () => {
    const human = new MutationError(
      "leave_requests",
      "check_violation",
      "Leave type CL does not allow half days",
      { code: "23514" },
    );
    expect(human.userMessage).toContain("Leave type CL does not allow half days.");

    const internal = new MutationError(
      "employees",
      "check_violation",
      'new row for relation "employees" violates check constraint "ck_emp_mobile"',
      { code: "23514" },
    );
    expect(internal.userMessage).not.toContain("ck_emp_mobile");
  });

  it("classifies which failures the user can fix by editing the form", () => {
    expect(new MutationError("t", "duplicate", "x").isUserFixable).toBe(true);
    expect(new MutationError("t", "offline", "x").isUserFixable).toBe(false);
  });

  it("always has a sentence for a form's error slot, whatever was thrown", () => {
    expect(mutationUserMessage(new Error("boom"))).toBeTruthy();
    expect(mutationUserMessage("boom")).toBeTruthy();
    expect(mutationUserMessage(new MutationError("t", "duplicate", "x"))).toMatch(/already used/i);
  });
});

describe("the helpers refuse before they reach the network", () => {
  it("refuses an update with no filters — that would rewrite every row", async () => {
    await expect(
      updateRow("employees", [], { about: "x" }, schema, { reason: "a proper reason here" }),
    ).rejects.toMatchObject({ mutationKind: "invalid_request" });
  });

  it("refuses an update with no changed fields", async () => {
    await expect(
      updateRow("employees", [eq("id", "1")], {}, schema, { reason: "a proper reason here" }),
    ).rejects.toMatchObject({ mutationKind: "invalid_request" });
  });

  it("refuses an insert with no columns", async () => {
    await expect(
      insertRow("employees", {}, schema, { reason: "a proper reason here" }),
    ).rejects.toMatchObject({ mutationKind: "invalid_request" });
  });

  it("refuses every helper when the reason is too short", async () => {
    const short = { reason: "nope" };
    await expect(insertRow("employees", { a: 1 }, schema, short)).rejects.toMatchObject({
      mutationKind: "reason_required",
    });
    await expect(
      updateRow("employees", [eq("id", "1")], { a: 1 }, schema, short),
    ).rejects.toMatchObject({ mutationKind: "reason_required" });
    await expect(
      upsertRow("settings", { key: "k" }, schema, { ...short, onConflict: "key" }),
    ).rejects.toMatchObject({ mutationKind: "reason_required" });
    await expect(softDelete("employees", "1", short)).rejects.toMatchObject({
      mutationKind: "reason_required",
    });
  });
});
