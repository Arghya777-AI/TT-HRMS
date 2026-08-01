/**
 * LeaveRangeCalendar — pick a from–to range on a calendar, with the employee's own weekly
 * offs and holidays already painted on it.
 *
 * WHY A CALENDAR AND NOT TWO DATE FIELDS. Two `<input type="date">` boxes can express the
 * range, but they cannot answer the question that decides the application: "if I take Friday
 * to Tuesday, how many days does that actually cost me?" That answer depends on the
 * employee's rota, and the only place it can be shown before submitting is the grid itself.
 * The native fields are kept alongside — a keyboard user and a phone's date wheel are both
 * faster than clicking two cells — so the calendar adds a way in rather than becoming the
 * only one.
 *
 * ── THE PAINT COMES FROM THE SERVER, FOR THE VISIBLE MONTH ───────────────────
 * `leave_countable_dates` is asked for the whole month on display, so every cell can be
 * marked before anything is selected — an employee should see that the 2nd is their weekly
 * off while deciding, not after. That is a SECOND call to the same function the page makes
 * for the selected range: this one paints, the page's one totals a selection that may cross a
 * month boundary. Same function, same rota, two questions, both cached by react-query.
 *
 * Nothing here derives a weekly off. `WO-SUN-ALTSAT` — Sunday plus ALTERNATE Saturday — is
 * the rule in use at this venue, and a `getDay() === 0` in a calendar cell would paint the
 * wrong Saturdays forever. Every mark on this grid is a flag the database set.
 *
 * ── SELECTION ────────────────────────────────────────────────────────────────
 * First click sets the start and clears the end; the next click on or after it closes the
 * range. A click BEFORE the start restarts from there rather than inverting the range —
 * inverting is what an employee means by "actually, from here" roughly never, and the server
 * refuses it anyway.
 *
 * Both directions of month navigation are open, unlike the attendance calendar. Leave is
 * applied for forwards, and a retrospective application is a real case an approver decides
 * on; capping either side would be the screen inventing a policy the database does not have.
 */
import { useMemo, useState } from "react";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import {
  addIstMonths,
  fmtCivilWeekday,
  fmtMonthLong,
  istMonthDates,
  istMonthOfDate,
  istMonthRange,
  nowIstDate,
  nowIstMonth,
  type IstMonthKey,
} from "@/lib/datetime";
import { useCountableDates } from "../hooks/useLeaveApply";
import { freeDayReason } from "../leaveRange";
import type { CountableDate } from "../api/leave-apply.api";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface LeaveRangeCalendarProps {
  readonly fromDate: string;
  readonly toDate: string;
  readonly onChange: (fromDate: string, toDate: string) => void;
}

export function LeaveRangeCalendar({
  fromDate,
  toDate,
  onChange,
}: LeaveRangeCalendarProps): React.JSX.Element {
  /* Opens on the month of the current start date, so returning to the step lands where the
     employee left off rather than snapping back to today. */
  const [month, setMonth] = useState<IstMonthKey>(
    (fromDate === "" ? nowIstMonth() : istMonthOfDate(fromDate)) as IstMonthKey,
  );
  const bounds = useMemo(() => istMonthRange(month), [month]);
  const painted = useCountableDates(bounds.from, bounds.to);

  const byDate = useMemo(() => {
    const map = new Map<string, CountableDate>();
    for (const row of painted.data ?? []) map.set(row.leave_date, row);
    return map;
  }, [painted.data]);

  const dates = useMemo(() => istMonthDates(month), [month]);
  const leadingBlanks = useMemo(() => {
    const first = dates[0];
    if (first === undefined) return 0;
    return WEEKDAYS.indexOf(fmtCivilWeekday(first) as (typeof WEEKDAYS)[number]);
  }, [dates]);

  const today = nowIstDate();

  /**
   * One click, two meanings, in this order:
   *
   *  1. there is an open start and this date is on or after it → close the range;
   *  2. anything else → start a new selection here.
   *
   * Case 2 covers a completed range (so a third click begins again rather than only ever
   * dragging the end outwards, which would leave no way back without clearing the form) and a
   * click before the open start (so "actually, from here" moves the start instead of
   * inverting a range the server would refuse).
   */
  function pick(date: string): void {
    if (fromDate !== "" && toDate === "" && date >= fromDate) {
      onChange(fromDate, date);
      return;
    }
    onChange(date, "");
  }

  return (
    <div className="rounded-lg border bg-background/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <CalendarRange className="size-3.5 text-primary" aria-hidden />
          {fmtMonthLong(month)}
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            aria-label={t("leave.app.range.prevMonth")}
            onClick={() => setMonth(addIstMonths(month, -1) as IstMonthKey)}
          >
            <ChevronLeft className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            aria-label={t("leave.app.range.nextMonth")}
            onClick={() => setMonth(addIstMonths(month, 1) as IstMonthKey)}
          >
            <ChevronRight className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      <div
        className="mt-2 grid grid-cols-7 gap-1"
        role="grid"
        aria-label={t("leave.app.range.gridLabel")}
      >
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

        {dates.map((date) => {
          const row = byDate.get(date) ?? null;
          const reason = row === null ? null : freeDayReason(row);
          const isStart = date === fromDate;
          const isEnd = date === toDate;
          const inRange =
            fromDate !== "" && toDate !== "" && date > fromDate && date < toDate;
          const selected = isStart || isEnd || inRange;

          return (
            <button
              key={date}
              type="button"
              role="gridcell"
              aria-pressed={selected}
              aria-label={
                reason === null
                  ? date
                  : `${date} — ${
                      reason === "weekly_off"
                        ? t("leave.app.range.weeklyOff")
                        : (row?.holiday_name ?? t("leave.app.range.holiday"))
                    }`
              }
              onClick={() => pick(date)}
              className={cn(
                "relative flex aspect-square min-h-8 items-center justify-center rounded-md border",
                "text-xs tabular-nums transition-all duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "hover:border-primary/60",
                // Free days are recessive AND marked, never colour-only: the number goes
                // muted, a dot sits under it, and the label spells the reason out.
                reason === null ? "" : "text-muted-foreground",
                selected
                  ? "border-primary bg-primary/10 font-semibold text-foreground"
                  : "bg-card",
                isStart || isEnd ? "ring-2 ring-primary" : "",
                date === today ? "outline outline-1 outline-offset-1 outline-primary/50" : "",
              )}
            >
              {date.slice(8)}
              {reason !== null ? (
                <span
                  aria-hidden
                  className={cn(
                    "absolute bottom-0.5 size-1 rounded-full",
                    reason === "weekly_off" ? "bg-muted-foreground" : "bg-warning",
                  )}
                />
              ) : null}
            </button>
          );
        })}
      </div>

      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.65rem] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground" />
          {t("leave.app.range.weeklyOff")}
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          {t("leave.app.range.holiday")}
        </span>
        {painted.isPending ? <span>{t("leave.app.range.loading")}</span> : null}
        {painted.error !== null ? (
          <span className="text-destructive">{t("leave.app.range.paintFailed")}</span>
        ) : null}
      </p>
    </div>
  );
}
