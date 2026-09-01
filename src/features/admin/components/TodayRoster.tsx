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
import { CalendarOff, Globe, MapPin, ScanFace, UserCheck, UserX } from "lucide-react";
import { formatDistance } from "@/lib/venueDistance";
import { elapsedOnSite, formatElapsed } from "../liveWorked";
import { useTick } from "../hooks/useTick";
import { openStreetMapUrl } from "@/lib/punchPlace";
import { t } from "@/shared/i18n/en";
import { fmtDurationHm } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import type {
  CaptureMethod,
  PunchFixOnRoster,
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

/*
  Typed to `t`'s own key union rather than `string`, so a mistyped key is a compile error here
  instead of a raw key name rendered on screen.
*/
const METHOD_LABEL: Record<CaptureMethod, Parameters<typeof t>[0]> = {
  gate: "admin.roster.method.gate",
  web: "admin.roster.method.web",
  mixed: "admin.roster.method.mixed",
  none: "admin.roster.method.none",
};

function MethodCell({ method }: { method: CaptureMethod }): React.JSX.Element {
  if (method === "none") return <span className="text-muted-foreground">—</span>;
  // The icon carries the same fact as the word, for a table read at a glance across a room.
  const Icon = method === "web" ? Globe : ScanFace;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {t(METHOD_LABEL[method])}
    </span>
  );
}

/**
 * Where the punch was taken, and how far that is from the venue.
 *
 * ── WHY THE GATE READS DIFFERENTLY FROM THE WEB ──────────────────────────────
 * A gate punch's coordinates are barely information: the tablet is bolted to a known wall, and
 * its 844 recorded fixes sit inside about 17 m × 32 m. So a gate row says "at the gate" and
 * offers the map link without a number, because "12 m from the venue" is GPS noise dressed up
 * as a fact.
 *
 * A WEB punch is the whole reason this column exists. Nobody watched the person arrive, so the
 * distance IS the evidence — and it is stated plainly, in metres under a kilometre and
 * kilometres above, with the map link beside it. That is the "see location" an admin asked for.
 *
 * ── WHAT IT REFUSES TO SAY ───────────────────────────────────────────────────
 * With no venue point configured there is no distance, and this renders the coordinates alone
 * rather than inventing a centre to measure from. And a fix too coarse to resolve the venue's
 * own radius is marked as approximate instead of being presented as a clean inside/outside — a
 * ±800 m reading against a 300 m fence has an error bar wider than the thing measured.
 */
function LocationCell({ fix }: { fix: PunchFixOnRoster | null }): React.JSX.Element {
  if (fix === null) return <span className="text-muted-foreground">—</span>;

  const href = openStreetMapUrl({
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracyMetres: fix.accuracyMetres,
  });

  const distance = fix.distance;
  const label = fix.via === "gate"
    ? t("admin.roster.loc.atGate")
    : distance === null
      ? t("admin.roster.loc.noVenue")
      : t("admin.roster.loc.away", { d: formatDistance(distance.metres) });

  return (
    <span className="inline-flex items-center gap-1.5">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        // The row itself opens the person, so the map link must not also trigger that.
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:decoration-solid",
          fix.via === "web" && distance !== null && !distance.withinFence
            ? "text-warning"
            : "text-muted-foreground",
        )}
        title={t("admin.roster.loc.mapTitle", {
          lat: fix.latitude.toFixed(6),
          lng: fix.longitude.toFixed(6),
          acc: fix.accuracyMetres === null ? "?" : String(Math.round(fix.accuracyMetres)),
        })}
      >
        <MapPin className="size-3.5 shrink-0" aria-hidden />
        {label}
      </a>
      {distance?.coarse === true ? (
        <span className="text-[10px] uppercase text-muted-foreground">
          {t("admin.roster.loc.approx")}
        </span>
      ) : null}
    </span>
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
  const elapsed = elapsedOnSite({
    firstInAt: row.firstInAt,
    lastOutAt: row.lastOutAt,
    nowMs,
    // This table is today, by construction — `fetchTodayRoster` reads the today board.
    isLive: true,
  });

  if (row.workedMinutes > 0) {
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <span>{fmtDurationHm(row.workedMinutes)}</span>
        {/* Still here after an out-scan: the engine's figure is settled, the clock is not. */}
        {elapsed.running ? (
          <span className="text-[10px] text-muted-foreground">
            {t("admin.roster.onSite", { value: formatElapsed(elapsed) })}
          </span>
        ) : null}
      </span>
    );
  }

  if (elapsed.running) {
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <span className="text-foreground">{formatElapsed(elapsed)}</span>
        <span className="text-[10px] text-muted-foreground">{t("admin.roster.onSiteTag")}</span>
      </span>
    );
  }

  return <span className="text-muted-foreground">—</span>;
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
              <th scope="col" className="px-3 py-2 font-medium">{t("admin.roster.col.method")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("admin.roster.col.location")}</th>
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
                <td className="px-3 py-2.5"><MethodCell method={row.method} /></td>
                <td className="px-3 py-2.5"><LocationCell fix={row.fix} /></td>
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
