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
 *
 * THE BARS UNDER THE GRID ANSWER WHAT THE GRID CANNOT. A cell says what KIND of day it
 * was; it cannot say that Tuesday ran to eleven hours and Thursday stopped at four.
 * That was already in the data — `total_worked_minutes` on every row this card
 * already fetches, printed in the day panel under "Worked" — but one day at a time, so
 * seeing a pattern meant opening thirty dialogs. Same query, same rows, no new figure:
 * the bars only put the month's hours side by side.
 *
 * A DAY WITH NO ROW IS A GAP, NOT A ZERO BAR. Future dates and days the engine has not
 * processed have no record, and drawing them at height nothing would say the employee
 * worked nothing — which for a day that has not happened yet is a claim, not a fact.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DayDetailDialog } from "@/shared/ui/DayDetailDialog";
import { TrendBars, type TrendBar } from "@/shared/ui/charts/TrendBars";
import type { ChartTone } from "@/shared/ui/charts/chartTokens";
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
import { dayRecordedBy, type RecordedBy } from "../dayRecordedBy";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Status → a reserved tone, a one-letter mark and a word.
 *
 * The letter is what makes the grid readable without colour. Statuses not listed fall
 * through to a neutral dot and their own humanised name, so a status added to the enum
 * ahead of this file degrades to "shown but unstyled" rather than disappearing.
 */
const STATUS_STYLE: Readonly<
  Record<string, { dot: string; wash: string; mark: string; key: string }>
> = {
  present: { dot: "bg-emerald-500", wash: "bg-emerald-500/10", mark: "P", key: "home.cal.status.present" },
  work_from_home: { dot: "bg-teal-500", wash: "bg-teal-500/10", mark: "H", key: "home.cal.status.wfh" },
  on_duty: { dot: "bg-teal-500", wash: "bg-teal-500/10", mark: "D", key: "home.cal.status.onDuty" },
  half_day: { dot: "bg-amber-500", wash: "bg-amber-500/15", mark: "½", key: "home.cal.status.halfDay" },
  absent: { dot: "bg-rose-500", wash: "bg-rose-500/15", mark: "A", key: "home.cal.status.absent" },
  on_leave: { dot: "bg-sky-500", wash: "bg-sky-500/15", mark: "L", key: "home.cal.status.onLeave" },
  on_leave_half: { dot: "bg-sky-400", wash: "bg-sky-400/10", mark: "L", key: "home.cal.status.onLeaveHalf" },
  comp_off_availed: { dot: "bg-violet-500", wash: "bg-violet-500/15", mark: "C", key: "home.cal.status.compOff" },
  weekly_off: { dot: "bg-muted-foreground/40", wash: "bg-muted/50", mark: "•", key: "home.cal.status.weeklyOff" },
  holiday: { dot: "bg-indigo-400", wash: "bg-indigo-400/15", mark: "★", key: "home.cal.status.holiday" },
  weekly_off_worked: { dot: "bg-emerald-600", wash: "bg-emerald-600/15", mark: "P", key: "home.cal.status.weeklyOffWorked" },
  holiday_worked: { dot: "bg-emerald-600", wash: "bg-emerald-600/15", mark: "P", key: "home.cal.status.holidayWorked" },
  pending: { dot: "bg-muted-foreground/25", wash: "", mark: "", key: "home.cal.status.pending" },
};

/**
 * Who recorded the day → a pip in the corner of the cell. A SECOND colour code,
 * answering a different question from the status: not "what was this day" but
 * "where did this record come from" (see `dayRecordedBy` for the ranking).
 *
 * SHAPE AS WELL AS COLOUR, for two reasons. The status palette above already spends
 * emerald, teal, amber, rose, sky, violet and indigo, so a fourth family of hues
 * would collide with meanings the reader has only just learned. And this file's rule
 * is that colour is never the sole carrier of a state — here the second carrier
 * cannot be a letter, because the cell already has one, so it is the outline.
 *
 * `self` is a deliberate neutral grey: it is the ordinary case, very nearly every
 * working day of the month, and a saturated pip on all of them would drown out the
 * two marks that actually merit a second look.
 */
const RECORDED_STYLE: Readonly<
  Record<Exclude<RecordedBy, "none">, { pip: string; shape: string; key: string }>
> = {
  self: { pip: "bg-foreground/40", shape: "rounded-full", key: "home.cal.by.self" },
  corrected: { pip: "bg-blue-600", shape: "rotate-45", key: "home.cal.by.corrected" },
  hr_override: { pip: "bg-orange-500", shape: "", key: "home.cal.by.hrOverride" },
};

/**
 * The same statuses again, in the shared chart vocabulary, for the hours bars.
 *
 * IT IS NOT A SECOND COLOUR CODE. Every status whose bar can have any HEIGHT — the
 * present family, half days, absents — maps to the tone that renders in the hue its
 * own cell already carries: emerald→success, amber→warning, rose→destructive,
 * sky→info. The two that do not line up exactly (`holiday` is indigo in the grid and
 * plum in the ramp, `comp_off_availed` is violet and gets `leave`) are days nobody
 * worked, so their bars are zero-height and carry no visible colour at all.
 *
 * `late` is the kit's name for the warning token, not a claim that a half day was
 * late — the tone list is the colour vocabulary, and amber is what a half day is.
 */
const STATUS_TONE: Readonly<Record<string, ChartTone>> = {
  present: "present",
  work_from_home: "present",
  on_duty: "present",
  weekly_off_worked: "present",
  holiday_worked: "present",
  half_day: "late",
  absent: "absent",
  on_leave: "leave",
  on_leave_half: "leave",
  comp_off_availed: "leave",
  weekly_off: "weeklyOff",
  holiday: "holiday",
  pending: "neutral",
};

/** Fixed legend order, so the key does not reshuffle itself month to month. */
const RECORDED_ORDER = ["self", "corrected", "hr_override"] as const;
const STATUS_ORDER = Object.keys(STATUS_STYLE);

interface Cell {
  readonly date: string;
  readonly dayOfMonth: string;
  readonly day: AttendanceDay | null;
  readonly recordedBy: RecordedBy;
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
    return istMonthDates(month).map((date) => {
      const day = byDate.get(date) ?? null;
      return {
        date,
        dayOfMonth: date.slice(8, 10),
        day,
        recordedBy: dayRecordedBy(day),
        isToday: date === today,
        isFuture: date > today,
      };
    });
  }, [rows, month, today]);

  /*
    ── THE GRID HAD NO KEY, SO THE COLOURS MEANT NOTHING ───────────────────────────

    Two colour codes are on screen now — the status wash and the recorded-by pip — and
    until this legend there was nothing anywhere that said what any of them stood for.
    A pink cell marked "A" is only legible to somebody who already knows.

    ONLY WHAT THIS MONTH ACTUALLY CONTAINS. A fixed twelve-status key would be a wall
    of colours the reader has to search for the two that apply to them, and it would
    claim the month held a holiday and a comp-off when it held neither. Statuses with
    no style (one added to the enum ahead of this file) are left out rather than given
    a blank swatch — they still render in the grid, and the day panel spells them out.
  */
  const legend = useMemo(() => {
    const statuses = new Set<string>();
    const sources = new Set<RecordedBy>();
    for (const row of rows) {
      if (STATUS_STYLE[row.status] !== undefined) statuses.add(row.status);
      sources.add(dayRecordedBy(row));
    }
    return {
      statuses: STATUS_ORDER.filter((code) => statuses.has(code)).map(
        (code) => STATUS_STYLE[code]!,
      ),
      sources: RECORDED_ORDER.filter((code) => sources.has(code)),
    };
  }, [rows]);

  /*
    ONE BAR PER DATE, IN THE GRID'S OWN ORDER, so the fifth bar and the fifth cell are
    the fifth of the month. `value` is the row's own `total_worked_minutes` and nothing
    else — no averaging, no filling in, no totalling. A date with no row, or a row the
    engine has not put an hours figure on, is `null`: TrendBars leaves a gap there, and
    a gap is what "we do not know" looks like.

    The tooltip caption is the status WORD, the same one the legend and the day panel
    use, so a bar the reader is unsure about names itself rather than relying on hue.
  */
  const workedBars = useMemo<TrendBar[]>(
    () =>
      cells.map((cell) => {
        const day = cell.day;
        const style = day === null ? undefined : STATUS_STYLE[day.status];
        return {
          key: cell.date,
          label: cell.dayOfMonth,
          value: day?.total_worked_minutes ?? null,
          tone: (day === null ? undefined : STATUS_TONE[day.status]) ?? "neutral",
          ...(style === undefined ? {} : { caption: t(style.key as never) }),
        };
      }),
    [cells],
  );

  /*
    A month with no hours anywhere — before the date of joining, or one the engine has
    not reached — would render as a bare axis under thirty gaps, which reads as a
    broken chart rather than as an empty one. The grid above already says the month is
    empty, honestly and in its own shape, so the bars simply stay away.
  */
  const hasWorkedHours = workedBars.some((bar) => bar.value !== null);

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
            /*
              The pip is `aria-hidden`, so the recorded-by fact would be invisible to a
              screen reader if it were not spelled into the label here. It is the part
              of a cell least guessable from context: "absent" can be inferred from a
              missing punch, "set by HR" cannot be inferred from anything.
            */
            const words = [
              cell.date,
              cell.day === null
                ? null
                : style === null
                  ? cell.day.status
                  : t(style.key as never),
              cell.recordedBy === "none"
                ? null
                : t(RECORDED_STYLE[cell.recordedBy].key as never),
            ].filter((word): word is string => word !== null);
            return (
              <button
                key={cell.date}
                type="button"
                role="gridcell"
                disabled={cell.isFuture}
                aria-pressed={selected}
                aria-label={words.join(" — ")}
                onClick={() => setOpenDate(selected ? null : cell.date)}
                className={cn(
                  /*
                    A BOUNDED HEIGHT, NOT `aspect-square`.

                    Square cells take their height from their width, and this card is
                    full-width on the home page — so seven columns across a desktop
                    container made every day box about 200px tall, holding an 11px
                    number and a 6px dot. Reported as "reduce the size of box"; the
                    real fault was that the box had no ceiling and grew with the
                    viewport, which is why it looked right in a narrow column and
                    absurd on a laptop.

                    Fixed height, so the month reads as a month at any width. 44px on
                    a phone keeps the tap target at the usual minimum, and there the
                    cells come out roughly square anyway.
                  */
                  "relative flex h-11 flex-col items-center justify-center overflow-hidden sm:h-12",
                  "rounded-lg border text-center transition-all duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  cell.isFuture
                    ? "border-dashed opacity-40"
                    : "hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-sm",
                  // A faint wash of the status colour behind the cell, so the month has a
                  // readable rhythm from across the room — the letter and the dot still
                  // carry the meaning up close.
                  style === null ? "" : style.wash,
                  cell.isToday
                    ? "border-primary ring-2 ring-primary/40 ring-offset-1 ring-offset-background"
                    : "",
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
                {/* Top-right, out of the way of the centred number and letter. */}
                {cell.recordedBy === "none" ? null : (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute right-1 top-1 size-1.5",
                      RECORDED_STYLE[cell.recordedBy].pip,
                      RECORDED_STYLE[cell.recordedBy].shape,
                    )}
                  />
                )}

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

        {legend.statuses.length > 0 || legend.sources.length > 0 ? (
          <ul className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.65rem] leading-tight text-muted-foreground">
            {legend.statuses.map((status) => (
              <li key={status.key} className="inline-flex items-center gap-1">
                <span aria-hidden className={cn("size-1.5 rounded-full", status.dot)} />
                <span aria-hidden className="font-semibold">{status.mark}</span>
                {t(status.key as never)}
              </li>
            ))}
            {legend.sources.length > 0 ? (
              <>
                <li aria-hidden className="h-3 w-px bg-border" />
                <li className="font-medium">{t("home.cal.by.legend")}</li>
                {legend.sources.map((code) => (
                  <li key={code} className="inline-flex items-center gap-1">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5",
                        RECORDED_STYLE[code].pip,
                        RECORDED_STYLE[code].shape,
                      )}
                    />
                    {t(RECORDED_STYLE[code].key as never)}
                  </li>
                ))}
              </>
            ) : null}
          </ul>
        ) : null}

        {/*
          BELOW THE LEGEND ON PURPOSE. The bars borrow the grid's colours, so the key
          that explains those colours has to have been read first.
        */}
        {hasWorkedHours ? (
          <div className="mt-3 border-t pt-3">
            <p className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
              {t("home.chart.worked.heading")}
            </p>
            <TrendBars
              className="mt-1"
              bars={workedBars}
              title={t("home.chart.worked.title", { month: fmtMonthLong(month) })}
              format={fmtDurationHm}
              height={96}
            />
          </div>
        ) : null}

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

              {/*
                The pip in words, because a 6px mark in the corner of a cell is a hint
                and this is where the hint gets settled.
              */}
              {openCell.recordedBy === "none" ? null : (
                <>
                  <dt className="text-muted-foreground">{t("home.cal.field.recordedBy")}</dt>
                  <dd className="flex items-center justify-end gap-1.5 text-right font-medium">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0",
                        RECORDED_STYLE[openCell.recordedBy].pip,
                        RECORDED_STYLE[openCell.recordedBy].shape,
                      )}
                    />
                    {t(RECORDED_STYLE[openCell.recordedBy].key as never)}
                  </dd>
                </>
              )}

              {/*
                HR's reason, shown to the employee rather than kept on the admin side.
                `ck_ad__override_reason` makes ten characters of explanation mandatory
                before a day can be set by hand — a rule whose only purpose is that
                somebody can later read it, and the person with the most at stake is
                the one whose day it is.
              */}
              {(openCell.day.manual_override_reason ?? "").trim() === "" ? null : (
                <>
                  <dt className="text-muted-foreground">{t("home.cal.field.overrideReason")}</dt>
                  <dd className="col-span-1 text-right font-medium">
                    {openCell.day.manual_override_reason}
                  </dd>
                </>
              )}
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
