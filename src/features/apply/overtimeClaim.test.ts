/**
 * A month of overtime can be claimed, and the figure is the server's.
 *
 * ── WHAT THE VENUE ASKED FOR ─────────────────────────────────────────────────
 * "If they have completed one month attendance, and there are certain days where they have
 * worked extra — it should show summarised. Can they submit it to me saying, okay, the overtime
 * I want to claim? For that they have to give me proofs. It should come as an approval to me."
 * And: "either you can be compensated, or we can give it as a compensatory off."
 *
 * ── THE TWO PROPERTIES WORTH GUARDING ────────────────────────────────────────
 * 1. NO MINUTE COUNT CROSSES THE WIRE. `submit_overtime_claim` sums the month from
 *    `attendance_days` itself, and `overtime_claimable` — the same function — is what the form
 *    displays. So an employee cannot claim hours the engine never credited, and the approval is
 *    a decision about whether to pay rather than an arithmetic check. HR was explicit: "I don't
 *    want to keep on verifying all that."
 *
 * 2. A DAY WITH AN UNAPPROVED PUNCH IS NOT CLAIMABLE. `overtime_minutes` derives from payable
 *    minutes, which include time still awaiting a punch decision. Letting those in would ask an
 *    administrator to approve payment for hours they have not yet accepted as worked.
 *
 * ── VERIFIED AGAINST THE LIVE DATABASE ───────────────────────────────────────
 * Every behaviour below was exercised in a rolled-back transaction before shipping: the current
 * month refused; a month with no overtime refused; a five-character reason refused; 300 clean
 * plus 60 withheld reported as exactly that; filed at status `pending` with the approval raised
 * at level 1 of 2; a second live claim refused; approval crediting 0.5 comp-off days expiring
 * after 90 days; 105 minutes refused as comp-off and accepted as paid.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPENSATION_MODES } from "./api/overtime-claim.api";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*--.*$/gm, "");

const mig = strip(read("supabase", "migrations", "20260904140000_a_month_of_overtime_can_be_claimed.sql"));
const api = strip(read("src", "features", "apply", "api", "overtime-claim.api.ts"));
const page = strip(read("src", "features", "apply", "pages", "OvertimeClaim.page.tsx"));

describe("the employee cannot assert their own number", () => {
  it("the submit function takes no minutes argument", () => {
    expect(mig).toContain("submit_overtime_claim(\n  p_month        date,\n  p_compensation text,\n  p_reason       text)");
  });

  it("the client cannot send one either", () => {
    expect(api).toContain("p_month: month, p_compensation: compensation, p_reason: reason.trim()");
    /*
      Scoped to the SUBMIT call, not the whole module. The first version asserted
      `claimed_minutes:` appeared nowhere and failed — the schema legitimately reads it back for
      the "your claims" list. Reading the server's figure is the point; sending one is the
      problem, so the assertion has to be about the arguments.
    */
    const submitArgs = api.slice(api.indexOf("SUBMIT_FN,"), api.indexOf("z.string().uuid()"));
    expect(submitArgs).not.toMatch(/minutes/i);
  });

  it("there is no minutes field on the form", () => {
    expect(page).not.toMatch(/type="number"/);
  });

  it("the figure comes from the same function the form reads", () => {
    // One computation, read in both places, so the number shown IS the number filed.
    expect(mig).toContain("SELECT * INTO v_c FROM public.overtime_claimable(v_emp, v_start)");
    expect(api).toContain("overtime_claimable");
  });

  it("gives the browser no way to insert a row directly", () => {
    /*
      No self-insert policy and no INSERT grant: the definer function is the only way in, which
      is what keeps `claimed_minutes` the server's figure.
    */
    expect(mig).toContain("GRANT SELECT ON TABLE public.overtime_claims TO authenticated");
    expect(mig).not.toMatch(/GRANT[^;]*INSERT[^;]*overtime_claims/);
    expect(mig).not.toMatch(/CREATE POLICY[^;]*FOR INSERT[^;]*overtime_claims/);
  });
});

describe("what a month offers", () => {
  it("excludes days that still hold an unapproved punch", () => {
    expect(mig).toContain("FILTER (WHERE COALESCE(d.pending_approval_minutes,0) = 0)");
  });

  it("reports those days separately rather than dropping them", () => {
    // An employee who can see the hours on their attendance page must be told why the claim is
    // smaller; silence reads as the system losing their time.
    expect(mig).toContain("FILTER (WHERE COALESCE(d.pending_approval_minutes,0) > 0)");
    expect(page).toContain('t("apply.ot.withheld"');
  });

  it("says so when the only overtime is withheld, instead of claiming there is none", () => {
    expect(mig).toContain("still waiting on % day(s) of punch approvals");
  });

  it("reads attendance under the caller's own RLS", () => {
    expect(mig).toContain("SECURITY INVOKER");
  });
});

describe("the refusals", () => {
  it("will not claim a month that has not finished", () => {
    expect(mig).toContain("The month has not finished yet");
  });

  it("will not accept a reason too short to be read later", () => {
    expect(mig).toContain("at least 15 characters");
    expect(mig).toContain("length(btrim(reason)) >= 15");
  });

  it("permits one live claim per month, and a refiling after a rejection", () => {
    expect(mig).toContain("uq_otc__live_per_month");
    expect(mig).toContain("WHERE status IN ('pending', 'in_progress', 'escalated', 'approved')");
  });

  it("refuses a comp-off claim that would round to nothing", () => {
    /*
      `ck_col__granularity` allows only half-day steps, so a short claim credits zero. Accepting
      it would spend an approval and give the employee nothing, with no error to explain it.
    */
    expect(mig).toContain("it would round to nothing. Claim it as paid instead");
  });
});

describe("approving it does something", () => {
  it("applies from the row, so any decision route works", () => {
    // The lesson from the regularisation defect, applied before it could recur.
    expect(mig).toContain("CREATE TRIGGER trg_otc__apply_on_approve");
    expect(mig).toContain("NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved'");
  });

  it("is idempotent", () => {
    expect(mig).toContain("IF c.applied_at IS NOT NULL THEN");
    expect(mig).toContain("'already_applied'");
  });

  it("credits comp-off rounded DOWN, never up", () => {
    // Rounding up would invent time nobody worked.
    expect(mig).toContain("floor((c.claimed_minutes::numeric / v_full) * 2) / 2");
  });

  it("guards the settle trigger so it cannot withdraw its own request", () => {
    /*
      THE BUG THE DRY RUN CAUGHT. `settle_approval_for_detail` ends with `ELSE 'withdrawn'`, so
      without a WHEN clause it fired on the back-link UPDATE — status still 'pending' — and
      withdrew the approval it had just raised. The claim read `withdrawn` seconds after being
      filed, and the month became claimable again because 'withdrawn' is outside the unique
      index's status list.
    */
    expect(mig).toContain("WHEN (NEW.approval_request_id IS NOT NULL");
    expect(mig).toContain("NEW.status::text = ANY (ARRAY['withdrawn', 'cancelled'])");
    expect(mig).toContain("OLD.status IS DISTINCT FROM NEW.status");
  });
});

describe("it reaches an administrator", () => {
  it("routes through the manager-then-admin chain", () => {
    // "It should come as an approval to me" — Sunil is an administrator, so the standard claim
    // chain reaches him after the manager. AC-OT is the pre-approval chain and stays put.
    expect(mig).toContain("WHERE code = 'AC-CLAIM-STD'");
  });

  it("registers the detail table on the whitelist the evidence panel trusts", () => {
    expect(mig).toContain("'overtime_claims'");
    expect(mig).toContain("ck_request_types__detail_table");
  });

  it("offers both outcomes the venue named", () => {
    expect([...COMPENSATION_MODES]).toEqual(["paid", "comp_off"]);
    expect(mig).toContain("compensation IN ('paid', 'comp_off')");
  });
});
