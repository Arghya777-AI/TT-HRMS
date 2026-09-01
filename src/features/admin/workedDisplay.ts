/**
 * workedDisplay.ts — which number goes in the Worked column, and what it means.
 *
 * ── WHY THIS IS A PURE FUNCTION AND NOT A BRANCH INSIDE THE CELL ─────────────
 * The rule got three things wrong in a row, each of them a plausible-looking number on a
 * dashboard somebody makes decisions from:
 *
 *   1. `row.attended ? worked : "—"` hid 88 real minutes because the engine had — correctly —
 *      called an 88-minute day `absent`. The shortest day on the board was the one with no
 *      number on it.
 *   2. A bare "0h 00m" for everybody who had scanned in and not out. `total_worked_minutes`
 *      counts COMPLETED intervals, so 0 is right and useless beside the word "Present".
 *   3. A day with BOTH scans and no credited minutes fell past every branch and printed a dash,
 *      with the in-time and out-time sitting on the same row.
 *
 * Three wrong answers to one question is a sign the question deserves its own tested function.
 * Asserting on the four outcomes beats grepping the component for the shape of an `if`.
 *
 * ── THE THREE NUMBERS ARE NOT INTERCHANGEABLE ────────────────────────────────
 * `credited` is the engine's paid figure, with the shift's unpaid break already subtracted.
 * `running` and `span` are wall-clock between scans, with nothing subtracted, so they run ahead
 * of the paid figure by exactly that break. Each carries its own kind so the caller is forced to
 * caption them differently — one label for all three would make the numbers look like they
 * contradicted each other.
 */
import { elapsedOnSite, type Elapsed } from "./liveWorked";

export type WorkedDisplay =
  /** The engine's paid minutes. `alsoOnSite` is set when they are still here after an out-scan. */
  | { readonly kind: "credited"; readonly minutes: number; readonly alsoOnSite: Elapsed | null }
  /** Still on site: wall-clock since the first scan, ticking. */
  | { readonly kind: "running"; readonly elapsed: Elapsed }
  /** Both scans present, engine credits nothing. The span is real; the credit is not. */
  | { readonly kind: "span"; readonly elapsed: Elapsed }
  /** No scan at all. */
  | { readonly kind: "none" };

export interface WorkedInput {
  readonly workedMinutes: number;
  readonly firstInAt: string | null;
  readonly lastOutAt: string | null;
  readonly nowMs: number;
}

export function workedDisplay(input: WorkedInput): WorkedDisplay {
  const elapsed = elapsedOnSite({
    firstInAt: input.firstInAt,
    lastOutAt: input.lastOutAt,
    nowMs: input.nowMs,
    // The roster is today by construction — `fetchTodayRoster` reads the today board.
    isLive: true,
  });

  if (input.workedMinutes > 0) {
    return {
      kind: "credited",
      minutes: input.workedMinutes,
      alsoOnSite: elapsed.running ? elapsed : null,
    };
  }
  if (elapsed.running) return { kind: "running", elapsed };
  if (elapsed.totalSeconds > 0) return { kind: "span", elapsed };
  return { kind: "none" };
}
