/**
 * xlsx.ts — a real Excel workbook, with no dependency.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
 * `exportReport.ts` ships CSV-with-a-BOM and says so honestly: "it is a text file that Excel is
 * friendly to, it has no sheets, no column widths, no number formats and no frozen header row
 * … if a client ever needs a workbook they can pivot — several sheets, live formulas — that is
 * a SERVER-side render". A client has now asked for exactly that: attendance day by day inside
 * a month, month by month inside a year, a week at a time, with the leave and hours arithmetic
 * beside it. That is three tables per file, and three tables is what a workbook is FOR.
 *
 * The server-side render remains the right answer for a statutory register, and nothing here
 * changes that line — see `exportReport.ts` on `export_log`. This is the same GOVERNED
 * ANALYTICS OUTPUT the CSV writer already serves, in the shape that was asked for.
 *
 * ── AND WHY NOT SheetJS OR exceljs ───────────────────────────────────────────
 * The same reasons that file already records, which have not changed: SheetJS is roughly a
 * megabyte of parser this app would never use and carries a documented history of
 * prototype-pollution and ReDoS advisories, and exceljs pulls a zip stack for ~700 kB. Writing
 * a workbook is a much smaller problem than reading one — a .xlsx is a zip of about six XML
 * parts, and if every entry is STORED rather than deflated there is no compressor to bring in.
 * The whole of it is below, in less code than either dependency's type definitions.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: formulas, merged cells, multiple fonts, themes, charts,
 * images, or reading. If one of those is ever needed, this is the wrong file to grow — that is
 * the point at which the server-side render earns its keep.
 *
 * ── NUMBERS ARE WRITTEN AS NUMBERS ───────────────────────────────────────────
 * The frontend contract says the browser never re-derives a business figure, and it does not:
 * every value here is handed in by the caller, already computed by the server or by the one
 * shared module the screens use. But a workbook exists to be re-sliced, and a column of
 * "8h 00m" strings cannot be summed, averaged or pivoted by the person who asked for it. So a
 * numeric cell carries its number and the header says what the unit is.
 */

// -----------------------------------------------------------------------------
// The public shape
// -----------------------------------------------------------------------------

/** A number writes as a number; a string writes as text; null writes as an empty cell. */
export type XlsxValue = string | number | null;

export interface XlsxColumn {
  readonly header: string;
  /** Approximate character width. Excel's unit is "width of the zero glyph", near enough. */
  readonly width?: number;
}

export interface XlsxSheet {
  readonly name: string;
  readonly columns: readonly XlsxColumn[];
  readonly rows: readonly (readonly XlsxValue[])[];
}

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// -----------------------------------------------------------------------------
// XML
// -----------------------------------------------------------------------------

/** The characters XML 1.0 cannot represent at all. Tab, newline and return are legal. */
const ILLEGAL_XML = new RegExp(
  "[" +
    String.fromCharCode(0) + "-" + String.fromCharCode(8) +
    String.fromCharCode(11) + String.fromCharCode(12) +
    String.fromCharCode(14) + "-" + String.fromCharCode(31) +
    "]",
  "g",
);

/**
 * Escape for XML text and attributes both.
 *
 * Illegal control characters are STRIPPED rather than escaped. XML 1.0 has no representation
 * for them, and Excel rejects the whole workbook as corrupt if one appears — a single stray
 * 0x1A in a pasted remark would otherwise cost the user the entire download with no
 * explanation at all.
 */
export function xmlEscape(raw: string): string {
  return raw
    .replace(ILLEGAL_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 0 → A, 25 → Z, 26 → AA. Excel's column letters are bijective base-26. */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

/**
 * Excel refuses `[ ] : * ? / \` in a sheet name, caps it at 31 characters, and will not open a
 * workbook holding two sheets of the same name. A silently-corrupt download is a far worse
 * outcome than a truncated tab label, so this fixes rather than validates.
 */
export function sheetName(raw: string, taken: readonly string[] = []): string {
  const cleaned = raw.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31);
  const base = cleaned === "" ? "Sheet" : cleaned;
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = ` (${n})`;
    const candidate = base.slice(0, 31 - suffix.length) + suffix;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base.slice(0, 28)}999`;
}

function cellXml(value: XlsxValue, ref: string, styleIndex: number): string {
  const s = styleIndex === 0 ? "" : ` s="${styleIndex}"`;
  if (value === null || value === "") return "";
  if (typeof value === "number") {
    // NaN and Infinity have no cell representation; an empty cell is the honest answer.
    if (!Number.isFinite(value)) return "";
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  /*
    Inline strings rather than a shared-strings table. A shared table is smaller only when
    values repeat heavily, and costs a second pass plus an index nobody here benefits from —
    these sheets are mostly dates, statuses and numbers.
  */
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const cols = sheet.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 14}" customWidth="1"/>`)
    .join("");

  const header = sheet.columns
    .map((c, i) => cellXml(c.header, `${columnLetter(i)}1`, 1))
    .join("");

  const body = sheet.rows
    .map((row, r) => {
      const cells = row.map((v, i) => cellXml(v, `${columnLetter(i)}${r + 2}`, 0)).join("");
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join("");

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    /* The header stays put while somebody scrolls a year of rows. */
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    "</sheetView></sheetViews>" +
    `<cols>${cols}</cols>` +
    `<sheetData><row r="1">${header}</row>${body}</sheetData>` +
    "</worksheet>"
  );
}

/** Two styles: 0 is plain, 1 is the bold header on a light fill. */
const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  "<font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>" +
  '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  "</cellXfs>" +
  /*
    The named "Normal" style. Without it openpyxl warns "workbook contains no default style"
    and applies its own — which means some reader somewhere is guessing, and a reader that
    guesses is a reader that may instead refuse. One line to not find out which.
  */
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

// -----------------------------------------------------------------------------
// ZIP (stored — no compressor, therefore no dependency)
// -----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/**
 * A ZIP with every entry STORED.
 *
 * Deflate would make the file smaller and would mean shipping or writing a compressor. Excel
 * reads stored entries perfectly well, and an attendance workbook is tens of kilobytes of
 * mostly-unique text — the compression this forgoes is not the difference between a usable
 * download and an unusable one.
 *
 * No data descriptors and no zip64: every size is known before the entry is written, and a
 * workbook approaching 4 GB would have failed for other reasons long before.
 */
function zip(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.path);
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;

    const local = [
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0), // flags — no data descriptor
      ...u16(0), // method 0 = stored
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0),
    ];
    parts.push(new Uint8Array(local), nameBytes, entry.bytes);

    central.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0), // extra length
      ...u16(0), // comment length
      ...u16(0), // disk number
      ...u16(0), // internal attrs
      ...u32(0), // external attrs
      ...u32(offset),
      ...Array.from(nameBytes),
    );

    offset += local.length + nameBytes.length + size;
  }

  const centralBytes = new Uint8Array(central);
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralBytes.length),
    ...u32(offset),
    ...u16(0),
  ]);

  const all = [...parts, centralBytes, end];
  const total = all.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// -----------------------------------------------------------------------------
// The workbook
// -----------------------------------------------------------------------------

/**
 * The workbook as BYTES.
 *
 * Separate from the Blob wrapper so the writer can be tested at all: jsdom's `Blob` has no
 * `arrayBuffer()`, so a test that built one could never read back what it had written — and a
 * file-format writer nobody can open in a test is a file-format writer nobody has checked.
 */
export function buildXlsxBytes(sheets: readonly XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("a workbook needs at least one sheet");

  const named: XlsxSheet[] = [];
  for (const sheet of sheets) {
    named.push({ ...sheet, name: sheetName(sheet.name, named.map((s) => s.name)) });
  }

  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    named
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    "</Types>";

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    named
      .map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("") +
    "</sheets></workbook>";

  /* The styles part is the LAST relationship, after every sheet, so the ids line up. */
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    named
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    "</Relationships>";

  return zip([
    { path: "[Content_Types].xml", bytes: enc(contentTypes) },
    { path: "_rels/.rels", bytes: enc(rootRels) },
    { path: "xl/workbook.xml", bytes: enc(workbook) },
    { path: "xl/_rels/workbook.xml.rels", bytes: enc(workbookRels) },
    { path: "xl/styles.xml", bytes: enc(STYLES_XML) },
    ...named.map((s, i) => ({
      path: `xl/worksheets/sheet${i + 1}.xml`,
      bytes: enc(sheetXml(s)),
    })),
  ]);
}

/**
 * The same bytes, wrapped for a download.
 *
 * Copied into a fresh `ArrayBuffer` rather than handed `bytes.buffer`: a `Uint8Array` can be a
 * view over a `SharedArrayBuffer`, which is not a `BlobPart`, and the copy is a few tens of
 * kilobytes once per download.
 */
export function buildXlsx(sheets: readonly XlsxSheet[]): Blob {
  const bytes = buildXlsxBytes(sheets);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: XLSX_MIME });
}
