/**
 * §14 · /admin/analytics/attendance — punctuality, hours and exceptions over time.
 *
 * Four deployed relations back this screen, and each one dictates the shape of
 * the panel that reads it:
 *
 *  * `v_attendance_late_trend` is already grouped by date, so the trend chart
 *    plots `late_count` / `on_time_count` / `absent_count` straight from the row
 *    and prints the view's own `late_pct` beside them (clamped [0,100] by
 *    `fn_late_pct` — this is the screen where the incumbent's "1,700.00%" came
 *    from, and the clamp lives in Postgres, not here).
 *  * `v_attendance_hour_buckets` is grouped by (date, bucket) with a `pct_of_date`
 *    computed per date. A range would therefore need the client to add day
 *    counts together, so the distribution is shown for ONE date and the date is
 *    a control on the page.
 *  * `v_attendance_in_trend` is per employee × date and carries `first_in_minutes`
 *    plus the pre-rendered 24-hour `first_in_hm`. It is read server-ORDERED, so
 *    "the latest arrivals" is Postgres's ranking, not a client sort of a page.
 *  * `v_attendance_monthly_summary` wraps `analytics.mv_attendance_monthly`, so
 *    every figure in that grid is AS OF the last refresh. The stamp is printed at
 *    the top from the matview's own `refreshed_at`, and there is no refresh
 *    button because `public.refresh_analytics()` is granted to `service_role`
 *    only (031/057) — a button that cannot work is worse than none.
 *
 * The month tiles do NOT come from the matview: they are `count=exact` over
 * `v_attendance_day_enriched` with the Day Records screen's own predicates, so
 * each tile equals the grid it opens. Nothing on this page is summed, averaged
 * or ranked in the browser.
 *
 * @route /admin/analytics/attendance
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3, Clock } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import {
  fmtCivilDate,
  fmtCivilDayMonthWeekday,
  fmtDateTime,
  fmtDurationHm,
  fmtMonthLong,
  istMonthRange,
  nowIstDate,
  nowIstMonth,
} from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { CountTile } from "../components/CountTile";
import { MonthStepper } from "../components/MonthStepper";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { TextField } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  useAttendanceMonthly,
  useAttendanceStamp,
  useHourBuckets,
  useLatestFirstIns,
  useLateTrend,
  useMonthDayCounts,
  ANALYTICS_ROW_CAP,
  FIRST_IN_ROW_CAP,
} from "../hooks/useAnalyticsWorkforce";
import type {
  AttendanceMonthlyRow,
  HourBucketRow,
  InTrendRow,
  LateTrendRow,
} from "../api/analytics-workforce.api";

const GRID_STROKE = "hsl(var(--border))";
const LATE_STROKE = "hsl(var(--chart-2))";
const ON_TIME_STROKE = "hsl(var(--chart-5))";
const ABSENT_STROKE = "hsl(var(--chart-4))";
const BUCKET_FILL = "hsl(var(--chart-3))";

/** 'YYYY-MM' → the numbers the matview is keyed by. */
function monthParts(month: string): { year: number; month: number } {
  return { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
}

export default function AnalyticsAttendancePage() {
  const [params, setParams] = useSearchParams();

  const monthParam = params.get("m");
  const month = monthParam !== null && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : nowIstMonth();
  const { from, to } = istMonthRange(month);
  // A month that is not the current one has no "today" in it; its last date is
  // the honest default for a single-day distribution.
  const defaultDate = month === nowIstMonth() ? nowIstDate() : to;
  const dateParam = params.get("d");
  const date = dateParam !== null && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : defaultDate;

  const labels = useEmployeeLabels();
  const stamp = useAttendanceStamp();
  const dayCounts = useMonthDayCounts(month);
  const trend = useLateTrend(from, to);
  const buckets = useHourBuckets(date);
  const firstIns = useLatestFirstIns(date);
  const { year, month: monthNumber } = monthParts(month);
  const monthly = useAttendanceMonthly(year, monthNumber);

  // Memoised because the trend chart's points derive from it: a fresh `[]` on
  // every render would rebuild the series (and the chart) for nothing.
  const trendRows = useMemo(() => trend.data ?? [], [trend.data]);
  const bucketRows = buckets.data ?? [];
  const firstInRows = firstIns.data ?? [];
  const monthlyRows = monthly.data ?? [];

  /** Chart points: one per date, every value a column of the view. */
  const trendPoints = useMemo(
    () =>
      trendRows.map((row) => ({
        date: row.ist_date,
        label: fmtCivilDayMonthWeekday(row.ist_date),
        late: row.late_count,
        onTime: row.on_time_count,
        absent: row.absent_count,
      })),
    [trendRows],
  );

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  /** Stepping the month drops an explicit date, so the default follows along. */
  function setMonth(next: string): void {
    const params2 = new URLSearchParams(params);
    params2.set("m", next);
    params2.delete("d");
    setParams(params2, { replace: true });
  }

  const trendColumns: DataGridColumn<LateTrendRow>[] = useMemo(
    () => [
      {
        key: "ist_date",
        header: t("admin.analytics.att.col.date"),
        width: "12rem",
        sortable: true,
        render: (row) => fmtCivilDayMonthWeekday(row.ist_date),
      },
      {
        key: "working_count",
        header: t("admin.analytics.att.col.working"),
        width: "8rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.working_count)}</span>,
      },
      {
        key: "on_time_count",
        header: t("admin.analytics.att.col.onTime"),
        width: "8rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.on_time_count)}</span>,
      },
      {
        key: "late_count",
        header: t("admin.analytics.att.col.late"),
        width: "8rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num text-warning">{formatNumber(row.late_count)}</span>,
      },
      {
        key: "absent_count",
        header: t("admin.analytics.att.col.absent"),
        width: "8rem",
        align: "right",
        sortable: true,
        hideBelow: "md",
        render: (row) => <span className="num">{formatNumber(row.absent_count)}</span>,
      },
      {
        key: "pending_count",
        header: t("admin.analytics.att.col.pending"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatNumber(row.pending_count)}</span>,
      },
      {
        key: "late_pct",
        header: t("admin.analytics.att.col.latePct"),
        width: "8rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.late_pct,
        render: (row) => <span className="num">{formatPercent(row.late_pct, { digits: 2 })}</span>,
      },
    ],
    [],
  );

  const bucketColumns: DataGridColumn<HourBucketRow>[] = useMemo(
    () => [
      {
        key: "bucket",
        header: t("admin.analytics.att.col.bucket"),
        width: "8rem",
        render: (row) => <span className="num">{row.bucket}</span>,
      },
      {
        key: "day_count",
        header: t("admin.analytics.att.col.dayCount"),
        width: "8rem",
        align: "right",
        render: (row) => <span className="num">{formatNumber(row.day_count)}</span>,
      },
      {
        key: "pct_of_date",
        header: t("admin.analytics.att.col.shareOfDay"),
        width: "9rem",
        align: "right",
        render: (row) => <span className="num">{formatPercent(row.pct_of_date, { digits: 2 })}</span>,
      },
    ],
    [],
  );

  const firstInColumns: DataGridColumn<InTrendRow>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.analytics.att.col.employee"),
        width: "16rem",
        render: (row) => {
          const label = labels.data?.get(row.employee_id);
          return (
            <PersonCell
              name={label?.name ?? null}
              code={label?.code ?? null}
              secondary={label?.department ?? null}
            />
          );
        },
      },
      {
        key: "first_in_hm",
        header: t("admin.analytics.att.col.firstIn"),
        width: "8rem",
        align: "right",
        // The view's own 24-hour IST string; never re-derived from an instant.
        render: (row) => <span className="num font-medium">{dash(row.first_in_hm)}</span>,
      },
      {
        key: "late_minutes",
        header: t("admin.analytics.att.col.lateBy"),
        width: "9rem",
        align: "right",
        render: (row) =>
          row.is_late ? (
            <span className="num text-warning">{fmtDurationHm(row.late_minutes)}</span>
          ) : (
            <span className="text-muted-foreground">{t("admin.analytics.att.onTime")}</span>
          ),
      },
    ],
    [labels.data],
  );

  const monthlyColumns: DataGridColumn<AttendanceMonthlyRow>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.analytics.att.col.employee"),
        width: "15rem",
        sortable: true,
        sortValue: (row) => labels.data?.get(row.employee_id)?.name ?? "",
        render: (row) => {
          const label = labels.data?.get(row.employee_id);
          return <PersonCell name={label?.name ?? null} code={label?.code ?? null} />;
        },
      },
      {
        key: "working_days",
        header: t("admin.analytics.att.col.workingDays"),
        width: "8rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.working_days)}</span>,
      },
      {
        key: "present_days",
        header: t("admin.analytics.att.col.presentDays"),
        width: "8rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.present_days)}</span>,
      },
      {
        key: "absent_days",
        header: t("admin.analytics.att.col.absentDays"),
        width: "8rem",
        align: "right",
        sortable: true,
        hideBelow: "md",
        render: (row) => <span className="num">{formatNumber(row.absent_days)}</span>,
      },
      {
        key: "pending_days",
        header: t("admin.analytics.att.col.pendingDays"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatNumber(row.pending_days)}</span>,
      },
      {
        key: "late_days",
        header: t("admin.analytics.att.col.lateDays"),
        width: "7rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num text-warning">{formatNumber(row.late_days)}</span>,
      },
      {
        key: "late_pct",
        header: t("admin.analytics.att.col.latePct"),
        width: "8rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.late_pct,
        render: (row) => <span className="num">{formatPercent(row.late_pct, { digits: 2 })}</span>,
      },
      {
        key: "attendance_pct",
        header: t("admin.analytics.att.col.attendancePct"),
        width: "9rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.attendance_pct,
        hideBelow: "md",
        render: (row) => (
          <span className="num">{formatPercent(row.attendance_pct, { digits: 2 })}</span>
        ),
      },
      {
        key: "total_worked_minutes",
        header: t("admin.analytics.att.col.worked"),
        width: "8rem",
        align: "right",
        sortable: true,
        hideBelow: "lg",
        render: (row) => <span className="num">{fmtDurationHm(row.total_worked_minutes)}</span>,
      },
      {
        key: "avg_worked_minutes_per_present_day",
        header: t("admin.analytics.att.col.avgWorked"),
        width: "9rem",
        align: "right",
        hideBelow: "lg",
        // Averaged BY THE VIEW over a named denominator; NULL, not 0, when there
        // is no present day. The formatter rounds the fractional minute for
        // display and prints an em dash for NULL — nothing re-derives the average.
        render: (row) => (
          <span className="num">{fmtDurationHm(row.avg_worked_minutes_per_present_day)}</span>
        ),
      },
      {
        key: "overtime_minutes",
        header: t("admin.analytics.att.col.overtime"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{fmtDurationHm(row.overtime_minutes)}</span>,
      },
    ],
    [labels.data],
  );

  const daysBase = `/admin/attendance/days?m=${month}`;

  return (
    <div className="container py-6">
      <PageHeader
        icon={BarChart3}
        title={t("admin.analytics.att.title")}
        subtitle={t("admin.analytics.att.subtitle", { month: fmtMonthLong(month) })}
        actions={<MonthStepper month={month} onChange={setMonth} />}
      />

      {/* The matview's age, stated before any figure that came out of it. */}
      <p className="num text-xs text-muted-foreground">
        {stamp.isPending
          ? t("admin.analytics.att.asOfLoading")
          : stamp.data == null
            ? t("admin.analytics.att.asOfUnknown")
            : t("admin.analytics.att.asOf", { at: fmtDateTime(stamp.data) })}
      </p>

      {/* Live employee-day counts for the month — each one opens its own grid. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CountTile
          label={t("admin.analytics.att.tile.days")}
          hint={t("admin.analytics.att.tile.daysHint")}
          to={daysBase}
          drillLabel={t("admin.analytics.att.tile.daysDrill")}
          source={t("admin.analytics.att.source.days")}
          query={dayCounts.get("all") ?? { data: undefined, error: null, isPending: true }}
        />
        <CountTile
          label={t("admin.analytics.att.tile.late")}
          hint={t("admin.analytics.att.tile.lateHint")}
          to={`${daysBase}&late=true`}
          drillLabel={t("admin.analytics.att.tile.lateDrill")}
          source={t("admin.analytics.att.source.days")}
          query={dayCounts.get("late") ?? { data: undefined, error: null, isPending: true }}
        />
        <CountTile
          label={t("admin.analytics.att.tile.absent")}
          hint={t("admin.analytics.att.tile.absentHint")}
          to={`${daysBase}&status=absent`}
          drillLabel={t("admin.analytics.att.tile.absentDrill")}
          source={t("admin.analytics.att.source.days")}
          query={dayCounts.get("absent") ?? { data: undefined, error: null, isPending: true }}
        />
        <CountTile
          label={t("admin.analytics.att.tile.exceptions")}
          hint={t("admin.analytics.att.tile.exceptionsHint")}
          to={`${daysBase}&exceptions=true`}
          drillLabel={t("admin.analytics.att.tile.exceptionsDrill")}
          source={t("admin.analytics.att.source.days")}
          query={dayCounts.get("exceptions") ?? { data: undefined, error: null, isPending: true }}
        />
      </div>

      {/* Punctuality trend across the month. */}
      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">{t("admin.analytics.att.trend.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.att.trend.hint")}</p>
        <StateBoundary
          loading={trend.isPending}
          error={trend.error}
          onRetry={() => void trend.refetch()}
          isEmpty={trendRows.length === 0}
          empty={
            <EmptyState
              icon={Clock}
              title={t("admin.analytics.att.trend.empty.title")}
              hint={t("admin.analytics.att.trend.empty.hint")}
            />
          }
        >
          <figure className="mt-3 m-0 rounded-lg border bg-card p-4">
            <div className="overflow-x-auto">
              <div className="h-72 min-w-[560px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={trendPoints}
                    margin={{ top: 12, right: 20, bottom: 4, left: 8 }}
                    accessibilityLayer
                  >
                    <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 12 }}
                      stroke={GRID_STROKE}
                      tickLine={false}
                      minTickGap={24}
                      className="fill-muted-foreground"
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 12 }}
                      stroke={GRID_STROKE}
                      tickLine={false}
                      width={48}
                      className="fill-muted-foreground"
                    />
                    <Tooltip
                      cursor={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1 }}
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "0.375rem",
                        fontSize: "0.875rem",
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: "0.75rem" }} />
                    <Line
                      type="linear"
                      dataKey="onTime"
                      name={t("admin.analytics.att.col.onTime")}
                      stroke={ON_TIME_STROKE}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="linear"
                      dataKey="late"
                      name={t("admin.analytics.att.col.late")}
                      stroke={LATE_STROKE}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="linear"
                      dataKey="absent"
                      name={t("admin.analytics.att.col.absent")}
                      stroke={ABSENT_STROKE}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <figcaption className="mt-2 text-xs text-muted-foreground">
              {t("admin.analytics.att.trend.caption")}
            </figcaption>
          </figure>
          <div className="mt-3">
            <DataGrid columns={trendColumns} rows={trendRows} rowKey={(row) => row.ist_date} pageSize={31} />
          </div>
        </StateBoundary>
      </section>

      {/* One day at a time: hours distribution + the latest first scans. */}
      <section className="mt-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold">
              {t("admin.analytics.att.day.title", { date: fmtCivilDate(date) })}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.att.day.hint")}</p>
          </div>
          <TextField
            label={t("admin.analytics.att.day.pick")}
            type="date"
            value={date}
            onChange={(v) => setParam("d", v)}
          />
        </div>

        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <StateBoundary
            loading={buckets.isPending}
            error={buckets.error}
            onRetry={() => void buckets.refetch()}
            isEmpty={bucketRows.length === 0}
            empty={
              <EmptyState
                icon={Clock}
                title={t("admin.analytics.att.buckets.empty.title")}
                hint={t("admin.analytics.att.buckets.empty.hint")}
              />
            }
          >
            <figure className="m-0 rounded-lg border bg-card p-4">
              <figcaption className="mb-2 text-sm font-medium">
                {t("admin.analytics.att.buckets.title")}
              </figcaption>
              <div className="overflow-x-auto">
                <div className="h-56 min-w-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={bucketRows}
                      margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                      accessibilityLayer
                    >
                      <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                      <XAxis
                        dataKey="bucket"
                        tick={{ fontSize: 12 }}
                        stroke={GRID_STROKE}
                        tickLine={false}
                        className="fill-muted-foreground"
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fontSize: 12 }}
                        stroke={GRID_STROKE}
                        tickLine={false}
                        width={40}
                        className="fill-muted-foreground"
                      />
                      <Tooltip
                        cursor={{ fill: "hsl(var(--muted))" }}
                        contentStyle={{
                          background: "hsl(var(--popover))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "0.375rem",
                          fontSize: "0.875rem",
                        }}
                      />
                      <Bar
                        dataKey="day_count"
                        name={t("admin.analytics.att.col.dayCount")}
                        fill={BUCKET_FILL}
                        radius={[4, 4, 0, 0]}
                        isAnimationActive={false}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="mt-3">
                <DataGrid
                  columns={bucketColumns}
                  rows={bucketRows}
                  rowKey={(row) => row.bucket}
                  pageSize={10}
                />
              </div>
            </figure>
          </StateBoundary>

          <div>
            <h3 className="text-sm font-medium">
              {t("admin.analytics.att.firstIn.title", { n: String(FIRST_IN_ROW_CAP) })}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("admin.analytics.att.firstIn.hint")}
            </p>
            <div className="mt-3">
              <StateBoundary
                loading={firstIns.isPending}
                error={firstIns.error}
                onRetry={() => void firstIns.refetch()}
                isEmpty={firstInRows.length === 0}
                partialError={labels.error}
                partialLabel={t("admin.analytics.att.firstIn.namesLabel")}
                empty={
                  <EmptyState
                    icon={Clock}
                    title={t("admin.analytics.att.firstIn.empty.title")}
                    hint={t("admin.analytics.att.firstIn.empty.hint")}
                  />
                }
              >
                <DataGrid
                  columns={firstInColumns}
                  rows={firstInRows}
                  rowKey={(row) => `${row.employee_id}-${row.ist_date}`}
                  pageSize={FIRST_IN_ROW_CAP}
                />
              </StateBoundary>
            </div>
          </div>
        </div>
      </section>

      {/* The matview grid: one row per employee for the month's pay period. */}
      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">
          {t("admin.analytics.att.monthly.title", { month: fmtMonthLong(month) })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.att.monthly.hint")}</p>
        <div className="mt-3">
          <StateBoundary
            loading={monthly.isPending}
            error={monthly.error}
            onRetry={() => void monthly.refetch()}
            isEmpty={monthlyRows.length === 0}
            partialError={labels.error}
            partialLabel={t("admin.analytics.att.firstIn.namesLabel")}
            empty={
              <EmptyState
                icon={BarChart3}
                title={t("admin.analytics.att.monthly.empty.title")}
                hint={t("admin.analytics.att.monthly.empty.hint")}
              />
            }
          >
            <DataGrid
              columns={monthlyColumns}
              rows={monthlyRows}
              rowKey={(row) => `${row.employee_id}-${row.pay_period_code}`}
              pageSize={25}
            />
          </StateBoundary>
        </div>
        {monthlyRows.length >= ANALYTICS_ROW_CAP ? (
          <div className="mt-3">
            <Notice tone="warning">
              {t("admin.analytics.att.monthly.capped", { n: String(ANALYTICS_ROW_CAP) })}
            </Notice>
          </div>
        ) : null}
      </section>

      <div className="mt-6 space-y-3">
        <Notice tone="info">{t("admin.analytics.att.footnote.sources")}</Notice>
        <Notice tone="warning">{t("admin.analytics.att.footnote.gaps")}</Notice>
      </div>
    </div>
  );
}
