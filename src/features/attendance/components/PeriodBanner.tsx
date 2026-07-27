/**
 * PeriodBanner — the literal period line of E-03 plus the arrears and lock lines.
 *
 * The line reads, verbatim (spec-employee §5 E-03):
 *   `July 2026 · 01-Jul-2026 to 31-Jul-2026 · 31 days · 25 elapsed · 6 remaining`
 *
 * Three defects are answered here at once:
 *  - DR-34: the period is the CALENDAR month. `31 days`, never a 25-day
 *    "pay period" — the 25th is a payroll cutoff, and it is stated as one on its
 *    own line with the arrears it produces, read from `pay_periods`.
 *  - DR-30: `elapsed` is the denominator every percentage on this screen uses,
 *    so it is on the banner rather than implied.
 *  - DR-19: a locked period says so in words instead of silently rejecting a
 *    correction later.
 */
import { CalendarRange, Clock, Lock, Repeat } from "lucide-react";
import {
  compareCivilDates,
  daysInIstMonth,
  fmtCivilDate,
  fmtCivilTime,
  fmtMonthLong,
  istMonthElapsedDays,
  istMonthRange,
  istMonthRemainingDays,
} from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import type { PayPeriod, ShiftRefRow } from "../api/attendance.api";

export interface PeriodBannerProps {
  /** 'YYYY-MM'. */
  month: string;
  /** The `pay_periods` row for this month; null when none is published. */
  payPeriod: PayPeriod | null;
  /** The employee's standard shift, for the chip. Null = none assigned. */
  shift: ShiftRefRow | null;
  /** `weekly_off_rules.name` — already a sentence; never assembled here. */
  weeklyOffRuleName: string | null;
}

function Chip({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

export function PeriodBanner({ month, payPeriod, shift, weeklyOffRuleName }: PeriodBannerProps) {
  const range = istMonthRange(month);
  const total = daysInIstMonth(month);
  const elapsed = istMonthElapsedDays(month);
  const remaining = istMonthRemainingDays(month);

  const cutoff = payPeriod?.attendance_cutoff_date ?? null;
  const cutoffBeforeMonthEnd = cutoff !== null && compareCivilDates(cutoff, range.to) < 0;
  const locked = payPeriod?.attendance_locked_at ?? null;

  const shiftWindow =
    shift === null
      ? null
      : `${shift.name} · ${fmtCivilTime(shift.start_time)}–${fmtCivilTime(shift.end_time)}`;

  return (
    <section className="mb-6 rounded-lg border bg-card p-4" aria-label={t("attendance.register.title")}>
      <p className="num flex items-start gap-2 text-sm font-medium">
        <CalendarRange className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>
          {t("attendance.banner.line", {
            month: fmtMonthLong(month),
            from: fmtCivilDate(range.from),
            to: fmtCivilDate(range.to),
            total,
            elapsed,
            remaining,
          })}
        </span>
      </p>

      <p className="mt-2 text-xs text-muted-foreground">
        {cutoff === null
          ? t("attendance.banner.noPeriod")
          : cutoffBeforeMonthEnd
            ? t("attendance.banner.arrears", {
                cutoff: fmtCivilDate(cutoff),
                month: fmtMonthLong(month),
              })
            : t("attendance.banner.arrearsNone", { cutoff: fmtCivilDate(cutoff) })}
      </p>

      {locked !== null ? (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/5 px-2 py-1 text-xs">
          <Lock className="h-3.5 w-3.5 text-warning" aria-hidden />
          {t("attendance.banner.locked")}
        </p>
      ) : null}

      {shiftWindow !== null || weeklyOffRuleName !== null ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {shiftWindow !== null ? (
            <Chip icon={Clock} label={t("attendance.chip.shift")} value={shiftWindow} />
          ) : null}
          {weeklyOffRuleName !== null ? (
            <Chip icon={Repeat} label={t("attendance.chip.weeklyOff")} value={weeklyOffRuleName} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
