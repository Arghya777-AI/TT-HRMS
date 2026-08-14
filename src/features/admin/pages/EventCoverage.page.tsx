/**
 * §4 · /admin/attendance/coverage — Event Coverage. What the roster actually
 * plans for a week, and a written register of the three things this backend
 * cannot answer.
 *
 * THE SCREEN THE PRD ASKED FOR was "required vs rostered vs present headcount per
 * department per event". For most of this screen's life two thirds of that
 * sentence had no data behind it. Migration 043100 supplied the missing two
 * thirds; the last third is still genuinely absent, and is still not faked.
 *
 * ── WHAT ARRIVED ────────────────────────────────────────────────────────────
 *
 *  1. `public.events` EXISTS. It did not, for ninety migrations: the 004900
 *     deferred-FK sweep listed `roster_slots.event_id → public.events` and was
 *     guarded on `to_regclass(...) IS NOT NULL`, so it skipped in silence every
 *     time it ran. The register is at /admin/org/events.
 *  2. A REQUIRED-HEADCOUNT FIGURE EXISTS. `event_labour_demand.required_headcount`
 *     states demand per event per department. Before it, `required_headcount`,
 *     `planned_headcount`, `min_staff` and `headcount_required` appeared nowhere
 *     in the schema, so "required" was not a column, a view or a function.
 *  3. `v_event_coverage` joins them and emits `short_by` as
 *     GREATEST(required − rostered, 0) — never negative, because over-rostering is
 *     not a shortfall. The table below reads that view; nothing here recomputes
 *     the subtraction.
 *
 * ── WHAT IS STILL MISSING, AND IS STILL NOT DRAWN ───────────────────────────
 *
 *  * PLANNED-VS-PRESENT CANNOT BE JOINED. The engine writes
 *    `attendance_days.roster_slot_id`, but `v_attendance_day_enriched` does not
 *    project that column, and `roster_slots.attendance_day_id` is never written by
 *    anything. Neither side of the join is readable from a browser, so "present
 *    against plan" stays absent rather than being approximated from dates — which
 *    would silently credit an unrostered person's punches.
 *  * A SLOT COUNTS ONLY WHEN SOMEBODY ASSIGNS IT. The roster planner assigns a
 *    whole rostered day to a booking (043500); nothing is inferred from dates,
 *    because a slot on the same day as a wedding is not evidence that it is FOR
 *    the wedding. A day nobody has assigned reads zero, and that zero is a fact
 *    about the roster rather than about this screen.
 *
 * The department-week half of this screen is unchanged and was always real:
 * `rosters` (one row per department-week, with its publish state) and Postgres
 * COUNTS over `roster_slots`. The per-day strip is seven `count=exact` reads, one
 * per date — not one read divided seven ways — and the chart plots those counts
 * unchanged.
 *
 * @route /admin/attendance/coverage
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtCivilDayMonthWeekday, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import {
  istWeekDates,
  istWeekRange,
  istWeekStart,
  type RosterSlotFilters,
} from "@/features/team/api/roster.api";
import { RosterSlotTile, WeekStepper } from "@/features/team/components/RosterWeek";
import { useRosterSlotCount } from "@/features/team/hooks/useRoster";
import { Notice } from "../components/Notice";
import { SelectField } from "../components/Field";
import { StackedBarsChart, type ChartPoint } from "../components/AnalyticsOpsCharts";
import {
  rosterStatusValues,
  type Roster,
  type RosterFilters,
} from "../api/coverage.api";
import {
  usePublishedRosterSlotCount,
  useRosterCount,
  useRosters,
} from "../hooks/useAttendanceRecords";
import { useRefOptions } from "../hooks/useMasters";
import { useEventCoverage } from "../hooks/useEventRegister";
import { CoverageBar } from "@/shared/ui/charts/CoverageBar";
import type { EventCoverageRow } from "../api/events.api";

const ROSTER_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("team.roster.status.draft"), tone: "neutral" },
  published: { label: t("team.roster.status.published"), tone: "success" },
  locked: { label: t("team.roster.status.locked"), tone: "info" },
};

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A count query reduced to the chart's value: a number, or a GAP — never a zero. */
function chartValue(q: { data: number | undefined; error: Error | null }): number | null {
  if (q.error !== null) return null;
  return q.data ?? null;
}

export default function EventCoveragePage() {
  const [params, setParams] = useSearchParams();

  const rawWeek = params.get("w");
  const weekStart =
    rawWeek !== null && CIVIL_DATE.test(rawWeek)
      ? istWeekStart(rawWeek)
      : istWeekStart(nowIstDate());
  const week = useMemo(() => istWeekRange(weekStart), [weekStart]);
  /*
    Bookings whose START falls in this week. `starts_at` is a timestamptz and the
    week is a pair of IST civil dates, so the bounds are stamped with +05:30
    explicitly — a bare date string would be read as UTC and quietly drop
    everything booked before 05:30 on the Monday.
  */
  const eventCoverage = useEventCoverage(
    useMemo(
      () => ({ from: `${week.from}T00:00:00+05:30`, to: `${week.to}T23:59:59+05:30` }),
      [week.from, week.to],
    ),
  );
  /* A row with nothing required and nobody rostered says nothing; the view emits
     one per event even where no demand has been recorded. */
  const eventCoverageRows = (eventCoverage.data ?? []).filter(
    (r) => r.required_headcount > 0 || r.rostered_headcount > 0,
  );
  const eventCoverageColumns: DataGridColumn<EventCoverageRow>[] = [
    {
      key: "title",
      header: t("events.coverage.col.event"),
      render: (row) => (
        <div>
          <p className="font-medium leading-snug">{row.title}</p>
          <p className="font-mono text-xs text-muted-foreground">{row.event_code}</p>
        </div>
      ),
    },
    {
      key: "department_name",
      header: t("events.coverage.col.dept"),
      render: (row) => row.department_name ?? t("events.coverage.noDept"),
    },
    {
      key: "required_headcount",
      header: t("events.coverage.col.required"),
      align: "right",
      width: "8rem",
      render: (row) => formatNumber(row.required_headcount),
    },
    {
      key: "rostered_headcount",
      header: t("events.coverage.col.rostered"),
      align: "right",
      width: "8rem",
      render: (row) => formatNumber(row.rostered_headcount),
    },
    {
      key: "short_by",
      header: t("events.coverage.col.short"),
      width: "13rem",
      /* The same bar the event register draws, from the same view column — two
         screens showing one fact must not render it two ways. */
      render: (row) => (
        <CoverageBar
          value={row.rostered_headcount}
          target={row.required_headcount === 0 ? null : row.required_headcount}
          title={`${row.title} · ${row.department_name ?? t("events.coverage.noDept")}`}
          showLabel
          format={(v) => formatNumber(v)}
        />
      ),
    },
  ];
  const days = useMemo(() => istWeekDates(weekStart), [weekStart]);

  const departmentId = params.get("dept") ?? "";
  const status = params.get("status") ?? "";
  const selectedRosterId = params.get("r") ?? "";

  const setParam = (key: string, value: string, alsoClear: readonly string[] = []) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    for (const k of alsoClear) next.delete(k);
    setParams(next, { replace: true });
  };

  const departments = useRefOptions("departments");
  const departmentName = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of departments.data ?? []) map.set(d.id, d.name);
    return map;
  }, [departments.data]);

  const rosterFilters: RosterFilters = useMemo(
    () => ({
      from: weekStart,
      to: weekStart,
      ...(departmentId !== "" ? { departmentIds: [departmentId] } : {}),
      ...(status !== "" ? { statuses: [status] } : {}),
    }),
    [weekStart, departmentId, status],
  );

  const rosters = useRosters(rosterFilters);
  const rosterTotal = useRosterCount(rosterFilters);
  const weekPublishedSlots = usePublishedRosterSlotCount(week, departmentId === "");

  const selected: Roster | undefined = useMemo(
    () => (rosters.data ?? []).find((r) => r.id === selectedRosterId),
    [rosters.data, selectedRosterId],
  );

  /**
   * Scope for every slot count on this screen. With a roster selected it is
   * department-exact (one roster IS one department-week); without one it is the
   * whole company for the week, which the tile hints say in words.
   */
  const scope: RosterSlotFilters = useMemo(
    () => ({
      from: week.from,
      to: week.to,
      ...(selected !== undefined ? { rosterId: selected.id } : {}),
    }),
    [week.from, week.to, selected],
  );

  const plannedAll = useRosterSlotCount(scope, undefined, true);
  const plannedPublished = useRosterSlotCount(scope, "published", true);
  const plannedDraft = useRosterSlotCount(scope, "draft", true);
  const plannedWorking = useRosterSlotCount(scope, "working", true);
  const plannedWeeklyOff = useRosterSlotCount(scope, "weekly_off", true);

  /**
   * Seven independent server counts — one per date of the week. Hooks cannot be
   * called in a loop, and that constraint is honest here: each bar is its own
   * `count=exact` over `slot_date = <that date>`, not one week total split up.
   */
  const dayScope = (index: number): RosterSlotFilters => {
    const date = days[index] ?? week.from;
    return {
      from: date,
      to: date,
      ...(selected !== undefined ? { rosterId: selected.id } : {}),
      slice: "working",
    };
  };
  const perDay = [
    useRosterSlotCount(dayScope(0), "working", true),
    useRosterSlotCount(dayScope(1), "working", true),
    useRosterSlotCount(dayScope(2), "working", true),
    useRosterSlotCount(dayScope(3), "working", true),
    useRosterSlotCount(dayScope(4), "working", true),
    useRosterSlotCount(dayScope(5), "working", true),
    useRosterSlotCount(dayScope(6), "working", true),
  ] as const;

  // Read out as seven values so the chart's memo depends on the NUMBERS, not on a
  // freshly-built array. A failed or pending count is `null` — a gap in the bar
  // chart, never a zero that would read as "nobody rostered".
  const d0 = chartValue(perDay[0]);
  const d1 = chartValue(perDay[1]);
  const d2 = chartValue(perDay[2]);
  const d3 = chartValue(perDay[3]);
  const d4 = chartValue(perDay[4]);
  const d5 = chartValue(perDay[5]);
  const d6 = chartValue(perDay[6]);
  const points: readonly ChartPoint[] = useMemo(() => {
    const values = [d0, d1, d2, d3, d4, d5, d6];
    return days.map((date, index) => ({
      x: fmtCivilDayMonthWeekday(date),
      values: { planned: values[index] ?? null },
    }));
  }, [days, d0, d1, d2, d3, d4, d5, d6]);

  const columns: DataGridColumn<Roster>[] = [
    {
      key: "department_id",
      header: t("admin.coverage.col.department"),
      width: "14rem",
      render: (r) => dash(departmentName.get(r.department_id)),
    },
    {
      key: "title",
      header: t("admin.coverage.col.title"),
      sortable: true,
      render: (r) => dash(r.title),
    },
    {
      key: "status",
      header: t("admin.coverage.col.status"),
      width: "9rem",
      render: (r) => <StatusChip status={r.status} map={ROSTER_STATUS_CHIP} />,
    },
    {
      key: "published_at",
      header: t("admin.coverage.col.published"),
      width: "12rem",
      hideBelow: "md",
      render: (r) => (
        <span className="num">
          {r.published_at === null ? dash(null) : fmtDateTime(r.published_at)}
        </span>
      ),
    },
    {
      key: "required",
      header: t("admin.coverage.col.required"),
      width: "9rem",
      align: "right",
      // Never a number: no relation on this backend states labour demand.
      render: () => <span className="text-muted-foreground">{dash(null)}</span>,
    },
    {
      key: "open",
      header: t("admin.coverage.col.open"),
      width: "8rem",
      render: (r) => (
        <Button
          variant={r.id === selectedRosterId ? "default" : "outline"}
          size="sm"
          onClick={() => setParam("r", r.id)}
        >
          {r.id === selectedRosterId ? t("admin.coverage.open.current") : t("admin.coverage.open.action")}
        </Button>
      ),
    },
  ];

  const scopeLabel =
    selected === undefined
      ? t("admin.coverage.scope.week")
      : t("admin.coverage.scope.roster", {
          department: departmentName.get(selected.department_id) ?? dash(null),
          week: fmtCivilDate(selected.week_start_date),
        });

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarDays}
        title={t("admin.coverage.title")}
        subtitle={t("admin.coverage.subtitle")}
        actions={<WeekStepper weekStart={weekStart} onChange={(w) => setParam("w", w, ["r"])} />}
      />

      {/*
        REQUIRED VERSUS ROSTERED, which this screen could not show for its whole
        life. `public.events`, `event_labour_demand` and `v_event_coverage` all
        arrived in 043100; the shortfall is the view's own GREATEST(required −
        rostered, 0), never recomputed here.
      */}
      <section className="mt-4" aria-labelledby="cov-events">
        <h2 id="cov-events" className="font-display text-lg font-semibold">
          {t("events.coverage.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("admin.coverage.events.hint")}</p>
        <StateBoundary
          loading={eventCoverage.isLoading}
          error={eventCoverage.error ?? undefined}
          onRetry={() => void eventCoverage.refetch()}
          isEmpty={eventCoverage.data !== undefined && eventCoverageRows.length === 0}
          empty={
            <EmptyState
              icon={CalendarDays}
              title={t("admin.coverage.events.empty.title")}
              hint={t("admin.coverage.events.empty.hint")}
            />
          }
          skeletonRows={3}
        >
          <DataGrid
            rows={eventCoverageRows}
            columns={eventCoverageColumns}
            rowKey={(r) => `${r.event_id}:${r.department_id ?? "none"}`}
          />
        </StateBoundary>
      </section>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.coverage.filter.department")}
          value={departmentId}
          placeholder={t("admin.coverage.filter.allDepartments")}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(value) => setParam("dept", value, ["r"])}
        />
        <SelectField
          label={t("admin.coverage.filter.status")}
          value={status}
          placeholder={t("admin.coverage.filter.allStatuses")}
          options={rosterStatusValues.map((s) => ({
            value: s,
            label: ROSTER_STATUS_CHIP[s]?.label ?? s,
          }))}
          onChange={(value) => setParam("status", value, ["r"])}
        />
        <div className="flex items-end justify-end">
          {selectedRosterId !== "" ? (
            <Button variant="ghost" onClick={() => setParam("r", "")}>
              {t("admin.coverage.filter.allWeek")}
            </Button>
          ) : null}
        </div>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">{scopeLabel}</p>

      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <RosterSlotTile
          label={t("admin.coverage.tile.planned")}
          hint={t("admin.coverage.tile.plannedHint")}
          count={plannedAll}
        />
        <RosterSlotTile
          label={t("admin.coverage.tile.published")}
          hint={t("admin.coverage.tile.publishedHint")}
          count={plannedPublished}
        />
        <RosterSlotTile
          label={t("admin.coverage.tile.draft")}
          hint={t("admin.coverage.tile.draftHint")}
          count={plannedDraft}
        />
        <RosterSlotTile
          label={t("admin.coverage.tile.working")}
          hint={t("admin.coverage.tile.workingHint")}
          count={plannedWorking}
        />
        <RosterSlotTile
          label={t("admin.coverage.tile.weeklyOff")}
          hint={t("admin.coverage.tile.weeklyOffHint")}
          count={plannedWeeklyOff}
        />
        <RosterSlotTile
          label={t("admin.coverage.tile.required")}
          count={{ data: undefined, error: null, isPending: false }}
          unavailable={t("admin.coverage.tile.requiredBlocked")}
        />
      </div>

      {departmentId !== "" && selected === undefined ? (
        <div className="mt-3">
          <Notice tone="info">{t("admin.coverage.gap.departmentSlots")}</Notice>
        </div>
      ) : null}

      {/* Company-wide published slots for the week — the one figure coverage.api
          can offer without a roster, and it is switched off when it cannot honour
          the department filter. */}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <RosterSlotTile
          label={t("admin.coverage.tile.weekPublished")}
          hint={t("admin.coverage.tile.weekPublishedHint")}
          count={weekPublishedSlots}
          {...(departmentId !== "" ? { unavailable: t("admin.coverage.tile.weekPublishedBlocked") } : {})}
        />
        <RosterSlotTile
          label={t("admin.coverage.tile.rosters")}
          hint={t("admin.coverage.tile.rostersHint")}
          count={rosterTotal}
        />
        <RosterSlotTile
          label={t("admin.coverage.tile.present")}
          count={{ data: undefined, error: null, isPending: false }}
          unavailable={t("admin.coverage.tile.presentBlocked")}
        />
      </div>

      {/* Per-day planned staffing: seven independent server counts. */}
      <section className="mt-6 rounded-lg border bg-card p-4">
        <StackedBarsChart
          title={t("admin.coverage.chart.title")}
          caption={t("admin.coverage.chart.caption")}
          series={[{ key: "planned", label: t("admin.coverage.chart.series") }]}
          points={points}
          format={(value) => (value === null ? dash(null) : formatNumber(value))}
          xHeader={t("admin.coverage.chart.xHeader")}
        />
      </section>

      <div className="mt-6">
        <StateBoundary
          loading={rosters.isPending}
          error={rosters.error}
          onRetry={() => void rosters.refetch()}
          partialError={departments.error}
          partialLabel={t("admin.coverage.partial.departments")}
          isEmpty={(rosters.data ?? []).length === 0}
          empty={
            <EmptyState
              icon={CalendarDays}
              title={t("admin.coverage.empty.title")}
              hint={t("admin.coverage.empty.hint")}
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={rosters.data ?? []}
            rowKey={(r) => r.id}
            pageSize={10}
            toolbar={
              <p className="text-xs text-muted-foreground">
                {rosterTotal.isSuccess
                  ? t("admin.coverage.grid.total", { n: formatNumber(rosterTotal.data) })
                  : t("admin.coverage.grid.totalUnknown")}
              </p>
            }
          />
        </StateBoundary>
      </div>

      <div className="mt-4 space-y-2">
        <Notice tone="info">{t("admin.coverage.gap.noPresent")}</Notice>
        <Notice tone="info">{t("admin.coverage.gap.noWrite")}</Notice>
        <Notice tone="info">{t("admin.coverage.footnote")}</Notice>
      </div>
    </div>
  );
}
