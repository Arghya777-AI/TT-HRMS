/**
 * select-count.test.ts — guards `selectCount`, the helper every Command Centre
 * tile counts with.
 *
 * What is actually at stake: a tile must be the cardinality of exactly the row
 * set its drill-through opens. That holds only if (a) the request really is a
 * `HEAD` with `count=exact` — never a page of rows whose `.length` depends on a
 * `limit` — and (b) the filters reach the builder unchanged. Both are asserted
 * here, together with the two failure shapes a tile branches on: a privilege
 * refusal must arrive as a no-permission `QueryError` (so the tile says "not
 * available to you"), and a null count on success must read as 0, never as
 * `undefined` leaking into `formatNumber`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  relation: "",
  selectArgs: [] as unknown[],
  calls: [] as { op: string; args: unknown[] }[],
  response: { count: null as number | null, error: null as unknown },
}));

vi.mock("@/lib/supabase", () => {
  const builder: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(state.response).then(resolve),
  };
  for (const op of [
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "like",
    "ilike",
    "is",
    "not",
    "in",
    "contains",
    "or",
    "order",
    "limit",
    "abortSignal",
  ]) {
    builder[op] = (...args: unknown[]) => {
      state.calls.push({ op, args });
      return builder;
    };
  }
  builder.select = (...args: unknown[]) => {
    state.selectArgs = args;
    return builder;
  };
  return {
    supabase: {
      from: (relation: string) => {
        state.relation = relation;
        return builder;
      },
    },
  };
});

const { QueryError, gt, inList, isTrue, selectCount } = await import("./query");

beforeEach(() => {
  state.relation = "";
  state.selectArgs = [];
  state.calls = [];
  state.response = { count: null, error: null };
});

describe("selectCount", () => {
  it("asks Postgres for an exact count and transfers no rows", async () => {
    state.response = { count: 14, error: null };
    const n = await selectCount("v_admin_employee");
    expect(n).toBe(14);
    expect(state.relation).toBe("v_admin_employee");
    expect(state.selectArgs).toEqual(["*", { count: "exact", head: true }]);
    // No limit: a limit would make the tile disagree with the list it opens.
    expect(state.calls.some((c) => c.op === "limit")).toBe(false);
  });

  it("applies the same filter vocabulary as selectMany, unchanged", async () => {
    state.response = { count: 2, error: null };
    await selectCount("v_exception_queue", [
      inList("severity", ["critical", "warning"]),
      isTrue("attended"),
      gt("expiring_within_30_days", 0),
    ]);
    expect(state.calls).toEqual([
      { op: "in", args: ["severity", ["critical", "warning"]] },
      { op: "is", args: ["attended", true] },
      { op: "gt", args: ["expiring_within_30_days", 0] },
    ]);
  });

  it("reads a successful null count as zero, not as undefined", async () => {
    state.response = { count: null, error: null };
    await expect(selectCount("v_enrolment_coverage")).resolves.toBe(0);
  });

  it("surfaces a privilege refusal as a no-permission QueryError", async () => {
    state.response = {
      count: null,
      error: { code: "42501", message: "permission denied", details: null, hint: null },
    };
    await expect(selectCount("v_kiosk_health")).rejects.toMatchObject({
      name: "QueryError",
      kind: "no_permission",
    });
    await expect(selectCount("v_kiosk_health")).rejects.toBeInstanceOf(QueryError);
  });

  it("surfaces a missing view as our own bug, so a tile does not retry forever", async () => {
    state.response = {
      count: null,
      error: { code: "42P01", message: "relation does not exist", details: null, hint: null },
    };
    await expect(selectCount("v_not_deployed")).rejects.toMatchObject({ kind: "schema" });
  });
});
