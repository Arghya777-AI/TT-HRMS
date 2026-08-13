/**
 * /team — Team Today. Who on MY team is in right now, and who is not.
 *
 * This is the manager's version of the story the whole product is built on:
 * ONE camera at the venue gate, a security guard operating it, and the FIRST
 * scan of the IST day becoming arrival while the LAST becomes departure. Scans
 * in between are counted and change neither. The board says that in as many
 * words at the bottom, because a manager looking at "3 scans" needs to know that
 * it does not mean three arrivals.
 *
 * Four rules held here:
 *
 *  1. MANAGERSHIP IS DERIVED, NEVER GRANTED. This page passes no manager id to
 *     anything. `v_attendance_today_board` carries `app.can_see_employee(e.id)`
 *     in its own WHERE clause, so "my team" is Postgres's answer, computed from
 *     reporting lines, and a client that forgot to filter cannot leak a row.
 *  2. NO ARITHMETIC. Every flag on this screen — attended, yet_to_reach,
 *     overdue, late_in, off_today — is a named boolean column of that view, and
 *     `first_in_hm` / `last_out_hm` / `worked_hm` arrive pre-rendered as IST wall
 *     clocks. Worked minutes already have the unpaid break removed and late
 *     minutes already have the grace period applied; this page prints them and
 *     decides nothing.
 *  3. THE TILES ARE SERVER COUNTS. Each tile is a `count=exact` over the SAME
 *     predicate as the rows it filters to (`teamPresenceFilters`), so a tile and
 *     the grid under it cannot disagree (DR-29). `rows.length` appears nowhere.
 *  4. IT SAYS WHEN IT LAST LOOKED. A live screen that goes quietly stale is
 *     worse than one that admits its age, so the refresh time is on the page.
 *
 * Selection lives in the URL, so a filtered board is a link a manager can send.
 *
 * @route /team
 */
import { useNavigate, useSearchParams } from "react-router-dom";
import { Clock, Inbox, RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDateWeekday, fmtDurationHm, fmtTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
// Shared with the admin console on purpose: `PersonCell` is the one place name
// and employee code are rendered without being concatenated (DR-23), and
// `Notice` is the one honest banner. Forking either would fork its defect fix.
import { PersonCell } from "@/features/admin/components/PersonCell";
import { Notice } from "@/features/admin/components/Notice";
import { CHART_TONE, type ChartTone } from "@/shared/ui/charts/chartTokens";
import { ProgressRing } from "@/shared/ui/charts/ProgressRing";
import { SplitBar, type SplitSegment } from "@/shared/ui/charts/SplitBar";
import {
  useBoardStateCount,
  useIstToday,
  useMyApprovalCount,
  useTeamPresenceCount,
  useTeamToday,
} from "../hooks/useTeamToday";
import {
  DAY_STATUS_CHIP,
  isTeamPresenceSlice,
  type BoardState,
  type TeamPresenceSlice,
  type TeamTodayRow,
} from "../api/team.api";

const TILES: readonly {
  slice: TeamPresenceSlice;
  label: string;
  tone: "success" | "info" | "warn" | "danger" | "neutral";
}[] = [
  { slice: "in", label: t("team.today.tile.in"), tone: "success" },
  { slice: "yet_to_reach", label: t("team.today.tile.yetToReach"), tone: "info" },
  { slice: "late", label: t("team.today.tile.late"), tone: "warn" },
  { slice: "overdue", label: t("team.today.tile.overdue"), tone: "danger" },
  { slice: "on_leave", label: t("team.today.tile.onLeave"), tone: "info" },
  { slice: "off", label: t("team.today.tile.off"), tone: "neutral" },
];

const TILE_HINT: Readonly<Record<TeamPresenceSlice, string>> = {
  in: t("team.today.tileHint.in"),
  yet_to_reach: t("team.today.tileHint.yetToReach"),
  late: t("team.today.tileHint.late"),
  overdue: t("team.today.tileHint.overdue"),
  on_leave: t("team.today.tileHint.onLeave"),
  off: t("team.today.tileHint.off"),
};

const TONE_RING: Readonly<Record<string, string>> = {
  success: "border-success/50",
  info: "border-info/50",
  warn: "border-warning/50",
  danger: "border-destructive/50",
  neutral: "border-border",
};

/**
 * THE THREE SLICES THAT CANNOT OVERLAP, and why the other three are not here.
 *
 * `v_attendance_today_board` derives its flags independently, so the six tiles
 * WERE six predicates over the same rows — NOT six buckets — and that is why an
 * earlier version of this bar drew only three of them.
 *
 * Two pairs nest: `late_in` can only be set from a first punch, so every late
 * arrival is already inside `attended`; `on_leave` is a status drawn from inside
 * the wider `off_today` set. And one pair genuinely double-counted, because
 * `attendance_days.is_working_day` is GENERATED as `NOT is_holiday AND NOT
 * is_weekly_off AND status NOT IN ('not_yet_joined','post_exit')` — approved
 * leave is not excluded, so a leave day on an ordinary Tuesday still carries a
 * `shift_start_at` and zero punches, and that person satisfied `off_today` AND,
 * past grace, `overdue`.
 *
 * MIGRATION 042900 FIXED THE DATA RATHER THAN THE PICTURE. `board_state` is one
 * exclusive value per person — in / off / yet_to_reach / missing / no_shift /
 * unknown — assigned in the order a human triages: IN beats everything, OFF
 * beats MISSING. So the whole board can now be drawn, the segments sum to the
 * headcount the page prints, and the Overdue tile has stopped counting people on
 * approved leave as missing.
 *
 * `unknown` is charted too, deliberately. It should always be zero; if it ever
 * is not, the gap in the rules belongs on screen rather than folded into a
 * neighbouring bucket where nobody would find it.
 */
const BOARD_SLICES: readonly { state: BoardState; label: string; tone: ChartTone }[] = [
  // Same catalogue keys as TILES wherever a tile exists, so a segment and its
  // tile cannot be worded differently; tones match the tile borders.
  { state: "in", label: t("team.today.tile.in"), tone: "present" },
  { state: "off", label: t("team.today.tile.off"), tone: "weeklyOff" },
  { state: "yet_to_reach", label: t("team.today.tile.yetToReach"), tone: "leave" },
  { state: "missing", label: t("team.today.tile.overdue"), tone: "absent" },
  { state: "no_shift", label: t("team.today.state.noShift"), tone: "neutral" },
  { state: "unknown", label: t("team.today.state.unknown"), tone: "late" },
];

export default function TeamTodayPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const istDate = useIstToday();

  const raw = params.get("state");
  const slice: TeamPresenceSlice | null = isTeamPresenceSlice(raw) ? raw : null;

  const board = useTeamToday(slice, istDate);
  const rows = board.data ?? [];

  /**
   * One server count per tile, plus the denominator. Each is its own query on
   * purpose: a tile that cannot be read shows an em dash and does not blank the
   * rest of the band.
   */
  const counts: Readonly<Record<TeamPresenceSlice, ReturnType<typeof useTeamPresenceCount>>> = {
    in: useTeamPresenceCount("in", istDate),
    yet_to_reach: useTeamPresenceCount("yet_to_reach", istDate),
    late: useTeamPresenceCount("late", istDate),
    overdue: useTeamPresenceCount("overdue", istDate),
    on_leave: useTeamPresenceCount("on_leave", istDate),
    off: useTeamPresenceCount("off", istDate),
  };
  const onBoard = useTeamPresenceCount(null, istDate);
  const approvals = useMyApprovalCount();

  /*
    THE PICTURE IS THE TILES, NOT A SECOND READING OF THEM.

    Every value below is `data` off one of the count queries already driving a
    tile — no row is counted, nothing is summed, and `rows.length` stays absent
    from this file. A slice whose count has not arrived (or failed) contributes
    NO segment, and a bar missing one of its three segments would silently
    reshape the other two, so the bar renders only once all three are in.
  */
  /*
    One count per exclusive bucket. Each is its own query, matching how every
    other figure on this console is produced, and the bar renders only when ALL
    of them have arrived — a missing segment would silently reshape the others
    into shares of a smaller whole.
  */
  const boardStateCounts = {
    in: useBoardStateCount("in"),
    off: useBoardStateCount("off"),
    yet_to_reach: useBoardStateCount("yet_to_reach"),
    missing: useBoardStateCount("missing"),
    no_shift: useBoardStateCount("no_shift"),
    unknown: useBoardStateCount("unknown"),
  } as const satisfies Record<BoardState, ReturnType<typeof useBoardStateCount>>;

  const gateSegments: SplitSegment[] = BOARD_SLICES.flatMap((bucket) => {
    const value = boardStateCounts[bucket.state].data;
    return value === undefined
      ? []
      : [{ key: bucket.state, label: bucket.label, value, tone: bucket.tone }];
  });
  const gateReady = gateSegments.length === BOARD_SLICES.length;

  /*
    The ring is the one ratio on this page that is provably exact: `attended` is
    a filter over the very rows `onBoard` counts unfiltered, so the numerator is
    a subset of the denominator by construction and the arc can never overrun.
    Both numbers are already printed — the "In" tile and the board line below.
  */
  const inCount = counts.in.data;
  const boardCount = onBoard.data;
  const showPresence = boardCount !== undefined && boardCount > 0;

  const setSlice = (next: TeamPresenceSlice | null) => {
    const params2 = new URLSearchParams(params);
    if (next === null) params2.delete("state");
    else params2.set("state", next);
    setParams(params2, { replace: true });
  };

  const columns: DataGridColumn<TeamTodayRow>[] = [
    {
      key: "display_name",
      header: t("team.today.col.employee"),
      width: "15rem",
      sortable: true,
      render: (r) => (
        <PersonCell name={r.display_name} code={r.employee_code} secondary={r.department_name} />
      ),
    },
    {
      key: "shift_code",
      header: t("team.today.col.shift"),
      width: "6rem",
      // The bare code. `shift_display_label` is built as "G — 09:30 AM to
      // 06:30 PM" and a 12-hour clock is banned (DR-53), so it is not even
      // selected from the view.
      render: (r) => dash(r.shift_code),
    },
    {
      key: "expected_by",
      header: t("team.today.col.expected"),
      width: "8rem",
      align: "right",
      hideBelow: "md",
      // shift start + the grace the SERVER chose (policy, else shift, else 10m).
      render: (r) => (
        <span className="num">{r.expected_by === null ? "—" : fmtTime(r.expected_by)}</span>
      ),
    },
    {
      key: "first_in_hm",
      header: t("team.today.col.firstScan"),
      width: "8rem",
      align: "right",
      sortable: true,
      render: (r) => <span className="num font-medium">{dash(r.first_in_hm)}</span>,
    },
    {
      key: "last_out_hm",
      header: t("team.today.col.lastScan"),
      width: "8rem",
      align: "right",
      render: (r) => <span className="num">{dash(r.last_out_hm)}</span>,
    },
    {
      key: "punch_count",
      header: t("team.today.col.scans"),
      width: "6rem",
      align: "right",
      hideBelow: "md",
      render: (r) => <span className="num">{formatNumber(r.punch_count)}</span>,
    },
    {
      key: "worked_hm",
      header: t("team.today.col.worked"),
      width: "8rem",
      align: "right",
      hideBelow: "md",
      // The view's own 'H:MM'; fall back to formatting its own minutes column.
      render: (r) => <span className="num">{r.worked_hm ?? fmtDurationHm(r.worked_minutes)}</span>,
    },
    {
      key: "late_minutes",
      header: t("team.today.col.late"),
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
      header: t("team.today.col.status"),
      width: "10rem",
      render: (r) => <StatusChip status={r.status} map={DAY_STATUS_CHIP} />,
    },
  ];

  const lastLooked = board.dataUpdatedAt > 0 ? fmtTime(board.dataUpdatedAt) : null;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Clock}
        title={t("team.today.title")}
        subtitle={t("team.today.subtitle", { date: fmtCivilDateWeekday(istDate) })}
        actions={
          <div className="flex items-center gap-3">
            {lastLooked !== null ? (
              <span className="num text-xs text-muted-foreground">
                {t("team.today.lastRefreshed", { time: lastLooked })}
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
              {t("team.today.refresh")}
            </Button>
          </div>
        }
      />

      {/* Presence tiles — each a server count, each a filter on the grid below. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {TILES.map((tile) => {
          const q = counts[tile.slice];
          const active = slice === tile.slice;
          return (
            <button
              key={tile.slice}
              type="button"
              onClick={() => setSlice(active ? null : tile.slice)}
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
              <p className="mt-1 text-xs text-muted-foreground">{TILE_HINT[tile.slice]}</p>
            </button>
          );
        })}
      </div>

      {/* The same counts, drawn — beside the tiles, never instead of them. */}
      {showPresence ? (
        <section className="mt-4 rounded-lg border bg-card p-4">
          <h2 className="font-display text-sm font-semibold">{t("team.today.chart.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("team.today.chart.hint")}</p>
          <div className="mt-4 flex flex-col items-center gap-6 sm:flex-row sm:items-center">
            {inCount === undefined ? null : (
              <ProgressRing
                value={inCount}
                total={boardCount}
                centre={formatNumber(inCount)}
                caption={t("team.today.chart.ring.caption", { n: formatNumber(boardCount) })}
                title={t("team.today.chart.ring.title")}
                color={CHART_TONE.present}
                className="sm:shrink-0"
              />
            )}
            {gateReady ? (
              <div className="w-full min-w-0 flex-1">
                <SplitBar
                  segments={gateSegments}
                  title={t("team.today.chart.gate.title")}
                  format={formatNumber}
                  height={14}
                />
              </div>
            ) : null}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">{t("team.today.chart.note")}</p>
        </section>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground">
          {onBoard.isSuccess
            ? t("team.today.onBoard", { n: formatNumber(onBoard.data) })
            : t("team.today.onBoardUnknown")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {approvals.isSuccess
              ? t("team.today.approvalsWaiting", { n: formatNumber(approvals.data) })
              : t("team.today.approvalsUnknown")}
          </span>
          <Button variant="outline" size="sm" onClick={() => void navigate("/team/approvals")}>
            <Inbox className="mr-2 size-4" aria-hidden />
            {t("team.today.openApprovals")}
          </Button>
          {slice !== null ? (
            <Button variant="ghost" size="sm" onClick={() => setSlice(null)}>
              {t("team.today.showEveryone")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={board.isPending}
          error={board.error}
          onRetry={() => void board.refetch()}
          isEmpty={rows.length === 0}
          empty={
            slice !== null ? (
              <EmptyState
                icon={Users}
                title={t("team.today.empty.filtered.title")}
                hint={t("team.today.empty.filtered.hint")}
                action={
                  <Button variant="outline" onClick={() => setSlice(null)}>
                    {t("team.today.showEveryone")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Users}
                title={t("team.today.empty.title")}
                hint={t("team.today.empty.hint")}
              />
            )
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.employee_id}
            pageSize={50}
            onRowClick={(r) => void navigate(`/team/people/${r.employee_code}`)}
          />
        </StateBoundary>
      </div>

      <div className="mt-4 space-y-3">
        <Notice tone="info">{t("team.today.footnote.gate")}</Notice>
        <Notice tone="info">{t("team.today.footnote.noArithmetic")}</Notice>
      </div>
    </div>
  );
}
