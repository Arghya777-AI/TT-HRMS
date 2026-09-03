/**
 * The reimbursement page: what a month adds up to, and who can find it.
 *
 * ── WHAT WAS ASKED FOR, AND WHY IT DID NOT EXIST ─────────────────────────────
 * "How can the admin check which reimbursements have been processed, which are done, and which
 * are pending? There should be a reimbursement page to understand everything, with month/year
 * filtering, so they can view the totals: who claimed how much, and for what purpose."
 *
 * Checked before building: `/admin/payroll/reimbursements` shows each claim's own amount and
 * adds nothing up — its own header says "not one amount is added up here" — and it cannot be
 * filtered by month at all. There was no view over `reimbursement_claims`, no exportable report
 * subject and no analytics KPI.
 *
 * AND IT HAD NO ENTRANCE. The payroll rail row was deliberately withdrawn, so that page was
 * reachable only by typing the URL. That is why the question was "is there any page" rather
 * than "why is the total wrong".
 *
 * ── THE THREE FIGURES A CLAIM CAN BE COUNTED IN ──────────────────────────────
 * The venue's own rows disagree: CLM-2026-000003 covers 26-30 AUGUST and was filed on
 * 2 SEPTEMBER. Verified against live data — September is 6,148 by expense period, 12,118 by
 * filing date and 0 by payment date. All three are correct answers to different questions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { financialYearPeriod, monthPeriod, recentMonths } from "./api/reimbursementAdmin.api";
import { paiseToRupeeString, toCsv } from "./reimbursementCsv";
import { claimFilters } from "./api/payroll-statutory.api";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*--.*$/gm, "");

const page = strip(read("src", "features", "admin", "pages", "ReimbursementAdmin.page.tsx"));
const mig = strip(read("supabase", "migrations", "20260904180000_what_a_month_of_reimbursement_adds_up_to.sql"));
const nav = strip(read("src", "app", "shell", "nav-model.ts"));
const manifest = strip(read("src", "app", "route-manifest.ts"));

describe("an admin can find it", () => {
  it("has a row in the left-hand rail", () => {
    /*
      The whole reason the question was asked. The payroll rail entrance is withdrawn, so
      filing this page under `admin-payroll` would have left it exactly as undiscoverable.
    */
    expect(nav).toContain('to: "/admin/reimbursements"');
    expect(nav).toContain('cap: "admin.access"');
  });

  it("carries its own domain, so rail coverage is satisfied rather than excepted", () => {
    expect(manifest).toContain('"admin-reimbursements"');
    const excepted = read("src", "app", "shell", "railCoverage.test.ts");
    expect(excepted).not.toContain("admin-reimbursements");
  });

  it("is admin-only", () => {
    expect(manifest).toMatch(/"\/admin\/reimbursements", "Reimbursements", "A",/);
  });
});

describe("the period, and which date decides it", () => {
  it("offers a month and a financial year", () => {
    expect(monthPeriod("2026-09-01")).toEqual({ from: "2026-09-01", to: "2026-09-30", label: "2026-09" });
    expect(monthPeriod("2026-02-15")).toEqual({ from: "2026-02-01", to: "2026-02-28", label: "2026-02" });
  });

  it("uses the INDIAN financial year, April to March", () => {
    /*
      Not a calendar year: payroll, tax and every statutory return in this product already work
      April-to-March, and a calendar total would reconcile against none of them.
    */
    expect(financialYearPeriod("2026-09-03")).toEqual({ from: "2026-04-01", to: "2027-03-31", label: "2026-27" });
    // January falls in the year that STARTED the previous April.
    expect(financialYearPeriod("2027-01-15")).toEqual({ from: "2026-04-01", to: "2027-03-31", label: "2026-27" });
  });

  it("lists recent months newest first, crossing a year boundary", () => {
    const m = recentMonths("2027-01-15", 3);
    expect(m).toEqual(["2027-01", "2026-12", "2026-11"]);
  });

  it("offers all three bases, and the SQL knows the same three", () => {
    expect(mig).toContain("CREATE TYPE public.claim_period_basis AS ENUM ('period', 'filed', 'paid')");
    /*
      Asserted against the exhaustive records rather than templated keys. The first version of
      this test looked for the literal `admin.radm.basis.hint.period` and failed — correctly:
      the page was building the key by template, and `t()` has no missing-key fallback, so a
      typo there renders an empty cell rather than an error. The page now maps them explicitly
      and a new basis is a compile error.
    */
    for (const b of ["period", "filed", "paid"]) {
      expect(page, b).toContain(`${b}: "admin.radm.basis.${b}"`);
      expect(page, b).toContain(`${b}: "admin.radm.basis.hint.${b}"`);
    }
    expect(page).not.toMatch(/as MessageKey\)/);
  });
});

describe("the table filters the same rows the total sums", () => {
  it("filters strictly on period_to for the expense basis", () => {
    const f = claimFilters({ from: "2026-09-01", to: "2026-09-30", basis: "period" });
    expect(f).toEqual([
      { op: "gte", column: "period_to", value: "2026-09-01" },
      { op: "lte", column: "period_to", value: "2026-09-30" },
    ]);
  });

  it("bounds the filing basis by IST days, not UTC midnight", () => {
    /*
      ── A REAL OFF-BY-FIVE-AND-A-HALF-HOURS BUG, FOUND BY ESLINT ─────────────
      `created_at` is a timestamptz. The first version compared it to the bare string
      '2026-09-01', which Postgres reads as UTC midnight — 05:30 IST. So a claim filed at
      02:00 IST on 1 September, which is 20:30 UTC on 31 August, fell OUTSIDE the month, and
      the last five and a half hours of 30 September IST fell outside it too. Five and a half
      hours of every boundary day attributed to the wrong month, silently, in a total somebody
      would reconcile against a bank statement.
      
      The rule banning `toISOString()` for business dates is what surfaced it. The bounds are
      now the real instants: 00:00 IST on the 1st to 00:00 IST on the 1st of the next month,
      upper bound exclusive.
    */
    const f = claimFilters({ from: "2026-09-01", to: "2026-09-30", basis: "filed" });
    expect(f).toEqual([
      { op: "gte", column: "created_at", value: "2026-08-31T18:30:00.000Z" },
      { op: "lt", column: "created_at", value: "2026-09-30T18:30:00.000Z" },
    ]);
  });

  it("excludes unpaid claims entirely on the payment basis", () => {
    // An unpaid claim has no payment date and belongs in no month on that basis.
    const f = claimFilters({ from: "2026-09-01", to: "2026-09-30", basis: "paid" });
    expect(f).toContainEqual({ op: "not_is", column: "paid_on", value: null });
  });

  it("reads every claim when no period is given", () => {
    expect(claimFilters({})).toEqual([]);
  });

  it("uses no filter operator the query layer does not have", () => {
    /*
      THE BUG THIS CAUGHT. A first version expressed the expense basis as a PostgREST `or` so a
      claim with no `period_to` could fall back to its filing date. `Filter` has no `or`, so it
      needed an `as unknown as Filter` cast and would have shipped a filter the builder silently
      ignored — a screen showing every claim ever filed while claiming to show one month.
    */
    const api = strip(read("src", "features", "admin", "api", "payroll-statutory.api.ts"));
    expect(api).not.toContain('op: "or"');
    expect(api).not.toContain("as unknown as Filter");
  });
});

describe("the totals are Postgres's", () => {
  it("is summed server-side, not in the browser", () => {
    // A tile must be the total of exactly the rows its table shows; summing a capped page in
    // JavaScript would make the figure depend on the page size.
    expect(page).toContain("fetchReimbursementSummary(period.from, period.to, basis, signal)");
    expect(page).not.toMatch(/rows\.reduce\(/);
  });

  it("reports what is still OWED, not just claimed and paid", () => {
    // Approved and unpaid is the figure to read first, and it is neither of the other two.
    expect(mig).toContain("outstanding_paise");
    expect(mig).toContain("WHERE paid_on IS NULL\n        AND status IN ('approved', 'auto_approved', 'applied')");
    expect(page).toContain("admin.radm.tile.outstanding");
  });

  it("counts the three states the venue named", () => {
    for (const k of ["pending_count", "approved_count", "paid_count"]) expect(mig).toContain(k);
    for (const k of ["count.pending", "count.processed", "count.done"]) expect(page).toContain(k);
  });

  it("surfaces claims it cannot place in a month instead of dropping them", () => {
    /*
      `period_to` is nullable and nothing forces it, so a claim can exist that no
      expense-period total may legitimately include. Silence there would be a total that is
      quietly wrong rather than narrow.
    */
    expect(mig).toContain("undated_count");
    expect(page).toContain("s.undated_count > 0");
  });

  it("is SECURITY INVOKER, so an admin sees only their own scope's money", () => {
    expect(mig).toContain("SECURITY INVOKER");
    expect(mig).not.toMatch(/reimbursement_period_summary[\s\S]{0,600}SECURITY DEFINER/);
  });
});

describe("what the table shows", () => {
  it("names who claimed, how much, and what for", () => {
    for (const k of ["col.who", "col.claimed", "col.approved", "col.purpose"]) {
      expect(page, k).toContain(k);
    }
  });

  it("builds the purpose from the LINES, not the header", () => {
    // The header carries only an optional event_reference; the description an employee typed
    // lives on each line.
    expect(page).toContain("line.description ?? line.expense_head");
    expect(page).toContain("new Set(");
  });

  it("marks approved-and-unpaid on the row, not just in the total", () => {
    expect(page).toContain("admin.radm.owed");
  });

  it("shares one implementation of every action with the payroll page", () => {
    // A decision must not mean two different things depending on which screen took it.
    expect(page).toContain("useDecideClaim");
    expect(page).toContain("useClaimDecisionTargets");
  });

  it("offers decide buttons only where the SERVER says this admin is the approver", () => {
    expect(page).toContain("targetMap?.get(row.id)");
    expect(page).toContain("decidable !== undefined");
  });
});

describe("the download", () => {
  it("writes rupees as a plain decimal, not a formatted currency", () => {
    /*
      `formatPaise` gives "₹6,148.00" — the comma is a column break waiting to happen, and the
      symbol has to be stripped before anybody can sum the column they downloaded it to sum.
    */
    expect(paiseToRupeeString(614800)).toBe("6148.00");
    expect(paiseToRupeeString(5)).toBe("0.05");
    expect(paiseToRupeeString(null)).toBe("");
  });

  it("escapes a value containing a comma or a quote", () => {
    const csv = toCsv([{ p: 'Taxi, airport; said "urgent"' }], [{ header: "What for", value: (r) => r.p }]);
    expect(csv).toContain('"Taxi, airport; said ""urgent"""');
  });

  it("starts with a BOM, so Excel on Windows reads UTF-8", () => {
    expect(toCsv([], [{ header: "a", value: () => "" }]).startsWith("﻿")).toBe(true);
  });

  it("uses CRLF line endings", () => {
    const csv = toCsv([{ a: "1" }], [{ header: "a", value: (r) => r.a }]);
    expect(csv).toContain("\r\n");
  });
});
