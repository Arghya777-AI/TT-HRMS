/**
 * OpenRequestsGrid — the ONE rendering of "what I have sent that nobody has
 * decided yet".
 *
 * Used by E-10 (`/me/apply` → My open requests) and E-12 (`/me/approvals` →
 * Tracking). Sharing the component as well as the query means the two screens
 * cannot differ in a label, a status word or a count.
 *
 * No duration is derived here. `Submitted` and `Decision due` are the server's
 * own timestamps; "Past SLA" is a comparison against `sla_due_at`, which the
 * server computed and stored.
 */
import { Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import { fmtDateTime } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { formatINR } from "@/lib/money";
import {
  approverNames,
  isPastSla,
  summaryText,
  type DirectoryEntry,
  type OpenRequest,
} from "../api/apply.api";

const OPEN_STATUS_MAP: Record<string, StatusChipEntry> = {
  pending: { label: "Waiting for a decision", tone: "warn" },
  in_progress: { label: "Being decided", tone: "warn" },
  escalated: { label: "Escalated", tone: "danger" },
};

export interface OpenRequestsGridProps {
  rows: readonly OpenRequest[];
  approvers: Readonly<Record<string, DirectoryEntry>>;
  /** Empty-state copy differs between the launcher and the tracking section. */
  emptyTitle: string;
  emptyHint: string;
}

export function OpenRequestsGrid({ rows, approvers, emptyTitle, emptyHint }: OpenRequestsGridProps) {
  const columns: DataGridColumn<OpenRequest>[] = [
    {
      key: "request_number",
      header: t("apply.col.ref"),
      width: "10rem",
      render: (row) => <span className="font-mono text-xs">{row.request_number}</span>,
    },
    {
      /*
        THE TITLE LEADS, the reason sits under it.

        This column rendered `summaryText(summary) ?? title` — so whenever a
        request HAD a reason, the title was hidden by it, and "Asset · Laptops
        ×1" was replaced by "need it for site work". Both matter and neither
        replaces the other: the title says WHAT was asked for and the summary says
        why. Reported as "if anyone is making any request then try to show
        important details in that row like assets name or any request,
        reason/amount".
      */
      key: "type",
      header: t("apply.col.type"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.title}</span>
          <span className="text-xs text-muted-foreground">
            {dash(row.request_types?.name ?? null)}
          </span>
        </span>
      ),
    },
    {
      key: "summary",
      header: t("apply.col.summary"),
      hideBelow: "md",
      render: (row) => {
        const text = summaryText(row.summary);
        return text === null ? dash(null) : (
          <span className="line-clamp-2 text-sm text-muted-foreground">{text}</span>
        );
      },
    },
    {
      key: "amount",
      header: t("apply.col.amount"),
      align: "right",
      width: "8rem",
      hideBelow: "lg",
      render: (row) => (row.amount === null ? dash(null) : formatINR(row.amount)),
    },
    {
      key: "status",
      header: t("apply.col.status"),
      width: "12rem",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusChip status={row.status} map={OPEN_STATUS_MAP} />
          {isPastSla(row) ? <Badge variant="danger">{t("apply.overdue")}</Badge> : null}
        </span>
      ),
    },
    {
      key: "with",
      header: t("apply.col.with"),
      render: (row) => {
        const names = approverNames(row, approvers);
        return names.length > 0 ? names.join(", ") : t("apply.with.unknown");
      },
    },
    {
      key: "submitted_at",
      header: t("apply.col.submitted"),
      width: "13rem",
      hideBelow: "lg",
      sortable: true,
      render: (row) => fmtDateTime(row.submitted_at),
    },
    {
      key: "sla_due_at",
      header: t("apply.col.due"),
      width: "13rem",
      hideBelow: "lg",
      render: (row) => fmtDateTime(row.sla_due_at),
    },
  ];

  return (
    <DataGrid
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      pageSize={10}
      emptyState={<EmptyState icon={Send} title={emptyTitle} hint={emptyHint} />}
    />
  );
}
