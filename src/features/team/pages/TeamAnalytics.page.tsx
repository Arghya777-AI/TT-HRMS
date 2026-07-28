/**
 * §D · /team/analytics — Team Analytics. Late arrivals, hours worked and breaks
 * for my team, every figure lifted from the metric dictionary.
 *
 * THE ONE SOURCE. Every number and every plotted point on this screen comes from
 * `f_attendance_period_summary(p_from, p_to, p_employee_id)` — the single
 * implementation of the §9.2 metric dictionary — read through the existing
 * `useTeamPeriodSummaries`, or from `count=exact` reads through `useTeamDayCount`.
 * `late_pct` and `attendance_pct` arrive already computed and already clamped by
 * `fn_late_pct`; `avg_worked_minutes_per_working_day` arrives already averaged BY
 * POSTGRES over the working days it decided were working days. Nothing on this
 * page divides, sums or averages anything.
 *
 * WHY THERE IS NO SINGLE TEAM-WIDE LINE. A "team late %" for a month would be an
 * aggregate of aggregates, and this backend exposes no relation that groups the
 * summary by team — so the trend plots one line PER PERSON, each point that
 * person's own server value. Four lines is the palette's validated ceiling, and
 * when the team is larger the screen says whose lines are drawn rather than
 * quietly picking.
 *
 * WHAT IS MISSING, and is therefore absent rather than approximated:
 *  * `v_team_punches` does not exist (it is named only in migration comments), so
 *    there is no punch-level or gate-level analysis here.
 *  * `v_attendance_late_trend` and `v_break_trend` are org-wide GROUP BY date with
 *    no employee column, so a manager reading them would get their own days mixed
 *    into the team's picture. They are deliberately not used.
 *
 * @route /team/analytics
 */
import { useMemo, useState } from "react";
import { BarChart3, Users } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { addIstMonths, fmtDurationHm, fmtMonthLong, istMonthRange, nowIstMonth } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "@/features/admin/components/Notice";
import { MonthStepper } from "@/features/admin/components/MonthStepper";
import {
  RankedBarsChart,
  TrendLinesChart,
  type ChartPoint,
  type ChartSeries,
} from "@/features/admin/components/AnalyticsOpsCharts";
import { MAX_SERIES } from "@/features/admin/analytics-ops-palette";
import type { TeamMember, TeamPeriodSummary } from "../api/team.api";
import {
  useTeamDayCount,
  useTeamPeriodSummaries,
  useTeamRoster,
} from "../hooks/useTeamDecisions";

/** How many months the trend covers, including the selected one. */
const TREND_MONTHS = 6;

const percentFormat = (value: number | null): string =>
  value === null ? dash(null) : formatPercent(value);
const countFormat = (value: number | null): string =>
  value === null ? dash(null) : formatNumber(value);
const durationFormat = (value: number | null): string =>
  value === null ? dash(null) : fmtDurationHm(value);

/**
 * Chart categories must be unique — two bars with the same label would collapse
 * into one. The employee code is appended ONLY when a display name repeats, so
 * identity is never needlessly glued together (DR-23).
 */
function chartLabels(members: readonly TeamMember[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const m of members) seen.set(m.display_name, (seen.get(m.display_name) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const m of members) {
    labels.set(
      m.id,
      (seen.get(m.display_name) ?? 0) > 1 ? `${m.display_name} · ${m.employee_code}` : m.display_name,
    );
  }
  return labels;
}

/** summary rows keyed by employee, so a chart can look one person's month up. */
function byEmployee(rows: readonly TeamPeriodSummary[]): Map<string, TeamPeriodSummary> {
  const map = new Map<string, TeamPeriodSummary>();
  for (const row of rows) map.set(row.employee_id, row);
  return map;
}

export default function TeamAnalyticsPage() {
  const team = useTeamRoster();
  const members = useMemo(() => team.data?.members ?? [], [team.data]);
  const employeeIds = useMemo(() => team.data?.employeeIds ?? [], [team.data]);

  const [month, setMonth] = useState(() => nowIstMonth());

  /**
   * Six months of the SAME server function, one call per month. Written out
   * because hooks cannot be called in a loop — and each call is independently
   * cached, so stepping the month re-uses five of the six.
   */
  const months = useMemo(
    () => Array.from({ length: TREND_MONTHS }, (_, k) => addIstMonths(month, -(TREND_MONTHS - 1 - k))),
    [month],
  );
  /*
    THIS SCREEN KEEPS ITS MONTH STEPPER, deliberately. The chart is a month-over-month
    trend: six calls to the same server function, one per calendar month. A day or a
    custom range is not a narrower version of that question, it is a different chart —
    so offering the shared period here would be a control that cannot mean what it says.
    The other team screens (attendance, leave) read per-day rows and DID move.

    The window is expanded here now that `useTeamPeriodSummaries` takes (from, to):
    the function `f_attendance_period_summary` never cared about months.
  */
  const windows = useMemo(
    () => months.map((m) => istMonthRange(m)),
    [months],
  );
  const w = (k: number) => windows[k] ?? istMonthRange(month);
  const m0 = useTeamPeriodSummaries(w(0).from, w(0).to, employeeIds);
  const m1 = useTeamPeriodSummaries(w(1).from, w(1).to, employeeIds);
  const m2 = useTeamPeriodSummaries(w(2).from, w(2).to, employeeIds);
  const m3 = useTeamPeriodSummaries(w(3).from, w(3).to, employeeIds);
  const m4 = useTeamPeriodSummaries(w(4).from, w(4).to, employeeIds);
  const m5 = useTeamPeriodSummaries(w(5).from, w(5).to, employeeIds);
  /** The selected month is the LAST of the six. */
  const current = m5;

  // Exception tiles for the selected month — the same counts /team/attendance
  // opens, so the two screens cannot disagree about how many late days there were.
  const selected = useMemo(() => istMonthRange(month), [month]);
  const base = useMemo(
    () => ({ from: selected.from, to: selected.to, employeeIds }),
    [selected.from, selected.to, employeeIds],
  );
  const lateCount = useTeamDayCount(base, "late");
  const earlyExitCount = useTeamDayCount(base, "early_exit");
  const absentCount = useTeamDayCount(base, "absent");
  const leaveCount = useTeamDayCount(base, "on_leave");
  const exceptionCount = useTeamDayCount(base, "exceptions");

  const labels = useMemo(() => chartLabels(members), [members]);
  const currentByEmployee = useMemo(() => byEmployee(current.data ?? []), [current.data]);

  /** Ranked charts: one point per person, in the view's own name order. */
  const rankedPoints = useMemo(
    () =>
      members.map((m) => {
        const row = currentByEmployee.get(m.id);
        return {
          x: labels.get(m.id) ?? m.display_name,
          values: {
            attendance_pct: row?.attendance_pct ?? null,
            late_days: row?.late_days ?? null,
            avg_worked: row?.avg_worked_minutes_per_working_day ?? null,
            break_minutes: row?.break_minutes ?? null,
          },
        } satisfies ChartPoint;
      }),
    [members, currentByEmployee, labels],
  );

  /** Trend: up to four people, six months, `attendance_pct` unchanged. */
  const trendMembers = useMemo(() => members.slice(0, MAX_SERIES), [members]);
  const trendSeries: readonly ChartSeries[] = useMemo(
    () => trendMembers.map((m) => ({ key: m.id, label: labels.get(m.id) ?? m.display_name })),
    [trendMembers, labels],
  );
  const monthlyMaps = useMemo(
    () => [m0.data, m1.data, m2.data, m3.data, m4.data, m5.data].map((rows) => byEmployee(rows ?? [])),
    [m0.data, m1.data, m2.data, m3.data, m4.data, m5.data],
  );
  const trendPoints: readonly ChartPoint[] = useMemo(
    () =>
      months.map((key, index) => {
        const map = monthlyMaps[index];
        const values: Record<string, number | null> = {};
        for (const m of trendMembers) values[m.id] = map?.get(m.id)?.attendance_pct ?? null;
        return { x: fmtMonthLong(key), values };
      }),
    [months, monthlyMaps, trendMembers],
  );

  const noTeam = team.data?.isEmpty === true;
  const clipped = members.length > MAX_SERIES;

  return (
    <div className="container py-6">
      <PageHeader
        icon={BarChart3}
        title={t("team.analytics.title")}
        subtitle={t("team.analytics.subtitle", { n: formatNumber(employeeIds.length) })}
        actions={<MonthStepper month={month} onChange={setMonth} />}
      />

      {noTeam ? (
        <div className="mt-6">
          <EmptyState
            icon={Users}
            title={t("team.analytics.noTeam.title")}
            hint={t("team.analytics.noTeam.hint")}
          />
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Tile label={t("team.analytics.tile.late")} query={lateCount} />
            <Tile label={t("team.analytics.tile.earlyExit")} query={earlyExitCount} />
            <Tile label={t("team.analytics.tile.absent")} query={absentCount} />
            <Tile label={t("team.analytics.tile.leave")} query={leaveCount} />
            <Tile label={t("team.analytics.tile.exceptions")} query={exceptionCount} />
          </div>

          <section className="mt-4 rounded-lg border bg-card p-4">
            <StateBoundary
              loading={current.isPending || team.isPending}
              error={current.error ?? team.error}
              onRetry={() => void current.refetch()}
              isEmpty={(current.data ?? []).length === 0}
              empty={
                <EmptyState
                  icon={BarChart3}
                  title={t("team.analytics.empty.title")}
                  hint={t("team.analytics.empty.hint")}
                />
              }
              skeletonRows={4}
            >
              <div className="grid gap-8 xl:grid-cols-2">
                <RankedBarsChart
                  title={t("team.analytics.chart.attendance.title")}
                  caption={t("team.analytics.chart.attendance.caption", {
                    month: fmtMonthLong(month),
                  })}
                  measure={{ key: "attendance_pct", label: t("team.analytics.measure.attendance") }}
                  points={rankedPoints}
                  format={percentFormat}
                  xHeader={t("team.analytics.chart.person")}
                />
                <RankedBarsChart
                  title={t("team.analytics.chart.late.title")}
                  caption={t("team.analytics.chart.late.caption", { month: fmtMonthLong(month) })}
                  measure={{ key: "late_days", label: t("team.analytics.measure.late") }}
                  points={rankedPoints}
                  format={countFormat}
                  xHeader={t("team.analytics.chart.person")}
                />
                <RankedBarsChart
                  title={t("team.analytics.chart.worked.title")}
                  caption={t("team.analytics.chart.worked.caption", { month: fmtMonthLong(month) })}
                  measure={{ key: "avg_worked", label: t("team.analytics.measure.worked") }}
                  points={rankedPoints}
                  format={durationFormat}
                  xHeader={t("team.analytics.chart.person")}
                />
                <RankedBarsChart
                  title={t("team.analytics.chart.breaks.title")}
                  caption={t("team.analytics.chart.breaks.caption", { month: fmtMonthLong(month) })}
                  measure={{ key: "break_minutes", label: t("team.analytics.measure.breaks") }}
                  points={rankedPoints}
                  format={durationFormat}
                  xHeader={t("team.analytics.chart.person")}
                />
              </div>
            </StateBoundary>
          </section>

          <section className="mt-4 rounded-lg border bg-card p-4">
            <StateBoundary
              loading={m0.isPending || m1.isPending || m2.isPending}
              error={m0.error ?? m1.error ?? m2.error ?? m3.error ?? m4.error ?? m5.error}
              onRetry={() => {
                void m0.refetch();
                void m1.refetch();
                void m2.refetch();
                void m3.refetch();
                void m4.refetch();
                void m5.refetch();
              }}
              isEmpty={trendSeries.length === 0}
              empty={
                <p className="text-sm text-muted-foreground">{t("team.analytics.trend.empty")}</p>
              }
              skeletonRows={4}
            >
              <TrendLinesChart
                title={t("team.analytics.trend.title")}
                caption={t("team.analytics.trend.caption")}
                series={trendSeries}
                points={trendPoints}
                format={percentFormat}
                xHeader={t("team.analytics.trend.xHeader")}
                yMax={100}
              />
            </StateBoundary>
            {clipped ? (
              <div className="mt-3">
                <Notice tone="info">
                  {t("team.analytics.trend.clipped", {
                    drawn: formatNumber(trendSeries.length),
                    total: formatNumber(members.length),
                  })}
                </Notice>
              </div>
            ) : null}
          </section>

          <div className="mt-4 space-y-2">
            <Notice tone="info">{t("team.analytics.gap.noPunches")}</Notice>
            <Notice tone="info">{t("team.analytics.footnote")}</Notice>
          </div>
        </>
      )}
    </div>
  );
}

/** A tile: one server count, or an em dash and the reason it cannot be read. */
function Tile({
  label,
  query,
}: {
  label: string;
  query: { data: number | undefined; error: Error | null; isPending: boolean };
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num mt-1 font-display text-xl font-semibold">
        {query.isPending
          ? "…"
          : query.error !== null
            ? t("common.empty")
            : formatNumber(query.data)}
      </p>
    </div>
  );
}
