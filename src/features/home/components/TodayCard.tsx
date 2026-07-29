/**
 * Region B — TODAY (spec-employee §5 E-02).
 *
 * Every figure is a column of `attendance_days` (via `v_attendance_day_enriched`):
 * `first_in_at`, `last_out_at`, `total_worked_minutes`, `status`. Nothing is
 * derived. The ONE moving number is the stopwatch since the first scan, and it is
 * labelled as exactly that — worked hours stay the engine's number, because the
 * engine is what applies the unpaid break and the shift's grace (§3.4).
 *
 * `null` row = the engine has not written today yet: "No punches yet today",
 * never a zero-filled card. One scan = `missing_punch`, never absent (§3.1).
 */
import { Link } from "react-router-dom";
import { Clock, ScanFace } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip } from "@/shared/ui/StatusChip";
import {
  fmtDurationHm,
  fmtTime,
  fmtTimeWithDayOffset,
  isFutureInstant,
  minutesSince,
} from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import type { AttendanceDay } from "@/features/attendance/api/attendance.api";
// The status chip comes from the attendance domain's own vocabulary, so this card
// and /me/attendance say the same words about the same row (DR-29/DR-53).
import { dayStatusChip, displayStatus } from "@/features/attendance/display";
import { Fact, HomeCard, RegionBody } from "./HomeCard";

export interface TodayCardProps {
  /** The today query, already scoped to the caller by RLS. */
  query: UseQueryResult<AttendanceDay | null, Error>;
  /** Ticker instant, so the running stopwatch repaints. */
  nowMs: number;
  /** IST business date, for the punches deep link when no row exists yet. */
  today: string;
}

/*
  ONE COLUMN, NOT TWO. This card was written for a row of two, so it carried
  `lg:col-span-2` and left a single column for Needs-your-attention. The punch card has
  joined that row, so a two-column Today would push the third card onto a row of its own —
  which is exactly the vertical stacking this change exists to remove.
*/
export function TodayCard({ query, nowMs, today }: TodayCardProps) {
  return (
    <HomeCard
      icon={Clock}
      title={t("home.today.title")}
      action={
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/me/attendance/${today}`}>{t("home.today.viewPunches")}</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/me/regularizations/new">{t("home.today.regularize")}</Link>
          </Button>
        </div>
      }
    >
      <RegionBody
        query={query}
        // Two across, matching the real grid below — never four in a third-width card.
        skeleton={
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
        }
        isEmpty={(day) => day === null}
        empty={
          <EmptyState
            icon={ScanFace}
            title={t("home.today.empty.title")}
            hint={t("home.today.empty.hint")}
          />
        }
      >
        {(day) => (day === null ? null : <TodayFacts day={day} nowMs={nowMs} />)}
      </RegionBody>
    </HomeCard>
  );
}

function TodayFacts({ day, nowMs }: { day: AttendanceDay; nowMs: number }) {
  // `pending` stays "not processed yet" and never becomes Absent (§3.6/DR-30).
  const status = displayStatus(day, day.ist_date);
  const checkedIn = day.first_in_at !== null;
  const checkedOut = day.last_out_at !== null;
  const shiftRunning =
    checkedIn &&
    !checkedOut &&
    day.shift_end_at !== null &&
    isFutureInstant(day.shift_end_at, nowMs);

  return (
    <div className="space-y-4">
      {/*
        TWO ACROSS AT EVERY WIDTH. It used to go to four columns at `sm`, which was right
        for a card spanning two thirds of the page and wrong now: four stats across a
        third-width card gives each of them about seventy pixels, and "0h 00m" wraps
        mid-value. Two-by-two keeps every figure on one line, and the four facts pair up
        naturally anyway — in and out, then worked and status.
      */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact
          label={t("home.today.firstIn")}
          value={day.first_in_at === null ? "—" : fmtTime(day.first_in_at)}
        />
        <Fact
          label={t("home.today.lastOut")}
          value={
            day.last_out_at === null ? "—" : fmtTimeWithDayOffset(day.last_out_at, day.ist_date)
          }
        />
        <Fact label={t("home.today.worked")} value={fmtDurationHm(day.total_worked_minutes)} />
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t("home.today.title")}</dt>
          <dd className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusChip status={status} map={dayStatusChip(status, day.leave_type_name)} />
            {day.is_regularized ? (
              <Badge variant="info">{t("home.today.regularized")}</Badge>
            ) : null}
          </dd>
        </div>
      </dl>

      {shiftRunning && day.first_in_at !== null ? (
        <p className="rounded-md bg-info/10 px-3 py-2 text-sm text-info" role="status">
          <span className="font-medium">{t("home.today.running")}</span>{" "}
          <span className="num">
            {t("home.today.runningSince", {
              elapsed: fmtDurationHm(minutesSince(day.first_in_at, nowMs)),
              time: fmtTime(day.first_in_at),
            })}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {t("home.today.runningHint")}
          </span>
        </p>
      ) : null}

      {day.punch_count === 1 ? (
        <p className="text-sm text-warning">{t("home.today.awaitingCheckout")}</p>
      ) : null}

      {day.is_late && day.late_minutes !== null && day.late_minutes > 0 ? (
        <p className="text-sm text-warning">
          {t("home.today.lateBy", { duration: fmtDurationHm(day.late_minutes) })}
        </p>
      ) : null}

      {day.is_locked ? (
        <p className="text-sm text-muted-foreground">{t("home.today.locked")}</p>
      ) : null}
    </div>
  );
}
