/**
 * AnalyticsExportButtons — CSV and PDF for the rows a screen is already showing.
 *
 * It takes the ROWS, not the grid. `exportReport` refuses to read the DOM on
 * purpose (see its header): scraping the table would export whatever page the
 * user had paged to, with the sort they last clicked and the columns their
 * viewport happened to hide. Passing the same array the grid was handed is what
 * makes the file and the screen the same answer.
 *
 * `filters` is required by the engine and therefore required here: a printed page
 * reading "Late days: 41" with no period and no department on it is worthless in
 * a meeting and dangerous in a file.
 *
 * WHAT THIS IS NOT: a PII egress. §14 reserves those for the server function that
 * writes the `export_log` row in the same breath as the file. This is governed
 * analytics output the administrator is already looking at, under their own RLS
 * scope, and it writes no register row.
 */
import { useState } from "react";
import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  exportReport,
  type DimensionLabels,
  type ExportColumn,
  type ExportFormat,
} from "@/lib/exportReport";
import type { AnalyticsFilters } from "@/lib/analyticsFilters";
import { t } from "@/shared/i18n/en";

export interface AnalyticsExportButtonsProps<Row> {
  readonly title: string;
  readonly subtitle?: string;
  /** Base name; the engine sanitises it and appends the extension. */
  readonly filename: string;
  readonly columns: readonly ExportColumn<Row>[];
  readonly rows: readonly Row[];
  /** The question these rows answer. Printed at the top of every page. */
  readonly filters: AnalyticsFilters;
  /** Names for the filter IDs — the caller already loaded the pick-lists. */
  readonly labels?: DimensionLabels;
}

export function AnalyticsExportButtons<Row>({
  title,
  subtitle,
  filename,
  columns,
  rows,
  filters,
  labels,
}: AnalyticsExportButtonsProps<Row>) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [failed, setFailed] = useState(false);

  async function run(format: ExportFormat): Promise<void> {
    setBusy(format);
    setFailed(false);
    try {
      await exportReport({
        title,
        ...(subtitle === undefined ? {} : { subtitle }),
        columns,
        rows,
        format,
        filename,
        filters,
        ...(labels === undefined ? {} : { labels }),
      });
    } catch {
      // Nothing partial can have been written — the engine builds the whole blob
      // before it touches the DOM — so the honest report is "no file", in a
      // sentence. The PDF path is the one that realistically fails: its two
      // libraries are fetched on demand and a dead network kills the import.
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  const nothing = rows.length === 0;

  return (
    <>
      <Button
        variant="outline"
        className="h-11"
        disabled={nothing || busy !== null}
        onClick={() => {
          void run("csv");
        }}
      >
        <Download className="mr-2 h-4 w-4" aria-hidden />
        {busy === "csv" ? t("admin.analytics.export.busy") : t("admin.analytics.export.csv")}
      </Button>
      <Button
        variant="outline"
        className="h-11"
        disabled={nothing || busy !== null}
        onClick={() => {
          void run("pdf");
        }}
      >
        <FileText className="mr-2 h-4 w-4" aria-hidden />
        {busy === "pdf" ? t("admin.analytics.export.busy") : t("admin.analytics.export.pdf")}
      </Button>
      {nothing ? (
        <span className="text-xs text-muted-foreground">{t("admin.analytics.export.nothing")}</span>
      ) : null}
      {failed ? (
        <span role="alert" className="text-sm text-destructive">
          {t("admin.analytics.export.failed")}
        </span>
      ) : null}
    </>
  );
}
