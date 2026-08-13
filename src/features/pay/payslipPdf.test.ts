/**
 * The payslip PDF, asserted against its own bytes.
 *
 * jsPDF writes uncompressed text streams, so the words that reach the page can
 * be read back out of the Blob — which is what makes "does the figure actually
 * appear" testable rather than a matter of opening the file and looking.
 *
 * What these guard is the thing that went wrong first time round: the browser's
 * print produced masked amounts (₹•,••,•••) and a URL footer, and nobody could
 * send it to a bank. A payslip that renders but shows dots where the money goes
 * is worse than no payslip, because it looks like it worked.
 */
import { describe, expect, it } from "vitest";
import { buildPayslipPdf, payslipFileName, type PayslipPdfInput } from "./payslipPdf";
import type { PayslipLineRow } from "./api/pay.api";

/** A header row with only what the builder reads; the view returns far more. */
const HEADER = {
  payslip_number: "TT0002/2027-03",
  period_start: "2027-02-26",
  period_end: "2027-03-25",
  pay_date: "2027-03-31",
  period_days: 28,
  paid_days: 28,
  lop_days: 0,
  gross_earnings_paise: 4_500_000,
  total_deductions_paise: 550_000,
  net_pay_paise: 3_950_000,
  net_pay_words: "Thirty nine thousand five hundred rupees only",
  employer_contributions_paise: 320_000,
  total_ctc_for_period_paise: 4_820_000,
  ytd_gross_paise: 54_000_000,
  ytd_deductions_paise: 6_600_000,
  ytd_net_paise: 47_400_000,
  ytd_tds_paise: 2_100_000,
  payment_status: "paid",
  payment_mode: "bank_transfer",
} as unknown as PayslipLineRow;

function componentLine(label: string, paise: number, basis: string): PayslipLineRow {
  return { label, amount_paise: paise, calc_basis: basis } as unknown as PayslipLineRow;
}

const INPUT: PayslipPdfInput = {
  header: HEADER,
  earnings: [
    componentLine("Basic", 2_700_000, "60% of gross, 28/28 days"),
    componentLine("House rent allowance", 1_080_000, "40% of basic"),
  ],
  deductions: [componentLine("Provident fund", 324_000, "12% of basic")],
  employerLines: [componentLine("Employer PF", 324_000, "12% of basic")],
  issuer: { legalName: "Machani Hospitalities LLP", tradeName: "The Tamarind Tree" },
  employee: {
    name: "Suraj Kumar",
    code: "TT0002",
    designation: "HR Executive",
    department: "Management",
    location: "Tamarind Tree, Avalahalli",
    dateOfJoining: "2026-01-12",
  },
  bank: { maskedNumber: "••••••7234", bankName: "Canara Bank" },
  statutory: { pan: "XXXXXX026C", uan: "XXXXXXXX8462", pf: "XXXXXXXXXXXX0274" },
  periodLabel: "Mar-2027",
  generatedAtIso: "2026-08-13T05:54:00.000Z",
};

/**
 * jsdom's Blob has no `.arrayBuffer()`; FileReader is the portable way in — the
 * same reader `exportReport.test.ts` uses.
 *
 * READ AS WINDOWS-1252, not UTF-8. A PDF is binary, and decoding it as UTF-8
 * makes any byte in the C2–F4 range swallow the ASCII bytes that follow it — so
 * "₹39,500" came back with the digits eaten and an assertion failed against
 * perfectly correct output. Single-byte decoding maps every byte to one
 * character and leaves the ASCII alone.
 */
function textOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("blob read failed"));
    };
    reader.readAsText(blob, "windows-1252");
  });
}

describe("buildPayslipPdf", () => {
  it("produces a PDF", async () => {
    const blob = await buildPayslipPdf(INPUT);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(1000);
  });

  it("prints the amounts rather than masking them", async () => {
    /*
      THE DEFECT THIS FILE EXISTS FOR. The screen masks until "Show amounts" is
      pressed, and the printed version inherited the mask — so the download was
      a page of ₹•,••,•••. Downloading your own payslip IS the deliberate act
      that masking waits for.
    */
    const text = await textOf(await buildPayslipPdf(INPUT));
    /*
      The MASK SHAPE, not a bare bullet. Decoding PDF bytes single-byte turns
      plenty of binary into "•" by coincidence (0x95), so asserting on one
      character fails against perfectly correct output. `MASKED_INR_SHAPE` is the
      thing that must never appear.
    */
    expect(text).not.toContain("•,••,•••");
    expect(text).toContain("39,500"); // the net, in rupees
    expect(text).toContain("45,000"); // gross
  });

  it("carries the identifying facts a bank will look for", async () => {
    const text = await textOf(await buildPayslipPdf(INPUT));
    for (const fact of [
      "Suraj Kumar",
      "TT0002",
      "Machani Hospitalities LLP",
      "Mar-2027",
      "Canara Bank",
    ]) {
      expect(text, `missing: ${fact}`).toContain(fact);
    }
  });

  it("uses the SERVER's words form and never composes its own", async () => {
    const text = await textOf(await buildPayslipPdf(INPUT));
    expect(text).toContain("Thirty nine thousand five hundred rupees only");

    // With none stamped, it says so rather than spelling the number itself — a
    // client that spells its own number can spell a different one.
    const without = await textOf(
      await buildPayslipPdf({
        ...INPUT,
        header: { ...HEADER, net_pay_words: null } as unknown as PayslipLineRow,
      }),
    );
    expect(without).toContain("has not stamped the words form");
  });

  it("prints payroll's own working beside each line", async () => {
    const text = await textOf(await buildPayslipPdf(INPUT));
    // `calc_basis` is the proof of how a figure was reached; it is rendered
    // verbatim, never paraphrased.
    expect(text).toContain("60% of gross");
  });

  it("marks every page as the employee's own copy", async () => {
    const text = await textOf(await buildPayslipPdf(INPUT));
    expect(text).toContain("Employee copy");
    // So it can never be mistaken for the document payroll signs.
    expect(text).toContain("computer generated");
  });

  it("says a missing figure is missing instead of printing zero", async () => {
    const text = await textOf(
      await buildPayslipPdf({
        ...INPUT,
        header: { ...HEADER, ytd_tds_paise: null } as unknown as PayslipLineRow,
      }),
    );
    /*
      A blank YTD tax printed as ₹0 is a claim that no tax was deducted. The
      dash says payroll did not stamp it, which is the truth.
    */
    expect(text).not.toContain("Income tax deducted 0");
  });

  it("survives a payslip with no lines at all", async () => {
    // Exactly the state of the payslip in the reported PDF.
    const blob = await buildPayslipPdf({
      ...INPUT,
      earnings: [],
      deductions: [],
      employerLines: [],
    });
    const text = await textOf(blob);
    expect(blob.size).toBeGreaterThan(1000);
    expect(text).toContain("published no lines");
  });
});

describe("payslipFileName", () => {
  it("names the file the way somebody expects to find it", () => {
    expect(payslipFileName({ employeeCode: "TT0002", periodLabel: "Mar-2027" })).toBe(
      "Payslip-Mar-2027-TT0002.pdf",
    );
  });

  it("strips anything that would break a filesystem", () => {
    const name = payslipFileName({ employeeCode: "TT/00 02", periodLabel: "Mar 2027" });
    expect(name).not.toMatch(/[/\\ ]/);
    expect(name.endsWith(".pdf")).toBe(true);
  });

  it("still produces a name with no employee code", () => {
    expect(payslipFileName({ employeeCode: null, periodLabel: "Mar-2027" })).toContain("payslip");
  });
});
