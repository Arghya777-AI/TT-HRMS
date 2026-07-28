/**
 * exportReport.ts — the ONE way a report leaves this app as a file.
 *
 * WHAT IT TAKES AND WHAT IT REFUSES
 * ---------------------------------
 * It takes DATA — the same rows the screen was handed — plus a column spec. It never
 * reads the DOM. Scraping the rendered table would export whatever the grid happened
 * to be paginating, with the sort the user last clicked and the columns their
 * viewport happened not to hide (`DataGridColumn.hideBelow`), which is how a report
 * ends up disagreeing with the screen it was taken from. Rows in, file out.
 *
 * It REQUIRES the {@link AnalyticsFilters} that produced the rows. Not optional: a
 * printed page showing "Late arrivals: 41" with no period and no department on it is
 * worthless in a meeting and dangerous in a file — nobody downstream can tell it from
 * a different, wrong 41. A snapshot report with no natural period passes
 * `periodFor("day", istToday())` and says so on the page.
 *
 * TWO FORMATS, AND ONE OF THEM IS HONEST ABOUT ITS NAME
 * ----------------------------------------------------
 * `format: "csv"` emits **UTF-8 CSV with a byte-order mark — NOT a real .xlsx**. The
 * BOM is what makes Excel open it as a spreadsheet with the encoding right on a
 * double-click (without it Excel reads UTF-8 as Windows-1252 and every em dash, ₹ and
 * name with a diacritic arrives mangled). Anyone reading this file later should know
 * exactly what they are shipping: it is a text file that Excel is friendly to, it has
 * no sheets, no column widths, no number formats and no frozen header row.
 *
 * WOULD A TRUE .xlsx BE WORTH A DEPENDENCY? Considered and declined, for now. The
 * candidates are `xlsx`/SheetJS (~1 MB of parser this app would never use, and the
 * npm-published builds have a documented history of prototype-pollution and ReDoS
 * advisories) or `exceljs` (~700 kB, pulls a zip stack). What they would buy over
 * this file is column widths, a bold header row and real number cells. Against that:
 * every figure in this product is a SERVER-COMPUTED, ALREADY-FORMATTED string by
 * design (frontend-contract §5 — the browser never re-derives a business number), so
 * "real number cells" would mean shipping raw values that no longer match the screen,
 * which is the opposite of what an export is for. If a client ever needs a workbook
 * they can pivot — several sheets, live formulas — that is a SERVER-side render next
 * to the `export_log` row, not a browser dependency. Until somebody asks, CSV ships,
 * and PDF is the format for anything meant to be read rather than re-sliced.
 *
 * WHAT THIS IS NOT — READ BEFORE WIRING IT TO A NEW SCREEN
 * -------------------------------------------------------
 * §14 (/admin/analytics/exports) draws a hard line: a PII EGRESS is only sanctioned
 * through a server function that writes the `export_log` row in the same breath as it
 * produces the file, so the register can never disagree with reality. This engine
 * writes no register row, no content hash and no row count anywhere. So it is for
 * GOVERNED ANALYTICS OUTPUT the user is already looking at — aggregates and day rows
 * from the `v_*` views, under their own RLS scope. It is NOT for the statutory
 * registers, not for salary-bearing extracts, and not for a bulk dump of the employee
 * master; those keep going through `export-audit` and whatever joins it. The one
 * defence it does own is that a browser-built CSV is a real injection surface, and
 * that is handled below rather than assumed away.
 *
 * jspdf and jspdf-autotable are imported DYNAMICALLY, never at module scope: together
 * they are ~350 kB and this module is imported by ordinary analytics screens. The
 * same rule the kiosk's face pipeline follows for `@vladmandic/face-api`.
 */
import {
  EM_DASH,
  dash,
  formatDays,
  formatDaysFixed,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { formatPaise } from "@/lib/money";
import {
  fmtCivilDate,
  fmtCivilDateWeekday,
  fmtCivilMonth,
  fmtCivilTime,
  fmtDateTime,
  fmtDuration,
  fmtDurationHm,
  fmtMonthLong,
  nowInstantIso,
} from "@/lib/datetime";
import type { Period } from "@/lib/period";
import type { AnalyticsFilters, SourceFilter } from "@/lib/analyticsFilters";
import { t, type MessageKey } from "@/shared/i18n/en";

// -----------------------------------------------------------------------------
// The column spec — data-shaped, never DOM-shaped
// -----------------------------------------------------------------------------

export type ExportFormat = "pdf" | "csv";

export type ColumnAlign = "left" | "center" | "right";

/**
 * How a cell is rendered. Each case delegates to the repo's ONE formatter for that
 * kind of value, so the file and the screen cannot drift: '2,20,000' stays Indian
 * grouped, '7:50' stays h:mm, money stays integer paise routed through money.ts.
 */
export type ColumnFormat =
  | "text"
  | "number"
  | "percent"
  | "days"
  | "daysFixed"
  /** Minutes → '7:50'. */
  | "duration"
  /** Minutes → '7h 50m'. */
  | "durationHm"
  /** INTEGER PAISE → '₹1,10,000'. Never a float amount. */
  | "paise"
  /** Postgres `date` 'YYYY-MM-DD' → '25-Jul-2026'. */
  | "date"
  | "dateWeekday"
  /** timestamptz → '25-Jul-2026 09:05 IST'. */
  | "dateTime"
  /** Postgres `time` → '09:30'. */
  | "time"
  /** 'YYYY-MM' → 'Jul-2026'. */
  | "month"
  | "boolean";

/** Formats whose values are figures, and so default to right alignment. */
const NUMERIC_FORMATS: ReadonlySet<ColumnFormat> = new Set<ColumnFormat>([
  "number",
  "percent",
  "days",
  "daysFixed",
  "duration",
  "durationHm",
  "paise",
]);

export interface ExportColumn<Row> {
  /** Field name on the row. Also the column's identity in the spec. */
  readonly key: string;
  /** Human label — never a raw DB column name (D-10/11). Already through `t()`. */
  readonly header: string;
  /** Defaults to right for numeric formats, left otherwise. */
  readonly align?: ColumnAlign;
  /**
   * A named format, or a function for a composite cell ("Anita R. (TT-0142)").
   * The function receives the whole row, so a derived cell never needs a
   * pre-flattened copy of the data.
   */
  readonly format?: ColumnFormat | ((row: Row) => string);
}

/**
 * Display names for the filter IDs. `AnalyticsFilters` holds IDs, deliberately — a
 * department can be renamed and two locations can hold departments with the same
 * name — so the caller, which already loaded the pick-lists, supplies the labels.
 * An unresolved ID still prints (as the ID): an active filter that is silently
 * omitted from the header turns a narrowed report into a lie about the whole venue.
 */
export interface DimensionLabels {
  readonly department?: string;
  readonly location?: string;
  readonly employee?: string;
}

export interface ExportReportInput<Row> {
  readonly title: string;
  readonly subtitle?: string;
  readonly columns: readonly ExportColumn<Row>[];
  readonly rows: readonly Row[];
  readonly format: ExportFormat;
  /** Base name; the extension is appended and the name is sanitised. */
  readonly filename: string;
  /** The question these rows answer. Required — see the file header. */
  readonly filters: AnalyticsFilters;
  readonly labels?: DimensionLabels;
  /** Overridable so a test is not racing the clock. Defaults to now. */
  readonly generatedAt?: string;
  /**
   * CSV only. The heading block is a preamble above the column row, which is right
   * for a person opening it in Excel and wrong for a script parsing it. Default true.
   */
  readonly includeMeta?: boolean;
  /** Set false to get the artifact without touching the DOM (tests, or re-upload). */
  readonly download?: boolean;
}

export interface ExportArtifact {
  readonly filename: string;
  readonly mimeType: string;
  readonly blob: Blob;
}

/** One line of the report heading: a label and its value, rendered by both writers. */
export interface HeadingLine {
  readonly label: string;
  readonly value: string;
}

// -----------------------------------------------------------------------------
// Value → text
// -----------------------------------------------------------------------------

/**
 * A cell value as a number, or null.
 *
 * Numeric strings are accepted on purpose: PostgREST serialises `numeric` columns as
 * JSON strings to preserve precision, so `payable_worked_minutes` can arrive as
 * "450" from one view and 450 from another. Both must print the same.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number") return String(value);
  return null;
}

/** timestamptz → display. A malformed instant must not abort a 5,000-row export. */
function safeDateTime(value: unknown): string {
  const s = asString(value);
  if (s === null) return EM_DASH;
  try {
    return fmtDateTime(s);
  } catch {
    return EM_DASH;
  }
}

function formatCell(value: unknown, format: ColumnFormat): string {
  switch (format) {
    case "number":
      return formatNumber(asNumber(value));
    case "percent":
      return formatPercent(asNumber(value));
    case "days":
      return formatDays(asNumber(value));
    case "daysFixed":
      return formatDaysFixed(asNumber(value));
    case "duration":
      return fmtDuration(asNumber(value));
    case "durationHm":
      return fmtDurationHm(asNumber(value));
    case "paise":
      return formatPaise(asNumber(value), { fallback: EM_DASH });
    case "date":
      return fmtCivilDate(asString(value));
    case "dateWeekday":
      return fmtCivilDateWeekday(asString(value));
    case "dateTime":
      return safeDateTime(value);
    case "time":
      return fmtCivilTime(asString(value));
    case "month":
      return fmtCivilMonth(asString(value));
    case "boolean":
      if (value === null || value === undefined) return EM_DASH;
      return value === true || value === "true" ? t("common.yes") : t("common.no");
    case "text":
      return dash(value === null || value === undefined ? null : String(value));
  }
}

/**
 * Read one cell off a row.
 *
 * The single sanctioned cast in this module: a report row is addressed by column key,
 * and TypeScript cannot know an arbitrary caller-supplied `Row` carries a string
 * index. Nothing is invented by it — a key the row does not have reads as `undefined`
 * and renders as an em dash, exactly like any other blank.
 */
function cellText<Row>(row: Row, column: ExportColumn<Row>): string {
  if (typeof column.format === "function") return column.format(row);
  const value = (row as unknown as Record<string, unknown>)[column.key];
  return formatCell(value, column.format ?? "text");
}

function alignOf<Row>(column: ExportColumn<Row>): ColumnAlign {
  if (column.align !== undefined) return column.align;
  return typeof column.format === "string" && NUMERIC_FORMATS.has(column.format)
    ? "right"
    : "left";
}

// -----------------------------------------------------------------------------
// The heading — period and filters, in both writers
// -----------------------------------------------------------------------------

const SOURCE_LABEL_KEY: Readonly<Record<Exclude<SourceFilter, "all">, MessageKey>> = {
  web: "analytics.export.source.web",
  kiosk_face: "analytics.export.source.kiosk_face",
  mobile: "analytics.export.source.mobile",
  import: "analytics.export.source.import",
  manual: "analytics.export.source.manual",
};

/**
 * The period, said the way the filter bar says it: '25-Jul-2026 (Sat)',
 * 'July 2026', 'Year 2026', 'Week of 20-Jul-2026 – 26-Jul-2026'.
 *
 * Exported because it is the line the whole report is judged against, and because a
 * caller putting the same period in a toast or a filename must not spell it a second
 * way. Every date goes through datetime.ts — a period bound is an IST civil date
 * string, never an instant, and must never be routed through `new Date()`.
 */
export function periodLabel(period: Period): string {
  switch (period.granularity) {
    case "day":
      return fmtCivilDateWeekday(period.from);
    case "week":
      return t("analytics.export.period.week", {
        from: fmtCivilDate(period.from),
        to: fmtCivilDate(period.to),
      });
    case "month":
      return fmtMonthLong(period.from.slice(0, 7));
    case "year":
      return t("analytics.export.period.year", { year: period.from.slice(0, 4) });
    case "range":
      return t("analytics.export.period.range", {
        from: fmtCivilDate(period.from),
        to: fmtCivilDate(period.to),
      });
  }
}

/** Active dimensions as heading lines; one positive line when none are set. */
export function filterLines(
  filters: AnalyticsFilters,
  labels: DimensionLabels = {},
): readonly HeadingLine[] {
  const lines: HeadingLine[] = [];
  if (filters.departmentId !== undefined) {
    lines.push({
      label: t("analytics.export.filter.department"),
      value: labels.department ?? filters.departmentId,
    });
  }
  if (filters.locationId !== undefined) {
    lines.push({
      label: t("analytics.export.filter.location"),
      value: labels.location ?? filters.locationId,
    });
  }
  if (filters.employeeId !== undefined) {
    lines.push({
      label: t("analytics.export.filter.employee"),
      value: labels.employee ?? filters.employeeId,
    });
  }
  if (filters.source !== "all") {
    lines.push({
      label: t("analytics.export.filter.source"),
      value: t(SOURCE_LABEL_KEY[filters.source]),
    });
  }
  if (lines.length === 0) {
    lines.push({
      label: t("analytics.export.filter.filters"),
      value: t("analytics.export.filter.none"),
    });
  }
  return lines;
}

export interface ReportMeta {
  readonly title: string;
  readonly subtitle?: string;
  readonly filters: AnalyticsFilters;
  readonly labels?: DimensionLabels;
  readonly rowCount: number;
  /** ISO instant. */
  readonly generatedAt: string;
}

/**
 * The heading block, identical in the PDF and at the top of the CSV. Both writers
 * render this same list, so the two files can never state different periods for the
 * same export — which they would within a month if each built its own header.
 */
export function reportHeading(meta: ReportMeta): readonly HeadingLine[] {
  const lines: HeadingLine[] = [{ label: t("analytics.export.meta.report"), value: meta.title }];
  if (meta.subtitle !== undefined && meta.subtitle !== "") {
    lines.push({ label: t("analytics.export.meta.scope"), value: meta.subtitle });
  }
  lines.push({ label: t("analytics.export.meta.period"), value: periodLabel(meta.filters.period) });
  lines.push(...filterLines(meta.filters, meta.labels));
  lines.push({ label: t("analytics.export.meta.rows"), value: formatNumber(meta.rowCount) });
  // IST, and it says IST — a timestamp on a printed report that could be read in two
  // zones is worse than none, and this venue's whole clock is Asia/Kolkata.
  lines.push({
    label: t("analytics.export.meta.generated"),
    value: safeDateTime(meta.generatedAt),
  });
  return lines;
}

// -----------------------------------------------------------------------------
// CSV — UTF-8 with a BOM. Excel-friendly text, not a workbook.
// -----------------------------------------------------------------------------

/** U+FEFF. Excel only reads a UTF-8 CSV correctly when it opens with this. */
export const UTF8_BOM = "\ufeff";

/** RFC 4180, and the ending Excel is happiest with. */
const CRLF = "\r\n";

/**
 * The characters that make a spreadsheet treat a cell as a FORMULA rather than text.
 * `=` and `+` are the obvious two; `-` and `@` are equally live; a leading TAB or CR
 * is the classic way to sneak past a naive check because the app strips it first.
 * The payload people actually use is `=cmd|' /C calc'!A0` — remote code, in a cell.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** A bare number: '-5', '1234.5'. Not a formula, and must stay a number in Excel. */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * One CSV field: quoted per RFC 4180 and neutralised against CSV injection.
 *
 * WHY THE APOSTROPHE AND NOT JUST QUOTES. Quoting is NOT a defence: Excel evaluates
 * `"=1+1"` as happily as `=1+1`. The only thing that reliably demotes a cell to text
 * is a leading `'`, which Excel consumes on open. So the two jobs are done
 * separately — the apostrophe stops the formula, the quotes preserve the delimiters.
 *
 * WHY THE PLAIN-NUMBER EXEMPTION. Every negative figure in an attendance report
 * starts with `-`. Prefixing all of them would make '-5' arrive as text, so the
 * column would not sum — a broken report to defend against nothing, since '-5' is
 * not executable. Anything else leading with `-` (including '-0:15', and certainly
 * `-2+3+cmd|…`) is neutralised.
 *
 * WHY ONLY SPACES ARE TRIMMED BEFORE THE TEST. ' =cmd…' is inert in Excel but live
 * in other spreadsheets, and a display_name is attacker-controlled — so leading
 * spaces are looked through. Leading TAB and CR are NOT looked through: they are
 * themselves in the dangerous set, precisely because stripping them is the standard
 * way a check gets bypassed. Trimming `\s` would have re-opened that hole.
 */
export function csvCell(raw: string): string {
  // Spaces, non-breaking spaces and a stray BOM — written as escapes, because an
  // invisible character inside a security-relevant regex is unreviewable.
  const probe = raw.replace(/^[ \u00a0\ufeff]+/, "");
  const isFormula = FORMULA_LEAD.test(probe) && !PLAIN_NUMBER.test(probe);
  const body = isFormula ? `'${raw}` : raw;
  const needsQuotes = isFormula || /[",\r\n]/.test(body) || body !== body.trim();
  return needsQuotes ? `"${body.replace(/"/g, '""')}"` : body;
}

const csvRow = (cells: readonly string[]): string => cells.map(csvCell).join(",");

/**
 * Rows formatted per turn of the event loop.
 *
 * 500 is enough that the yield overhead is noise on a small export and small enough
 * that a 50,000-row register never holds the main thread for more than a few ms at a
 * time. The alternative — a Web Worker — would mean copying the whole result set
 * across the boundary and duplicating every formatter there, to save a few frames.
 */
const CHUNK_ROWS = 500;

/** Hand the browser back the thread. `setTimeout(0)` is enough; this is not a race. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export interface BuildCsvInput<Row> {
  readonly columns: readonly ExportColumn<Row>[];
  readonly rows: readonly Row[];
  readonly meta?: ReportMeta;
}

/**
 * The CSV text, BOM included. Async and chunked — see {@link CHUNK_ROWS}.
 *
 * Blank cells carry the screen's em dash rather than an empty field, because this is
 * a report of what was displayed, not a data feed; that single non-ASCII character is
 * also why the BOM is not optional.
 */
export async function buildCsv<Row>(input: BuildCsvInput<Row>): Promise<string> {
  const { columns, rows, meta } = input;
  const lines: string[] = [];

  if (meta !== undefined) {
    for (const line of reportHeading(meta)) lines.push(csvRow([line.label, line.value]));
    // A blank line, so Excel's import guesser starts the table at the header row
    // rather than folding the preamble into it.
    lines.push("");
  }

  lines.push(csvRow(columns.map((c) => c.header)));

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue; // noUncheckedIndexedAccess; a sparse array cannot print.
    lines.push(csvRow(columns.map((c) => cellText(row, c))));
    if ((i + 1) % CHUNK_ROWS === 0) await yieldToEventLoop();
  }

  // Trailing CRLF: some importers drop a file's last line when it is unterminated.
  return `${UTF8_BOM}${lines.join(CRLF)}${CRLF}`;
}

// -----------------------------------------------------------------------------
// PDF — jspdf + jspdf-autotable, dynamically imported
// -----------------------------------------------------------------------------

/** Beyond this many columns a portrait A4 crushes the text; turn the page. */
const LANDSCAPE_COLUMN_THRESHOLD = 6;

const PAGE_MARGIN = 36; // pt — half an inch.

async function buildPdfBlob<Row>(
  columns: readonly ExportColumn<Row>[],
  rows: readonly Row[],
  meta: ReportMeta,
): Promise<Blob> {
  // Dynamic, and in parallel: ~350 kB that must never reach the entry graph.
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const autoTable = autoTableModule.default;

  const doc = new jsPDF({
    orientation: columns.length > LANDSCAPE_COLUMN_THRESHOLD ? "landscape" : "portrait",
    unit: "pt",
    format: "a4",
  });
  doc.setProperties({
    title: meta.title,
    subject: periodLabel(meta.filters.period),
    creator: t("app.name"),
  });

  const heading = reportHeading(meta);
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  // jspdf types `splitTextToSize` as returning `any`; it returns the wrapped lines.
  const titleLines = doc.splitTextToSize(meta.title, pageWidth - PAGE_MARGIN * 2) as string[];

  // The heading is drawn on EVERY page, not just the first. A report is read one page
  // at a time and photocopied a page at a time; page 3 on its own must still say what
  // period and which department it is about, or it is the same worthless page as one
  // with no period at all.
  const headingTop = PAGE_MARGIN + 12;
  const titleBottom = headingTop + titleLines.length * 16;
  const headingBottom = titleBottom + heading.length * 11 + 8;

  const drawHeading = (): void => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(titleLines, PAGE_MARGIN, headingTop);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90);
    heading.forEach((line, i) => {
      doc.text(`${line.label}: ${line.value}`, PAGE_MARGIN, titleBottom + i * 11);
    });

    doc.setDrawColor(200);
    doc.setLineWidth(0.5);
    doc.line(PAGE_MARGIN, headingBottom - 4, pageWidth - PAGE_MARGIN, headingBottom - 4);
  };

  const body =
    rows.length === 0
      ? // An empty result is a finding — it prints as a sentence, not as a table with
        // nothing under it, which reads as a broken export.
        [
          [
            {
              content: t("analytics.export.noRows"),
              colSpan: columns.length,
              styles: { halign: "center" as const, textColor: 120 },
            },
          ],
        ]
      : rows.map((row) => columns.map((c) => cellText(row, c)));

  const columnStyles: Record<string, { halign: ColumnAlign }> = {};
  columns.forEach((c, i) => {
    columnStyles[String(i)] = { halign: alignOf(c) };
  });

  autoTable(doc, {
    head: [columns.map((c) => c.header)],
    body,
    startY: headingBottom,
    margin: { top: headingBottom, right: PAGE_MARGIN, bottom: PAGE_MARGIN + 12, left: PAGE_MARGIN },
    styles: { font: "helvetica", fontSize: 8, cellPadding: 3, overflow: "linebreak" },
    headStyles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [246, 247, 249] },
    columnStyles,
    // Repeated on every page break, which is what keeps the period on page 3.
    didDrawPage: () => {
      drawHeading();
    },
  });

  // Page numbers last: "of N" is unknowable while the table is still paginating.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(130);
    doc.text(
      t("analytics.export.page", { page: p, pages }),
      pageWidth - PAGE_MARGIN,
      pageHeight - PAGE_MARGIN + 10,
      { align: "right" },
    );
  }

  return doc.output("blob");
}

// -----------------------------------------------------------------------------
// Delivery
// -----------------------------------------------------------------------------

/**
 * A filename that is safe to hand to a browser.
 *
 * Report names carry user data — an employee's name, a department, a note somebody
 * typed — so this is untrusted input on a path. Path separators, control characters
 * and leading dots are stripped rather than escaped, and the extension is ours.
 */
export function safeFilename(name: string, format: ExportFormat): string {
  const stem = name
    .replace(/\.(csv|pdf|xlsx|xls|txt)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    // No report name needs '..'; collapsing it means nothing downstream ever has to
    // reason about whether a traversal survived the separator strip above.
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return `${stem === "" ? "report" : stem}.${format === "pdf" ? "pdf" : "csv"}`;
}

/**
 * Hand the file to the browser. Object URL rather than a data: URI — a data URI of a
 * 50,000-row CSV is a multi-megabyte string in the address bar and Safari refuses it.
 * The URL is revoked on the next tick, after the click has been dispatched.
 */
function triggerDownload(artifact: ExportArtifact): void {
  const url = URL.createObjectURL(artifact.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * Build a report file from ROWS and hand it to the browser.
 *
 * Async throughout: the PDF libraries are fetched on demand, and the CSV formatting
 * pass yields between chunks so a large export never freezes the tab. One honest
 * caveat — autotable's own layout pass is synchronous and cannot be chunked without a
 * worker, so a very large PDF will still block for a beat. That is a reason to offer
 * CSV for bulk, not a reason to pretend otherwise.
 *
 * Returns the artifact so a caller can also log, preview or re-upload it.
 */
export async function exportReport<Row>(input: ExportReportInput<Row>): Promise<ExportArtifact> {
  const {
    title,
    subtitle,
    columns,
    rows,
    format,
    filename,
    filters,
    labels,
    generatedAt,
    includeMeta = true,
    download = true,
  } = input;

  const meta: ReportMeta = {
    title,
    ...(subtitle === undefined ? {} : { subtitle }),
    filters,
    ...(labels === undefined ? {} : { labels }),
    rowCount: rows.length,
    generatedAt: generatedAt ?? nowInstantIso(),
  };

  const artifact: ExportArtifact =
    format === "pdf"
      ? {
          filename: safeFilename(filename, "pdf"),
          mimeType: "application/pdf",
          blob: await buildPdfBlob(columns, rows, meta),
        }
      : {
          filename: safeFilename(filename, "csv"),
          mimeType: "text/csv;charset=utf-8",
          blob: new Blob(
            [await buildCsv({ columns, rows, ...(includeMeta ? { meta } : {}) })],
            // The charset is declared here as well as by the BOM: some browsers hand
            // the type straight to the OS, which is what picks the opening app.
            { type: "text/csv;charset=utf-8" },
          ),
        };

  if (download) triggerDownload(artifact);
  return artifact;
}
