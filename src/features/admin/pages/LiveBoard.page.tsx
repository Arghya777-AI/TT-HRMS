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
import { Fragment, useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { fmtMonthLong, isIstMonthKey, nowIstDate, type IstMonthKey } from "@/lib/datetime";
import {
  fromDayRecord,
  fromTodayBoard,
  isLiveScope,
  rangeFor,
  type BoardRow,
  monthOf,
  stepScope,
  type BoardScope,
} from "../attendanceBoard";
import { flattenDayRecords, useDayRecords } from "../hooks/useAttendanceRecords";
import { departmentTotals, grandTotal, type BucketMetric } from "../departmentTotals";
import { BucketDrillDown } from "../components/BucketDrillDown";

/** Rows per page when reading history. One page covers a month for a small venue. */
const DAY_PAGE = 200;
import { ChevronLeft, ChevronRight, Clock, RefreshCw, Users } from "lucide-react";
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

/**
 * A number on the subtotals table that opens the people behind it.
 *
 * A `<button>` rather than a click handler on the `<td>`: this is a real control, so it has to
 * be reachable by keyboard and announce its expanded state. `aria-expanded` is what tells a
 * screen-reader user that a panel appeared below.
 *
 * A zero is NOT a button. There is nothing behind it, and a control that opens an empty panel
 * teaches people that the controls do not work.
 */
function DrillCell({
  value,
  open,
  onToggle,
  tone,
  children,
}: {
  readonly value: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly tone?: "warning" | "destructive";
  readonly children: React.ReactNode;
}): React.JSX.Element {
  if (value === 0) {
    return <span className="text-muted-foreground">{children}</span>;
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "rounded px-1.5 py-0.5 tabular-nums underline decoration-dotted underline-offset-2",
        "hover:bg-primary/10 hover:decoration-solid focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        open && "bg-primary/15 font-semibold",
        tone === "warning" && "text-warning",
        tone === "destructive" && "text-destructive",
      )}
    >
      {children}
    </button>
  );
}

export default function LiveBoardPage() {
  const [params, setParams] = useSearchParams();
  const istDate = useIstToday();

  /*
    ── THE SCOPE: A DAY OR A MONTH ────────────────────────────────────────────────

    `?date=` picks a single day and `?month=` a whole one; absent both, today. Today is
    served by `v_attendance_today_board` and stays LIVE — it is the only source that can
    answer "expected by", "yet to reach" and "overdue", all computed against now().

    Any other day, and every month INCLUDING the current one, is served by
    `v_day_enriched`. The current month is deliberately not live: the today view returns
    one row per employee, so using it for a month would silently drop every other day.

    Both are normalised by `attendanceBoard.ts` into one row shape, so a column renderer
    never branches on which view it came from — that branching is how a column starts
    showing a different number depending on the date selected.
  */
  const monthParam = params.get("month");
  const dateParam = params.get("date");
  const scope: BoardScope = isIstMonthKey(monthParam ?? "")
    ? { kind: "month", month: monthParam ?? "" }
    : { kind: "day", date: dateParam !== null && dateParam !== "" ? dateParam : istDate };
  const live = isLiveScope(scope, istDate);
  const range = rangeFor(scope);

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

  /*
    The historical query is ENABLED ONLY when the scope is not live, so selecting a past
    date does not keep a second request in flight against today, and today does not pay for
    a query it will not read.
  */
  const history = useDayRecords(
    {
      from: range.from,
      to: range.to,
      ...(departmentId !== "" ? { departmentIds: [departmentId] } : {}),
    },
    live ? 1 : DAY_PAGE,
  );

  const rows: BoardRow[] = useMemo(
    () =>
      live
        ? (board.data ?? []).map(fromTodayBoard)
        : flattenDayRecords(history.data).map(fromDayRecord),
    [live, board.data, history.data],
  );
  const total = useBoardTotal(istDate);

  /* Subtotals over the rows on screen. See departmentTotals.ts for why these are the one
     figure on this console computed in the browser, and what is deliberately not averaged. */
  const deptTotals = useMemo(() => departmentTotals(rows), [rows]);
  const deptGrand = useMemo(() => grandTotal(deptTotals), [deptTotals]);

  /*
    Which drill-down is open, if any. ONE AT A TIME on purpose: the panel is a wide table of
    people and two of them open at once turns the subtotals into a wall. Re-clicking the same
    cell closes it.

    `dept` is `undefined` for the all-departments footer row and `null` for the unassigned
    bucket, matching `bucketMembers`.
  */
  const [openBucket, setOpenBucket] = useState<
    { dept: string | null | undefined; metric: BucketMetric } | null
  >(null);
  const isOpen = (dept: string | null | undefined, metric: BucketMetric): boolean =>
    openBucket !== null && openBucket.metric === metric && openBucket.dept === dept;
  const toggleBucket = (dept: string | null | undefined, metric: BucketMetric): void =>
    setOpenBucket((prev) => (prev !== null && prev.metric === metric && prev.dept === dept
      ? null
      : { dept, metric }));

  /* The date the drill-down asks about for leave. On a range the first day is the honest
     choice — the panel's own heading says which dates the counts came from. */
  const drillDate = rows[0]?.istDate ?? nowIstDate();
  const DEPT_COLUMNS = 7;

  // One server count per tile — the same predicate the rows use.
  const counts: Record<BoardState, ReturnType<typeof useBoardSlice>> = {
    in: useBoardSlice(STATE_TO_SLICE.in, istDate),
    yet_to_reach: useBoardSlice(STATE_TO_SLICE.yet_to_reach, istDate),
    late: useBoardSlice(STATE_TO_SLICE.late, istDate),
    overdue: useBoardSlice(STATE_TO_SLICE.overdue, istDate),
    off: useBoardSlice(STATE_TO_SLICE.off, istDate),
  };

  /** One writer for the scope, so `date` and `month` can never both be set. */
  const setScopeParam = (next: BoardScope) => {
    const p = new URLSearchParams(params);
    p.delete("date");
    p.delete("month");
    if (next.kind === "day") {
      if (next.date !== istDate) p.set("date", next.date);
    } else {
      p.set("month", next.month);
    }
    setParams(p, { replace: true });
  };

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const columns: DataGridColumn<BoardRow>[] = [
    {
      key: "displayName",
      header: t("admin.live.col.employee"),
      width: "15rem",
      sortable: true,
      /*
        THE NAME OPENS THAT PERSON'S SCANS. The board answers "is she in and was she
        late"; the next question is always "show me the actual scans" — how many, from
        which device or IP, where, and whether the geofence passed. Punch Log already
        answers all of it and already filters by `?emp=`, so this is a link rather than a
        second screen. Scoped to TODAY, because that is the day the board is about.
      */
      render: (r) => (
        <Link
          to={`/admin/attendance/punches?emp=${r.employeeId}&from=${istDate}&to=${istDate}`}
          className="block rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={t("admin.live.openScans", { name: r.displayName })}
        >
          <PersonCell name={r.displayName} code={r.employeeCode} secondary={r.departmentName} />
        </Link>
      ),
    },
    {
      key: "shiftCode",
      header: t("admin.live.col.shift"),
      width: "7rem",
      // The bare code, never shift_display_label — that field is built as
      // "G — 09:30 AM to 06:30 PM" and 12-hour clocks are banned (DR-53).
      render: (r) => dash(r.shiftCode),
    },
    {
      key: "expectedBy",
      header: t("admin.live.col.expected"),
      width: "8rem",
      align: "right",
      render: (r) => (
        <span className="num">{r.expectedBy === null ? "—" : fmtTime(r.expectedBy)}</span>
      ),
    },
    {
      key: "firstInHm",
      header: t("admin.live.col.firstIn"),
      width: "8rem",
      align: "right",
      sortable: true,
      // Pre-rendered IST wall clock from the view.
      render: (r) => <span className="num font-medium">{dash(r.firstInHm)}</span>,
    },
    {
      key: "lastOutHm",
      header: t("admin.live.col.lastOut"),
      width: "8rem",
      align: "right",
      render: (r) => <span className="num">{dash(r.lastOutHm)}</span>,
    },
    {
      key: "punchCount",
      header: t("admin.live.col.scans"),
      width: "6rem",
      align: "right",
      render: (r) => <span className="num">{formatNumber(r.punchCount)}</span>,
    },
    {
      key: "workedMinutes",
      header: t("admin.live.col.worked"),
      width: "8rem",
      align: "right",
      hideBelow: "md",
      // Prefer the view's own string; fall back to formatting its minutes.
      render: (r) => (
        <span className="num">{fmtDurationHm(r.workedMinutes)}</span>
      ),
    },
    {
      key: "lateMinutes",
      header: t("admin.live.col.late"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (r) =>
        r.isLate ? (
          <span className="num text-warning">{fmtDurationHm(r.lateMinutes)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    /*
      OVERTIME FOR THE DAY, which this board could not show until migration 039200 put it
      on the view. Two numbers in one cell, deliberately: the engine's figure and — when a
      manager has signed some off — what was approved. Payroll pays the approved number, so
      showing only the raw one tells a manager somebody is owed hours nobody agreed to.

      On a weekly off or a holiday the engine writes `extra_work_minutes` instead and
      overtime stays zero, so that is shown in its place rather than a misleading dash.
    */
    {
      key: "overtimeMinutes",
      header: t("admin.live.col.overtime"),
      width: "9rem",
      align: "right",
      render: (r) => {
        const ot = r.overtimeMinutes ?? 0;
        const approved = r.approvedOvertimeMinutes ?? 0;
        const extra = r.extraWorkMinutes ?? 0;
        if (ot === 0 && extra > 0) {
          return (
            <span className="num text-xs" title={t("admin.live.extraWorkHint")}>
              {fmtDurationHm(extra)}
              <span className="ml-1 text-muted-foreground">{t("admin.live.extraWorkTag")}</span>
            </span>
          );
        }
        if (ot === 0) return <span className="text-muted-foreground">—</span>;
        return (
          <span className="num flex flex-col items-end leading-tight">
            <span>{fmtDurationHm(ot)}</span>
            {approved > 0 && approved !== ot ? (
              <span className="text-[0.65rem] text-success">
                {t("admin.live.approvedOt", { hours: fmtDurationHm(approved) })}
              </span>
            ) : null}
            {approved === 0 ? (
              <span className="text-[0.65rem] text-muted-foreground">
                {t("admin.live.otUnapproved")}
              </span>
            ) : null}
          </span>
        );
      },
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
        title={t("admin.board.title")}
        subtitle={
          scope.kind === "month"
            ? t("admin.board.subtitle.month", { month: fmtMonthLong(scope.month as IstMonthKey) })
            : live
              ? t("admin.live.subtitle", { date: fmtCivilDateWeekday(istDate) })
              : t("admin.board.subtitle.day", { date: fmtCivilDateWeekday(scope.date) })
        }
        actions={
          <div className="flex items-center gap-3">
            {lastLooked !== null ? (
              <span className="num text-xs text-muted-foreground">
                {t("admin.live.lastRefreshed", { time: lastLooked })}
              </span>
            ) : null}
            <Button
              variant="outline"
              onClick={() => void (live ? board.refetch() : history.refetch())}
              disabled={live ? board.isFetching : history.isFetching}
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

      {/*
        Presence tiles — server counts, each one a filter on the grid below.

        THEY ARE TODAY'S COUNTS AND ONLY TODAY'S. Every one is a `count=exact` against
        `v_attendance_today_board`, which is hardcoded to `util.ist_today()`, so on a
        historical scope they would show today's numbers above yesterday's rows. Rather than
        render five confidently wrong figures they are hidden, and the note below says which
        columns stop applying on a settled day.
      */}
      {live ? (
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
      ) : (
        <p className="mt-4 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("admin.board.historicNote")}
        </p>
      )}

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
      {/*
        ── SCOPE: A DAY, OR A MONTH ──────────────────────────────────────────────
        Prev/next step the day (or the month) without a date picker, because stepping is
        what an administrator does most; the date and month inputs are there for a jump.
        "Today" returns to the live view, which is the only scope that can answer
        "expected by", "yet to reach" and "overdue".
      */}
      <section className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label={t("admin.board.prev")}
            onClick={() => setScopeParam(stepScope(scope, -1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label={t("admin.board.next")}
            onClick={() => setScopeParam(stepScope(scope, 1))}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-muted-foreground">{t("admin.board.day")}</span>
          <input
            type="date"
            value={scope.kind === "day" ? scope.date : ""}
            onChange={(event) => setScopeParam({ kind: "day", date: event.target.value })}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-muted-foreground">{t("admin.board.month")}</span>
          <input
            type="month"
            value={scope.kind === "month" ? scope.month : monthOf(scope.date)}
            onChange={(event) => setScopeParam({ kind: "month", month: event.target.value })}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          />
        </label>

        {!live ? (
          <Button variant="ghost" size="sm" onClick={() => setScopeParam({ kind: "day", date: istDate })}>
            {t("admin.board.today")}
          </Button>
        ) : (
          <span className="rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success">
            {t("admin.board.liveNow")}
          </span>
        )}
      </section>


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
      {/*
        ── PER-DEPARTMENT SUBTOTALS ──────────────────────────────────────────────
        Over EXACTLY the rows below, and labelled as such. Every other figure on this
        console is a server `count=exact`, because a browser sum over a page counts what
        arrived rather than what matched. These are different: the set being summed is the
        set on screen, and the reader can see it.

        No averages and no percentages, deliberately. Filter the board to "late only" and a
        per-department percentage becomes 100% everywhere — arithmetically right, completely
        misleading. Counts shrink visibly with the filter instead.
      */}
      {deptTotals.length > 1 ? (
        <section className="mt-4 overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <caption className="px-4 pt-3 text-left text-xs text-muted-foreground">
              {t("admin.board.dept.caption", { n: formatNumber(rows.length) })}
            </caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  {t("admin.board.dept.department")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("admin.board.dept.people")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("admin.board.dept.present")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("admin.board.dept.late")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("admin.board.dept.leave")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("admin.board.dept.absent")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("admin.board.dept.overtime")}
                </th>
              </tr>
            </thead>
            <tbody>
              {deptTotals.map((dept) => {
                const d = dept.departmentName;
                return (
                  <Fragment key={d ?? "unassigned"}>
                    <tr className="border-b last:border-0">
                      <td className="px-4 py-2">
                        {/* The department name opens its whole roster — every person in it,
                            whatever their state. */}
                        <DrillCell
                          value={dept.employees}
                          open={isOpen(d, "employees")}
                          onToggle={() => toggleBucket(d, "employees")}
                        >
                          {d ?? t("admin.board.dept.unassigned")}
                        </DrillCell>
                      </td>
                      <td className="num px-3 py-2 text-right tabular-nums">
                        <DrillCell
                          value={dept.employees}
                          open={isOpen(d, "employees")}
                          onToggle={() => toggleBucket(d, "employees")}
                        >
                          {formatNumber(dept.employees)}
                        </DrillCell>
                      </td>
                      <td className="num px-3 py-2 text-right tabular-nums">
                        <DrillCell
                          value={dept.present}
                          open={isOpen(d, "present")}
                          onToggle={() => toggleBucket(d, "present")}
                        >
                          {formatNumber(dept.present)}
                        </DrillCell>
                      </td>
                      <td className="num px-3 py-2 text-right tabular-nums">
                        <DrillCell
                          value={dept.late}
                          open={isOpen(d, "late")}
                          onToggle={() => toggleBucket(d, "late")}
                          tone="warning"
                        >
                          {formatNumber(dept.late)}
                        </DrillCell>
                      </td>
                      <td className="num px-3 py-2 text-right tabular-nums">
                        <DrillCell
                          value={dept.onLeave}
                          open={isOpen(d, "onLeave")}
                          onToggle={() => toggleBucket(d, "onLeave")}
                        >
                          {formatNumber(dept.onLeave)}
                        </DrillCell>
                      </td>
                      <td className="num px-3 py-2 text-right tabular-nums">
                        <DrillCell
                          value={dept.absent}
                          open={isOpen(d, "absent")}
                          onToggle={() => toggleBucket(d, "absent")}
                          tone="destructive"
                        >
                          {formatNumber(dept.absent)}
                        </DrillCell>
                      </td>
                      <td className="num px-3 py-2 text-right tabular-nums">
                        <DrillCell
                          value={dept.overtimeMinutes}
                          open={isOpen(d, "overtime")}
                          onToggle={() => toggleBucket(d, "overtime")}
                        >
                          {dept.overtimeMinutes > 0 ? fmtDurationHm(dept.overtimeMinutes) : "—"}
                        </DrillCell>
                      </td>
                    </tr>
                    {openBucket !== null && openBucket.dept === d ? (
                      <BucketDrillDown
                        rows={rows}
                        metric={openBucket.metric}
                        departmentName={d}
                        istDate={drillDate}
                        columnCount={DEPT_COLUMNS}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
            {/* Summed from the SAME buckets as the body, so the two provably agree. */}
            {/* The footer drills too, across EVERY department — `dept: undefined`. Its panel
                shows the department beside each name, which the per-department panels omit
                because there it would be the same word on every row. */}
            <tfoot>
              <tr className="border-t-2 font-semibold">
                <td className="px-4 py-2">
                  <DrillCell
                    value={deptGrand.employees}
                    open={isOpen(undefined, "employees")}
                    onToggle={() => toggleBucket(undefined, "employees")}
                  >
                    {t("admin.board.dept.all")}
                  </DrillCell>
                </td>
                <td className="num px-3 py-2 text-right tabular-nums">
                  <DrillCell
                    value={deptGrand.employees}
                    open={isOpen(undefined, "employees")}
                    onToggle={() => toggleBucket(undefined, "employees")}
                  >
                    {formatNumber(deptGrand.employees)}
                  </DrillCell>
                </td>
                <td className="num px-3 py-2 text-right tabular-nums">
                  <DrillCell
                    value={deptGrand.present}
                    open={isOpen(undefined, "present")}
                    onToggle={() => toggleBucket(undefined, "present")}
                  >
                    {formatNumber(deptGrand.present)}
                  </DrillCell>
                </td>
                <td className="num px-3 py-2 text-right tabular-nums">
                  <DrillCell
                    value={deptGrand.late}
                    open={isOpen(undefined, "late")}
                    onToggle={() => toggleBucket(undefined, "late")}
                    tone="warning"
                  >
                    {formatNumber(deptGrand.late)}
                  </DrillCell>
                </td>
                <td className="num px-3 py-2 text-right tabular-nums">
                  <DrillCell
                    value={deptGrand.onLeave}
                    open={isOpen(undefined, "onLeave")}
                    onToggle={() => toggleBucket(undefined, "onLeave")}
                  >
                    {formatNumber(deptGrand.onLeave)}
                  </DrillCell>
                </td>
                <td className="num px-3 py-2 text-right tabular-nums">
                  <DrillCell
                    value={deptGrand.absent}
                    open={isOpen(undefined, "absent")}
                    onToggle={() => toggleBucket(undefined, "absent")}
                    tone="destructive"
                  >
                    {formatNumber(deptGrand.absent)}
                  </DrillCell>
                </td>
                <td className="num px-3 py-2 text-right tabular-nums">
                  <DrillCell
                    value={deptGrand.overtimeMinutes}
                    open={isOpen(undefined, "overtime")}
                    onToggle={() => toggleBucket(undefined, "overtime")}
                  >
                    {deptGrand.overtimeMinutes > 0 ? fmtDurationHm(deptGrand.overtimeMinutes) : "—"}
                  </DrillCell>
                </td>
              </tr>
              {openBucket !== null && openBucket.dept === undefined ? (
                <BucketDrillDown
                  rows={rows}
                  metric={openBucket.metric}
                  istDate={drillDate}
                  columnCount={DEPT_COLUMNS}
                />
              ) : null}
            </tfoot>
          </table>
        </section>
      ) : null}

          <DataGrid columns={columns} rows={rows} rowKey={(r) => r.employeeId} pageSize={50} />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.live.footnote")}</Notice>
      </div>
    </div>
  );
}
