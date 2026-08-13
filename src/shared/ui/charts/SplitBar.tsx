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
  readonly height?: number;
  readonly className?: string;
}

export function SplitBar({
  segments,
  title,
  format = (v) => String(v),
  legend = true,
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
                title={`${segment.label}: ${format(segment.value)}`}
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
            </li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}
