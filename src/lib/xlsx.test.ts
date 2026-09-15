/**
 * The workbook writer, checked by reading its own output back.
 *
 * A file-format writer that is only asserted against its own source strings proves nothing —
 * the failure mode is "Excel says the file is corrupt", and no amount of `toContain("<sheet")`
 * catches that. So these tests parse the ZIP back out of the bytes and read the cells.
 *
 * Every entry is STORED, which is what makes a reader small enough to live in a test: no
 * inflater, just the local header's name and size. If the writer ever starts deflating, this
 * reader stops working — which is the correct outcome, because the claim it exists to check
 * would no longer be the claim being made.
 *
 * ALSO VERIFIED OUTSIDE THIS SUITE, once, against a real implementation: openpyxl opens a
 * workbook from this writer with zero warnings, reports the sheet names, the frozen pane
 * (A2), the bold header and the column widths, and reads 480 / 3.5 / −291 back as numbers
 * rather than text. That is the check this one stands in for on every run.
 */
import { describe, expect, it } from "vitest";
import { buildXlsxBytes, columnLetter, crc32, sheetName, xmlEscape } from "./xlsx";

// -----------------------------------------------------------------------------
// The smallest STORED-zip reader that can prove the point
// -----------------------------------------------------------------------------

function readStoredZip(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    expect(method, "every entry must be STORED for this reader").toBe(0);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const nameAt = at + 30;
    const dataAt = nameAt + nameLen + extraLen;
    const name = new TextDecoder().decode(bytes.subarray(nameAt, nameAt + nameLen));
    out.set(name, new TextDecoder().decode(bytes.subarray(dataAt, dataAt + size)));
    at = dataAt + size;
  }
  return out;
}

/** Every `<c>` of a sheet, as ref → text, so a cell can be asserted by address. */
function cells(sheetXml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(.*?)<\/c>/g)) {
    const ref = m[1] ?? "";
    const body = m[2] ?? "";
    const inline = /<is><t[^>]*>(.*?)<\/t><\/is>/.exec(body);
    const numeric = /<v>(.*?)<\/v>/.exec(body);
    out.set(ref, inline?.[1] ?? numeric?.[1] ?? "");
  }
  return out;
}

const SIMPLE = [
  {
    name: "Day wise",
    columns: [{ header: "Date", width: 18 }, { header: "Status" }, { header: "Worked (minutes)" }],
    rows: [
      ["2026-09-01", "Present", 480],
      ["2026-09-02", "Half day", 240],
      ["2026-09-03", "On leave", null],
    ],
  },
];

describe("column letters", () => {
  it("counts in bijective base-26", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    // 26 is AA, not BA — the trap that puts every cell after the 26th in the wrong column.
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
    expect(columnLetter(51)).toBe("AZ");
    expect(columnLetter(52)).toBe("BA");
    expect(columnLetter(701)).toBe("ZZ");
    expect(columnLetter(702)).toBe("AAA");
  });
});

describe("sheet names are fixed, never rejected", () => {
  it("strips the characters Excel refuses", () => {
    expect(sheetName("Summary/With:Bad*Chars?[x]")).toBe("Summary With Bad Chars x");
  });
  it("caps at 31 characters", () => {
    expect(sheetName("x".repeat(60))).toHaveLength(31);
  });
  it("never repeats a name, because a duplicate will not open", () => {
    const a = sheetName("Summary");
    const b = sheetName("Summary", [a]);
    const c = sheetName("Summary", [a, b]);
    expect(new Set([a, b, c]).size).toBe(3);
  });
  it("falls back rather than producing an empty tab name", () => {
    expect(sheetName("///")).toBe("Sheet");
  });
});

describe("xml escaping", () => {
  it("escapes the five entities", () => {
    expect(xmlEscape(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &apos; f",
    );
  });

  it("STRIPS control characters, which XML cannot represent at all", () => {
    // One of these inside a pasted remark would otherwise corrupt the entire workbook.
    const withCtrl = `before${String.fromCharCode(26)}after`;
    expect(xmlEscape(withCtrl)).toBe("beforeafter");
  });

  it("keeps tab, newline and return, which are legal", () => {
    expect(xmlEscape("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });
});

describe("crc32", () => {
  it("matches the known value for a standard input", () => {
    // The canonical CRC-32 of "123456789".
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("is zero for nothing", () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("the workbook reads back", () => {
  it("contains exactly the parts a .xlsx needs", () => {
    const parts = readStoredZip(buildXlsxBytes(SIMPLE));
    for (const required of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]) {
      expect(parts.has(required), `missing ${required}`).toBe(true);
    }
  });

  it("puts the header in row 1 and the data from row 2", () => {
    const parts = readStoredZip(buildXlsxBytes(SIMPLE));
    const c = cells(parts.get("xl/worksheets/sheet1.xml") ?? "");
    expect(c.get("A1")).toBe("Date");
    expect(c.get("C1")).toBe("Worked (minutes)");
    expect(c.get("A2")).toBe("2026-09-01");
    expect(c.get("B3")).toBe("Half day");
  });

  it("writes numbers as NUMBERS, so the file can be summed", () => {
    const sheet = readStoredZip(buildXlsxBytes(SIMPLE)).get("xl/worksheets/sheet1.xml") ?? "";
    // A numeric cell has no t="inlineStr" and carries a bare <v>.
    expect(sheet).toContain('<c r="C2"><v>480</v></c>');
    expect(sheet).not.toContain('<c r="C2" t="inlineStr"');
  });

  it("writes a negative number as a number too", () => {
    const sheet =
      readStoredZip(buildXlsxBytes([{ name: "S", columns: [{ header: "V" }], rows: [[-291]] }]))
        .get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain("<v>-291</v>");
  });

  it("omits a null cell entirely rather than writing an empty string", () => {
    const c = cells(
      readStoredZip(buildXlsxBytes(SIMPLE)).get("xl/worksheets/sheet1.xml") ?? "",
    );
    expect(c.has("C4")).toBe(false);
  });

  it("drops NaN and Infinity rather than emitting an unopenable cell", () => {
    const sheet =
      readStoredZip(
        buildXlsxBytes([{ name: "S", columns: [{ header: "V" }], rows: [[Number.NaN], [Infinity]] }]),
      ).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).not.toContain("NaN");
    expect(sheet).not.toContain("Infinity");
  });

  it("freezes the header row and sets the widths it was given", () => {
    const sheet = readStoredZip(buildXlsxBytes(SIMPLE)).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<col min="1" max="1" width="18"');
  });

  it("declares a default style, or a reader has to guess one", () => {
    const styles = readStoredZip(buildXlsxBytes(SIMPLE)).get("xl/styles.xml") ?? "";
    expect(styles).toContain('<cellStyle name="Normal" xfId="0" builtinId="0"/>');
  });

  it("escapes a value that would otherwise break the XML", () => {
    const sheet =
      readStoredZip(
        buildXlsxBytes([
          { name: "S", columns: [{ header: "V" }], rows: [['Quote " & <angle>']] },
        ]),
      ).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain("Quote &quot; &amp; &lt;angle&gt;");
    // The raw form must not survive anywhere, or the part will not parse.
    expect(sheet).not.toContain("<angle>");
  });

  it("gives every sheet a part, a relationship and a content type", () => {
    const bytes = buildXlsxBytes([
      { name: "One", columns: [{ header: "a" }], rows: [] },
      { name: "Two", columns: [{ header: "b" }], rows: [] },
      { name: "Three", columns: [{ header: "c" }], rows: [] },
    ]);
    const parts = readStoredZip(bytes);
    expect(parts.has("xl/worksheets/sheet3.xml")).toBe(true);
    const rels = parts.get("xl/_rels/workbook.xml.rels") ?? "";
    /* Three sheets then styles — the styles relationship must be LAST or the ids collide. */
    expect(rels).toContain('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"');
    expect(rels).toContain('Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"');
    expect(parts.get("[Content_Types].xml")).toContain("/xl/worksheets/sheet3.xml");
  });

  it("de-duplicates sheet names in the workbook it actually writes", () => {
    const parts = readStoredZip(
      buildXlsxBytes([
        { name: "Summary", columns: [{ header: "a" }], rows: [] },
        { name: "Summary", columns: [{ header: "b" }], rows: [] },
      ]),
    );
    const book = parts.get("xl/workbook.xml") ?? "";
    expect(book).toContain('name="Summary"');
    expect(book).toContain('name="Summary (2)"');
  });

  it("refuses a workbook with no sheets rather than writing an unopenable one", () => {
    expect(() => buildXlsxBytes([])).toThrow();
  });

  it("records each entry's real CRC and size, or the archive is corrupt", () => {
    const bytes = buildXlsxBytes(SIMPLE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(18, true);
    const nameLen = view.getUint16(26, true);
    const dataAt = 30 + nameLen + view.getUint16(28, true);
    expect(view.getUint32(14, true)).toBe(crc32(bytes.subarray(dataAt, dataAt + size)));
  });

  it("ends with the central directory record a reader looks for first", () => {
    const bytes = buildXlsxBytes(SIMPLE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
    // 6 fixed parts + 1 sheet.
    expect(view.getUint16(bytes.length - 12, true)).toBe(6);
  });
});
