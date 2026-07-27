/**
 * §14 · /admin/analytics/workforce — headcount, joiners, exits and attrition.
 *
 * Two SEPARATE sources sit on this page, and the page says which is which
 * rather than blending them into one authoritative-looking number:
 *
 *  1. THE BREAKDOWNS ARE LIVE SERVER COUNTS. Headcount by department, by
 *     employment type and by lifecycle state is one `count=exact` per slice over
 *     `v_admin_employee`, using the employee directory's own predicates
 *     (`deleted_at IS NULL` + the status set). So each bar equals exactly the
 *     rows `/admin/people` would list, and no slice is a client-side group-by.
 *     The "not assigned" slice exists because `department_id IS NULL` rows would
 *     otherwise vanish between the departments and the total.
 *  2. THE SERIES IS MATVIEW-BACKED. Joiners, exits, average headcount, annualised
 *     attrition and the tenure buckets are columns of `v_headcount_monthly`
 *     (live over `analytics.mv_headcount_daily`), so they are as of the last
 *     refresh — printed at the top of the page from the matview's own
 *     `refreshed_at`. `public.refresh_analytics()` is granted to `service_role`
 *     only, so this screen cannot offer a "refresh now" button; the scheduled
 *     job is the only refresher and pretending otherwise would be a fake control.
 *
 * What is deliberately NOT here:
 *
 *  * An ORG-WIDE joiner/exit chart. `v_headcount_monthly` groups by
 *    (year, month, department) and has no rollup row — the "no department" row is
 *    a department, not a total. Summing departments in the browser to draw one
 *    line is precisely the arithmetic this codebase forbids, so the chart asks
 *    for a department first and says so.
 *  * A joiner/exit series taken from the lifecycle stream. There is no analytics
 *    view over `employee_lifecycle_events`; what IS honest is a COUNT of
 *    un-reversed events per type in the year, and that is what the event strip
 *    shows — labelled as event counts, not as headcount movement.
 *
 * @route /admin/analytics/workforce
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
import { BarChart3, Users } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { KpiTile } from "@/shared/ui/KpiTile";
import { Skeleton } from "@/components/ui/skeleton";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { fmtDateTime, fmtMonthLong, nowIstDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { CountTile } from "../components/CountTile";
import { Notice } from "../components/Notice";
import { SelectField, type SelectOption } from "../components/Field";
import { unavailableHint } from "../command-vocab";
import { useRefOptions } from "../hooks/useMasters";
import {
  useHeadcountByDepartment,
  useHeadcountByStatus,
  useHeadcountByType,
  useHeadcountMonthly,
  useHeadcountStamp,
  useLifecycleCounts,
  useOnRollCount,
  type CountSlice,
} from "../hooks/useAnalyticsWorkforce";
import {
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  employmentStatusSchema,
  employmentTypeSchema,
} from "../api/employees.api";
import type { HeadcountMonthlyRow } from "../api/analytics-workforce.api";

const LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
  joined: t("admin.analytics.wf.event.joined"),
  confirmed: t("admin.analytics.wf.event.confirmed"),
  promoted: t("admin.analytics.wf.event.promoted"),
  transferred: t("admin.analytics.wf.event.transferred"),
  resigned: t("admin.analytics.wf.event.resigned"),
  terminated: t("admin.analytics.wf.event.terminated"),
};

/** Lifecycle states worth their own tile beside the on-roll total. */
const TILE_STATUSES = ["on_probation", "on_notice", "exited"] as const;

const GRID_STROKE = "hsl(var(--border))";
const BAR_FILL = "hsl(var(--chart-1))";
const JOINER_STROKE = "hsl(var(--chart-5))";
const EXIT_STROKE = "hsl(var(--chart-4))";

/** Human label for a slice whose `label` is still the raw enum value. */
function statusLabel(key: string): string {
  const parsed = employmentStatusSchema.safeParse(key);
  return parsed.success ? EMPLOYMENT_STATUS_LABELS[parsed.data] : key;
}

function typeLabel(key: string): string {
  const parsed = employmentTypeSchema.safeParse(key);
  return parsed.success ? EMPLOYMENT_TYPE_LABELS[parsed.data] : key;
}

/** A slice as the grids and the chart consume it: label + the server's count. */
interface SliceRow {
  readonly key: string;
  readonly label: string;
  readonly count: number | null;
  readonly unreadable: string | null;
}

function toRows(slices: readonly CountSlice[], relabel?: (key: string) => string): SliceRow[] {
  return slices.map((slice) => ({
    key: slice.key,
    label: relabel === undefined ? slice.label : relabel(slice.key),
    count: slice.query.data ?? null,
    unreadable: slice.query.error !== null ? unavailableHint(slice.query.error) : null,
  }));
}

const sliceColumns: DataGridColumn<SliceRow>[] = [
  { key: "label", header: t("admin.analytics.wf.col.slice"), width: "16rem" },
  {
    key: "count",
    header: t("admin.analytics.wf.col.headcount"),
    width: "10rem",
    align: "right",
    sortable: true,
    sortValue: (row) => row.count,
    render: (row) =>
      row.unreadable !== null ? (
        <span className="text-xs text-muted-foreground">{row.unreadable}</span>
      ) : (
        <span className="num">{dash(row.count, formatNumber)}</span>
      ),
  },
];

/** The years the year picker offers — this year and the four before it. */
function yearOptions(): SelectOption[] {
  const thisYear = Number(nowIstDate().slice(0, 4));
  return [0, 1, 2, 3, 4].map((back) => {
    const year = thisYear - back;
    return { value: String(year), label: String(year) };
  });
}

export default function AnalyticsWorkforcePage() {
  const [params, setParams] = useSearchParams();

  const thisYear = Number(nowIstDate().slice(0, 4));
  const yearParam = Number(params.get("year") ?? "");
  const year = Number.isInteger(yearParam) && yearParam > 2000 ? yearParam : thisYear;
  const departmentId = params.get("department") ?? "";

  const departments = useRefOptions("departments");
  const departmentChoices: SelectOption[] = useMemo(
    () => (departments.data ?? []).map((d) => ({ value: d.id, label: d.name })),
    [departments.data],
  );

  const onRoll = useOnRollCount();
  const byStatus = useHeadcountByStatus();
  const byType = useHeadcountByType();
  const byDepartment = useHeadcountByDepartment(
    departments.data ?? [],
    t("admin.analytics.wf.noDepartment"),
  );
  const stamp = useHeadcountStamp();
  const lifecycle = useLifecycleCounts(year);
  const monthly = useHeadcountMonthly(year, departmentId === "" ? null : departmentId);

  const statusByKey = useMemo(() => {
    const map = new Map<string, CountSlice>();
    for (const slice of byStatus) map.set(slice.key, slice);
    return map;
  }, [byStatus]);

  const departmentRows = useMemo(() => toRows(byDepartment), [byDepartment]);
  const typeRows = useMemo(() => toRows(byType, typeLabel), [byType]);
  const statusRows = useMemo(() => toRows(byStatus, statusLabel), [byStatus]);

  /** Bars only for departments whose count actually arrived. */
  const departmentBars = departmentRows.filter((row) => row.count !== null);

  // Memoised because the joiner/exit series derives from it.
  const monthlyRows = useMemo(() => monthly.data ?? [], [monthly.data]);
  const singleDepartment = departmentId !== "";

  /** One point per month for the chosen department — server columns, no sums. */
  const seriesPoints = useMemo(
    () =>
      monthlyRows.map((row) => ({
        month: row.month,
        label: fmtMonthLong(`${String(row.year)}-${String(row.month).padStart(2, "0")}`),
        joiners: row.joiners,
        exits: row.exits,
      })),
    [monthlyRows],
  );

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  const monthlyColumns: DataGridColumn<HeadcountMonthlyRow>[] = useMemo(
    () => [
      {
        key: "month",
        header: t("admin.analytics.wf.col.month"),
        width: "9rem",
        sortable: true,
        sortValue: (row) => row.month,
        render: (row) => fmtMonthLong(`${String(row.year)}-${String(row.month).padStart(2, "0")}`),
      },
      {
        key: "department_name",
        header: t("admin.analytics.wf.col.department"),
        width: "12rem",
        sortable: true,
        render: (row) => dash(row.department_name),
      },
      {
        key: "avg_headcount",
        header: t("admin.analytics.wf.col.avgHeadcount"),
        width: "9rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.avg_headcount,
        render: (row) => <span className="num">{dash(row.avg_headcount, formatNumber)}</span>,
      },
      {
        key: "joiners",
        header: t("admin.analytics.wf.col.joiners"),
        width: "7rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.joiners)}</span>,
      },
      {
        key: "exits",
        header: t("admin.analytics.wf.col.exits"),
        width: "7rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.exits)}</span>,
      },
      {
        key: "attrition_pct",
        header: t("admin.analytics.wf.col.attrition"),
        width: "9rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.attrition_pct,
        hideBelow: "md",
        // Annualised by the view; NOT clamped, because 600% in a two-person
        // department is a real reading and hiding it would be the defect.
        render: (row) => <span className="num">{formatPercent(row.attrition_pct, { digits: 1 })}</span>,
      },
      {
        key: "probation_count",
        header: t("admin.analytics.wf.col.probation"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{dash(row.probation_count, formatNumber)}</span>,
      },
      {
        key: "tenure_lt_1y",
        header: t("admin.analytics.wf.col.tenureLt1"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{dash(row.tenure_lt_1y, formatNumber)}</span>,
      },
      {
        key: "tenure_1_3y",
        header: t("admin.analytics.wf.col.tenure13"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{dash(row.tenure_1_3y, formatNumber)}</span>,
      },
      {
        key: "tenure_3_5y",
        header: t("admin.analytics.wf.col.tenure35"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{dash(row.tenure_3_5y, formatNumber)}</span>,
      },
      {
        key: "tenure_ge_5y",
        header: t("admin.analytics.wf.col.tenureGe5"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{dash(row.tenure_ge_5y, formatNumber)}</span>,
      },
    ],
    [],
  );

  const asOf = stamp.data;

  return (
    <div className="container py-6">
      <PageHeader
        icon={BarChart3}
        title={t("admin.analytics.wf.title")}
        subtitle={t("admin.analytics.wf.subtitle")}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label={t("admin.analytics.wf.filter.year")}
              value={String(year)}
              options={yearOptions()}
              onChange={(v) => setParam("year", v)}
            />
            <SelectField
              label={t("admin.analytics.wf.filter.department")}
              value={departmentId}
              placeholder={t("admin.analytics.wf.filter.anyDepartment")}
              options={departmentChoices}
              onChange={(v) => setParam("department", v)}
            />
          </div>
        }
      />

      {/* Live counts first — these are not matview figures and must not be read as such. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CountTile
          label={t("admin.analytics.wf.tile.onRoll")}
          hint={t("admin.analytics.wf.tile.onRollHint")}
          to="/admin/people"
          drillLabel={t("admin.analytics.wf.tile.onRollDrill")}
          source={t("admin.analytics.wf.source.directory")}
          query={onRoll}
        />
        {TILE_STATUSES.map((status) => {
          const slice = statusByKey.get(status);
          return (
            <CountTile
              key={status}
              label={statusLabel(status)}
              hint={t("admin.analytics.wf.tile.statusHint")}
              to="/admin/people/lifecycle"
              drillLabel={t("admin.analytics.wf.tile.statusDrill")}
              source={t("admin.analytics.wf.source.directory")}
              query={slice?.query ?? { data: undefined, error: null, isPending: true }}
            />
          );
        })}
      </div>

      <p className="num mt-3 text-xs text-muted-foreground">
        {asOf == null
          ? t("admin.analytics.wf.asOfUnknown")
          : t("admin.analytics.wf.asOf", {
              at: fmtDateTime(asOf.refreshed_at),
              date: asOf.as_of_date,
            })}
      </p>

      {/* Headcount by department — bar chart + the same numbers as a table. */}
      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">{t("admin.analytics.wf.byDept.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.wf.byDept.hint")}</p>
        <StateBoundary
          loading={departments.isPending}
          error={departments.error}
          onRetry={() => void departments.refetch()}
          isEmpty={departmentRows.length === 0}
          empty={
            <EmptyState
              icon={Users}
              title={t("admin.analytics.wf.byDept.empty.title")}
              hint={t("admin.analytics.wf.byDept.empty.hint")}
            />
          }
        >
          <figure className="mt-3 m-0 rounded-lg border bg-card p-4">
            <div className="overflow-x-auto">
              <div className="h-72 min-w-[520px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={departmentBars}
                    layout="vertical"
                    margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
                    accessibilityLayer
                  >
                    <CartesianGrid stroke={GRID_STROKE} horizontal={false} />
                    <XAxis
                      type="number"
                      allowDecimals={false}
                      tick={{ fontSize: 12 }}
                      stroke={GRID_STROKE}
                      tickLine={false}
                      className="fill-muted-foreground"
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={150}
                      tick={{ fontSize: 12 }}
                      stroke={GRID_STROKE}
                      tickLine={false}
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
                      dataKey="count"
                      name={t("admin.analytics.wf.col.headcount")}
                      fill={BAR_FILL}
                      radius={[0, 4, 4, 0]}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <figcaption className="mt-2 text-xs text-muted-foreground">
              {t("admin.analytics.wf.byDept.caption")}
            </figcaption>
          </figure>
          <div className="mt-3">
            <DataGrid
              columns={sliceColumns}
              rows={departmentRows}
              rowKey={(row) => row.key}
              pageSize={25}
            />
          </div>
        </StateBoundary>
      </section>

      {/* Employment type and lifecycle state — tables, same server counts. */}
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="font-display text-lg font-semibold">{t("admin.analytics.wf.byType.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.wf.byType.hint")}</p>
          <div className="mt-3">
            <DataGrid columns={sliceColumns} rows={typeRows} rowKey={(row) => row.key} pageSize={10} />
          </div>
        </div>
        <div>
          <h2 className="font-display text-lg font-semibold">{t("admin.analytics.wf.byStatus.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.wf.byStatus.hint")}</p>
          <div className="mt-3">
            <DataGrid columns={sliceColumns} rows={statusRows} rowKey={(row) => row.key} pageSize={11} />
          </div>
        </div>
      </section>

      {/* Lifecycle events recorded in the chosen year — counts, not movement. */}
      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">
          {t("admin.analytics.wf.events.title", { year: String(year) })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.wf.events.hint")}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {lifecycle.map((slice) => (
            <KpiTile
              key={slice.key}
              label={LIFECYCLE_LABELS[slice.key] ?? slice.key}
              value={
                slice.query.isPending ? (
                  <Skeleton className="h-7 w-10" />
                ) : slice.query.error !== null ? (
                  dash(null)
                ) : (
                  formatNumber(slice.query.data ?? 0)
                )
              }
              hint={
                slice.query.error !== null
                  ? unavailableHint(slice.query.error)
                  : t("admin.analytics.wf.events.tileHint")
              }
              to="/admin/people/lifecycle"
              drillLabel={t("admin.analytics.wf.events.drill")}
            />
          ))}
        </div>
      </section>

      {/* The matview series. Per department, because there is no rollup row. */}
      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">
          {t("admin.analytics.wf.series.title", { year: String(year) })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.analytics.wf.series.hint")}</p>

        {singleDepartment ? null : (
          <div className="mt-3">
            <Notice tone="warning">{t("admin.analytics.wf.series.needDepartment")}</Notice>
          </div>
        )}

        <StateBoundary
          loading={monthly.isPending}
          error={monthly.error}
          onRetry={() => void monthly.refetch()}
          isEmpty={monthlyRows.length === 0}
          empty={
            <EmptyState
              icon={BarChart3}
              title={t("admin.analytics.wf.series.empty.title")}
              hint={t("admin.analytics.wf.series.empty.hint")}
            />
          }
        >
          {singleDepartment && seriesPoints.length > 0 ? (
            <figure className="mt-3 m-0 rounded-lg border bg-card p-4">
              <div className="overflow-x-auto">
                <div className="h-64 min-w-[520px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={seriesPoints}
                      margin={{ top: 12, right: 20, bottom: 4, left: 8 }}
                      accessibilityLayer
                    >
                      <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 12 }}
                        stroke={GRID_STROKE}
                        tickLine={false}
                        minTickGap={16}
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
                        dataKey="joiners"
                        name={t("admin.analytics.wf.col.joiners")}
                        stroke={JOINER_STROKE}
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        isAnimationActive={false}
                      />
                      <Line
                        type="linear"
                        dataKey="exits"
                        name={t("admin.analytics.wf.col.exits")}
                        stroke={EXIT_STROKE}
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <figcaption className="mt-2 text-xs text-muted-foreground">
                {t("admin.analytics.wf.series.caption")}
              </figcaption>
            </figure>
          ) : null}

          <div className="mt-3">
            <DataGrid
              columns={monthlyColumns}
              rows={monthlyRows}
              rowKey={(row) =>
                `${String(row.year)}-${String(row.month)}-${row.department_id ?? "none"}`
              }
              pageSize={25}
            />
          </div>
        </StateBoundary>
      </section>

      <div className="mt-6 space-y-3">
        <Notice tone="info">{t("admin.analytics.wf.footnote.sources")}</Notice>
        <Notice tone="warning">{t("admin.analytics.wf.footnote.gaps")}</Notice>
      </div>
    </div>
  );
}
