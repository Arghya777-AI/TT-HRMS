/**
 * RosterWeek.tsx — the three pieces the roster screens share: the Monday-to-Monday
 * stepper, a slice tile whose number came from a server COUNT, and the
 * people × seven-days week grid.
 *
 * They live in one component module because /team/roster, /admin/attendance/roster
 * and /admin/attendance/coverage must render a roster week IDENTICALLY. A manager
 * and an administrator looking at the same Banquet week have to see the same
 * shift codes, the same draft markers and the same blank cells; two hand-rolled
 * grids would eventually disagree, and the roster is the one artefact both roles
 * plan against.
 *
 * What the grid will not do:
 *  * No cell is computed. A cell prints the slot row as stored — the shift code
 *    from the shift master, the planned window when the slot carries one, the
 *    role label, the draft marker, the swap marker.
 *  * An EMPTY CELL MEANS THERE IS NO SLOT ROW for that person-date. It is not a
 *    weekly off (that is a row with `is_weekly_off`), and it is never counted:
 *    the absence of a row cannot be filtered over `roster_slots`, so it is shown
 *    and stated, never quantified.
 *  * Rows are PEOPLE, columns are dates. Nothing is totalled in either direction.
 */
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { fmtCivilDate, fmtCivilDayMonthWeekday, fmtCivilTime, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { PersonCell } from "@/features/admin/components/PersonCell";
import { istWeekDates, istWeekRange, shiftIstWeek, type RosterSlot } from "../api/roster.api";
import type { ShiftRefMap } from "../hooks/useRoster";

/** Monday-to-Monday stepper. Forward is NOT capped — a roster looks ahead. */
export function WeekStepper({
  weekStart,
  onChange,
}: {
  weekStart: string;
  onChange: (weekStart: string) => void;
}) {
  const { from, to } = istWeekRange(weekStart);
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="icon"
        aria-label={t("team.roster.week.previous")}
        onClick={() => onChange(shiftIstWeek(weekStart, -1))}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="num min-w-[13rem] text-center text-sm font-medium" aria-live="polite">
        {t("team.roster.week.label", { from: fmtCivilDate(from), to: fmtCivilDate(to) })}
      </span>
      <Button
        variant="outline"
        size="icon"
        aria-label={t("team.roster.week.next")}
        onClick={() => onChange(shiftIstWeek(weekStart, 1))}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** The subset of `UseQueryResult` a tile needs — the same shape CountTile uses. */
export interface RosterCountState {
  data: number | undefined;
  error: Error | null;
  isPending: boolean;
}

/**
 * A tile whose number is a Postgres COUNT over the SAME predicate as the grid
 * beside it. When it cannot be read it shows an em dash, never a plausible zero;
 * when `onClick` is given it also selects that slice, so the number an admin
 * presses is the cardinality of what they then look at.
 */
export function RosterSlotTile({
  label,
  hint,
  count,
  active,
  onClick,
  unavailable,
}: {
  label: string;
  hint?: string;
  count: RosterCountState;
  active?: boolean;
  onClick?: () => void;
  /** Why this number is not being asked for at all, e.g. a filter it cannot honour. */
  unavailable?: string;
}) {
  const body = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num mt-1 font-display text-xl font-semibold">
        {unavailable !== undefined
          ? t("common.empty")
          : count.isPending
            ? "…"
            : count.error !== null
              ? t("common.empty")
              : formatNumber(count.data)}
      </p>
      {unavailable !== undefined ? (
        <p className="mt-1 text-xs text-warning">{unavailable}</p>
      ) : hint !== undefined ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </>
  );

  if (onClick === undefined) {
    return <div className="rounded-lg border bg-card p-3">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active === true}
      className={cn(
        "rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active === true && "ring-2 ring-primary",
      )}
    >
      {body}
    </button>
  );
}

/** One day cell: the slot as stored, or an empty cell that means "no slot row". */
function SlotCell({
  slot,
  shifts,
}: {
  slot: RosterSlot | undefined;
  shifts: ShiftRefMap | undefined;
}) {
  if (slot === undefined) {
    return <span className="text-muted-foreground">{t("common.empty")}</span>;
  }
  if (slot.is_weekly_off) {
    return <span className="text-xs text-muted-foreground">{t("team.roster.cell.weeklyOff")}</span>;
  }
  const shift = slot.shift_id === null ? undefined : shifts?.get(slot.shift_id);
  // Both branches are server values, printed. Nothing is reconciled here: when a
  // slot carries its own planned window that window IS the plan; otherwise the
  // shift master's civil window is what the engine will read.
  const window =
    slot.planned_start_at !== null && slot.planned_end_at !== null
      ? `${fmtDateTime(slot.planned_start_at)} – ${fmtDateTime(slot.planned_end_at)}`
      : shift !== undefined
        ? `${fmtCivilTime(shift.start_time)}–${fmtCivilTime(shift.end_time)}`
        : null;
  return (
    <span className="flex flex-col leading-tight">
      <span className="text-xs font-medium">{dash(shift?.code)}</span>
      {window !== null ? <span className="num text-xs text-muted-foreground">{window}</span> : null}
      {slot.role_label !== null && slot.role_label !== "" ? (
        <span className="truncate text-xs text-muted-foreground">{slot.role_label}</span>
      ) : null}
      {!slot.is_published ? (
        <span className="text-xs text-warning">{t("team.roster.cell.draft")}</span>
      ) : null}
      {slot.swap_status !== null ? (
        <span className="text-xs text-info">{t("team.roster.cell.swap")}</span>
      ) : null}
    </span>
  );
}

export interface RosterWeekPerson {
  readonly id: string;
  readonly name: string | null;
  readonly code: string | null;
  readonly secondary?: string | null;
}

export interface RosterWeekGridProps {
  /** The IST Monday the seven columns start from. */
  weekStart: string;
  /** Grid rows, in the order the caller's server read produced them. */
  people: readonly RosterWeekPerson[];
  /** employee_id → slot_date → slot, from `useRosterGrid`. */
  slotsByEmployee: ReadonlyMap<string, ReadonlyMap<string, RosterSlot>>;
  shifts: ShiftRefMap | undefined;
  pageSize?: number;
  toolbar?: ReactNode;
}

export function RosterWeekGrid({
  weekStart,
  people,
  slotsByEmployee,
  shifts,
  pageSize = 15,
  toolbar,
}: RosterWeekGridProps) {
  const days = istWeekDates(weekStart);
  const columns: DataGridColumn<RosterWeekPerson>[] = [
    {
      key: "person",
      header: t("team.roster.col.who"),
      width: "13rem",
      sortable: true,
      sortValue: (r) => r.name,
      render: (r) => (
        <PersonCell name={r.name} code={r.code} secondary={r.secondary ?? null} />
      ),
    },
    ...days.map(
      (date): DataGridColumn<RosterWeekPerson> => ({
        key: date,
        header: fmtCivilDayMonthWeekday(date),
        width: "9rem",
        render: (r) => <SlotCell slot={slotsByEmployee.get(r.id)?.get(date)} shifts={shifts} />,
      }),
    ),
  ];

  return (
    <DataGrid
      columns={columns}
      rows={people}
      rowKey={(r) => r.id}
      pageSize={pageSize}
      {...(toolbar !== undefined ? { toolbar } : {})}
    />
  );
}
