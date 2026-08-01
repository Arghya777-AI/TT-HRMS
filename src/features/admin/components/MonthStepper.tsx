/**
 * MonthStepper — previous / month label / next, for the admin screens whose
 * period lives in the URL (`?m=YYYY-MM`).
 *
 * "Next" stops at the current IST month: there is no kiosk health and no match
 * log for a month that has not happened, and an empty grid for August in July
 * reads as an outage rather than as the future (DR-30, the phantom-absent
 * defect, in its calendar form).
 *
 * THE LABEL'S MINIMUM WIDTH IS A PHONE MINIMUM, NOT A DESKTOP ONE. `min-w-[9rem]` plus two
 * 40px buttons plus the "This month" button that every caller puts beside it came to more than
 * a 390px viewport, and none of it could give — so six admin and team screens scrolled
 * sideways, which drags the fixed bottom nav out of alignment with them. The floor is now
 * 7rem below `sm` (still wide enough for "September 2026" at this size) and the row may
 * shrink, so the overflow lands on the label rather than on the page.
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
    <div className="flex min-w-0 items-center gap-1">
      <Button
        variant="outline"
        size="icon"
        disabled={!canGoBack}
        aria-label={t("attendance.period.previous")}
        onClick={() => onChange(previous)}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span
        className="min-w-[7rem] flex-1 text-center text-sm font-medium sm:min-w-[9rem] sm:flex-none"
        aria-live="polite"
      >
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
