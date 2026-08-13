/**
 * §4 · /admin/attendance/roster — Roster Planner. Every department-week the
 * database holds, and the slot grid inside the one you open.
 *
 * THE HONEST SHAPE OF THIS SCREEN
 * -------------------------------
 * The manifest hint is "publish shifts against event requirements". Two of those
 * three things are not on this backend, and neither is faked:
 *
 *  * PUBLISHING IS OFFERED NOW, AND SLOT EDITING IS NOT. For most of this
 *    screen's life neither was: migration 015 routed slot writes through roster
 *    edge functions that were never deployed, and no `publish_roster` RPC existed
 *    while `capabilities` already carried `roster.publish`. 043200 supplied the
 *    function, so the button below calls it rather than writing
 *    `rosters.status = 'published'` from a browser — which would have had to
 *    invent `published_by` and `published_at` from the client clock.
 *
 *    Slot writes remain absent, deliberately. "Who may work which shift" involves
 *    eligibility, rest gaps and overlapping bookings, and none of that is
 *    modelled; a grid that let an admin drag anybody anywhere would be quicker to
 *    build than to trust.
 *  * EVENT REQUIREMENTS. `public.events` exists (043100) and is managed at
 *    /admin/org/events, but nothing here attaches a slot to one yet.
 *    `roster_slots.event_id`
 *    is a bare uuid whose FK the 049 sweep skips, NULL on every row.
 *
 * What IS real, and is therefore what this screen does:
 *  * `rosters` — one row per department-week with status, publisher and publish
 *    instant, filterable by week, department and status.
 *  * `roster_slots` — the employee-date grid inside one roster, drafts included.
 *  * Every tile is `count=exact` over the SAME predicate as the grid it sits above.
 *    The per-roster counts are department-exact, because one roster IS one
 *    department-week (`uq_rosters__department_week`) — which is precisely why the
 *    week-wide published-slot tile, which cannot be narrowed that way, is switched
 *    off with its reason when a department filter is on.
 *
 * @route /admin/attendance/roster
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
import { fmtCivilDate, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import {
  isRosterSlotSlice,
  istWeekRange,
  istWeekStart,
  type RosterSlotFilters,
  type RosterSlotSlice,
} from "@/features/team/api/roster.api";
import {
  RosterSlotTile,
  RosterWeekGrid,
  WeekStepper,
  type RosterWeekPerson,
} from "@/features/team/components/RosterWeek";
import {
  useRosterGrid,
  useRosterShifts,
  useRosterSlotCount,
  useRosterSlots,
} from "@/features/team/hooks/useRoster";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { SelectField } from "../components/Field";
import { rosterStatusValues, type Roster, type RosterFilters } from "../api/coverage.api";
import {
  usePublishedRosterSlotCount,
  useRosterCount,
  usePublishRoster,
  useRosters,
} from "../hooks/useAttendanceRecords";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import { useRefOptions } from "../hooks/useMasters";

const ROSTER_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("team.roster.status.draft"), tone: "neutral" },
  published: { label: t("team.roster.status.published"), tone: "success" },
  locked: { label: t("team.roster.status.locked"), tone: "info" },
};

const SLICE_ORDER: readonly RosterSlotSlice[] = [
  "all",
  "published",
  "draft",
  "working",
  "weekly_off",
  "swap",
];

function sliceLabel(slice: RosterSlotSlice): string {
  switch (slice) {
    case "all":
      return t("team.roster.slice.all");
    case "published":
      return t("team.roster.slice.published");
    case "draft":
      return t("team.roster.slice.draft");
    case "working":
      return t("team.roster.slice.working");
    case "weekly_off":
      return t("team.roster.slice.weeklyOff");
    case "swap":
      return t("team.roster.slice.swap");
  }
}

function statusLabel(status: string): string {
  return ROSTER_STATUS_CHIP[status]?.label ?? status;
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function RosterPlannerPage() {
  const [params, setParams] = useSearchParams();

  /** `?w=` is normalised through `istWeekStart`, so a hand-typed URL cannot land
   *  the grid on a Wednesday and silently show six days of one week. */
  const rawWeek = params.get("w");
  const weekStart =
    rawWeek !== null && CIVIL_DATE.test(rawWeek) ? istWeekStart(rawWeek) : istWeekStart(nowIstDate());
  const week = useMemo(() => istWeekRange(weekStart), [weekStart]);

  const departmentId = params.get("dept") ?? "";
  const status = params.get("status") ?? "";
  const selectedRosterId = params.get("r") ?? "";
  const rawSlice = params.get("slice");
  const slice: RosterSlotSlice = isRosterSlotSlice(rawSlice) ? rawSlice : "all";

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

  /** One roster predicate, shared by the list and its server COUNT. */
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
  const publish = usePublishRoster();
  const rosterTotal = useRosterCount(rosterFilters);
  /** Week-wide, company-wide: `roster_slots` has no department column, so this
   *  number is not asked for at all while a department filter is on. */
  const weekPublishedSlots = usePublishedRosterSlotCount(week, departmentId === "");

  const selected: Roster | undefined = useMemo(
    () => (rosters.data ?? []).find((r) => r.id === selectedRosterId),
    [rosters.data, selectedRosterId],
  );

  const slotBase: RosterSlotFilters = useMemo(
    () => ({
      from: week.from,
      to: week.to,
      ...(selected !== undefined ? { rosterId: selected.id } : {}),
    }),
    [week.from, week.to, selected],
  );
  const slotFilters: RosterSlotFilters = useMemo(
    () => ({ ...slotBase, ...(slice !== "all" ? { slice } : {}) }),
    [slotBase, slice],
  );

  const hasRoster = selected !== undefined;
  const slots = useRosterSlots(slotFilters, hasRoster);
  const shifts = useRosterShifts(slots.data);
  const grid = useRosterGrid(slots.data);

  const slotCounts: Record<RosterSlotSlice, ReturnType<typeof useRosterSlotCount>> = {
    all: useRosterSlotCount(slotBase, undefined, hasRoster),
    published: useRosterSlotCount(slotBase, "published", hasRoster),
    draft: useRosterSlotCount(slotBase, "draft", hasRoster),
    working: useRosterSlotCount(slotBase, "working", hasRoster),
    weekly_off: useRosterSlotCount(slotBase, "weekly_off", hasRoster),
    swap: useRosterSlotCount(slotBase, "swap", hasRoster),
  };

  /**
   * Slot rows carry `employee_id` and no name — the label comes from the
   * directory read every admin screen shares. Rows are the people the roster
   * actually names, ordered by that label so the grid reads like a rota.
   */
  const labels = useEmployeeLabels();
  const people: readonly RosterWeekPerson[] = useMemo(() => {
    const rows = grid.employeeIds.map((id) => {
      const label = labels.data?.get(id);
      return {
        id,
        name: label?.name ?? null,
        code: label?.code ?? null,
        secondary: label?.department ?? null,
      };
    });
    return [...rows].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [grid.employeeIds, labels.data]);

  const columns: DataGridColumn<Roster>[] = [
    {
      key: "week_start_date",
      header: t("admin.rosterp.col.week"),
      width: "10rem",
      sortable: true,
      render: (r) => <span className="num">{fmtCivilDate(r.week_start_date)}</span>,
    },
    {
      key: "title",
      header: t("admin.rosterp.col.title"),
      sortable: true,
      render: (r) => dash(r.title),
    },
    {
      key: "department_id",
      header: t("admin.rosterp.col.department"),
      width: "12rem",
      render: (r) => dash(departmentName.get(r.department_id)),
    },
    {
      key: "status",
      header: t("admin.rosterp.col.status"),
      width: "9rem",
      render: (r) => <StatusChip status={r.status} map={ROSTER_STATUS_CHIP} />,
    },
    {
      key: "published_at",
      header: t("admin.rosterp.col.published"),
      width: "12rem",
      hideBelow: "md",
      render: (r) => (
        <span className="num">{r.published_at === null ? dash(null) : fmtDateTime(r.published_at)}</span>
      ),
    },
    {
      key: "publish",
      header: t("admin.rosterp.col.publish"),
      width: "10rem",
      /*
        Drawn on a DRAFT week only. `publish_roster` treats a second press as a
        no-op and refuses a locked week, but a control that does nothing teaches
        people to distrust controls — so it is simply absent where it would not
        act.
      */
      render: (r) =>
        r.status !== "draft" ? (
          <span className="text-xs text-muted-foreground">{dash(null)}</span>
        ) : (
          <ReasonActionButton
            label={t("team.roster.publish.cta")}
            title={t("team.roster.publish.title", { week: fmtCivilDate(r.week_start_date) })}
            description={t("admin.rosterp.publish.what")}
            onConfirm={async (reason) => {
              await publish.mutateAsync({ input: { rosterId: r.id }, reason });
              confirmSubmitted(t("team.roster.publish.done"), {
                detail: t("team.roster.publish.doneDetail"),
              });
            }}
          />
        ),
    },
    {
      key: "open",
      header: t("admin.rosterp.col.open"),
      width: "7rem",
      render: (r) => (
        <Button
          variant={r.id === selectedRosterId ? "default" : "outline"}
          size="sm"
          onClick={() => setParam("r", r.id, ["slice"])}
        >
          {r.id === selectedRosterId ? t("admin.rosterp.open.current") : t("admin.rosterp.open.action")}
        </Button>
      ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarDays}
        title={t("admin.rosterp.title")}
        subtitle={t("admin.rosterp.subtitle")}
        actions={<WeekStepper weekStart={weekStart} onChange={(w) => setParam("w", w, ["r", "slice"])} />}
      />

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.rosterp.filter.department")}
          value={departmentId}
          placeholder={t("admin.rosterp.filter.allDepartments")}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(value) => setParam("dept", value, ["r"])}
          {...(departments.error !== null ? { hint: t("admin.rosterp.filter.departmentsUnavailable") } : {})}
        />
        <SelectField
          label={t("admin.rosterp.filter.status")}
          value={status}
          placeholder={t("admin.rosterp.filter.allStatuses")}
          options={rosterStatusValues.map((s) => ({ value: s, label: statusLabel(s) }))}
          onChange={(value) => setParam("status", value, ["r"])}
        />
        <div className="flex items-end justify-end">
          {departmentId !== "" || status !== "" ? (
            <Button
              variant="ghost"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete("dept");
                next.delete("status");
                next.delete("r");
                setParams(next, { replace: true });
              }}
            >
              {t("admin.rosterp.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <RosterSlotTile
          label={t("admin.rosterp.tile.rosters")}
          hint={t("admin.rosterp.tile.rostersHint")}
          count={rosterTotal}
        />
        <RosterSlotTile
          label={t("admin.rosterp.tile.weekSlots")}
          hint={t("admin.rosterp.tile.weekSlotsHint")}
          count={weekPublishedSlots}
          {...(departmentId !== ""
            ? { unavailable: t("admin.rosterp.tile.weekSlotsBlocked") }
            : {})}
        />
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={rosters.isPending}
          error={rosters.error}
          onRetry={() => void rosters.refetch()}
          partialError={departments.error}
          partialLabel={t("admin.rosterp.partial.departments")}
          isEmpty={(rosters.data ?? []).length === 0}
          empty={
            <EmptyState
              icon={CalendarDays}
              title={t("admin.rosterp.empty.title")}
              hint={t("admin.rosterp.empty.hint")}
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
                  ? t("admin.rosterp.grid.total", { n: formatNumber(rosterTotal.data) })
                  : t("admin.rosterp.grid.totalUnknown")}
              </p>
            }
          />
        </StateBoundary>
      </div>

      {/* The slot grid inside ONE roster — department-exact, drafts included. */}
      <section className="mt-6 rounded-lg border bg-card p-4">
        <h2 className="font-display text-sm font-semibold">{t("admin.rosterp.slots.title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {selected === undefined
            ? t("admin.rosterp.slots.pick")
            : t("admin.rosterp.slots.for", {
                department: departmentName.get(selected.department_id) ?? dash(null),
                week: fmtCivilDate(selected.week_start_date),
              })}
        </p>

        {selected === undefined ? null : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {SLICE_ORDER.map((s) => (
                <RosterSlotTile
                  key={s}
                  label={sliceLabel(s)}
                  active={slice === s}
                  onClick={() => setParam("slice", s === "all" ? "" : s)}
                  count={slotCounts[s]}
                />
              ))}
            </div>

            <div className="mt-4">
              <StateBoundary
                loading={slots.isPending}
                error={slots.error}
                onRetry={() => void slots.refetch()}
                partialError={shifts.error ?? labels.error}
                partialLabel={t("admin.rosterp.partial.slotLabels")}
                isEmpty={(slots.data ?? []).length === 0}
                empty={
                  <EmptyState
                    icon={CalendarDays}
                    title={t("admin.rosterp.slots.empty.title")}
                    hint={t("admin.rosterp.slots.empty.hint")}
                    action={
                      slice !== "all" ? (
                        <Button variant="outline" onClick={() => setParam("slice", "")}>
                          {t("team.roster.empty.showAll")}
                        </Button>
                      ) : undefined
                    }
                  />
                }
              >
                <RosterWeekGrid
                  weekStart={selected.week_start_date}
                  people={people}
                  slotsByEmployee={grid.byEmployee}
                  shifts={shifts.data}
                  toolbar={
                    <p className="text-xs text-muted-foreground">
                      {t("admin.rosterp.slots.toolbar", { n: formatNumber(people.length) })}
                    </p>
                  }
                />
              </StateBoundary>
            </div>
          </>
        )}
      </section>

      <div className="mt-4 space-y-2">
        <Notice tone="info">{t("admin.rosterp.gap.noSlotEdit")}</Notice>
        <Notice tone="info">{t("admin.rosterp.gap.noEventLink")}</Notice>
        <Notice tone="info">{t("admin.rosterp.footnote")}</Notice>
      </div>
    </div>
  );
}
