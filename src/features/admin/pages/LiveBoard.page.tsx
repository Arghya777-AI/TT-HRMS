/**
 * §4 · /admin/attendance/live — Live Board. Who is in right now, by department.
 *
 * This is the screen that tells the client's story: ONE camera at the gate, a
 * guard operating it, and the FIRST scan of the IST day becoming arrival while
 * the LAST becomes departure. The board says so in as many words, because it is
 * the rule the whole system is built around.
 *
 * Three rules held here:
 *
 *  1. NO ARITHMETIC. `v_attendance_today_board` computes every state flag
 *     (attended, yet_to_reach, late_in, on_time, overdue, off_today) and
 *     pre-renders `first_in_hm`, `last_out_hm` and `worked_hm`. This page prints
 *     columns. It does not decide who is late, and it does not add up hours —
 *     worked minutes come from `attendance_days`, which applies the unpaid break,
 *     the grace period and the day's status.
 *  2. THE TILES ARE SERVER COUNTS. Each presence tile is a `count=exact` using
 *     the same predicate as the rows it filters to (`boardSliceFilters`, shared
 *     with the Command Centre chips), so the home screen, this tile and this grid
 *     cannot disagree.
 *  3. IT SAYS WHEN IT LAST LOOKED. A live screen that silently goes stale is
 *     worse than one that admits its age, so the refresh time is on the page.
 *
 * @route /admin/attendance/live
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Clock, RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDateWeekday, fmtDurationHm, fmtTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { PersonCell } from "../components/PersonCell";
import { Notice } from "../components/Notice";
import { SelectField } from "../components/Field";
import { useBoardSlice, useBoardTotal, useIstToday } from "../hooks/useCommandCentre";
import { useTodayBoard } from "../hooks/useLiveBoard";
import { useRefOptions } from "../hooks/useMasters";
import type { TodayBoardRow } from "../api/attendance.api";
import type { BoardSlice } from "../api/command.api";

/** The URL state a Command Centre chip deep-links into. */
type BoardState = "in" | "yet_to_reach" | "off" | "late" | "overdue";

const STATE_TO_SLICE: Readonly<Record<BoardState, BoardSlice>> = {
  in: "present",
  yet_to_reach: "yet_to_reach",
  off: "off",
  late: "late",
  overdue: "overdue",
};

const TILES: readonly { state: BoardState; label: string; tone: "success" | "info" | "warn" | "danger" | "neutral" }[] = [
  { state: "in", label: t("admin.live.tile.in"), tone: "success" },
  { state: "yet_to_reach", label: t("admin.live.tile.yetToReach"), tone: "info" },
  { state: "late", label: t("admin.live.tile.late"), tone: "warn" },
  { state: "overdue", label: t("admin.live.tile.overdue"), tone: "danger" },
  { state: "off", label: t("admin.live.tile.off"), tone: "neutral" },
];

const TONE_RING: Readonly<Record<string, string>> = {
  success: "border-success/50",
  info: "border-info/50",
  warn: "border-warning/50",
  danger: "border-destructive/50",
  neutral: "border-border",
};

const DAY_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  present: { label: t("admin.live.status.present"), tone: "success" },
  absent: { label: t("admin.live.status.absent"), tone: "danger" },
  weekly_off: { label: t("admin.live.status.weeklyOff"), tone: "neutral" },
  holiday: { label: t("admin.live.status.holiday"), tone: "neutral" },
  on_leave: { label: t("admin.live.status.onLeave"), tone: "info" },
  half_day: { label: t("admin.live.status.halfDay"), tone: "warn" },
  pending: { label: t("admin.live.status.pending"), tone: "info" },
};

function isBoardState(v: string | null): v is BoardState {
  return v === "in" || v === "yet_to_reach" || v === "off" || v === "late" || v === "overdue";
}

export default function LiveBoardPage() {
  const [params, setParams] = useSearchParams();
  const istDate = useIstToday();

  const rawState = params.get("state");
  const state: BoardState | null = isBoardState(rawState) ? rawState : null;
  const departmentId = params.get("department") ?? "";

  const departments = useRefOptions("departments");

  const filters = useMemo(
    () => ({
      ...(state !== null ? { state } : {}),
      ...(departmentId !== "" ? { departmentIds: [departmentId] } : {}),
    }),
    [state, departmentId],
  );

  const board = useTodayBoard(filters, istDate);
  const rows = board.data ?? [];
  const total = useBoardTotal(istDate);

  // One server count per tile — the same predicate the rows use.
  const counts: Record<BoardState, ReturnType<typeof useBoardSlice>> = {
    in: useBoardSlice(STATE_TO_SLICE.in, istDate),
    yet_to_reach: useBoardSlice(STATE_TO_SLICE.yet_to_reach, istDate),
    late: useBoardSlice(STATE_TO_SLICE.late, istDate),
    overdue: useBoardSlice(STATE_TO_SLICE.overdue, istDate),
    off: useBoardSlice(STATE_TO_SLICE.off, istDate),
  };

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const columns: DataGridColumn<TodayBoardRow>[] = [
    {
      key: "display_name",
      header: t("admin.live.col.employee"),
      width: "15rem",
      sortable: true,
      render: (r) => (
        <PersonCell name={r.display_name} code={r.employee_code} secondary={r.department_name} />
      ),
    },
    {
      key: "shift_code",
      header: t("admin.live.col.shift"),
      width: "7rem",
      // The bare code, never shift_display_label — that field is built as
      // "G — 09:30 AM to 06:30 PM" and 12-hour clocks are banned (DR-53).
      render: (r) => dash(r.shift_code),
    },
    {
      key: "expected_by",
      header: t("admin.live.col.expected"),
      width: "8rem",
      align: "right",
      render: (r) => (
        <span className="num">{r.expected_by === null ? "—" : fmtTime(r.expected_by)}</span>
      ),
    },
    {
      key: "first_in_hm",
      header: t("admin.live.col.firstIn"),
      width: "8rem",
      align: "right",
      sortable: true,
      // Pre-rendered IST wall clock from the view.
      render: (r) => <span className="num font-medium">{dash(r.first_in_hm)}</span>,
    },
    {
      key: "last_out_hm",
      header: t("admin.live.col.lastOut"),
      width: "8rem",
      align: "right",
      render: (r) => <span className="num">{dash(r.last_out_hm)}</span>,
    },
    {
      key: "punch_count",
      header: t("admin.live.col.scans"),
      width: "6rem",
      align: "right",
      render: (r) => <span className="num">{formatNumber(r.punch_count)}</span>,
    },
    {
      key: "worked_hm",
      header: t("admin.live.col.worked"),
      width: "8rem",
      align: "right",
      hideBelow: "md",
      // Prefer the view's own string; fall back to formatting its minutes.
      render: (r) => (
        <span className="num">{r.worked_hm ?? fmtDurationHm(r.worked_minutes)}</span>
      ),
    },
    {
      key: "late_minutes",
      header: t("admin.live.col.late"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (r) =>
        r.is_late ? (
          <span className="num text-warning">{fmtDurationHm(r.late_minutes)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "status",
      header: t("admin.live.col.status"),
      width: "9rem",
      render: (r) =>
        r.status === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.live.status.noRecord")}</span>
        ) : (
          <StatusChip status={r.status} map={DAY_CHIP} />
        ),
    },
  ];

  const lastLooked = board.dataUpdatedAt > 0 ? fmtTime(board.dataUpdatedAt) : null;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Clock}
        title={t("admin.live.title")}
        subtitle={t("admin.live.subtitle", { date: fmtCivilDateWeekday(istDate) })}
        actions={
          <div className="flex items-center gap-3">
            {lastLooked !== null ? (
              <span className="num text-xs text-muted-foreground">
                {t("admin.live.lastRefreshed", { time: lastLooked })}
              </span>
            ) : null}
            <Button
              variant="outline"
              onClick={() => void board.refetch()}
              disabled={board.isFetching}
            >
              <RefreshCw
                className={cn("mr-2 size-4", board.isFetching && "animate-spin")}
                aria-hidden
              />
              {t("admin.live.refresh")}
            </Button>
          </div>
        }
      />

      {/* Presence tiles — server counts, each one a filter on the grid below. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TILES.map((tile) => {
          const q = counts[tile.state];
          const active = state === tile.state;
          return (
            <button
              key={tile.state}
              type="button"
              onClick={() => setParam("state", active ? "" : tile.state)}
              aria-pressed={active}
              className={cn(
                "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                TONE_RING[tile.tone],
                active && "ring-2 ring-primary",
              )}
            >
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p className="num mt-1 font-display text-2xl font-semibold">
                {q.isPending ? "…" : q.error !== null ? "—" : formatNumber(q.data)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.live.filter.department")}
          value={departmentId}
          placeholder={t("admin.live.filter.anyDepartment")}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => setParam("department", v)}
        />
        <div className="flex items-end">
          {state !== null || departmentId !== "" ? (
            <Button variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              {t("admin.live.filter.clear")}
            </Button>
          ) : null}
        </div>
        <div className="flex items-end justify-end">
          <p className="text-sm text-muted-foreground">
            {total.isSuccess
              ? t("admin.live.onRoll", { n: formatNumber(total.data) })
              : t("admin.live.onRollUnknown")}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={board.isPending}
          error={board.error}
          onRetry={() => void board.refetch()}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={Users}
              title={t("admin.live.empty.title")}
              hint={t("admin.live.empty.hint")}
            />
          }
        >
          <DataGrid columns={columns} rows={rows} rowKey={(r) => r.employee_id} pageSize={50} />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.live.footnote")}</Notice>
      </div>
    </div>
  );
}
