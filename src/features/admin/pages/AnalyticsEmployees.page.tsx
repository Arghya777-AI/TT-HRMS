/**
 * §14 · /admin/analytics/employees — the employee-wise breakdown, and the middle
 * link of the drill-down chain the client described: dashboard → this list →
 * one person.
 *
 *   "Department-wise and employee-wise … everything can be filtered. On every
 *    details page, the same filters should apply. It's kind of like Power BI:
 *    first the dashboard is shown, then you click 'more data', click 'more data'."
 *
 * WHAT MAKES THE CHAIN HOLD
 * -------------------------
 *  * ONE filter model, read from the URL (`useAnalyticsFilters`), rendered by the
 *    ONE bar (`AnalyticsFilterBar`), and carried onto every row's link by
 *    `withFilters` + `forEmployee`. The row you click and the screen it opens are
 *    answering the same question, because the question is the query string.
 *  * ONE cached read behind the tiles and the grid. `useAttendanceSummary` and
 *    `useEmployeeBreakdown` share a query key and differ only by their `select`,
 *    so the strip cannot disagree with the rows beneath it — they are two
 *    projections of one array, not two answers fetched a second apart.
 *
 * WHERE THE NUMBERS COME FROM. Every per-day input — worked minutes, the span,
 * breaks, lateness, overtime, the status — is a column of
 * `v_attendance_day_enriched`, computed by the attendance engine. The grouping
 * and the averaging happen in `analyticsAggregate.ts` (PostgREST cannot GROUP BY,
 * and no deployed relation rolls the day grain up over an arbitrary period), which
 * is stated on the page by `AnalyticsCaveats` rather than left for the reader to
 * guess.
 *
 * AVERAGES NAME THEIR DENOMINATOR. Worked, in-office and break averages are over
 * COMPLETE days — days carrying both a first and a last scan — never over every row
 * in the period. Averaging across weekly offs, holidays and absences is how a team
 * that never works less than eight hours acquires an "average day" of 4h 10m; and
 * including a single-scan day, which the engine writes with a zero span because it
 * never learned when the person left, is the same lie one row at a time.
 *
 * @route /admin/analytics/employees
 */
import { useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { dash, formatDays, formatNumber } from "@/lib/format";
import { fmtDurationHm } from "@/lib/datetime";
import { forEmployee, withFilters } from "@/lib/analyticsFilters";
import type { DimensionLabels, ExportColumn } from "@/lib/exportReport";
import { t } from "@/shared/i18n/en";
import { AnalyticsCaveats } from "../components/AnalyticsCaveats";
import { AnalyticsExportButtons } from "../components/AnalyticsExportButtons";
import { AnalyticsFilterBar } from "../components/AnalyticsFilterBar";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { periodLabel } from "../analyticsFilterBar";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";
import {
  useAnalyticsFilterOptions,
  useAnalyticsScope,
  useAttendanceSummary,
  useEmployeeBreakdown,
} from "../hooks/useAnalytics";
import type { EmployeeBreakdownRow } from "../api/analytics.api";

/** A tile's number while the one shared read is still in flight, or after it failed. */
function tileValue(pending: boolean, failed: boolean, value: string) {
  if (pending) return <Skeleton className="h-7 w-16" />;
  if (failed) return dash(null);
  return value;
}

export default function AnalyticsEmployeesPage() {
  const navigate = useNavigate();
  const { filters } = useAnalyticsFilters();

  const options = useAnalyticsFilterOptions();
  // Derived synchronously from the cached masters — no extra round trip. Wanted
  // here for the resolved department/location NAMES, which head the export.
  const { scope } = useAnalyticsScope(filters);
  const summary = useAttendanceSummary(filters);
  const breakdown = useEmployeeBreakdown(filters);

  const rows = useMemo(() => breakdown.data?.rows ?? [], [breakdown.data]);
  const measures = summary.data?.measures ?? null;
  const provenance = breakdown.data?.provenance ?? null;

  /**
   * The drill-through. The ROUTE carries the employee code (a person's URL should
   * be readable and shareable), the QUERY carries the whole filter set including
   * `emp=<uuid>` — the code is the address, the uuid is the predicate, and the
   * detail screen uses each for what it is good for.
   */
  const detailPath = useCallback(
    (row: EmployeeBreakdownRow): string =>
      withFilters(
        `/admin/analytics/employees/${encodeURIComponent(row.employeeCode)}`,
        forEmployee(filters, row.employeeId),
      ),
    [filters],
  );

  const columns: DataGridColumn<EmployeeBreakdownRow>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.analytics.emp.col.employee"),
        width: "16rem",
        sortable: true,
        sortValue: (row) => row.displayName,
        render: (row) => (
          // A real link inside the row: the whole row is clickable for the mouse,
          // and this is what a keyboard reaches. `stopPropagation` so the two
          // handlers do not both navigate.
          <Link
            to={detailPath(row)}
            aria-label={t("admin.analytics.emp.drill", { name: row.displayName })}
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <PersonCell name={row.displayName} code={row.employeeCode} />
          </Link>
        ),
      },
      {
        key: "department",
        header: t("admin.analytics.emp.col.department"),
        width: "12rem",
        sortable: true,
        hideBelow: "lg",
        sortValue: (row) => row.departmentName ?? "",
        render: (row) => dash(row.departmentName),
      },
      {
        key: "attended",
        header: t("admin.analytics.emp.col.attended"),
        width: "7rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.measures.attendedDays,
        render: (row) => <span className="num">{formatNumber(row.measures.attendedDays)}</span>,
      },
      {
        key: "avgWorked",
        header: t("admin.analytics.emp.col.avgWorked"),
        width: "8rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.measures.avgWorkedMinutes,
        // Null, not zero, when nobody scanned: `fmtDurationHm` prints the em dash.
        render: (row) => <span className="num">{fmtDurationHm(row.measures.avgWorkedMinutes)}</span>,
      },
      {
        key: "avgInOffice",
        header: t("admin.analytics.emp.col.avgInOffice"),
        width: "8rem",
        align: "right",
        sortable: true,
        hideBelow: "md",
        sortValue: (row) => row.measures.avgGrossSpanMinutes,
        render: (row) => (
          <span className="num">{fmtDurationHm(row.measures.avgGrossSpanMinutes)}</span>
        ),
      },
      {
        key: "avgBreak",
        header: t("admin.analytics.emp.col.avgBreak"),
        width: "7rem",
        align: "right",
        sortable: true,
        hideBelow: "lg",
        sortValue: (row) => row.measures.avgBreakMinutes,
        render: (row) => <span className="num">{fmtDurationHm(row.measures.avgBreakMinutes)}</span>,
      },
      {
        key: "late",
        header: t("admin.analytics.emp.col.late"),
        width: "7rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.measures.lateDays,
        render: (row) => (
          <span className={row.measures.lateDays > 0 ? "num text-warning" : "num"}>
            {formatNumber(row.measures.lateDays)}
          </span>
        ),
      },
      {
        key: "avgLate",
        header: t("admin.analytics.emp.col.avgLate"),
        width: "8rem",
        align: "right",
        sortable: true,
        hideBelow: "lg",
        sortValue: (row) => row.measures.avgLateMinutes,
        render: (row) => <span className="num">{fmtDurationHm(row.measures.avgLateMinutes)}</span>,
      },
      {
        key: "absent",
        header: t("admin.analytics.emp.col.absent"),
        width: "7rem",
        align: "right",
        sortable: true,
        hideBelow: "md",
        sortValue: (row) => row.measures.absentDays,
        render: (row) => (
          <span className={row.measures.absentDays > 0 ? "num text-destructive" : "num"}>
            {formatNumber(row.measures.absentDays)}
          </span>
        ),
      },
      {
        key: "leave",
        header: t("admin.analytics.emp.col.leave"),
        width: "7rem",
        align: "right",
        sortable: true,
        hideBelow: "md",
        sortValue: (row) => row.measures.leaveDays,
        // Fractional on purpose: a half day is 0.5, and `formatDays` keeps '7'
        // whole while printing '7.5' when it is not.
        render: (row) => <span className="num">{formatDays(row.measures.leaveDays)}</span>,
      },
      {
        key: "overtime",
        header: t("admin.analytics.emp.col.overtime"),
        width: "8rem",
        align: "right",
        sortable: true,
        hideBelow: "lg",
        sortValue: (row) => row.measures.overtimeMinutes,
        render: (row) => <span className="num">{fmtDurationHm(row.measures.overtimeMinutes)}</span>,
      },
      {
        key: "flagged",
        header: t("admin.analytics.emp.col.flagged"),
        width: "7rem",
        align: "right",
        sortable: true,
        hideBelow: "lg",
        sortValue: (row) => row.measures.anomalyDays,
        render: (row) => (
          <span className={row.measures.anomalyDays > 0 ? "num text-warning" : "num"}>
            {formatNumber(row.measures.anomalyDays)}
          </span>
        ),
      },
    ],
    [detailPath],
  );

  /**
   * The export takes the SAME rows the grid was handed, flattened one level —
   * `measures` is a nested object and a report column addresses one field.
   */
  const exportColumns: readonly ExportColumn<EmployeeBreakdownRow>[] = useMemo(
    () => [
      { key: "displayName", header: t("admin.analytics.emp.col.employee"), format: (row) => row.displayName },
      {
        key: "employeeCode",
        header: t("admin.analytics.emp.col.code"),
        format: (row) => row.employeeCode,
      },
      {
        key: "departmentName",
        header: t("admin.analytics.emp.col.department"),
        format: (row) => dash(row.departmentName),
      },
      {
        key: "attendedDays",
        header: t("admin.analytics.emp.col.attended"),
        align: "right",
        format: (row) => formatNumber(row.measures.attendedDays),
      },
      {
        key: "avgWorkedMinutes",
        header: t("admin.analytics.emp.col.avgWorked"),
        align: "right",
        format: (row) => fmtDurationHm(row.measures.avgWorkedMinutes),
      },
      {
        key: "avgGrossSpanMinutes",
        header: t("admin.analytics.emp.col.avgInOffice"),
        align: "right",
        format: (row) => fmtDurationHm(row.measures.avgGrossSpanMinutes),
      },
      {
        key: "avgBreakMinutes",
        header: t("admin.analytics.emp.col.avgBreak"),
        align: "right",
        format: (row) => fmtDurationHm(row.measures.avgBreakMinutes),
      },
      {
        key: "lateDays",
        header: t("admin.analytics.emp.col.late"),
        align: "right",
        format: (row) => formatNumber(row.measures.lateDays),
      },
      {
        key: "avgLateMinutes",
        header: t("admin.analytics.emp.col.avgLate"),
        align: "right",
        format: (row) => fmtDurationHm(row.measures.avgLateMinutes),
      },
      {
        key: "absentDays",
        header: t("admin.analytics.emp.col.absent"),
        align: "right",
        format: (row) => formatNumber(row.measures.absentDays),
      },
      {
        key: "leaveDays",
        header: t("admin.analytics.emp.col.leave"),
        align: "right",
        format: (row) => formatDays(row.measures.leaveDays),
      },
      {
        key: "overtimeMinutes",
        header: t("admin.analytics.emp.col.overtime"),
        align: "right",
        format: (row) => fmtDurationHm(row.measures.overtimeMinutes),
      },
      {
        key: "anomalyDays",
        header: t("admin.analytics.emp.col.flagged"),
        align: "right",
        format: (row) => formatNumber(row.measures.anomalyDays),
      },
    ],
    [],
  );

  const exportLabels: DimensionLabels = {
    ...(scope?.departmentName == null ? {} : { department: scope.departmentName }),
    ...(scope?.locationName == null ? {} : { location: scope.locationName }),
  };

  const pending = summary.isPending;
  const failed = summary.error !== null;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Users}
        title={t("admin.analytics.emp.title")}
        subtitle={t("admin.analytics.emp.subtitle", { period: periodLabel(filters.period) })}
        actions={
          <Button asChild variant="outline" className="h-11">
            <Link to="/admin/analytics">
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
              {t("admin.analytics.emp.back")}
            </Link>
          </Button>
        }
      />

      <AnalyticsFilterBar
        departments={options.data?.departments}
        locations={options.data?.locations}
        optionsLoading={options.isPending}
      />

      <p className="mt-3 text-sm text-muted-foreground">{t("admin.analytics.emp.intro")}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label={t("admin.analytics.emp.tile.people")}
          value={tileValue(pending, failed, formatNumber(measures?.employeeCount ?? 0))}
          hint={t("admin.analytics.emp.tile.peopleHint")}
          explainer={{
            formula: t("admin.analytics.emp.tile.peopleHint"),
            numbers: t("admin.analytics.emp.explainer.count", {
              rows: formatNumber(provenance?.rowsScanned ?? 0),
            }),
          }}
        />
        <KpiTile
          label={t("admin.analytics.emp.tile.attended")}
          value={tileValue(pending, failed, formatNumber(measures?.attendedDays ?? 0))}
          hint={t("admin.analytics.emp.tile.attendedHint")}
          explainer={{
            formula: t("admin.analytics.emp.tile.attendedHint"),
            numbers: t("admin.analytics.emp.explainer.count", {
              rows: formatNumber(provenance?.rowsScanned ?? 0),
            }),
          }}
        />
        <KpiTile
          label={t("admin.analytics.emp.tile.worked")}
          value={tileValue(pending, failed, fmtDurationHm(measures?.avgWorkedMinutes))}
          hint={t("admin.analytics.emp.tile.workedHint")}
          explainer={{
            formula: t("admin.analytics.emp.tile.workedHint"),
            numbers: t("admin.analytics.emp.explainer.mean", {
              // completedDays, not attendedDays: the mean excludes single-scan
              // days, whose zero duration is a missing scan-out and not a short day.
              n: formatNumber(measures?.completedDays ?? 0),
            }),
          }}
        />
        <KpiTile
          label={t("admin.analytics.emp.tile.late")}
          value={tileValue(pending, failed, formatNumber(measures?.lateDays ?? 0))}
          hint={t("admin.analytics.emp.tile.lateHint")}
          tone={(measures?.lateDays ?? 0) > 0 ? "warn" : "neutral"}
          explainer={{
            formula: t("admin.analytics.emp.tile.lateHint"),
            numbers: t("admin.analytics.emp.explainer.count", {
              rows: formatNumber(provenance?.rowsScanned ?? 0),
            }),
          }}
        />
      </div>

      <section className="mt-6">
        <StateBoundary
          loading={breakdown.isPending}
          error={breakdown.error}
          onRetry={() => void breakdown.refetch()}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={Users}
              title={t("admin.analytics.emp.empty.title")}
              hint={t("admin.analytics.emp.empty.hint")}
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.employeeId}
            pageSize={25}
            onRowClick={(row) => {
              navigate(detailPath(row));
            }}
            toolbar={
              <AnalyticsExportButtons
                // No subtitle: the report heading prints the period and every
                // active filter on their own labelled lines already.
                title={t("admin.analytics.emp.export.title")}
                filename={t("admin.analytics.emp.export.file")}
                columns={exportColumns}
                rows={rows}
                filters={filters}
                labels={exportLabels}
              />
            }
          />
        </StateBoundary>
      </section>

      {provenance === null ? null : (
        <AnalyticsCaveats
          provenance={provenance}
          departmentName={scope?.departmentName ?? null}
          locationName={scope?.locationName ?? null}
          className="mt-4"
        />
      )}

      <div className="mt-4">
        <Notice tone="info">{t("admin.analytics.emp.footnote")}</Notice>
      </div>
    </div>
  );
}
