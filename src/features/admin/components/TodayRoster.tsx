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
import { t } from "@/shared/i18n/en";
import { fmtDurationHm } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import type {
  CaptureMethod,
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

/** The three headline numbers. Unlike the old tiles, these partition the roll. */
function Blocks({ counts }: { counts: Roster["counts"] }): React.JSX.Element {
  const blocks = [
    {
      key: "present",
      icon: UserCheck,
      label: t("admin.roster.present"),
      value: counts.present,
      tone: "text-success",
    },
    {
      key: "absent",
      icon: UserX,
      label: t("admin.roster.absent"),
      value: counts.absent,
      tone: counts.absent > 0 ? "text-destructive" : "text-muted-foreground",
    },
    {
      key: "leave",
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

function VarianceCell({ row }: { row: RosterRow }): React.JSX.Element {
  if (row.varianceMinutes === null || !row.attended) {
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
  onOpen,
}: {
  group: RosterGroup;
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
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">{t("admin.roster.col.employee")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("admin.roster.col.state")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("admin.roster.col.in")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("admin.roster.col.out")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("admin.roster.col.method")}</th>
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
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {row.attended ? fmtDurationHm(row.workedMinutes) : <span className="text-muted-foreground">—</span>}
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
          <Blocks counts={roster.counts} />

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
            <Group key={group.key} group={group} onOpen={open} />
          ))}
        </div>
      )}
    </StateBoundary>
  );
}
