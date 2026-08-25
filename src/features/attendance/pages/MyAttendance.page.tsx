/**
 * E-03 · /me/attendance — one calendar month of my attendance.
 *
 * Every number on this screen comes from ONE server row
 * (`f_attendance_period_summary`), the same row the payslip reads. There is no
 * client aggregation anywhere in this file: the donut plots named columns, the 14
 * tiles print named columns, and the register prints one view row per date. That
 * is the structural fix for the reference product's dashboard-vs-modal
 * disagreement (spec-screens DR-29).
 *
 * The other two invariants worth stating out loud:
 *  - The period is the CALENDAR month, `?m=YYYY-MM`, with elapsed days as the
 *    denominator and the payroll cutoff surfaced as an arrears line (DR-34).
 *  - A date that has not happened yet is `not_yet` — it is in the register, it is
 *    never an absent, and it is in no denominator (DR-30).
 *
 * @route /me/attendance
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CalendarClock, Clock, Lock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import {
  fmtCivilDayMonthWeekday,
  fmtDurationHm,
  fmtMonthLong,
  fmtTime,
  fmtTimeWithDayOffset,
  isIstMonthKey,
  istMonthRange,
  istToday,
  nowIstMonth,
} from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { ShiftRefRow } from "../api/attendance.api";
import {
  useAttendanceDays,
  useAttendancePeriodSummary,
  useMyAttendanceContext,
  usePayPeriod,
  useShiftRefs,
  useWeeklyOffRuleRef,
} from "../hooks/useAttendance";
import { dayStatusChip, shiftDisplay, NOT_YET } from "../display";
import { buildRegisterRows, sliceMatchesRow, type RegisterRow, type SliceKey } from "../register";
import { PeriodSelector } from "../components/PeriodSelector";
import { SelfPunchCard } from "../components/SelfPunchCard";
import { TodayLive } from "../components/TodayLive";
import { useSelfPunchState } from "../hooks/useSelfPunch";
import { PeriodBanner } from "../components/PeriodBanner";
import { MonthDonut } from "../components/MonthDonut";
import { MonthGlance } from "../components/MonthGlance";
import { MonthStatusMix } from "../components/MonthStatusMix";
import { MonthKpis } from "../components/MonthKpis";
import { MonthTotals } from "../components/MonthTotals";
import { MonthSummaryPanel } from "../components/MonthSummaryPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dayVariance, fmtSignedMinutes, type NoExpectationReason } from "../lib/variance";

/**
 * Why a day contributed nothing, in words.
 *
 * A dash with no explanation invites the question this column exists to answer. Kept beside the
 * column rather than inside `variance.ts`, so the calculation stays free of copy.
 */
const VARIANCE_REASON_KEY: Record<NoExpectationReason, Parameters<typeof t>[0]> = {
  holiday: "attendance.variance.reason.holiday",
  weekly_off: "attendance.variance.reason.weeklyOff",
  on_leave: "attendance.variance.reason.onLeave",
  not_working_day: "attendance.variance.reason.notWorking",
  unresolved: "attendance.variance.reason.unresolved",
};

const SLICE_LABEL_KEY: Record<SliceKey, Parameters<typeof t>[0]> = {
  attended: "attendance.slice.attended",
  half: "attendance.slice.half",
  weeklyOff: "attendance.slice.weeklyOff",
  holiday: "attendance.slice.holiday",
  leave: "attendance.slice.leave",
  compOff: "attendance.slice.compOff",
  absent: "attendance.slice.absent",
  pending: "attendance.slice.pending",
};

export default function MyAttendancePage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  // The month lives in the URL. A malformed `?m=` falls back to this month
  // rather than throwing — a bad link should still land somewhere honest.
  const requested = params.get("m");
  const month = requested !== null && isIstMonthKey(requested) ? requested : nowIstMonth();
  const range = useMemo(() => istMonthRange(month), [month]);

  const context = useMyAttendanceContext();
  const summary = useAttendancePeriodSummary(month, range);
  const days = useAttendanceDays(range);
  const payPeriod = usePayPeriod(month);
  const weeklyOff = useWeeklyOffRuleRef(context.data?.weekly_off_rule_id ?? null);

  const [slice, setSlice] = useState<SliceKey | null>(null);
  useEffect(() => setSlice(null), [month]);

  // The register needs the shift master rows the month actually references, plus
  // the employee's standard shift for the banner chip.
  const shiftIds = useMemo(() => {
    const ids = (days.data ?? [])
      .map((d) => d.shift_id)
      .filter((id): id is string => id !== null);
    const standard = context.data?.shift_id ?? null;
    if (standard !== null) ids.push(standard);
    return ids;
  }, [days.data, context.data]);
  const shifts = useShiftRefs(shiftIds);

  const rows = useMemo(() => buildRegisterRows(month, days.data ?? []), [month, days.data]);

  /*
    Today's computed row, for the shift the live panel measures against.

    The engine may not have PROCESSED today — it usually has not — but the row still carries the
    shift, its duration and any leave, which is everything `TodayLive` needs to know what today
    expects. Worked minutes come from the punches instead, live.
  */
  /*
    The tab lives in the URL, matching how MyDocuments does it. Two reasons: a link to somebody's
    full summary is a thing people send each other, and the back button should undo a tab change
    rather than leaving the page.
  */
  const tab = params.get("tab") === "summary" ? "summary" : "register";
  function selectTab(next: string) {
    const nextParams = new URLSearchParams(params);
    if (next === "register") nextParams.delete("tab");
    else nextParams.set("tab", next);
    setParams(nextParams, { replace: true });
  }

  const punchState = useSelfPunchState(month === nowIstMonth());
  const todayRow = useMemo(() => {
    const target = punchState.data?.businessDate ?? istToday();
    return (days.data ?? []).find((d) => d.ist_date === target) ?? null;
  }, [days.data, punchState.data]);
  const visibleRows = useMemo(
    () => (slice === null ? rows : rows.filter((row) => sliceMatchesRow(slice, row))),
    [rows, slice],
  );

  function setMonth(next: string): void {
    const nextParams = new URLSearchParams(params);
    nextParams.set("m", next);
    setParams(nextParams, { replace: false });
  }

  const monthLabel = fmtMonthLong(month);
  const shiftMap: ReadonlyMap<string, ShiftRefRow> = shifts.data ?? new Map<string, ShiftRefRow>();
  const standardShift =
    context.data?.shift_id != null ? shiftMap.get(context.data.shift_id) ?? null : null;

  const columns: DataGridColumn<RegisterRow>[] = [
    {
      key: "istDate",
      header: t("attendance.col.date"),
      width: "9rem",
      sortable: true,
      sortValue: (row) => row.istDate,
      render: (row) => fmtCivilDayMonthWeekday(row.istDate),
    },
    {
      key: "status",
      header: t("attendance.col.status"),
      width: "13rem",
      render: (row) => (
        <StatusChip
          status={row.status}
          map={dayStatusChip(row.status, row.day?.leave_type_name ?? null)}
        />
      ),
    },
    {
      key: "shift",
      header: t("attendance.col.shift"),
      hideBelow: "md",
      render: (row) => {
        if (row.day === null) return dash(null);
        const shift = shiftDisplay(row.day, shiftMap);
        if (shift === null) return t("attendance.grid.noShift");
        return (
          <span className="flex flex-col leading-tight">
            <span>{shift.name}</span>
            <span className="num text-xs text-muted-foreground">{shift.window}</span>
          </span>
        );
      },
    },
    {
      key: "in",
      header: t("attendance.col.in"),
      width: "7rem",
      render: (row) => {
        if (row.day === null) return dash(null);
        const time = dash(row.day.first_in_at, fmtTime);
        if (!row.day.is_regularized) return time;
        return (
          <span className="inline-flex items-center gap-1">
            <span className="num">{time}</span>
            <Pencil
              className="h-3 w-3 text-muted-foreground"
              aria-label={t("attendance.grid.regularized")}
            />
          </span>
        );
      },
    },
    {
      key: "out",
      header: t("attendance.col.out"),
      width: "8rem",
      // Cross-midnight check-outs read '06:04 (+1d)' — a bare '06:04' against
      // yesterday's date reads as a 22-hour day.
      render: (row) =>
        row.day === null ? dash(null) : fmtTimeWithDayOffset(row.day.last_out_at, row.istDate),
    },
    {
      key: "worked",
      header: t("attendance.col.worked"),
      width: "7rem",
      align: "right",
      render: (row) => (row.day === null ? dash(null) : fmtDurationHm(row.day.total_worked_minutes)),
    },
    {
      key: "late",
      header: t("attendance.col.late"),
      width: "7rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => {
        const late = row.day?.late_minutes ?? null;
        if (late === null || late <= 0) return dash(null);
        return <span className="text-warning">{fmtDurationHm(late)}</span>;
      },
    },
    {
      /*
        ── MORE OR LESS THAN THE SHIFT ─────────────────────────────────────────
        The column the WORKED figure on its own cannot answer: nine hours is a full day on one
        shift and a short one on another, and nobody reads a shift length off a table.

        Green ahead, red behind, and the sign is printed even when positive — in a column that
        holds either direction, an unsigned "1h 20m" is ambiguous at exactly the glance this
        column exists for.

        A day that expects nothing says so instead of showing a zero. "—" with a reason beats a
        number that looks like a measurement but is not one.
      */
      /*
        ── ONE COLUMN, TWO FACTS THAT ARE NOT THE SAME NUMBER ──────────────────
        This replaced a separate OT column, because two adjacent columns both about "extra
        time" read as a duplicate — and on most rows the OT one was empty, which made it look
        redundant rather than different.

        They are genuinely different, which is why the payable figure survives as a sub-line
        instead of being deleted:

          THE BIG NUMBER is arithmetic — worked minus what the shift expected. Nobody has to
          agree to it; it is simply what happened.
          THE SUB-LINE is what payroll will act on. Overtime is filtered by eligibility, a
          minimum before it counts at all, rounding, a daily cap, and approval. Somebody can
          work ninety minutes over and be paid for none of it.

        Collapsing to one number would have told an employee they were owed something nobody had
        approved. Keeping two columns implied they were the same measurement. A number and its
        payable consequence, stacked, is neither.
      */
      key: "variance",
      header: t("attendance.col.variance"),
      width: "11rem",
      align: "right",
      hideBelow: "md",
      render: (row) => {
        if (row.day === null) return dash(null);
        const v = dayVariance(row.day);
        if (!v.counts) {
          return (
            <span className="text-muted-foreground" title={t(VARIANCE_REASON_KEY[v.reason ?? "unresolved"])}>
              {dash(null)}
            </span>
          );
        }

        const approved = row.day.approved_overtime_minutes ?? 0;
        const eligible = row.day.overtime_minutes ?? 0;
        // Only ever shown on a surplus day: "pending approval" against a shortfall is nonsense.
        const payable =
          v.varianceMinutes > 0 && approved > 0
            ? t("attendance.grid.otApproved", { value: fmtDurationHm(approved) })
            : v.varianceMinutes > 0 && eligible > 0
              ? t("attendance.grid.otPending", { value: fmtDurationHm(eligible) })
              : null;

        return (
          <span className="inline-flex flex-col items-end leading-tight">
            <span
              className={
                v.varianceMinutes === 0
                  ? "text-muted-foreground"
                  : v.varianceMinutes > 0
                    ? "text-success"
                    : "text-destructive"
              }
              title={t("attendance.grid.varianceHint", {
                worked: fmtDurationHm(v.workedMinutes),
                expected: fmtDurationHm(v.expectedMinutes),
              })}
            >
              {v.varianceMinutes === 0 ? "0m" : fmtSignedMinutes(v.varianceMinutes)}
            </span>
            {payable !== null ? (
              <span className="text-[11px] text-muted-foreground">{payable}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "action",
      header: t("attendance.col.action"),
      width: "8rem",
      align: "right",
      render: (row) => {
        if (row.status === NOT_YET) return dash(null);
        // The cell swallows the click so the row's own navigation cannot race
        // the link the reader actually pressed.
        return (
          <span onClick={(e) => e.stopPropagation()}>
            {row.day?.is_locked === true ? (
              <span
                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                title={t("attendance.action.locked")}
              >
                <Lock className="h-3.5 w-3.5" aria-hidden />
                {t("attendance.action.locked")}
              </span>
            ) : (row.day?.punch_count ?? 0) > 0 ? (
              <Button variant="outline" size="sm" asChild>
                <Link to={`/me/attendance/${row.istDate}`}>{t("attendance.action.punches")}</Link>
              </Button>
            ) : (
              <Button variant="ghost" size="sm" asChild>
                <Link to={`/me/regularizations/new?date=${row.istDate}`}>
                  {t("attendance.action.fix")}
                </Link>
              </Button>
            )}
          </span>
        );
      },
    },
  ];

  // No employee record on this login (kiosk-only staff): an honest wall, not a
  // spinner and not an empty grid.
  if (context.isSuccess && context.data === null) {
    return (
      <div className="container py-6">
        <PageHeader
          icon={CalendarClock}
          title={t("attendance.page.title")}
          subtitle={t("attendance.page.subtitle")}
        />
        <EmptyState
          icon={Lock}
          title={t("attendance.state.noEmployee.title")}
          hint={t("attendance.state.noEmployee.hint")}
        />
      </div>
    );
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarClock}
        title={t("attendance.page.title")}
        subtitle={t("attendance.page.subtitle")}
        actions={
          <PeriodSelector
            month={month}
            dateOfJoin={context.data?.date_of_join ?? null}
            onChange={setMonth}
          />
        }
      />

      {/* The punch button, on the screen the employee opens to check today.
          Shown only while the CURRENT month is selected: it records a punch at
          this instant, and offering it under a register of March last year would
          imply it writes there. */}
      {/*
        The punch card, and beside it where today actually stands.

        Only on the current month: a live panel on a past month would be counting nothing, and
        `TodayLive` returns null before the first scan of the day so a fresh morning shows the
        card alone rather than an empty frame.
      */}
      {month === nowIstMonth() ? (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <SelfPunchCard />
          <TodayLive today={todayRow} state={punchState.data ?? null} />
        </div>
      ) : null}

      <StateBoundary
        loading={payPeriod.isLoading || context.isLoading}
        partialError={payPeriod.error ?? context.error ?? undefined}
        partialLabel={t("attendance.chip.shift")}
        skeletonRows={1}
      >
        <PeriodBanner
          month={month}
          payPeriod={payPeriod.data ?? null}
          shift={standardShift}
          weeklyOffRuleName={weeklyOff.data?.name ?? null}
        />
      </StateBoundary>

      <StateBoundary
        loading={summary.isLoading}
        error={summary.error ?? undefined}
        onRetry={() => void summary.refetch()}
        isEmpty={summary.isSuccess && summary.data === null}
        empty={
          <EmptyState
            icon={Clock}
            title={t("attendance.summary.missing.title", { month: monthLabel })}
            hint={t("attendance.summary.missing.hint")}
            action={
              <Button variant="outline" asChild>
                <Link to="/me/regularizations/new">{t("attendance.day.regularize")}</Link>
              </Button>
            }
          />
        }
        skeletonRows={4}
      >
        {summary.data !== null && summary.data !== undefined ? (
          <>
            <section className="mb-6 rounded-lg border bg-card p-4">
              <MonthDonut
                month={month}
                summary={summary.data}
                activeKey={slice}
                onSelect={setSlice}
              />
              {slice !== null ? (
                <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{t("attendance.donut.filtered", { label: t(SLICE_LABEL_KEY[slice]) })}</span>
                  <Button variant="outline" size="sm" onClick={() => setSlice(null)}>
                    {t("attendance.donut.clear")}
                  </Button>
                </p>
              ) : null}
            </section>

            <MonthKpis month={month} summary={summary.data} />
          </>
        ) : null}
      </StateBoundary>

      {/* The month in two pictures, in the register's own colours and directly
          above it. Both read server columns only — the split bar the summary
          row, the day bars the same `total_worked_minutes` the Worked column
          below prints — so neither can state a figure the table contradicts.
          It carries no state of its own and is deliberately NOT filtered by the
          donut slice: it is the shape of the whole month, and a four-bar chart
          under a filtered register would answer a question nobody asked. */}
      <MonthGlance rows={rows} summary={summary.data ?? null} />

      {/*
        BESIDE MonthGlance, not instead of it. That panel draws the summary's day
        columns, which answer "how many days had this property" and deliberately
        overlap; this one draws `attendance_days.status`, which is a partition, so
        its segments genuinely sum to the days shown. Two true questions, two
        bars, neither pretending to be the other.
      */}
      <MonthStatusMix from={range.from} to={range.to} />

      {/*
        Two views of the same month, not two pages.

        The register answers "what happened on the 3rd"; the summary answers "where did the month
        land, and what does it come to". They share every query above, so the two can never
        disagree — which is the whole reason they are tabs rather than separate routes with
        separate fetches.
      */}
      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList aria-label={t("attendance.tabs.label")} className="mb-4 h-auto flex-wrap">
          <TabsTrigger value="register">{t("attendance.register.title")}</TabsTrigger>
          <TabsTrigger value="summary">{t("attendance.summaryTab.label")}</TabsTrigger>
        </TabsList>

        <TabsContent value="summary">
          <StateBoundary
            loading={days.isLoading || summary.isLoading}
            error={days.error ?? summary.error ?? undefined}
            onRetry={() => {
              void days.refetch();
              void summary.refetch();
            }}
            skeletonRows={4}
          >
            <MonthSummaryPanel
              days={days.data ?? []}
              summary={summary.data ?? null}
              monthLabel={monthLabel}
            />
          </StateBoundary>
        </TabsContent>

        <TabsContent value="register">

      {/*
        Above the table, not below it. The column it explains is the one people will ask about
        first, and an explanation placed after the numbers is read after the confusion.
      */}
      <p className="mb-3 rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-snug text-muted-foreground">
        {t("attendance.grid.varianceLegend")}
      </p>

      <StateBoundary
        loading={days.isLoading}
        error={days.error ?? undefined}
        onRetry={() => void days.refetch()}
        partialError={shifts.error ?? undefined}
        partialLabel={t("attendance.col.shift")}
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={visibleRows}
          rowKey={(row) => row.istDate}
          pageSize={31}
          onRowClick={(row) => {
            if (row.status === NOT_YET) return;
            navigate(`/me/attendance/${row.istDate}`);
          }}
          emptyState={
            slice === null ? (
              <EmptyState
                icon={Clock}
                title={t("attendance.empty.title", { month: monthLabel })}
                hint={t("attendance.empty.hint")}
              />
            ) : (
              <EmptyState
                icon={Clock}
                title={t("attendance.emptyFiltered.title", { label: t(SLICE_LABEL_KEY[slice]) })}
                hint={t("attendance.emptyFiltered.hint")}
                action={
                  <Button variant="outline" onClick={() => setSlice(null)}>
                    {t("attendance.donut.clear")}
                  </Button>
                }
              />
            )
          }
        />

        {/*
          Under the table, because a reader arrives at the total having just scrolled the
          evidence for it. Draws from the same rows the grid does, so the two cannot disagree.
        */}
        <MonthTotals days={days.data ?? []} monthLabel={monthLabel} />
      </StateBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
}
