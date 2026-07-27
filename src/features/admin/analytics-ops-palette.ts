/**
 * analytics-ops-palette.ts — the categorical series palette the operational
 * analytics charts draw from, and the ceiling on how many series may be drawn.
 *
 * It lives in its own module (not beside the chart components) for two reasons:
 * a file that exports both components and constants breaks fast refresh, and the
 * cap is a fact pages need to reason about — the kiosk screen has to know it can
 * only plot four devices before it asks the admin to filter.
 *
 * HOW THE ORDER WAS CHOSEN — this is not taste. The brand tokens
 * (`--chart-1 … --chart-8`, index.css) are a muted heritage set, and in their
 * DECLARED order the first two are indistinguishable: terracotta `--chart-1`
 * (#c47a54) and ochre `--chart-2` (#b98946) are ΔE 2.1 apart under deuteranopia
 * and ΔE 4.9 apart under normal vision (OKLab ×100). Cycling through the tokens
 * in order would therefore ship a chart whose first two series read as one.
 *
 * These four, in this order, pass all-pairs colour-vision separation and the 3:1
 * contrast floor against both the light and dark chart surfaces:
 *
 *     --chart-3  indigo      --chart-1  terracotta
 *     --chart-6  teal        --chart-4  mauve
 *
 * A FIFTH series is refused rather than generated. The remaining tokens collide
 * with one of these four, and a hue nobody can name apart is worse than a filter
 * prompt. Charts also carry secondary encoding (dash patterns on lines, a table
 * fallback on every figure) because indigo↔mauve still sits under the
 * normal-vision comfort floor at ΔE 12.8.
 *
 * Colour binds to a series KEY in the caller's declared order — never to rank —
 * so filtering the set never repaints the survivors.
 */

/** The validated categorical order. Index 0 is also the single-series colour. */
export const SERIES_COLORS: readonly string[] = [
  "hsl(var(--chart-3))",
  "hsl(var(--chart-1))",
  "hsl(var(--chart-6))",
  "hsl(var(--chart-4))",
];

/** Secondary encoding for lines — identity survives greyscale and print. */
export const SERIES_DASH: readonly string[] = ["0", "6 3", "2 3", "9 3 2 3"];

/** Four is this palette's honest ceiling, not a layout preference. */
export const MAX_SERIES = 4;

/** Recessive chrome, straight from the theme tokens. */
export const CHART_GRID = "hsl(var(--border))";
export const CHART_SURFACE = "hsl(var(--card))";

export function seriesColour(index: number): string {
  return SERIES_COLORS[index] ?? SERIES_COLORS[SERIES_COLORS.length - 1] ?? CHART_GRID;
}
