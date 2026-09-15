/**
 * useAttendanceExport — press once, get the workbook.
 *
 * Deliberately NOT a react-query query. An export is a thing somebody DOES, once, on purpose:
 * it must not be cached, refetched on focus, deduplicated against a stale key, or started
 * because a component remounted. It is a mutation in every way that matters and is written as
 * a plain async action with its own progress.
 *
 * ── PROGRESS IS REAL, NOT A SPINNER ──────────────────────────────────────────
 * A year for the whole venue is twelve month-reads for the days and twelve more for the
 * monthly summaries. That is long enough that a bare spinner reads as "hung", so each month
 * reports as it lands and the button says "4 of 12".
 */
import { useCallback, useRef, useState } from "react";
import { buildXlsx } from "@/lib/xlsx";
import { periodFor, type Granularity } from "@/lib/period";
import { fmtDateTime, nowInstantIso, nowIstDate } from "@/lib/datetime";
import { mutationUserMessage } from "@/shared/api/query";
import { t } from "@/shared/i18n/en";
import {
  buildAttendanceSheets,
  type ExportScope,
  type WorkbookInput,
} from "../lib/attendanceWorkbook";
import {
  employeeIdsIn,
  fetchExportBalances,
  fetchExportDays,
  fetchExportEmployees,
  fetchExportMonthlySummaries,
  fetchExportSummaries,
} from "../api/attendanceExport.api";

export interface ExportProgress {
  readonly done: number;
  readonly total: number;
}

export interface AttendanceExportState {
  readonly isRunning: boolean;
  readonly progress: ExportProgress | null;
  readonly error: string | null;
  readonly run: (scope: ExportScope, employeeId: string | null, anchorDate?: string) => void;
}

/** The workbook's own name. `safeFilename` is not reused: that one forces .csv or .pdf. */
export function workbookFilename(
  scope: ExportScope,
  label: string,
  who: string | null,
): string {
  const parts = ["attendance", scope, label, who ?? t("attendance.export.file.everyone")];
  const stem = parts
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return `${stem === "" ? "attendance" : stem}.xlsx`;
}

/** Hand the file to the browser. Object URL, revoked on the next tick. */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

const GRANULARITY: Readonly<Record<ExportScope, Granularity>> = {
  week: "week",
  month: "month",
  year: "year",
};

export function useAttendanceExport(): AttendanceExportState {
  const [isRunning, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* Guards a double click: a second run would download a second identical file. */
  const busy = useRef(false);

  const run = useCallback(
    (scope: ExportScope, employeeId: string | null, anchorDate?: string) => {
      if (busy.current) return;
      busy.current = true;
      setRunning(true);
      setError(null);
      setProgress(null);

      void (async () => {
        try {
          const anchor = anchorDate ?? nowIstDate();
          const period = periodFor(GRANULARITY[scope], anchor);
          const range = { from: period.from, to: period.to };

          /*
            The days first, because everything else is shaped by who they turn up. A year read
            reports twice — once for the day months, once for the summary months — so the two
            halves share one progress line rather than resetting it.
          */
          const monthsInRange = scope === "year" ? 12 : 1;
          const totalSteps = scope === "year" ? monthsInRange * 2 : 2;
          let step = 0;
          const bump = (): void => {
            step += 1;
            setProgress({ done: step, total: totalSteps });
          };

          const { days, truncated } = await fetchExportDays(range, employeeId, () => {
            bump();
          });

          const months =
            scope === "year"
              ? await fetchExportMonthlySummaries(range, employeeId, () => {
                bump();
              })
              : undefined;

          const summaries = await fetchExportSummaries(range, employeeId);
          const balances = await fetchExportBalances(employeeId);
          const employees = await fetchExportEmployees(employeeIdsIn(days, summaries));

          const input: WorkbookInput = {
            scope,
            from: range.from,
            to: range.to,
            rangeLabel: `${range.from} — ${range.to}`,
            generatedAt: fmtDateTime(nowInstantIso()),
            employees,
            summaries,
            days,
            balances,
            ...(months === undefined ? {} : { months }),
            ...(truncated ? { truncated } : {}),
          };

          const blob = buildXlsx(buildAttendanceSheets(input));
          const who =
            employeeId === null
              ? null
              : (employees.find((e) => e.employeeId === employeeId)?.code ?? null);
          download(blob, workbookFilename(scope, range.from, who));
        } catch (cause) {
          setError(mutationUserMessage(cause));
        } finally {
          busy.current = false;
          setRunning(false);
          setProgress(null);
        }
      })();
    },
    [],
  );

  return { isRunning, progress, error, run };
}
