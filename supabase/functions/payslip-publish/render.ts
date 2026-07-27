/**
 * payslip-publish/render.ts — the server-side payslip PDF.
 *
 * spec-admin §"Payslips": "Generated server-side at publish, immutable private
 * bucket + content hash." spec-employee E-08.4 names jsPDF, but that is the
 * CLIENT's ad-hoc download of a payslip it can already see. The published,
 * hashed, emailed artefact cannot be produced in a browser — a client-rendered
 * PDF would mean the client decides what a payslip says. So: pdf-lib, loaded
 * through `_shared/deps.ts`, standard-14 fonts only.
 *
 * TEXT-ONLY, deliberately:
 *   - No embedded font file → nothing to fetch at render time, and no 300 KB of
 *     TTF in every isolate.
 *   - No QR code. spec-employee mentions a verification QR; drawing one needs a
 *     matrix encoder we do not have, and a WRONG QR is worse than none. The
 *     verification URL is printed as text instead, and the payslip carries its
 *     own id, so `/verify/<uuid>` still works by typing.
 *   - No logo. `companies.logo_path` is a Storage object; fetching and embedding
 *     it per payslip is a per-employee round trip for decoration.
 *
 * `Rs.` NOT `₹`: the standard-14 fonts are WinAnsi-encoded and U+20B9 is not in
 * WinAnsi — `drawText` THROWS on it. Every string that reaches this module is
 * additionally scrubbed by `latin1()` so a stray glyph in a component label
 * (Kannada name, curly quote from a spreadsheet import) degrades to `?` instead
 * of failing the whole run at employee 37.
 */

import { loadPdfLib } from "../_shared/deps.ts";

// ── Money ───────────────────────────────────────────────────────────────────
// D-04: money is integer paise end to end. It becomes a string exactly once,
// here, at the last possible moment.

/** `12345678` → `1,23,456.78` (Indian grouping: last 3, then 2s). */
export function formatPaise(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.trunc(abs / 100);
  const fraction = abs % 100;
  const digits = String(rupees);
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
  }
  return `${negative ? "-" : ""}${grouped}.${String(fraction).padStart(2, "0")}`;
}

/** `Rs. 1,23,456.78`. */
export function formatRupees(paise: number): string {
  return `Rs. ${formatPaise(paise)}`;
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
] as const;
const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
] as const;

function twoDigits(n: number): string {
  if (n < 20) return ONES[n] as string;
  const tens = TENS[Math.floor(n / 10)] as string;
  const ones = ONES[n % 10] as string;
  return ones === "" ? tens : `${tens} ${ones}`;
}

function threeDigits(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest > 0) parts.push(twoDigits(rest));
  return parts.join(" ");
}

/**
 * `payslips.net_pay_words`, Indian numbering:
 * `2240000` → `Rupees Twenty Two Thousand Four Hundred Only`.
 *
 * The column comment (022) fixes the format, including the `Only` terminator.
 * Paise are spelled out when non-zero; a negative net (recovery exceeding
 * earnings) is prefixed `Minus`, never rendered as an unsigned number.
 */
export function amountInWordsInr(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.trunc(abs / 100);
  const fraction = abs % 100;

  const chunks: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1_000);
  const hundred = rupees % 1_000;

  if (crore > 0) chunks.push(`${threeDigits(crore % 1000) || twoDigits(crore)} Crore`);
  if (lakh > 0) chunks.push(`${twoDigits(lakh)} Lakh`);
  if (thousand > 0) chunks.push(`${twoDigits(thousand)} Thousand`);
  if (hundred > 0) chunks.push(threeDigits(hundred));

  const rupeeWords = chunks.length === 0 ? "Zero" : chunks.join(" ");
  const paiseWords = fraction > 0 ? ` and ${twoDigits(fraction)} Paise` : "";
  return `${negative ? "Minus " : ""}Rupees ${rupeeWords}${paiseWords} Only`;
}

/**
 * Force a string into WinAnsi's reachable range. pdf-lib's standard-14 fonts
 * throw `WinAnsiEncoding cannot encode "…"` on anything else, and one Kannada
 * character in a designation must not fail a 200-payslip publish.
 */
export function latin1(value: string | null | undefined, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return value
    .replace(/₹/g, "Rs.")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    // deno-lint-ignore no-control-regex
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
    .trim();
}

/** `XXXXXX3456` — mirrors `util.mask_tail(value, 4)`. */
export function maskTail(value: string | null | undefined, visible = 4): string {
  if (value === null || value === undefined || value === "") return "-";
  const v = value.trim();
  if (v.length <= visible) return "X".repeat(v.length);
  return "X".repeat(v.length - visible) + v.slice(-visible);
}

// ── Input contract ──────────────────────────────────────────────────────────

export interface PayslipLineInput {
  label: string;
  line_kind: string;
  sequence: number;
  full_month_amount_paise: number;
  amount_paise: number;
  ytd_amount_paise: number;
  is_prorated: boolean;
  is_arrear: boolean;
}

export interface PayslipPdfInput {
  company: {
    legal_name: string;
    trade_name: string | null;
    address_lines: string[];
    pan: string | null;
    tan: string | null;
    pf_establishment_code: string | null;
    esi_establishment_code: string | null;
  };
  employee: {
    employee_code: string;
    display_name: string;
    designation: string | null;
    department: string | null;
    location: string | null;
    date_of_join: string | null;
    payment_mode: string;
    bank_name: string | null;
    bank_ifsc: string | null;
    bank_account_masked: string | null;
    uan: string | null;
    pf_number: string | null;
    esi_number: string | null;
    pan_masked: string | null;
  };
  payslip: {
    id: string;
    payslip_number: string;
    run_number: string;
    period_name: string;
    period_start: string;
    period_end: string;
    pay_date: string;
    period_days: number;
    paid_days: number;
    lop_days: number;
    present_days: number;
    weekly_off_days: number;
    holiday_days: number;
    leave_days_paid: number;
    leave_days_unpaid: number;
    overtime_minutes: number;
    late_deduction_days: number;
    gross_earnings_paise: number;
    total_deductions_paise: number;
    net_pay_paise: number;
    net_pay_words: string;
    employer_contributions_paise: number;
    ytd_gross_paise: number;
    ytd_deductions_paise: number;
    ytd_net_paise: number;
    ytd_tds_paise: number;
  };
  lines: PayslipLineInput[];
  /** IST wall clock, from `_shared/datetime.ts`. Never computed here. */
  generatedAtIst: string;
  verifyUrl: string;
}

// ── Layout constants (A4 portrait, points) ──────────────────────────────────

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LINE = 13.5;
const SIZE_TITLE = 15;
const SIZE_HEAD = 9.5;
const SIZE_BODY = 8.8;
const SIZE_SMALL = 7.6;

/**
 * Render one payslip. Returns the PDF bytes and the page count (which
 * `documents.page_count` requires and CHECKs to be > 0).
 */
export async function renderPayslipPdf(
  input: PayslipPdfInput,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();

  const doc = await PDFDocument.create();
  doc.setTitle(latin1(`Payslip ${input.payslip.payslip_number}`));
  doc.setSubject(latin1(`${input.employee.display_name} — ${input.payslip.period_name}`));
  doc.setProducer("Tamarind Tree HRMS");
  doc.setCreator("Tamarind Tree HRMS payslip-publish");

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.09, 0.09, 0.11);
  const muted = rgb(0.42, 0.42, 0.46);
  const rule = rgb(0.78, 0.78, 0.8);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const newPage = (): void => {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };

  /** Reserve vertical space; break the page when it will not fit. */
  const need = (points: number): void => {
    if (y - points < MARGIN + 30) newPage();
  };

  const text = (
    value: string,
    opts: { x?: number; size?: number; font?: "regular" | "bold"; color?: typeof ink } = {},
  ): void => {
    page.drawText(latin1(value), {
      x: opts.x ?? MARGIN,
      y,
      size: opts.size ?? SIZE_BODY,
      font: opts.font === "bold" ? bold : regular,
      color: opts.color ?? ink,
    });
  };

  const rightText = (
    value: string,
    right: number,
    opts: { size?: number; font?: "regular" | "bold"; color?: typeof ink } = {},
  ): void => {
    const size = opts.size ?? SIZE_BODY;
    const font = opts.font === "bold" ? bold : regular;
    const safe = latin1(value);
    page.drawText(safe, {
      x: right - font.widthOfTextAtSize(safe, size),
      y,
      size,
      font,
      color: opts.color ?? ink,
    });
  };

  const hr = (): void => {
    page.drawLine({
      start: { x: MARGIN, y: y + 4 },
      end: { x: PAGE_WIDTH - MARGIN, y: y + 4 },
      thickness: 0.6,
      color: rule,
    });
  };

  /** `label ......... value` on one row, label left, value right-aligned. */
  const field = (label: string, value: string, column: 0 | 1): void => {
    const half = CONTENT_WIDTH / 2;
    const x = MARGIN + column * (half + 8);
    page.drawText(latin1(label), { x, y, size: SIZE_SMALL, font: regular, color: muted });
    page.drawText(latin1(value === "" ? "-" : value), {
      x: x + 92,
      y,
      size: SIZE_BODY,
      font: regular,
      color: ink,
    });
  };

  const sectionTitle = (label: string): void => {
    need(LINE * 2);
    y -= LINE * 0.6;
    text(label.toUpperCase(), { font: "bold", size: SIZE_HEAD });
    y -= 5;
    hr();
    y -= LINE;
  };

  // ── Company header ────────────────────────────────────────────────────────
  text(input.company.legal_name, { font: "bold", size: SIZE_TITLE });
  y -= LINE * 1.2;
  if (input.company.trade_name !== null && input.company.trade_name !== input.company.legal_name) {
    text(input.company.trade_name, { size: SIZE_BODY, color: muted });
    y -= LINE;
  }
  for (const line of input.company.address_lines) {
    text(line, { size: SIZE_SMALL, color: muted });
    y -= LINE * 0.8;
  }
  const regs = [
    input.company.pan === null ? null : `PAN ${input.company.pan}`,
    input.company.tan === null ? null : `TAN ${input.company.tan}`,
    input.company.pf_establishment_code === null
      ? null
      : `PF ${input.company.pf_establishment_code}`,
    input.company.esi_establishment_code === null
      ? null
      : `ESI ${input.company.esi_establishment_code}`,
  ].filter((v): v is string => v !== null);
  if (regs.length > 0) {
    text(regs.join("   ·   "), { size: SIZE_SMALL, color: muted });
    y -= LINE * 0.8;
  }

  y -= LINE * 0.6;
  hr();
  y -= LINE * 1.4;

  text(`Payslip — ${input.payslip.period_name}`, { font: "bold", size: SIZE_HEAD + 1 });
  rightText(input.payslip.payslip_number, PAGE_WIDTH - MARGIN, { font: "bold", size: SIZE_HEAD });
  y -= LINE;
  text(
    `Period ${input.payslip.period_start} to ${input.payslip.period_end}   ·   Pay date ${input.payslip.pay_date}`,
    { size: SIZE_SMALL, color: muted },
  );
  rightText(`Run ${input.payslip.run_number}`, PAGE_WIDTH - MARGIN, {
    size: SIZE_SMALL,
    color: muted,
  });
  y -= LINE;

  // ── Employee ──────────────────────────────────────────────────────────────
  sectionTitle("Employee");
  const empFields: [string, string][] = [
    ["Employee code", input.employee.employee_code],
    ["Name", input.employee.display_name],
    ["Designation", input.employee.designation ?? ""],
    ["Department", input.employee.department ?? ""],
    ["Location", input.employee.location ?? ""],
    ["Date of joining", input.employee.date_of_join ?? ""],
    ["Payment mode", input.employee.payment_mode.replace(/_/g, " ")],
    ["Bank", input.employee.bank_name ?? ""],
    ["Account", input.employee.bank_account_masked ?? ""],
    ["IFSC", input.employee.bank_ifsc ?? ""],
    ["UAN", input.employee.uan ?? ""],
    ["PF number", input.employee.pf_number ?? ""],
    ["ESI number", input.employee.esi_number ?? ""],
    // Statutory identifiers are MASKED on the printed payslip (§6 masking):
    // the employee knows their own PAN; a payslip forwarded to a landlord or a
    // loan agent should not carry it in full.
    ["PAN", input.employee.pan_masked ?? ""],
  ];
  for (let i = 0; i < empFields.length; i += 2) {
    need(LINE);
    const left = empFields[i] as [string, string];
    field(left[0], left[1], 0);
    const right = empFields[i + 1];
    if (right !== undefined) field(right[0], right[1], 1);
    y -= LINE;
  }

  // ── Attendance ────────────────────────────────────────────────────────────
  const days = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  sectionTitle("Attendance for the period");
  const attFields: [string, string][] = [
    ["Period days", days(input.payslip.period_days)],
    ["Paid days", days(input.payslip.paid_days)],
    ["Present days", days(input.payslip.present_days)],
    ["Loss of pay", days(input.payslip.lop_days)],
    ["Weekly offs", days(input.payslip.weekly_off_days)],
    ["Holidays", days(input.payslip.holiday_days)],
    ["Paid leave", days(input.payslip.leave_days_paid)],
    ["Unpaid leave", days(input.payslip.leave_days_unpaid)],
    ["Approved OT", `${Math.floor(input.payslip.overtime_minutes / 60)}h ${
      input.payslip.overtime_minutes % 60
    }m`],
    ["Late deduction", days(input.payslip.late_deduction_days)],
  ];
  for (let i = 0; i < attFields.length; i += 2) {
    need(LINE);
    const left = attFields[i] as [string, string];
    field(left[0], left[1], 0);
    const right = attFields[i + 1];
    if (right !== undefined) field(right[0], right[1], 1);
    y -= LINE;
  }

  // ── Line tables ───────────────────────────────────────────────────────────
  const colFull = MARGIN + 250;
  const colAmount = MARGIN + 360;
  const colYtd = PAGE_WIDTH - MARGIN;

  const tableHeader = (): void => {
    need(LINE * 2);
    text("Description", { font: "bold", size: SIZE_SMALL, color: muted });
    rightText("Full month", colFull, { font: "bold", size: SIZE_SMALL, color: muted });
    rightText("This period", colAmount, { font: "bold", size: SIZE_SMALL, color: muted });
    rightText("Year to date", colYtd, { font: "bold", size: SIZE_SMALL, color: muted });
    y -= 5;
    hr();
    y -= LINE;
  };

  const lineRow = (line: PayslipLineInput): void => {
    need(LINE);
    const marks: string[] = [];
    if (line.is_prorated) marks.push("prorated");
    if (line.is_arrear) marks.push("arrear");
    const label = marks.length > 0
      ? `${line.label} (${marks.join(", ")})`
      : line.label;
    text(label);
    rightText(formatPaise(line.full_month_amount_paise), colFull);
    rightText(formatPaise(line.amount_paise), colAmount);
    rightText(formatPaise(line.ytd_amount_paise), colYtd);
    y -= LINE;
  };

  const totalRow = (label: string, paise: number): void => {
    need(LINE * 1.6);
    y -= 2;
    hr();
    y -= LINE;
    text(label, { font: "bold" });
    rightText(formatRupees(paise), colAmount, { font: "bold" });
    y -= LINE;
  };

  const byKind = (...kinds: string[]): PayslipLineInput[] =>
    input.lines
      .filter((l) => kinds.includes(l.line_kind))
      .sort((a, b) => a.sequence - b.sequence);

  const earnings = byKind("earning", "arrear", "reimbursement");
  const deductions = byKind("deduction", "recovery");
  const employer = byKind("employer_contribution");
  const informational = byKind("informational");

  sectionTitle("Earnings");
  tableHeader();
  if (earnings.length === 0) {
    text("No earning lines.", { color: muted });
    y -= LINE;
  } else {
    for (const line of earnings) lineRow(line);
  }
  totalRow("Gross earnings", input.payslip.gross_earnings_paise);

  sectionTitle("Deductions");
  tableHeader();
  if (deductions.length === 0) {
    text("No deductions.", { color: muted });
    y -= LINE;
  } else {
    for (const line of deductions) lineRow(line);
  }
  totalRow("Total deductions", input.payslip.total_deductions_paise);

  // ── Net pay ───────────────────────────────────────────────────────────────
  need(LINE * 4);
  y -= LINE * 0.6;
  page.drawRectangle({
    x: MARGIN,
    y: y - 6,
    width: CONTENT_WIDTH,
    height: LINE * 2.1,
    color: rgb(0.95, 0.95, 0.96),
  });
  y += 2;
  text("NET PAY", { x: MARGIN + 8, font: "bold", size: SIZE_HEAD });
  rightText(formatRupees(input.payslip.net_pay_paise), PAGE_WIDTH - MARGIN - 8, {
    font: "bold",
    size: SIZE_HEAD + 1,
  });
  y -= LINE;
  text(input.payslip.net_pay_words, { x: MARGIN + 8, size: SIZE_SMALL, color: muted });
  y -= LINE * 1.8;

  if (employer.length > 0) {
    sectionTitle("Employer contributions (not part of net pay)");
    tableHeader();
    for (const line of employer) lineRow(line);
    totalRow("Total employer contributions", input.payslip.employer_contributions_paise);
  }

  if (informational.length > 0) {
    sectionTitle("For information only");
    tableHeader();
    for (const line of informational) lineRow(line);
  }

  // ── YTD ───────────────────────────────────────────────────────────────────
  sectionTitle("Year to date (this financial year, including this payslip)");
  const ytdFields: [string, string][] = [
    ["Gross", formatRupees(input.payslip.ytd_gross_paise)],
    ["Deductions", formatRupees(input.payslip.ytd_deductions_paise)],
    ["Net paid", formatRupees(input.payslip.ytd_net_paise)],
    ["TDS", formatRupees(input.payslip.ytd_tds_paise)],
  ];
  for (let i = 0; i < ytdFields.length; i += 2) {
    need(LINE);
    const left = ytdFields[i] as [string, string];
    field(left[0], left[1], 0);
    const right = ytdFields[i + 1];
    if (right !== undefined) field(right[0], right[1], 1);
    y -= LINE;
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  need(LINE * 4);
  y -= LINE * 0.6;
  hr();
  y -= LINE;
  text(
    "This is a computer-generated payslip. Amounts are in Indian Rupees. Employer contributions are shown for information and are not part of net pay.",
    { size: SIZE_SMALL, color: muted },
  );
  y -= LINE * 0.85;
  text(`Verify: ${input.verifyUrl}`, { size: SIZE_SMALL, color: muted });
  y -= LINE * 0.85;
  text(
    `Payslip id ${input.payslip.id}   ·   generated ${input.generatedAtIst} IST`,
    { size: SIZE_SMALL, color: muted },
  );

  const bytes = await doc.save();
  return { bytes, pageCount: doc.getPageCount() };
}
