/**
 * LeaveCalendarBand — the month of leave, at the top of the Command Centre.
 *
 * WHY IT IS HERE AND NOT ONLY AT /admin/leave/calendar. The full org calendar has
 * existed all along, four clicks into the leave section, and an administrator opening
 * the console saw twelve counters and no shape of the month. Who is off, when, and
 * how thin a given day gets is the question a venue manager actually arrives with, so
 * it leads — and it links onward to the full screen for filtering by department and
 * leave type, which this band deliberately does not duplicate.
 *
 * THE YEAR IS A FIRST-CLASS CONTROL, not a pair of arrows. `MonthStepper` exists but
 * caps forward navigation at the current month, which is right for attendance (there
 * are no future punches) and wrong for leave — approved leave is mostly in the future,
 * and a calendar that refuses to show December is not a leave calendar. So this has
 * its own year stepper and a row of twelve month chips: fewer clicks to reach any
 * month than arrows can manage, and it reads as a control surface rather than a
 * paginator.
 *
 * INTENSITY IS ONE HUE, LIGHT TO DARK. Leave count per day is a magnitude, so it gets
 * a sequential ramp of a single hue and never a rainbow — the density of a day has an
 * order, and hues do not. The number is always printed as well as tinted, because
 * colour alone is not a value.
 *
 * MOBILE IS THE SAME GRID, NOT A DIFFERENT SCREEN. Seven columns survive on a phone
 * because a month has a shape and an agenda list destroys it; what changes is that
 * cells drop to a number plus a count, and tapping one opens the day's people in a
 * panel below. That keeps one mental model at every width.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DayDetailDialog } from "@/shared/ui/DayDetailDialog";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { formatNumber } from "@/lib/format";
import {
  fmtCivilDayMonthWeekday,
  fmtCivilWeekday,
  fmtMonthLong,
  istMonthDates,
  istMonthRange,
  istToday,
  nowIstMonth,
  type IstMonthKey,
} from "@/lib/datetime";
import { asArray } from "@/lib/asArray";
import type { LeaveCalendarRow } from "../api/leave.api";
import { useOrgLeaveCalendar } from "../hooks/useLeaveConfig";
import { ADMIN_ROUTES } from "../command-vocab";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Jan…Dec chips. Index + 1 is the month number, so no month-name parsing. */
const MONTH_CHIPS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

interface DayCell {
  readonly date: string;
  readonly dayOfMonth: string;
  readonly rows: readonly LeaveCalendarRow[];
  /** Distinct people — one person can hold two counted rows in a day. */
  readonly people: number;
  readonly isToday: boolean;
  readonly isWeekend: boolean;
}

/**
 * Four steps of one hue. Thresholds are absolute head-count, not a percentage of the
 * venue: an administrator reads "three people off" as a fact about the rota, and a
 * ratio would need a denominator this band does not have and should not guess.
 */
function intensityClass(people: number): string {
  if (people === 0) return "bg-card";
  if (people === 1) return "bg-primary/10";
  if (people <= 3) return "bg-primary/20";
  if (people <= 6) return "bg-primary/35";
  return "bg-primary/50";
}

function monthKeyOf(year: number, monthIndex: number): IstMonthKey {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}` as IstMonthKey;
}

export function LeaveCalendarBand() {
  const today = istToday();
  const [month, setMonth] = useState<IstMonthKey>(nowIstMonth() as IstMonthKey);
  const [openDate, setOpenDate] = useState<string | null>(null);

  const year = Number.parseInt(month.slice(0, 4), 10);
  const monthIndex = Number.parseInt(month.slice(5, 7), 10) - 1;
  const range = istMonthRange(month);

  const calendar = useOrgLeaveCalendar({ from: range.from, to: range.to });
  const rows = asArray(calendar.data);

  const cells = useMemo<DayCell[]>(() => {
    const byDate = new Map<string, LeaveCalendarRow[]>();
    for (const row of rows) {
      const list = byDate.get(row.leave_date) ?? [];
      list.push(row);
      byDate.set(row.leave_date, list);
    }
    return istMonthDates(month).map((date) => {
      const dayRows = byDate.get(date) ?? [];
      const weekday = fmtCivilWeekday(date);
      return {
        date,
        dayOfMonth: date.slice(8, 10),
        rows: dayRows,
        people: new Set(dayRows.map((row) => row.employee_id)).size,
        isToday: date === today,
        isWeekend: weekday === "Sat" || weekday === "Sun",
      };
    });
  }, [rows, month, today]);

  const leadingBlanks = useMemo(() => {
    const first = cells[0];
    if (first === undefined) return 0;
    return WEEKDAYS.indexOf(fmtCivilWeekday(first.date) as (typeof WEEKDAYS)[number]);
  }, [cells]);

  const totalLeaveDays = rows.length;
  const distinctPeople = new Set(rows.map((row) => row.employee_id)).size;
  const openCell = cells.find((cell) => cell.date === openDate) ?? null;

  return (
    <section
      aria-label={t("admin.cc.calendar.title")}
      className="relative overflow-hidden rounded-xl border bg-card"
    >
      {/*
        The one decorative flourish, and it is a gradient rather than an image so it
        costs nothing and inverts correctly in dark mode. It sits behind the header
        only — the grid itself stays on the plain card surface, because a tinted
        background under a tinted intensity scale would make the scale unreadable.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent"
      />

      <div className="relative p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <CalendarDays className="size-5 text-primary" aria-hidden />
              {t("admin.cc.calendar.title")}
            </h2>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              {t("admin.cc.calendar.subtitle")}
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to={ADMIN_ROUTES.orgLeaveCalendar}>{t("admin.cc.calendar.openFull")}</Link>
          </Button>
        </div>

        {/* ── Year, then month. Two controls, no arrows-only navigation. ────── */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div
            className="flex items-center gap-1 rounded-lg border bg-background/80 p-1"
            role="group"
            aria-label={t("admin.cc.calendar.yearAria")}
          >
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`${year - 1}`}
              onClick={() => setMonth(monthKeyOf(year - 1, monthIndex))}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <span className="num min-w-[3.5rem] text-center text-sm font-semibold tabular-nums">
              {year}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`${year + 1}`}
              onClick={() => setMonth(monthKeyOf(year + 1, monthIndex))}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>

          {/* Twelve chips, scrollable on a phone rather than wrapped into four rows. */}
          <div className="-mx-1 flex flex-1 gap-1 overflow-x-auto px-1 pb-1">
            {MONTH_CHIPS.map((label, index) => {
              const key = monthKeyOf(year, index);
              const active = key === month;
              return (
                <Button
                  key={label}
                  size="sm"
                  variant={active ? "default" : "ghost"}
                  aria-pressed={active}
                  className="h-7 shrink-0 px-2.5 text-xs"
                  onClick={() => {
                    setMonth(key);
                    setOpenDate(null);
                  }}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        </div>

        <StateBoundary
          loading={calendar.isPending}
          error={calendar.error}
          onRetry={() => void calendar.refetch()}
          skeletonRows={4}
        >
          <p className="mt-4 text-xs text-muted-foreground">
            {totalLeaveDays === 0
              ? t("admin.cc.calendar.empty")
              : t("admin.cc.calendar.monthTotal", {
                  n: formatNumber(totalLeaveDays),
                  people: formatNumber(distinctPeople),
                })}
          </p>

          <div
            className="mt-2 grid grid-cols-7 gap-1 sm:gap-1.5"
            role="grid"
            aria-label={fmtMonthLong(month)}
          >
            {WEEKDAYS.map((day) => (
              <div
                key={day}
                className="pb-1 text-center text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {day}
              </div>
            ))}

            {Array.from({ length: leadingBlanks }, (_, i) => (
              <div key={`blank-${i}`} aria-hidden />
            ))}

            {cells.map((cell) => {
              const selected = cell.date === openDate;
              return (
                <button
                  key={cell.date}
                  type="button"
                  role="gridcell"
                  aria-label={t("admin.cc.calendar.dayAria", {
                    date: cell.date,
                    n: formatNumber(cell.people),
                  })}
                  aria-pressed={selected}
                  onClick={() => setOpenDate(selected ? null : cell.date)}
                  className={cn(
                    "group relative flex min-h-[3.25rem] flex-col rounded-lg border p-1.5 text-left transition",
                    "hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-[4.5rem]",
                    intensityClass(cell.people),
                    cell.isWeekend && cell.people === 0 ? "bg-muted/40" : "",
                    // Today gets a ring AND a soft halo — the one cell that must be
                    // findable at a glance without reading a single number.
                    cell.isToday
                      ? "border-primary ring-2 ring-primary/40 ring-offset-1 ring-offset-background"
                      : "",
                    selected ? "border-primary ring-2 ring-primary" : "",
                  )}
                >
                  <span
                    className={cn(
                      "num text-xs font-semibold tabular-nums",
                      cell.isToday ? "text-primary" : "text-foreground",
                    )}
                  >
                    {cell.dayOfMonth}
                  </span>

                  {cell.people > 0 ? (
                    <span className="mt-auto flex items-center gap-1 text-[0.65rem] font-medium">
                      <Users className="size-3 shrink-0" aria-hidden />
                      <span className="num tabular-nums">{formatNumber(cell.people)}</span>
                    </span>
                  ) : null}

                  {cell.isToday ? (
                    <span className="sr-only">{t("admin.cc.calendar.today")}</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/*
            THE DAY OPENS IN A MODAL, not a block under the grid. A panel below put the
            answer off-screen on a phone — a tap looked like it did nothing — and pushed
            everything after the calendar down, so the page moved under the reader.
          */}
          <DayDetailDialog
            open={openCell !== null}
            onClose={() => setOpenDate(null)}
            title={openCell === null ? "" : fmtCivilDayMonthWeekday(openCell.date)}
            subtitle={
              openCell === null
                ? null
                : t("admin.cc.calendar.peopleOnLeave", {
                    n: formatNumber(openCell.people),
                  })
            }
            footer={
              <Button variant="ghost" size="sm" asChild className="h-7 text-xs">
                <Link to={ADMIN_ROUTES.orgLeaveCalendar}>
                  {t("admin.cc.calendar.openFull")}
                </Link>
              </Button>
            }
          >
            {openCell === null || openCell.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("admin.cc.calendar.noneOnDay")}</p>
            ) : (
              <ul className="space-y-1.5">
                {openCell.rows.map((row) => (
                  <li
                    key={row.leave_request_day_id}
                    className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2"
                  >
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full ring-2 ring-background"
                      style={{ backgroundColor: row.colour_hex ?? "currentColor" }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {row.display_name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.leave_type_name}
                        {row.department_name === null ? "" : ` · ${row.department_name}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </DayDetailDialog>
        </StateBoundary>
      </div>
    </section>
  );
}
