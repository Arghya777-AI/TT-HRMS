/**
 * localMatch.ts — the 1:N the gate runs on itself when it cannot reach the server.
 *
 * ── IT MIRRORS `kiosk-punch`, DELIBERATELY AND EXACTLY ───────────────────────
 * Euclidean distance over L2-normalised 128-D descriptors; best sample per PERSON, not per
 * template; confidence as `1 - distance / 2`; accept only when confidence clears the bar AND
 * the runner-up is at least a margin away.
 *
 * Every one of those choices is copied from the server rather than reinvented, and the margin
 * rule is the one most worth stating: ranking SAMPLES instead of people would fill the top
 * places with one face, make the runner-up that same person again, and collapse the margin to
 * nearly nothing — so every honest scan would be refused as ambiguous. The server learned that;
 * this must not have to learn it again.
 *
 * ── WHAT IT IS ALLOWED TO DECIDE ─────────────────────────────────────────────
 * A name on a screen and a row in the on-screen log. Nothing else. The punch still travels with
 * its descriptor and `kiosk-punch` re-matches against live templates when the queue drains, so
 * a stale bundle can be briefly wrong on a display and can never be wrong on the record.
 *
 * ── WHY IT REFUSES RATHER THAN GUESSES ───────────────────────────────────────
 * An offline gate is exactly where a wrong name does the most damage: nobody is watching, the
 * person walks off satisfied, and the mistake is only discovered when the queue drains and the
 * server names somebody else. "Not sure" is a better thing to show than a confident error.
 */
import type { BundlePerson, FaceBundle } from "./faceBundle";

/**
 * Largest possible distance between two unit vectors, and the divisor that turns a distance
 * into a confidence. Two opposed unit vectors are 2 apart. Must equal the server's.
 */
const MAX_UNIT_DISTANCE = 2;

/** `kiosk-punch`'s DEFAULT_MIN_CONFIDENCE. Kept in step by `localMatch.test.ts`. */
export const DEFAULT_MIN_CONFIDENCE = 0.62;

/** `kiosk-punch`'s DEFAULT_MIN_MARGIN. */
export const DEFAULT_MIN_MARGIN = 0.06;

export function confidenceFor(distance: number): number {
  return 1 - distance / MAX_UNIT_DISTANCE;
}

export type LocalMatch =
  | {
    kind: "matched";
    employeeId: string;
    employeeCode: string;
    displayName: string;
    confidence: number;
    /** Distance to the runner-up minus distance to the winner. */
    margin: number;
  }
  /** Nobody was close enough to name. */
  | { kind: "no_match"; bestConfidence: number | null }
  /** Two people were too close together to separate. */
  | { kind: "ambiguous"; margin: number }
  /** No usable bundle: never fetched, empty, or past its expiry. */
  | { kind: "unavailable" };

/**
 * Squared distance, and the `limit` is what makes this fast enough.
 *
 * The loop abandons a candidate the moment it is already further away than the best so far —
 * so most of the 365 comparisons stop after a handful of the 128 dimensions. Squared, because
 * `sqrt` is monotonic: comparing squares orders candidates identically and the root is taken
 * once at the end rather than 365 times.
 */
function squaredDistance(a: Float32Array, b: readonly number[], limit: number): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i]! - b[i]!;
    total += d * d;
    if (total > limit) return total;
  }
  return total;
}

/** The closest sample belonging to one person. */
function bestForPerson(
  person: BundlePerson,
  probe: readonly number[],
  limit: number,
): number {
  let best = Infinity;
  for (const descriptor of person.descriptors) {
    const d = squaredDistance(descriptor, probe, Math.min(limit, best));
    if (d < best) best = d;
  }
  return best;
}

export interface MatchOptions {
  minConfidence?: number;
  minMargin?: number;
  /** Injectable so a test can pin expiry behaviour without touching the clock. */
  now?: number;
}

/**
 * Search the bundle for the probe.
 *
 * `bundleUsable` is not called here — the caller checks it — but an expired or empty bundle
 * still returns `unavailable` rather than searching, so a mistake at the call site fails safe.
 */
export function matchLocally(
  bundle: FaceBundle | null,
  probe: readonly number[],
  options: MatchOptions = {},
): LocalMatch {
  if (bundle === null || bundle.people.length === 0) return { kind: "unavailable" };
  if (probe.length !== bundle.descriptorDim) return { kind: "unavailable" };

  const now = options.now ?? Date.now();
  const expires = Date.parse(bundle.expiresAt);
  // Fails closed on an unparseable expiry: this is the control that bounds how long stale
  // biometric data keeps being honoured.
  if (!Number.isFinite(expires) || now >= expires) return { kind: "unavailable" };

  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;

  let best: { person: BundlePerson; squared: number } | null = null;
  let runnerUp = Infinity;

  for (const person of bundle.people) {
    const squared = bestForPerson(person, probe, best === null ? Infinity : runnerUp);
    if (best === null || squared < best.squared) {
      // The old winner becomes the runner-up; that is what keeps the margin meaningful.
      if (best !== null) runnerUp = best.squared;
      best = { person, squared };
    } else if (squared < runnerUp) {
      runnerUp = squared;
    }
  }

  if (best === null) return { kind: "unavailable" };

  const bestDistance = Math.sqrt(best.squared);
  const confidence = confidenceFor(bestDistance);
  if (confidence < minConfidence) {
    return { kind: "no_match", bestConfidence: confidence };
  }

  const margin = Number.isFinite(runnerUp) ? Math.sqrt(runnerUp) - bestDistance : Infinity;
  if (margin < minMargin) return { kind: "ambiguous", margin };

  return {
    kind: "matched",
    employeeId: best.person.employeeId,
    employeeCode: best.person.employeeCode,
    displayName: best.person.displayName,
    confidence,
    margin,
  };
}
