/**
 * ShowAmounts — the ONE page-level money reveal control (spec-employee §8:
 * "salary `₹•,••,•••` session toggle").
 *
 * Deliberately one control per page rather than an eye icon on every row: with
 * twenty rows, per-field reveals train the reader to click through masking
 * without noticing, and the mask stops being a decision. Here the decision is
 * made once, it is visible (the countdown is on screen the whole time), and it
 * expires on its own.
 */
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import { REVEAL_WINDOW_SECONDS, type AmountReveal } from "../reveal";

export interface ShowAmountsProps {
  reveal: AmountReveal;
}

export function ShowAmounts({ reveal }: ShowAmountsProps) {
  const { revealed, secondsLeft, countdown } = reveal;
  const remainingPct = Math.max(0, Math.min(100, (secondsLeft / REVEAL_WINDOW_SECONDS) * 100));

  return (
    <div className="flex items-center gap-3">
      {revealed ? (
        <div className="hidden sm:block">
          {/* The ticking figure itself is aria-hidden: a screen reader does not
              need it read out once a second. The status line below announces
              the state change only. */}
          <p className="num text-xs font-medium text-muted-foreground" aria-hidden>
            {t("pay.reveal.countdown", { time: countdown })}
          </p>
          <div className="mt-1 h-1 w-28 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-warning transition-[width] duration-1000 ease-linear"
              style={{ width: `${remainingPct}%` }}
            />
          </div>
        </div>
      ) : null}

      <Button
        variant={revealed ? "secondary" : "default"}
        size="sm"
        onClick={revealed ? reveal.hide : reveal.reveal}
        aria-pressed={revealed}
      >
        {revealed ? (
          <EyeOff className="mr-1.5 h-4 w-4" aria-hidden />
        ) : (
          <Eye className="mr-1.5 h-4 w-4" aria-hidden />
        )}
        {revealed ? t("pay.reveal.hide") : t("pay.reveal.show")}
      </Button>

      <span className="sr-only" role="status">
        {revealed ? t("pay.reveal.announce", { minutes: reveal.windowMinutes }) : t("pay.reveal.hidden")}
      </span>
    </div>
  );
}

/** The standing explanation of what the toggle does. Sits in the page body. */
export function RevealNote({ reveal }: ShowAmountsProps) {
  return (
    <p className="text-xs text-muted-foreground">
      {reveal.revealed
        ? t("pay.reveal.note.on", { time: reveal.countdown })
        : t("pay.reveal.note.off", { minutes: reveal.windowMinutes })}
    </p>
  );
}
