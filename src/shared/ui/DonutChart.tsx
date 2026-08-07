import { useId, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";

/**
 * DonutChart — the one composition-of-a-whole ring (spec-employee §3.7, DR-30).
 *
 * Why hand-rolled SVG rather than Recharts: the ring needs a 2px surface gap
 * between segments, a keyboard-reachable legend that doubles as the filter
 * control, and an exact `role="img"` + hidden-`<table>` fallback. All three are
 * fights against a charting library and ~40 kB of it; none of them is a fight
 * against 60 lines of SVG. Recharts stays reserved for the time-series charts
 * where the axis machinery actually earns its bundle (frontend-contract §9).
 *
 * Arithmetic note: this component normalises the slice values it is handed into
 * percentages of their own total. That is presentation — a ring that does not
 * sum to 100% is not a ring. It never re-derives a business number: every
 * `value` must arrive from a named server column, and the caller keeps showing
 * those raw counts next to the ring (frontend-contract §5).
 */

export interface DonutSlice {
  /** Stable identity. Colour is bound to THIS, never to the slice's position. */
  key: string;
  label: string;
  /** Server-provided count. Fractions (half-days, 0.5 leave) are fine. */
  value: number;
  /** Any CSS colour — pass a token expression, e.g. `hsl(var(--success))`. */
  color: string;
  /**
   * Overlay a 45° hatch. Reserved for an "unknown / not processed" bucket, so
   * it reads as different-in-kind rather than just another hue — and stays
   * legible under CVD, print and forced-colours.
   */
  texture?: boolean;
  /**
   * The colour's NAME, shown after the label as "Absent (red)".
   *
   * A swatch tells you which row goes with which arc only while you can see the
   * difference between the arcs. Naming the colour does three things a swatch cannot: it
   * survives a black-and-white print, it gives somebody a word to say out loud when they
   * point at the chart in a meeting, and it lets a screen reader convey which slice is
   * meant. It is redundant on purpose — the swatch, the label and the name all carry it.
   */
  colourName?: string;
}

export interface DonutChartProps {
  slices: readonly DonutSlice[];
  /** Big figure inside the ring — e.g. elapsed days. Already formatted. */
  centreValue: string;
  /** One line under it, e.g. 'of 31 days'. */
  centreCaption: string;
  /** Accessible name of the figure; also the visible heading if `heading`. */
  title: string;
  /** Render `title` as a visible heading above the ring. */
  heading?: boolean;
  /** Column header for the value column of the fallback table. */
  valueHeader?: string;
  /** Currently selected slice key, for a controlled selection. */
  activeKey?: string | null;
  /** Selecting a slice; called with null when the selection is cleared. */
  onSelect?: (key: string | null) => void;
  /** Extra content under the legend (a "clear filter" button, a note…). */
  footer?: ReactNode;
  className?: string;
}

/** viewBox geometry: outer radius 100, inner 68 → innerRadius 68% exactly. */
const BOX = 240;
const CENTRE = BOX / 2;
const RING_RADIUS = 84;
const RING_WIDTH = 32;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Surface gap between adjacent segments, in user units (§ marks-and-anatomy). */
const SEGMENT_GAP = 3;

export interface DonutPercent {
  key: string;
  /** One decimal place; the set is guaranteed to sum to exactly 100.0. */
  percent: number;
}

/**
 * Largest-remainder (Hare–Niemeyer) apportionment to one decimal place.
 *
 * Rounding each share independently is what produces a legend reading
 * 28.0 + 0.0 + 28.0 + 4.0 + 0.0 + 40.0 = 100.0 on one month and 99.9 on the
 * next. Apportioning tenths-of-a-percent instead makes the total exact by
 * construction, and the tenths land on the slices with the largest discarded
 * fractions rather than on whichever slice happens to be last.
 */
export function largestRemainderPercents(
  values: readonly number[],
): number[] {
  const total = values.reduce((sum, v) => sum + (v > 0 ? v : 0), 0);
  if (total <= 0) return values.map(() => 0);

  const tenths = values.map((v) => ((v > 0 ? v : 0) / total) * 1000);
  const floors = tenths.map((x) => Math.floor(x));
  const assigned = floors.reduce((sum, v) => sum + v, 0);
  let spare = 1000 - assigned;

  const byRemainder = tenths
    .map((x, index) => ({ index, remainder: x - Math.floor(x) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (const item of byRemainder) {
    if (spare <= 0) break;
    const current = floors[item.index];
    if (current === undefined) continue;
    floors[item.index] = current + 1;
    spare -= 1;
  }
  return floors.map((tenth) => tenth / 10);
}

export function DonutChart({
  slices,
  centreValue,
  centreCaption,
  title,
  heading = false,
  valueHeader,
  activeKey = null,
  onSelect,
  footer,
  className,
}: DonutChartProps) {
  const baseId = useId();
  const tableId = `${baseId}-table`;
  const hatchId = `${baseId}-hatch`;
  const [hovered, setHovered] = useState<string | null>(null);

  const percents = useMemo(
    () => largestRemainderPercents(slices.map((s) => s.value)),
    [slices],
  );

  const total = slices.reduce((sum, s) => sum + (s.value > 0 ? s.value : 0), 0);
  const drawable = slices
    .map((slice, index) => ({ slice, percent: percents[index] ?? 0 }))
    .filter((entry) => entry.slice.value > 0);

  // Segment offsets accumulate clockwise from 12 o'clock.
  let cursor = 0;
  const segments = drawable.map(({ slice, percent }) => {
    const length = (percent / 100) * CIRCUMFERENCE;
    const start = cursor;
    cursor += length;
    return { slice, percent, start, length };
  });

  const dimmed = (key: string): boolean => {
    const focus = hovered ?? activeKey;
    return focus !== null && focus !== key;
  };

  function toggle(key: string): void {
    if (!onSelect) return;
    onSelect(activeKey === key ? null : key);
  }

  return (
    /*
      ── WHY THIS ROW IS ALLOWED TO WRAP ────────────────────────────────────────
      The donut used to be pinned at `sm:w-[240px] shrink-0` beside a `flex-1` legend, on the
      reasoning that `sm:` means "wide enough for two columns". It does not: the breakpoint
      measures the VIEWPORT, and this component is dropped into a `lg:grid-cols-3` cell, so on a
      desktop it lives in a third of the width. Measured with the real stylesheet at a 1400px
      container, the card came out 456px, the donut ate 240 of it, and the legend label was left
      21px wide — every status name truncated to nothing, and the percentage column pressed
      against the card's edge. Narrower than that and it crosses the border.

      `flex-wrap` plus a real minimum on the legend fixes it at every width without a media
      query: while the two fit side by side they stay side by side, and the moment they do not
      the legend drops to its own full-width line instead of crushing itself. The donut also
      comes down to 200px, which is still legible and buys the labels 40px.
    */
    <div className={cn("flex flex-col gap-5 sm:flex-row sm:flex-wrap sm:items-center", className)}>
      <figure className="m-0 mx-auto w-full max-w-[240px] shrink-0 sm:mx-0 sm:w-[200px]">
        {heading ? (
          <figcaption className="mb-2 text-sm font-medium text-muted-foreground">{title}</figcaption>
        ) : null}
        <div className="relative aspect-square">
          <svg
            viewBox={`0 0 ${BOX} ${BOX}`}
            className="h-full w-full -rotate-90"
            role="img"
            aria-label={title}
            aria-describedby={tableId}
          >
            <defs>
              <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="hsl(var(--muted))" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="hsl(var(--muted-foreground))" strokeWidth="2" />
              </pattern>
            </defs>

            {/* Track — also the whole ring when the period has no data at all. */}
            <circle
              cx={CENTRE}
              cy={CENTRE}
              r={RING_RADIUS}
              fill="none"
              stroke="hsl(var(--muted))"
              strokeWidth={RING_WIDTH}
            />

            {segments.map(({ slice, start, length }) => {
              const visible = Math.max(0, length - SEGMENT_GAP);
              return (
                <circle
                  key={slice.key}
                  cx={CENTRE}
                  cy={CENTRE}
                  r={RING_RADIUS}
                  fill="none"
                  stroke={slice.texture === true ? `url(#${hatchId})` : slice.color}
                  strokeWidth={RING_WIDTH}
                  strokeDasharray={`${visible} ${CIRCUMFERENCE - visible}`}
                  strokeDashoffset={-start}
                  className={cn(
                    "transition-opacity duration-150",
                    onSelect ? "cursor-pointer" : undefined,
                    dimmed(slice.key) ? "opacity-25" : "opacity-100",
                  )}
                  onMouseEnter={() => setHovered(slice.key)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={onSelect ? () => toggle(slice.key) : undefined}
                />
              );
            })}
          </svg>

          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
            <div>
              <p className="num font-display text-3xl font-semibold leading-none">{centreValue}</p>
              <p className="mt-1 text-xs text-muted-foreground">{centreCaption}</p>
            </div>
          </div>
        </div>
      </figure>

      {/* `min-w-[15rem]` is what triggers the wrap: below it the flex line cannot hold both,
          so the legend takes its own row rather than squeezing the labels to nothing. */}
      <div className="min-w-[15rem] flex-1">
        <ul className="space-y-1">
          {slices.map((slice, index) => {
            const percent = percents[index] ?? 0;
            const selected = activeKey === slice.key;
            return (
              <li key={slice.key}>
                <button
                  type="button"
                  disabled={!onSelect}
                  aria-pressed={onSelect ? selected : undefined}
                  onClick={() => toggle(slice.key)}
                  onMouseEnter={() => setHovered(slice.key)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(slice.key)}
                  onBlur={() => setHovered(null)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    onSelect ? "hover:bg-muted/60" : "cursor-default",
                    selected ? "bg-muted" : undefined,
                    dimmed(slice.key) ? "opacity-60" : undefined,
                  )}
                >
                  <span
                    aria-hidden
                    className="h-3 w-3 shrink-0 rounded-sm border border-border"
                    style={
                      slice.texture === true
                        ? {
                            backgroundColor: "hsl(var(--muted))",
                            backgroundImage:
                              "repeating-linear-gradient(45deg, hsl(var(--muted-foreground)) 0 2px, transparent 2px 5px)",
                          }
                        : { backgroundColor: slice.color }
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {slice.label}
                    {slice.colourName === undefined ? null : (
                      <span className="ml-1 text-muted-foreground">({slice.colourName})</span>
                    )}
                  </span>
                  <span className="num shrink-0 font-medium">{formatCount(slice.value)}</span>
                  <span className="num w-[3.25rem] shrink-0 text-right text-muted-foreground">
                    {total > 0 ? `${percent.toFixed(1)}%` : t("common.empty")}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {footer ? <div className="mt-2 px-2">{footer}</div> : null}
      </div>

      {/* Accessible fallback: the same series as a real table, for screen
          readers, print and anyone who cannot separate the hues. */}
      <table id={tableId} className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{t("common.label")}</th>
            <th scope="col">{valueHeader ?? t("common.value")}</th>
            <th scope="col">{t("common.share")}</th>
          </tr>
        </thead>
        <tbody>
          {slices.map((slice, index) => (
            <tr key={slice.key}>
              <th scope="row">{slice.label}</th>
              <td>{formatCount(slice.value)}</td>
              <td>{total > 0 ? `${(percents[index] ?? 0).toFixed(1)}%` : t("common.empty")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Whole days as '7', halves as '7.5' — never '7.00'. */
function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
