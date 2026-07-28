/**
 * aiSpec.ts — turning the agent's spec into things a chart library can draw.
 *
 * Non-component exports live here rather than beside the renderer: a file that exports
 * both a component and constants breaks `react-refresh/only-export-components`, the same
 * split as `commandSearch.ts` and `sectionNavModel.ts`.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THE MODEL NAMES A TOKEN, NEVER A COLOUR
 *
 * `series.colour` arrives as `"series-1"`, `"positive"`, `"warning"` — the function's
 * `PALETTE_TOKENS`. It is never a hex, and that is the point: a model that could emit
 * `#ff0000` would be choosing the product's colours, would escape the theme, and would
 * break in dark mode. The mapping from token to CSS variable happens HERE, in code, so
 * the assistant's charts are the same colours as every other chart in the product —
 * including the all-pairs-validated first four (see `index.css`).
 *
 * An unknown token falls back to the muted foreground rather than throwing: a chart with
 * one grey series still communicates, a crashed panel does not.
 */

/** The function's `PALETTE_TOKENS`, mapped onto the theme's validated slots. */
const TOKEN_TO_VAR: Readonly<Record<string, string>> = {
  // The operational quartet, in the order that passes all-pairs CVD separation.
  "series-1": "--chart-1",
  "series-2": "--chart-2",
  "series-3": "--chart-3",
  "series-4": "--chart-4",
  // 5 and 6 come from the extended set, validated for adjacent pairs.
  "series-5": "--chart-5",
  "series-6": "--chart-6",
  // Status tokens are RESERVED and never reused as a series colour — same rule the
  // rest of the product follows.
  positive: "--success",
  negative: "--destructive",
  warning: "--warning",
  neutral: "--muted-foreground",
  muted: "--muted-foreground",
};

/** `series-2` → `hsl(var(--chart-2))`. Unknown tokens degrade to muted. */
export function paletteColour(token: string | null | undefined): string {
  const variable = token === null || token === undefined ? undefined : TOKEN_TO_VAR[token];
  return `hsl(var(${variable ?? "--muted-foreground"}))`;
}

/**
 * The block types this client can draw.
 *
 * Kept as a set so an unrecognised type is a KNOWN unknown: the renderer shows a small
 * "this answer used a panel this screen cannot draw yet" note with the block's title,
 * rather than silently dropping content the model considered part of its answer. The
 * function may add a type at any time without a frontend deploy, so silence would mean
 * a reader loses part of an answer with no indication.
 */
export const RENDERABLE_BLOCKS: ReadonlySet<string> = new Set([
  "kpi_row",
  "gauge_row",
  "stat_callout",
  "line_chart",
  "area",
  "bar_chart",
  "donut",
  "table",
  "list",
  "timeline",
  "comparison",
  "progress_bars",
  "alert",
  "payslip_card",
  "employee_card",
  "calendar_heatmap",
]);

/**
 * The display string for a value, and NOTHING is re-formatted here.
 *
 * The server recomputes `display` from `raw` after the model has spoken, so that a
 * model cannot state a figure that differs from the tool's. Falling back to `String(raw)`
 * only covers a server that omitted `display`; it never re-derives currency, durations
 * or percentages, because doing so would put a second formatter in the product that
 * could disagree with the first.
 */
export function valueText(value: {
  display?: string | undefined;
  raw: number | string | null;
}): string {
  if (typeof value.display === "string" && value.display.length > 0) return value.display;
  if (value.raw === null) return "—";
  return String(value.raw);
}

/** A `kpi_row` item may carry its figure inline or nested under `value`. */
export interface FlexibleItem {
  label: string;
  detail?: string | null | undefined;
  value?: { raw: number | string | null; display?: string | undefined; masked?: boolean } | null;
  raw?: number | string | null | undefined;
  display?: string | undefined;
  masked?: boolean | undefined;
}

/**
 * Read an item's figure from either shape.
 *
 * The function's own examples put `raw`/`format` directly on a `kpi_row` item while
 * `list` and `comparison` items nest them under `value`. Both were observed in a live
 * response, so the renderer handles both rather than betting on one.
 */
export function itemValueText(item: FlexibleItem): string | null {
  if (item.value !== null && item.value !== undefined) return valueText(item.value);
  if (item.raw !== undefined) return valueText({ raw: item.raw, display: item.display });
  return null;
}

/** True when a figure is server-masked, so the UI can mark it rather than imply a number. */
export function itemMasked(item: FlexibleItem): boolean {
  return item.value?.masked === true || item.masked === true;
}

/**
 * Chart points, with gaps preserved as gaps.
 *
 * `y: null` means "no working day", and the function's own prompt says so. It must stay
 * null: coercing it to 0 draws a line to the floor and invents a day somebody worked
 * nothing, which is exactly the misreading the whole analytics layer avoids.
 */
export interface ChartRow {
  x: string;
  [series: string]: string | number | null;
}

export function toChartRows(
  series: readonly { name: string; points: readonly { x: string; y: number | null }[] }[],
): ChartRow[] {
  const byX = new Map<string, ChartRow>();
  for (const s of series) {
    for (const point of s.points) {
      const row = byX.get(point.x) ?? { x: point.x };
      row[s.name] = point.y;
      byX.set(point.x, row);
    }
  }
  // The function emits points in order; Map preserves insertion, so the first series
  // sets the axis order and later ones fill in. No sort — a date-like string sorts
  // lexicographically only by luck, and the server already ordered it.
  return [...byX.values()];
}
