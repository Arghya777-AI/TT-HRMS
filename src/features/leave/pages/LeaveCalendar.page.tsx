/**
 * E-05.6 Leave calendar `/me/leave/calendar` — my leave, my offs, my holidays.
 *
 * Three server reads, no client inference:
 *   · `v_leave_calendar` filtered to me — the counted days of my live requests.
 *   · `holidays` on my own `holiday_calendar_id`.
 *   · `v_attendance_day_enriched.is_weekly_off` — the engine's per-date answer to
 *     "is this my off?", which is the only correct one once rotational rules and
 *     roster overrides are in play. It exists for computed dates, so future offs
 *     appear as the roster is published; the screen says that rather than guessing
 *     a pattern.
 *
 * Team overlap is deliberately absent: spec E-05 wants counts-only via
 * `v_team_leave_density`, and no such view is deployed. A count invented in the
 * browser from rows RLS would not even return is exactly the defect class being
 * removed, so the screen states the gap.
 *
 * @route /me/leave/calendar
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { isHalfDay, portionText } from "../leavePortion";
import type { LeaveRosterRow } from "../api/leave-apply.api";
import {
  addIstMonths,
  fmtCivilDayMonthWeekday,
  fmtCivilWeekday,
  fmtMonthLong,
  isIstMonthKey,
  istMonthDates,
  istMonthRange,
  nowIstDate,
  nowIstMonth,
} from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { useAttendanceDays } from "@/features/attendance/hooks/useAttendance";
import { useMyLeaveCalendar } from "../hooks/useLeave";
import {
  useLeaveRoster, useHolidaysInWindow, useMyLeaveContext } from "../hooks/useLeaveApply";
import type { CalendarHoliday } from "../api/leave-apply.api";
import type { LeaveCalendarDay } from "../api/leave.api";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

interface DayCell {
  readonly date: string;
  readonly leave: readonly LeaveCalendarDay[];
  readonly holiday: CalendarHoliday | null;
  readonly isWeeklyOff: boolean;
  readonly isToday: boolean;
}

export default function LeaveCalendarPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("m");
  const month = raw !== null && isIstMonthKey(raw) ? raw : nowIstMonth();
  const range = istMonthRange(month);
  const today = nowIstDate();

  const context = useMyLeaveContext();
  const leave = useMyLeaveCalendar(range);
  const holidays = useHolidaysInWindow(context.data?.holiday_calendar_id ?? null, range.from, range.to);
  const days = useAttendanceDays(range);
  /*
    Everyone's approved leave, not just mine. Reads `v_leave_roster` — see its own comment for
    what it deliberately does not expose. The venue chose to show colleagues the leave TYPE, with
    the health disclosure that carries, and this is that decision.
  */
  const roster = useLeaveRoster(range.from, range.to);

  /*
    Grouped by date, in a Map so the month's own order survives — the query already returns
    `leave_date` ascending, and an object would re-order the keys as numeric-looking strings.
  */
  const byDate = useMemo(() => {
    const out = new Map<string, LeaveRosterRow[]>();
    for (const row of roster.data ?? []) {
      const bucket = out.get(row.leave_date);
      if (bucket === undefined) out.set(row.leave_date, [row]);
      else bucket.push(row);
    }
    return out;
  }, [roster.data]);

  function goMonth(delta: number) {
    const next = new URLSearchParams(params);
    next.set("m", addIstMonths(month, delta));
    setParams(next, { replace: true });
  }

  const cells = useMemo<DayCell[]>(() => {
    const leaveByDate = new Map<string, LeaveCalendarDay[]>();
    for (const row of leave.data ?? []) {
      const list = leaveByDate.get(row.leave_date) ?? [];
      list.push(row);
      leaveByDate.set(row.leave_date, list);
    }
    const holidayByDate = new Map<string, CalendarHoliday>();
    for (const h of holidays.data ?? []) holidayByDate.set(h.holiday_date, h);
    const offByDate = new Map<string, boolean>();
    for (const d of days.data ?? []) offByDate.set(d.ist_date, d.is_weekly_off);

    return istMonthDates(month).map((date) => ({
      date,
      leave: leaveByDate.get(date) ?? [],
      holiday: holidayByDate.get(date) ?? null,
      isWeeklyOff: offByDate.get(date) === true,
      isToday: date === today,
    }));
  }, [leave.data, holidays.data, days.data, month, today]);

  const leadingBlanks = useMemo(() => {
    const first = cells[0];
    if (first === undefined) return 0;
    return WEEKDAYS.indexOf(fmtCivilWeekday(first.date) as (typeof WEEKDAYS)[number]);
  }, [cells]);

  const marked = cells.filter(
    (c) => c.leave.length > 0 || c.holiday !== null || c.isWeeklyOff,
  );
  const isEmpty = !leave.isLoading && !holidays.isLoading && !days.isLoading && marked.length === 0;

  return (
    <div>
      <PageHeader
        icon={CalendarRange}
        title={t("leave.cal.title")}
        subtitle={t("leave.cal.subtitle")}
        actions={
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9"
              aria-label={t("leave.cal.prev")}
              onClick={() => goMonth(-1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[9rem] whitespace-nowrap text-center text-sm font-medium">
              {fmtMonthLong(month)}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9"
              aria-label={t("leave.cal.next")}
              onClick={() => goMonth(1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link to="/me/leave">{t("leave.apply.back")}</Link>
            </Button>
          </div>
        }
      />

      <ul className="mb-4 flex flex-wrap gap-2 text-xs">
        <li>
          <Badge variant="info">{t("leave.cal.legend.leave")}</Badge>
        </li>
        <li>
          <Badge variant="neutral">{t("leave.cal.legend.off")}</Badge>
        </li>
        <li>
          <Badge variant="success">{t("leave.cal.legend.holiday")}</Badge>
        </li>
      </ul>

      <StateBoundary
        loading={leave.isLoading || context.isLoading}
        error={leave.error ?? context.error}
        onRetry={() => {
          void leave.refetch();
          void context.refetch();
        }}
        isEmpty={isEmpty}
        empty={
          <EmptyState
            title={t("leave.cal.empty.title")}
            hint={t("leave.cal.empty.hint")}
            action={
              <Button asChild size="sm">
                <Link to="/me/leave/apply">{t("leave.nav.apply")}</Link>
              </Button>
            }
          />
        }
        partialError={holidays.error ?? days.error}
        partialLabel={t("leave.cal.legend.holiday")}
        skeletonRows={4}
      >
        {/* ≥768px: month grid */}
        <div className="hidden md:block">
          <div className="grid grid-cols-7 gap-1" role="grid" aria-label={fmtMonthLong(month)}>
            {WEEKDAYS.map((wd) => (
              <div key={wd} className="pb-1 text-center text-xs font-medium text-muted-foreground">
                {wd}
              </div>
            ))}
            {Array.from({ length: leadingBlanks }, (_, i) => (
              <div key={`blank-${i}`} aria-hidden />
            ))}
            {cells.map((cell) => (
              <div
                key={cell.date}
                className={cn(
                  "min-h-[5.5rem] rounded-md border p-2 text-left",
                  cell.isWeeklyOff && "bg-muted/50",
                  cell.holiday !== null && "border-success/40 bg-success/5",
                  cell.leave.length > 0 && "border-info/50 bg-info/5",
                  cell.isToday && "ring-2 ring-ring",
                )}
              >
                <p className="num text-xs font-semibold">{cell.date.slice(8)}</p>
                {cell.holiday !== null ? (
                  <p className="mt-1 line-clamp-2 text-xs text-success">{cell.holiday.name}</p>
                ) : null}
                {cell.isWeeklyOff && cell.leave.length === 0 && cell.holiday === null ? (
                  <p className="mt-1 text-xs text-muted-foreground">{t("leave.cal.legend.off")}</p>
                ) : null}
                {cell.leave.map((l) => (
                  <Link
                    key={l.leave_request_day_id}
                    to={`/me/leave/${l.leave_request_id}`}
                    className="mt-1 block truncate rounded text-xs text-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {l.leave_type_name}
                  </Link>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* <768px: agenda list (spec E-05.6 mobile = agenda) */}
        <div className="md:hidden">
          <h2 className="mb-2 font-display text-base font-semibold">{t("leave.cal.agenda.title")}</h2>
          <ul className="divide-y rounded-lg border bg-card">
            {marked.map((cell) => (
              <li key={cell.date} className="p-3">
                <p className="text-sm font-medium">{fmtCivilDayMonthWeekday(cell.date)}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {cell.holiday !== null ? (
                    <Badge variant="success">{cell.holiday.name}</Badge>
                  ) : null}
                  {cell.isWeeklyOff ? (
                    <Badge variant="neutral">{t("leave.cal.legend.off")}</Badge>
                  ) : null}
                  {cell.leave.map((l) => (
                    <Link key={l.leave_request_day_id} to={`/me/leave/${l.leave_request_id}`}>
                      <Badge variant="info">{l.leave_type_name}</Badge>
                    </Link>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">{t("leave.cal.offsPartial")}</p>
      </StateBoundary>

      {/*
        ── WHO ELSE IS OFF ────────────────────────────────────────────────────
        This replaced a note saying team overlap was unavailable. It was accurate: the page could
        only ever read my own rows, because `leave_requests` is scoped to
        `app.visible_employee_ids()`. `v_leave_roster` is a separate, deliberately narrow view
        that answers the question without opening the request itself.

        Its own boundary, so a failure here leaves MY calendar above it standing — my leave is
        the reason I opened this page, and it must not disappear because a company-wide read
        failed.
      */}
      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">{t("leave.cal.who.title")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("leave.cal.who.subtitle")}</p>

        <StateBoundary
          loading={roster.isLoading}
          error={roster.error ?? undefined}
          onRetry={() => void roster.refetch()}
          skeletonRows={3}
        >
          {byDate.size === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">{t("leave.cal.who.empty")}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {[...byDate.entries()].map(([date, rows]) => (
                <li key={date} className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-xs font-medium">
                    {fmtCivilDayMonthWeekday(date)}
                    {date === today ? ` · ${t("leave.cal.who.today")}` : ""}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {rows.map((row) => (
                      <span
                        key={row.leave_request_day_id}
                        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
                      >
                        <span
                          aria-hidden
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: row.colour_hex ?? "currentColor" }}
                        />
                        <span className="font-medium">{row.display_name}</span>
                        <span className="text-muted-foreground">{row.leave_type_name}</span>
                        {isHalfDay(row.portion) ? (
                          <span className="rounded bg-warning/15 px-1 text-[10px] font-medium text-warning">
                            {portionText(row.portion)}
                          </span>
                        ) : null}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </StateBoundary>
      </section>
    </div>
  );
}
