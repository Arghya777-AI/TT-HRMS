/**
 * reimbursementCsv.ts — the register as a file HR can send to accounts.
 *
 * "Can they download that and submit it to me?" — so the download has to be the SAME rows the
 * screen shows, in the same order, with the money in rupees rather than paise. A file that
 * disagreed with the page would be worse than no file: it is the copy that leaves the building.
 *
 * Its own module because the escaping is the only part that can be got wrong, and it is
 * testable here in a way a click handler is not.
 */
import { csvCell, UTF8_BOM } from "@/lib/exportReport";

export interface CsvColumn<T> {
  readonly header: string;
  readonly value: (row: T) => string;
}

/**
 * Rupees, from integer paise, as a plain decimal.
 *
 * NOT `formatPaise`: that produces "₹6,148.00" with en-IN grouping, and a comma inside a
 * spreadsheet cell is a column break waiting to happen. `csvCell` would quote it correctly,
 * but the currency symbol and the grouping then have to be stripped by whoever opens it before
 * they can sum a column — which is the one thing they downloaded it to do.
 */
export function paiseToRupeeString(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return "";
  return (paise / 100).toFixed(2);
}

/**
 * Rows to a CSV string.
 *
 * The BOM is deliberate: without it Excel on Windows reads UTF-8 as the local codepage, and
 * every employee name with a non-ASCII character arrives mangled.
 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const head = columns.map((c) => csvCell(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(","));
  return UTF8_BOM + [head, ...body].join("\r\n") + "\r\n";
}

/**
 * Hand the file to the browser.
 *
 * A blob and an anchor rather than a data: URL — a month of claims can exceed the length some
 * browsers accept in a URL, and the failure there is silent.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Freed on the next tick: revoking synchronously can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
