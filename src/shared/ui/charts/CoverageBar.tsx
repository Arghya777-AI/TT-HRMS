/**
 * CoverageBar — how far something got against what it was supposed to reach.
 *
 * `SplitBar` shows how a whole DIVIDES. This shows one figure against a TARGET,
 * which is a different question and reads badly as a stacked bar: rostered
 * against required, taken against entitled, collected against due. The thing a
 * reader wants in one glance is not the two numbers — it is whether the first
 * one got there, and by how far it missed.
 *
 * ── THE THREE STATES, AND WHY EACH LOOKS DIFFERENT ──────────────────────────
 *
 *  · SHORT — the fill stops before the end and the gap stays visible, in the
 *    destructive tone. The gap is the whole point; filling the track and writing
 *    "80%" underneath would bury it.
 *  · MET — the fill reaches the end, in the success tone.
 *  · OVER — the fill reaches the end and a marker sits where the target was, so
 *    surplus is legible without the bar growing past its own track. A bar that
 *    overflows its container to show 140% is a bar that breaks a table cell.
 *
 * ── A TARGET OF ZERO IS NOT A FULL BAR ──────────────────────────────────────
 *
 * Nothing required means nothing to be short of — but it does NOT mean covered,
 * and colouring it green would tell a manager a department is staffed when
 * nobody has said what it needs. With no target the bar renders as an empty
 * neutral track and the caption says so.
 *
 * Plain flex boxes, like `SplitBar` — this is two rectangles, and it renders
 * inside table cells where a charting library and a ResponsiveContainer have no
 * business being.
 */
import { useId } from "react";
import { cn } from "@/lib/utils";
import { CHART_TONE, prefersReducedMotion } from "./chartTokens";

export interface CoverageBarProps {
  /** What was achieved — rostered, taken, collected. */
  readonly value: number;
  /**
   * What it was meant to reach. Null or zero means nobody has stated one, which
   * is rendered as unknown rather than as met.
   */
  readonly target: number | null;
  /** Accessible name — what the reader is looking at. */
  readonly title: string;
  /** Formats both figures for the label; defaults to the plain number. */
  readonly format?: (value: number) => string;
  /** One line beneath, e.g. "3 short in Kitchen". Caller's words. */
  readonly caption?: string;
  /** Show the "n of m" label above the bar. Off inside a dense table cell. */
  readonly showLabel?: boolean;
  readonly height?: number;
  readonly className?: string;
}

/** What the bar is saying, named once so the colour and the words cannot drift. */
export type CoverageState = "unknown" | "short" | "met" | "over";

export function coverageState(value: number, target: number | null): CoverageState {
  if (target === null || target <= 0) return "unknown";
  if (value < target) return "short";
  return value > target ? "over" : "met";
}

/** How much is missing. Never negative — a surplus is not a negative shortfall. */
export function shortfall(value: number, target: number | null): number {
  if (target === null || target <= 0) return 0;
  return Math.max(target - value, 0);
}

const STATE_TONE: Record<CoverageState, string> = {
  unknown: CHART_TONE.neutral,
  short: CHART_TONE.absent,
  met: CHART_TONE.present,
  over: CHART_TONE.present,
};

export function CoverageBar({
  value,
  target,
  title,
  format = (v) => String(v),
  caption,
  showLabel = false,
  height = 10,
  className,
}: CoverageBarProps) {
  const titleId = useId();
  const state = coverageState(value, target);

  /*
    Capped at 100%. An over-covered bar shows a full track and a marker at the
    target rather than a fill running past its own container — the surplus is
    read from the figures, which are exact, not from a rectangle that has escaped.
  */
  const pct =
    target === null || target <= 0 ? 0 : Math.min(Math.max(value / target, 0), 1) * 100;

  const label =
    target === null || target <= 0
      ? format(value)
      : `${format(value)} / ${format(target)}`;

  return (
    <figure className={cn("w-full", className)} aria-labelledby={titleId}>
      <figcaption id={titleId} className="sr-only">
        {title}
      </figcaption>

      {showLabel ? (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="num text-xs font-medium">{label}</span>
          {state === "short" ? (
            <span className="num text-xs font-semibold text-destructive">
              −{format(shortfall(value, target))}
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        className="relative w-full overflow-hidden rounded-full bg-muted"
        style={{ height }}
        role="img"
        aria-label={`${title}: ${label}`}
        title={`${title}: ${label}`}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${String(pct)}%`,
            backgroundColor: STATE_TONE[state],
            transition: prefersReducedMotion()
              ? undefined
              : "width 600ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />
        {/*
          Where the target sat, drawn only when it has been beaten. On a short or
          exactly-met bar the target IS the end of the track, so a marker there
          would be a line on the edge of a rounded rectangle — noise.
        */}
        {state === "over" ? (
          <span
            aria-hidden
            className="absolute inset-y-0 w-0.5 bg-background/70"
            style={{ left: `${String((target === null ? 1 : target / Math.max(value, 1)) * 100)}%` }}
          />
        ) : null}
      </div>

      {caption === undefined ? null : (
        <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
      )}
    </figure>
  );
}
