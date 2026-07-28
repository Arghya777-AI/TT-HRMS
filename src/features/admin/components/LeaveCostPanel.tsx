/**
 * LeaveCostPanel — what leave the company owes, what was taken, what is about to
 * lapse, and what payroll cost. Seven blocks over six relations, all narrowed by the
 * one `AnalyticsFilters` already in the URL.
 *
 * SIX THINGS THIS PANEL REFUSES TO DO, each of which is why a block below looks the
 * way it does:
 *
 *  1. IT WILL NOT PUT A RUPEE SIGN ON LEAVE LIABILITY. `LeaveLiability.liabilityPaise`
 *     is typed `null` by construction — no relation this panel reads carries a
 *     per-employee daily rate, and picking a basis (gross ÷ 26? ÷ period days? basic
 *     only?) would manufacture a figure nobody could check. The headline is a DAY
 *     count, every day tile says "days" in the value itself, and the caveat says so in
 *     words. Paid and unpaid types are separate tiles: an unpaid balance costs nothing
 *     to honour, so adding them would overstate the obligation.
 *  2. IT WILL NOT DRAW THE DENSITY CHART ON A CAPPED READ. Zero-filling empty dates is
 *     honest here and nowhere else in this product — `v_leave_calendar` has a row only
 *     when somebody is on leave, so a date with no rows is a real zero. That argument
 *     collapses the moment the read truncates, because an empty date could then be a
 *     date whose rows the cap cut off. The chart is replaced by the reason it is gone.
 *  3. IT WILL NOT STACK A SUBSET ON ITS SUPERSET. "Approved" people are part of "people
 *     off", so the two density series are grouped bars, never stacked — a stack would
 *     draw a total nobody counted. Same rule on the cost chart: its two segments are
 *     gross and employer cost, whose sum IS the §9.2 definition of payroll cost, so
 *     the bar's height is that total drawn rather than a second total computed.
 *  4. IT WILL NOT SEGMENT A MONTH BY DEPARTMENT. The validated palette carries four
 *     honestly separable series; a venue with nine departments would lose five of them
 *     and the bar would come out shorter than the month cost. Departments get a ranked
 *     chart of their own, where every one of them fits.
 *  5. IT WILL NOT COUNT COMP-OFF EXPIRY AS A STATISTIC. Expiring credits are work
 *     somebody owes this week, so that block is a named list with expiry dates and a
 *     row that opens the person's comp-off ledger — sorted the way it gets worked,
 *     soonest expiry first.
 *  6. IT WILL NOT SHOW EMPTY COST TILES TO SOMEBODY WHO MAY NOT SEE COST. The gate is
 *     `can("admin.access")` — the capability `route-manifest.ts` maps every payroll
 *     route to, the same one `useHrPayrollCost` takes as its `enabled` flag. Without
 *     it the two reads never fire and the tiles are absent, because "₹0" reads as "this
 *     venue spent nothing" when the truth is "cost is not yours to see". The real gate
 *     is `app.is_admin()` inside both views; this is the UX half.
 *
 * WHERE THE CAVEATS ARE PRINTED. `AnalyticsProvenance.caveats` mixes two kinds: the
 * SCOPE's (the source filter cannot reach these relations, this department is too
 * large to name) which are identical on all six blocks, and the BLOCK's (liability is
 * in days, cost is monthly) which belong beside their own figures. Printing all of
 * them under all six blocks would repeat the same four sentences six times and bury
 * the one that matters, so they are split: scope notes once at the top, block notes
 * under the block.
 */
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Banknote,
  CalendarDays,
  HeartHandshake,
  Layers,
  Lock,
  Scale,
  TrendingUp,
} from "lucide-react";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { Money } from "@/shared/ui/Money";
import { StatusChip } from "@/shared/ui/StatusChip";
import { useAuth } from "@/app/auth/AuthProvider";
import { dash, formatDays, formatDaysFixed, formatNumber, formatPercent } from "@/lib/format";
import { formatPaise } from "@/lib/money";
import { fmtCivilDate, fmtCivilMonth, fmtDateTime } from "@/lib/datetime";
import { periodFor } from "@/lib/period";
import { t, type MessageKey } from "@/shared/i18n/en";
import { withFilters, type AnalyticsFilters } from "@/lib/analyticsFilters";
import type { ExportColumn } from "@/lib/exportReport";
import { CHART_GRID, seriesColour } from "../analytics-ops-palette";
import { LEDGER_ENTRY_CHIP } from "../leave-config-vocab";
import { AnalyticsFilterBar } from "./AnalyticsFilterBar";
import { AnalyticsExportButtons } from "./AnalyticsExportButtons";
import { RankedBarsChart, StackedBarsChart, type ChartPoint } from "./AnalyticsOpsCharts";
import { Notice, type NoticeTone } from "./Notice";
import { PersonCell } from "./PersonCell";
import { useAnalyticsFilterOptions } from "../hooks/useAnalytics";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";
import { useEmployeeLabels, type EmployeeLabelMap } from "../hooks/useEmployeeLabels";
import {
  useCompOffExpiry,
  useHrPayrollCost,
  useHrPayrollVariance,
  useLeaveCalendarPage,
  useLeaveLiability,
  useLeaveMovement,
} from "../hooks/useHrLeaveCost";
import {
  DEFAULT_BUSIEST_DATES,
  DEFAULT_MOVER_COUNT,
  VARIANCE_FLAG_PCT,
  type CompOffExpiryEntry,
  type CostCell,
  type LeaveDensityPoint,
  type LeaveTakenByDepartment,
  type LeaveTakenByType,
  type LeaveTypeBalance,
  type LedgerMovementRow,
  type VarianceMover,
} from "../api/hr-leavecost.api";
import type { AnalyticsProvenance } from "../api/analytics.api";

/**
 * Bars past this are not drawn. Fourteen is the same ceiling `WorkforcePanel` uses for
 * the same reason — sixty 4px bars communicate nothing — and the caption states how
 * many groups were left off so a top-N never reads as the whole organisation.
 */
const MAX_BARS = 14;

/** The null-department bucket needs a stable, collision-proof grid key. */
const UNASSIGNED_KEY = " unassigned";

/**
 * Caveats produced by `resolveLeaveCostScope` rather than by one relation's read.
 * These are identical on all six blocks, so they are printed ONCE above everything.
 * Anything not in here is specific to the block that reported it.
 */
const SCOPE_CAVEATS: ReadonlySet<string> = new Set<string>([
  "hr.leavecost.caveat.sourceNotApplicable",
  "hr.leavecost.caveat.departmentEmpty",
  "hr.leavecost.caveat.departmentTooLarge",
  "hr.leavecost.caveat.ledgerDepartmentAsAtToday",
]);

/**
 * Tone per caveat, keyed by string rather than `MessageKey`: a mapped type over the
 * ten-thousand-key catalogue is a real typecheck cost for a four-entry lookup (the
 * same trade `AnalyticsCaveats` makes). Unlisted keys read as information.
 *
 * The four warnings are the ones that mean a figure is INCOMPLETE rather than merely
 * qualified — a capped read, a capped month window, and the two blocked-department
 * cases where a block is empty instead of silently org-wide.
 */
const CAVEAT_TONE: Readonly<Record<string, NoticeTone>> = {
  "hr.leavecost.caveat.truncated": "warning",
  "hr.leavecost.caveat.costMonthsCapped": "warning",
  "hr.leavecost.caveat.departmentEmpty": "warning",
  "hr.leavecost.caveat.departmentTooLarge": "warning",
};

/** A day count as a tile value, with its unit attached so it cannot read as rupees. */
const daysValue = (days: number | null): string =>
  days === null ? dash(null) : t("hr.leavecost.days", { days: formatDays(days) });

const daysCell = (days: number | null): string => formatDays(days);

const paiseFormat = (value: number | null): string => formatPaise(value);
const paiseTick = (value: number | null): string => formatPaise(value, { paise: false });
const dayFormat = (value: number | null): string => formatDays(value);

export interface LeaveCostPanelProps {
  /**
   * Render this panel's own filter bar. FALSE when embedded under a surface that
   * already renders one over the same URL filters — see `WorkforcePanelProps`. The
   * `locationNotApplicable` note below is produced from `filters.locationId`
   * regardless of which bar set it, so a host bar that DOES offer location still
   * gets told here that this panel narrowed nothing by it.
   */
  readonly showFilterBar?: boolean;
}

export function LeaveCostPanel({ showFilterBar = true }: LeaveCostPanelProps = {}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { filters } = useAnalyticsFilters();
  const { can } = useAuth();

  /**
   * THE PAYROLL GATE. Not a new capability: `route-manifest.ts` maps every payroll
   * route (tier A and A/S alike — no payroll row is tier S) to `admin.access`, and
   * `useHrPayrollCost` already takes it as an `enabled` flag. Passing it here keeps the
   * two reads out of the cache entirely for a user without it, so nothing can later be
   * mistaken for a genuine zero.
   */
  const canSeeCost = can("admin.access");

  const options = useAnalyticsFilterOptions();
  const employeeLabels = useEmployeeLabels();

  const liability = useLeaveLiability(filters);
  const calendar = useLeaveCalendarPage(filters);
  const compOff = useCompOffExpiry(filters);
  const movement = useLeaveMovement(filters);
  const cost = useHrPayrollCost(filters, canSeeCost);
  // The pay periods come FROM the cost read, which is what guarantees the variance
  // block and the cost block describe the same run even if a rerun is released
  // mid-session. Undefined (not []) while cost is in flight keeps the query disabled.
  const variance = useHrPayrollVariance(filters, cost.data?.cost.payPeriodIds, canSeeCost);

  const labels = employeeLabels.data;

  /** Narrow the panel in place, so Back undoes exactly one drill. */
  const drillTo = (next: AnalyticsFilters): void => {
    void navigate(withFilters(pathname, next));
  };

  /** Leave the panel for a console screen, carrying the period and dimensions along. */
  const openWithFilters = (path: string, next: AnalyticsFilters = filters): void => {
    void navigate(withFilters(path, next));
  };

  const departmentName = useMemo(() => {
    if (filters.departmentId === undefined) return undefined;
    return (options.data?.departments ?? []).find((d) => d.id === filters.departmentId)?.name;
  }, [options.data, filters.departmentId]);

  const employeeName =
    filters.employeeId === undefined ? undefined : labels?.get(filters.employeeId)?.name;

  /**
   * Every scope caveat any block reported, deduplicated, plus the one the data layer
   * cannot report: `AnalyticsFilters.locationId` is never read by
   * `resolveLeaveCostScope`, so a `loc` in the address bar silently narrows nothing.
   * The bar hides that dimension, which means only a hand-edited URL gets here — and
   * that is exactly when an unhonoured filter has to be said out loud.
   */
  const scopeNotes = useMemo<MessageKey[]>(() => {
    const seen = new Set<string>();
    const out: MessageKey[] = [];
    if (filters.locationId !== undefined) {
      out.push("hr.leavecost.caveat.locationNotApplicable");
      seen.add("hr.leavecost.caveat.locationNotApplicable");
    }
    const sources: readonly (AnalyticsProvenance | undefined)[] = [
      liability.data?.provenance,
      calendar.data?.provenance,
      compOff.data?.provenance,
      movement.data?.provenance,
      cost.data?.provenance,
      variance.data?.provenance,
    ];
    for (const provenance of sources) {
      for (const key of provenance?.caveats ?? []) {
        if (SCOPE_CAVEATS.has(key) && !seen.has(key)) {
          seen.add(key);
          out.push(key);
        }
      }
    }
    return out;
  }, [
    filters.locationId,
    liability.data,
    calendar.data,
    compOff.data,
    movement.data,
    cost.data,
    variance.data,
  ]);

  const taken = calendar.data?.taken;
  const density = calendar.data?.density;
  const summary = compOff.data?.summary;
  const ledger = movement.data?.movement;
  const costData = cost.data?.cost;
  const costWindow = cost.data?.window;
  const varianceData = variance.data?.variance;

  // ── Chart points ─────────────────────────────────────────────────────────────
  const takenTypePoints = useMemo<ChartPoint[]>(
    () =>
      (taken?.byType ?? []).slice(0, MAX_BARS).map((row) => ({
        x: row.leaveTypeName,
        // The code, not the position: a re-ordered chart must not label the wrong type.
        id: row.leaveTypeCode,
        values: { days: row.days, people: row.employees },
      })),
    [taken],
  );

  const takenDeptPoints = useMemo<ChartPoint[]>(
    () =>
      (taken?.byDepartment ?? []).slice(0, MAX_BARS).map((row) => ({
        x: row.departmentName ?? t("hr.leavecost.unassigned"),
        // Empty string for the unassigned bucket — there is no uuid to filter on, so
        // the drill is declined below rather than opening a broken link.
        id: row.departmentId ?? "",
        values: { days: row.days, people: row.employees },
      })),
    [taken],
  );

  const densityRows = useMemo(
    () =>
      (density?.points ?? []).map((point) => ({
        date: point.istDate.slice(5),
        headcount: point.headcount,
        confirmed: point.confirmedHeadcount,
      })),
    [density],
  );

  /**
   * The density chart is drawn only when the calendar read was COMPLETE. On a capped
   * read the zero-filled dates stop being facts — see this file's header — so the panel
   * shows the reason instead of a chart with holes it cannot explain.
   */
  const densityDrawable =
    density !== undefined && density.points.length > 0 && calendar.data?.provenance.truncated !== true;

  const costMonthPoints = useMemo<ChartPoint[]>(
    () =>
      (costData?.months ?? []).map((month) => ({
        x: fmtCivilMonth(month.month),
        id: month.month,
        values: { gross: month.grossPaise, employer: month.employerCostPaise },
      })),
    [costData],
  );

  const costDeptPoints = useMemo<ChartPoint[]>(
    () =>
      (costData?.departments ?? []).slice(0, MAX_BARS).map((row) => ({
        x: row.departmentName ?? t("hr.leavecost.unassigned"),
        id: row.departmentId ?? "",
        values: { total: row.totalCostPaise, months: row.months },
      })),
    [costData],
  );

  // ── Comp-off action list, with names joined in ───────────────────────────────
  const compOffRows = useMemo(() => summary?.expiring ?? [], [summary]);

  return (
    <section className="mb-8">
      {/* `location` and `source` are HIDDEN, not ignored: no relation this panel reads
          carries a location column, and punch source is a per-scan column on
          attendance_punches. Offering a control that narrows nothing is how a reader
          comes to believe a figure is scoped when it is not. */}
      {showFilterBar ? (
        <AnalyticsFilterBar
          departments={options.data?.departments ?? []}
          locations={options.data?.locations ?? []}
          optionsLoading={options.isLoading}
          {...(employeeName === undefined ? {} : { employeeName })}
          hide={["location", "source"]}
        />
      ) : null}

      <div className="mb-3 mt-5">
        <h2 className="font-display text-lg font-semibold">{t("hr.leavecost.title")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("hr.leavecost.subtitle")}</p>
      </div>

      {/* Printed BEFORE any number, not under it: a reader who has already believed a
          figure is not helped by a footnote. */}
      {scopeNotes.length > 0 ? (
        <div className="mb-4 space-y-2">
          {scopeNotes.map((key) => (
            <CaveatNotice key={key} caveat={key} />
          ))}
        </div>
      ) : null}

      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("hr.leavecost.section.leave")}
      </h3>

      {/* ═══ 1. LEAVE LIABILITY — in DAYS, as at today ══════════════════════════ */}
      <section className="rounded-lg border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold">{t("hr.leavecost.liability.title")}</h4>
          <div className="flex flex-wrap items-center gap-2">
            <AnalyticsExportButtons<LeaveTypeBalance>
              title={t("hr.leavecost.export.liabilityTitle")}
              filename="leave-liability"
              columns={LIABILITY_EXPORT_COLUMNS}
              rows={liability.data?.liability.rows ?? []}
              filters={filters}
              labels={dimensionLabels(departmentName, employeeName)}
            />
          </div>
        </div>

        <StateBoundary
          loading={liability.isPending}
          error={liability.error ?? undefined}
          onRetry={() => void liability.refetch()}
          isEmpty={liability.isSuccess && liability.data.liability.rows.length === 0}
          empty={
            <EmptyState
              icon={Scale}
              title={t("hr.leavecost.liability.emptyTitle")}
              hint={t("hr.leavecost.liability.empty")}
            />
          }
          skeletonRows={2}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <KpiTile
              label={t("hr.leavecost.liability.total")}
              value={daysValue(liability.data?.liability.totalAvailableDays ?? null)}
              hint={t("hr.leavecost.liability.totalHint", {
                employees: formatNumber(liability.data?.liability.employees ?? 0),
                types: formatNumber(liability.data?.liability.rows.length ?? 0),
              })}
            />
            <KpiTile
              label={t("hr.leavecost.liability.paid")}
              value={daysValue(liability.data?.liability.paidAvailableDays ?? null)}
              hint={t("hr.leavecost.liability.paidHint")}
              tone="warn"
            />
            <KpiTile
              label={t("hr.leavecost.liability.unpaid")}
              value={daysValue(liability.data?.liability.unpaidAvailableDays ?? null)}
              hint={t("hr.leavecost.liability.unpaidHint")}
            />
            <KpiTile
              label={t("hr.leavecost.liability.compOff")}
              value={daysValue(liability.data?.liability.compOffAvailableDays ?? null)}
              hint={t("hr.leavecost.liability.compOffHint")}
            />
            <KpiTile
              label={t("hr.leavecost.liability.spendable")}
              value={daysValue(spendableDays(liability.data?.liability.rows))}
              hint={t("hr.leavecost.liability.spendableHint")}
            />
          </div>

          <div className="mt-4">
            <DataGrid
              columns={liabilityColumns()}
              rows={liability.data?.liability.rows ?? []}
              rowKey={(row) => row.leaveTypeId}
              pageSize={10}
              onRowClick={(row) => {
                // `type` is not one of the filter params, so withFilters preserves it
                // while overwriting period and dimensions with the current question.
                openWithFilters(
                  `/admin/leave/balances?type=${encodeURIComponent(row.leaveTypeId)}`,
                );
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {t("hr.leavecost.liability.avgDenominator")}
            </p>
          </div>

          <BlockNotes provenance={liability.data?.provenance} />
        </StateBoundary>
      </section>

      {/* ═══ 2. LEAVE TAKEN in the period ═══════════════════════════════════════ */}
      <section className="mt-4 rounded-lg border bg-card p-4">
        <h4 className="mb-3 text-sm font-semibold">{t("hr.leavecost.taken.title")}</h4>

        <StateBoundary
          loading={calendar.isPending}
          error={calendar.error ?? undefined}
          onRetry={() => void calendar.refetch()}
          isEmpty={calendar.isSuccess && calendar.data.taken.total.dayRows === 0}
          empty={
            <EmptyState
              icon={CalendarDays}
              title={t("hr.leavecost.taken.emptyTitle")}
              hint={t("hr.leavecost.taken.empty")}
            />
          }
          skeletonRows={2}
        >
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiTile
              label={t("hr.leavecost.taken.days")}
              value={daysValue(taken?.total.days ?? null)}
              hint={t("hr.leavecost.taken.daysHint", {
                rows: formatNumber(taken?.total.dayRows ?? 0),
                employees: formatNumber(taken?.total.employees ?? 0),
              })}
            />
            <KpiTile
              label={t("hr.leavecost.taken.confirmed")}
              value={daysValue(taken?.total.confirmedDays ?? null)}
            />
            <KpiTile
              label={t("hr.leavecost.taken.pending")}
              value={daysValue(taken?.total.pendingDays ?? null)}
              tone={(taken?.total.pendingDays ?? 0) > 0 ? "warn" : undefined}
            />
            <KpiTile
              label={t("hr.leavecost.taken.cancelling")}
              value={daysValue(taken?.total.cancellingDays ?? null)}
              hint={t("hr.leavecost.taken.cancellingHint")}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border p-4">
              {/* No `select`: `AnalyticsFilters` has no leave-type dimension and the
                  calendar rollup carries the type CODE, not the id the leave console
                  filters on. A link no screen honours is worse than an honest picture. */}
              <RankedBarsChart
                title={t("hr.leavecost.taken.byTypeTitle")}
                caption={barsCaption(
                  t("hr.leavecost.taken.byTypeCaption", {
                    rows: formatNumber(taken?.total.dayRows ?? 0),
                  }),
                  taken?.byType.length ?? 0,
                )}
                measure={{ key: "days", label: t("hr.leavecost.taken.col.days") }}
                context={{ key: "people", label: t("hr.leavecost.taken.col.people") }}
                points={takenTypePoints}
                format={dayFormat}
                xHeader={t("hr.leavecost.taken.col.type")}
              />
            </div>
            <div className="rounded-lg border p-4">
              <RankedBarsChart
                title={t("hr.leavecost.taken.byDeptTitle")}
                caption={barsCaption(
                  t("hr.leavecost.taken.byDeptCaption"),
                  taken?.byDepartment.length ?? 0,
                )}
                measure={{ key: "days", label: t("hr.leavecost.taken.col.days") }}
                context={{ key: "people", label: t("hr.leavecost.taken.col.people") }}
                points={takenDeptPoints}
                format={dayFormat}
                xHeader={t("hr.leavecost.taken.col.department")}
                select={{
                  selectLabel: (label) => t("hr.leavecost.taken.deptDrill", { name: label }),
                  onSelect: (id) => {
                    if (id === "") return;
                    drillTo({ ...filters, departmentId: id });
                  },
                }}
              />
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <DataGrid
              columns={takenTypeColumns()}
              rows={taken?.byType ?? []}
              rowKey={(row) => row.leaveTypeCode}
              pageSize={10}
            />
            <DataGrid
              columns={takenDeptColumns()}
              rows={taken?.byDepartment ?? []}
              rowKey={(row) => row.departmentId ?? UNASSIGNED_KEY}
              pageSize={10}
              onRowClick={(row) => {
                if (row.departmentId === null) return;
                drillTo({ ...filters, departmentId: row.departmentId });
              }}
            />
          </div>

          {/* The calendar page's caveats live here, under the first of the two blocks
              it feeds — the one whose totals are split by status because of them. */}
          <BlockNotes provenance={calendar.data?.provenance} />
        </StateBoundary>
      </section>

      {/* ═══ 3. ROSTER DENSITY — the spike is the finding ═══════════════════════ */}
      <section className="mt-4 rounded-lg border bg-card p-4">
        <h4 className="mb-3 text-sm font-semibold">{t("hr.leavecost.density.title")}</h4>

        <StateBoundary
          loading={calendar.isPending}
          error={calendar.error ?? undefined}
          onRetry={() => void calendar.refetch()}
          skeletonRows={3}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KpiTile
              label={t("hr.leavecost.density.peak")}
              value={formatNumber(density?.peakHeadcount ?? 0)}
              tone={(density?.peakHeadcount ?? 0) > 0 ? "warn" : undefined}
              hint={
                density === undefined || density.peakHeadcount === 0
                  ? t("hr.leavecost.density.peakNone")
                  : t("hr.leavecost.density.peakHint", {
                      count: formatNumber(density.peakHeadcount),
                      dates: peakDatesSentence(density.peakDates),
                    })
              }
            />
            <KpiTile
              label={t("hr.leavecost.density.mean")}
              value={dash(density?.meanHeadcount ?? null, (v) => v.toFixed(1))}
              // THE DENOMINATOR, on the tile, plus why zero-filling is right here.
              hint={t("hr.leavecost.density.meanHint", {
                days: formatNumber(density?.daysInPeriod ?? 0),
              })}
            />
          </div>

          {densityDrawable ? (
            <figure className="m-0 mt-4">
              <h5 className="text-sm font-medium">{t("hr.leavecost.density.chartTitle")}</h5>
              <div className="mt-2 overflow-x-auto">
                <div className="h-56 min-w-[520px]">
                  <ResponsiveContainer width="100%" height="100%">
                    {/* GROUPED, not stacked: approved people are a subset of the people
                        off, and stacking them would draw a total nobody counted. */}
                    <BarChart
                      data={densityRows}
                      margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
                      accessibilityLayer
                    >
                      <CartesianGrid stroke={CHART_GRID} strokeWidth={1} vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 11 }}
                        stroke={CHART_GRID}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        stroke={CHART_GRID}
                        allowDecimals={false}
                        width={44}
                      />
                      <Tooltip />
                      <Legend />
                      <Bar
                        dataKey="headcount"
                        name={t("hr.leavecost.density.seriesHeadcount")}
                        fill={seriesColour(0)}
                        isAnimationActive={false}
                      />
                      <Bar
                        dataKey="confirmed"
                        name={t("hr.leavecost.density.seriesConfirmed")}
                        fill={seriesColour(1)}
                        isAnimationActive={false}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <figcaption className="mt-2 text-xs text-muted-foreground">
                {t("hr.leavecost.density.chartCaption")}
              </figcaption>
            </figure>
          ) : calendar.data?.provenance.truncated === true ? (
            <Notice tone="warning" className="mt-4">
              {t("hr.leavecost.density.truncated")}
            </Notice>
          ) : null}

          <div className="mt-4">
            <h5 className="text-sm font-medium">{t("hr.leavecost.density.riskTitle")}</h5>
            <p className="mb-3 mt-1 text-xs text-muted-foreground">
              {t("hr.leavecost.density.riskHint", {
                shown: formatNumber(Math.min(DEFAULT_BUSIEST_DATES, density?.busiestDates.length ?? 0)),
                total: formatNumber(
                  (density?.points ?? []).filter((point) => point.headcount > 0).length,
                ),
              })}
            </p>
            <DataGrid
              columns={densityColumns()}
              rows={density?.busiestDates ?? []}
              rowKey={(row) => row.istDate}
              pageSize={10}
              emptyState={
                <EmptyState
                  icon={CalendarDays}
                  title={t("hr.leavecost.density.riskTitle")}
                  hint={t("hr.leavecost.density.peakNone")}
                />
              }
              onRowClick={(row) => {
                // A single-day period: the whole panel re-reads for that one date, which
                // is what "the spike is the finding" is for.
                drillTo({ ...filters, period: periodFor("day", row.istDate) });
              }}
            />
          </div>

          {/* Same read as the block above, so only the basis line repeats. */}
          <BlockNotes provenance={calendar.data?.provenance} caveats={false} />
        </StateBoundary>
      </section>

      {/* ═══ 4. COMP-OFF EXPIRY — an action list ════════════════════════════════ */}
      <section className="mt-4 rounded-lg border bg-card p-4">
        <h4 className="mb-3 text-sm font-semibold">{t("hr.leavecost.compoff.title")}</h4>

        <StateBoundary
          loading={compOff.isPending}
          error={compOff.error ?? undefined}
          onRetry={() => void compOff.refetch()}
          isEmpty={compOff.isSuccess && compOff.data.summary.employees === 0}
          empty={
            <EmptyState
              icon={HeartHandshake}
              title={t("hr.leavecost.compoff.emptyTitle")}
              hint={t("hr.leavecost.compoff.empty")}
            />
          }
          skeletonRows={2}
        >
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiTile
              label={t("hr.leavecost.compoff.available")}
              value={daysValue(summary?.availableDays ?? null)}
              hint={t("hr.leavecost.compoff.availableHint", {
                employees: formatNumber(summary?.employees ?? 0),
              })}
            />
            <KpiTile
              label={t("hr.leavecost.compoff.expiring")}
              value={daysValue(summary?.expiringDays ?? null)}
              tone={(summary?.expiringDays ?? 0) > 0 ? "danger" : undefined}
              hint={t("hr.leavecost.compoff.expiringHint", {
                employees: formatNumber(summary?.employeesExpiring ?? 0),
              })}
            />
            <KpiTile
              label={t("hr.leavecost.compoff.expiringPeople")}
              value={formatNumber(summary?.employeesExpiring ?? 0)}
              tone={(summary?.employeesExpiring ?? 0) > 0 ? "warn" : undefined}
              hint={t("hr.leavecost.compoff.expiringPeopleHint")}
            />
            <KpiTile
              label={t("hr.leavecost.compoff.nearest")}
              value={
                summary?.nearestExpiry == null
                  ? dash(null)
                  : fmtCivilDate(summary.nearestExpiry)
              }
              hint={t("hr.leavecost.compoff.nearestHint")}
            />
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            {t("hr.leavecost.compoff.creditsHint", {
              credits: formatNumber(summary?.openCredits ?? 0),
              employees: formatNumber(summary?.employees ?? 0),
            })}
          </p>

          {/* A capped list is ordered soonest-expiry-first at the SERVER, so it keeps the
              rows that matter — but the counts above then describe what arrived. */}
          {compOff.data?.provenance.truncated === true ? (
            <Notice tone="warning" className="mt-3">
              {t("hr.leavecost.compoff.listCapped", {
                shown: formatNumber(compOffRows.length),
              })}
            </Notice>
          ) : null}
          {employeeLabels.error !== null ? (
            <Notice tone="info" className="mt-3">
              {t("hr.leavecost.compoff.namesUnavailable")}
            </Notice>
          ) : null}

          <div className="mt-4">
            <DataGrid
              columns={compOffColumns(labels)}
              rows={compOffRows}
              rowKey={(row) => row.employeeId}
              loading={employeeLabels.isPending}
              pageSize={10}
              emptyState={
                <EmptyState
                  icon={HeartHandshake}
                  title={t("hr.leavecost.compoff.expiring")}
                  hint={t("hr.leavecost.compoff.expiringNone")}
                />
              }
              onRowClick={(row) => {
                // `emp` IS a filter param, so it travels in the filter object rather
                // than in the path — withFilters strips filter params off the path.
                openWithFilters("/admin/leave/comp-off", {
                  ...filters,
                  employeeId: row.employeeId,
                });
              }}
            />
          </div>

          <BlockNotes provenance={compOff.data?.provenance} />
        </StateBoundary>
      </section>

      {/* ═══ 5. HOW BALANCES MOVED — the ledger ═════════════════════════════════ */}
      <section className="mt-4 rounded-lg border bg-card p-4">
        <h4 className="mb-3 text-sm font-semibold">{t("hr.leavecost.movement.title")}</h4>

        <StateBoundary
          loading={movement.isPending}
          error={movement.error ?? undefined}
          onRetry={() => void movement.refetch()}
          isEmpty={movement.isSuccess && movement.data.movement.entries === 0}
          empty={
            <EmptyState
              icon={TrendingUp}
              title={t("hr.leavecost.movement.emptyTitle")}
              hint={t("hr.leavecost.movement.empty")}
            />
          }
          skeletonRows={2}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile
              label={t("hr.leavecost.movement.credited")}
              value={daysValue(ledger?.creditedDays ?? null)}
              hint={t("hr.leavecost.movement.creditedHint")}
            />
            <KpiTile
              label={t("hr.leavecost.movement.debited")}
              value={daysValue(ledger?.debitedDays ?? null)}
              hint={t("hr.leavecost.movement.debitedHint")}
            />
            <KpiTile
              label={t("hr.leavecost.movement.net")}
              value={daysValue(ledger?.netDays ?? null)}
              tone={(ledger?.netDays ?? 0) < 0 ? "warn" : undefined}
              hint={t("hr.leavecost.movement.netHint", {
                entries: formatNumber(ledger?.entries ?? 0),
                employees: formatNumber(ledger?.employees ?? 0),
              })}
            />
          </div>

          {(ledger?.reversedEntries ?? 0) > 0 ? (
            <Notice tone="info" className="mt-3">
              {t("hr.leavecost.movement.reversed", {
                count: formatNumber(ledger?.reversedEntries ?? 0),
              })}
            </Notice>
          ) : null}

          <div className="mt-4">
            <DataGrid
              columns={movementColumns()}
              rows={ledger?.rows ?? []}
              rowKey={(row) => row.entryType}
              pageSize={10}
            />
          </div>

          <BlockNotes provenance={movement.data?.provenance} />
        </StateBoundary>
      </section>

      <h3 className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("hr.leavecost.section.cost")}
      </h3>

      {/* ═══ 6 + 7. COST and VARIANCE — capability-gated ════════════════════════ */}
      {!canSeeCost ? (
        // HIDDEN, not empty. Zero tiles beat zero-valued tiles: "₹0" would read as a
        // venue that spent nothing, which is a claim about payroll rather than access.
        <div className="rounded-lg border bg-card p-4">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <Lock className="size-4 text-muted-foreground" aria-hidden />
            {t("hr.leavecost.cost.locked")}
          </h4>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("hr.leavecost.cost.lockedHint")}
          </p>
        </div>
      ) : (
        <>
          <section className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-sm font-semibold">{t("hr.leavecost.cost.title")}</h4>
              <AnalyticsExportButtons<CostCell>
                title={t("hr.leavecost.export.costTitle")}
                filename="payroll-cost-by-month-department"
                columns={COST_EXPORT_COLUMNS}
                rows={costData?.cells ?? []}
                filters={filters}
                labels={dimensionLabels(departmentName, employeeName)}
              />
            </div>

            <StateBoundary
              loading={cost.isPending}
              error={cost.error ?? undefined}
              onRetry={() => void cost.refetch()}
              isEmpty={cost.isSuccess && cost.data.cost.rows === 0}
              empty={
                <EmptyState
                  icon={Banknote}
                  title={t("hr.leavecost.cost.emptyTitle")}
                  hint={t("hr.leavecost.cost.empty")}
                />
              }
              skeletonRows={3}
            >
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                <KpiTile
                  label={t("hr.leavecost.cost.total")}
                  value={<Money paise={costData?.totalCostPaise ?? null} />}
                  hint={t("hr.leavecost.cost.totalHint", {
                    rows: formatNumber(costData?.rows ?? 0),
                    months: formatNumber(costData?.months.length ?? 0),
                  })}
                />
                <KpiTile
                  label={t("hr.leavecost.cost.gross")}
                  value={<Money paise={costData?.grossPaise ?? null} />}
                  hint={t("hr.leavecost.cost.grossHint")}
                />
                <KpiTile
                  label={t("hr.leavecost.cost.employer")}
                  value={<Money paise={costData?.employerCostPaise ?? null} />}
                  hint={t("hr.leavecost.cost.employerHint")}
                />
                <KpiTile
                  label={t("hr.leavecost.cost.net")}
                  value={<Money paise={costData?.netPaise ?? null} />}
                  hint={t("hr.leavecost.cost.netHint")}
                />
                <KpiTile
                  label={t("hr.leavecost.cost.overtime")}
                  value={<Money paise={costData?.overtimeCostPaise ?? null} />}
                  // The share is recomputed from two summed paise columns, never
                  // averaged from the view's per-row ratio. Null share ⇒ say why.
                  hint={
                    costData?.overtimeSharePct == null
                      ? t("hr.leavecost.cost.overtimeUnavailable")
                      : t("hr.leavecost.cost.overtimeHint", {
                          share: formatPercent(costData.overtimeSharePct, { clamp: true }),
                        })
                  }
                />
              </div>

              <div className="mt-3 space-y-2">
                <Notice tone="info">{t("hr.leavecost.cost.perEmployeeUnavailable")}</Notice>
                {costWindow !== undefined ? (
                  <p className="text-xs text-muted-foreground">
                    {t("hr.leavecost.cost.window", {
                      months: formatNumber(costWindow.months.length),
                      total: formatNumber(costWindow.totalMonths),
                    })}{" "}
                    {costData?.refreshedAt == null
                      ? t("hr.leavecost.cost.asOfUnknown")
                      : t("hr.leavecost.cost.asOf", {
                          when: fmtDateTime(costData.refreshedAt),
                        })}
                  </p>
                ) : null}
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <StackedBarsChart
                    title={t("hr.leavecost.cost.monthTitle")}
                    caption={t("hr.leavecost.cost.monthChartCaption")}
                    series={[
                      { key: "gross", label: t("hr.leavecost.cost.col.gross") },
                      { key: "employer", label: t("hr.leavecost.cost.col.employer") },
                    ]}
                    points={costMonthPoints}
                    format={paiseFormat}
                    tickFormat={paiseTick}
                    xHeader={t("hr.leavecost.cost.col.month")}
                  />
                </div>
                <div className="rounded-lg border p-4">
                  <RankedBarsChart
                    title={t("hr.leavecost.cost.deptTitle")}
                    caption={barsCaption(
                      t("hr.leavecost.cost.deptChartCaption"),
                      costData?.departments.length ?? 0,
                    )}
                    measure={{ key: "total", label: t("hr.leavecost.cost.col.total") }}
                    points={costDeptPoints}
                    format={paiseFormat}
                    tickFormat={paiseTick}
                    xHeader={t("hr.leavecost.cost.col.department")}
                    select={{
                      selectLabel: (label) => t("hr.leavecost.cost.deptDrill", { name: label }),
                      onSelect: (id) => {
                        if (id === "") return;
                        drillTo({ ...filters, departmentId: id });
                      },
                    }}
                  />
                </div>
              </div>

              <div className="mt-4">
                <h5 className="text-sm font-medium">{t("hr.leavecost.cost.cellsTitle")}</h5>
                <p className="mb-3 mt-1 text-xs text-muted-foreground">
                  {t("hr.leavecost.cost.cellsHint")}
                </p>
                <DataGrid
                  columns={costCellColumns()}
                  rows={costData?.cells ?? []}
                  rowKey={(row) => `${row.month} ${row.departmentId ?? UNASSIGNED_KEY}`}
                  pageSize={25}
                  onRowClick={(row) => {
                    if (row.departmentId === null) return;
                    drillTo({ ...filters, departmentId: row.departmentId });
                  }}
                />
              </div>

              {/* The engine's own org totals live on the run headers, not in these
                  cells — said out loud so nobody reconciles the two by hand. */}
              <Notice tone="info" className="mt-3">
                {t("hr.leavecost.orgTotalPointer")}
              </Notice>

              <BlockNotes provenance={cost.data?.provenance} />
            </StateBoundary>
          </section>

          <section className="mt-4 rounded-lg border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-sm font-semibold">{t("hr.leavecost.variance.title")}</h4>
              <span className="num text-xs text-muted-foreground">
                {variance.data?.runNumber == null
                  ? t("hr.leavecost.variance.runUnknown")
                  : t("hr.leavecost.variance.run", { run: variance.data.runNumber })}
              </span>
            </div>

            <StateBoundary
              loading={variance.isPending}
              error={variance.error ?? undefined}
              onRetry={() => void variance.refetch()}
              isEmpty={variance.isSuccess && variance.data.variance.employees === 0}
              empty={
                <EmptyState
                  icon={Layers}
                  title={t("hr.leavecost.variance.emptyTitle")}
                  hint={t("hr.leavecost.variance.empty")}
                />
              }
              skeletonRows={2}
            >
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                <KpiTile
                  label={t("hr.leavecost.variance.netChange")}
                  value={<Money paise={varianceData?.netChangePaise ?? null} />}
                  tone={(varianceData?.netChangePaise ?? 0) < 0 ? "warn" : undefined}
                  // THE denominator that stops a clean run looking like a crisis.
                  hint={t("hr.leavecost.variance.netChangeHint", {
                    comparable: formatNumber(varianceData?.comparable ?? 0),
                    firstPayslip: formatNumber(varianceData?.firstPayslip ?? 0),
                  })}
                />
                <KpiTile
                  label={t("hr.leavecost.variance.currentTotal")}
                  value={<Money paise={varianceData?.currentTotalPaise ?? null} />}
                  hint={t("hr.leavecost.variance.currentTotalHint", {
                    employees: formatNumber(varianceData?.employees ?? 0),
                  })}
                />
                <KpiTile
                  label={t("hr.leavecost.variance.flagged", { pct: VARIANCE_FLAG_PCT })}
                  value={formatNumber(varianceData?.flagged ?? 0)}
                  tone={(varianceData?.flagged ?? 0) > 0 ? "danger" : "success"}
                  hint={t("hr.leavecost.variance.flaggedHint", { pct: VARIANCE_FLAG_PCT })}
                />
                <KpiTile
                  label={t("hr.leavecost.variance.increased")}
                  value={formatNumber(varianceData?.increased ?? 0)}
                  hint={t("hr.leavecost.variance.movementHint", {
                    increased: formatNumber(varianceData?.increased ?? 0),
                    decreased: formatNumber(varianceData?.decreased ?? 0),
                    unchanged: formatNumber(varianceData?.unchanged ?? 0),
                    comparable: formatNumber(varianceData?.comparable ?? 0),
                  })}
                />
                <KpiTile
                  label={t("hr.leavecost.variance.employees")}
                  value={formatNumber(varianceData?.employees ?? 0)}
                  hint={t("hr.leavecost.variance.employeesHint", {
                    comparable: formatNumber(varianceData?.comparable ?? 0),
                    firstPayslip: formatNumber(varianceData?.firstPayslip ?? 0),
                  })}
                />
              </div>

              {/* Should be unreachable — the fetch pins the grain server-side — so it is
                  a loud warning rather than a footnote if it ever fires. */}
              {(varianceData?.componentRowsIgnored ?? 0) > 0 ? (
                <Notice tone="warning" className="mt-3">
                  {t("hr.leavecost.variance.componentRows", {
                    count: formatNumber(varianceData?.componentRowsIgnored ?? 0),
                  })}
                </Notice>
              ) : null}

              <div className="mt-4">
                <h5 className="text-sm font-medium">{t("hr.leavecost.variance.moversTitle")}</h5>
                <p className="mb-3 mt-1 text-xs text-muted-foreground">
                  {t("hr.leavecost.variance.moversHint", {
                    shown: formatNumber(
                      Math.min(DEFAULT_MOVER_COUNT, varianceData?.movers.length ?? 0),
                    ),
                    total: formatNumber(varianceData?.comparable ?? 0),
                  })}
                </p>
                <DataGrid
                  columns={moverColumns()}
                  rows={varianceData?.movers ?? []}
                  rowKey={(row) => row.employeeId}
                  pageSize={10}
                  onRowClick={(row) => {
                    // The compensation tab is keyed by employee_code (route-manifest).
                    if (row.employeeCode === null) return;
                    openWithFilters(
                      `/admin/people/${encodeURIComponent(row.employeeCode)}/compensation`,
                    );
                  }}
                />
              </div>

              <BlockNotes provenance={variance.data?.provenance} />
            </StateBoundary>
          </section>
        </>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Notes — caveats and provenance, split scope vs block (see the file header)
// -----------------------------------------------------------------------------

/** `Notice` already carries the tone's icon, so the sentence is all this adds. */
function CaveatNotice({ caveat }: { caveat: MessageKey }) {
  return <Notice tone={CAVEAT_TONE[caveat] ?? "info"}>{t(caveat)}</Notice>;
}

/**
 * One block's own caveats, plus where its figures came from.
 *
 * The scope-wide keys are filtered out — they are printed once at the top of the panel
 * — and the basis line names the relation and the row count, because these totals were
 * added up in this browser and the reader is entitled to know which of the two they
 * are looking at.
 *
 * `caveats={false}` is for the SECOND block fed by a shared read: "leave taken" and
 * "roster density" are two projections of one `v_leave_calendar` page, so the caveats
 * belong under the first of them and only the basis line is repeated. Printing them
 * twice would train a reader to skip them.
 */
function BlockNotes({
  provenance,
  caveats = true,
}: {
  provenance: AnalyticsProvenance | undefined;
  caveats?: boolean;
}) {
  if (provenance === undefined) return null;
  const own = caveats ? provenance.caveats.filter((key) => !SCOPE_CAVEATS.has(key)) : [];
  return (
    <div className="mt-4 space-y-2">
      {own.map((key) => (
        <CaveatNotice key={key} caveat={key} />
      ))}
      <p className="text-xs text-muted-foreground">
        {provenance.rowsScanned === 0
          ? t("hr.leavecost.basisNone", { relation: provenance.relation })
          : t("hr.leavecost.basis", {
              rows: formatNumber(provenance.rowsScanned),
              relation: provenance.relation,
            })}
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Small derivations — presentation only, never a business figure
// -----------------------------------------------------------------------------

/**
 * The caption, plus "top N of M" whenever bars were left off. A top-N that does not
 * say so is how a chart of fourteen departments reads as a whole organisation.
 */
function barsCaption(base: string, total: number): string {
  if (total <= MAX_BARS) return base;
  return `${base} ${t("hr.leavecost.bars.more", {
    shown: formatNumber(MAX_BARS),
    total: formatNumber(total),
  })}`;
}

/**
 * Every date that hit the peak, or the first few plus a count of the rest. A single
 * "worst day" hides a pattern that repeats every Friday, which is the whole reason the
 * aggregate returns the list — but a period where forty dates tie must not fill a tile.
 */
const MAX_PEAK_DATES_LISTED = 5;

function peakDatesSentence(dates: readonly string[]): string {
  const listed = dates.slice(0, MAX_PEAK_DATES_LISTED).map((d) => fmtCivilDate(d));
  const rest = dates.length - listed.length;
  const joined = listed.join(", ");
  return rest <= 0
    ? joined
    : `${joined} ${t("hr.leavecost.density.peakMoreDates", { count: formatNumber(rest) })}`;
}

/**
 * The spendable total: the sum of a NAMED per-type column
 * (`available_after_pending`), added the same way the aggregate adds every other day
 * figure. It is summed here rather than read off `LeaveLiability` because the pure
 * module publishes that column per type and not as an organisation total — and adding
 * the rows it already returned is the honest alternative to leaving the tile blank.
 * Rounded at the boundary for the same reason `roundDays` exists: 0.1 + 0.2.
 */
function spendableDays(rows: readonly LeaveTypeBalance[] | undefined): number | null {
  if (rows === undefined || rows.length === 0) return null;
  let total = 0;
  for (const row of rows) total += row.availableAfterPendingDays;
  return Math.round(total * 100) / 100;
}

/** Filter IDs → the names an exported report prints in its heading block. */
function dimensionLabels(
  department: string | undefined,
  employee: string | undefined,
): { department?: string; employee?: string } {
  return {
    ...(department === undefined ? {} : { department }),
    ...(employee === undefined ? {} : { employee }),
  };
}

// -----------------------------------------------------------------------------
// Grid columns
// -----------------------------------------------------------------------------

function liabilityColumns(): DataGridColumn<LeaveTypeBalance>[] {
  return [
    {
      key: "leaveTypeName",
      header: t("hr.leavecost.liability.col.type"),
      width: "14rem",
      sortable: true,
      sortValue: (row) => row.leaveTypeName,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.leaveTypeName}</span>
          <span className="num text-xs text-muted-foreground">{row.leaveTypeCode}</span>
        </span>
      ),
    },
    {
      key: "isPaid",
      header: t("hr.leavecost.liability.paidChip"),
      width: "7rem",
      hideBelow: "md",
      // The flag that decides whether this row's balance costs anything to honour.
      render: (row) =>
        row.isPaid ? (
          <StatusChip
            status="paid"
            map={{ paid: { label: t("hr.leavecost.liability.paidChip"), tone: "warn" } }}
          />
        ) : (
          <StatusChip
            status="unpaid"
            map={{ unpaid: { label: t("hr.leavecost.liability.unpaidChip"), tone: "neutral" } }}
          />
        ),
    },
    {
      key: "employees",
      header: t("hr.leavecost.liability.col.employees"),
      align: "right",
      width: "6rem",
      sortable: true,
      sortValue: (row) => row.employees,
      render: (row) => <span className="num">{formatNumber(row.employees)}</span>,
    },
    {
      key: "entitlementDays",
      header: t("hr.leavecost.liability.col.entitlement"),
      align: "right",
      width: "7rem",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.entitlementDays,
      render: (row) => <span className="num">{daysCell(row.entitlementDays)}</span>,
    },
    {
      key: "availedDays",
      header: t("hr.leavecost.liability.col.availed"),
      align: "right",
      width: "6rem",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.availedDays,
      render: (row) => <span className="num">{daysCell(row.availedDays)}</span>,
    },
    {
      key: "pendingDays",
      header: t("hr.leavecost.liability.col.pending"),
      align: "right",
      width: "7rem",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.pendingDays,
      render: (row) => <span className="num">{daysCell(row.pendingDays)}</span>,
    },
    {
      key: "lapsedDays",
      header: t("hr.leavecost.liability.col.lapsed"),
      align: "right",
      width: "6rem",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.lapsedDays,
      render: (row) => (
        <span className={row.lapsedDays > 0 ? "num text-destructive" : "num"}>
          {daysCell(row.lapsedDays)}
        </span>
      ),
    },
    {
      key: "availableDays",
      header: t("hr.leavecost.liability.col.available"),
      align: "right",
      width: "7rem",
      sortable: true,
      sortValue: (row) => row.availableDays,
      render: (row) => <span className="num font-medium">{daysCell(row.availableDays)}</span>,
    },
    {
      key: "avgAvailableDaysPerEmployee",
      header: t("hr.leavecost.liability.col.avgPerEmployee"),
      align: "right",
      width: "8rem",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.avgAvailableDaysPerEmployee,
      // Null when nobody holds the type: "no holders" is not "everybody holds zero".
      render: (row) => (
        <span className="num">{dash(row.avgAvailableDaysPerEmployee, formatDaysFixed)}</span>
      ),
    },
  ];
}

/** The four day totals every leave grouping carries, as columns. */
function daySplitColumns<T extends LeaveTakenByType | LeaveTakenByDepartment>(): DataGridColumn<T>[] {
  return [
    {
      key: "days",
      header: t("hr.leavecost.taken.col.days"),
      align: "right",
      width: "6rem",
      sortable: true,
      sortValue: (row) => row.days,
      render: (row) => <span className="num font-medium">{daysCell(row.days)}</span>,
    },
    {
      key: "confirmedDays",
      header: t("hr.leavecost.taken.col.confirmed"),
      align: "right",
      width: "6rem",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.confirmedDays,
      render: (row) => <span className="num">{daysCell(row.confirmedDays)}</span>,
    },
    {
      key: "pendingDays",
      header: t("hr.leavecost.taken.col.pending"),
      align: "right",
      width: "6rem",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.pendingDays,
      render: (row) => <span className="num">{daysCell(row.pendingDays)}</span>,
    },
    {
      key: "cancellingDays",
      header: t("hr.leavecost.taken.col.cancelling"),
      align: "right",
      width: "6rem",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.cancellingDays,
      render: (row) => <span className="num">{daysCell(row.cancellingDays)}</span>,
    },
    {
      key: "employees",
      header: t("hr.leavecost.taken.col.people"),
      align: "right",
      width: "6rem",
      sortable: true,
      sortValue: (row) => row.employees,
      render: (row) => <span className="num">{formatNumber(row.employees)}</span>,
    },
  ];
}

function takenTypeColumns(): DataGridColumn<LeaveTakenByType>[] {
  return [
    {
      key: "leaveTypeName",
      header: t("hr.leavecost.taken.col.type"),
      sortable: true,
      sortValue: (row) => row.leaveTypeName,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.leaveTypeName}</span>
          <span className="num text-xs text-muted-foreground">{row.leaveTypeCode}</span>
        </span>
      ),
    },
    ...daySplitColumns<LeaveTakenByType>(),
  ];
}

function takenDeptColumns(): DataGridColumn<LeaveTakenByDepartment>[] {
  return [
    {
      key: "departmentName",
      header: t("hr.leavecost.taken.col.department"),
      sortable: true,
      sortValue: (row) => row.departmentName ?? "",
      render: (row) => row.departmentName ?? t("hr.leavecost.unassigned"),
    },
    ...daySplitColumns<LeaveTakenByDepartment>(),
  ];
}

function densityColumns(): DataGridColumn<LeaveDensityPoint>[] {
  return [
    {
      key: "istDate",
      header: t("hr.leavecost.density.col.date"),
      sortable: true,
      sortValue: (row) => row.istDate,
      render: (row) => <span className="num">{fmtCivilDate(row.istDate)}</span>,
    },
    {
      key: "headcount",
      header: t("hr.leavecost.density.col.headcount"),
      align: "right",
      sortable: true,
      sortValue: (row) => row.headcount,
      render: (row) => <span className="num font-medium">{formatNumber(row.headcount)}</span>,
    },
    {
      key: "confirmedHeadcount",
      header: t("hr.leavecost.density.col.confirmed"),
      align: "right",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.confirmedHeadcount,
      render: (row) => <span className="num">{formatNumber(row.confirmedHeadcount)}</span>,
    },
    {
      key: "pendingHeadcount",
      header: t("hr.leavecost.density.col.pending"),
      align: "right",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.pendingHeadcount,
      render: (row) => <span className="num">{formatNumber(row.pendingHeadcount)}</span>,
    },
    {
      key: "days",
      header: t("hr.leavecost.density.col.days"),
      align: "right",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.days,
      // The COVER number beside the roster number: two half-days by one person is 1.0
      // of cover but one person away, and a planner needs both.
      render: (row) => <span className="num">{daysCell(row.days)}</span>,
    },
  ];
}

/**
 * The comp-off action list. `v_comp_off_balance` carries no name — the person lives on
 * the directory — so the id is joined to a label here. An id the (capped) directory
 * read did not return says so rather than printing a uuid at somebody.
 */
function compOffColumns(labels: EmployeeLabelMap | undefined): DataGridColumn<CompOffExpiryEntry>[] {
  return [
    {
      key: "employee",
      header: t("hr.leavecost.compoff.col.employee"),
      sortable: true,
      sortValue: (row) => labels?.get(row.employeeId)?.name ?? "",
      render: (row) => {
        const label = labels?.get(row.employeeId);
        if (label === undefined) {
          return (
            <span className="text-muted-foreground">
              {t("hr.leavecost.compoff.unknownEmployee")}
            </span>
          );
        }
        return <PersonCell name={label.name} code={label.code} secondary={label.department} />;
      },
    },
    {
      key: "nearestExpiry",
      header: t("hr.leavecost.compoff.col.nearest"),
      sortable: true,
      // A null expiry sorts LAST: it is not urgent, it is unbounded.
      sortValue: (row) => row.nearestExpiry ?? "9999-12-31",
      render: (row) => (
        <span className="num text-destructive">{dash(row.nearestExpiry, fmtCivilDate)}</span>
      ),
    },
    {
      key: "expiringDays",
      header: t("hr.leavecost.compoff.col.expiring"),
      align: "right",
      sortable: true,
      sortValue: (row) => row.expiringDays,
      render: (row) => <span className="num font-medium">{daysCell(row.expiringDays)}</span>,
    },
    {
      key: "availableDays",
      header: t("hr.leavecost.compoff.col.available"),
      align: "right",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.availableDays,
      render: (row) => <span className="num">{daysCell(row.availableDays)}</span>,
    },
    {
      key: "openCredits",
      header: t("hr.leavecost.compoff.col.credits"),
      align: "right",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.openCredits,
      render: (row) => <span className="num">{formatNumber(row.openCredits)}</span>,
    },
  ];
}

function movementColumns(): DataGridColumn<LedgerMovementRow>[] {
  return [
    {
      key: "entryType",
      header: t("hr.leavecost.movement.col.entry"),
      sortable: true,
      sortValue: (row) => row.entryType,
      // The enum value never reaches a cell (D-10): the shared leave vocabulary owns
      // the sentence AND the tone, so a lapse reads as a loss here exactly as it does
      // on a leave statement.
      render: (row) => {
        const entry = LEDGER_ENTRY_CHIP[row.entryType];
        return <StatusChip status={row.entryType} map={{ [row.entryType]: entry }} />;
      },
    },
    {
      key: "days",
      header: t("hr.leavecost.movement.col.days"),
      align: "right",
      sortable: true,
      sortValue: (row) => row.days,
      // Signed exactly as the ledger stores it — a debit arrives negative and prints
      // negative. No sign is applied, and none is stripped.
      render: (row) => (
        <span className={row.days < 0 ? "num text-destructive" : "num text-success"}>
          {daysCell(row.days)}
        </span>
      ),
    },
    {
      key: "entries",
      header: t("hr.leavecost.movement.col.entries"),
      align: "right",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.entries,
      render: (row) => <span className="num">{formatNumber(row.entries)}</span>,
    },
    {
      key: "employees",
      header: t("hr.leavecost.movement.col.people"),
      align: "right",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.employees,
      render: (row) => <span className="num">{formatNumber(row.employees)}</span>,
    },
  ];
}

function costCellColumns(): DataGridColumn<CostCell>[] {
  return [
    {
      key: "month",
      header: t("hr.leavecost.cost.col.month"),
      width: "8rem",
      sortable: true,
      sortValue: (row) => row.month,
      render: (row) => <span className="num">{fmtCivilMonth(row.month)}</span>,
    },
    {
      key: "departmentName",
      header: t("hr.leavecost.cost.col.department"),
      sortable: true,
      sortValue: (row) => row.departmentName ?? "",
      render: (row) => row.departmentName ?? t("hr.leavecost.unassigned"),
    },
    {
      key: "costCentres",
      header: t("hr.leavecost.cost.col.cells"),
      align: "right",
      width: "7rem",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.costCentres,
      render: (row) => <span className="num">{formatNumber(row.costCentres)}</span>,
    },
    {
      key: "grossPaise",
      header: t("hr.leavecost.cost.col.gross"),
      align: "right",
      width: "9rem",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.grossPaise,
      render: (row) => <Money paise={row.grossPaise} />,
    },
    {
      key: "employerCostPaise",
      header: t("hr.leavecost.cost.col.employer"),
      align: "right",
      width: "9rem",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.employerCostPaise,
      render: (row) => <Money paise={row.employerCostPaise} />,
    },
    {
      key: "overtimeCostPaise",
      header: t("hr.leavecost.cost.col.overtime"),
      align: "right",
      width: "9rem",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.overtimeCostPaise,
      render: (row) => <Money paise={row.overtimeCostPaise} />,
    },
    {
      key: "totalCostPaise",
      header: t("hr.leavecost.cost.col.total"),
      align: "right",
      width: "10rem",
      sortable: true,
      sortValue: (row) => row.totalCostPaise,
      render: (row) => <Money paise={row.totalCostPaise} className="font-medium" />,
    },
  ];
}

function moverColumns(): DataGridColumn<VarianceMover>[] {
  return [
    {
      key: "employee",
      header: t("hr.leavecost.variance.col.employee"),
      sortable: true,
      sortValue: (row) => row.displayName ?? "",
      render: (row) => (
        <span className="flex flex-col gap-1">
          <PersonCell name={row.displayName} code={row.employeeCode} />
          {row.flagged ? (
            <StatusChip
              status="flagged"
              map={{
                flagged: { label: t("hr.leavecost.variance.flaggedChip"), tone: "danger" },
              }}
            />
          ) : null}
        </span>
      ),
    },
    {
      key: "previousPaise",
      header: t("hr.leavecost.variance.col.previous"),
      align: "right",
      width: "9rem",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.previousPaise,
      // NULL is "no earlier payslip", never zero — and a mover with no previous amount
      // cannot occur (the aggregate excludes them), so this is the defensive branch.
      render: (row) =>
        row.previousPaise === null ? (
          <span className="text-muted-foreground">{t("hr.leavecost.variance.noPrevious")}</span>
        ) : (
          <Money paise={row.previousPaise} />
        ),
    },
    {
      key: "currentPaise",
      header: t("hr.leavecost.variance.col.current"),
      align: "right",
      width: "9rem",
      sortable: true,
      sortValue: (row) => row.currentPaise,
      render: (row) => <Money paise={row.currentPaise} />,
    },
    {
      key: "variancePaise",
      header: t("hr.leavecost.variance.col.change"),
      align: "right",
      width: "9rem",
      sortable: true,
      sortValue: (row) => row.variancePaise,
      render: (row) => (
        <Money
          paise={row.variancePaise}
          className={row.variancePaise < 0 ? "text-destructive" : "text-success"}
        />
      ),
    },
    {
      key: "variancePct",
      header: t("hr.leavecost.variance.col.changePct"),
      align: "right",
      width: "8rem",
      hideBelow: "md",
      sortable: true,
      sortValue: (row) => row.variancePct,
      // NOT clamped: this is a change, not a share of a whole, and a 140% rise is a
      // real 140% rise that a reviewer must see.
      render: (row) => (
        <span className={row.flagged ? "num text-destructive" : "num"}>
          {formatPercent(row.variancePct)}
        </span>
      ),
    },
  ];
}

// -----------------------------------------------------------------------------
// Export column sets — the same named columns the grids show
// -----------------------------------------------------------------------------

const LIABILITY_EXPORT_COLUMNS: readonly ExportColumn<LeaveTypeBalance>[] = [
  { key: "leaveTypeCode", header: t("hr.leavecost.liability.col.code"), format: "text" },
  { key: "leaveTypeName", header: t("hr.leavecost.liability.col.type"), format: "text" },
  { key: "employees", header: t("hr.leavecost.liability.col.employees"), format: "number" },
  { key: "entitlementDays", header: t("hr.leavecost.liability.col.entitlement"), format: "days" },
  { key: "availedDays", header: t("hr.leavecost.liability.col.availed"), format: "days" },
  { key: "pendingDays", header: t("hr.leavecost.liability.col.pending"), format: "days" },
  { key: "lapsedDays", header: t("hr.leavecost.liability.col.lapsed"), format: "days" },
  { key: "availableDays", header: t("hr.leavecost.liability.col.available"), format: "days" },
  {
    key: "avgAvailableDaysPerEmployee",
    header: t("hr.leavecost.liability.col.avgPerEmployee"),
    format: "daysFixed",
  },
];

const COST_EXPORT_COLUMNS: readonly ExportColumn<CostCell>[] = [
  { key: "month", header: t("hr.leavecost.cost.col.month"), format: "month" },
  {
    key: "departmentName",
    header: t("hr.leavecost.cost.col.department"),
    format: (row) => row.departmentName ?? t("hr.leavecost.unassigned"),
  },
  { key: "costCentres", header: t("hr.leavecost.cost.col.cells"), format: "number" },
  { key: "grossPaise", header: t("hr.leavecost.cost.col.gross"), format: "paise" },
  { key: "employerCostPaise", header: t("hr.leavecost.cost.col.employer"), format: "paise" },
  { key: "overtimeCostPaise", header: t("hr.leavecost.cost.col.overtime"), format: "paise" },
  { key: "totalCostPaise", header: t("hr.leavecost.cost.col.total"), format: "paise" },
];
