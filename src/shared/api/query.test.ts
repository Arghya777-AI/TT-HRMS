/**
 * query.test.ts — guards the shared read layer every feature api depends on.
 * Pure decoders and error mapping only; no network.
 */
import { describe, expect, it } from "vitest";
import {
  MutationError,
  QueryError,
  dbDate,
  dbInt,
  dbNumeric,
  dbPercent,
  eq,
  inList,
  headerSafeReason,
  isNoPermissionError,
  mutationUserMessage,
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

describe("an unclassified write failure keeps its evidence", () => {
  /*
    The defect: a policy would not circulate and the only thing on screen was
    "The change could not be saved. Try again, and report it if it keeps
    failing." The message, SQLSTATE, details and hint were all on the error and
    all discarded, so the failure could not be diagnosed from the outside — and
    "report it" asked somebody to report a sentence containing no facts.
  */
  it("shows the server's sentence and the code", () => {
    const e = new MutationError("publish_policy", "unknown", "Only HR can publish a policy.", {
      code: "42501",
    });
    expect(e.userMessage).toContain("Only HR can publish a policy.");
    expect(e.userMessage).toContain("42501");
  });

  it("falls back to the code alone when the message is not a sentence", () => {
    const e = new MutationError("publish_policy", "unknown", 'violates check constraint "ck_x"', {
      code: "23514",
    });
    // The constraint identifier is still suppressed — it is not for a person.
    expect(e.userMessage).not.toContain("ck_x");
    expect(e.userMessage).toContain("23514");
  });

  it("still says something when there is neither", () => {
    const e = new MutationError("publish_policy", "unknown", "");
    expect(e.userMessage.length).toBeGreaterThan(10);
  });

  it("does not change a classified refusal", () => {
    const e = new MutationError("leave_requests", "duplicate", "whatever the server said");
    expect(e.userMessage).not.toContain("whatever the server said");
  });
});

describe("a Storage failure keeps its words too", () => {
  /*
    Storage is not Postgres and supplies no SQLSTATE, so its refusals landed in
    the one branch that returned a bare "Try again" — while carrying the sentence
    that named the fault ("Bucket not found", an RLS refusal on storage.objects).
  */
  it("appends the bucket's own message when there is no code", () => {
    const e = new QueryError("storage/documents", "unknown", "Bucket not found");
    expect(mutationUserMessage(e)).toContain("Bucket not found");
  });

  it("still suppresses a constraint identifier", () => {
    const e = new QueryError("documents", "unknown", 'violates check constraint "ck_x"');
    expect(mutationUserMessage(e)).not.toContain("ck_x");
  });
});

describe("a plain JavaScript throw is not swallowed", () => {
  /*
    THE HOLE THAT HID A REAL BUG THROUGH THREE ROUNDS OF FIXING IT.

    Everything else in mutationUserMessage handles a STRUCTURED failure. A plain
    Error thrown inside a mutation function — hashing a file, reading
    crypto.subtle, building a path — never passes through fromThrownMutation and
    landed on the final bare sentence with its message discarded. Four failed
    uploads were diagnosed as "unknown" because of this one line.
  */
  it("shows the message of a plain Error", () => {
    const said = mutationUserMessage(new Error("crypto.subtle is undefined"));
    expect(said).toContain("crypto.subtle is undefined");
  });

  it("shows the message of a TypeError", () => {
    const said = mutationUserMessage(new TypeError("Cannot read properties of undefined"));
    expect(said).toContain("Cannot read properties of undefined");
  });

  it("falls back cleanly when there is no message at all", () => {
    const said = mutationUserMessage(new Error(""));
    expect(said.length).toBeGreaterThan(10);
    expect(said).not.toContain("undefined");
  });

  it("handles a thrown string", () => {
    expect(mutationUserMessage("something went sideways")).toContain("something went sideways");
  });

  it("still ends the sentence properly", () => {
    expect(mutationUserMessage(new Error("no full stop here"))).toMatch(/\.$/);
  });
});


describe("a reason always survives the HTTP header", () => {
  /*
    Publishing a policy failed with "Failed to execute 'set' on 'Headers':
    String contains non ISO-8859-1 code point" — the reason carried curly quotes.
    `setHeader` throws BEFORE the request is built, so nothing reached the
    network and it looked for days like a server refusal.
  */
  it("folds the curly quotes that caused it", () => {
    const said = headerSafeReason(
      "Publishing the policy \u201Cfor testing\u201D for acknowledgement.",
    );
    expect(said).toBe('Publishing the policy "for testing" for acknowledgement.');
  });

  it("folds dashes, ellipsis and the apostrophe a phone keyboard produces", () => {
    expect(headerSafeReason("Correcting Vinod\u2019s punch \u2014 late\u2026")).toBe(
      "Correcting Vinod's punch - late...",
    );
  });

  it("keeps a rupee sign RECOVERABLE rather than dropping it", () => {
    // The audit log is evidence: an encoded character can be decoded later, a
    // deleted one cannot, and nobody would know it had gone.
    const said = headerSafeReason("Claim of \u20B91,200 approved.");
    expect(said).toContain("%E2%82%B9");
    expect(decodeURIComponent(said)).toContain("\u20B9");
  });

  it("leaves plain Latin-1 completely untouched", () => {
    const plain = "Correcting the punch for 12-Aug; the gate reader was offline.";
    expect(headerSafeReason(plain)).toBe(plain);
  });

  it("returns something a Headers value accepts, for every input", () => {
    const inputs = [
      "\u0928\u092E\u0938\u094D\u0924\u0947",
      "\uD83D\uDE00 emoji",
      "caf\u00E9",
      "\u201Cmixed\u201D \u20B9 \u2014 \u0915",
    ];
    for (const input of inputs) {
      const out = headerSafeReason(input);
      for (const ch of out) {
        expect(ch.codePointAt(0)).toBeLessThanOrEqual(0xff);
      }
    }
  });
});
