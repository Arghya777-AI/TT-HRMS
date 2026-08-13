/**
 * payslipPdf.ts — a payslip as a document, not a screenshot of an application.
 *
 * ── WHY THIS EXISTS, AND WHY IT ALMOST DID NOT ─────────────────────────────
 *
 * `pay.api.ts` states the rule this file has to answer to:
 *
 *     "The browser therefore DOWNLOADS the authoritative document; it does not
 *      render a second, possibly divergent one with jsPDF."
 *
 * That is the right instinct — two renderings of one payslip is two sets of
 * numbers that can disagree, and the one payroll signed must win. But the
 * authoritative PDF is produced by the `payslip-publish` edge function, which
 * has never been deployed on this project, so `pdf_document_id` is NULL on every
 * payslip and the rule was protecting a document that does not exist. What the
 * employee actually got was nothing.
 *
 * The first attempt at a download was `window.print()`, and the output proved
 * the point better than any argument: masked amounts (₹•,••,•••), the floating
 * assistant bubble, the search bar, a URL footer, and three pages of whitespace.
 * Nobody can send that to a bank.
 *
 * So this renders the payslip properly, and resolves the divergence rule three
 * ways rather than ignoring it:
 *
 *   1. Every figure comes from the SAME rows the screen reads. Nothing is
 *      recomputed here — not the net, not the totals, not the words form. If a
 *      number is absent server-side it is absent here too, and says so.
 *   2. The footer states, on every page, that this is the employee's own copy
 *      generated in their browser, with the moment it was made.
 *   3. The caller prefers payroll's PDF whenever `pdf_document_id` is set. This
 *      is the fallback, not the replacement.
 *
 * ── ON MASKING ─────────────────────────────────────────────────────────────
 *
 * The screen masks amounts until "Show amounts" is pressed. This does NOT mask
 * them: pressing Download on your own payslip is the same deliberate act as
 * pressing Show, and a payslip whose figures are dots is not a payslip. What
 * stays masked is what the SERVER masks — the bank account and the statutory
 * identifiers arrive already redacted and there is nothing here to reveal.
 */
import { BRAND } from "@/config/brand";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";

import type { PayslipLineRow } from "./api/pay.api";

/** What the PDF needs, gathered by the caller from the screen's own queries. */
export interface PayslipPdfInput {
  /** The header row every line repeats — the single source for totals. */
  readonly header: PayslipLineRow;
  readonly earnings: readonly PayslipLineRow[];
  readonly deductions: readonly PayslipLineRow[];
  readonly employerLines: readonly PayslipLineRow[];
  readonly issuer: { readonly legalName: string | null; readonly tradeName: string | null };
  readonly employee: {
    readonly name: string | null;
    readonly code: string | null;
    readonly designation: string | null;
    readonly department: string | null;
    readonly location: string | null;
    readonly dateOfJoining: string | null;
  };
  /** Already redacted by the server; printed as received. */
  readonly bank: { readonly maskedNumber: string | null; readonly bankName: string | null };
  readonly statutory: {
    readonly pan: string | null;
    readonly uan: string | null;
    readonly pf: string | null;
  };
  /** The month label the screen shows, e.g. "Mar-2027". */
  readonly periodLabel: string;
  /**
   * Stamped in the footer, as an IST instant string from `nowInstantIso()`.
   *
   * A string rather than a Date because the repo forbids `new Date()` and
   * `toISOString()` for anything a person reads — both are UTC, and a payslip
   * footer that says a time five and a half hours off the one on the clock is
   * exactly the confusion those rules exist to prevent.
   */
  readonly generatedAtIso: string;
}

const PAGE = { width: 595.28, margin: 40 } as const; // A4 portrait, points.
const INK = { heading: "#1a2e22", body: "#333333", muted: "#6b7280" } as const;

/**
 * Indian digit grouping, no currency symbol.
 *
 * ── WHY NOT ₹ ──────────────────────────────────────────────────────────────
 *
 * The PDF's standard fonts (Helvetica and friends) are WinAnsi-encoded and have
 * no glyph for U+20B9. jsPDF handles a string containing one by re-encoding the
 * WHOLE string, and what lands on the page is a blank where the symbol should be
 * — on a payslip, blanks next to money are the last thing anybody wants.
 *
 * Found by the test asserting the net pay appears in the output: it did not,
 * because the amount had been turned into an unreadable run by one character.
 *
 * So the amounts carry no symbol and every money column is headed "(INR)". That
 * is how payslips generated with core PDF fonts have always done it, and it
 * cannot be mistaken for another currency on a document that names the company
 * and the employee's Indian statutory numbers.
 */
const GROUPED = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function money(paise: number | null | undefined): string {
  return paise === null || paise === undefined ? "-" : GROUPED.format(paise / 100);
}

function line(row: PayslipLineRow): [string, string, string] {
  return [
    row.label ?? row.component_code ?? "—",
    /* `calc_basis` is payroll's own working — the proof of how the figure was
       reached. Printed verbatim, never paraphrased. */
    row.calc_basis ?? "",
    money(row.amount_paise),
  ];
}

/**
 * Build the payslip. Returns a Blob so the caller decides download vs view —
 * the same object serves both, and generating twice would risk two files.
 */
export async function buildPayslipPdf(input: PayslipPdfInput): Promise<Blob> {
  // Dynamic and parallel: ~350 kB that must never reach the entry graph.
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const autoTable = autoTableModule.default;

  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const { header, employee, issuer } = input;

  doc.setProperties({
    title: `Payslip ${input.periodLabel} — ${employee.name ?? ""}`.trim(),
    subject: header.payslip_number,
    author: issuer.legalName ?? BRAND.legalName,
  });

  let y = PAGE.margin;
  const right = PAGE.width - PAGE.margin;

  // ── Masthead ──────────────────────────────────────────────────────────────
  doc.setTextColor(INK.heading);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(issuer.legalName ?? BRAND.legalName, PAGE.margin, y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(INK.muted);
  if (issuer.tradeName !== null && issuer.tradeName !== "") {
    y += 14;
    doc.text(issuer.tradeName, PAGE.margin, y);
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(INK.heading);
  doc.text(`Payslip  ${input.periodLabel}`, right, PAGE.margin, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(INK.muted);
  doc.text(header.payslip_number, right, PAGE.margin + 13, { align: "right" });

  y += 16;
  doc.setDrawColor(210);
  doc.line(PAGE.margin, y, right, y);
  y += 6;

  // ── Who and when ──────────────────────────────────────────────────────────
  autoTable(doc, {
    startY: y,
    theme: "plain",
    styles: { fontSize: 9, cellPadding: { top: 3, bottom: 3, left: 0, right: 8 } },
    columnStyles: {
      0: { textColor: INK.muted, cellWidth: 95 },
      1: { textColor: INK.body, fontStyle: "bold", cellWidth: 165 },
      2: { textColor: INK.muted, cellWidth: 95 },
      3: { textColor: INK.body, fontStyle: "bold" },
    },
    body: [
      ["Employee", employee.name ?? "—", "Employee code", employee.code ?? "—"],
      ["Role", employee.designation ?? "—", "Department", employee.department ?? "—"],
      ["Work location", employee.location ?? "—", "Date of joining", fmtCivilDate(employee.dateOfJoining)],
      [
        "Pay period",
        `${fmtCivilDate(header.period_start)} to ${fmtCivilDate(header.period_end)}`,
        "Pay date",
        fmtCivilDate(header.pay_date),
      ],
      [
        "Days in window",
        String(header.period_days),
        "Paid days",
        `${String(header.paid_days)}${Number(header.lop_days) > 0 ? `  (LOP ${String(header.lop_days)})` : ""}`,
      ],
      [
        "Payment",
        header.payment_status ?? "—",
        "Paid by",
        header.payment_mode ?? "—",
      ],
      [
        "Salary account",
        [input.bank.maskedNumber, input.bank.bankName].filter(Boolean).join("  ") || "—",
        "PAN",
        input.statutory.pan ?? "—",
      ],
      ["UAN", input.statutory.uan ?? "—", "PF number", input.statutory.pf ?? "—"],
    ],
  });

  const after = (): number => {
    const table = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    return (table?.finalY ?? y) + 18;
  };

  // ── Earnings and deductions ───────────────────────────────────────────────
  const section = (
    title: string,
    rows: readonly PayslipLineRow[],
    total: string,
    totalLabel: string,
  ): void => {
    autoTable(doc, {
      startY: after(),
      head: [[title, "How it was worked out", "Amount (INR)"]],
      body:
        rows.length > 0
          ? rows.map(line)
          : [["Payroll published no lines under this heading.", "", "—"]],
      foot: [[totalLabel, "", total]],
      theme: "striped",
      headStyles: { fillColor: [26, 46, 34], textColor: 255, fontSize: 9, halign: "left" },
      footStyles: { fillColor: [245, 245, 245], textColor: INK.heading, fontStyle: "bold", fontSize: 9 },
      styles: { fontSize: 9, cellPadding: 5, textColor: INK.body },
      columnStyles: {
        0: { cellWidth: 165 },
        1: { textColor: INK.muted, fontSize: 8 },
        2: { halign: "right", cellWidth: 95 },
      },
      margin: { left: PAGE.margin, right: PAGE.margin },
    });
  };

  section("Earnings", input.earnings, money(header.gross_earnings_paise), "Gross earnings (A)");
  section("Deductions", input.deductions, money(header.total_deductions_paise), "Total deductions (B)");

  // ── Net pay ───────────────────────────────────────────────────────────────
  const netY = after();
  doc.setFillColor(240, 246, 241);
  doc.rect(PAGE.margin, netY, right - PAGE.margin, 46, "F");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(INK.muted);
  doc.text("NET PAY  (A - B)", PAGE.margin + 12, netY + 17);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(INK.heading);
  doc.text(money(header.net_pay_paise), right - 12, netY + 20, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(INK.muted);
  /* The words form is SERVER-generated (`net_pay_words`) and is never composed
     here — a client that spells its own number can spell a different one. */
  doc.text(
    header.net_pay_words !== null && header.net_pay_words !== ""
      ? `In words: ${header.net_pay_words}`
      : "In words: payroll has not stamped the words form on this payslip.",
    PAGE.margin + 12,
    netY + 36,
  );

  // ── Employer contributions, kept OUT of the net arithmetic ────────────────
  if (input.employerLines.length > 0 || header.employer_contributions_paise !== null) {
    autoTable(doc, {
      startY: netY + 62,
      head: [["Employer contributions", "Paid by the company, on top of your salary", "Amount (INR)"]],
      body:
        input.employerLines.length > 0
          ? input.employerLines.map(line)
          : [["Payroll published no employer contribution lines.", "", "—"]],
      foot: [
        ["Employer contributions (C)", "", money(header.employer_contributions_paise)],
        ["Cost to company for this window (A + C)", "", money(header.total_ctc_for_period_paise)],
      ],
      theme: "striped",
      headStyles: { fillColor: [90, 90, 90], textColor: 255, fontSize: 9, halign: "left" },
      footStyles: { fillColor: [245, 245, 245], textColor: INK.heading, fontStyle: "bold", fontSize: 9 },
      styles: { fontSize: 9, cellPadding: 5, textColor: INK.body },
      columnStyles: { 0: { cellWidth: 165 }, 1: { textColor: INK.muted, fontSize: 8 }, 2: { halign: "right", cellWidth: 95 } },
      margin: { left: PAGE.margin, right: PAGE.margin },
    });
  }

  // ── Year to date ──────────────────────────────────────────────────────────
  autoTable(doc, {
    startY: after(),
    head: [["Year to date, as stamped on this payslip", "Amount (INR)"]],
    body: [
      ["Gross earnings", money(header.ytd_gross_paise)],
      ["Deductions", money(header.ytd_deductions_paise)],
      ["Net paid", money(header.ytd_net_paise)],
      ["Income tax deducted", money(header.ytd_tds_paise)],
    ],
    theme: "striped",
    headStyles: { fillColor: [90, 90, 90], textColor: 255, fontSize: 9, halign: "left" },
    styles: { fontSize: 9, cellPadding: 5, textColor: INK.body },
    columnStyles: { 1: { halign: "right", cellWidth: 95 } },
    margin: { left: PAGE.margin, right: PAGE.margin },
  });

  // ── Footer, on every page ─────────────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    const bottom = doc.internal.pageSize.getHeight() - 24;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(INK.muted);
    /*
      Says what it is. This is the employee's own copy, made in their browser
      from the figures on their screen — not the document payroll signs. When
      `payslip-publish` is deployed, that one is offered first and this line is
      how anybody can tell the two apart in a filing cabinet.
    */
    doc.text(
      `Employee copy - generated ${fmtDateTime(input.generatedAtIso)} - ` +
        `${header.payslip_number} - computer generated, no signature required`,
      PAGE.margin,
      bottom,
    );
    doc.text(`${String(page)} / ${String(pages)}`, right, bottom, { align: "right" });
  }

  return doc.output("blob");
}

/** The file name a person expects to find in their downloads folder. */
export function payslipFileName(input: {
  readonly employeeCode: string | null;
  readonly periodLabel: string;
}): string {
  const who = (input.employeeCode ?? "payslip").replace(/[^A-Za-z0-9_-]/g, "");
  const when = input.periodLabel.replace(/[^A-Za-z0-9-]/g, "-");
  return `Payslip-${when}-${who}.pdf`;
}
