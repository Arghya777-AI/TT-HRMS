/**
 * MonthStepper — previous / month label / next, for the admin screens whose
 * period lives in the URL (`?m=YYYY-MM`).
 *
 * "Next" stops at the current IST month: there is no kiosk health and no match
 * log for a month that has not happened, and an empty grid for August in July
 * reads as an outage rather than as the future (DR-30, the phantom-absent
 * defect, in its calendar form).
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addIstMonths, fmtMonthLong, nowIstMonth } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";

export interface MonthStepperProps {
  month: string;
  onChange: (month: string) => void;
  /** Earliest month the caller has data for; below it "previous" is disabled. */
  minMonth?: string;
}

export function MonthStepper({ month, onChange, minMonth }: MonthStepperProps) {
  const previous = addIstMonths(month, -1);
  const next = addIstMonths(month, 1);
  // ISO month keys sort lexicographically, so a string compare IS the ordering.
  const canGoBack = minMonth === undefined || previous >= minMonth;
  const canGoForward = next <= nowIstMonth();

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="icon"
        disabled={!canGoBack}
        aria-label={t("attendance.period.previous")}
        onClick={() => onChange(previous)}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="min-w-[9rem] text-center text-sm font-medium" aria-live="polite">
        {fmtMonthLong(month)}
      </span>
      <Button
        variant="outline"
        size="icon"
        disabled={!canGoForward}
        aria-label={t("attendance.period.next")}
        onClick={() => onChange(next)}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
