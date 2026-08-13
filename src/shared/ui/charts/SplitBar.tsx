/**
 * SplitBar — one horizontal bar showing how a whole divides.
 *
 * Earnings against deductions, present against absent, one department's share of
 * headcount. The comparison a stacked bar makes instantly and a pair of numbers
 * does not: which is bigger, and by roughly how much.
 *
 * Plain flex boxes rather than a chart library — this is rectangles in a row, and
 * it renders inside table cells and card footers where a 90 kB dependency and a
 * ResponsiveContainer have no business being.
 */
import { useId } from "react";
import { cn } from "@/lib/utils";
import { CHART_TONE, prefersReducedMotion, type ChartTone } from "./chartTokens";

export interface SplitSegment {
  readonly key: string;
  readonly label: string;
  /** Server value. Negatives are ignored: a bar cannot be less than nothing. */
  readonly value: number;
  readonly tone: ChartTone;
}

export interface SplitBarProps {
  readonly segments: readonly SplitSegment[];
  readonly title: string;
  /** Formats each value for its tooltip and legend; defaults to the number. */
  readonly format?: (value: number) => string;
  /** Show the labels beneath. Off inside a dense table row. */
  readonly legend?: boolean;
  /**
   * Put each segment's SHARE beside its figure in the legend.
   *
   * The share is the one number a stacked bar is showing and the only one a
   * reader cannot get from the labels — "18 days" against a whole they have to
   * add up themselves is half an answer. Off by default because inside a table
   * cell there is no room for it.
   */
  readonly showShare?: boolean;
  /**
   * A line under the legend naming the whole, e.g. "of 26 days". Supplied by the
   * caller because only the caller knows whether the segments ARE the whole — a
   * bar of three of six buckets must not claim to be a total.
   */
  readonly totalCaption?: string;
  readonly height?: number;
  readonly className?: string;
}

export function SplitBar({
  segments,
  title,
  format = (v) => String(v),
  legend = true,
  showShare = false,
  totalCaption,
  height = 10,
  className,
}: SplitBarProps) {
  const titleId = useId();
  const usable = segments.filter((s) => s.value > 0);
  const total = usable.reduce((sum, s) => sum + s.value, 0);

  return (
    <figure className={cn("w-full", className)} aria-labelledby={titleId}>
      <figcaption id={titleId} className="sr-only">
        {title}
      </figcaption>
      <div
        className="flex w-full overflow-hidden rounded-full bg-muted"
        style={{ height }}
        role="img"
        aria-label={
          total === 0
            ? title
            : `${title}: ${usable.map((s) => `${s.label} ${format(s.value)}`).join(", ")}`
        }
      >
        {total === 0
          ? null
          : usable.map((segment) => (
              <div
                key={segment.key}
                /* `title` gives a native tooltip on hover with no JS and no
                   portal — inside a table cell that is the right trade. */
                title={
                  showShare
                    ? `${segment.label}: ${format(segment.value)} (${share(segment.value, total)})`
                    : `${segment.label}: ${format(segment.value)}`
                }
                className="h-full first:rounded-l-full last:rounded-r-full hover:brightness-110"
                style={{
                  width: `${String((segment.value / total) * 100)}%`,
                  backgroundColor: CHART_TONE[segment.tone],
                  transition: prefersReducedMotion()
                    ? undefined
                    : "width 600ms cubic-bezier(0.22, 1, 0.36, 1), filter 150ms",
                }}
              />
            ))}
      </div>
      {legend && usable.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {usable.map((segment) => (
            <li key={segment.key} className="flex items-center gap-1.5 text-xs">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: CHART_TONE[segment.tone] }}
                aria-hidden
              />
              <span className="text-muted-foreground">{segment.label}</span>
              <span className="num font-medium">{format(segment.value)}</span>
              {showShare ? (
                <span className="num text-muted-foreground">{share(segment.value, total)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {totalCaption !== undefined && usable.length > 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{totalCaption}</p>
      ) : null}
    </figure>
  );
}

/**
 * One segment's share of the bar, to the nearest whole percent.
 *
 * Rounded for READING, and never anywhere near a decision: the figures beside it
 * are the server's and are what anybody would act on. Rounding here cannot make
 * two screens disagree because no other screen shows this number.
 */
function share(value: number, total: number): string {
  if (total <= 0) return "—";
  return `${String(Math.round((value / total) * 100))}%`;
}
