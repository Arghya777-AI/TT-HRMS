/**
 * MovementPanel — joiners, exits, attrition and the four watchlists, over the
 * period and dimensions already in the URL.
 *
 * WHAT THIS PANEL IS FOR
 * ----------------------
 * The top half answers "what happened to headcount". The bottom half is the part
 * that earns its place: four lists of DECISIONS SOMEBODY OWES — a confirmation
 * nobody signed, a contract nobody renewed, notice nobody planned a handover for,
 * an exit interview nobody held. Those are work, not numbers to admire, so they
 * are tables with names in them and every row opens that person's record.
 *
 * THREE THINGS THIS SCREEN REFUSES TO DO
 * --------------------------------------
 *  1. PRINT AN UNLABELLED ATTRITION PERCENTAGE. Every HR team defines attrition
 *     differently, so the formula sits under the tile in words, with this
 *     period's own numbers substituted, and the window is stated in days. The
 *     annualised figure is withheld entirely below `MIN_ANNUALISE_DAYS` — a
 *     seven-day window multiplies every exit by 52 and turns one leaver into a
 *     crisis nobody can un-see.
 *  2. PLOT HEADCOUNT AND MOVEMENT ON ONE PAIR OF AXES. Two hundred heads and
 *     three joiners share no useful scale, and a second y-axis is the single
 *     most misread thing in dashboards. They are two charts over the same x
 *     domain instead.
 *  3. BLEND THE TWO SOURCES. The series is a nightly matview; the watchlists are
 *     live. Both figures are shown, the "as of" line says which is which, and
 *     when they disagree the panel explains the disagreement rather than
 *     silently preferring one.
 *
 * GAPS ARE GAPS. `v_headcount_daily` stops at the last refresh, so a period
 * running into today or the future has dates it does not hold. Those points are
 * null, the line breaks, the average excludes them, and a banner says how many
 * days are missing. Drawing them as zero would render a venue's entire workforce
 * disappearing overnight.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
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
import { CalendarClock, FileWarning, LogOut, UserCheck, Users } from "lucide-react";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { fmtCivilDate, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { withFilters, type AnalyticsFilters } from "@/lib/analyticsFilters";
import { AnalyticsCaveats } from "./AnalyticsCaveats";
import { Notice } from "./Notice";
import { PersonCell } from "./PersonCell";
import { CHART_GRID, seriesColour } from "../analytics-ops-palette";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";
import {
  useContractWatchlist,
  useExitQuality,
  useLiveMovementCounts,
  useMovementReconciliation,
  useMovementSeries,
  useNoticeWatchlist,
  useProbationWatchlist,
} from "../hooks/useHrMovement";
import {
  CONTRACT_LOOKAHEAD_DAYS,
  EXIT_TYPE_LABELS,
  hypotheticalAnnualiseFactor,
  isExitType,
  type AttritionRate,
  type ContractWatchRow,
  type MovementDepartmentRow,
  type MovementEmployee,
  type MovementEmployeeRow,
  type NoticeWatchRow,
  type ProbationWatchRow,
} from "../api/hr-movement.api";
import { EMPLOYMENT_STATUS_LABELS, employmentStatusSchema } from "../api/employees.api";

/**
 * Colour binds to the SERIES, not to its position, and the same two hues mean
 * joiners and exits in every chart and table on the panel. `SERIES_COLORS` is the
 * repo's validated categorical order (all-pairs CVD separation and a 3:1 floor
 * against both chart surfaces — see analytics-ops-palette.ts), so this is not a
 * taste decision being made here.
 */
const JOINERS_COLOUR = seriesColour(0);
const EXITS_COLOUR = seriesColour(1);

/** A department id can be null; the grid still needs a stable row key. */
const UNASSIGNED_KEY = "unassigned";

export interface MovementPanelProps {
  /**
   * Override the URL-backed filters. Omit on a normal screen — the panel then
   * reads the same `AnalyticsFilters` the filter bar writes, so a drill-through
   * into it inherits the exact question being asked.
   */
  readonly filters?: AnalyticsFilters;
}

export function MovementPanel({ filters: override }: MovementPanelProps = {}) {
  const navigate = useNavigate();
  const { filters: urlFilters } = useAnalyticsFilters();
  const filters = override ?? urlFilters;
  const period = filters.period;
  const today = nowIstDate();

  const series = useMovementSeries(filters);
  const live = useLiveMovementCounts(filters);
  const probation = useProbationWatchlist(filters);
  const contracts = useContractWatchlist(filters);
  const notice = useNoticeWatchlist(filters);
  const exits = useExitQuality(filters);
  const { reconciliation } = useMovementReconciliation(filters);

  const snapshot = series.data;
  const attrition = snapshot?.attrition;

  function openEmployee(code: string): void {
    // The 360 route is keyed by employee_code, not by id — see route-manifest.
    void navigate(`/admin/people/${encodeURIComponent(code)}`);
  }

  // ── Chart series ─────────────────────────────────────────────────────────
  // `isCovered: false` becomes null on every measure so the line BREAKS and the
  // bars are absent. A zero here would draw a workforce that vanished.
  const chartData = useMemo(
    () =>
      (snapshot?.series.points ?? []).map((p) => ({
        date: p.istDate.slice(5),
        headcount: p.headcount,
        joiners: p.joiners,
        exits: p.exits,
      })),
    [snapshot],
  );

  const hasSeries = (snapshot?.series.coveredDays ?? 0) > 0;

  // The panel is empty only when NOTHING is happening — no movement recorded and
  // no watchlist row. Any one of them present means there is something to read.
  const isEmpty =
    series.isSuccess &&
    live.isSuccess &&
    !hasSeries &&
    (live.data?.joiners ?? 0) === 0 &&
    (live.data?.exits ?? 0) === 0 &&
    (probation.data?.rows.length ?? 0) === 0 &&
    (contracts.data?.rows.length ?? 0) === 0 &&
    (notice.data?.rows.length ?? 0) === 0;

  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="font-display text-lg font-semibold">{t("admin.movement.title")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("admin.movement.subtitle")}</p>
      </div>

      {/* ── How current the snapshot is. Printed before any number that came
             out of it, because "as of" changes what the number means. ─────── */}
      {snapshot !== undefined ? <SnapshotBanner result={snapshot} /> : null}

      {/* ── Where the two sources disagree, and why. ────────────────────────── */}
      {reconciliation !== null && !reconciliation.agrees ? (
        <Notice tone="info" className="mb-3">
          {t("admin.movement.recon.disagree", {
            snapshotJoiners: formatNumber(reconciliation.snapshotJoiners),
            snapshotExits: formatNumber(reconciliation.snapshotExits),
            liveJoiners: formatNumber(reconciliation.liveJoiners),
            liveExits: formatNumber(reconciliation.liveExits),
          })}
        </Notice>
      ) : null}

      <StateBoundary
        loading={series.isLoading || live.isLoading}
        error={series.error ?? live.error ?? undefined}
        onRetry={() => {
          void series.refetch();
          void live.refetch();
        }}
        isEmpty={isEmpty}
        empty={
          <EmptyState
            icon={Users}
            title={t("admin.movement.empty.title")}
            hint={t("admin.movement.empty.hint")}
          />
        }
        skeletonRows={3}
      >
        {/* ── Headline. Joiners and exits are the LIVE counts — they are the
               current truth and they are the numbers the lists below open. ── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label={t("admin.movement.kpi.joiners")}
            value={formatNumber(live.data?.joiners ?? 0)}
            hint={t("admin.movement.kpi.joinersHint")}
            to={withFilters("/admin/people/onboarding", filters)}
          />
          <KpiTile
            label={t("admin.movement.kpi.exits")}
            value={formatNumber(live.data?.exits ?? 0)}
            hint={t("admin.movement.kpi.exitsHint")}
            to={withFilters("/admin/people/exits", filters)}
          />
          <KpiTile
            label={t("admin.movement.kpi.net")}
            value={formatNumber((live.data?.joiners ?? 0) - (live.data?.exits ?? 0))}
            hint={t("admin.movement.kpi.netHint")}
            tone={(live.data?.joiners ?? 0) - (live.data?.exits ?? 0) < 0 ? "warn" : undefined}
            to={withFilters("/admin/people/lifecycle", filters)}
          />
          <KpiTile
            label={t("admin.movement.kpi.avgHeadcount")}
            // One decimal: a mean of integers is not an integer, and rounding it
            // to one would make the attrition arithmetic below fail to reproduce.
            value={dash(snapshot?.series.avgHeadcount ?? null, (n) => n.toFixed(1))}
            hint={t("admin.movement.kpi.avgHeadcountHint", {
              days: formatNumber(snapshot?.series.coveredDays ?? 0),
            })}
          />
          <KpiTile
            label={t("admin.movement.kpi.attrition")}
            value={formatPercent(attrition?.periodPct ?? null)}
            hint={t("admin.movement.attrition.window", {
              days: formatNumber(attrition?.windowDays ?? 0),
            })}
            explainer={{
              formula: t("admin.movement.attrition.formula"),
              numbers: attritionNumbers(attrition),
            }}
          />
          <KpiTile
            label={t("admin.movement.kpi.attritionAnnualised")}
            value={formatPercent(attrition?.annualisedPct ?? null)}
            hint={annualisedHint(attrition)}
            explainer={{
              formula: t("admin.movement.attrition.formula"),
              numbers: attritionNumbers(attrition),
            }}
          />
        </div>

        {/* ── The formula, on screen, next to the number it produced. ──────── */}
        <div className="mt-3 rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium">{t("admin.movement.attrition.title")}</h3>
          <p className="num mt-1.5 text-sm">{t("admin.movement.attrition.formula")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{attritionNumbers(attrition)}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">{annualisedHint(attrition)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.movement.attrition.sourceNote")}
          </p>
        </div>

        {/* ── Two charts, one x domain. Never one chart with two y axes. ───── */}
        {hasSeries ? (
          <div className="mt-4 grid gap-4">
            <div className="rounded-lg border bg-card p-4">
              <h3 className="mb-3 text-sm font-medium">
                {t("admin.movement.chart.levelTitle")}
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  {/* Not zero-based: headcount moves by single digits against a
                      base of hundreds, and a 0-anchored axis flattens every
                      change this chart exists to show. */}
                  <YAxis tick={{ fontSize: 11 }} domain={["auto", "auto"]} width={44} />
                  <Tooltip />
                  {/* One series, so no legend box — the heading names it. */}
                  <Line
                    type="monotone"
                    dataKey="headcount"
                    name={t("admin.movement.chart.headcount")}
                    stroke={JOINERS_COLOUR}
                    strokeWidth={2}
                    dot={false}
                    // A day the snapshot does not hold must LOOK like a hole.
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="rounded-lg border bg-card p-4">
              <h3 className="text-sm font-medium">{t("admin.movement.chart.movementTitle")}</h3>
              <p className="mb-3 mt-1 text-xs text-muted-foreground">
                {t("admin.movement.chart.movementHint")}
              </p>
              <ResponsiveContainer width="100%" height={180}>
                {/* Grouped, never stacked: joiners plus exits is not a quantity
                    anybody wants, and stacking would invite reading it as one. */}
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={44} />
                  <Tooltip />
                  <Legend />
                  <Bar
                    dataKey="joiners"
                    name={t("admin.movement.chart.joiners")}
                    fill={JOINERS_COLOUR}
                  />
                  <Bar dataKey="exits" name={t("admin.movement.chart.exits")} fill={EXITS_COLOUR} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <Notice tone="info" className="mt-4">
            {t("admin.movement.chart.noSeries")}
          </Notice>
        )}

        {/* ── By department. Also the table view of the two charts above. ──── */}
        <div className="mt-4 rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium">{t("admin.movement.dept.title")}</h3>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">
            {t("admin.movement.dept.hint")}
          </p>
          <DataGrid
            columns={departmentColumns()}
            rows={snapshot?.departments ?? []}
            rowKey={(r) => r.departmentId ?? UNASSIGNED_KEY}
            loading={series.isLoading}
            pageSize={10}
            onRowClick={(r) => {
              if (r.departmentId === null) return;
              void navigate(
                withFilters("/admin/analytics/workforce", {
                  ...filters,
                  departmentId: r.departmentId,
                }),
              );
            }}
          />
        </div>

        {/* ═══ WATCHLISTS — the part that is work ═════════════════════════ */}
        <div className="mb-3 mt-8">
          <h2 className="font-display text-lg font-semibold">
            {t("admin.movement.watch.heading")}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("admin.movement.watch.headingHint")}
          </p>
        </div>

        <div className="grid gap-4">
          <WatchCard
            icon={UserCheck}
            title={t("admin.movement.probation.title")}
            hint={t("admin.movement.probation.hint", { to: fmtCivilDate(period.to) })}
            count={probation.data?.rows.length ?? 0}
            total={probation.data?.total ?? 0}
            truncated={probation.data?.truncated ?? false}
          >
            <DataGrid
              columns={probationColumns()}
              rows={probation.data?.rows ?? []}
              rowKey={(r) => r.employee.id}
              loading={probation.isLoading}
              pageSize={10}
              onRowClick={(r) => openEmployee(r.employee.employee_code)}
              emptyState={
                <EmptyState
                  icon={UserCheck}
                  title={t("admin.movement.probation.title")}
                  hint={t("admin.movement.probation.empty")}
                />
              }
            />
          </WatchCard>

          <WatchCard
            icon={FileWarning}
            title={t("admin.movement.contract.title")}
            hint={t("admin.movement.contract.hint", {
              from: fmtCivilDate(period.from),
              to: fmtCivilDate(period.to),
              lookahead: formatNumber(CONTRACT_LOOKAHEAD_DAYS),
            })}
            count={contracts.data?.rows.length ?? 0}
            total={contracts.data?.total ?? 0}
            truncated={contracts.data?.truncated ?? false}
          >
            <DataGrid
              columns={contractColumns()}
              rows={contracts.data?.rows ?? []}
              rowKey={(r) => r.employee.id}
              loading={contracts.isLoading}
              pageSize={10}
              onRowClick={(r) => openEmployee(r.employee.employee_code)}
              emptyState={
                <EmptyState
                  icon={FileWarning}
                  title={t("admin.movement.contract.title")}
                  hint={t("admin.movement.contract.empty")}
                />
              }
            />
          </WatchCard>

          <WatchCard
            icon={CalendarClock}
            title={t("admin.movement.notice.title")}
            hint={t("admin.movement.notice.hint", { today: fmtCivilDate(today) })}
            count={notice.data?.rows.length ?? 0}
            total={notice.data?.total ?? 0}
            truncated={notice.data?.truncated ?? false}
          >
            <DataGrid
              columns={noticeColumns()}
              rows={notice.data?.rows ?? []}
              rowKey={(r) => r.employee.id}
              loading={notice.isLoading}
              pageSize={10}
              onRowClick={(r) => openEmployee(r.employee.employee_code)}
              emptyState={
                <EmptyState
                  icon={CalendarClock}
                  title={t("admin.movement.notice.title")}
                  hint={t("admin.movement.notice.empty")}
                />
              }
            />
          </WatchCard>

          <WatchCard
            icon={LogOut}
            title={t("admin.movement.exits.title")}
            hint={t("admin.movement.exits.hint", {
              from: fmtCivilDate(period.from),
              to: fmtCivilDate(period.to),
              exits: formatNumber(exits.data?.quality.exits ?? 0),
            })}
            count={exits.data?.rows.length ?? 0}
            total={exits.data?.total ?? 0}
            truncated={exits.data?.truncated ?? false}
          >
            {exits.data !== undefined && exits.data.quality.exits > 0 ? (
              <ExitQualityBlock quality={exits.data.quality} />
            ) : null}
            <DataGrid
              columns={exitColumns()}
              rows={exits.data?.rows ?? []}
              rowKey={(r) => r.id}
              loading={exits.isLoading}
              pageSize={10}
              onRowClick={(r) => openEmployee(r.employee_code)}
              emptyState={
                <EmptyState
                  icon={LogOut}
                  title={t("admin.movement.exits.title")}
                  hint={t("admin.movement.exits.empty")}
                />
              }
            />
          </WatchCard>
        </div>

        {/* ── Where every figure came from. ───────────────────────────────── */}
        {snapshot !== undefined ? (
          <AnalyticsCaveats provenance={snapshot.provenance} className="mt-4" />
        ) : null}
        {snapshot !== undefined ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("admin.movement.basis", {
              relation: snapshot.provenance.relation,
              rows: formatNumber(snapshot.provenance.rowsScanned),
              employeeRelation: exits.data?.provenance.relation ?? "v_admin_employee",
            })}
          </p>
        ) : null}
      </StateBoundary>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Staleness
// -----------------------------------------------------------------------------

/**
 * The "as of" line, and the warning when the period runs past the snapshot.
 *
 * Two separate sentences on purpose: the first is always true and always shown,
 * the second only when part of the period is genuinely missing from the series.
 * Folding them into one would either cry wolf every night or bury the day the
 * matview stopped refreshing.
 */
function SnapshotBanner({
  result,
}: {
  result: { stamp: { as_of_date: string; refreshed_at: string } | null; daysBeyondSnapshot: number; provenance: { relation: string } };
}) {
  const stamp = result.stamp;
  return (
    <div className="mb-3 space-y-2">
      <Notice tone="info">
        {stamp === null
          ? t("admin.movement.asOfUnknown")
          : t("admin.movement.asOf", {
              relation: result.provenance.relation,
              through: fmtCivilDate(stamp.as_of_date),
              refreshed: fmtDateTime(stamp.refreshed_at),
            })}
      </Notice>
      {stamp !== null && result.daysBeyondSnapshot > 0 ? (
        <Notice tone="warning">
          {t("admin.movement.snapshotBehind", {
            through: fmtCivilDate(stamp.as_of_date),
            days: formatNumber(result.daysBeyondSnapshot),
          })}
        </Notice>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Attrition copy — the formula with THIS period's numbers in it
// -----------------------------------------------------------------------------

function attritionNumbers(rate: AttritionRate | undefined): string {
  if (rate === undefined || rate.avgHeadcount === null) {
    return t("admin.movement.attrition.noDenominator");
  }
  return t("admin.movement.attrition.numbers", {
    exits: formatNumber(rate.exits),
    avg: rate.avgHeadcount.toFixed(1),
    pct: formatPercent(rate.periodPct),
    days: formatNumber(rate.windowDays),
  });
}

/**
 * Either the annualisation factor, or the reason there isn't one. Never blank —
 * an empty hint under an em dash reads as a broken tile rather than a deliberate
 * refusal.
 */
function annualisedHint(rate: AttritionRate | undefined): string {
  if (rate === undefined || rate.periodPct === null) {
    return t("admin.movement.attrition.noDenominator");
  }
  if (rate.annualiseFactor !== null) {
    return t("admin.movement.attrition.annualisedLabel", {
      factor: rate.annualiseFactor.toFixed(1),
      days: formatNumber(rate.windowDays),
    });
  }
  const hypothetical = hypotheticalAnnualiseFactor(rate.windowDays);
  return t("admin.movement.attrition.tooShort", {
    days: formatNumber(rate.windowDays),
    factor: hypothetical === null ? "—" : hypothetical.toFixed(0),
  });
}

// -----------------------------------------------------------------------------
// Watchlist card
// -----------------------------------------------------------------------------

interface WatchCardProps {
  readonly icon: typeof Users;
  readonly title: string;
  readonly hint: string;
  /** Rows actually rendered. */
  readonly count: number;
  /** Cardinality of the predicate — differs from `count` only when capped. */
  readonly total: number;
  readonly truncated: boolean;
  readonly children: React.ReactNode;
}

function WatchCard({ icon: Icon, title, hint, count, total, truncated, children }: WatchCardProps) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          {title}
        </h3>
        <span className="num text-lg font-semibold">{formatNumber(count)}</span>
      </div>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">{hint}</p>
      {truncated ? (
        <Notice tone="warning" className="mb-3">
          {t("admin.movement.watch.truncated", {
            shown: formatNumber(count),
            total: formatNumber(total),
          })}
        </Notice>
      ) : null}
      {children}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Exit quality
// -----------------------------------------------------------------------------

/**
 * The three rates every exit register is judged on, each with its denominator
 * printed, plus the exit-type breakdown as recorded.
 *
 * `is_rehire_eligible` is a NULLABLE boolean and all three states are shown.
 * Folding "not yet decided" into "not eligible" would put people on a
 * do-not-rehire list that nobody ever put them on.
 */
function ExitQualityBlock({
  quality,
}: {
  quality: {
    exits: number;
    byType: readonly { exitType: string | null; exits: number }[];
    interviewDone: number;
    rehireEligible: number;
    rehireNotEligible: number;
    rehireUndecided: number;
    settled: number;
    settlementPending: number;
  };
}) {
  return (
    <div className="mb-4">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("admin.movement.quality.title")}
      </h4>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("admin.movement.quality.denominator", { exits: formatNumber(quality.exits) })}
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label={t("admin.movement.quality.interviewDone")}
          value={formatPercent((quality.interviewDone / quality.exits) * 100)}
          hint={t("admin.movement.quality.interviewHint", {
            done: formatNumber(quality.interviewDone),
            exits: formatNumber(quality.exits),
          })}
          tone={quality.interviewDone < quality.exits ? "warn" : "success"}
        />
        <KpiTile
          label={t("admin.movement.quality.rehire")}
          value={formatPercent((quality.rehireEligible / quality.exits) * 100)}
          hint={t("admin.movement.quality.rehireHint", {
            yes: formatNumber(quality.rehireEligible),
            no: formatNumber(quality.rehireNotEligible),
            undecided: formatNumber(quality.rehireUndecided),
            exits: formatNumber(quality.exits),
          })}
        />
        <KpiTile
          label={t("admin.movement.quality.settled")}
          value={formatPercent((quality.settled / quality.exits) * 100)}
          hint={t("admin.movement.quality.settledHint", {
            settled: formatNumber(quality.settled),
            pending: formatNumber(quality.settlementPending),
          })}
          tone={quality.settlementPending > 0 ? "warn" : "success"}
        />
      </div>

      <h4 className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("admin.movement.quality.typeTitle")}
      </h4>
      {/* A single-series horizontal bar per recorded exit type. One colour,
          because identity is carried by the axis label, not by a hue nobody
          asked for — and six types would exceed the palette's honest ceiling. */}
      <ResponsiveContainer width="100%" height={Math.max(120, quality.byType.length * 34)}>
        <BarChart
          data={quality.byType.map((row) => ({
            name: exitTypeLabel(row.exitType),
            exits: row.exits,
          }))}
          layout="vertical"
          margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
          <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
          <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar dataKey="exits" name={t("admin.movement.kpi.exits")} fill={EXITS_COLOUR} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The CHECK-constraint value never reaches a screen (D-10); NULL is named. */
function exitTypeLabel(exitType: string | null): string {
  if (exitType === null) return t("admin.movement.quality.typeUnrecorded");
  return isExitType(exitType) ? EXIT_TYPE_LABELS[exitType] : exitType;
}

// -----------------------------------------------------------------------------
// Grid columns
// -----------------------------------------------------------------------------

function departmentColumns(): DataGridColumn<MovementDepartmentRow>[] {
  return [
    {
      key: "department",
      header: t("admin.movement.dept.col.department"),
      render: (r) => r.departmentName ?? t("admin.movement.dept.unassigned"),
      sortable: true,
      sortValue: (r) => r.departmentName ?? "",
    },
    {
      key: "joiners",
      header: t("admin.movement.dept.col.joiners"),
      align: "right",
      sortable: true,
      render: (r) => formatNumber(r.joiners),
      sortValue: (r) => r.joiners,
    },
    {
      key: "exits",
      header: t("admin.movement.dept.col.exits"),
      align: "right",
      sortable: true,
      render: (r) => formatNumber(r.exits),
      sortValue: (r) => r.exits,
    },
    {
      key: "net",
      header: t("admin.movement.dept.col.net"),
      align: "right",
      hideBelow: "sm",
      sortable: true,
      render: (r) => (
        <span className={r.netChange < 0 ? "text-warning" : undefined}>
          {formatNumber(r.netChange)}
        </span>
      ),
      sortValue: (r) => r.netChange,
    },
    {
      key: "avgHeadcount",
      header: t("admin.movement.dept.col.avgHeadcount"),
      align: "right",
      hideBelow: "md",
      sortable: true,
      render: (r) => dash(r.avgHeadcount, (n) => n.toFixed(1)),
      sortValue: (r) => r.avgHeadcount,
    },
    {
      key: "attrition",
      header: t("admin.movement.dept.col.attrition"),
      align: "right",
      hideBelow: "md",
      sortable: true,
      render: (r) => formatPercent(r.attrition.periodPct),
      sortValue: (r) => r.attrition.periodPct,
    },
  ];
}

/**
 * The person + department cells every watchlist opens with.
 *
 * Generic over the watchlist row rather than duplicated three times, and
 * constrained on `MovementEmployeeRow` — the structural shape the PURE module
 * emits — so a column set cannot quietly start depending on a column the
 * aggregate does not carry.
 */
function personColumn<T extends { employee: MovementEmployeeRow }>(): DataGridColumn<T> {
  return {
    key: "person",
    header: t("admin.movement.watch.col.person"),
    render: (r) => (
      <PersonCell
        name={r.employee.display_name}
        code={r.employee.employee_code}
        secondary={r.employee.designation_name}
      />
    ),
    sortable: true,
    sortValue: (r) => r.employee.display_name,
  };
}

function departmentColumn<T extends { employee: MovementEmployeeRow }>(): DataGridColumn<T> {
  return {
    key: "department",
    header: t("admin.movement.watch.col.department"),
    hideBelow: "md",
    render: (r) => dash(r.employee.department_name),
    sortable: true,
    sortValue: (r) => r.employee.department_name ?? "",
  };
}

function probationColumns(): DataGridColumn<ProbationWatchRow>[] {
  return [
    personColumn<ProbationWatchRow>(),
    departmentColumn<ProbationWatchRow>(),
    {
      key: "joined",
      header: t("admin.movement.probation.col.joined"),
      hideBelow: "lg",
      render: (r) => fmtCivilDate(r.employee.date_of_join),
      sortable: true,
      sortValue: (r) => r.employee.date_of_join ?? "",
    },
    {
      key: "probation",
      header: t("admin.movement.probation.col.probation"),
      hideBelow: "lg",
      align: "right",
      render: (r) =>
        t("admin.movement.probation.months", { months: formatNumber(r.employee.probation_months) }),
      sortable: true,
      sortValue: (r) => r.employee.probation_months,
    },
    {
      key: "dueOn",
      header: t("admin.movement.probation.col.dueOn"),
      render: (r) => fmtCivilDate(r.dueOn),
      sortable: true,
      sortValue: (r) => r.dueOn,
    },
    {
      key: "overdue",
      header: t("admin.movement.probation.col.overdue"),
      align: "right",
      // The whole reason this list is sorted the way it is: an overdue
      // confirmation is a decision somebody is already late on.
      render: (r) =>
        r.isOverdue ? (
          <span className="text-destructive">
            {t("admin.movement.probation.overdueDays", {
              days: formatNumber(Math.abs(r.daysUntilDue)),
            })}
          </span>
        ) : r.daysUntilDue === 0 ? (
          <span className="text-warning">{t("admin.movement.probation.dueToday")}</span>
        ) : (
          <span className="text-muted-foreground">
            {t("admin.movement.probation.dueInDays", { days: formatNumber(r.daysUntilDue) })}
          </span>
        ),
      sortable: true,
      sortValue: (r) => r.daysUntilDue,
    },
    statusColumn<ProbationWatchRow>(),
  ];
}

/** Employment status as a chip — the raw enum value never reaches a cell (D-10). */
function statusColumn<T extends { employee: MovementEmployeeRow }>(): DataGridColumn<T> {
  return {
    key: "status",
    header: t("admin.movement.watch.col.status"),
    hideBelow: "lg",
    render: (r) => <EmploymentStatusChip status={r.employee.employment_status} />,
    sortable: true,
    sortValue: (r) => r.employee.employment_status,
  };
}

/** The enum is mapped to its label; an unmapped value falls back rather than throwing. */
function EmploymentStatusChip({ status }: { status: string }) {
  const parsed = employmentStatusSchema.safeParse(status);
  const label = parsed.success ? EMPLOYMENT_STATUS_LABELS[parsed.data] : status;
  return <StatusChip status={status} map={{ [status]: { label, tone: "neutral" } }} />;
}

function contractColumns(): DataGridColumn<ContractWatchRow>[] {
  return [
    personColumn<ContractWatchRow>(),
    departmentColumn<ContractWatchRow>(),
    {
      key: "endsOn",
      header: t("admin.movement.contract.col.endsOn"),
      render: (r) => fmtCivilDate(r.endsOn),
      sortable: true,
      sortValue: (r) => r.endsOn,
    },
    {
      key: "remaining",
      header: t("admin.movement.contract.col.remaining"),
      align: "right",
      render: (r) =>
        r.hasExpired ? (
          <span className="text-destructive">
            {t("admin.movement.contract.expired", {
              days: formatNumber(Math.abs(r.daysUntilEnd)),
            })}
          </span>
        ) : r.daysUntilEnd === 0 ? (
          <span className="text-warning">{t("admin.movement.contract.expiresToday")}</span>
        ) : (
          <span className={r.daysUntilEnd <= 14 ? "text-warning" : "text-muted-foreground"}>
            {t("admin.movement.contract.inDays", { days: formatNumber(r.daysUntilEnd) })}
          </span>
        ),
      sortable: true,
      sortValue: (r) => r.daysUntilEnd,
    },
    {
      key: "manager",
      header: t("admin.movement.watch.col.manager"),
      hideBelow: "lg",
      render: (r) => dash(r.employee.reporting_manager_name),
    },
  ];
}

function noticeColumns(): DataGridColumn<NoticeWatchRow>[] {
  return [
    personColumn<NoticeWatchRow>(),
    departmentColumn<NoticeWatchRow>(),
    {
      key: "resigned",
      header: t("admin.movement.notice.col.resigned"),
      hideBelow: "lg",
      render: (r) => fmtCivilDate(r.resignedOn),
      sortable: true,
      sortValue: (r) => r.resignedOn,
    },
    {
      key: "lastDay",
      header: t("admin.movement.notice.col.lastDay"),
      render: (r) => fmtCivilDate(r.lastWorkingDay),
      sortable: true,
      sortValue: (r) => r.lastWorkingDay,
    },
    {
      key: "remaining",
      header: t("admin.movement.notice.col.remaining"),
      align: "right",
      render: (r) => (
        <span className={r.daysRemaining <= 7 ? "text-warning" : undefined}>
          {t("admin.movement.notice.days", { days: formatNumber(r.daysRemaining) })}
        </span>
      ),
      sortable: true,
      sortValue: (r) => r.daysRemaining,
    },
    {
      key: "policy",
      header: t("admin.movement.notice.col.policy"),
      align: "right",
      hideBelow: "md",
      render: (r) =>
        t("admin.movement.notice.days", {
          days: formatNumber(r.employee.notice_period_days),
        }),
      sortValue: (r) => r.employee.notice_period_days,
    },
    {
      key: "shortfall",
      header: t("admin.movement.notice.col.shortfall"),
      align: "right",
      hideBelow: "md",
      // Serving MORE than the policy is not a shortfall and is not shown as a
      // negative number pretending to be one.
      render: (r) =>
        r.noticeShortfallDays > 0 ? (
          <span className="text-destructive">
            {t("admin.movement.notice.shortfallDays", {
              days: formatNumber(r.noticeShortfallDays),
            })}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("admin.movement.notice.noShortfall")}</span>
        ),
      sortable: true,
      sortValue: (r) => r.noticeShortfallDays,
    },
  ];
}

function exitColumns(): DataGridColumn<MovementEmployee>[] {
  return [
    {
      key: "person",
      header: t("admin.movement.watch.col.person"),
      render: (r) => (
        <PersonCell name={r.display_name} code={r.employee_code} secondary={r.designation_name} />
      ),
      sortable: true,
      sortValue: (r) => r.display_name,
    },
    {
      key: "department",
      header: t("admin.movement.watch.col.department"),
      hideBelow: "md",
      render: (r) => dash(r.department_name),
      sortable: true,
      sortValue: (r) => r.department_name ?? "",
    },
    {
      key: "lastDay",
      header: t("admin.movement.exits.col.lastDay"),
      render: (r) => fmtCivilDate(r.last_working_day),
      sortable: true,
      sortValue: (r) => r.last_working_day ?? "",
    },
    {
      key: "type",
      header: t("admin.movement.exits.col.type"),
      render: (r) => exitTypeLabel(r.exit_type),
      sortable: true,
      sortValue: (r) => r.exit_type ?? "",
    },
    {
      key: "reason",
      header: t("admin.movement.exits.col.reason"),
      hideBelow: "lg",
      render: (r) => dash(r.exit_reason),
    },
    {
      key: "interview",
      header: t("admin.movement.exits.col.interview"),
      hideBelow: "md",
      render: (r) =>
        r.exit_interview_done ? (
          <StatusChip status="done" map={{ done: { label: t("admin.movement.quality.interviewDone"), tone: "success" } }} />
        ) : (
          <StatusChip
            status="pending"
            map={{ pending: { label: t("admin.movement.quality.interviewPending"), tone: "warn" } }}
          />
        ),
    },
    {
      key: "rehire",
      header: t("admin.movement.exits.col.rehire"),
      hideBelow: "lg",
      // Three states, three chips. NULL is "not decided", never "not eligible".
      render: (r) =>
        r.is_rehire_eligible === true ? (
          <StatusChip status="yes" map={{ yes: { label: t("admin.movement.quality.rehireYes"), tone: "success" } }} />
        ) : r.is_rehire_eligible === false ? (
          <StatusChip status="no" map={{ no: { label: t("admin.movement.quality.rehireNo"), tone: "danger" } }} />
        ) : (
          <StatusChip
            status="undecided"
            map={{ undecided: { label: t("admin.movement.quality.rehireUndecided"), tone: "neutral" } }}
          />
        ),
    },
    {
      key: "settlement",
      header: t("admin.movement.exits.col.settlement"),
      hideBelow: "md",
      render: (r) =>
        r.full_and_final_settled_on === null ? (
          <StatusChip
            status="pending"
            map={{ pending: { label: t("admin.movement.quality.settlementPending"), tone: "warn" } }}
          />
        ) : (
          fmtCivilDate(r.full_and_final_settled_on)
        ),
      sortable: true,
      sortValue: (r) => r.full_and_final_settled_on ?? "",
    },
  ];
}
