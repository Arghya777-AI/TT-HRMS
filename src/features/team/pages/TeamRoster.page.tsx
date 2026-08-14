/**
 * §D · /team/roster — Roster & Events. The published week for my team, as the
 * database actually holds it.
 *
 * What this screen is honest about, and why:
 *
 *  1. IT PUBLISHES, AND NOTHING MORE. For most of this screen's life there was no
 *     publish control and the gap was named here instead — `capabilities` carried
 *     `roster.publish` for managers while no RPC existed to call. Migration 043200
 *     added `publish_roster`, so the button below is real.
 *
 *     It moves a DRAFT week to PUBLISHED. It does not add, move or delete a slot:
 *     "who may put whom on which shift" involves shift eligibility, rest rules and
 *     overlapping bookings, and building the roster stays with an administrator
 *     until those exist. A manager publishing a week they cannot yet edit is still
 *     the useful half — the section head who knows the week is right is the one
 *     who should release it.
 *
 *     Who may: an administrator, or a manager for whom EVERY slot on the week is
 *     one of their own people. That is a whole-roster rule, which is why the server
 *     side is a function and not a widened RLS policy — RLS runs per row, and row
 *     by row a manager could release a week that is only partly theirs.
 *  2. IT DOES NOT SHOW EVENTS — YET. `public.events` exists now (043100), along
 *     with `fk_roster_slots__event`, so the reason this screen gave for years is
 *     spent. What is still true is narrower: nothing yet ATTACHES a slot to a
 *     booking, so `event_id` is NULL on every row and an overlay here would draw
 *     an empty band. The register lives at /admin/org/events; attaching slots to
 *     it belongs on the planner, beside the week it applies to.
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
import {
  addIstDays,
  civilDayOffset,
  fmtCivilDate,
  fmtDateTime,
  fmtWeekday,
  nowIstDate,
} from "@/lib/datetime";
import { TrendBars, type TrendBar } from "@/shared/ui/charts/TrendBars";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "@/features/admin/components/Notice";
import { usePublishRoster, useRosters } from "@/features/admin/hooks/useAttendanceRecords";
import { ReasonActionButton } from "@/features/admin/components/ReasonActionButton";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
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
  /**
   * Slots per roster header, not per week. A week can carry more than one header
   * — `rosters` is one row per DEPARTMENT-week — so "how many slots am I about to
   * release" has to be counted against the header being published, or the
   * confirmation would quote somebody else's department back at the manager.
   *
   * This counts what THIS manager can see, which is the point: `publish_roster`
   * refuses a week containing anybody who is not their reportee, so a number here
   * that is smaller than the roster's true size is the same disagreement the
   * server is about to raise, and raising it is correct.
   */
  const slotsByRoster = useMemo(() => {
    const counts = new Map<string, number>();
    for (const slot of slots.data ?? []) {
      counts.set(slot.roster_id, (counts.get(slot.roster_id) ?? 0) + 1);
    }
    return counts;
  }, [slots.data]);
  const myRosterIds = useMemo(() => new Set(slotsByRoster.keys()), [slotsByRoster]);
  const myHeaders = useMemo(
    () => (headers.data ?? []).filter((r) => myRosterIds.has(r.id)),
    [headers.data, myRosterIds],
  );
  const publish = usePublishRoster();

  /*
    ── WHICH DAY IS THIN ──────────────────────────────────────────────────────
    The six tiles above answer "how much of this week is what" — published,
    draft, weekly off. None of them answers the question a section head actually
    asks on a Tuesday, which is WHICH DAY is short. Seven bars do, at a glance.

    Counted from the slots already loaded rather than seven more `count=exact`
    reads: `slots.data` IS the week for this team, fetched under one predicate,
    so a per-day tally over it is a partition of a set the server already
    returned — not a second, looser query that could disagree with the grid.

    A day with no slots is a REAL zero here, not an absent record: the week was
    read in full and nothing was found on that date. That is exactly the state
    the footnote calls "an empty cell is the absence of a row".
  */
  const dayBars: readonly TrendBar[] = useMemo(() => {
    const perDay = new Map<string, number>();
    for (const slot of slots.data ?? []) {
      /* A weekly off is a slot row but not a person working — counting it as
         cover is how a Sunday looks staffed when nobody is in. */
      if (slot.is_weekly_off) continue;
      perDay.set(slot.slot_date, (perDay.get(slot.slot_date) ?? 0) + 1);
    }
    return Array.from({ length: 7 }, (_, i) => {
      const date = addIstDays(weekStart, i);
      const n = perDay.get(date) ?? 0;
      return {
        key: date,
        label: fmtWeekday(`${date}T12:00:00+05:30`).slice(0, 3),
        value: n,
        tone: n === 0 ? ("absent" as const) : ("present" as const),
        caption: t("team.roster.chart.day", { date: fmtCivilDate(date) }),
      };
    });
  }, [slots.data, weekStart]);

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

          {/* ── Which day is thin ────────────────────────────────────────── */}
          <section className="mt-4 rounded-lg border bg-card p-4">
            <h2 className="font-display text-sm font-semibold">
              {t("team.roster.chart.title")}
            </h2>
            <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
              {t("team.roster.chart.hint")}
            </p>
            <TrendBars
              title={t("team.roster.chart.title")}
              bars={dayBars}
              height={130}
              showAxis
              format={(v) => formatNumber(v)}
            />
          </section>

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
                    {/*
                      Offered on a DRAFT week only. A published week publishes again
                      as a no-op server-side, and a locked one is refused — but a
                      button that does nothing is a button that teaches people to
                      distrust buttons, so it is simply not drawn.

                      No confirmation is demanded beyond the press. The reason is
                      derived from the action, as everywhere else: an audit row
                      reading "publish the roster for the week of 18 Aug" is more
                      truthful than whatever a manager types at 6pm on a Friday.
                    */}
                    {r.status === "draft" ? (
                      <span className="ml-auto">
                        <ReasonActionButton
                          surface="team roster"
                          label={t("team.roster.publish.cta")}
                          title={t("team.roster.publish.title", {
                            week: fmtCivilDate(r.week_start_date),
                          })}
                          description={t("team.roster.publish.what", {
                            n: formatNumber(slotsByRoster.get(r.id) ?? 0),
                            week: fmtCivilDate(r.week_start_date),
                          })}
                          onConfirm={async (reason) => {
                            await publish.mutateAsync({
                              input: { rosterId: r.id },
                              reason,
                            });
                            confirmSubmitted(t("team.roster.publish.done"), {
                              detail: t("team.roster.publish.doneDetail"),
                            });
                          }}
                        />
                      </span>
                    ) : null}
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
            <Notice tone="note">{t("team.roster.gap.noSlotEdit")}</Notice>
            <Notice tone="note">{t("team.roster.gap.noEventLink")}</Notice>
            <Notice tone="note">{t("team.roster.footnote")}</Notice>
          </div>
        </>
      )}
    </div>
  );
}
