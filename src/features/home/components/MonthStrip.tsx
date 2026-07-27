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
 */
import { Link } from "react-router-dom";
import { CalendarRange, Wrench } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
    </>
  );
}
