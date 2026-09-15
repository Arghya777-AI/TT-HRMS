/**
 * AttendanceExportButton — one control, three surfaces.
 *
 * The employee's own attendance page passes their id, the admin's person page passes that
 * person's, and the admin day-records page passes `null` for everybody in scope. Nothing else
 * differs, so nothing else is duplicated: one menu, one hook, one workbook builder.
 *
 * ── WHY THE SCOPE IS A MENU AND NOT THREE BUTTONS ────────────────────────────
 * Week, month and year are the same action over different spans. Three buttons in a toolbar
 * would read as three features and would have to be shortened to fit, which is how "Yr" ends
 * up in a product. The menu also has room to say what is inside the file, which a button
 * label never does.
 *
 * ── AND WHY IT NAMES THE PERIOD IT WILL USE ──────────────────────────────────
 * "This month" is ambiguous on a screen that is already showing a different month. The anchor
 * date is passed in by the page — whatever period the reader is looking at — so the file they
 * get is the one they were looking at, not the one the calendar happens to be on.
 */
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useAttendanceExport } from "../hooks/useAttendanceExport";
import type { ExportScope } from "../lib/attendanceWorkbook";

export interface AttendanceExportButtonProps {
  /** Whose attendance. `null` means everybody the reader is allowed to see. */
  readonly employeeId: string | null;
  /** Any date inside the period on screen; the scope widens it to a week, month or year. */
  readonly anchorDate?: string;
  /** Shown when the reader may also take the whole venue — the admin day-records page. */
  readonly alsoEveryone?: boolean;
  readonly size?: "sm" | "default";
}

const SCOPES: readonly { readonly scope: ExportScope; readonly labelKey: Parameters<typeof t>[0] }[] = [
  { scope: "week", labelKey: "attendance.export.menu.week" },
  { scope: "month", labelKey: "attendance.export.menu.month" },
  { scope: "year", labelKey: "attendance.export.menu.year" },
];

export function AttendanceExportButton({
  employeeId,
  anchorDate,
  alsoEveryone = false,
  size = "sm",
}: AttendanceExportButtonProps): React.JSX.Element {
  const exporter = useAttendanceExport();

  const label =
    exporter.isRunning && exporter.progress !== null
      ? t("attendance.export.busy", {
        done: formatNumber(exporter.progress.done),
        total: formatNumber(exporter.progress.total),
      })
      : t("attendance.export.button");

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size={size} disabled={exporter.isRunning}>
            {exporter.isRunning ? (
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
            ) : (
              <Download className="mr-2 size-4" aria-hidden />
            )}
            {label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {t("attendance.export.menu.hint")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {alsoEveryone ? (
            <DropdownMenuLabel className="text-xs">
              {t("attendance.export.menu.scopeOne")}
            </DropdownMenuLabel>
          ) : null}
          {SCOPES.map(({ scope, labelKey }) => (
            <DropdownMenuItem
              key={scope}
              onSelect={() => {
                exporter.run(scope, employeeId, anchorDate);
              }}
            >
              {t(labelKey)}
            </DropdownMenuItem>
          ))}

          {/*
            Only where the reader may take the venue. The employee's own page never shows it —
            RLS would refuse the extra rows anyway, and offering a button that returns one
            person's data under a label saying "every employee" is worse than not offering it.
          */}
          {alsoEveryone ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs">
                {t("attendance.export.menu.scopeAll")}
              </DropdownMenuLabel>
              {SCOPES.map(({ scope, labelKey }) => (
                <DropdownMenuItem
                  key={`all-${scope}`}
                  onSelect={() => {
                    exporter.run(scope, null, anchorDate);
                  }}
                >
                  {t(labelKey)}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {exporter.error === null ? null : (
        <p className="max-w-xs text-right text-xs text-destructive">
          {t("attendance.export.failed", { reason: exporter.error })}
        </p>
      )}
    </div>
  );
}
