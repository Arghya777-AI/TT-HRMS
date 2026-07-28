/**
 * analytics-ops-palette.ts — the categorical series palette the operational analytics
 * charts draw from, and the ceiling on how many series may be drawn.
 *
 * It lives in its own module (not beside the chart components) for two reasons: a file
 * that exports both components and constants breaks fast refresh, and the cap is a fact
 * pages need to reason about — the kiosk screen has to know it can only plot four
 * devices before it asks the admin to filter.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THE RE-ORDERING THIS FILE USED TO DO IS GONE, AND THAT IS THE POINT
 *
 * It used to draw slots in the order 3, 1, 6, 4 — a hand-picked detour around a real
 * defect: under the previous terracotta-led scheme, `--chart-1` (#c47a54) and
 * `--chart-2` (#b98946) were ΔE 2.1 apart under deuteranopia, so cycling the tokens in
 * their declared order shipped charts whose first two series read as one colour. The
 * detour was correct then. It is wrong now, because it selects a sequence that was
 * never validated against the NEW palette.
 *
 * The venue-derived palette in `index.css` is built the other way round: slots 1–4 were
 * SEARCHED for and chosen precisely so that the declared order is the safe order. They
 * pass ALL-PAIRS colour-vision separation in both light and dark — not merely adjacent
 * pairs — because a four-series chart draws all four at once and every pair among them
 * has to be tellable apart:
 *
 *     --chart-1  foliage green    --chart-2  water blue
 *     --chart-3  gold             --chart-4  plum
 *
 * So this module now simply takes the first four, in order. No detour to maintain, and
 * one source of truth for what slot 1 means.
 *
 * A FIFTH SERIES IS STILL REFUSED rather than generated. Slots 5–8 exist for donuts and
 * status breakdowns and are validated for adjacent pairs only; adding one to a live
 * four-series chart would break the all-pairs guarantee above. A hue nobody can tell
 * apart is worse than a filter prompt.
 *
 * SECONDARY ENCODING IS NOT OPTIONAL HERE. The worst pair among the four sits in the
 * 6–8 CVD floor band, which the validator permits only alongside a second channel. That
 * channel is `SERIES_DASH` on lines, plus the legend and the table/CSV export every
 * figure carries. Remove those and the palette stops being defensible.
 *
 * Colour binds to a series KEY in the caller's declared order — never to rank — so
 * filtering the set never repaints the survivors.
 */

/**
 * The validated categorical order: the first four tokens, as declared.
 * Index 0 is also the single-series colour — foliage green, the brand's lead.
 */
export const SERIES_COLORS: readonly string[] = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
];

/** Secondary encoding for lines — identity survives greyscale, print and CVD. */
export const SERIES_DASH: readonly string[] = ["0", "6 3", "2 3", "9 3 2 3"];

/** Four is this palette's honest all-pairs ceiling, not a layout preference. */
export const MAX_SERIES = 4;

/** Recessive chrome, straight from the theme tokens. */
export const CHART_GRID = "hsl(var(--border))";
export const CHART_SURFACE = "hsl(var(--card))";

export function seriesColour(index: number): string {
  return SERIES_COLORS[index] ?? SERIES_COLORS[SERIES_COLORS.length - 1] ?? CHART_GRID;
}
