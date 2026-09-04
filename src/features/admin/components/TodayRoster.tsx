/**
 * TodayRoster — who is here today, by department.
 *
 * ── WHAT IT REPLACED, AND WHY ────────────────────────────────────────────────
 * The dashboard opened on six tiles — on roll, arrived, yet to arrive, late, overdue, web/mobile
 * — and no names. Six independent counts is not a picture of a day; they also overlap (somebody
 * late is also arrived), so they cannot be read as a whole, and the one question people actually
 * have ("who is in, who is not") needed a different screen to answer.
 *
 * So: three numbers that DO partition the roll, then the list.
 *
 * ── GROUPED BY DEPARTMENT, AND THAT IS A CORRECTION ──────────────────────────
 * The first version split on `designations.is_managerial / is_executive` and headed the block
 * "Management". That put Johar Lal Ree — Ground department, managerial designation — under
 * Management, and left most of the actual Management department out: only 2 of its 20 people
 * carry the flag. "Management" is a DEPARTMENT here, next to Ground, Restaurant and Coorg.
 *
 * ── EVERY GROUP STATES ITS OWN NUMBERS ───────────────────────────────────────
 * Present / absent / on leave per department, in the heading, beside the venue totals at the
 * top. One pair of totals cannot answer "is Restaurant short today", which is the question that
 * gets acted on. The blocks are the venue; the headings are the teams.
 *
 * ── ABSENT IS NOT A STATUS ───────────────────────────────────────────────────
 * The row's own words come from the engine, but "absent" is derived: expected today, has not
 * scanned, not off. That matters because the engine leaves most days `pending` until it closes
 * them, so a table that only trusted a status called "absent" would show almost nobody as
 * absent on a day that had barely started.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarOff, Globe, ScanFace, UserCheck, UserX } from "lucide-react";
import { formatDistance } from "@/lib/venueDistance";
import { formatElapsed } from "../liveWorked";
import { sessionsFromPunches, sessionTotals } from "../punchSessions";
import { workedDisplay } from "../workedDisplay";
import { useTick } from "../hooks/useTick";
import { openStreetMapUrl } from "@/lib/punchPlace";
import { t } from "@/shared/i18n/en";
import { fmtDurationHm } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import type {
  PunchOnRoster,
  RosterCounts,
  RosterGroup,
  RosterRow,
  TodayRoster as Roster,
} from "../api/todayRoster.api";

export interface TodayRosterProps {
  roster: Roster | undefined;
  loading: boolean;
  error?: Error | undefined;
  onRetry: () => void;
}

/**
 * How many departments get named in a block's breakdown before the rest become "Others".
 *
 * Four departments have anybody in them today, so the practical effect is Management, Ground
 * and Restaurant named, with Coorg and the unassigned folded into Others. A cap rather than a
 * list, because a venue that grows to fifteen departments must not get a fifteen-line stat block.
 */
const NAMED_IN_BREAKDOWN = 3;

/** One metric, split across departments. */
type Metric = "present" | "absent" | "onLeave";

interface BreakdownPart {
  readonly key: string;
  readonly name: string;
  readonly value: number;
}

/**
 * The department split for one metric, in the same order the tables below use.
 *
 * Zeroes are KEPT for a named department. "Ground 0" is the whole point of a breakdown — a
 * present count of 60 that silently omitted Ground would read as though Ground were not on the
 * roll, when what actually happened is that none of them scanned.
 */
function breakdownFor(groups: readonly RosterGroup[], metric: Metric): BreakdownPart[] {
  const named = groups.slice(0, NAMED_IN_BREAKDOWN).map((g) => ({
    key: g.key,
    name: g.name,
    value: g.counts[metric],
  }));
  const rest = groups.slice(NAMED_IN_BREAKDOWN);
  if (rest.length === 0) return named;
  return [
    ...named,
    {
      key: "__others",
      name: t("admin.roster.breakdown.others", { n: String(rest.length) }),
      value: rest.reduce((sum, g) => sum + g.counts[metric], 0),
    },
  ];
}

/**
 * The three headline numbers, each split by department.
 *
 * Unlike the six tiles this replaced, the three partition the roll — so they can be read as a
 * whole. The split was asked for because a total alone cannot be acted on: "60 present" is a
 * fact about the venue, "Ground 30" is a fact somebody can do something about. Same grouping
 * and same order as the tables below, so the eye can move between them.
 */
function Blocks({
  counts,
  groups,
}: {
  counts: Roster["counts"];
  groups: readonly RosterGroup[];
}): React.JSX.Element {
  const blocks = [
    {
      key: "present" as const,
      icon: UserCheck,
      label: t("admin.roster.present"),
      value: counts.present,
      tone: "text-success",
    },
    {
      key: "absent" as const,
      icon: UserX,
      label: t("admin.roster.absent"),
      value: counts.absent,
      tone: counts.absent > 0 ? "text-destructive" : "text-muted-foreground",
    },
    {
      key: "onLeave" as const,
      icon: CalendarOff,
      label: t("admin.roster.onLeave"),
      value: counts.onLeave,
      tone: "text-foreground",
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {blocks.map((b) => (
        <div key={b.key} className="rounded-xl border bg-card p-4">
          <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            <b.icon className="size-3.5 shrink-0" aria-hidden />
            {b.label}
          </p>
          <p className={cn("mt-1 font-mono text-4xl font-semibold tabular-nums", b.tone)}>
            {b.value}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("admin.roster.ofOnRoll", { total: String(counts.onRoll) })}
          </p>

          {/*
            The split. A definition list rather than a sentence: these are label/number pairs
            somebody scans down rather than reads.
          */}
          <dl className="mt-3 space-y-1 border-t pt-2">
            {breakdownFor(groups, b.key).map((part) => (
              <div key={part.key} className="flex items-baseline justify-between gap-3">
                <dt className="truncate text-[11px] text-muted-foreground">{part.name}</dt>
                <dd
                  className={cn(
                    "shrink-0 font-mono text-xs font-semibold tabular-nums",
                    part.value === 0 ? "text-muted-foreground" : b.tone,
                  )}
                >
                  {part.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/**
 * The day's punches, in order, each with where it was taken.
 *
 * ── WHY A TIMELINE AND NOT ONE LOCATION ──────────────────────────────────────
 * This replaced two columns — "Captured via" and "Location" — which between them showed a
 * SINGLE fix per person, web preferred over the gate. That answered "was this person away
 * today" and could not answer "away WHEN": a day of 09:00 at the gate and 19:00 from home
 * rendered only the 19:00, and the arrival disappeared.
 *
 * A punch timeline is what an attendance row shows across this industry, and it is what was
 * asked for — the location of the in AND the out, together in one column.
 *
 * ── WHAT EACH CHIP SAYS, AND WHAT IT LEAVES OUT ──────────────────────────────
 * Time, then how. A GATE punch carries no distance: the tablet is bolted to a known wall and
 * its own fixes cluster inside about 17 m by 32 m, so a number there is GPS noise dressed as a
 * measurement. A WEB punch is the whole reason this column exists, so it carries the distance
 * and turns amber past the venue's own radius.
 *
 * The chips wrap rather than scroll. A day with eight punches is unusual and worth seeing
 * whole; a horizontal scrollbar inside a table cell is where information goes to hide.
 */
/**
 * One scan, rendered as a time that carries its own evidence.
 *
 * The icon says which door it came through, the number beside a web punch says how far from
 * the venue, and the star says an administrator has still to accept it. The hover text spells
 * all of that out, and a punch with coordinates links to the map.
 */
function PunchChip({ punch }: { punch: PunchOnRoster | null }): React.JSX.Element {
  if (punch === null) return <span className="text-muted-foreground">—</span>;

  const away = punch.via === "web" && punch.distance !== null && !punch.distance.withinFence;
  const href =
    punch.latitude === null || punch.longitude === null
      ? null
      : openStreetMapUrl({
        latitude: punch.latitude,
        longitude: punch.longitude,
        accuracyMetres: punch.accuracyMetres,
      });

  const title = [
    punch.via === "web" ? t("admin.roster.loc.viaWeb") : t("admin.roster.loc.viaGate"),
    punch.distance === null
      ? t("admin.roster.loc.noVenue")
      : t("admin.roster.loc.away", { d: formatDistance(punch.distance.metres) }),
    punch.accuracyMetres === null
      ? null
      : t("admin.roster.loc.accuracy", { m: String(Math.round(punch.accuracyMetres)) }),
    punch.awaitingApproval ? t("admin.roster.loc.awaiting") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const body = (
    <>
      {punch.via === "web" ? (
        <Globe className="size-3 shrink-0" aria-hidden />
      ) : (
        <ScanFace className="size-3 shrink-0" aria-hidden />
      )}
      <span className="tabular-nums">{punch.at}</span>
      {punch.via === "web" && punch.distance !== null ? (
        <span className="opacity-80">{formatDistance(punch.distance.metres)}</span>
      ) : null}
      {punch.awaitingApproval ? <span className="text-warning">*</span> : null}
    </>
  );

  const chip = cn(
    "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px]",
    away ? "border-warning/50 bg-warning/10 text-warning" : "text-muted-foreground",
  );

  return href === null ? (
    <span className={chip} title={title}>{body}</span>
  ) : (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // The row itself opens the person, so a map link must not also trigger that.
      onClick={(e) => e.stopPropagation()}
      className={cn(chip, "underline decoration-dotted underline-offset-2 hover:decoration-solid")}
      title={title}
    >
      {body}
    </a>
  );
}

/**
 * The day's scans as IN and OUT columns, one row per session, with the arithmetic.
 *
 * Four chips in a row could not say which scan was an arrival, which a departure, or which
 * pair was the shift and which was somebody returning at night. `sessionsFromPunches` pairs
 * them the way the attendance engine does, so the figures here add up to the worked total in
 * the next column rather than being a second opinion about it.
 *
 * The sum is written out — 7h 50m + 1h 05m = 8h 55m — and only when there IS a second session.
 * A single pair is just a day, and spelling out "7h 50m = 7h 50m" would be noise on every row.
 */
function PunchesCell({ punches }: { punches: readonly PunchOnRoster[] }): React.JSX.Element {
  const sessions = sessionsFromPunches(punches);
  if (sessions.length === 0) return <span className="text-muted-foreground">—</span>;
  const totals = sessionTotals(sessions);

  return (
    <div className="min-w-[15rem]">
      <table className="w-full border-separate border-spacing-x-2 border-spacing-y-0.5 text-[11px]">
        <thead>
          <tr className="text-left uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="font-medium">&nbsp;</th>
            <th scope="col" className="font-medium">{t("admin.roster.sess.in")}</th>
            <th scope="col" className="font-medium">{t("admin.roster.sess.out")}</th>
            <th scope="col" className="text-right font-medium">&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s, i) => (
            <tr key={`${s.inPunch.at}-${i}`}>
              <th
                scope="row"
                className={cn(
                  "whitespace-nowrap text-left font-medium",
                  s.kind === "extra" ? "text-success" : "text-muted-foreground",
                )}
              >
                {t(s.kind === "extra" ? "admin.roster.sess.extra" : "admin.roster.sess.shift")}
              </th>
              <td><PunchChip punch={s.inPunch} /></td>
              <td><PunchChip punch={s.outPunch} /></td>
              <td className="whitespace-nowrap text-right tabular-nums">
                {s.minutes === null ? (
                  <span className="text-muted-foreground">{t("admin.roster.sess.open")}</span>
                ) : (
                  <span className={s.kind === "extra" ? "font-medium text-success" : undefined}>
                    {fmtDurationHm(s.minutes)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/*
        The sum, in the reader's own words. Rendered only for a day with a second session —
        that is the day the number in the next column needs explaining.
      */}
      {totals.hasExtra ? (
        <p className="mt-1 border-t pt-1 text-right text-[11px] tabular-nums text-muted-foreground">
          {fmtDurationHm(totals.shiftMinutes)}
          <span className="mx-1">+</span>
          <span className="text-success">{fmtDurationHm(totals.extraMinutes)}</span>
          <span className="mx-1">=</span>
          <span className="font-medium text-foreground">{fmtDurationHm(totals.totalMinutes)}</span>
          {totals.open ? <span className="ml-1">{t("admin.roster.sess.open")}</span> : null}
        </p>
      ) : null}
    </div>
  );
}


function StateCell({ row }: { row: RosterRow }): React.JSX.Element {
  if (row.attended) {
    return (
      <span className="inline-flex items-center rounded-full bg-success/12 px-2 py-0.5 text-xs font-medium text-success">
        {t("admin.roster.state.present")}
      </span>
    );
  }
  if (row.offToday) {
    return (
      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        {t("admin.roster.state.off")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-destructive/12 px-2 py-0.5 text-xs font-medium text-destructive">
      {t("admin.roster.state.absent")}
    </span>
  );
}

/**
 * Hours worked — and it must never say a person who has been here since 09:20 has done nothing.
 *
 * ── THE TWO BUGS THIS FIXES ──────────────────────────────────────────────────
 * It used to render `row.attended ? worked : "—"`. That hid REAL hours: Deepesh punched in at
 * 07:59 and out at 09:28, which the engine recorded as 88 minutes worked and — correctly, since
 * 88 minutes does not earn a day — a status of `absent`. `attended` is false for `absent`, so
 * the column showed "—" against 1h 28m of actual work.
 *
 * And it showed a bare "0h 00m" for the 54 people who had scanned IN and not yet OUT. That is
 * the engine being right and the screen being useless: `total_worked_minutes` counts COMPLETED
 * intervals, so it is genuinely 0 until somebody scans out. Rendering that beside "Present"
 * reads as a whole shift of nothing.
 *
 * ── SO: THE ENGINE'S FIGURE WHEN THERE IS ONE, A LIVE CLOCK WHEN THERE IS NOT ─
 * The two are labelled differently on purpose and are NOT the same measurement. The engine's
 * number is paid time, with the shift's unpaid break already subtracted. The live clock is
 * wall-clock time since the first scan with nothing deducted, so it runs ahead by exactly that
 * break — which is why it is captioned "on site" and never "worked".
 */
function WorkedCell({ row, nowMs }: { row: RosterRow; nowMs: number }): React.JSX.Element {
  const shown = workedDisplay({
    workedMinutes: row.workedMinutes,
    firstInAt: row.firstInAt,
    lastOutAt: row.lastOutAt,
    nowMs,
  });

  switch (shown.kind) {
    case "credited":
      return (
        <span className="inline-flex flex-col items-end leading-tight">
          <span>
            {fmtDurationHm(shown.minutes)}
            {/*
              THE STAR. The hours above ARE in this day's figure; they are held OUT of the
              monthly total until an administrator accepts the reason. Without the mark the two
              numbers simply disagree and a reader has no way to know why.
            */}
            {row.awaitingApproval > 0 ? (
              <span
                className="ml-0.5 text-warning"
                title={t("admin.roster.awaitingApproval", {
                  n: String(row.awaitingApproval),
                })}
              >
                *
              </span>
            ) : null}
          </span>
          {/* Still here after an out-scan: the engine's figure is settled, the clock is not. */}
          {shown.alsoOnSite !== null ? (
            <span className="text-[10px] text-muted-foreground">
              {t("admin.roster.onSite", { value: formatElapsed(shown.alsoOnSite) })}
            </span>
          ) : null}
        </span>
      );
    case "running":
      return (
        <span className="inline-flex flex-col items-end leading-tight">
          <span className="text-foreground">{formatElapsed(shown.elapsed)}</span>
          <span className="text-[10px] text-muted-foreground">{t("admin.roster.onSiteTag")}</span>
        </span>
      );
    case "span":
      return (
        <span className="inline-flex flex-col items-end leading-tight">
          <span className="text-foreground">{formatElapsed(shown.elapsed)}</span>
          <span className="text-[10px] text-warning">{t("admin.roster.spanUncredited")}</span>
        </span>
      );
    case "none":
      return <span className="text-muted-foreground">—</span>;
  }
}

/**
 * Over or under the shift — but only once the day has an end.
 *
 * ── WHY THE `attended` GATE WENT ─────────────────────────────────────────────
 * It suppressed the figure for anybody the engine had not called present, which included
 * Deepesh at 88 minutes worked against an 8-hour shift. That is a −6h 32m day and precisely the
 * row somebody wants to see; hiding it behind a status flag made the shortest day on the
 * dashboard the one with no number.
 *
 * ── WHY AN OPEN DAY STILL SHOWS NOTHING ──────────────────────────────────────
 * It used to read "−8h 00m" for everybody who had scanned in and not out, because worked was 0
 * against an expected 480. Somebody who arrived twenty minutes ago has not failed to work eight
 * hours; the day has not finished asking. A number that is wrong all morning and right at
 * closing time is worse than a dash, and the live clock in the next column already says what is
 * happening. So the variance appears once there is an out-scan.
 */
function VarianceCell({ row }: { row: RosterRow }): React.JSX.Element {
  const open = row.firstInAt !== null && row.lastOutAt === null;
  if (row.varianceMinutes === null || open) {
    return <span className="text-muted-foreground">—</span>;
  }
  const v = row.varianceMinutes;
  return (
    <span className={v > 0 ? "text-success" : v < 0 ? "text-destructive" : "text-muted-foreground"}>
      {v === 0 ? "0m" : `${v > 0 ? "+" : "−"}${fmtDurationHm(Math.abs(v))}`}
    </span>
  );
}

/**
 * The per-department tally that sits in a group heading.
 *
 * Absent and on-leave are dimmed to muted at zero rather than hidden. A department with nobody
 * missing should still show that column, because a heading whose shape changes with the day is
 * one somebody has to re-read every morning to work out what they are looking at.
 */
function GroupTally({ counts }: { counts: RosterCounts }): React.JSX.Element {
  const parts = [
    { key: "present", label: t("admin.roster.present"), value: counts.present, tone: "text-success" },
    {
      key: "absent",
      label: t("admin.roster.absent"),
      value: counts.absent,
      tone: counts.absent > 0 ? "text-destructive" : "text-muted-foreground",
    },
    {
      key: "leave",
      label: t("admin.roster.onLeave"),
      value: counts.onLeave,
      tone: counts.onLeave > 0 ? "text-foreground" : "text-muted-foreground",
    },
  ];
  return (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {parts.map((p) => (
        <div key={p.key} className="flex items-baseline gap-1.5">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{p.label}</dt>
          <dd className={cn("font-mono text-sm font-semibold tabular-nums", p.tone)}>{p.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Group({
  group,
  nowMs,
  onOpen,
}: {
  group: RosterGroup;
  nowMs: number;
  onOpen: (row: RosterRow) => void;
}): React.JSX.Element | null {
  const rows = group.rows;
  if (rows.length === 0) return null;
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-4 py-3">
        <div>
          <h3 className="font-display text-sm font-semibold">
            {group.name}
            <span className="ml-2 font-normal text-muted-foreground">
              {t("admin.roster.group.onRoll", { n: String(group.counts.onRoll) })}
            </span>
          </h3>
        </div>
        <GroupTally counts={group.counts} />
      </div>

      {/* The table scrolls inside its own box; the page never scrolls sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[64rem] text-sm">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">{t("admin.roster.col.employee")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("admin.roster.col.state")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("admin.roster.col.in")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("admin.roster.col.out")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("admin.roster.col.punches")}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t("admin.roster.col.worked")}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t("admin.roster.col.variance")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.employeeId}
                /*
                  The whole row opens the person, not a link in one cell: on a table this wide
                  the target somebody aims at is the name they are already reading.
                */
                onClick={() => onOpen(row)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(row);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={t("admin.roster.openAria", { name: row.displayName })}
                className="cursor-pointer border-b last:border-0 hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
              >
                <td className="px-4 py-2.5">
                  <span className="block font-medium">{row.displayName}</span>
                  {/* Designation, not department — the department is the heading above. */}
                  <span className="block text-[11px] text-muted-foreground">
                    {row.employeeCode}
                    {row.designationName !== null ? ` · ${row.designationName}` : ""}
                  </span>
                </td>
                <td className="px-3 py-2.5"><StateCell row={row} /></td>
                <td className="px-3 py-2.5 tabular-nums">
                  {row.firstInHm ?? <span className="text-muted-foreground">—</span>}
                  {row.lateMinutes > 0 ? (
                    <span className="ml-1.5 text-[11px] text-warning">
                      {t("admin.roster.lateBy", { value: fmtDurationHm(row.lateMinutes) })}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 tabular-nums">
                  {row.lastOutHm ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2.5"><PunchesCell punches={row.punches} /></td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  <WorkedCell row={row} nowMs={nowMs} />
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums"><VarianceCell row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function TodayRoster({
  roster,
  loading,
  error,
  onRetry,
}: TodayRosterProps): React.JSX.Element {
  const navigate = useNavigate();

  /*
    One clock for the whole table, and only while somebody is actually still on site. Ticking
    after the last person has scanned out would re-render eighty rows every second for no visible
    change; ticking per row would put eighty intervals on the page.
  */
  const anyRunning = (roster?.groups ?? []).some((g) =>
    g.rows.some((r) => r.firstInAt !== null && r.lastOutAt === null),
  );
  const nowMs = useTick(anyRunning);

  const open = useMemo(
    () => (row: RosterRow) => {
      /*
        Straight to the person's own attendance screen, which already carries every computed day,
        every scan pair and — since this roster was added — the period's over/under total.
        Building a second per-employee attendance view here would be a second place for those
        numbers to be computed, and eventually to disagree.

        The route is keyed on the employee CODE, not the id: `/admin/people/:code/attendance`
        looks the person up by `employee_code`. An earlier draft of this file passed the uuid,
        which resolves to nobody and renders the "no such employee" state.
      */
      navigate(`/admin/people/${encodeURIComponent(row.employeeCode)}/attendance`);
    },
    [navigate],
  );

  return (
    <StateBoundary
      loading={loading}
      error={error}
      onRetry={onRetry}
      skeletonRows={6}
    >
      {roster === undefined ? null : (
        <div className="space-y-4">
          <Blocks counts={roster.counts} groups={roster.groups} />

          {roster.truncated ? (
            <p className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
              {t("admin.roster.truncated")}
            </p>
          ) : null}

          {/*
            One table per department that has somebody on roll, in the order the API decided —
            Management first, then by headcount. Built from the data rather than a fixed list, so
            a new department appears on its own and the seventeen empty ones never render.
          */}
          {roster.groups.map((group) => (
            <Group key={group.key} group={group} nowMs={nowMs} onOpen={open} />
          ))}
        </div>
      )}
    </StateBoundary>
  );
}
