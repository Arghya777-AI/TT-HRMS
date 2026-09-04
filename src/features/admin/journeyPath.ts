/**
 * Turning a day's location pings into a drawable route.
 *
 * Its own module because both decisions here are judgements about evidence rather than
 * drawing code, and both are worth testing directly:
 *
 *   · a fix too coarse to place anybody is never part of a route;
 *   · a long silence is not a straight line, because the app was shut and nobody knows.
 */
import { COARSE_ABOVE_M, type LocationPing } from "./api/locationTrail.api";

/** A gap longer than this is drawn dashed: the app was closed and the route is unknown. */
export const GAP_MINUTES = 15;

export interface Fix {
  readonly at: string;
  readonly lat: number;
  readonly lng: number;
  readonly accuracy: number | null;
  readonly distance: number | null;
  /** Too coarse to place anybody: shown on the map, never joined into the path. */
  readonly coarse: boolean;
  readonly offline: boolean;
}

const num = (v: number | string | null): number | null => {
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The plottable fixes, in the order they were taken.
 *
 * A ping with only one half of a coordinate is dropped rather than defaulted: `Number(null)`
 * is 0, and 0 is a real latitude — off the coast of Africa.
 */
export function toFixes(pings: readonly LocationPing[]): Fix[] {
  const out: Fix[] = [];
  for (const p of pings) {
    const lat = num(p.lat);
    const lng = num(p.lng);
    if (lat === null || lng === null) continue;
    const accuracy = num(p.accuracy_m);
    out.push({
      at: p.captured_at,
      lat,
      lng,
      accuracy,
      distance: num(p.distance_m),
      coarse: accuracy !== null && accuracy > COARSE_ABOVE_M,
      offline: p.captured_offline,
    });
  }
  return out;
}

/**
 * The path, split wherever the trail went quiet.
 *
 * Each run is a stretch of fixes close enough in time to join with a solid line. Between
 * runs the app was closed: the caller draws those links dashed, because a straight line
 * across an hour of silence is a guess and must not look like a walk.
 */
export function pathRuns(fixes: readonly Fix[], gapMinutes = GAP_MINUTES): Fix[][] {
  const runs: Fix[][] = [];
  let run: Fix[] = [];
  let prev: number | null = null;
  for (const f of fixes) {
    if (f.coarse) continue; // places nobody — never part of a route
    const ms = new Date(f.at).getTime();
    if (prev !== null && ms - prev > gapMinutes * 60_000) {
      if (run.length > 0) runs.push(run);
      run = [];
    }
    run.push(f);
    prev = ms;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * How far apart the two furthest fixes are, against the worst accuracy among them.
 *
 * The figure that decides whether a route means anything. At this venue a real day gave a
 * 60 m spread from readings accurate to ±35 m — so the "journey" is inside the error of a
 * single reading, and the map has to let a reader see that rather than assert movement.
 */
export function spreadIsWithinError(fixes: readonly Fix[]): boolean {
  const usable = fixes.filter((f) => !f.coarse);
  if (usable.length < 2) return true;
  let worst = 0;
  for (const f of usable) worst = Math.max(worst, f.accuracy ?? 0);
  if (worst === 0) return false;
  let spread = 0;
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i];
      const b = usable[j];
      if (a === undefined || b === undefined) continue;
      spread = Math.max(spread, metresBetween(a, b));
    }
  }
  // Two readings each good to ±worst can sit 2×worst apart with nobody having moved.
  return spread <= worst * 2;
}

/** Equirectangular metres — exact enough at the scale of one venue. */
function metresBetween(a: Fix, b: Fix): number {
  const latMid = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (b.lat - a.lat) * 111_320;
  const dLng = (b.lng - a.lng) * 111_320 * Math.cos(latMid);
  return Math.hypot(dLat, dLng);
}
