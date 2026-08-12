/**
 * The refusal sentences, tested against the strings the DATABASE actually raises.
 *
 * Every input below is copied from a `RAISE EXCEPTION` in `supabase/migrations`,
 * not invented — a rewrite tested against a paraphrase of the server proves
 * nothing, because the real message is the one that has to match.
 */
import { describe, expect, it } from "vitest";
import {
  humaniseRefusal,
  isUnexplainedConstraint,
  REFUSAL_REWRITE_COUNT,
} from "./humaniseRefusal";

describe("humaniseRefusal", () => {
  it("has a table to consult", () => {
    // A silent zero would make every assertion below pass vacuously.
    expect(REFUSAL_REWRITE_COUNT).toBeGreaterThan(5);
  });

  it("stops naming a column for the handover rule", () => {
    const raw = "handover_to_employee_id is mandatory for operational departments";
    const said = humaniseRefusal(raw);
    expect(said).not.toContain("handover_to_employee_id");
    expect(said).toContain("cover for you");
  });

  it("keeps the server's own number for the address rule", () => {
    const said = humaniseRefusal("address_during_leave is required for leave longer than 7 days");
    expect(said).toContain("7");
    expect(said).not.toContain("address_during_leave");
  });

  it("quotes the clashing request back", () => {
    const said = humaniseRefusal(
      "leave request overlaps existing request LV-2026-000004 for the same employee",
    );
    expect(said).toContain("LV-2026-000004");
    expect(said.toLowerCase()).toContain("already have leave");
  });

  it("puts the balance figures in the order a person needs them", () => {
    const said = humaniseRefusal(
      "insufficient Earned Leave balance: need 3.00 paid day(s), 1.50 available — reduce days or mark the overflow as unpaid (LWP)",
    );
    expect(said).toContain("1.50");
    expect(said).toContain("3.00");
    expect(said).toContain("Earned Leave");
  });

  it("explains a zero-day range rather than restating it", () => {
    /*
      The refusal people hit by picking a weekend: the range is real, the count is
      zero, and "requires at least 0.50" does not say why.
    */
    const said = humaniseRefusal(
      "request is 0.000 day(s); leave type EL requires at least 0.50",
    );
    expect(said).toContain("0.50");
    expect(said.toLowerCase()).toContain("holidays");
  });

  it("keeps the monthly ceiling's own sentence, which is already plain", () => {
    // 041600 wrote this one for a person, so it must pass through untouched.
    const raw =
      "Earned Leave allows at most 3.00 day(s) in a month. You already have 1 day(s) in September 2026 and this request adds 4.000.";
    expect(humaniseRefusal(raw)).toBe(raw);
  });

  it("passes an unrecognised message through unchanged", () => {
    /*
      The whole point: a rule added tomorrow shows ITS OWN words. Swallowing it
      into something generic is the behaviour this file exists to end, and
      repeating that here would be worse than not having the file.
    */
    const raw = "some rule nobody has written a rewrite for yet";
    expect(humaniseRefusal(raw)).toBe(raw);
  });

  it("names the rule behind a duplicate resignation", () => {
    /*
      A partial UNIQUE index, not a CHECK: Postgres reports the index name. The
      rule it enforces is "one open resignation at a time", and the useful half
      of the answer is what to do — withdraw the first.
    */
    const raw =
      'duplicate key value violates unique constraint "uq_resign__one_open"';
    const said = humaniseRefusal(raw);
    expect(said).not.toContain("uq_resign__");
    expect(said.toLowerCase()).toContain("withdraw");
  });

  it("survives an empty message", () => {
    expect(humaniseRefusal("   ")).toBe("");
  });

  it("names the rule behind a bare CHECK", () => {
    /*
      The refusal from the screenshot: a resignation dated inside the notice
      period. Postgres says only which constraint failed, and the employee was
      shown "(code 23514)".
    */
    const raw =
      'new row for relation "resignations" violates check constraint "ck_resign__notice_or_waiver"';
    const said = humaniseRefusal(raw);
    expect(said).not.toContain("ck_resign__");
    expect(said.toLowerCase()).toContain("notice period");
  });

  it("leaves an unknown constraint alone rather than guessing", () => {
    const raw = 'new row for relation "x" violates check constraint "ck_something_new"';
    expect(humaniseRefusal(raw)).toBe(raw);
    expect(isUnexplainedConstraint(raw)).toBe(true);
  });

  it("knows when a constraint IS explained", () => {
    const raw =
      'new row for relation "asset_requests" violates check constraint "ck_asr__quantity"';
    expect(isUnexplainedConstraint(raw)).toBe(false);
  });
});
