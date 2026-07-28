/**
 * AnalyticsOverview — the filtered, charted dashboard that sits above the measure
 * directory on `/admin/analytics`.
 *
 * WHY A SECTION AND NOT A REWRITE OF THE PAGE
 * -------------------------------------------
 * `AnalyticsHome.page.tsx` is deliberately a DIRECTORY: every tile there is a
 * `count=exact` over the same relation the destination screen reads, and its header
 * says outright that nothing on it is summed or averaged. That discipline is why its
 * numbers and its drill-throughs cannot disagree, and it would be vandalism to throw
 * away while adding charts. So the directory stays exactly as it is, and this — which
 * DOES aggregate, and says so — is a separate block above it.
 *
 * The two answer different questions. The directory answers "where do I go"; this
 * answers "what is happening in the period I selected".
 *
 * EVERY NUMBER STATES ITS BASIS. `analytics.api.ts` returns an `AnalyticsProvenance`
 * with every result — which relation, computed where, rows scanned, whether the read
 * was truncated, and any caveat that applies. That is surfaced rather than hidden,
 * because the failure mode of a dashboard is not a wrong pixel, it is a plausible
 * number nobody can trace.
 *
 * TRUNCATION IS LOUD, and it has to be: the day read is ordered `ist_date ASC`, so a
 * capped page loses the END of the period. Drawing that trend without a warning would
 * render the last days as a collapse in attendance — a graph that invents a crisis.
 *
 * EVERY ELEMENT DRILLS THROUGH CARRYING THE FILTERS. Tiles, department bars and the
 * "see all employees" link all go through `withFilters`, so the screen that opens is
 * answering the same question the tile was.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, Download, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DonutChart } from "@/shared/ui/DonutChart";
import { fmtDuration } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { withFilters, type AnalyticsFilters } from "@/lib/analyticsFilters";
import { exportReport } from "@/lib/exportReport";
import { AnalyticsFilterBar } from "./AnalyticsFilterBar";
import { Notice } from "./Notice";
import {
  useAnalyticsFilterOptions,
  useAttendanceSummary,
  useDailyTrend,
  useDepartmentBreakdown,
  useTodayBoard,
} from "../hooks/useAnalytics";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";
import type { DepartmentBreakdownRow } from "../analyticsAggregate";

/** Minutes → a clock face. `avgLastOutMinutes` can exceed 1440 on a night shift. */
function clockOf(minutes: number | null): string {
  if (minutes === null) return dash(null);
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${h < 10 ? "0" : ""}${String(h)}:${m < 10 ? "0" : ""}${String(m)}`;
}

export function AnalyticsOverview() {
  const navigate = useNavigate();
  const { filters } = useAnalyticsFilters();

  const options = useAnalyticsFilterOptions();
  const today = useTodayBoard();
  const summary = useAttendanceSummary(filters);
  const trend = useDailyTrend(filters);
  const departments = useDepartmentBreakdown(filters);

  const measures = summary.data?.measures;
  const provenance = summary.data?.provenance;

  /**
   * The trend series. `isEmpty` days are kept as GAPS rather than zeroes — a day with
   * no rows is a day the engine has not processed or nobody was rostered, and plotting
   * it as 0 worked minutes draws a cliff that never happened.
   */
  const trendData = useMemo(
    () =>
      (trend.data?.points ?? []).map((p) => ({
        date: p.istDate.slice(5),
        worked: p.isEmpty ? null : Math.round(p.measures.totalWorkedMinutes / 60),
        present: p.isEmpty ? null : p.measures.presentDays,
      })),
    [trend.data],
  );

  const deptData = useMemo(
    () =>
      (departments.data?.rows ?? []).slice(0, 12).map((r: DepartmentBreakdownRow) => ({
        name: r.departmentName ?? t("analytics.label.unassignedDepartment"),
        present: r.measures.presentDays,
        absent: r.measures.absentDays,
        late: r.measures.lateDays,
      })),
    [departments.data],
  );

  const statusSlices = useMemo(() => {
    if (measures === undefined) return [];
    return [
      // `key` is stable identity: DonutChart binds colour to it, not to position,
      // so a slice keeps its colour when another one drops to zero and vanishes.
      // Colour is bound to the KEY, not the position, so "absent" stays red even
      // when "leave" drops to zero and its slice disappears.
      { key: "present", label: t("admin.analytics.overview.present"), value: measures.presentDays, color: "hsl(var(--success))" },
      { key: "absent", label: t("admin.analytics.overview.absent"), value: measures.absentDays, color: "hsl(var(--destructive))" },
      { key: "leave", label: t("admin.analytics.overview.leave"), value: Math.round(measures.leaveDays), color: "hsl(var(--warning))" },
      { key: "holiday", label: t("admin.analytics.overview.holiday"), value: measures.holidayDays, color: "hsl(var(--muted-foreground))" },
      { key: "weeklyOff", label: t("admin.analytics.overview.weeklyOff"), value: measures.weeklyOffDays, color: "hsl(var(--border))" },
    ].filter((s) => s.value > 0);
  }, [measures]);

  async function download(format: "pdf" | "csv"): Promise<void> {
    const rows = departments.data?.rows ?? [];
    await exportReport({
      title: t("admin.analytics.overview.exportTitle"),
      columns: [
        { key: "dept", header: t("admin.analytics.overview.col.department") },
        { key: "present", header: t("admin.analytics.overview.present"), align: "right" },
        { key: "absent", header: t("admin.analytics.overview.absent"), align: "right" },
        { key: "late", header: t("admin.analytics.overview.lateDays"), align: "right" },
        { key: "avgWorked", header: t("admin.analytics.overview.avgWorked"), align: "right" },
      ],
      rows: rows.map((r) => ({
        dept: r.departmentName ?? t("analytics.label.unassignedDepartment"),
        present: r.measures.presentDays,
        absent: r.measures.absentDays,
        late: r.measures.lateDays,
        avgWorked: fmtDuration(r.measures.avgWorkedMinutes),
      })),
      format,
      filename: "attendance-by-department",
      filters,
    });
  }

  return (
    <section className="mb-8">
      <AnalyticsFilterBar
        departments={options.data?.departments ?? []}
        locations={options.data?.locations ?? []}
        optionsLoading={options.isLoading}
      />

      {/* ── Live: who is on site right now. Independent of the period filter, and
             labelled so nobody reads it as part of the selected range. ────────── */}
      <h2 className="mb-2 mt-5 font-display text-lg font-semibold">
        {t("admin.analytics.overview.todayTitle")}
      </h2>
      <StateBoundary
        loading={today.isLoading}
        error={today.error ?? undefined}
        onRetry={() => void today.refetch()}
        skeletonRows={1}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label={t("admin.analytics.overview.onRoll")}
            value={formatNumber(today.data?.tiles.onRoll ?? 0)}
            to={withFilters("/admin/people", filters)}
          />
          <KpiTile
            label={t("admin.analytics.overview.attended")}
            value={formatNumber(today.data?.tiles.attended ?? 0)}
            tone="success"
            to={withFilters("/admin/attendance/live", filters)}
          />
          <KpiTile
            label={t("admin.analytics.overview.yetToReach")}
            value={formatNumber(today.data?.tiles.yetToReach ?? 0)}
            to={withFilters("/admin/attendance/live", filters)}
          />
          <KpiTile
            label={t("admin.analytics.overview.lateIn")}
            value={formatNumber(today.data?.tiles.lateIn ?? 0)}
            tone={(today.data?.tiles.lateIn ?? 0) > 0 ? "warn" : undefined}
            to={withFilters("/admin/attendance/live", filters)}
          />
          <KpiTile
            label={t("admin.analytics.overview.overdue")}
            value={formatNumber(today.data?.tiles.overdue ?? 0)}
            tone={(today.data?.tiles.overdue ?? 0) > 0 ? "danger" : undefined}
            to={withFilters("/admin/attendance/live", filters)}
          />
          {/* The client's "web login vs on-premise" split — the only place the day
              grain can answer it, because punch source is a per-scan column. */}
          <KpiTile
            label={t("admin.analytics.overview.webPunches")}
            value={formatNumber(today.data?.tiles.webPunchDays ?? 0)}
            hint={t("admin.analytics.overview.webPunchesHint")}
            to={withFilters("/admin/attendance/punches", filters)}
          />
        </div>
      </StateBoundary>

      {/* ── The selected period ──────────────────────────────────────────────── */}
      <div className="mb-2 mt-6 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">
          {t("admin.analytics.overview.periodTitle")}
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void download("csv")}>
            <Download className="mr-1.5 size-4" aria-hidden />
            {t("admin.analytics.overview.exportExcel")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void download("pdf")}>
            <Download className="mr-1.5 size-4" aria-hidden />
            {t("admin.analytics.overview.exportPdf")}
          </Button>
        </div>
      </div>

      {provenance?.truncated === true ? (
        <div className="mb-3">
          <Notice tone="warning">
            <span className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t("admin.analytics.overview.truncated", {
                rows: formatNumber(provenance.rowsScanned),
              })}
            </span>
          </Notice>
        </div>
      ) : null}

      <StateBoundary
        loading={summary.isLoading}
        error={summary.error ?? undefined}
        onRetry={() => void summary.refetch()}
        isEmpty={summary.isSuccess && (measures?.daysCounted ?? 0) === 0}
        empty={
          <EmptyState
            icon={Users}
            title={t("admin.analytics.overview.empty.title")}
            hint={t("admin.analytics.overview.empty.hint")}
          />
        }
        skeletonRows={2}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label={t("admin.analytics.overview.employees")}
            value={formatNumber(measures?.employeeCount ?? 0)}
            to={withFilters("/admin/analytics/employees", filters)}
          />
          <KpiTile
            label={t("admin.analytics.overview.avgWorked")}
            value={fmtDuration(measures?.avgWorkedMinutes ?? null)}
            hint={t("admin.analytics.overview.avgWorkedHint", {
              days: formatNumber(measures?.completedDays ?? 0),
            })}
            to={withFilters("/admin/analytics/employees", filters)}
          />
          <KpiTile
            label={t("admin.analytics.overview.avgInOffice")}
            value={fmtDuration(measures?.avgGrossSpanMinutes ?? null)}
            to={withFilters("/admin/analytics/employees", filters)}
          />
          <KpiTile
            label={t("admin.analytics.overview.avgArrival")}
            value={clockOf(measures?.avgFirstInMinutes ?? null)}
            hint={t("admin.analytics.overview.avgArrivalHint")}
            to={withFilters("/admin/analytics/employees", filters)}
          />
          <KpiTile
            label={t("admin.analytics.overview.lateDays")}
            value={formatNumber(measures?.lateDays ?? 0)}
            tone={(measures?.lateDays ?? 0) > 0 ? "warn" : undefined}
            hint={t("admin.analytics.overview.lateDaysHint", {
              avg: fmtDuration(measures?.avgLateMinutes ?? null),
            })}
            to={withFilters("/admin/attendance/exceptions", filters)}
          />
          <KpiTile
            label={t("admin.analytics.overview.overtime")}
            value={fmtDuration(measures?.overtimeMinutes ?? 0)}
            to={withFilters("/admin/analytics/employees", filters)}
          />
        </div>

        {/* ── Infographics ──────────────────────────────────────────────────── */}
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border bg-card p-4 lg:col-span-2">
            <h3 className="mb-3 text-sm font-medium">
              {t("admin.analytics.overview.trendTitle")}
            </h3>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                {/* connectNulls={false}: a gap day must LOOK like a gap. */}
                <Line
                  type="monotone"
                  dataKey="worked"
                  name={t("admin.analytics.overview.workedHours")}
                  stroke="var(--chart-1, #7c5c3e)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="present"
                  name={t("admin.analytics.overview.present")}
                  stroke="var(--chart-2, #4f7a5b)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-sm font-medium">
              {t("admin.analytics.overview.statusTitle")}
            </h3>
            {statusSlices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("admin.analytics.overview.empty.hint")}
              </p>
            ) : (
              <DonutChart
                slices={statusSlices}
                title={t("admin.analytics.overview.statusTitle")}
                // The centre carries the DENOMINATOR, not a percentage: the slices
                // are already proportions, and the one thing a reader cannot infer
                // from them is how many days they are a proportion of.
                centreValue={formatNumber(measures?.daysCounted ?? 0)}
                centreCaption={t("admin.analytics.overview.daysCounted")}
              />
            )}
          </div>
        </div>

        <div className="mt-4 rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium">
            {t("admin.analytics.overview.deptTitle")}
          </h3>
          <ResponsiveContainer width="100%" height={Math.max(200, deptData.length * 38)}>
            <BarChart data={deptData} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
              <Tooltip />
              {/*
                Clicking a bar drills into that department with the period intact —
                the "click, click, click" the client described. The department is
                matched by NAME because the day view exposes department_name, not id;
                the filter bar resolves the id, so this looks it up from the options.
              */}
              <Bar
                dataKey="present"
                name={t("admin.analytics.overview.present")}
                fill="var(--chart-2, #4f7a5b)"
                cursor="pointer"
                onClick={(entry: { name?: string }) => {
                  const match = (options.data?.departments ?? []).find(
                    (d) => d.name === entry.name,
                  );
                  if (match === undefined) return;
                  void navigate(
                    withFilters("/admin/analytics/employees", {
                      ...filters,
                      departmentId: match.id,
                    } as AnalyticsFilters),
                  );
                }}
              />
              <Bar
                dataKey="late"
                name={t("admin.analytics.overview.lateDays")}
                fill="var(--chart-4, #c08a3e)"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {provenance !== undefined ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("admin.analytics.overview.basis", {
              relation: provenance.relation,
              rows: formatNumber(provenance.rowsScanned),
            })}
          </p>
        ) : null}
      </StateBoundary>
    </section>
  );
}
