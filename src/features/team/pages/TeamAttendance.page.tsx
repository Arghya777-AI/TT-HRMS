/**
 * §D · /team/attendance — Team Attendance. My team's days, exceptions and
 * trends, one month at a time.
 *
 * Rules held here (spec-manager, frontend contract §6):
 *
 *  1. SCOPE IS THE ROSTER'S. Every read is narrowed to the ids the reporting
 *     closure resolved (`useTeamRoster`) — the manager's own days belong on
 *     /me/attendance, not in their team's exception counts. RLS decided which
 *     rows exist at all; the narrowing is correctness, not security.
 *  2. NOTHING IS DERIVED HERE. `worked_hm`, `late_hm`, the status and the
 *     anomaly flags are view columns; the month roll-ups (late %, attendance %,
 *     average worked) come from `f_attendance_period_summary`, the ONE
 *     implementation of the metric dictionary. This page prints them.
 *  3. UNAPPROVED OVERTIME IS SHOWN, NOT COMPUTED. The sanctioned filter
 *     vocabulary cannot express `overtime > approved_overtime`, and the browser
 *     must not subtract it either — both columns are printed side by side, so
 *     the gap is visible without arithmetic.
 *
 * @route /team/attendance
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays, Clock, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDateWeekday, fmtDuration } from "@/lib/datetime";
import { dash, formatDays, formatNumber, formatPercent } from "@/lib/format";
import { SplitBar, type SplitSegment } from "@/shared/ui/charts/SplitBar";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "@/features/admin/components/Notice";
import { PersonCell } from "@/features/admin/components/PersonCell";
import { PeriodBar } from "@/features/admin/components/PeriodBar";
import { useAnalyticsFilters } from "@/features/admin/hooks/useAnalyticsFilters";
import {
  DAY_STATUS_CHIP,
  isTeamDaySlice,
  type TeamDay,
  type TeamDaySlice,
} from "../api/team.api";
import { useTeamRoster } from "../hooks/useTeamDecisions";
import {
  useTeamDayCount,
  useTeamDays,
  useTeamPeriodSummaries,
} from "../hooks/useTeamDecisions";

const SLICE_ORDER: readonly TeamDaySlice[] = [
  "all",
  "exceptions",
  "late",
  "early_exit",
  "absent",
  "on_leave",
  "regularized",
];

function sliceLabel(slice: TeamDaySlice): string {
  switch (slice) {
    case "all":
      return t("team.att.slice.all");
    case "exceptions":
      return t("team.att.slice.exceptions");
    case "late":
      return t("team.att.slice.late");
    case "early_exit":
      return t("team.att.slice.earlyExit");
    case "absent":
      return t("team.att.slice.absent");
    case "on_leave":
      return t("team.att.slice.onLeave");
    case "regularized":
      return t("team.att.slice.regularized");
  }
}

/** One tile = one server count over the same predicate as the grid. */
function SliceTile({
  slice,
  active,
  onClick,
  count,
}: {
  slice: TeamDaySlice;
  active: boolean;
  onClick: () => void;
  count: { data: number | undefined; isPending: boolean; error: Error | null };
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "ring-2 ring-primary",
      )}
    >
      <p className="text-xs text-muted-foreground">{sliceLabel(slice)}</p>
      <p className="num mt-1 font-display text-xl font-semibold">
        {count.isPending ? "…" : count.error !== null ? "—" : formatNumber(count.data)}
      </p>
    </button>
  );
}

export default function TeamAttendancePage() {
  const [params, setParams] = useSearchParams();
  const roster = useTeamRoster();
  // Memoised so downstream deps get a stable reference while loading.
  const employeeIds = useMemo(() => roster.data?.employeeIds ?? [], [roster.data]);

  /*
    THE PERIOD IS SHARED with the analytics dashboard, read from the same url
    parameters. It replaces a `useState` month, which had two problems beyond being
    month-only: a manager could not LINK to what they were looking at, and stepping
    the month was invisible to the rest of the app. `v_team_attendance_days` and
    `v_team_leave_days` are per-day rows, so any period is a predicate they honour.
  */
  const { filters: analytics } = useAnalyticsFilters();
  const rawSlice = params.get("slice");
  const slice: TeamDaySlice = isTeamDaySlice(rawSlice) ? rawSlice : "all";

  const filters = useMemo(
    () => ({
      from: analytics.period.from,
      to: analytics.period.to,
      employeeIds,
      ...(slice !== "all" ? { slice } : {}),
    }),
    [analytics.period.from, analytics.period.to, employeeIds, slice],
  );

  const days = useTeamDays(filters);
  const rows = days.data ?? [];
  const summaries = useTeamPeriodSummaries(
    analytics.period.from,
    analytics.period.to,
    employeeIds,
  );

  // One count per slice tile, all sharing the month + roster predicate. The
  // hook takes the slice as its second argument (it overrides the filter's).
  // Written out one call per slice — hooks may not be called in a loop, and a
  // fixed record of seven calls is the honest version of that constraint.
  const base = {
    from: analytics.period.from,
    to: analytics.period.to,
    employeeIds,
  } as const;
  const counts: Record<TeamDaySlice, ReturnType<typeof useTeamDayCount>> = {
    all: useTeamDayCount(base, undefined),
    exceptions: useTeamDayCount(base, "exceptions"),
    late: useTeamDayCount(base, "late"),
    early_exit: useTeamDayCount(base, "early_exit"),
    absent: useTeamDayCount(base, "absent"),
    on_leave: useTeamDayCount(base, "on_leave"),
    regularized: useTeamDayCount(base, "regularized"),
  };

  const setSlice = (next: TeamDaySlice) => {
    const p = new URLSearchParams(params);
    if (next === "all") p.delete("slice");
    else p.set("slice", next);
    setParams(p, { replace: true });
  };

  const nameOf = useMemo(() => {
    const map = new Map<string, { name: string; code: string }>();
    for (const m of roster.data?.members ?? [])
      map.set(m.id, { name: m.display_name ?? "", code: m.employee_code ?? "" });
    return map;
  }, [roster.data]);

  const columns: DataGridColumn<TeamDay>[] = [
    {
      key: "ist_date",
      header: t("team.att.col.date"),
      width: "11rem",
      sortable: true,
      render: (r) => <span className="num">{fmtCivilDateWeekday(r.ist_date)}</span>,
    },
    {
      key: "display_name",
      header: t("team.att.col.who"),
      width: "13rem",
      sortable: true,
      render: (r) => <PersonCell name={r.display_name} code={r.employee_code} />,
    },
    {
      key: "shift_code",
      header: t("team.att.col.shift"),
      width: "6rem",
      hideBelow: "lg",
      render: (r) => dash(r.shift_code),
    },
    {
      key: "first_in_hm",
      header: t("team.att.col.firstIn"),
      align: "right",
      width: "7rem",
      render: (r) => <span className="num">{dash(r.first_in_hm)}</span>,
    },
    {
      key: "last_out_hm",
      header: t("team.att.col.lastOut"),
      align: "right",
      width: "7rem",
      render: (r) => <span className="num">{dash(r.last_out_hm)}</span>,
    },
    {
      key: "worked_hm",
      header: t("team.att.col.worked"),
      align: "right",
      width: "7rem",
      render: (r) => <span className="num">{dash(r.worked_hm)}</span>,
    },
    {
      key: "late_hm",
      header: t("team.att.col.late"),
      align: "right",
      width: "6rem",
      hideBelow: "md",
      render: (r) =>
        r.is_late === true ? (
          <span className="num text-warning">{dash(r.late_hm)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "overtime_minutes",
      header: t("team.att.col.ot"),
      align: "right",
      width: "9rem",
      hideBelow: "lg",
      // Both figures printed side by side — the gap is visible, never computed.
      render: (r) => (
        <span className="num">
          {fmtDuration(r.overtime_minutes)} / {fmtDuration(r.approved_overtime_minutes)}
        </span>
      ),
    },
    {
      key: "status",
      header: t("team.att.col.status"),
      width: "9rem",
      render: (r) =>
        r.status === null ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <StatusChip status={r.status} map={DAY_STATUS_CHIP} />
        ),
    },
    {
      key: "has_anomalies",
      header: t("team.att.col.flags"),
      hideBelow: "lg",
      render: (r) =>
        (r.anomaly_flags ?? []).length > 0 ? (
          <span className="text-xs text-warning">{(r.anomaly_flags ?? []).join(", ")}</span>
        ) : r.is_regularized === true ? (
          <span className="text-xs text-muted-foreground">{t("team.att.regularized")}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  const noTeam = roster.data?.isEmpty === true;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Clock}
        title={t("team.att.title")}
        subtitle={t("team.att.subtitle", { n: formatNumber(employeeIds.length) })}
      />

      <PeriodBar className="mb-4" />

      {noTeam ? (
        <div className="mt-6">
          <EmptyState
            icon={Users}
            title={t("team.att.noTeam.title")}
            hint={t("team.att.noTeam.hint")}
          />
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {SLICE_ORDER.map((s) => (
              <SliceTile
                key={s}
                slice={s}
                active={slice === s}
                onClick={() => setSlice(s)}
                count={counts[s]}
              />
            ))}
          </div>

          {/* Month roll-up per person — every figure a server column (§9.2). */}
          <section className="mt-4 rounded-lg border bg-card p-4">
            <h2 className="font-display text-sm font-semibold">{t("team.att.trend.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("team.att.trend.hint")}</p>
            <StateBoundary
              loading={summaries.isPending}
              error={summaries.error}
              onRetry={() => void summaries.refetch()}
              isEmpty={(summaries.data ?? []).length === 0}
              empty={<p className="mt-3 text-sm text-muted-foreground">{t("team.att.trend.empty")}</p>}
              skeletonRows={3}
            >
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[48rem] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="py-2 pr-4">{t("team.att.trend.person")}</th>
                      <th scope="col" className="py-2 pr-4 text-right">{t("team.att.trend.present")}</th>
                      <th scope="col" className="py-2 pr-4 text-right">{t("team.att.trend.absent")}</th>
                      <th scope="col" className="py-2 pr-4 text-right">{t("team.att.trend.leave")}</th>
                      <th scope="col" className="py-2 pr-4 text-right">{t("team.att.trend.lateDays")}</th>
                      <th scope="col" className="py-2 pr-4 text-right">{t("team.att.trend.latePct")}</th>
                      <th scope="col" className="py-2 pr-4 text-right">{t("team.att.trend.attendancePct")}</th>
                      <th scope="col" className="py-2 pr-0">{t("team.att.trend.split")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(summaries.data ?? []).map((s) => {
                      const who = nameOf.get(s.employee_id);
                      /*
                        THE BAR IS THE ROW, RE-DRAWN — not a fourth figure.

                        `present_days`, `absent_days` and `leave_days` are the
                        three cells immediately to its left, straight off
                        `f_attendance_period_summary`. Nothing is summed here:
                        `SplitBar` normalises the three into widths, which is the
                        same presentational step `DonutChart` takes, and the
                        counts themselves stay printed beside it.

                        Three tones, three meanings, matching the day chips the
                        grid below uses for the same states.

                        `leave_days` is `numeric` — half-days arrive as 7.5 — so
                        `formatDays` renders the legend, never `String()`.
                      */
                      const splitSegments: SplitSegment[] = [
                        {
                          key: "present",
                          label: t("team.att.trend.present"),
                          value: s.present_days,
                          tone: "present",
                        },
                        {
                          key: "absent",
                          label: t("team.att.trend.absent"),
                          value: s.absent_days,
                          tone: "absent",
                        },
                        {
                          key: "leave",
                          label: t("team.att.trend.leave"),
                          value: s.leave_days,
                          tone: "leave",
                        },
                      ];
                      return (
                        <tr key={s.employee_id} className="border-b last:border-0">
                          <td className="py-2 pr-4">
                            <PersonCell name={who?.name} code={who?.code} />
                          </td>
                          <td className="num py-2 pr-4 text-right">{formatNumber(s.present_days)}</td>
                          <td className="num py-2 pr-4 text-right">{formatNumber(s.absent_days)}</td>
                          <td className="num py-2 pr-4 text-right">{formatNumber(s.leave_days)}</td>
                          <td className="num py-2 pr-4 text-right">{formatNumber(s.late_days)}</td>
                          <td className="num py-2 pr-4 text-right">{formatPercent(s.late_pct)}</td>
                          <td className="num py-2 pr-4 text-right">{formatPercent(s.attendance_pct)}</td>
                          <td className="py-2 pr-0">
                            <SplitBar
                              segments={splitSegments}
                              title={t("team.att.trend.splitTitle", {
                                name: who?.name ?? dash(who?.code),
                              })}
                              format={formatDays}
                              legend={false}
                              className="min-w-[7rem]"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {t("team.att.trend.splitNote")}
              </p>
            </StateBoundary>
          </section>

          <div className="mt-4">
            <StateBoundary
              loading={days.isPending || roster.isPending}
              error={days.error ?? roster.error}
              onRetry={() => void days.refetch()}
              isEmpty={rows.length === 0}
              empty={
                <EmptyState
                  icon={CalendarDays}
                  title={slice === "all" ? t("team.att.empty.title") : t("team.att.empty.sliceTitle")}
                  hint={t("team.att.empty.hint")}
                  action={
                    slice !== "all" ? (
                      <Button variant="outline" onClick={() => setSlice("all")}>
                        {t("team.att.empty.showAll")}
                      </Button>
                    ) : undefined
                  }
                />
              }
            >
              <DataGrid columns={columns} rows={rows} rowKey={(r) => r.id} pageSize={31} />
            </StateBoundary>
          </div>

          <div className="mt-4">
            <Notice tone="info">{t("team.att.footnote")}</Notice>
          </div>
        </>
      )}
    </div>
  );
}
