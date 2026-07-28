/**
 * WorkforcePanel — headcount, org shape, span of control, tenure, age and
 * workforce composition for the selected period, department and location.
 *
 * FOUR THINGS THIS PANEL REFUSES TO DO, each of which is the whole reason a
 * line of code below looks the way it does:
 *
 *  1. IT WILL NOT AVERAGE A PERIOD INTO A HEADCOUNT. Headcount is a stock, so a
 *     period selects a DATE — the end of it, clamped to today — and the panel
 *     prints that date above every figure. "How many people in July" has no
 *     answer; "how many on 31 July" has one.
 *  2. IT WILL NOT CONFLATE MANAGERS. "People with reportees" (distinct
 *     `reporting_manager_id`) and "hold the manager role" (`user_roles`) are two
 *     tiles, side by side, each saying what it counts. They are never added and
 *     never substituted — see `fetchManagerRoleCount` for why they are
 *     genuinely different populations in this database.
 *  3. IT WILL NOT DRILL INTO A PERSON FROM A DIVERSITY BUCKET. Every other
 *     chart here is a filter; the composition blocks deliberately are not, and
 *     buckets under the k-anonymity floor are withheld along with a second
 *     bucket so their size cannot be recovered by subtraction. This is the one
 *     place the drill-everywhere rule of this analytics surface is switched off,
 *     and the note on screen says so rather than leaving it looking unfinished.
 *  4. IT WILL NOT DRAW A LINE IT CANNOT FILTER. With a location selected the
 *     headcount trend is replaced by the reason it is missing, because
 *     `mv_headcount_daily` has no location column and a whole-venue line under
 *     one location's heading is worse than no line at all.
 *
 * Charts come from `AnalyticsOpsCharts` (validated palette, dash-coded lines,
 * a real table fallback under every figure) and `DonutChart`; nothing is drawn
 * here that those two do not already do properly.
 */
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, Network, Users } from "lucide-react";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DonutChart, type DonutSlice } from "@/shared/ui/DonutChart";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { t, type MessageKey } from "@/shared/i18n/en";
import { withFilters, type AnalyticsFilters } from "@/lib/analyticsFilters";
import { seriesColour } from "../analytics-ops-palette";
import { AnalyticsFilterBar } from "./AnalyticsFilterBar";
import { RankedBarsChart, TrendLinesChart, type ChartPoint } from "./AnalyticsOpsCharts";
import { Notice } from "./Notice";
import { useAnalyticsFilterOptions } from "../hooks/useAnalytics";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";
import {
  useHeadcountTrend,
  useManagerRoleCount,
  useWorkforceSnapshot,
} from "../hooks/useHrWorkforce";
import {
  MIN_PUBLISHABLE_BUCKET,
  WIDE_SPAN_THRESHOLD,
  type AgeBand,
  type HeadcountBucket,
  type ManagerSpan,
  type SuppressedBreakdown,
  type TenureBand,
} from "../api/hr-workforce.api";

/**
 * Bars past this are not drawn. A designation list can run to sixty entries and
 * a chart of sixty 4px bars communicates nothing; the caption states how many
 * groups were left off so the reader knows the picture is a top-N, not the whole
 * organisation.
 */
const MAX_BARS = 14;

/** Widest spans worth tabulating. The findings, not the whole reporting tree. */
const MAX_SPAN_ROWS = 25;

const TENURE_LABEL: Readonly<Record<TenureBand, MessageKey>> = {
  lt3m: "admin.hrwf.tenure.band.lt3m",
  m3to12: "admin.hrwf.tenure.band.m3to12",
  y1to3: "admin.hrwf.tenure.band.y1to3",
  y3plus: "admin.hrwf.tenure.band.y3plus",
};

const AGE_LABEL: Readonly<Record<AgeBand, MessageKey>> = {
  lt25: "admin.hrwf.age.band.lt25",
  a25to34: "admin.hrwf.age.band.a25to34",
  a35to44: "admin.hrwf.age.band.a35to44",
  a45to54: "admin.hrwf.age.band.a45to54",
  a55plus: "admin.hrwf.age.band.a55plus",
};

/**
 * Value labels for the composition blocks. Gender and marital status reuse the
 * People console's own catalogue — the same enum value must read the same on
 * every screen — and the reservation categories get labels here because nothing
 * else in the product renders them.
 */
const DIVERSITY_VALUE_LABEL: Readonly<Record<string, MessageKey>> = {
  male: "admin.people.gender.male",
  female: "admin.people.gender.female",
  transgender: "admin.people.gender.transgender",
  prefer_not_to_say: "admin.people.gender.prefer_not_to_say",
  single: "admin.people.marital.single",
  married: "admin.people.marital.married",
  divorced: "admin.people.marital.divorced",
  widowed: "admin.people.marital.widowed",
  separated: "admin.people.marital.separated",
  yes: "admin.hrwf.div.value.yes",
  no: "admin.hrwf.div.value.no",
  GEN: "admin.hrwf.div.category.GEN",
  OBC: "admin.hrwf.div.category.OBC",
  SC: "admin.hrwf.div.category.SC",
  ST: "admin.hrwf.div.category.ST",
  EWS: "admin.hrwf.div.category.EWS",
};

/** An unmapped value is server data (a free-text nationality) — render it as-is. */
function valueLabel(key: string | null): string {
  if (key === null) return t("admin.hrwf.label.notRecorded");
  const mapped = DIVERSITY_VALUE_LABEL[key];
  return mapped === undefined ? key : t(mapped);
}

const SPAN_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  in_scope: { label: t("admin.hrwf.span.inScopeYes"), tone: "neutral" },
  out_of_scope: { label: t("admin.hrwf.span.inScopeOut"), tone: "info" },
  wide: { label: t("admin.hrwf.span.wide", { threshold: WIDE_SPAN_THRESHOLD }), tone: "warn" },
};

const countFormat = (value: number | null): string => formatNumber(value);

/** Buckets → chart points, keeping the bucket's own key as the drill identity. */
function toBarPoints(buckets: readonly HeadcountBucket[]): ChartPoint[] {
  return buckets.slice(0, MAX_BARS).map((bucket) => ({
    x: bucket.label ?? t("admin.hrwf.label.unassigned"),
    // `id` is the uuid for department/location, the value itself otherwise —
    // so a re-ordered chart can never open the wrong department, and two
    // departments sharing a name stay two bars with two destinations.
    id: bucket.key ?? "",
    values: { people: bucket.count },
  }));
}

export interface WorkforcePanelProps {
  /**
   * Render this panel's own filter bar. FALSE when the panel is embedded under a
   * surface that already renders one over the same URL filters — four bars writing
   * the same four search params is not four controls, it is one control drawn four
   * times, and a reader who changes the third one has no way to know the other
   * three moved with it.
   *
   * Suppressing the bar loses nothing but the duplicate: the dimensions this panel
   * cannot honour are declared in `provenance.caveats` and printed above the
   * figures either way, so a `source` the host bar offers still says out loud that
   * it narrowed nothing here.
   */
  readonly showFilterBar?: boolean;
}

export function WorkforcePanel({ showFilterBar = true }: WorkforcePanelProps = {}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { filters } = useAnalyticsFilters();

  const options = useAnalyticsFilterOptions();
  const snapshot = useWorkforceSnapshot(filters);
  const trend = useHeadcountTrend(filters);
  const roleGrants = useManagerRoleCount();

  const data = snapshot.data?.snapshot;
  const scope = snapshot.data?.scope;
  const provenance = snapshot.data?.provenance;
  const asOfDate = scope?.asOf.date ?? filters.period.to;

  /**
   * Narrow the panel in place. `withFilters` on the CURRENT path, rather than a
   * link to another screen: this surface already answers the narrower question,
   * the URL stays shareable, and the drill earns a history entry so Back undoes
   * exactly one step of "click, click, click".
   */
  const drillTo = (next: AnalyticsFilters): void => {
    void navigate(withFilters(pathname, next));
  };

  const departmentPoints = useMemo(() => toBarPoints(data?.byDepartment ?? []), [data]);
  const locationPoints = useMemo(() => toBarPoints(data?.byLocation ?? []), [data]);
  const designationPoints = useMemo(() => toBarPoints(data?.byDesignation ?? []), [data]);
  const gradePoints = useMemo(() => toBarPoints(data?.byGrade ?? []), [data]);
  const typePoints = useMemo(() => toBarPoints(data?.byEmploymentType ?? []), [data]);

  const tenureSlices = useMemo<DonutSlice[]>(
    () =>
      (data?.tenure.bands ?? []).map((entry, i) => ({
        // Colour binds to the BAND, not to position, so a band that empties and
        // disappears never repaints the survivors.
        key: entry.band,
        label: t(TENURE_LABEL[entry.band]),
        value: entry.count,
        color: seriesColour(i),
      })),
    [data],
  );

  const ageSlices = useMemo<DonutSlice[]>(
    () =>
      (data?.age.bands ?? []).map((entry, i) => ({
        key: entry.band,
        label: t(AGE_LABEL[entry.band]),
        value: entry.count,
        color: seriesColour(i),
      })),
    [data],
  );

  const spanRows = useMemo(
    () => (data?.span.spans ?? []).slice(0, MAX_SPAN_ROWS),
    [data],
  );

  const trendPoints = useMemo<ChartPoint[]>(
    () =>
      (trend.data?.points ?? []).map((point) => ({
        x: fmtCivilDate(point.asOfDate),
        id: point.asOfDate,
        // A gap day is null, never 0 — see the aggregate's own comment. A zero
        // here would draw the venue losing its whole workforce overnight.
        values: { headcount: point.headcount, joiners: point.joiners, exits: point.exits },
      })),
    [trend.data],
  );

  /**
   * Does the matview actually cover ANY of these dates?
   *
   * Not `trendPoints.length > 0`: `aggregateHeadcountTrend` emits one point per
   * IST date in the period whether or not the matview holds a row for it, so a
   * length test is always true and would render two charts of entirely null
   * series — a blank plot area under a real heading, which reads as a broken
   * screen rather than as a nightly refresh that has not reached these dates.
   * `isEmpty` is the field the aggregate sets for exactly this question.
   */
  const trendHasData = useMemo(
    () => (trend.data?.points ?? []).some((point) => !point.isEmpty),
    [trend.data],
  );

  const spanColumns: DataGridColumn<ManagerSpan>[] = useMemo(
    () => [
      {
        key: "managerName",
        header: t("admin.hrwf.span.col.manager"),
        width: "18rem",
        render: (row) => row.managerName ?? t("admin.hrwf.span.unnamed"),
      },
      {
        key: "reportees",
        header: t("admin.hrwf.span.col.reportees"),
        width: "12rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.reportees,
        render: (row) => (
          <span className="flex items-center justify-end gap-2">
            <span className="num">{formatNumber(row.reportees)}</span>
            {row.reportees > WIDE_SPAN_THRESHOLD ? (
              <StatusChip status="wide" map={SPAN_CHIP} />
            ) : null}
          </span>
        ),
      },
      {
        key: "inScope",
        header: t("admin.hrwf.span.col.inScope"),
        width: "12rem",
        hideBelow: "md",
        render: (row) => (
          <StatusChip status={row.inScope ? "in_scope" : "out_of_scope"} map={SPAN_CHIP} />
        ),
      },
    ],
    [],
  );

  const caveats = provenance?.caveats ?? [];

  return (
    <section className="mb-8">
      {/* `employee` and `source` are hidden rather than ignored: a headcount of
          one person is not a measure, and punch source is a per-scan column. */}
      {showFilterBar ? (
        <AnalyticsFilterBar
          departments={options.data?.departments ?? []}
          locations={options.data?.locations ?? []}
          optionsLoading={options.isLoading}
          hide={["employee", "source"]}
        />
      ) : null}

      <div className="mb-2 mt-5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">{t("admin.hrwf.title")}</h2>
        <p className="num text-sm text-muted-foreground">
          {t("admin.hrwf.asOf", { date: fmtCivilDate(asOfDate) })}
        </p>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{t("admin.hrwf.subtitle")}</p>

      {/* Every caveat the scope produced, printed before the numbers rather
          than under them — a reader who has already believed a figure is not
          helped by a footnote. */}
      {caveats.length > 0 ? (
        <div className="mb-3 space-y-2">
          {caveats.map((key) => (
            <Notice key={key} tone={key === "admin.hrwf.caveat.truncated" ? "warning" : "info"}>
              {key === "admin.hrwf.caveat.truncated" ? (
                <span className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {t(key)}
                </span>
              ) : (
                t(key)
              )}
            </Notice>
          ))}
        </div>
      ) : null}

      <StateBoundary
        loading={snapshot.isLoading}
        error={snapshot.error ?? undefined}
        onRetry={() => void snapshot.refetch()}
        isEmpty={snapshot.isSuccess && (data?.headcount ?? 0) === 0}
        empty={
          <EmptyState
            icon={Users}
            title={t("admin.hrwf.empty.title")}
            hint={t("admin.hrwf.empty.hint", { date: fmtCivilDate(asOfDate) })}
          />
        }
        skeletonRows={2}
      >
        {/* ── Headline ────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label={t("admin.hrwf.kpi.headcount")}
            value={formatNumber(data?.headcount ?? 0)}
            hint={t("admin.hrwf.kpi.headcountHint", {
              date: fmtCivilDate(asOfDate),
              rows: formatNumber(data?.rowsConsidered ?? 0),
            })}
          />
          <KpiTile
            label={t("admin.hrwf.kpi.withReportees")}
            value={formatNumber(data?.span.managers ?? 0)}
            hint={t("admin.hrwf.kpi.withReporteesHint")}
          />
          {/* The other population, never merged with the one on its left. */}
          <KpiTile
            label={t("admin.hrwf.kpi.roleGrants")}
            value={
              roleGrants.error !== null
                ? dash(null)
                : formatNumber(roleGrants.data?.grants ?? 0)
            }
            hint={t("admin.hrwf.kpi.roleGrantsHint")}
          />
          <KpiTile
            label={t("admin.hrwf.kpi.span")}
            // One decimal: a span of control is a ratio, and rounding 8.4 to 8
            // hides the difference between a flat org and a stretched one.
            value={dash(data?.span.spanOfControl ?? null, (v) => v.toFixed(1))}
            hint={t("admin.hrwf.kpi.spanHint", {
              mean: dash(data?.span.meanReportees ?? null, (v) => v.toFixed(1)),
              orphans: formatNumber(data?.span.peopleWithoutAManager ?? 0),
            })}
          />
          <KpiTile
            label={t("admin.hrwf.kpi.widestSpan")}
            value={dash(data?.span.maxReportees ?? null, formatNumber)}
            tone={
              (data?.span.maxReportees ?? 0) > WIDE_SPAN_THRESHOLD ? "warn" : undefined
            }
            hint={
              data?.span.spans[0] === undefined
                ? t("admin.hrwf.kpi.widestSpanUnknown")
                : t("admin.hrwf.kpi.widestSpanHint", {
                    name: data.span.spans[0].managerName ?? t("admin.hrwf.span.unnamed"),
                  })
            }
          />
          <KpiTile
            label={t("admin.hrwf.kpi.wideSpans", { threshold: WIDE_SPAN_THRESHOLD })}
            value={formatNumber(data?.span.managersOverThreshold ?? 0)}
            tone={(data?.span.managersOverThreshold ?? 0) > 0 ? "warn" : undefined}
            hint={t("admin.hrwf.kpi.wideSpansHint", { threshold: WIDE_SPAN_THRESHOLD })}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Notice tone="info">{t("admin.hrwf.definition")}</Notice>
          {(data?.statusAnomalies ?? 0) > 0 ? (
            <KpiTile
              label={t("admin.hrwf.kpi.anomalies")}
              value={formatNumber(data?.statusAnomalies ?? 0)}
              tone="warn"
              hint={t("admin.hrwf.kpi.anomaliesHint")}
            />
          ) : null}
        </div>

        {scope?.asOf.historical === true ? (
          <div className="mt-3">
            <Notice tone="warning">
              {t("admin.hrwf.asOfHistorical", { date: fmtCivilDate(asOfDate) })}
            </Notice>
          </div>
        ) : null}

        {/* ── Where the people are ────────────────────────────────────────── */}
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border bg-card p-4">
            <RankedBarsChart
              title={t("admin.hrwf.bars.department")}
              caption={barsCaption("admin.hrwf.bars.departmentCaption", data?.byDepartment)}
              measure={{ key: "people", label: t("admin.hrwf.bars.measure") }}
              points={departmentPoints}
              format={countFormat}
              xHeader={t("admin.hrwf.bars.category")}
              select={{
                selectLabel: (label) => t("admin.hrwf.bars.drill", { name: label }),
                onSelect: (id) => {
                  // An empty id is the "not assigned" bar. There is no uuid to
                  // filter on, so it stays a count rather than a broken link.
                  if (id === "") return;
                  drillTo({ ...filters, departmentId: id });
                },
              }}
            />
          </div>
          <div className="rounded-lg border bg-card p-4">
            <RankedBarsChart
              title={t("admin.hrwf.bars.location")}
              caption={barsCaption("admin.hrwf.bars.locationCaption", data?.byLocation)}
              measure={{ key: "people", label: t("admin.hrwf.bars.measure") }}
              points={locationPoints}
              format={countFormat}
              xHeader={t("admin.hrwf.bars.category")}
              select={{
                selectLabel: (label) => t("admin.hrwf.bars.drill", { name: label }),
                onSelect: (id) => {
                  if (id === "") return;
                  drillTo({ ...filters, locationId: id });
                },
              }}
            />
          </div>
        </div>

        {/* No `select` on these three: `AnalyticsFilters` has no dimension for
            designation, grade or employment type, and a link no screen honours
            is worse than a chart that admits it is a picture. */}
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border bg-card p-4">
            <RankedBarsChart
              title={t("admin.hrwf.bars.designation")}
              caption={barsCaption("admin.hrwf.bars.designationCaption", data?.byDesignation)}
              measure={{ key: "people", label: t("admin.hrwf.bars.measure") }}
              points={designationPoints}
              format={countFormat}
              xHeader={t("admin.hrwf.bars.category")}
            />
          </div>
          <div className="rounded-lg border bg-card p-4">
            <RankedBarsChart
              title={t("admin.hrwf.bars.grade")}
              caption={barsCaption("admin.hrwf.bars.gradeCaption", data?.byGrade)}
              measure={{ key: "people", label: t("admin.hrwf.bars.measure") }}
              points={gradePoints}
              format={countFormat}
              xHeader={t("admin.hrwf.bars.category")}
            />
          </div>
          <div className="rounded-lg border bg-card p-4">
            <RankedBarsChart
              title={t("admin.hrwf.bars.type")}
              caption={barsCaption("admin.hrwf.bars.typeCaption", data?.byEmploymentType)}
              measure={{ key: "people", label: t("admin.hrwf.bars.measure") }}
              points={typePoints}
              format={countFormat}
              xHeader={t("admin.hrwf.bars.category")}
            />
          </div>
        </div>

        {/* ── Tenure and age ──────────────────────────────────────────────── */}
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-sm font-medium">{t("admin.hrwf.tenure.title")}</h3>
            <DonutChart
              slices={tenureSlices}
              title={t("admin.hrwf.tenure.title")}
              // The centre carries the DENOMINATOR, never a percentage: the
              // slices are already proportions, and the one thing a reader
              // cannot infer from them is what they are a proportion of.
              centreValue={formatNumber(data?.tenure.denominator ?? 0)}
              centreCaption={t("admin.hrwf.tenure.centre")}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              {t("admin.hrwf.tenure.caption", {
                date: fmtCivilDate(asOfDate),
                total: formatNumber(data?.headcount ?? 0),
              })}
            </p>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-sm font-medium">{t("admin.hrwf.age.title")}</h3>
            {(data?.age.denominator ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">{t("admin.hrwf.age.none")}</p>
            ) : (
              <>
                <DonutChart
                  slices={ageSlices}
                  title={t("admin.hrwf.age.title")}
                  centreValue={formatNumber(data?.age.denominator ?? 0)}
                  centreCaption={t("admin.hrwf.age.centre")}
                />
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("admin.hrwf.age.caption", {
                    date: fmtCivilDate(asOfDate),
                    counted: formatNumber(data?.age.denominator ?? 0),
                    total: formatNumber(data?.headcount ?? 0),
                    excluded: formatNumber(data?.age.excluded ?? 0),
                  })}
                </p>
              </>
            )}
          </div>
        </div>

        {/* ── Reporting lines ─────────────────────────────────────────────── */}
        <section className="mt-5">
          <h3 className="text-sm font-medium">{t("admin.hrwf.span.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("admin.hrwf.span.hint")}</p>
          <div className="mt-3">
            <DataGrid
              columns={spanColumns}
              rows={spanRows}
              rowKey={(row) => row.managerId}
              pageSize={10}
              emptyState={
                <EmptyState
                  icon={Network}
                  title={t("admin.hrwf.span.empty.title")}
                  hint={t("admin.hrwf.span.empty.hint")}
                />
              }
            />
          </div>
        </section>

        {/* ── Composition (DPDP) ──────────────────────────────────────────── */}
        <section className="mt-5">
          <h3 className="text-sm font-medium">{t("admin.hrwf.div.title")}</h3>
          <div className="mt-2">
            <Notice tone="info">
              {t("admin.hrwf.div.dpdp", { min: MIN_PUBLISHABLE_BUCKET })}
            </Notice>
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <CompositionBlock title={t("admin.hrwf.div.gender")} data={data?.diversity.gender} />
            <CompositionBlock title={t("admin.hrwf.div.category")} data={data?.diversity.category} />
            <CompositionBlock
              title={t("admin.hrwf.div.disability")}
              data={data?.diversity.differentlyAbled}
            />
            <CompositionBlock
              title={t("admin.hrwf.div.nationality")}
              data={data?.diversity.nationality}
            />
            <CompositionBlock
              title={t("admin.hrwf.div.marital")}
              data={data?.diversity.maritalStatus}
            />
          </div>
        </section>

        {provenance !== undefined ? (
          <p className="mt-4 text-xs text-muted-foreground">
            {t("admin.hrwf.basis", {
              relation: provenance.relation,
              rows: formatNumber(provenance.rowsScanned),
            })}
          </p>
        ) : null}
      </StateBoundary>

      {/* ── Trend — its own relation, its own boundary ───────────────────── */}
      <section className="mt-6">
        <StateBoundary
          loading={trend.isLoading}
          error={trend.error ?? undefined}
          onRetry={() => void trend.refetch()}
          skeletonRows={2}
        >
          {trend.data?.applicable === false ? (
            <Notice tone="warning">{t("admin.hrwf.trend.noLocation")}</Notice>
          ) : !trendHasData ? (
            <EmptyState
              icon={Users}
              title={t("admin.hrwf.trend.empty.title")}
              hint={t("admin.hrwf.trend.empty.hint")}
            />
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border bg-card p-4">
                <TrendLinesChart
                  title={t("admin.hrwf.trend.title")}
                  caption={t("admin.hrwf.trend.caption")}
                  series={[{ key: "headcount", label: t("admin.hrwf.trend.headcount") }]}
                  points={trendPoints}
                  format={countFormat}
                  xHeader={t("admin.hrwf.trend.date")}
                />
              </div>
              {/* A second chart rather than a second axis: joiners peak at two
                  or three against a headcount of hundreds, and on one axis the
                  flow is a flat line along the bottom. */}
              <div className="rounded-lg border bg-card p-4">
                <TrendLinesChart
                  title={t("admin.hrwf.trend.flowTitle")}
                  caption={t("admin.hrwf.trend.flowCaption")}
                  series={[
                    { key: "joiners", label: t("admin.hrwf.trend.joiners") },
                    { key: "exits", label: t("admin.hrwf.trend.exits") },
                  ]}
                  points={trendPoints}
                  format={countFormat}
                  xHeader={t("admin.hrwf.trend.date")}
                />
              </div>
            </div>
          )}

          <p className="mt-3 text-xs text-muted-foreground">
            {trend.data?.refreshedAt == null
              ? t("admin.hrwf.stampUnknown")
              : t("admin.hrwf.stamp", {
                  at: fmtDateTime(trend.data.refreshedAt),
                  date: fmtCivilDate(trend.data.coversTo ?? asOfDate),
                })}
            {trend.data !== undefined && trend.data.applicable ? (
              <>
                {" "}
                {t("admin.hrwf.basisTrend", {
                  relation: trend.data.provenance.relation,
                  rows: formatNumber(trend.data.provenance.rowsScanned),
                })}
              </>
            ) : null}
          </p>
        </StateBoundary>
      </section>
    </section>
  );
}

/** The caption, plus a "top N of M" line whenever bars were left off the chart. */
function barsCaption(key: MessageKey, buckets: readonly HeadcountBucket[] | undefined): string {
  const total = buckets?.length ?? 0;
  const base = t(key);
  if (total <= MAX_BARS) return base;
  return `${base} ${t("admin.hrwf.bars.more", { shown: MAX_BARS, total })}`;
}

/**
 * One composition attribute: the published buckets, and — when something was
 * held back — a single "withheld" row carrying only a headcount and a group
 * count. The withheld LABELS never reach the DOM, because on a free-text
 * attribute like nationality the label is the identifying fact, not the number.
 */
function CompositionBlock({
  title,
  data,
}: {
  title: string;
  data: SuppressedBreakdown | undefined;
}) {
  const kept = data?.kept ?? [];
  const withheld = data?.withheld ?? null;
  const total = data?.total ?? 0;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">{title}</h4>
        <span className="num text-xs text-muted-foreground">
          {t("admin.hrwf.div.total", { total: formatNumber(total) })}
        </span>
      </div>
      {/* Three distinct states, and the middle one is the point of this block:
          "withheld" is not the same as "not recorded", and collapsing them
          would let a suppression read as missing data. */}
      {kept.length > 0 ? (
        <dl className="mt-2 space-y-1">
          {kept.map((bucket) => (
            <div key={bucket.key ?? "__unrecorded"} className="flex items-baseline gap-2 text-sm">
              <dt className="min-w-0 flex-1 truncate">{valueLabel(bucket.key)}</dt>
              <dd className="num shrink-0 font-medium">{formatNumber(bucket.count)}</dd>
            </div>
          ))}
        </dl>
      ) : withheld !== null ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("admin.hrwf.div.allWithheld")}</p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">{t("admin.hrwf.label.notRecorded")}</p>
      )}
      {withheld !== null && kept.length > 0 ? (
        <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
          <span className="font-medium">{t("admin.hrwf.div.withheld")}</span>{" "}
          {t("admin.hrwf.div.withheldHint", {
            people: formatNumber(withheld.people),
            buckets: formatNumber(withheld.buckets),
          })}
        </p>
      ) : null}
    </div>
  );
}
