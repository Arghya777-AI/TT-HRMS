/**
 * certification.test.ts — the one rule this screen enforces before the server does.
 *
 * `uq_certclaim__one_open` is a PARTIAL UNIQUE INDEX over
 * `(employee_id, lower(btrim(certification_name)))` restricted to the open
 * statuses. Two of its three properties are easy to get wrong in a browser and
 * both produce the same symptom — a unique violation arriving as a raw Postgres
 * error after the round trip, at the moment somebody presses Send:
 *
 *   1. It is CASE- AND SPACE-INSENSITIVE. "  fssai " collides with "FSSAI".
 *   2. It only applies to OPEN claims. Asking again after a rejection is a normal
 *      thing to do, and a form that refused it would be wrong in the direction
 *      that costs somebody a certification.
 *
 * `hasOpenClaimFor` is that index restated in TypeScript, so the refusal arrives
 * in the employee's own words before the request is sent. These tests are what
 * keep the two definitions the same.
 */
import { describe, expect, it } from "vitest";
import {
  CERTIFICATION_OPEN_STATUSES,
  hasOpenClaimFor,
  type CertificationClaim,
} from "./certification.api";

/** Only the two fields the predicate reads; the rest would be noise. */
function claim(name: string, status: string): CertificationClaim {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    catalogue_id: null,
    certification_name: name,
    issuing_body: null,
    course_fee_paise: 100_000,
    amount_requested_paise: 100_000,
    amount_approved_paise: null,
    starts_on: null,
    completes_on: null,
    reason: "Because the kitchen needs somebody who can sign it off.",
    service_commitment_months: null,
    status,
    approval_request_id: null,
    submitted_at: null,
    decided_at: null,
    decided_comment: null,
    reimbursed_on: null,
    reimbursement_reference: null,
    created_at: "2026-08-01T00:00:00Z",
  };
}

describe("hasOpenClaimFor", () => {
  it("finds an exact match that is still open", () => {
    expect(hasOpenClaimFor([claim("Food safety supervisor", "pending")], "Food safety supervisor"))
      .toBe(true);
  });

  it("ignores case and surrounding space, exactly as lower(btrim(...)) does", () => {
    const rows = [claim("Food Safety Supervisor", "pending")];
    expect(hasOpenClaimFor(rows, "  food safety supervisor ")).toBe(true);
    expect(hasOpenClaimFor(rows, "FOOD SAFETY SUPERVISOR")).toBe(true);
  });

  it("lets somebody try again after a rejection", () => {
    // The index is partial. A second attempt at a course you were refused is
    // exactly the case it deliberately permits.
    expect(hasOpenClaimFor([claim("FSSAI Level 1", "rejected")], "FSSAI Level 1")).toBe(false);
  });

  it("lets somebody try again after withdrawing, or after it was paid", () => {
    for (const settled of ["withdrawn", "cancelled", "approved"]) {
      expect(hasOpenClaimFor([claim("FSSAI Level 1", settled)], "FSSAI Level 1")).toBe(false);
    }
  });

  it("blocks a second claim in every status the index calls open", () => {
    // Read from the exported list rather than retyped, so adding a status to one
    // and not the other cannot pass this file.
    for (const open of CERTIFICATION_OPEN_STATUSES) {
      expect(hasOpenClaimFor([claim("FSSAI Level 1", open)], "FSSAI Level 1")).toBe(true);
    }
  });

  it("does not match a different certification", () => {
    expect(hasOpenClaimFor([claim("FSSAI Level 1", "pending")], "FSSAI Level 2")).toBe(false);
  });

  it("treats an empty or blank name as nothing to compare", () => {
    /*
      An empty box is caught by its own blocker ("Name the certification"), and
      returning true here would stack a second, more confusing refusal on top of
      it — "you already have an open claim for ''".
    */
    expect(hasOpenClaimFor([claim("", "pending")], "")).toBe(false);
    expect(hasOpenClaimFor([claim("FSSAI", "pending")], "   ")).toBe(false);
  });

  it("says no when there are no claims at all", () => {
    expect(hasOpenClaimFor([], "FSSAI Level 1")).toBe(false);
  });
});
