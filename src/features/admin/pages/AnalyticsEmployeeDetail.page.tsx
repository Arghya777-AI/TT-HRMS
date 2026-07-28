/**
 * §14 · /admin/analytics/employees/:employeeCode — the deepest link of the
 * drill-down chain, and the screen the client specified almost field by field:
 *
 *   "What is the average for that particular employee in this time period, how
 *    much they are performing, any leave or letter above or not, average duration
 *    and end time, average work time, and average time being in office."
 *
 * So: mean first scan, mean last scan, mean worked, mean time in office, mean
 * break, lateness with its own average, early exits, overtime, leave by type, the
 * flagged days, a per-day table and the day-by-day trend behind all of it.
 *
 * THREE THINGS WORTH KNOWING BEFORE EDITING
 * -----------------------------------------
 *  1. THE ROUTE IS THE SCOPE. `:employeeCode` is the address (readable, shareable);
 *     `?emp=<uuid>` is the predicate. The code is resolved to the uuid through the
 *     employee master, and the filters are re-narrowed with `forEmployee` on every
 *     render, so a hand-typed URL with no `emp` param scopes correctly and a URL
 *     whose `emp` disagrees with its code cannot show somebody else's attendance.
 *     While the code is resolving the scope is a uuid that matches nothing — a
 *     scoped screen must never widen its own scope, not even for one render.
 *  2. IN OFFICE ≠ WORKED. `gross_span_minutes` is first scan to last scan with
 *     breaks inside it; `total_worked_minutes` has them removed. Both are the
 *     engine's, both are shown, and the gap between them is the break figure.
 *  3. EVERY AVERAGE HAS ITS OWN DENOMINATOR AND SAYS SO. Duration means are over
 *     COMPLETE days (both a first and a last scan); arrival is over the days with
 *     a first scan; departure over the days with a last scan; lateness over LATE
 *     days. They are genuinely different counts — a single-scan day has an arrival,
 *     no departure, and a duration the engine writes as zero because there was
 *     nothing to subtract from. An average taken over the wrong denominator is not
 *     a smaller number, it is a different fact.
 *
 * THE CAPTURE SPLIT is the one panel that leaves the day grain. `punch_source` is
 * a per-SCAN column, so the day view cannot answer "web or the gate tablet"; the
 * split is six `count=exact` reads over `v_attendance_punch_detail`, which is why
 * it carries its own heading and its own caveat rather than sitting among the
 * day-derived tiles.
 *
 * @route /admin/analytics/employees/:employeeCode
 */
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CalendarDays, ScanFace, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { dash, formatDays, formatNumber, formatShare } from "@/lib/format";
import {
  fmtCivilDate,
  fmtCivilDayMonthWeekday,
  fmtDurationHm,
  fmtIstMinutesOfDay,
} from "@/lib/datetime";
import { forEmployee, withFilters } from "@/lib/analyticsFilters";
import type { DimensionLabels, ExportColumn } from "@/lib/exportReport";
import { t } from "@/shared/i18n/en";
import { AnalyticsCaveats } from "../components/AnalyticsCaveats";
import { AnalyticsExportButtons } from "../components/AnalyticsExportButtons";
import { AnalyticsFilterBar } from "../components/AnalyticsFilterBar";
import { TrendLinesChart, type ChartPoint, type ChartSeries } from "../components/AnalyticsOpsCharts";
import { Notice } from "../components/Notice";
import { periodLabel, withDimension, SOURCE_LABEL_KEY } from "../analyticsFilterBar";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";
import {
  useAnalyticsFilterOptions,
  useCaptureSplit,
  useDailyTrend,
  useEmployeeDetail,
} from "../hooks/useAnalytics";
import { useAdminEmployee } from "../hooks/usePeople";
import {
  groupLeaveDaysByType,
  type AnalyticsDayRow,
  type DayStatus,
} from "../api/analytics.api";

/**
 * The scope while the employee code is still resolving: a syntactically valid
 * uuid that matches no row. An EMPTY employee filter would drop the predicate and
 * read the whole venue's days into a screen headed with one person's name.
 */
const NO_EMPLOYEE = "00000000-0000-0000-0000-000000000000";

/**
 * `public.attendance_status` → label + tone, exhaustive over the deployed enum so
 * no raw value can reach the screen (D-10). The wording is the SAME
 * `admin.days.status.*` catalogue the Day Records and Employee Attendance grids
 * read, so the three screens cannot describe one status three ways.
 */
const STATUS_CHIP: Readonly<Record<DayStatus, StatusChipEntry>> = {
  present: { label: t("admin.days.status.present"), tone: "success" },
  half_day: { label: t("admin.days.status.halfDay"), tone: "warn" },
  absent: { label: t("admin.days.status.absent"), tone: "danger" },
  weekly_off: { label: t("admin.days.status.weeklyOff"), tone: "neutral" },
  holiday: { label: t("admin.days.status.holiday"), tone: "neutral" },
  on_leave: { label: t("admin.days.status.onLeave"), tone: "info" },
  on_leave_half: { label: t("admin.days.status.onLeaveHalf"), tone: "info" },
  weekly_off_worked: { label: t("admin.days.status.weeklyOffWorked"), tone: "success" },
  holiday_worked: { label: t("admin.days.status.holidayWorked"), tone: "success" },
  comp_off_availed: { label: t("admin.days.status.compOffAvailed"), tone: "info" },
  on_duty: { label: t("admin.days.status.onDuty"), tone: "info" },
  work_from_home: { label: t("admin.days.status.workFromHome"), tone: "info" },
  suspended: { label: t("admin.days.status.suspended"), tone: "danger" },
  not_yet_joined: { label: t("admin.days.status.notYetJoined"), tone: "neutral" },
  post_exit: { label: t("admin.days.status.postExit"), tone: "neutral" },
  pending: { label: t("admin.days.status.pending"), tone: "info" },
};

const WORKED_SERIES: readonly ChartSeries[] = [
  { key: "worked", label: t("admin.analytics.person.trend.series") },
];

export default function AnalyticsEmployeeDetailPage() {
  const { employeeCode = "" } = useParams<{ employeeCode: string }>();
  const { filters } = useAnalyticsFilters();

  const options = useAnalyticsFilterOptions();
  const employee = useAdminEmployee(employeeCode);
  const employeeId = employee.data?.id ?? null;

  // Re-narrowed from the ROUTE on every render — see note 1 in the header.
  const scoped = useMemo(
    () => forEmployee(filters, employeeId ?? NO_EMPLOYEE),
    [filters, employeeId],
  );

  // Both hooks share one query key and differ only by their `select`, so the
  // tiles, the table and the chart are three projections of ONE read.
  const detail = useEmployeeDetail(scoped);
  const trend = useDailyTrend(scoped);
  const capture = useCaptureSplit(employeeId, filters.period);

  const days = useMemo(() => detail.data?.detail.days ?? [], [detail.data]);
  const measures = detail.data?.detail.measures ?? null;
  const provenance = detail.data?.provenance ?? null;
  const leaveByType = useMemo(() => groupLeaveDaysByType(days), [days]);

  const trendPoints = useMemo<ChartPoint[]>(
    () =>
      (trend.data?.points ?? []).map((point) => ({
        // The full civil date, not '25-Jul': a multi-year custom range would
        // otherwise produce two points with the same label, and the label is the
        // chart's identity for its tooltip and its table fallback.
        x: fmtCivilDate(point.istDate),
        // A gap, never a zero — no computed day is not a day of no work.
        values: { worked: point.isEmpty ? null : point.measures.totalWorkedMinutes },
      })),
    [trend.data],
  );

  const person = employee.data ?? null;
  const displayName = person?.display_name ?? t("admin.analytics.person.unknown");

  const columns: DataGridColumn<AnalyticsDayRow>[] = useMemo(
    () => [
      {
        key: "ist_date",
        header: t("admin.analytics.person.col.date"),
        width: "11rem",
        sortable: true,
        render: (row) => fmtCivilDayMonthWeekday(row.ist_date),
      },
      {
        key: "status",
        header: t("admin.analytics.person.col.status"),
        width: "9rem",
        sortable: true,
        render: (row) => <StatusChip status={row.status} map={STATUS_CHIP} />,
      },
      {
        key: "first_in_hm",
        header: t("admin.analytics.person.col.in"),
        width: "7rem",
        align: "right",
        // The view's own IST wall clock. Never re-derived from an instant here.
        render: (row) => <span className="num">{dash(row.first_in_hm)}</span>,
      },
      {
        key: "last_out_hm",
        header: t("admin.analytics.person.col.out"),
        width: "7rem",
        align: "right",
        render: (row) => <span className="num">{dash(row.last_out_hm)}</span>,
      },
      {
        key: "total_worked_minutes",
        header: t("admin.analytics.person.col.worked"),
        width: "8rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{fmtDurationHm(row.total_worked_minutes)}</span>,
      },
      {
        key: "gross_span_minutes",
        header: t("admin.analytics.person.col.inOffice"),
        width: "8rem",
        align: "right",
        sortable: true,
        hideBelow: "md",
        render: (row) => <span className="num">{fmtDurationHm(row.gross_span_minutes)}</span>,
      },
      {
        key: "break_minutes",
        header: t("admin.analytics.person.col.break"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{fmtDurationHm(row.break_minutes)}</span>,
      },
      {
        key: "late_minutes",
        header: t("admin.analytics.person.col.late"),
        width: "8rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.late_minutes,
        render: (row) =>
          row.is_late ? (
            <span className="num text-warning">{fmtDurationHm(row.late_minutes)}</span>
          ) : (
            <span className="text-muted-foreground">{t("admin.analytics.person.onTime")}</span>
          ),
      },
      {
        key: "overtime_minutes",
        header: t("admin.analytics.person.col.overtime"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{fmtDurationHm(row.overtime_minutes)}</span>,
      },
      {
        key: "leave_type_name",
        header: t("admin.analytics.person.col.leaveType"),
        width: "10rem",
        hideBelow: "lg",
        render: (row) => dash(row.leave_type_name),
      },
      {
        key: "has_anomalies",
        header: t("admin.analytics.person.col.flags"),
        width: "7rem",
        hideBelow: "md",
        render: (row) =>
          row.has_anomalies ? (
            <span className="text-warning">{t("admin.analytics.person.flagged")}</span>
          ) : (
            dash(null)
          ),
      },
    ],
    [],
  );

  const exportColumns: readonly ExportColumn<AnalyticsDayRow>[] = useMemo(
    () => [
      { key: "ist_date", header: t("admin.analytics.person.col.date"), format: "dateWeekday" },
      {
        key: "status",
        header: t("admin.analytics.person.col.status"),
        format: (row) => STATUS_CHIP[row.status].label,
      },
      { key: "first_in_hm", header: t("admin.analytics.person.col.in"), align: "right", format: "text" },
      { key: "last_out_hm", header: t("admin.analytics.person.col.out"), align: "right", format: "text" },
      {
        key: "total_worked_minutes",
        header: t("admin.analytics.person.col.worked"),
        format: "durationHm",
      },
      {
        key: "gross_span_minutes",
        header: t("admin.analytics.person.col.inOffice"),
        format: "durationHm",
      },
      { key: "break_minutes", header: t("admin.analytics.person.col.break"), format: "durationHm" },
      {
        key: "late_minutes",
        header: t("admin.analytics.person.col.late"),
        format: (row) => (row.is_late ? fmtDurationHm(row.late_minutes) : t("admin.analytics.person.onTime")),
      },
      {
        key: "overtime_minutes",
        header: t("admin.analytics.person.col.overtime"),
        format: "durationHm",
      },
      { key: "leave_type_name", header: t("admin.analytics.person.col.leaveType"), format: "text" },
      { key: "has_anomalies", header: t("admin.analytics.person.col.flags"), format: "boolean" },
    ],
    [],
  );

  const exportLabels: DimensionLabels = { employee: `${displayName} (${employeeCode})` };
  /**
   * Back to the list with the period and every OTHER dimension intact, but with
   * the employee narrowing dropped — carrying `emp` back would land the reader on
   * a list of exactly the one person they just came from.
   */
  const listPath = withFilters(
    "/admin/analytics/employees",
    withDimension(filters, "employeeId", null),
  );
  const attended = measures?.attendedDays ?? 0;

  /**
   * Every average states the denominator IT was taken over — and the three differ.
   * `attendedDays` is not one of them: a single-scan day is attended, carries an
   * arrival, carries no departure, and carries a zero duration the engine wrote
   * because there was nothing to subtract from. One shared sentence here would
   * overstate the sample behind the departure and duration tiles by exactly the
   * number of forgotten scan-outs, which is the anomaly the Flagged tile counts.
   */
  const over = (key: "complete" | "firstIn" | "lastOut", n: number): string =>
    n === 0
      ? t("admin.analytics.person.denominator.none")
      : t(`admin.analytics.person.denominator.${key}` as const, { n: formatNumber(n) });

  const overComplete = over("complete", measures?.completedDays ?? 0);

  return (
    <div className="container py-6">
      <PageHeader
        icon={UserRound}
        title={displayName}
        subtitle={t("admin.analytics.person.subtitle", {
          code: employeeCode,
          period: periodLabel(filters.period),
        })}
        actions={
          <Button asChild variant="outline" className="h-11">
            <Link to={listPath}>
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
              {t("admin.analytics.person.back")}
            </Link>
          </Button>
        }
      />

      {/*
        The employee dimension is HIDDEN on this bar: who the screen is about is
        the route, so a chip offering to remove the employee filter would be a
        control that visibly does nothing.
      */}
      <AnalyticsFilterBar
        departments={options.data?.departments}
        locations={options.data?.locations}
        optionsLoading={options.isPending}
        hide={["employee"]}
      />

      <StateBoundary
        loading={employee.isPending}
        error={employee.error}
        onRetry={() => void employee.refetch()}
      >
        <p className="mt-3 text-sm text-muted-foreground">
          {dash(person?.department_name)} · {dash(person?.designation_name)} ·{" "}
          {dash(person?.location_name)}
        </p>

        <StateBoundary
          loading={detail.isPending}
          error={detail.error}
          onRetry={() => void detail.refetch()}
          isEmpty={days.length === 0}
          empty={
            <EmptyState
              icon={CalendarDays}
              title={t("admin.analytics.person.empty.title")}
              hint={t("admin.analytics.person.empty.hint")}
            />
          }
        >
          {/* The averages the client asked for, each over a named denominator. */}
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label={t("admin.analytics.person.tile.firstIn")}
              value={fmtIstMinutesOfDay(measures?.avgFirstInMinutes)}
              hint={t("admin.analytics.person.tile.firstInHint")}
              explainer={{
                formula: t("admin.analytics.person.tile.firstInHint"),
                numbers: over("firstIn", measures?.firstInDays ?? 0),
              }}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.lastOut")}
              value={fmtIstMinutesOfDay(measures?.avgLastOutMinutes)}
              hint={t("admin.analytics.person.tile.lastOutHint")}
              explainer={{
                formula: t("admin.analytics.person.tile.lastOutHint"),
                numbers: over("lastOut", measures?.lastOutDays ?? 0),
              }}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.worked")}
              value={fmtDurationHm(measures?.avgWorkedMinutes)}
              hint={t("admin.analytics.person.tile.workedHint")}
              explainer={{
                formula: t("admin.analytics.person.tile.workedHint"),
                numbers: overComplete,
              }}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.inOffice")}
              value={fmtDurationHm(measures?.avgGrossSpanMinutes)}
              hint={t("admin.analytics.person.tile.inOfficeHint")}
              explainer={{
                formula: t("admin.analytics.person.tile.inOfficeHint"),
                numbers: overComplete,
              }}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.break")}
              value={fmtDurationHm(measures?.avgBreakMinutes)}
              hint={t("admin.analytics.person.tile.breakHint")}
              explainer={{
                formula: t("admin.analytics.person.tile.breakHint"),
                numbers: overComplete,
              }}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.attended")}
              value={formatNumber(attended)}
              hint={t("admin.analytics.person.tile.attendedHint", {
                working: formatNumber(measures?.workingDays ?? 0),
              })}
              explainer={{
                formula: t("admin.analytics.person.tile.attendedHint", {
                  working: formatNumber(measures?.workingDays ?? 0),
                }),
                numbers: t("admin.analytics.person.formula.count", {
                  rows: formatNumber(provenance?.rowsScanned ?? 0),
                }),
              }}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.late")}
              value={formatNumber(measures?.lateDays ?? 0)}
              hint={t("admin.analytics.person.tile.lateHint", {
                avg: fmtDurationHm(measures?.avgLateMinutes),
              })}
              tone={(measures?.lateDays ?? 0) > 0 ? "warn" : "neutral"}
              explainer={{
                formula: t("admin.analytics.person.tile.lateHint", {
                  avg: fmtDurationHm(measures?.avgLateMinutes),
                }),
                numbers:
                  (measures?.lateDays ?? 0) === 0
                    ? t("admin.analytics.person.denominator.none")
                    : t("admin.analytics.person.denominator.late", {
                        n: formatNumber(measures?.lateDays ?? 0),
                      }),
              }}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.earlyExit")}
              value={formatNumber(measures?.earlyExitDays ?? 0)}
              hint={t("admin.analytics.person.tile.earlyExitHint", {
                total: fmtDurationHm(measures?.totalEarlyExitMinutes ?? 0),
              })}
              tone={(measures?.earlyExitDays ?? 0) > 0 ? "warn" : "neutral"}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.overtime")}
              value={fmtDurationHm(measures?.overtimeMinutes ?? 0)}
              hint={t("admin.analytics.person.tile.overtimeHint", {
                approved: fmtDurationHm(measures?.approvedOvertimeMinutes ?? 0),
              })}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.leave")}
              value={formatDays(measures?.leaveDays ?? 0)}
              hint={t("admin.analytics.person.tile.leaveHint")}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.absent")}
              value={formatNumber(measures?.absentDays ?? 0)}
              hint={t("admin.analytics.person.tile.absentHint")}
              tone={(measures?.absentDays ?? 0) > 0 ? "danger" : "neutral"}
            />
            <KpiTile
              label={t("admin.analytics.person.tile.flagged")}
              value={formatNumber(measures?.anomalyDays ?? 0)}
              hint={t("admin.analytics.person.tile.flaggedHint")}
              tone={(measures?.anomalyDays ?? 0) > 0 ? "warn" : "neutral"}
            />
          </div>

          {/* Day-by-day worked time. Gaps stay gaps. */}
          <section className="mt-6 rounded-lg border bg-card p-4">
            <StateBoundary
              loading={trend.isPending}
              error={trend.error}
              onRetry={() => void trend.refetch()}
              isEmpty={trendPoints.length === 0}
              skeletonRows={4}
              empty={
                <EmptyState
                  icon={CalendarDays}
                  title={t("admin.analytics.person.trend.empty.title")}
                  hint={t("admin.analytics.person.trend.empty.hint")}
                />
              }
            >
              <TrendLinesChart
                title={t("admin.analytics.person.trend.title")}
                caption={t("admin.analytics.person.trend.caption")}
                series={WORKED_SERIES}
                points={trendPoints}
                format={(value) => fmtDurationHm(value)}
                xHeader={t("admin.analytics.person.col.date")}
                yWidth={72}
              />
            </StateBoundary>
          </section>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {/* Leave taken, by type. Fractions, not row counts. */}
            <section className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-semibold">{t("admin.analytics.person.leave.title")}</h2>
              {leaveByType.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("admin.analytics.person.leave.none")}
                </p>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("admin.analytics.person.leave.col.type")}</TableHead>
                        <TableHead className="text-right">
                          {t("admin.analytics.person.leave.col.days")}
                        </TableHead>
                        <TableHead className="text-right">
                          {t("admin.analytics.person.leave.col.occasions")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {leaveByType.map((row) => (
                        <TableRow key={row.leaveTypeName}>
                          <TableCell className="font-medium">{row.leaveTypeName}</TableCell>
                          <TableCell className="num text-right">{formatDays(row.days)}</TableCell>
                          <TableCell className="num text-right">{formatNumber(row.dayRows)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>

            {/* Web vs the gate tablet — the scan grain, counted by Postgres. */}
            <section className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-semibold">{t("admin.analytics.person.capture.title")}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("admin.analytics.person.capture.hint")}
              </p>
              <div className="mt-2">
                <StateBoundary
                  loading={capture.isPending}
                  error={capture.error}
                  onRetry={() => void capture.refetch()}
                  isEmpty={(capture.data?.total ?? 0) === 0}
                  skeletonRows={3}
                  empty={
                    <EmptyState icon={ScanFace} title={t("admin.analytics.person.capture.none")} />
                  }
                >
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("admin.analytics.person.capture.col.method")}</TableHead>
                          <TableHead className="text-right">
                            {t("admin.analytics.person.capture.col.scans")}
                          </TableHead>
                          <TableHead className="text-right">
                            {t("admin.analytics.person.capture.col.share")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(capture.data?.rows ?? []).map((row) => (
                          <TableRow key={row.source}>
                            <TableCell>{t(SOURCE_LABEL_KEY[row.source])}</TableCell>
                            <TableCell className="num text-right">
                              {formatNumber(row.punches)}
                            </TableCell>
                            <TableCell className="num text-right">
                              {formatShare(row.punches, capture.data?.total ?? 0)}
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="hover:bg-transparent">
                          <TableCell className="font-medium">
                            {t("admin.analytics.person.capture.total")}
                          </TableCell>
                          <TableCell className="num text-right font-medium">
                            {formatNumber(capture.data?.total ?? 0)}
                          </TableCell>
                          <TableCell />
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </StateBoundary>
              </div>
            </section>
          </div>

          {/* Every day in the period — the rows the averages were taken over. */}
          <section className="mt-6">
            <h2 className="font-display text-lg font-semibold">
              {t("admin.analytics.person.days.title")}
            </h2>
            <div className="mt-3">
              <DataGrid
                columns={columns}
                rows={days}
                rowKey={(row) => row.ist_date}
                pageSize={31}
                toolbar={
                  <AnalyticsExportButtons
                    // No subtitle: the report heading already prints the period
                    // and every active filter on its own labelled lines, and a
                    // "Scope" line repeating one of them is noise on paper.
                    title={t("admin.analytics.person.export.title", { name: displayName })}
                    filename={`${t("admin.analytics.person.export.file")}-${employeeCode}`}
                    columns={exportColumns}
                    rows={days}
                    filters={scoped}
                    labels={exportLabels}
                  />
                }
              />
            </div>
          </section>

          {provenance === null ? null : (
            <AnalyticsCaveats provenance={provenance} className="mt-4" />
          )}

          <div className="mt-4">
            <Notice tone="info">{t("admin.analytics.person.footnote")}</Notice>
          </div>
        </StateBoundary>
      </StateBoundary>
    </div>
  );
}
