/**
 * PeriodSelector — the ONE period control on E-03 (`[◄ Jul-2026 ►]`).
 *
 * The month lives in the URL as `?m=YYYY-MM` (spec-employee §3.2), so a month is
 * shareable, bookmarkable and survives a reload; there is no second copy of it in
 * component state to drift out of sync. Bounds are facts, not guesses: you cannot
 * step before the month you joined in, and you cannot step into the future.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addIstMonths, fmtCivilMonth, istMonthOfDate, nowIstMonth } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";

export interface PeriodSelectorProps {
  /** Current month, 'YYYY-MM'. */
  month: string;
  /** `employees.date_of_join`; null = no lower bound known yet. */
  dateOfJoin: string | null;
  onChange: (month: string) => void;
}

export function PeriodSelector({ month, dateOfJoin, onChange }: PeriodSelectorProps) {
  const minMonth = dateOfJoin === null ? null : istMonthOfDate(dateOfJoin);
  const maxMonth = nowIstMonth();
  const previous = addIstMonths(month, -1);
  const next = addIstMonths(month, 1);

  // 'YYYY-MM' strings are chronological under plain comparison.
  const atStart = minMonth !== null && previous < minMonth;
  const atEnd = next > maxMonth;

  return (
    <div className="flex items-center gap-1 rounded-lg border bg-card p-1">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        disabled={atStart}
        onClick={() => onChange(previous)}
        aria-label={t("attendance.period.previous")}
        title={atStart ? t("attendance.period.atStart") : t("attendance.period.previous")}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </Button>
      <span className="num min-w-24 px-1 text-center text-sm font-medium" aria-live="polite">
        {fmtCivilMonth(month)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        disabled={atEnd}
        onClick={() => onChange(next)}
        aria-label={t("attendance.period.next")}
        title={atEnd ? t("attendance.period.atEnd") : t("attendance.period.next")}
      >
        <ChevronRight className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
