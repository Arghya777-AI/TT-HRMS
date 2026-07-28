/**
 * exportReport.test.ts
 *
 * The two things worth proving here are not the same kind of thing:
 *
 *  1. CSV ESCAPING IS A SECURITY CONTROL, not cosmetics. A `display_name` reaches
 *     this file straight from a row an employee typed, and a cell that starts with
 *     `=` is code the moment Excel opens it. Every dangerous character gets its own
 *     assertion, including the two that are easy to get wrong: the plain-negative
 *     exemption (so figures still sum) and the leading-space bypass.
 *  2. THE PERIOD MUST REACH THE FILE. A report page with no period on it is
 *     worthless in a meeting, so both writers are checked against the heading —
 *     the CSV by reading the bytes, the PDF by reading the same heading block it
 *     draws (jspdf is dynamically imported and rasterising a PDF to assert on its
 *     text would test jspdf, not this module).
 */
import { describe, expect, it, vi } from "vitest";
import {
  UTF8_BOM,
  buildCsv,
  csvCell,
  exportReport,
  filterLines,
  periodLabel,
  reportHeading,
  safeFilename,
  type ExportColumn,
} from "./exportReport";
import { periodFor } from "./period";
import type { AnalyticsFilters } from "./analyticsFilters";

interface DayRow {
  display_name: string;
  ist_date: string;
  late_minutes: number | null;
  payable_worked_minutes: number;
  cost_paise: number;
}

const COLUMNS: readonly ExportColumn<DayRow>[] = [
  { key: "display_name", header: "Employee" },
  { key: "ist_date", header: "Date", format: "date" },
  { key: "late_minutes", header: "Late", format: "duration" },
  { key: "payable_worked_minutes", header: "Payable", format: "durationHm" },
  { key: "cost_paise", header: "Cost", format: "paise" },
];

const ROW: DayRow = {
  display_name: "Anita Rao",
  ist_date: "2026-07-15",
  late_minutes: 12,
  payable_worked_minutes: 470,
  cost_paise: 22_000_000,
};

const JULY: AnalyticsFilters = { period: periodFor("month", "2026-07-15"), source: "all" };

/** A fixed instant, so the generated-at line is not racing the clock. */
const GENERATED_AT = "2026-07-25T03:35:00.000Z"; // 09:05 IST

/** jsdom's Blob has no `.text()`; FileReader is the portable way in. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("blob read failed"));
    };
    reader.readAsText(blob);
  });
}

/** Let the next macrotask run — the object URL is revoked on a timer. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const META = {
  title: "Late arrivals",
  filters: JULY,
  rowCount: 1,
  generatedAt: GENERATED_AT,
} as const;

// -----------------------------------------------------------------------------
// CSV escaping — RFC 4180
// -----------------------------------------------------------------------------

describe("csvCell escapes every delimiter", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvCell("Anita Rao")).toBe("Anita Rao");
    expect(csvCell("")).toBe("");
  });

  it("quotes a comma", () => {
    expect(csvCell("Rao, Anita")).toBe('"Rao, Anita"');
  });

  it("quotes and doubles an embedded double quote", () => {
    expect(csvCell('Anita "Ani" Rao')).toBe('"Anita ""Ani"" Rao"');
    // A field that is nothing but quotes must still round-trip.
    expect(csvCell('"')).toBe('""""');
  });

  it("quotes newlines — LF, CR and CRLF — so one cell stays one cell", () => {
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("line one\r\nline two")).toBe('"line one\r\nline two"');
    expect(csvCell("tail\r")).toBe('"tail\r"');
  });

  it("quotes leading and trailing spaces rather than losing them", () => {
    expect(csvCell(" padded ")).toBe('" padded "');
  });

  it("handles a value carrying several dangers at once", () => {
    expect(csvCell('=SUM(A1),"x"\n')).toBe('"\'=SUM(A1),""x""\n"');
  });
});

// -----------------------------------------------------------------------------
// CSV injection — the reason this function exists
// -----------------------------------------------------------------------------

describe("csvCell neutralises formula injection", () => {
  it.each(["=", "+", "-", "@", "\t", "\r"])(
    "prefixes a cell starting with %j so the spreadsheet reads it as text",
    (lead) => {
      const out = csvCell(`${lead}cmd|' /C calc'!A0`);
      expect(out.startsWith(`"'${lead}`)).toBe(true);
    },
  );

  it("defuses the canonical DDE payload", () => {
    expect(csvCell("=cmd|' /C calc'!A0")).toBe(`"'=cmd|' /C calc'!A0"`);
  });

  it("defuses a payload hidden behind leading whitespace", () => {
    // Inert in Excel, live elsewhere — and a display_name is attacker-controlled.
    expect(csvCell("   =1+1")).toBe(`"'   =1+1"`);
  });

  it("leaves a plain negative number alone so the column still sums", () => {
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell("-1234.5")).toBe("-1234.5");
  });

  it("still defuses text that merely starts like a negative number", () => {
    expect(csvCell("-0:15")).toBe(`"'-0:15"`);
    expect(csvCell("-2+3+cmd|' /C calc'!A0")).toBe(`"'-2+3+cmd|' /C calc'!A0"`);
  });

  it("neutralises an attacker-supplied employee name end to end", async () => {
    const csv = await buildCsv({
      columns: [{ key: "display_name", header: "Employee" }],
      rows: [{ display_name: "=HYPERLINK(\"http://evil\",\"payslip\")" }],
    });
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""payslip"")"`);
    // The raw formula must not survive anywhere in the file.
    expect(csv).not.toContain("\n=HYPERLINK");
  });
});

// -----------------------------------------------------------------------------
// The file itself
// -----------------------------------------------------------------------------

describe("buildCsv", () => {
  it("opens with the UTF-8 BOM — without it Excel mangles the em dash and ₹", async () => {
    const csv = await buildCsv({ columns: COLUMNS, rows: [ROW] });
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
  });

  it("uses CRLF and terminates the last line", async () => {
    const csv = await buildCsv({ columns: COLUMNS, rows: [ROW] });
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toMatch(/[^\r]\n/);
  });

  it("formats every cell with the repo's helpers, so the file matches the screen", async () => {
    const csv = await buildCsv({ columns: COLUMNS, rows: [ROW] });
    const body = csv.trimEnd().split("\r\n").at(-1) ?? "";
    expect(body).toContain("15-Jul-2026"); // fmtCivilDate, not an ISO date
    expect(body).toContain("0:12"); // fmtDuration
    expect(body).toContain("7h 50m"); // fmtDurationHm
    expect(body).toContain("2,20,000"); // formatPaise → Indian grouping
  });

  it("renders a missing value as the screen's em dash", async () => {
    const csv = await buildCsv({ columns: COLUMNS, rows: [{ ...ROW, late_minutes: null }] });
    expect(csv).toContain("—");
  });

  it("still writes the header row and a truthful count when there are no rows", async () => {
    const csv = await buildCsv({
      columns: COLUMNS,
      rows: [],
      meta: { ...META, rowCount: 0 },
    });
    const lines = csv.replace(UTF8_BOM, "").trimEnd().split("\r\n");
    expect(lines).toContain("Employee,Date,Late,Payable,Cost");
    expect(csv).toContain("Rows,0");
    // Heading, blank separator, header row — and nothing pretending to be data.
    expect(lines.at(-1)).toBe("Employee,Date,Late,Payable,Cost");
  });

  it("omits the heading block when the caller wants machine-readable output", async () => {
    const csv = await buildCsv({ columns: COLUMNS, rows: [ROW] });
    expect(csv).not.toContain("Period");
    expect(csv.replace(UTF8_BOM, "").split("\r\n")[0]).toBe("Employee,Date,Late,Payable,Cost");
  });

  it("survives more rows than one chunk without dropping any", async () => {
    const rows = Array.from({ length: 1_100 }, (_, i) => ({ ...ROW, display_name: `E${String(i)}` }));
    const csv = await buildCsv({ columns: COLUMNS, rows });
    const lines = csv.replace(UTF8_BOM, "").trimEnd().split("\r\n");
    expect(lines).toHaveLength(1_101); // header + 1,100
    expect(lines.at(-1)).toContain("E1099");
  });
});

// -----------------------------------------------------------------------------
// The period label — the line the whole report is judged against
// -----------------------------------------------------------------------------

describe("periodLabel", () => {
  it("names every granularity the way the filter bar does", () => {
    expect(periodLabel(periodFor("day", "2026-07-25"))).toBe("25-Jul-2026 (Sat)");
    expect(periodLabel(periodFor("week", "2026-07-25"))).toBe(
      "Week of 20-Jul-2026 – 26-Jul-2026",
    );
    expect(periodLabel(periodFor("month", "2026-07-15"))).toBe("July 2026");
    expect(periodLabel(periodFor("year", "2026-03-01"))).toBe("Year 2026");
    expect(periodLabel({ granularity: "range", from: "2026-07-01", to: "2026-07-15" })).toBe(
      "01-Jul-2026 – 15-Jul-2026",
    );
  });
});

describe("the period reaches the output", () => {
  it("is in the CSV heading block, with the IST generated-at stamp", async () => {
    const csv = await buildCsv({ columns: COLUMNS, rows: [ROW], meta: META });
    expect(csv).toContain("Period,July 2026");
    expect(csv).toContain("Report,Late arrivals");
    expect(csv).toContain("Generated,25-Jul-2026 09:05 IST");
  });

  it("is in the heading block the PDF draws on every page", () => {
    const heading = reportHeading(META);
    expect(heading).toContainEqual({ label: "Period", value: "July 2026" });
    expect(heading.map((l) => l.label)).toEqual([
      "Report",
      "Period",
      "Filters",
      "Rows",
      "Generated",
    ]);
  });

  it("survives into a delivered .csv artifact", async () => {
    const artifact = await exportReport({
      title: "Late arrivals",
      columns: COLUMNS,
      rows: [ROW],
      format: "csv",
      filename: "late-arrivals",
      filters: JULY,
      generatedAt: GENERATED_AT,
      download: false,
    });
    expect(artifact.filename).toBe("late-arrivals.csv");
    expect(artifact.mimeType).toBe("text/csv;charset=utf-8");
    expect(await readBlob(artifact.blob)).toContain("Period,July 2026");
  });

  it("hands the file to the browser once, with a sanitised name, and leaks no object URL", async () => {
    // jsdom implements neither half of the object-URL API, so both are stubbed.
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const artifact = await exportReport({
      title: "Late arrivals",
      columns: COLUMNS,
      rows: [ROW],
      format: "csv",
      filename: "late arrivals/../../etc/passwd",
      filters: JULY,
      generatedAt: GENERATED_AT,
    });

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(artifact.filename).toBe("late-arrivals-.-.-etc-passwd.csv");
    expect(document.querySelector("a[download]")).toBeNull(); // the anchor is removed

    await nextTick();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");

    click.mockRestore();
    vi.unstubAllGlobals();
  });
});

// -----------------------------------------------------------------------------
// The PDF — the format somebody prints and carries into a meeting
//
// Assertions read the raw PDF bytes. That works because jsPDF writes uncompressed
// content streams by default, so drawn text survives as literal characters; if
// `compress: true` is ever set these three tests are the ones that will go red, and
// the fix is to assert on `reportHeading` instead, not to delete them.
// -----------------------------------------------------------------------------

describe("the PDF carries its own context", () => {
  const pdfColumns: readonly ExportColumn<DayRow>[] = COLUMNS.slice(0, 3);

  async function buildPdf(rows: readonly DayRow[]): Promise<string> {
    const artifact = await exportReport({
      title: "Late arrivals",
      subtitle: "Banquet",
      columns: pdfColumns,
      rows,
      format: "pdf",
      filename: "late-arrivals",
      filters: JULY,
      generatedAt: GENERATED_AT,
      download: false,
    });
    expect(artifact.mimeType).toBe("application/pdf");
    return readBlob(artifact.blob);
  }

  it("repeats the period on EVERY page, not just the first", async () => {
    // 120 rows spills onto three pages; page 3 read on its own must still say
    // which period and which department it is about.
    const rows = Array.from({ length: 120 }, (_, i) => ({ ...ROW, display_name: `E${String(i)}` }));
    const pdf = await buildPdf(rows);
    const pages = pdf.split("/Type /Page\n").length - 1;
    expect(pages).toBeGreaterThan(1);
    expect(pdf.split("July 2026").length - 1).toBeGreaterThanOrEqual(pages);
    expect(pdf).toContain("Page 2 of");
  });

  it("stamps the generated-at time in IST and says so", async () => {
    const pdf = await buildPdf([ROW]);
    expect(pdf).toContain("25-Jul-2026 09:05 IST");
  });

  it("prints an empty result as a sentence rather than an empty table", async () => {
    const pdf = await buildPdf([]);
    expect(pdf).toContain("No rows matched this period and filter.");
  });
});

// -----------------------------------------------------------------------------
// Filters and filenames
// -----------------------------------------------------------------------------

describe("filterLines", () => {
  it("states positively that nothing is filtered", () => {
    expect(filterLines(JULY)).toEqual([
      { label: "Filters", value: "None — all departments, locations and people" },
    ]);
  });

  it("prefers the resolved name and falls back to the id rather than staying silent", () => {
    const filters: AnalyticsFilters = {
      ...JULY,
      departmentId: "11111111-1111-4111-8111-111111111111",
      locationId: "22222222-2222-4222-8222-222222222222",
      source: "kiosk_face",
    };
    expect(filterLines(filters, { department: "Banquet" })).toEqual([
      { label: "Department", value: "Banquet" },
      { label: "Location", value: "22222222-2222-4222-8222-222222222222" },
      { label: "Punch source", value: "Gate tablet (face)" },
    ]);
  });
});

describe("safeFilename", () => {
  it("strips path separators and control characters from a name carrying user data", () => {
    expect(safeFilename("late arrivals/../../etc/passwd", "csv")).toBe(
      "late-arrivals-.-.-etc-passwd.csv",
    );
    expect(safeFilename("report\n\r", "pdf")).toBe("report.pdf");
    expect(safeFilename("", "csv")).toBe("report.csv");
  });

  it("replaces a caller-supplied extension rather than doubling it", () => {
    expect(safeFilename("attendance.csv", "csv")).toBe("attendance.csv");
    expect(safeFilename("attendance.xlsx", "pdf")).toBe("attendance.pdf");
  });
});
