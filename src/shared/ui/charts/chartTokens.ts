/**
 * chartTokens.ts — the colours and motion every chart in the app shares.
 *
 * ── WHY A FILE AND NOT A PALETTE PER CHART ─────────────────────────────────
 *
 * `--chart-1..8` have existed in index.css since the analytics screens were
 * built, and every one of those screens reaches for them directly. That worked
 * while charts lived in one place. Charts are now going onto the employee
 * screens too, and eight strings copied into a dozen files is how "present" ends
 * up green on one page and amber on another.
 *
 * More importantly the SEMANTIC colours must not be chosen per chart. Present is
 * success, absent is destructive, leave is info — those meanings already exist in
 * `StatusChip` and in the day badges on the attendance screens, and a chart that
 * invents its own mapping makes the reader translate between the picture and the
 * table beside it.
 *
 * ── ON MOTION ──────────────────────────────────────────────────────────────
 *
 * One duration, one easing, and both are switched OFF under
 * `prefers-reduced-motion`. index.css already reduces every CSS animation to
 * 0.01ms for those users; recharts animates in JavaScript and never sees that
 * rule, so the preference has to be read here or the app honours it everywhere
 * except the newest thing on the page.
 */

/** The categorical ramp, in the order a multi-series chart should consume it. */
export const CHART_SERIES = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--chart-6))",
  "hsl(var(--chart-7))",
  "hsl(var(--chart-8))",
] as const;

/**
 * Colour by MEANING, matching the chips and badges the same screens render.
 *
 * A bar and the badge beside it describing the same day must be the same colour,
 * or the reader has to hold two mappings at once.
 */
export const CHART_TONE = {
  present: "hsl(var(--success))",
  absent: "hsl(var(--destructive))",
  leave: "hsl(var(--info))",
  holiday: "hsl(var(--chart-4))",
  weeklyOff: "hsl(var(--muted-foreground))",
  late: "hsl(var(--warning))",
  earning: "hsl(var(--success))",
  deduction: "hsl(var(--destructive))",
  employer: "hsl(var(--chart-2))",
  neutral: "hsl(var(--muted-foreground))",
} as const;

export type ChartTone = keyof typeof CHART_TONE;

/** Pick a series colour by index, wrapping rather than running out. */
export function seriesColor(index: number): string {
  return CHART_SERIES[index % CHART_SERIES.length] ?? CHART_SERIES[0];
}

/**
 * Does this person want motion?
 *
 * Read at render rather than cached: somebody can change the system setting
 * without reloading, and a stale answer means the app disagrees with the OS.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Entry animation in ms — 0 when motion is not wanted, which recharts treats as off. */
export function chartAnimationMs(): number {
  return prefersReducedMotion() ? 0 : 550;
}

/** Shared recharts props so every chart animates identically. */
export function animationProps(): {
  isAnimationActive: boolean;
  animationDuration: number;
  animationEasing: "ease-out";
} {
  const ms = chartAnimationMs();
  return { isAnimationActive: ms > 0, animationDuration: ms, animationEasing: "ease-out" };
}
