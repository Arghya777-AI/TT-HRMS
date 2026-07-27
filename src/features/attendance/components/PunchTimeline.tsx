/**
 * PunchTimeline — every scan filed under one business date (E-03.6).
 *
 * What the view already decided, and we only render:
 *  - The FIRST scan of the business date is the check-in, the LAST is the
 *    check-out, and everything between is a plain scan (`derived_direction`).
 *    A single-scan day therefore has a check-in and no check-out — it is a
 *    missing punch, never a full day and never an absent (§3.1).
 *  - A scan the engine collapsed as a duplicate is struck through and labelled,
 *    rather than hidden: the employee can see that both taps registered and that
 *    only one counted.
 *
 * What is deliberately NOT here: `match_confidence` / `confidence_badge`. The
 * view carries both and an employee is never shown either (spec-employee §5,
 * A12) — a face-match score is a number they cannot act on and cannot contest.
 * `punchMethodLabel` gives the one word that is actionable: Face, Fingerprint,
 * Web or Corrected.
 */
import type { ReactNode } from "react";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { fmtTimeWithDayOffset } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import type { AttendancePunch } from "../api/attendance.api";
import { punchMethodLabel, punchRoleLabel } from "../display";

export interface PunchTimelineProps {
  punches: readonly AttendancePunch[];
  /** Ids the engine marked `duplicate_of_punch_id` — struck through. */
  duplicateIds: ReadonlySet<string>;
  /** The business date the scans are filed under, 'YYYY-MM-DD'. */
  businessDate: string;
  emptyState?: ReactNode;
}

export function PunchTimeline({
  punches,
  duplicateIds,
  businessDate,
  emptyState,
}: PunchTimelineProps) {
  const isDuplicate = (row: AttendancePunch): boolean => duplicateIds.has(row.id);

  const columns: DataGridColumn<AttendancePunch>[] = [
    {
      key: "punched_at",
      header: t("attendance.day.col.time"),
      width: "11rem",
      render: (row) => {
        const edge = row.derived_direction !== "SCAN";
        return (
          <span className="flex items-center gap-2.5">
            <span
              aria-hidden
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-full border-2",
                edge ? "border-primary bg-primary" : "border-muted-foreground bg-transparent",
              )}
            />
            <span className={cn("num", isDuplicate(row) && "line-through text-muted-foreground")}>
              {fmtTimeWithDayOffset(row.punched_at, businessDate)}
            </span>
          </span>
        );
      },
    },
    {
      key: "derived_direction",
      header: t("attendance.day.col.role"),
      width: "9rem",
      render: (row) => (
        <span className={cn(isDuplicate(row) && "line-through text-muted-foreground")}>
          {punchRoleLabel(row.derived_direction)}
        </span>
      ),
    },
    {
      key: "source",
      header: t("attendance.day.col.method"),
      render: (row) => punchMethodLabel(row),
    },
    {
      key: "device_label",
      header: t("attendance.day.col.gate"),
      hideBelow: "md",
      render: (row) => dash(row.device_label),
    },
    {
      key: "note",
      header: t("attendance.day.col.note"),
      hideBelow: "md",
      render: (row) => {
        const notes: string[] = [];
        if (isDuplicate(row)) notes.push(t("attendance.day.duplicate"));
        if (row.is_offline_replay === true) notes.push(t("attendance.day.offlineReplay"));
        if (row.operator_name !== null) notes.push(row.operator_name);
        if (row.reason !== null && row.reason.length > 0) notes.push(row.reason);
        return notes.length === 0 ? dash(null) : notes.join(" · ");
      },
    },
  ];

  return (
    <DataGrid
      columns={columns}
      rows={punches}
      rowKey={(row) => row.id}
      pageSize={50}
      {...(emptyState !== undefined ? { emptyState } : {})}
    />
  );
}
