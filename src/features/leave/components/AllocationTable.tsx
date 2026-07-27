/**
 * AllocationTable — the per-date allocation the server produced, rendered as-is.
 *
 * Shared by the apply preview (E-05.4) and the request detail (E-05.7) so the
 * two cannot describe the same request differently. Every column is a column of
 * `leave_request_days`: `day_value` is the server's fraction for that date and
 * `reason_skipped` is a label over the server's own `is_counted` /
 * `is_holiday` / `is_weekly_off` booleans. Nothing is summed here — the total
 * comes from `leave_requests.total_days`.
 */
import { CalendarOff } from "lucide-react";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { fmtCivilDayMonthWeekday } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import type { LeaveAllocationDay } from "../api/leave-apply.api";
import { fmtDays, portionLabel, skipLabel } from "./leave-vocab";

export interface AllocationTableProps {
  days: readonly LeaveAllocationDay[];
  loading?: boolean;
  /** Contextual empty state; the apply and detail screens phrase it differently. */
  emptyTitle: string;
  emptyHint: string;
}

const columns: DataGridColumn<LeaveAllocationDay>[] = [
  {
    key: "leave_date",
    header: t("leave.alloc.col.date"),
    render: (row) => fmtCivilDayMonthWeekday(row.leave_date),
  },
  {
    key: "portion",
    header: t("leave.alloc.col.portion"),
    hideBelow: "md",
    render: (row) => portionLabel(row.portion),
  },
  {
    key: "day_value",
    header: t("leave.alloc.col.deducts"),
    align: "right",
    width: "6.5rem",
    render: (row) => (
      <span className={cn("num", row.is_counted ? undefined : "text-muted-foreground")}>
        {fmtDays(row.day_value)}
      </span>
    ),
  },
  {
    key: "reason_skipped",
    header: t("leave.alloc.col.note"),
    render: (row) => (
      <span className={row.is_counted ? undefined : "text-muted-foreground"}>
        {skipLabel(row.reason_skipped)}
      </span>
    ),
  },
];

export function AllocationTable({ days, loading = false, emptyTitle, emptyHint }: AllocationTableProps) {
  return (
    <DataGrid<LeaveAllocationDay>
      columns={columns}
      rows={days}
      rowKey={(row) => row.id}
      loading={loading}
      pageSize={31}
      emptyState={<EmptyState icon={CalendarOff} title={emptyTitle} hint={emptyHint} />}
    />
  );
}
