/**
 * LiveOpsBand — spec-admin §2.2, "what is happening at the gate right now".
 *
 * Three panels, all reading today's IST business date:
 *
 *  1. Presence slices. Six server counts over `v_attendance_today_board`, each a
 *     link into the live board filtered to the same boolean column. "Yet to
 *     reach" and "Overdue" are separate on purpose: the view flips one to the
 *     other once shift start plus grace has passed, which is the honest version
 *     of a state the reference product left permanently optimistic.
 *  2. The gate feed — the last scans, with the SERVER's IN/OUT derivation, its
 *     confidence BAND (never the raw score) and the device. A scan the kiosk
 *     flagged is chipped, and the row links to the punch log to act on it.
 *  3. Per-device health for today: attempts, match rate and the slowest 5% of
 *     matches, straight out of `v_kiosk_health`. There is no org-wide average
 *     here — averaging per-device percentages on the client is exactly the
 *     arithmetic the contract bans, and one bad gate would vanish into it.
 */
import { Link } from "react-router-dom";
import { Activity, ScanFace } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import type { StatusTone } from "@/shared/ui/StatusChip";
import { fmtDateTime, fmtTime } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import type { KioskHealthRow } from "../api/system.api";
import type { PunchRow } from "../api/command.api";
import { ADMIN_ROUTES, CONFIDENCE_CHIP, DIRECTION_CHIP, unavailableHint } from "../command-vocab";
import { PersonCell } from "./PersonCell";
import {
  REFRESH,
  useBoardSlice,
  useBoardTotal,
  useGateFeed,
  useKioskHealthToday,
} from "../hooks/useCommandCentre";

const TONE_TEXT: Record<StatusTone, string> = {
  success: "text-success",
  warn: "text-warning",
  danger: "text-destructive",
  info: "text-info",
  neutral: "text-foreground",
};

interface SliceChipProps {
  label: string;
  to: string;
  tone: StatusTone;
  query: { data: number | undefined; error: Error | null; isPending: boolean };
}

/** One presence slice: a server count that opens the same filtered board. */
function SliceChip({ label, to, tone, query }: SliceChipProps) {
  return (
    <Link
      to={to}
      className="flex min-w-[7.5rem] flex-1 flex-col rounded-md border bg-background px-3 py-2 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {query.isPending ? (
        <Skeleton className="mt-1 h-6 w-10" />
      ) : query.error !== null ? (
        <span className="num mt-1 font-display text-xl font-semibold text-muted-foreground">
          {t("common.empty")}
        </span>
      ) : (
        <span className={cn("num mt-1 font-display text-xl font-semibold", TONE_TEXT[tone])}>
          {formatNumber(query.data ?? 0)}
        </span>
      )}
    </Link>
  );
}

function gateColumns(): DataGridColumn<PunchRow>[] {
  return [
    {
      key: "ist_time_display",
      header: t("admin.cc.col.time"),
      width: "6rem",
      render: (row) => <span className="num">{dash(row.ist_time_display)}</span>,
    },
    {
      key: "display_name",
      header: t("admin.cc.col.person"),
      render: (row) => <PersonCell name={row.display_name} code={row.employee_code} />,
    },
    {
      key: "derived_direction",
      header: t("admin.cc.col.direction"),
      width: "7rem",
      render: (row) =>
        row.derived_direction === null ? (
          t("common.empty")
        ) : (
          <StatusChip status={row.derived_direction} map={DIRECTION_CHIP} />
        ),
    },
    {
      key: "confidence_badge",
      header: t("admin.cc.col.confidence"),
      width: "8rem",
      hideBelow: "md",
      render: (row) =>
        row.confidence_badge === null ? (
          <span className="text-muted-foreground">{t("admin.cc.confidence.notMatched")}</span>
        ) : (
          <StatusChip status={row.confidence_badge} map={CONFIDENCE_CHIP} />
        ),
    },
    {
      key: "device_label",
      header: t("admin.cc.col.device"),
      hideBelow: "lg",
      render: (row) => dash(row.device_label ?? row.source_label),
    },
    {
      key: "needs_review",
      header: t("admin.cc.col.flagged"),
      width: "9rem",
      hideBelow: "sm",
      render: (row) =>
        row.needs_review ? (
          <Link
            to={ADMIN_ROUTES.punchesToReview}
            className="text-sm font-medium text-warning underline-offset-2 hover:underline"
          >
            {t("admin.cc.gate.review")}
          </Link>
        ) : (
          <span className="text-muted-foreground">{t("common.empty")}</span>
        ),
    },
  ];
}

function kioskColumns(): DataGridColumn<KioskHealthRow>[] {
  return [
    {
      key: "label",
      header: t("admin.cc.col.deviceName"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.label}</span>
          <span className="num text-xs text-muted-foreground">{row.device_code}</span>
        </span>
      ),
    },
    {
      key: "total_attempts",
      header: t("admin.cc.col.attempts"),
      align: "right",
      width: "7rem",
      render: (row) => <span className="num">{formatNumber(row.total_attempts)}</span>,
    },
    {
      key: "matched",
      header: t("admin.cc.col.matched"),
      align: "right",
      width: "7rem",
      hideBelow: "sm",
      render: (row) => <span className="num">{formatNumber(row.matched)}</span>,
    },
    {
      key: "match_success_pct",
      header: t("admin.cc.col.matchRate"),
      align: "right",
      width: "8rem",
      render: (row) => (
        <span className="num">{formatPercent(row.match_success_pct, { clamp: true })}</span>
      ),
    },
    {
      key: "p95_latency_ms",
      header: t("admin.cc.col.p95"),
      align: "right",
      width: "8rem",
      hideBelow: "md",
      render: (row) => (
        <span className="num">
          {row.p95_latency_ms === null
            ? t("common.empty")
            : t("admin.cc.ms", { value: formatNumber(row.p95_latency_ms) })}
        </span>
      ),
    },
    {
      key: "last_seen_at",
      header: t("admin.cc.col.lastSeen"),
      hideBelow: "lg",
      render: (row) =>
        row.last_seen_at === null ? t("admin.cc.gate.neverSeen") : fmtDateTime(row.last_seen_at),
    },
  ];
}

export interface LiveOpsBandProps {
  istDate: string;
}

export function LiveOpsBand({ istDate }: LiveOpsBandProps) {
  const present = useBoardSlice("present", istDate);
  const onTime = useBoardSlice("on_time", istDate);
  const late = useBoardSlice("late", istDate);
  const yetToReach = useBoardSlice("yet_to_reach", istDate);
  const overdue = useBoardSlice("overdue", istDate);
  const off = useBoardSlice("off", istDate);
  const total = useBoardTotal(istDate);

  const gate = useGateFeed(istDate);
  const kiosk = useKioskHealthToday(istDate);

  const totalLine =
    total.isPending || total.error !== null
      ? t("admin.cc.ops.scopeUnknown")
      : t("admin.cc.ops.scope", { count: formatNumber(total.data ?? 0) });

  return (
    <section aria-labelledby="live-ops-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="live-ops-heading" className="flex items-center gap-2 font-display text-lg font-semibold">
            <Activity className="h-4 w-4 text-primary" aria-hidden />
            {t("admin.cc.ops.title")}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{totalLine}</p>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("admin.cc.ops.refresh", { seconds: REFRESH.live / 1000 })}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <SliceChip
          label={t("admin.cc.slice.present")}
          to={ADMIN_ROUTES.liveIn}
          tone="success"
          query={present}
        />
        <SliceChip
          label={t("admin.cc.slice.onTime")}
          to={ADMIN_ROUTES.liveOnTime}
          tone="success"
          query={onTime}
        />
        <SliceChip
          label={t("admin.cc.slice.late")}
          to={ADMIN_ROUTES.daysLate(istDate)}
          tone="warn"
          query={late}
        />
        <SliceChip
          label={t("admin.cc.slice.yetToReach")}
          to={ADMIN_ROUTES.liveYetToReach}
          tone="neutral"
          query={yetToReach}
        />
        <SliceChip
          label={t("admin.cc.slice.overdue")}
          to={ADMIN_ROUTES.liveOverdue}
          tone="danger"
          query={overdue}
        />
        <SliceChip
          label={t("admin.cc.slice.off")}
          to={ADMIN_ROUTES.liveOff}
          tone="info"
          query={off}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-base font-semibold">{t("admin.cc.gate.title")}</h3>
            <Link
              to={ADMIN_ROUTES.punchesToReviewOn(istDate)}
              className="text-sm font-medium text-primary underline-offset-2 hover:underline"
            >
              {t("admin.cc.gate.openLog")}
            </Link>
          </div>
          <StateBoundary
            loading={gate.isPending}
            error={gate.error}
            onRetry={() => void gate.refetch()}
            isEmpty={(gate.data ?? []).length === 0}
            empty={
              <EmptyState
                icon={ScanFace}
                title={t("admin.cc.gate.empty.title")}
                hint={t("admin.cc.gate.empty.hint")}
              />
            }
            skeletonRows={4}
          >
            <DataGrid
              columns={gateColumns()}
              rows={gate.data ?? []}
              rowKey={(row) => row.id}
              pageSize={10}
            />
          </StateBoundary>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-base font-semibold">{t("admin.cc.kioskPanel.title")}</h3>
            <Link
              to={ADMIN_ROUTES.kioskDevices}
              className="text-sm font-medium text-primary underline-offset-2 hover:underline"
            >
              {t("admin.cc.kioskPanel.open")}
            </Link>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">{t("admin.cc.kioskPanel.note")}</p>
          <StateBoundary
            loading={kiosk.isPending}
            error={kiosk.error}
            onRetry={() => void kiosk.refetch()}
            isEmpty={(kiosk.data ?? []).length === 0}
            empty={
              <EmptyState
                icon={ScanFace}
                title={t("admin.cc.kioskPanel.empty.title")}
                hint={t("admin.cc.kioskPanel.empty.hint")}
              />
            }
            skeletonRows={3}
          >
            <DataGrid
              columns={kioskColumns()}
              rows={kiosk.data ?? []}
              rowKey={(row) => `${row.kiosk_device_id}:${row.ist_date}`}
              pageSize={10}
            />
          </StateBoundary>
        </div>
      </div>

      {total.error !== null ? (
        <p className="text-xs text-muted-foreground">{unavailableHint(total.error)}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t("admin.cc.ops.asOf", { time: fmtTime(gate.dataUpdatedAt) })}
      </p>
    </section>
  );
}
