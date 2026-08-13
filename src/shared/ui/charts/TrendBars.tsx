/**
 * TrendBars — a small bar chart for a run of days, weeks or months.
 *
 * The shape the employee screens kept needing and did not have: "how has this
 * been going", answered at a glance before the table below answers it precisely.
 *
 * ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────
 *
 * It does not compute. Every bar is a value the server already produced — this
 * component picks a colour and a height and nothing else. A chart that derives
 * its own totals is a second arithmetic that can disagree with the table beside
 * it, which is the failure this codebase spends most of its comments avoiding.
 *
 * It does not invent a zero. A day with no record is `null` and renders as a
 * gap, not a bar of height nothing — those are different facts and an employee
 * reading "absent" where the truth is "not processed yet" will raise a ticket.
 */
import { useId } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { cn } from "@/lib/utils";
import { animationProps, CHART_TONE, type ChartTone } from "./chartTokens";

export interface TrendBar {
  /** Stable identity — colour and tooltip bind to this, never to position. */
  readonly key: string;
  /** Axis label, already formatted (e.g. "12", "Mon", "Mar"). */
  readonly label: string;
  /** Server value. `null` means "no record", which is not zero. */
  readonly value: number | null;
  readonly tone: ChartTone;
  /** One line in the tooltip, already in words. */
  readonly caption?: string;
}

export interface TrendBarsProps {
  readonly bars: readonly TrendBar[];
  /** Accessible name — what the reader is looking at. */
  readonly title: string;
  /** Formats a value for the tooltip; defaults to the plain number. */
  readonly format?: (value: number) => string;
  readonly height?: number;
  readonly className?: string;
  /** Show the value axis. Off by default: on a sparkline it is noise. */
  readonly showAxis?: boolean;
  /**
   * Draw a dashed reference line at this value, labelled.
   *
   * A run of bars says which days were bigger. It does not say whether ANY of
   * them were normal, which is usually the question — a nine-hour Tuesday means
   * one thing on a nine-hour contract and another on a six. The caller supplies
   * the line because the caller knows what the right comparison is: a rostered
   * shift length, a contracted average, a target. Nothing is averaged here.
   */
  readonly reference?: { readonly value: number; readonly label: string };
}

interface Datum extends TrendBar {
  /** recharts needs a number to lay out; the original stays on the datum. */
  readonly plotted: number;
}

function ChartTooltip({
  active,
  payload,
  format,
  reference,
}: TooltipProps<number, string> & {
  format: (value: number) => string;
  reference?: { readonly value: number; readonly label: string };
}) {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  const datum = payload[0]?.payload as Datum | undefined;
  if (datum === undefined) return null;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <p className="font-medium text-popover-foreground">{datum.label}</p>
      <p className="num mt-0.5 text-popover-foreground">
        {datum.value === null ? "—" : format(datum.value)}
      </p>
      {datum.caption !== undefined ? (
        <p className="mt-0.5 text-muted-foreground">{datum.caption}</p>
      ) : null}
      {/*
        The comparison, stated rather than left to the eye. "7h 20m" is a fact;
        "40m under the rostered shift" is the fact somebody acts on, and it is
        subtraction of two numbers the caller already supplied — no aggregate, no
        average of its own.
      */}
      {reference !== undefined && datum.value !== null ? (
        <p className="num mt-0.5 text-muted-foreground">
          {datum.value === reference.value
            ? reference.label
            : `${format(Math.abs(datum.value - reference.value))} ${datum.value > reference.value ? "over" : "under"}`}
        </p>
      ) : null}
    </div>
  );
}

export function TrendBars({
  bars,
  title,
  format = (v) => String(v),
  height = 120,
  className,
  showAxis = false,
  reference,
}: TrendBarsProps) {
  const titleId = useId();

  /*
    A null becomes a zero-height bar rather than a missing datum: recharts drops
    an absent point and silently shifts every label after it, so the axis would
    stop matching the days. The Cell below paints it as nothing.
  */
  const data: Datum[] = bars.map((bar) => ({ ...bar, plotted: bar.value ?? 0 }));

  return (
    <figure className={cn("w-full", className)} aria-labelledby={titleId}>
      <figcaption id={titleId} className="sr-only">
        {title}
      </figcaption>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: showAxis ? 0 : -28 }}>
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          />
          <YAxis
            hide={!showAxis}
            tickLine={false}
            axisLine={false}
            width={36}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }}
            content={<ChartTooltip format={format} reference={reference} />}
          />
          {reference !== undefined ? (
            <ReferenceLine
              y={reference.value}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="4 4"
              strokeOpacity={0.7}
              label={{
                value: reference.label,
                position: "insideTopRight",
                fontSize: 9,
                fill: "hsl(var(--muted-foreground))",
              }}
            />
          ) : null}
          <Bar dataKey="plotted" radius={[3, 3, 0, 0]} {...animationProps()}>
            {data.map((datum) => (
              <Cell
                key={datum.key}
                /* A missing record is transparent — a gap, not a short bar. */
                fill={datum.value === null ? "transparent" : CHART_TONE[datum.tone]}
                className="transition-opacity hover:opacity-80"
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
