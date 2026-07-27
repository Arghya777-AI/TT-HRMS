/**
 * §D · /team/roster — Roster & Events. The published week for my team, as the
 * database actually holds it.
 *
 * What this screen is honest about, and why:
 *
 *  1. IT DOES NOT PUBLISH. The manifest hint says "plan and publish next week",
 *     and `capabilities` really does carry `roster.publish` for the manager role —
 *     but the endpoint it would call was never deployed. Migration 015 states slot
 *     writes go through the roster edge functions/RPCs; `supabase/functions/` has
 *     no roster function and no `publish_roster` RPC exists in any migration. So
 *     there is no publish control here, and the gap is named on screen rather than
 *     mocked with a button that would either do nothing or write straight to a
 *     table the attendance engine expects the server to own.
 *  2. IT DOES NOT SHOW EVENTS. `public.events` does not exist (the 049 FK sweep
 *     skips `roster_slots.event_id` for exactly that reason and `event_id` is NULL
 *     on every row), so "against event staffing needs" has no data behind it and
 *     no fictional booking is drawn.
 *  3. EVERY NUMBER IS A SERVER COUNT. Each tile is `count=exact` over the SAME
 *     predicate as the grid, so a tile and the week below it cannot disagree.
 *  4. A BLANK CELL IS THE ABSENCE OF A ROW. "Nobody rostered on Thursday" is not a
 *     filterable state over `roster_slots`, so it is shown as an empty cell and
 *     said in words, never counted.
 *
 * Manager scope: `useTeamRoster` resolves the reporting closure and every read is
 * narrowed to those ids — a correctness filter over what RLS already decided. The
 * slot policy lets a manager see DRAFT slots for their own reportees, which is
 * what makes the draft/published split on this screen meaningful.
 *
 * @route /team/roster
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { addIstDays, civilDayOffset, fmtCivilDate, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "@/features/admin/components/Notice";
import { useRosters } from "@/features/admin/hooks/useAttendanceRecords";
import {
  isRosterSlotSlice,
  istWeekRange,
  istWeekStart,
  type RosterSlotFilters,
  type RosterSlotSlice,
} from "../api/roster.api";
import {
  RosterSlotTile,
  RosterWeekGrid,
  WeekStepper,
  type RosterWeekPerson,
} from "../components/RosterWeek";
import { useTeamRoster } from "../hooks/useTeamDecisions";
import {
  useRosterGrid,
  useRosterShifts,
  useRosterSlotCount,
  useRosterSlots,
} from "../hooks/useRoster";

/** `ck_rosters__status` — the three header states, in the client's words. */
const ROSTER_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("team.roster.status.draft"), tone: "neutral" },
  published: { label: t("team.roster.status.published"), tone: "success" },
  locked: { label: t("team.roster.status.locked"), tone: "info" },
};

/** How far either side of today the "which week has a plan?" look-around reaches. */
const LOOKAROUND_DAYS = 120;

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

export default function TeamRosterPage() {
  const [params, setParams] = useSearchParams();
  const team = useTeamRoster();
  const employeeIds = useMemo(() => team.data?.employeeIds ?? [], [team.data]);

  const [weekStart, setWeekStart] = useState(() => istWeekStart(nowIstDate()));
  const week = useMemo(() => istWeekRange(weekStart), [weekStart]);

  const rawSlice = params.get("slice");
  const slice: RosterSlotSlice = isRosterSlotSlice(rawSlice) ? rawSlice : "all";

  const filters: RosterSlotFilters = useMemo(
    () => ({
      from: week.from,
      to: week.to,
      employeeIds,
      ...(slice !== "all" ? { slice } : {}),
    }),
    [week.from, week.to, employeeIds, slice],
  );

  const hasTeam = employeeIds.length > 0;
  const slots = useRosterSlots(filters, hasTeam);
  const shifts = useRosterShifts(slots.data);
  const grid = useRosterGrid(slots.data);

  // One count per tile, all over the same window + scope. Hooks may not be
  // called in a loop, so the six calls are written out.
  const base: RosterSlotFilters = useMemo(
    () => ({ from: week.from, to: week.to, employeeIds }),
    [week.from, week.to, employeeIds],
  );
  const counts: Record<RosterSlotSlice, ReturnType<typeof useRosterSlotCount>> = {
    all: useRosterSlotCount(base, undefined, hasTeam),
    published: useRosterSlotCount(base, "published", hasTeam),
    draft: useRosterSlotCount(base, "draft", hasTeam),
    working: useRosterSlotCount(base, "working", hasTeam),
    weekly_off: useRosterSlotCount(base, "weekly_off", hasTeam),
    swap: useRosterSlotCount(base, "swap", hasTeam),
  };

  /**
   * "Which week actually has a plan?" — a bounded look either side of today for
   * ANY slot belonging to this team, so an empty week can offer a real jump
   * instead of leaving a manager to guess. It reads the same table with the same
   * scope; the nearest date is chosen with `civilDayOffset`, never with local
   * `Date` maths, and nothing about the shown week is derived from it.
   */
  const today = nowIstDate();
  const nearbyFilters: RosterSlotFilters = useMemo(
    () => ({
      from: addIstDays(today, -LOOKAROUND_DAYS),
      to: addIstDays(today, LOOKAROUND_DAYS),
      employeeIds,
    }),
    [today, employeeIds],
  );
  const nearby = useRosterSlots(nearbyFilters, hasTeam);
  const nearestWeek = useMemo(() => {
    let best: { week: string; distance: number } | null = null;
    for (const slot of nearby.data ?? []) {
      const week = istWeekStart(slot.slot_date);
      if (week === weekStart) continue;
      const distance = Math.abs(civilDayOffset(today, slot.slot_date));
      if (best === null || distance < best.distance) best = { week, distance };
    }
    return best?.week ?? null;
  }, [nearby.data, today, weekStart]);

  /**
   * The header rows for this exact week. `rosters` is one row per department-week
   * and carries the publish state the slots do not: a week can hold published
   * slots under a header still in draft (seed 047 does exactly that when no
   * publisher profile existed yet), and a manager needs to see which.
   */
  const headers = useRosters({ from: weekStart, to: weekStart });
  const myRosterIds = useMemo(() => {
    const ids = new Set<string>();
    for (const slot of slots.data ?? []) ids.add(slot.roster_id);
    return ids;
  }, [slots.data]);
  const myHeaders = useMemo(
    () => (headers.data ?? []).filter((r) => myRosterIds.has(r.id)),
    [headers.data, myRosterIds],
  );

  /**
   * Grid rows are PEOPLE — every reportee, in the name order
   * `v_team_employee_basic` returned — so somebody with nothing rostered is
   * visibly unrostered instead of silently absent from the week.
   */
  const people: readonly RosterWeekPerson[] = useMemo(
    () =>
      (team.data?.members ?? []).map((m) => ({
        id: m.id,
        name: m.display_name,
        code: m.employee_code,
        secondary: m.department_name,
      })),
    [team.data],
  );

  const setSlice = (next: RosterSlotSlice) => {
    const p = new URLSearchParams(params);
    if (next === "all") p.delete("slice");
    else p.set("slice", next);
    setParams(p, { replace: true });
  };

  const noTeam = team.data?.isEmpty === true;
  const nothingRostered = (slots.data ?? []).length === 0;

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarDays}
        title={t("team.roster.title")}
        subtitle={t("team.roster.subtitle", { n: formatNumber(employeeIds.length) })}
        actions={<WeekStepper weekStart={weekStart} onChange={setWeekStart} />}
      />

      {noTeam ? (
        <div className="mt-6">
          <EmptyState
            icon={Users}
            title={t("team.roster.noTeam.title")}
            hint={t("team.roster.noTeam.hint")}
          />
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {SLICE_ORDER.map((s) => (
              <RosterSlotTile
                key={s}
                label={sliceLabel(s)}
                active={slice === s}
                onClick={() => setSlice(s)}
                count={counts[s]}
              />
            ))}
          </div>

          {/* The week's header rows — publish state, and when it happened. */}
          <section className="mt-4 rounded-lg border bg-card p-4">
            <h2 className="font-display text-sm font-semibold">
              {t("team.roster.headers.title")}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("team.roster.headers.hint")}</p>
            <StateBoundary
              loading={headers.isPending}
              error={headers.error}
              onRetry={() => void headers.refetch()}
              isEmpty={myHeaders.length === 0}
              empty={
                <p className="mt-3 text-sm text-muted-foreground">
                  {t("team.roster.headers.empty")}
                </p>
              }
              skeletonRows={2}
            >
              <ul className="mt-3 space-y-2">
                {myHeaders.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{dash(r.title)}</span>
                    <StatusChip status={r.status} map={ROSTER_STATUS_CHIP} />
                    <span className="num text-xs text-muted-foreground">
                      {r.published_at === null
                        ? t("team.roster.headers.notPublished")
                        : t("team.roster.headers.publishedAt", { at: fmtDateTime(r.published_at) })}
                    </span>
                  </li>
                ))}
              </ul>
            </StateBoundary>
          </section>

          <div className="mt-4">
            <StateBoundary
              loading={slots.isPending || team.isPending}
              error={slots.error ?? team.error}
              onRetry={() => void slots.refetch()}
              partialError={shifts.error}
              partialLabel={t("team.roster.partial.shifts")}
              isEmpty={nothingRostered}
              empty={
                <EmptyState
                  icon={CalendarDays}
                  title={
                    slice === "all"
                      ? t("team.roster.empty.title")
                      : t("team.roster.empty.sliceTitle")
                  }
                  hint={t("team.roster.empty.hint")}
                  action={
                    slice !== "all" ? (
                      <Button variant="outline" onClick={() => setSlice("all")}>
                        {t("team.roster.empty.showAll")}
                      </Button>
                    ) : nearestWeek !== null ? (
                      <Button variant="outline" onClick={() => setWeekStart(nearestWeek)}>
                        {t("team.roster.empty.jump", { date: fmtCivilDate(nearestWeek) })}
                      </Button>
                    ) : undefined
                  }
                />
              }
            >
              <RosterWeekGrid
                weekStart={weekStart}
                people={people}
                slotsByEmployee={grid.byEmployee}
                shifts={shifts.data}
                toolbar={
                  <p className="text-xs text-muted-foreground">
                    {t("team.roster.grid.toolbar", { n: formatNumber(people.length) })}
                  </p>
                }
              />
            </StateBoundary>
          </div>

          <div className="mt-4 space-y-2">
            <Notice tone="warning">{t("team.roster.gap.noWrite")}</Notice>
            <Notice tone="info">{t("team.roster.gap.noEvents")}</Notice>
            <Notice tone="info">{t("team.roster.footnote")}</Notice>
          </div>
        </>
      )}
    </div>
  );
}
