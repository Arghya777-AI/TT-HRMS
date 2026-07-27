/**
 * E-03.6 · /me/attendance/:date — every scan of one business date.
 *
 * `:date` is an IST civil date ('YYYY-MM-DD'), and it is the BUSINESS date, not
 * the wall-clock date of the scan: a night shift's 06:04 check-out is filed
 * under the day the shift started and is shown as `06:04 (+1d)` (§3.1).
 *
 * Three things this screen refuses to do:
 *  - Show a future date as anything but upcoming. No phantom absents (DR-30).
 *  - Show a match score, a template version or a face thumbnail's internals.
 *    Method is one word — Face, Fingerprint, Web, Corrected (A12).
 *  - Recompute worked hours. The calculation block reconciles by NAMING the
 *    server's own figures; if they do not add up, the engine is wrong and the
 *    screen must show that rather than hide it (DR-29).
 *
 * @route /me/attendance/:date
 */
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CalendarClock, Clock, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import {
  fmtCivilDateWeekday,
  fmtCivilTime,
  isFutureIstDate,
  istMonthOfDate,
} from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import {
  useAttendanceDay,
  useAttendancePunches,
  usePunchDuplicateIds,
  useShiftRefs,
} from "../hooks/useAttendance";
import { dayStatusChip, displayStatus } from "../display";
import { PunchTimeline } from "../components/PunchTimeline";
import { DayCalculation } from "../components/DayCalculation";

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function AttendanceDayDetailPage() {
  const { date } = useParams<{ date: string }>();
  const valid = typeof date === "string" && CIVIL_DATE.test(date);
  const istDate = valid ? date : "";

  const day = useAttendanceDay(valid ? istDate : undefined);
  const punches = useAttendancePunches(valid ? istDate : undefined);
  const duplicates = usePunchDuplicateIds(valid ? istDate : undefined);
  const shiftId = day.data?.shift_id ?? null;
  const shifts = useShiftRefs(shiftId === null ? [] : [shiftId]);

  const backTo = valid ? `/me/attendance?m=${istMonthOfDate(istDate)}` : "/me/attendance";
  const future = valid && isFutureIstDate(istDate);
  const status = valid ? displayStatus(day.data ?? null, istDate) : null;
  const shift = shiftId === null ? null : (shifts.data?.get(shiftId) ?? null);

  const header = (
    <PageHeader
      icon={CalendarClock}
      title={valid ? fmtCivilDateWeekday(istDate) : t("attendance.day.title")}
      subtitle={t("attendance.day.subtitle")}
      actions={
        <Button variant="outline" asChild>
          <Link to={backTo}>
            <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
            {t("attendance.day.back")}
          </Link>
        </Button>
      }
    />
  );

  if (!valid) {
    return (
      <div className="container py-6">
        {header}
        <EmptyState
          icon={CalendarClock}
          title={t("attendance.day.badDate.title")}
          hint={t("attendance.day.badDate.hint")}
          action={
            <Button asChild>
              <Link to="/me/attendance">{t("attendance.day.back")}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  // A date that has not happened yet is upcoming — never absent, never a
  // punch list waiting to be explained away.
  if (future) {
    return (
      <div className="container py-6">
        {header}
        <EmptyState
          icon={Clock}
          title={t("attendance.day.future.title")}
          hint={t("attendance.day.future.hint", { date: fmtCivilDateWeekday(istDate) })}
          action={
            <Button variant="outline" asChild>
              <Link to={backTo}>{t("attendance.day.back")}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="container py-6">
      {header}

      <StateBoundary
        loading={day.isLoading}
        error={day.error ?? undefined}
        onRetry={() => void day.refetch()}
        isEmpty={day.isSuccess && day.data === null}
        empty={
          <EmptyState
            icon={Clock}
            title={t("attendance.day.noRow.title")}
            hint={t("attendance.day.noRow.hint")}
            action={
              <Button variant="outline" asChild>
                <Link to={`/me/regularizations/new?date=${istDate}`}>
                  {t("attendance.day.regularize")}
                </Link>
              </Button>
            }
          />
        }
        skeletonRows={2}
      >
        {day.data !== null && day.data !== undefined && status !== null ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="min-w-0">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <StatusChip
                  status={status}
                  map={dayStatusChip(status, day.data.leave_type_name)}
                />
                {shift !== null ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    <span className="text-muted-foreground">{t("attendance.day.shift")}</span>
                    <span className="num font-medium">
                      {shift.name} · {fmtCivilTime(shift.start_time)}–{fmtCivilTime(shift.end_time)}
                    </span>
                  </span>
                ) : null}
                {day.data.holiday_name !== null ? (
                  <span className="rounded-full border bg-background px-2.5 py-1 text-xs">
                    {t("attendance.day.holiday")}: {day.data.holiday_name}
                  </span>
                ) : null}
                {day.data.is_locked ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/5 px-2.5 py-1 text-xs">
                    <Lock className="h-3.5 w-3.5 text-warning" aria-hidden />
                    {t("attendance.action.locked")}
                  </span>
                ) : null}
              </div>

              <h2 className="mb-3 font-display text-lg font-semibold">
                {t("attendance.day.timeline.title")}
              </h2>

              <StateBoundary
                loading={punches.isLoading}
                error={punches.error ?? undefined}
                onRetry={() => void punches.refetch()}
                partialError={duplicates.error ?? undefined}
                partialLabel={t("attendance.day.duplicateHint")}
                skeletonRows={3}
              >
                <PunchTimeline
                  punches={punches.data ?? []}
                  duplicateIds={duplicates.data ?? new Set<string>()}
                  businessDate={istDate}
                  emptyState={
                    <EmptyState
                      icon={Clock}
                      title={t("attendance.day.noPunches.title")}
                      hint={t("attendance.day.noPunches.hint")}
                      action={
                        day.data.is_locked ? undefined : (
                          <Button variant="outline" asChild>
                            <Link to={`/me/regularizations/new?date=${istDate}`}>
                              {t("attendance.day.regularize")}
                            </Link>
                          </Button>
                        )
                      }
                    />
                  }
                />
              </StateBoundary>
            </div>

            <DayCalculation day={day.data} />
          </div>
        ) : null}
      </StateBoundary>
    </div>
  );
}
