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
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DonutChart } from "@/shared/ui/DonutChart";
import { fmtDuration } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { withFilters, type AnalyticsFilters } from "@/lib/analyticsFilters";
import { exportReport } from "@/lib/exportReport";
import { AnalyticsFilterBar } from "./AnalyticsFilterBar";
import { WorkforcePanel } from "./WorkforcePanel";
import { MovementPanel } from "./MovementPanel";
import { LeaveCostPanel } from "./LeaveCostPanel";
import { CompliancePanel } from "./CompliancePanel";
import { Notice } from "./Notice";
import {
  useAnalyticsFilterOptions,
  useAttendanceSummary,
  useDailyTrend,
  useDepartmentBreakdown,
} from "../hooks/useAnalytics";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";
import { useAnalyticsLive } from "../hooks/useAnalyticsLive";
import { DashboardPanelTabs, useDashboardPanel } from "./DashboardPanelTabs";
import { TodayRoster } from "./TodayRoster";
import { useTodayRoster } from "../hooks/useTodayRoster";
import { liveStatusCopy, type AnalyticsLiveStatus } from "../analyticsLive";
import type { DayClass, DepartmentBreakdownRow } from "../analyticsAggregate";
import { DAY_CLASS_SLICES, dayClassValue } from "../analyticsHome";

/**
 * Tone per live status. `unavailable` is a WARNING, not neutral decoration: it means
 * the socket is not delivering, so every figure below will quietly go stale while the
 * screen sits open. That is the one state a reader has to be told about, and the old
 * chip — which rendered only on `live` — said nothing at all in exactly that case.
 *
 * Labels come from `liveStatusCopy` rather than being written again here, so the chip
 * and the hook's own documented copy cannot drift apart.
 */
const LIVE_CHIP: Readonly<Record<AnalyticsLiveStatus, StatusChipEntry>> = {
  live: { label: t(liveStatusCopy("live").label), tone: "success" },
  connecting: { label: t(liveStatusCopy("connecting").label), tone: "info" },
  unavailable: { label: t(liveStatusCopy("unavailable").label), tone: "warn" },
  off: { label: t(liveStatusCopy("off").label), tone: "neutral" },
};

/** Minutes → a clock face. `avgLastOutMinutes` can exceed 1440 on a night shift. */
function clockOf(minutes: number | null): string {
  if (minutes === null) return dash(null);
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${h < 10 ? "0" : ""}${String(h)}:${m < 10 ? "0" : ""}${String(m)}`;
}

/**
 * The hue of each day class, named for the legend. Taken from the token comments in
 * `src/index.css` beside `DAY_CLASS_SLICES`' colour choices, so the words match the pixels.
 */
const DAY_CLASS_COLOUR_NAME: Readonly<Record<DayClass, Parameters<typeof t>[0]>> = {
  present: "chart.colour.green",
  leave: "chart.colour.plum",
  weekly_off: "chart.colour.gold",
  holiday: "chart.colour.terracotta",
  absent: "chart.colour.red",
  not_counted: "chart.colour.iris",
  pending: "chart.colour.hatched",
};

export function AnalyticsOverview() {
  const navigate = useNavigate();
  const { filters } = useAnalyticsFilters();

  /*
    LIVE. One subscription for the whole dashboard, mounted here rather than in each
    panel: every panel shares the analytics query key, so a single invalidation
    refreshes all of them. Four subscriptions would mean four channels and four
    refetch storms for one punch at the gate.

    The hook coalesces events — a guard scanning a queue fires many per second, and
    invalidating per event would make this slower than polling.
  */
  const live = useAnalyticsLive();
  const [panel, setPanel] = useDashboardPanel();

  const options = useAnalyticsFilterOptions();
  const roster = useTodayRoster(panel === "overview");
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

  /*
    THE RING MUST ACCOUNT FOR EVERY DAY IT PUTS IN ITS CENTRE.

    This built its own five-slice list — present, absent, leave, holiday, weekly off — and that
    list is not exhaustive over the statuses an attendance day can hold. Live August: 283 day
    records, of which 134 absent, 6 present, 1 half day and **142 pending**. The centre read 283
    while the ring added up to 141, so half the month was missing from a chart that looked
    complete, and nothing said so.

    `DAY_CLASS_SLICES` in analyticsHome.ts already solves this: it is exhaustive over `DayClass`,
    it carries the hatched "not yet processed" slice, and `dayClassValue` is documented to sum to
    `daysCounted` exactly — which is precisely what lets the centre state the total without the
    reader adding anything up. Using it removes the second, wrong definition rather than
    patching it.
  */
  const statusSlices = useMemo(() => {
    if (measures === undefined) return [];
    return DAY_CLASS_SLICES
      .map((spec) => ({
        key: spec.key,
        label: t(spec.labelKey),
        value: dayClassValue(measures, spec.key),
        color: spec.color,
        colourName: t(DAY_CLASS_COLOUR_NAME[spec.key]),
        ...(spec.texture === true ? { texture: true as const } : {}),
      }))
      .filter((slice) => slice.value > 0);
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

      {/*
        SUB-TABS, because the whole dashboard on one page was 19,906 px tall — the
        client's words were that it is "very, very, very strict to scroll down". Five
        sections, one at a time, and ONLY the selected one is mounted: that also stops
        five panels' worth of queries firing for figures nobody is looking at.

        The choice lives in the url (`?panel=`) beside the period, so a particular
        section of a particular period is a link somebody can send. It is a separate
        parameter from the filter bar's, so switching sections never disturbs the
        filters and clearing filters never bounces the reader to Overview.
      */}
      <DashboardPanelTabs active={panel} onSelect={setPanel} />

      {panel === "overview" ? (
      <>
      {/*
        ── WHO IS HERE TODAY ─────────────────────────────────────────────────────
        This replaced six independent tiles — on roll, arrived, yet to arrive, late, overdue,
        web/mobile — and no names. Six counts is not a picture of a day: they overlap (somebody
        late is also arrived), so they cannot be read as a whole, and the question people
        actually open this screen with, "who is in and who is not", needed a different page to
        answer.

        Three numbers that DO partition the roll, then the list itself. Independent of the period
        filter above and labelled so, because it is about right now.
      */}
      <h2 className="mb-2 mt-5 font-display text-lg font-semibold">
        {t("admin.analytics.overview.todayTitle")}
      </h2>
      <TodayRoster
        roster={roster.data}
        loading={roster.isLoading}
        error={roster.error ?? undefined}
        onRetry={() => void roster.refetch()}
      />

      {/* ── The selected period ──────────────────────────────────────────────── */}
      <div className="mb-2 mt-6 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          {t("admin.analytics.overview.periodTitle")}
          {/* Whether the figures are updating themselves is a property of the
              screen a reader is entitled to see, not an implementation detail — and
              that cuts BOTH ways. Rendering only on `live` left the degraded cases
              silent, so a dashboard whose socket had dropped looked exactly like one
              that was live and simply had nothing to report. Every status is named,
              and `title` carries the hint the copy already provides. */}
          <span
            className="text-xs font-normal"
            title={t(liveStatusCopy(live.status).hint)}
          >
            <StatusChip status={live.status} map={LIVE_CHIP} />
          </span>
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

      {/*
        THE HR BREADTH. Each panel owns its own queries and reads the SAME URL
        filters, so stepping the period moves every one of them together — which is
        the whole point of putting the filter in the URL rather than in state.

        Ordered as an HR head reads: who is here, who is arriving and leaving, what
        it costs, and what is out of compliance.

        `showFilterBar={false}`: each panel renders its own bar when it is the whole
        screen, and the bar at the top of THIS section already writes the same four
        search params. Four bars over one URL state is one control drawn four times —
        change the third and the other three move without the reader touching them.
        Nothing is lost by suppressing them: a dimension a panel cannot honour is
        declared in its own provenance caveats, not by the absence of a control.
      */}
      </>
      ) : null}

      {/* One panel at a time. Each is mounted ONLY while selected, so an unopened
          section costs nothing — neither height nor queries. */}
      {panel === "workforce" ? <WorkforcePanel showFilterBar={false} /> : null}
      {panel === "movement" ? <MovementPanel /> : null}
      {panel === "leavecost" ? <LeaveCostPanel showFilterBar={false} /> : null}
      {panel === "compliance" ? <CompliancePanel showFilterBar={false} /> : null}
    </section>
  );
}
