/**
 * Region D — the my-month strip: K1, K8, K9, K14 of the §3.7 catalogue.
 *
 * Every value is a NAMED COLUMN of the one month-to-date row
 * (`v_attendance_period_summary`, which wraps `f_attendance_period_summary`
 * pinned to month-start…today). Nothing is summed, averaged or ratio'd here —
 * that is what makes this strip and `/me/attendance` unable to disagree (DR-29).
 *
 * Because the view is pinned to month-to-date, `total_days` = (to_date −
 * from_date + 1) IS the elapsed-day count, so K8 can state its denominator in
 * words from the row itself (DR-33) without a client-side elapsed calculation.
 *
 * ── THE RING, AND THE ONE THAT IS NOT HERE ─────────────────────────────────
 *
 * `paid_days` against `total_days` is the month's headline ratio and both halves
 * are named columns of this same row — the "Paid days" tile beside the ring
 * already prints one as its value and the other in its hint. The ring adds the
 * comparison and no arithmetic.
 *
 * A SPLIT BAR OF THE MONTH'S DAY TYPES WAS THE OBVIOUS SECOND CHART AND IT WOULD
 * HAVE LIED. `present_days` counts `weekly_off_worked` and `holiday_worked`,
 * while `weekly_off_days` and `holiday_days` count the `is_weekly_off` /
 * `is_holiday` FLAGS — so a weekly off that was worked lands in two segments at
 * once, and `leave_days` is a fraction sum that can overlap `half_days` again.
 * These columns are a metric catalogue, not a partition of the month, and a
 * stacked bar asserts a partition. The calendar above already shows how the
 * month divides, one day at a time, and it is right by construction.
 */
import { Link } from "react-router-dom";
import { CalendarRange, Wrench } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { ProgressRing } from "@/shared/ui/charts/ProgressRing";
import { CHART_TONE } from "@/shared/ui/charts/chartTokens";
import { fmtCivilDate, fmtDurationHm } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AttendancePeriodSummary } from "@/features/attendance/api/attendance.api";
import { HomeCard, RegionBody } from "./HomeCard";

export interface MonthStripProps {
  query: UseQueryResult<AttendancePeriodSummary | null, Error>;
}

export function MonthStrip({ query }: MonthStripProps) {
  return (
    <HomeCard
      icon={CalendarRange}
      title={t("home.month.title")}
      className="lg:col-span-3"
      action={
        <Button asChild variant="ghost" size="sm">
          <Link to="/me/attendance">{t("home.month.viewAll")}</Link>
        </Button>
      }
    >
      <RegionBody
        query={query}
        skeleton={
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        }
        isEmpty={(row) => row === null}
        empty={
          <EmptyState
            icon={Wrench}
            title={t("home.month.empty.title")}
            hint={t("home.month.empty.hint")}
          />
        }
      >
        {(row) => (row === null ? null : <Tiles row={row} />)}
      </RegionBody>
    </HomeCard>
  );
}

function Tiles({ row }: { row: AttendancePeriodSummary }) {
  const from = fmtCivilDate(row.from_date);
  const to = fmtCivilDate(row.to_date);
  const present = formatNumber(row.present_days);
  const half = formatNumber(row.half_days);
  const paid = formatNumber(row.paid_days);
  const total = formatNumber(row.total_days);
  const lateHours = fmtDurationHm(row.late_minutes);
  const extraHours = fmtDurationHm(row.extra_work_minutes);

  return (
    <>
      <p className="num mb-3 text-xs text-muted-foreground">
        {t("home.month.period", { from, to })}
      </p>
      {/*
        The ring stacks ABOVE the tiles on a phone and sits to their left from
        `lg`, which is the only width where four tiles and a 112px ring share a
        row without either being squeezed. It is a figure, not a replacement:
        every number it draws is still printed in full beside it.
      */}
      <div className="flex flex-col items-center gap-4 lg:flex-row lg:items-center">
        <ProgressRing
          className="shrink-0"
          value={row.paid_days}
          total={row.total_days}
          centre={paid}
          caption={t("home.chart.paidDays.caption", { total })}
          title={t("home.chart.paidDays.title", { paid, total })}
          color={CHART_TONE.present}
        />
        <div className="grid w-full flex-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label={t("home.kpi.attended")}
            value={t("home.unit.days", { count: present })}
            hint={t("home.kpi.attended.hint", { half })}
            explainer={{
              formula: t("home.kpi.attended.formula", { from, to }),
              numbers: t("home.kpi.attended.numbers", { present, half }),
            }}
          />
          <KpiTile
            label={t("home.kpi.paidDays")}
            value={t("home.unit.days", { count: paid })}
            hint={t("home.kpi.paidDays.hint", { total })}
            explainer={{
              formula: t("home.kpi.paidDays.formula"),
              numbers: t("home.kpi.paidDays.numbers", { paid, total, from, to }),
            }}
          />
          <KpiTile
            label={t("home.kpi.lateHours")}
            value={lateHours}
            hint={t("home.kpi.lateHours.hint", { days: formatNumber(row.late_days) })}
            tone={row.late_minutes > 0 ? "warn" : "neutral"}
            explainer={{
              formula: t("home.kpi.lateHours.formula"),
              numbers: t("home.kpi.lateHours.numbers", {
                duration: lateHours,
                days: formatNumber(row.late_days),
                from,
                to,
              }),
            }}
          />
          <KpiTile
            label={t("home.kpi.extraWork")}
            value={extraHours}
            hint={t("home.kpi.extraWork.hint")}
            tone={row.extra_work_minutes > 0 ? "success" : "neutral"}
            explainer={{
              formula: t("home.kpi.extraWork.formula"),
              numbers: t("home.kpi.extraWork.numbers", { duration: extraHours, from, to }),
            }}
          />
        </div>
      </div>
    </>
  );
}
