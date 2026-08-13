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
import { PeriodBanner } from "../components/PeriodBanner";
import { MonthDonut } from "../components/MonthDonut";
import { MonthGlance } from "../components/MonthGlance";
import { MonthStatusMix } from "../components/MonthStatusMix";
import { MonthKpis } from "../components/MonthKpis";

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
      key: "ot",
      header: t("attendance.col.ot"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => {
        const approved = row.day?.approved_overtime_minutes ?? null;
        if (approved !== null && approved > 0) return fmtDurationHm(approved);
        const eligible = row.day?.overtime_minutes ?? null;
        if (eligible !== null && eligible > 0) {
          return (
            <span className="text-muted-foreground">
              {t("attendance.grid.otPending", { value: fmtDurationHm(eligible) })}
            </span>
          );
        }
        return dash(null);
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
      {month === nowIstMonth() ? <SelfPunchCard className="mb-4" /> : null}

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

      <h2 className="mb-3 font-display text-lg font-semibold">
        {t("attendance.register.title")}
      </h2>

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
      </StateBoundary>
    </div>
  );
}
