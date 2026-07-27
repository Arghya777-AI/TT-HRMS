/**
 * DayCalculation — "how worked hours were derived", for one date (E-03.6).
 *
 * Every row below is a stored column of `attendance_days`, read through
 * `v_attendance_day_enriched`. The block RECONCILES to Worked by naming the
 * three server figures and the relation between them in words; it does not
 * recompute the subtraction, because a client that re-derived the number could
 * disagree with the payslip, which is the whole defect class we are removing
 * (DR-29). If gross − break does not look like worked on screen, the engine is
 * wrong and we want to see it.
 */
import { fmtDurationHm, fmtTime, fmtTimeWithDayOffset } from "@/lib/datetime";
import { dash, formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AttendanceDay } from "../api/attendance.api";

export interface DayCalculationProps {
  day: AttendanceDay;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="num text-sm font-medium">{value}</dd>
    </div>
  );
}

export function DayCalculation({ day }: DayCalculationProps) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="font-display text-base font-semibold">{t("attendance.day.calc.title")}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t("attendance.day.calc.hint")}</p>

      <dl className="mt-3">
        <Row label={t("attendance.day.calc.firstIn")} value={dash(day.first_in_at, fmtTime)} />
        <Row
          label={t("attendance.day.calc.lastOut")}
          value={fmtTimeWithDayOffset(day.last_out_at, day.ist_date)}
        />
        <Row label={t("attendance.day.calc.punches")} value={String(day.punch_count)} />
        <Row
          label={t("attendance.day.calc.grossSpan")}
          value={fmtDurationHm(day.gross_span_minutes)}
        />
        <Row label={t("attendance.day.calc.break")} value={fmtDurationHm(day.break_minutes)} />
        <Row
          label={t("attendance.day.calc.worked")}
          value={fmtDurationHm(day.total_worked_minutes)}
        />
        <Row
          label={t("attendance.day.calc.payable")}
          value={fmtDurationHm(day.payable_worked_minutes)}
        />
        {day.is_late ? (
          <Row label={t("attendance.day.calc.late")} value={fmtDurationHm(day.late_minutes)} />
        ) : null}
        {day.is_early_exit ? (
          <Row
            label={t("attendance.day.calc.earlyOut")}
            value={fmtDurationHm(day.early_exit_minutes)}
          />
        ) : null}
        <Row
          label={t("attendance.day.calc.ot")}
          value={fmtDurationHm(day.approved_overtime_minutes)}
        />
        <Row
          label={t("attendance.day.calc.paidRatio")}
          value={dash(day.day_fraction_paid, formatDays)}
        />
      </dl>

      {day.punch_count === 1 ? (
        <p className="mt-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
          {t("attendance.day.calc.missingOut")}
        </p>
      ) : null}
    </section>
  );
}
