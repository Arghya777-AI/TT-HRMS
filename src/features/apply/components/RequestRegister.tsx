/**
 * RequestRegister — every request one employee has ever raised, and where it got to.
 *
 * WHAT THIS ANSWERS, that nothing did before: "which of mine were approved or
 * rejected", "who has mine right now", "how far along is it". `OpenRequestsGrid`
 * shows what is in flight and drops a request the moment it is decided, so the
 * answer to all three used to be "look at your own screens for each type, one at
 * a time, and hope".
 *
 * ── NOTHING HERE IS COMPUTED ────────────────────────────────────────────────
 *
 * The status, the level, the current approvers and the decision time are all
 * server columns on `approval_requests`. This renders them. The one derived thing
 * is the LEVEL SENTENCE — "level 2 of 3" — which is two integers put next to each
 * other, and the tiles are `count=exact` from Postgres over the same predicate
 * the grid uses, so a tile can never disagree with the rows beneath it.
 *
 * ── THE TRAIL IS THE POINT ──────────────────────────────────────────────────
 *
 * Expanding a row reads `approval_actions` — who acted, at which level, what they
 * said. It is append-only and has no UPDATE or DELETE policy for anybody, so it
 * is evidence rather than a summary. `aa__via_request_read` lets an employee read
 * the trail of any request they can see, which is exactly their own.
 */
import { useState } from "react";
import { Clock, Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { cn } from "@/lib/utils";
import { dash, formatNumber } from "@/lib/format";
import { fmtDateTime } from "@/lib/datetime";
import { type MessageKey, t } from "@/shared/i18n/en";
import {
  approverNames,
  requestSliceValues,
  summaryText,
  type DirectoryEntry,
  type OpenRequest,
  type RequestSlice,
} from "../api/apply.api";
import { useApprovalTrail, useMyRequestCount, useMyRequests } from "../hooks/useApply";

/**
 * `approval_status` has twelve values and an employee needs four ideas.
 *
 * Anything not named here falls back to the raw value rather than being forced
 * into a bucket — a status this map has not met is a status somebody added, and
 * showing it verbatim is how it gets noticed.
 */
const STATUS_CHIP: Record<string, StatusChipEntry> = {
  draft: { label: t("register.status.draft"), tone: "neutral" },
  pending: { label: t("register.status.pending"), tone: "warn" },
  in_progress: { label: t("register.status.in_progress"), tone: "info" },
  escalated: { label: t("register.status.escalated"), tone: "danger" },
  approved: { label: t("register.status.approved"), tone: "success" },
  auto_approved: { label: t("register.status.auto_approved"), tone: "success" },
  applied: { label: t("register.status.applied"), tone: "success" },
  rejected: { label: t("register.status.rejected"), tone: "danger" },
  expired: { label: t("register.status.expired"), tone: "danger" },
  failed: { label: t("register.status.failed"), tone: "danger" },
  cancelled: { label: t("register.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("register.status.withdrawn"), tone: "neutral" },
};

const SLICE_TONE: Readonly<Record<RequestSlice, string>> = {
  open: "border-warning/50",
  approved: "border-success/50",
  rejected: "border-destructive/50",
  all: "border-border",
};

/** One tile: its own count query, so a failing tile cannot blank the others. */
function SliceTile({
  slice,
  active,
  onSelect,
}: {
  slice: RequestSlice;
  active: boolean;
  onSelect: () => void;
}) {
  const count = useMyRequestCount(slice);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        SLICE_TONE[slice],
        active && "ring-2 ring-primary",
      )}
    >
      <p className="text-xs text-muted-foreground">{t(`register.slice.${slice}` as MessageKey)}</p>
      <p className="num mt-0.5 font-display text-2xl font-semibold">
        {count.isPending
          ? "…"
          : count.error !== null
            ? t("common.empty")
            : formatNumber(count.data ?? 0)}
      </p>
    </button>
  );
}

/** Who acted, when, and what they said — straight off `approval_actions`. */
function Trail({ requestId }: { requestId: string }) {
  const trail = useApprovalTrail(requestId);
  return (
    <div className="px-1 py-2">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <Clock className="size-3.5 text-muted-foreground" aria-hidden />
        {t("register.trail.title")}
      </h3>
      <StateBoundary
        loading={trail.isLoading}
        error={trail.error ?? undefined}
        onRetry={() => void trail.refetch()}
        isEmpty={trail.data !== undefined && trail.data.actions.length === 0}
        empty={<p className="mt-1 text-sm text-muted-foreground">{t("register.trail.empty")}</p>}
        skeletonRows={1}
      >
        <ol className="mt-2 space-y-2">
          {(trail.data?.actions ?? []).map((action) => {
            const actor =
              action.actor_id === null ? null : (trail.data?.actors.get(action.actor_id) ?? null);
            return (
              <li key={action.id} className="rounded-md border bg-card px-2.5 py-2 text-sm">
                {/* A div, not a p: `<p>` takes phrasing content only, and the
                    browser closes it before a block child — everything after the
                    Badge would silently become a sibling. domNesting.test.ts
                    catches exactly this. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="neutral">
                    {t(`register.action.${action.action}` as MessageKey)}
                  </Badge>
                  <span className="font-medium">
                    {/* A step the ENGINE took has no actor, and saying "the system"
                        is truer than leaving a blank where a name should be. */}
                    {actor?.display_name ?? t("register.trail.system")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("register.trail.atLevel", { level: formatNumber(action.level) })}
                  </span>
                </div>
                {action.comment !== null && action.comment.trim() !== "" ? (
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{action.comment}</p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">{fmtDateTime(action.acted_at)}</p>
              </li>
            );
          })}
        </ol>
      </StateBoundary>
    </div>
  );
}

export interface RequestRegisterProps {
  readonly slice: RequestSlice;
  readonly onSliceChange: (slice: RequestSlice) => void;
}

export function RequestRegister({ slice, onSliceChange }: RequestRegisterProps) {
  const requests = useMyRequests(slice);
  const [openId, setOpenId] = useState<string | null>(null);
  const approvers: Readonly<Record<string, DirectoryEntry>> = requests.data?.approvers ?? {};

  const columns: DataGridColumn<OpenRequest>[] = [
    {
      key: "request_number",
      header: t("register.col.ref"),
      width: "12rem",
      render: (row) => <span className="font-mono text-xs">{row.request_number}</span>,
    },
    {
      key: "type",
      header: t("register.col.type"),
      width: "11rem",
      render: (row) => row.request_types?.name ?? dash(null),
    },
    {
      key: "title",
      header: t("register.col.what"),
      render: (row) => (
        <span>
          <span className="block">{row.title}</span>
          {summaryText(row.summary) !== null ? (
            <span className="block text-xs text-muted-foreground">{summaryText(row.summary)}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "status",
      header: t("register.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={STATUS_CHIP} />,
    },
    {
      key: "level",
      header: t("register.col.level"),
      width: "8rem",
      hideBelow: "md",
      /*
        Two integers the server maintains, printed side by side. Level 0 means
        it has not reached a level yet — submitted, not yet routed — and saying
        "0 of 2" would read as a failure rather than a moment.
      */
      render: (row) =>
        row.current_level === 0
          ? t("register.level.notYet")
          : t("register.level.of", {
              level: formatNumber(row.current_level),
              total: formatNumber(row.total_levels),
            }),
    },
    {
      key: "with",
      header: t("register.col.with"),
      width: "12rem",
      hideBelow: "lg",
      /*
        NOBODY is a real answer and the one worth showing loudly: a pending
        request with an empty approver set is one the engine could not route, and
        it will sit there until somebody notices.
      */
      render: (row) => {
        const names = approverNames(row, approvers);
        if (names.length > 0) return names.join(", ");
        if (row.decided_at !== null) return dash(null);
        return <Badge variant="warning">{t("register.with.nobody")}</Badge>;
      },
    },
    {
      key: "submitted_at",
      header: t("register.col.raised"),
      width: "12rem",
      hideBelow: "lg",
      sortable: true,
      render: (row) => fmtDateTime(row.submitted_at),
    },
    {
      key: "decided_at",
      header: t("register.col.decided"),
      width: "12rem",
      hideBelow: "lg",
      render: (row) => (row.decided_at === null ? dash(null) : fmtDateTime(row.decided_at)),
    },
  ];

  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-4">
        {requestSliceValues.map((value) => (
          <SliceTile
            key={value}
            slice={value}
            active={slice === value}
            onSelect={() => onSliceChange(value)}
          />
        ))}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">{t("register.hint")}</p>

      <div className="mt-3">
        <StateBoundary
          loading={requests.isLoading}
          error={requests.error ?? undefined}
          onRetry={() => void requests.refetch()}
        >
          <DataGrid
            columns={columns}
            rows={requests.data?.rows ?? []}
            rowKey={(row) => row.id}
            pageSize={25}
            onRowClick={(row) => setOpenId(openId === row.id ? null : row.id)}
            renderRowDetail={(row) => (row.id === openId ? <Trail requestId={row.id} /> : null)}
            emptyState={
              <EmptyState
                icon={Inbox}
                title={t("register.empty.title")}
                hint={t("register.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </div>
    </div>
  );
}
