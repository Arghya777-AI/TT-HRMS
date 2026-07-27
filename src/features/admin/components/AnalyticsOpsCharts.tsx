/**
 * AnalyticsOpsCharts.tsx — the three chart forms the operational analytics
 * screens need, and nothing else.
 *
 * WHY THESE THREE, AND WHY CAPPED AT FOUR SERIES
 * ----------------------------------------------
 * The series palette, the four-series ceiling and the reasoning behind both live
 * in `../analytics-ops-palette` — short version: the brand's chart tokens are a
 * muted heritage set whose declared order puts two indistinguishable hues first,
 * so the order is re-chosen for colour-vision separation and stops at four.
 * A fifth series is refused rather than generated; pages filter instead.
 *
 * Beyond colour:
 *   * Lines carry a dash pattern as SECONDARY ENCODING — identity is never
 *     colour alone.
 *   * Every chart ships a real `<table>` fallback in a `<details>`, so the
 *     numbers are readable without colour vision, without CSS, and on print.
 *
 * WHAT THESE CHARTS WILL NOT DO
 * -----------------------------
 *   * No dual axis, ever. Two measures of different scale are two charts.
 *   * No client arithmetic. Every plotted value is a server column handed in by
 *     the page; a stacked bar's HEIGHT is the visual sum of segments that are
 *     each their own server column, and the caption says so.
 *   * A missing value is a GAP (null), never a zero — `connectNulls` is off.
 */
import { useMemo, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import {
  CHART_GRID as GRID,
  CHART_SURFACE as SURFACE,
  MAX_SERIES,
  SERIES_DASH,
  seriesColour,
} from "../analytics-ops-palette";

const AXIS_TICK = { fontSize: 12 } as const;

export interface ChartSeries {
  /** Stable identity — the server column name. Colour binds to this. */
  readonly key: string;
  readonly label: string;
}

export interface ChartPoint {
  /** Category label, ALREADY formatted by @/lib/datetime. */
  readonly x: string;
  /** series key → server value. `null` renders a gap, never a zero. */
  readonly values: Readonly<Record<string, number | null>>;
}

export type ValueFormatter = (value: number | null) => string;

function toRows(
  points: readonly ChartPoint[],
  series: readonly ChartSeries[],
): Record<string, string | number | null>[] {
  return points.map((p) => {
    const row: Record<string, string | number | null> = { x: p.x };
    for (const s of series) row[s.key] = p.values[s.key] ?? null;
    return row;
  });
}

// -----------------------------------------------------------------------------
// Legend + table fallback + figure frame
// -----------------------------------------------------------------------------

function Legend({ series }: { series: readonly ChartSeries[] }) {
  // One series needs no legend box — the figure's own heading names it.
  if (series.length < 2) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
      {series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ background: seriesColour(i) }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function DataTable({
  series,
  points,
  format,
  xHeader,
}: {
  series: readonly ChartSeries[];
  points: readonly ChartPoint[];
  format: ValueFormatter;
  xHeader: string;
}) {
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        {t("admin.achart.showTable")}
      </summary>
      <div className="mt-2 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{xHeader}</TableHead>
              {series.map((s) => (
                <TableHead key={s.key} className="text-right">
                  {s.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((p) => (
              <TableRow key={p.x}>
                <TableCell className="font-medium">{p.x}</TableCell>
                {series.map((s) => (
                  <TableCell key={s.key} className="num text-right">
                    {p.values[s.key] == null ? dash(null) : format(p.values[s.key] ?? null)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}

interface FigureProps {
  title: string;
  caption: string;
  series: readonly ChartSeries[];
  points: readonly ChartPoint[];
  format: ValueFormatter;
  xHeader: string;
  children: ReactNode;
  className?: string;
}

function ChartFigure({
  title,
  caption,
  series,
  points,
  format,
  xHeader,
  children,
  className,
}: FigureProps) {
  return (
    <figure className={cn("m-0", className)}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {/* Wide plots scroll inside their own container; the page never does. */}
      <div className="mt-2 overflow-x-auto">
        <div className="h-64 min-w-[520px]">{children}</div>
      </div>
      <Legend series={series} />
      <figcaption className="mt-2 text-xs text-muted-foreground">{caption}</figcaption>
      <DataTable series={series} points={points} format={format} xHeader={xHeader} />
    </figure>
  );
}

/** Shared tooltip body — reads OUR point, never a recharts-reshaped payload. */
function TooltipCard({
  point,
  series,
  format,
}: {
  point: ChartPoint;
  series: readonly ChartSeries[];
  format: ValueFormatter;
}) {
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm shadow-md">
      <p className="font-medium">{point.x}</p>
      <dl className="mt-1 space-y-0.5">
        {series.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-sm"
              style={{ background: seriesColour(i) }}
            />
            <dt className="text-xs text-muted-foreground">{s.label}</dt>
            <dd className="num ml-auto text-xs">
              {point.values[s.key] == null ? dash(null) : format(point.values[s.key] ?? null)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// -----------------------------------------------------------------------------
// 1. Stacked bars over time
// -----------------------------------------------------------------------------

export interface StackedBarsProps {
  title: string;
  caption: string;
  /** Stacking order, bottom first. At most MAX_SERIES entries. */
  series: readonly ChartSeries[];
  points: readonly ChartPoint[];
  format: ValueFormatter;
  /** Axis-tick formatter; defaults to `format`. */
  tickFormat?: ValueFormatter;
  xHeader: string;
  yWidth?: number;
}

/**
 * Stacked bars. Each segment is one server column; the bar's total height is the
 * visual sum of exactly the segments drawn, which the caption must state. A 2px
 * surface stroke separates segments so adjacent fills never read as one block.
 */
export function StackedBarsChart({
  title,
  caption,
  series,
  points,
  format,
  tickFormat,
  xHeader,
  yWidth = 92,
}: StackedBarsProps) {
  // Sliced inside a memo: a fresh array identity every render would defeat the
  // memoised row/lookup build below.
  const drawn = useMemo(() => series.slice(0, MAX_SERIES), [series]);
  const rows = useMemo(() => toRows(points, drawn), [points, drawn]);
  const byX = useMemo(() => new Map(points.map((p) => [p.x, p])), [points]);
  const ticks = tickFormat ?? format;

  return (
    <ChartFigure
      title={title}
      caption={caption}
      series={drawn}
      points={points}
      format={format}
      xHeader={xHeader}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 12, right: 16, bottom: 4, left: 8 }} accessibilityLayer>
          <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="x"
            tick={AXIS_TICK}
            stroke={GRID}
            tickLine={false}
            interval="preserveStartEnd"
            className="fill-muted-foreground"
          />
          <YAxis
            tickFormatter={(value: number) => ticks(value)}
            width={yWidth}
            tick={AXIS_TICK}
            stroke={GRID}
            tickLine={false}
            className="fill-muted-foreground"
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))", fillOpacity: 0.35 }}
            content={({ active, label }) => {
              if (active !== true) return null;
              const point = byX.get(String(label));
              if (point === undefined) return null;
              return <TooltipCard point={point} series={drawn} format={format} />;
            }}
          />
          {drawn.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="total"
              fill={seriesColour(i)}
              stroke={SURFACE}
              strokeWidth={2}
              maxBarSize={44}
              isAnimationActive={false}
              {...(i === drawn.length - 1 ? { radius: [4, 4, 0, 0] as [number, number, number, number] } : {})}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

// -----------------------------------------------------------------------------
// 2. Multi-line over time
// -----------------------------------------------------------------------------

export interface TrendLinesProps {
  title: string;
  caption: string;
  series: readonly ChartSeries[];
  points: readonly ChartPoint[];
  format: ValueFormatter;
  tickFormat?: ValueFormatter;
  xHeader: string;
  yWidth?: number;
  /** Fix the Y domain top, e.g. 100 for a percentage. */
  yMax?: number;
}

export function TrendLinesChart({
  title,
  caption,
  series,
  points,
  format,
  tickFormat,
  xHeader,
  yWidth = 64,
  yMax,
}: TrendLinesProps) {
  // Sliced inside a memo: a fresh array identity every render would defeat the
  // memoised row/lookup build below.
  const drawn = useMemo(() => series.slice(0, MAX_SERIES), [series]);
  const rows = useMemo(() => toRows(points, drawn), [points, drawn]);
  const byX = useMemo(() => new Map(points.map((p) => [p.x, p])), [points]);
  const ticks = tickFormat ?? format;

  return (
    <ChartFigure
      title={title}
      caption={caption}
      series={drawn}
      points={points}
      format={format}
      xHeader={xHeader}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 12, right: 16, bottom: 4, left: 8 }} accessibilityLayer>
          <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="x"
            tick={AXIS_TICK}
            stroke={GRID}
            tickLine={false}
            minTickGap={24}
            className="fill-muted-foreground"
          />
          <YAxis
            tickFormatter={(value: number) => ticks(value)}
            width={yWidth}
            tick={AXIS_TICK}
            stroke={GRID}
            tickLine={false}
            domain={yMax === undefined ? [0, "auto"] : [0, yMax]}
            className="fill-muted-foreground"
          />
          <Tooltip
            cursor={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1 }}
            content={({ active, label }) => {
              if (active !== true) return null;
              const point = byX.get(String(label));
              if (point === undefined) return null;
              return <TooltipCard point={point} series={drawn} format={format} />;
            }}
          />
          {drawn.map((s, i) => {
            const colour = seriesColour(i);
            return (
              <Line
                key={s.key}
                type="linear"
                dataKey={s.key}
                name={s.label}
                stroke={colour}
                strokeWidth={2}
                strokeDasharray={SERIES_DASH[i] ?? "0"}
                dot={{ r: 3, fill: colour, stroke: SURFACE, strokeWidth: 2 }}
                activeDot={{ r: 5, fill: colour, stroke: SURFACE, strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

// -----------------------------------------------------------------------------
// 3. Ranked horizontal bars — one series, one server column
// -----------------------------------------------------------------------------

export interface RankedBarsProps {
  title: string;
  caption: string;
  /** The one measure. A single series needs no legend. */
  measure: ChartSeries;
  /** Already ordered by the server read; this component does not re-rank. */
  points: readonly ChartPoint[];
  format: ValueFormatter;
  tickFormat?: ValueFormatter;
  xHeader: string;
  labelWidth?: number;
}

/**
 * Horizontal bars for a categorical comparison (cost by department, count by
 * status). Values arrive already ordered from the server read — ordering here
 * would make the picture depend on the page's own sort state.
 */
export function RankedBarsChart({
  title,
  caption,
  measure,
  points,
  format,
  tickFormat,
  xHeader,
  labelWidth = 168,
}: RankedBarsProps) {
  const series = useMemo(() => [measure], [measure]);
  const rows = useMemo(() => toRows(points, series), [points, series]);
  const byX = useMemo(() => new Map(points.map((p) => [p.x, p])), [points]);
  const ticks = tickFormat ?? format;
  // 28px a bar plus padding — a ranked chart grows downwards, it does not squash.
  const height = Math.max(160, points.length * 34 + 32);

  return (
    <figure className="m-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-2 overflow-x-auto">
        <div className="min-w-[520px]" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
              accessibilityLayer
            >
              <CartesianGrid stroke={GRID} strokeWidth={1} horizontal={false} />
              <XAxis
                type="number"
                tickFormatter={(value: number) => ticks(value)}
                tick={AXIS_TICK}
                stroke={GRID}
                tickLine={false}
                className="fill-muted-foreground"
              />
              <YAxis
                type="category"
                dataKey="x"
                width={labelWidth}
                tick={AXIS_TICK}
                stroke={GRID}
                tickLine={false}
                className="fill-muted-foreground"
              />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted))", fillOpacity: 0.35 }}
                content={({ active, label }) => {
                  if (active !== true) return null;
                  const point = byX.get(String(label));
                  if (point === undefined) return null;
                  return <TooltipCard point={point} series={series} format={format} />;
                }}
              />
              <Bar
                dataKey={measure.key}
                name={measure.label}
                fill={seriesColour(0)}
                radius={[0, 4, 4, 0]}
                maxBarSize={22}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <figcaption className="mt-2 text-xs text-muted-foreground">{caption}</figcaption>
      <DataTable series={series} points={points} format={format} xHeader={xHeader} />
    </figure>
  );
}
