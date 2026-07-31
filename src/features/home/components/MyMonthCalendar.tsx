/**
 * MyMonthCalendar — the employee's own month, as a calendar rather than four counters.
 *
 * WHY IT IS NOT `MonthStrip`. That component is named for a month and is four KPI
 * tiles over one row of `v_attendance_period_summary` — present days, absent days and
 * so on. It answers "how did the month total up", which is the second question. The
 * first is "what happened on the 14th", and nothing on the home screen could answer
 * it: an employee had to leave home, open My Attendance, and find the row.
 *
 * STATUS IS CATEGORICAL, SO IT IS NOT A HEAT RAMP. The admin band tints by head-count,
 * which is a magnitude and has an order. A day's status does not — present is not
 * "more" than on-leave — so each day carries a reserved status colour AND a letter,
 * and the selected-day panel spells the word out. Colour alone is never the only
 * carrier of the state, which also keeps it readable for anyone who cannot separate
 * the hues.
 *
 * FORWARD NAVIGATION STOPS AT THIS MONTH, unlike the admin leave calendar. There are
 * no future punches, so a next-month arrow on an attendance calendar would offer a
 * grid that is empty by definition and read as data loss. Backwards is unlimited.
 *
 * THE DAY PANEL IS THE MOBILE STORY. Seven columns fit a phone at this cell size, and
 * tapping a day opens its detail below rather than in a tooltip — a tooltip is a
 * desktop-only affordance and this screen is mostly read on a phone.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DayDetailDialog } from "@/shared/ui/DayDetailDialog";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import {
  addIstMonths,
  fmtCivilDayMonthWeekday,
  fmtCivilWeekday,
  fmtDurationHm,
  fmtMonthLong,
  istMonthDates,
  istMonthRange,
  istToday,
  nowIstMonth,
  type IstMonthKey,
} from "@/lib/datetime";
import { asArray } from "@/lib/asArray";
import { useAttendanceDays } from "@/features/attendance/hooks/useAttendance";
import type { AttendanceDay } from "@/features/attendance/api/attendance.api";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Status → a reserved tone, a one-letter mark and a word.
 *
 * The letter is what makes the grid readable without colour. Statuses not listed fall
 * through to a neutral dot and their own humanised name, so a status added to the enum
 * ahead of this file degrades to "shown but unstyled" rather than disappearing.
 */
const STATUS_STYLE: Readonly<Record<string, { dot: string; mark: string; key: string }>> = {
  present: { dot: "bg-emerald-500", mark: "P", key: "home.cal.status.present" },
  work_from_home: { dot: "bg-teal-500", mark: "H", key: "home.cal.status.wfh" },
  on_duty: { dot: "bg-teal-500", mark: "D", key: "home.cal.status.onDuty" },
  half_day: { dot: "bg-amber-500", mark: "½", key: "home.cal.status.halfDay" },
  absent: { dot: "bg-rose-500", mark: "A", key: "home.cal.status.absent" },
  on_leave: { dot: "bg-sky-500", mark: "L", key: "home.cal.status.onLeave" },
  on_leave_half: { dot: "bg-sky-400", mark: "L", key: "home.cal.status.onLeaveHalf" },
  comp_off_availed: { dot: "bg-violet-500", mark: "C", key: "home.cal.status.compOff" },
  weekly_off: { dot: "bg-muted-foreground/40", mark: "•", key: "home.cal.status.weeklyOff" },
  holiday: { dot: "bg-indigo-400", mark: "★", key: "home.cal.status.holiday" },
  weekly_off_worked: { dot: "bg-emerald-600", mark: "P", key: "home.cal.status.weeklyOffWorked" },
  holiday_worked: { dot: "bg-emerald-600", mark: "P", key: "home.cal.status.holidayWorked" },
  pending: { dot: "bg-muted-foreground/25", mark: "", key: "home.cal.status.pending" },
};

interface Cell {
  readonly date: string;
  readonly dayOfMonth: string;
  readonly day: AttendanceDay | null;
  readonly isToday: boolean;
  readonly isFuture: boolean;
}

export function MyMonthCalendar() {
  const today = istToday();
  const thisMonth = nowIstMonth() as IstMonthKey;
  const [month, setMonth] = useState<IstMonthKey>(thisMonth);
  const [openDate, setOpenDate] = useState<string | null>(null);

  const range = istMonthRange(month);
  const days = useAttendanceDays(range);
  const rows = asArray(days.data);

  const cells = useMemo<Cell[]>(() => {
    const byDate = new Map<string, AttendanceDay>();
    for (const row of rows) byDate.set(row.ist_date, row);
    return istMonthDates(month).map((date) => ({
      date,
      dayOfMonth: date.slice(8, 10),
      day: byDate.get(date) ?? null,
      isToday: date === today,
      isFuture: date > today,
    }));
  }, [rows, month, today]);

  const leadingBlanks = useMemo(() => {
    const first = cells[0];
    if (first === undefined) return 0;
    return WEEKDAYS.indexOf(fmtCivilWeekday(first.date) as (typeof WEEKDAYS)[number]);
  }, [cells]);

  const openCell = cells.find((cell) => cell.date === openDate) ?? null;
  const canGoForward = addIstMonths(month, 1) <= thisMonth;

  /** Overtime across the month — the number the comp-off ask hangs off. */
  const monthOvertime = rows.reduce((sum, row) => sum + (row.overtime_minutes ?? 0), 0);

  return (
    <section aria-label={t("home.cal.title")} className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold">
            <CalendarDays className="size-4 text-primary" aria-hidden />
            {t("home.cal.title")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{fmtMonthLong(month)}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label={t("home.cal.previous")}
            onClick={() => {
              setMonth(addIstMonths(month, -1) as IstMonthKey);
              setOpenDate(null);
            }}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={!canGoForward}
            aria-label={t("home.cal.next")}
            onClick={() => {
              setMonth(addIstMonths(month, 1) as IstMonthKey);
              setOpenDate(null);
            }}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      <StateBoundary
        loading={days.isPending}
        error={days.error}
        onRetry={() => void days.refetch()}
        skeletonRows={3}
      >
        <div className="mt-3 grid grid-cols-7 gap-1" role="grid" aria-label={fmtMonthLong(month)}>
          {WEEKDAYS.map((label) => (
            <div
              key={label}
              className="pb-0.5 text-center text-[0.6rem] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {label}
            </div>
          ))}

          {Array.from({ length: leadingBlanks }, (_, i) => (
            <div key={`blank-${i}`} aria-hidden />
          ))}

          {cells.map((cell) => {
            const style = cell.day === null ? null : STATUS_STYLE[cell.day.status] ?? null;
            const selected = cell.date === openDate;
            return (
              <button
                key={cell.date}
                type="button"
                role="gridcell"
                disabled={cell.isFuture}
                aria-pressed={selected}
                aria-label={
                  cell.day === null
                    ? cell.date
                    : `${cell.date} — ${style === null ? cell.day.status : t(style.key as never)}`
                }
                onClick={() => setOpenDate(selected ? null : cell.date)}
                className={cn(
                  "flex aspect-square min-h-8 flex-col items-center justify-center rounded-md border text-center transition",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  cell.isFuture ? "opacity-40" : "hover:border-primary/50",
                  cell.isToday ? "border-primary ring-2 ring-primary/40" : "",
                  selected ? "border-primary ring-2 ring-primary" : "",
                )}
              >
                <span
                  className={cn(
                    "num text-[0.7rem] font-semibold leading-none tabular-nums",
                    cell.isToday ? "text-primary" : "",
                  )}
                >
                  {cell.dayOfMonth}
                </span>
                {/* The letter carries the state; the dot only reinforces it. */}
                {style !== null && style.mark !== "" ? (
                  <span className="mt-0.5 flex items-center gap-0.5">
                    <span aria-hidden className={cn("size-1.5 rounded-full", style.dot)} />
                    <span className="text-[0.6rem] leading-none text-muted-foreground">
                      {style.mark}
                    </span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* A modal, not a panel underneath: on a phone the panel was below the fold, so a
            tap read as "nothing happened", and opening it shoved the rest of the page down. */}
        <DayDetailDialog
          open={openCell !== null}
          onClose={() => setOpenDate(null)}
          title={openCell === null ? "" : fmtCivilDayMonthWeekday(openCell.date)}
          subtitle={
            openCell === null || openCell.day === null
              ? null
              : STATUS_STYLE[openCell.day.status] === undefined
                ? openCell.day.status
                : t(STATUS_STYLE[openCell.day.status]!.key as never)
          }
          footer={
            <Button variant="ghost" size="sm" asChild className="h-7 text-xs">
              <Link to="/me/attendance">{t("home.cal.openAttendance")}</Link>
            </Button>
          }
        >
          {openCell === null || openCell.day === null ? (
            <p className="text-sm text-muted-foreground">{t("home.cal.noRecord")}</p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("home.cal.field.shift")}</dt>
              <dd className="text-right font-medium">{openCell.day.shift_display_label ?? "—"}</dd>

              <dt className="text-muted-foreground">{t("home.cal.field.inOut")}</dt>
              <dd className="num text-right font-medium tabular-nums">
                {openCell.day.first_in_hm ?? "—"} → {openCell.day.last_out_hm ?? "—"}
              </dd>

              <dt className="text-muted-foreground">{t("home.cal.field.worked")}</dt>
              <dd className="num text-right font-medium tabular-nums">
                {fmtDurationHm(openCell.day.total_worked_minutes ?? 0)}
              </dd>

              {openCell.day.is_late ? (
                <>
                  <dt className="text-muted-foreground">{t("home.cal.field.late")}</dt>
                  <dd className="num text-right font-medium tabular-nums text-warning">
                    {fmtDurationHm(openCell.day.late_minutes ?? 0)}
                  </dd>
                </>
              ) : null}

              {(openCell.day.overtime_minutes ?? 0) > 0 ? (
                <>
                  <dt className="text-muted-foreground">{t("home.cal.field.overtime")}</dt>
                  <dd className="num text-right font-medium tabular-nums">
                    {fmtDurationHm(openCell.day.overtime_minutes ?? 0)}
                  </dd>
                </>
              ) : null}

              {openCell.day.leave_type_name !== null ? (
                <>
                  <dt className="text-muted-foreground">{t("home.cal.field.leaveType")}</dt>
                  <dd className="text-right font-medium">{openCell.day.leave_type_name}</dd>
                </>
              ) : null}

              {openCell.day.holiday_name !== null ? (
                <>
                  <dt className="text-muted-foreground">{t("home.cal.field.holiday")}</dt>
                  <dd className="text-right font-medium">{openCell.day.holiday_name}</dd>
                </>
              ) : null}
            </dl>
          )}
        </DayDetailDialog>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <p className="text-xs text-muted-foreground">
            {monthOvertime > 0
              ? t("home.cal.overtimeTotal", { hours: fmtDurationHm(monthOvertime) })
              : t("home.cal.tapHint")}
          </p>
          <Button variant="ghost" size="sm" asChild className="h-7 text-xs">
            <Link to="/me/attendance">{t("home.cal.openAttendance")}</Link>
          </Button>
        </div>
      </StateBoundary>
    </section>
  );
}
