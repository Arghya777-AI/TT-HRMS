/**
 * liveness.test.ts — guards the one claim `measureLiveness` makes: the number it
 * produces is a MEASUREMENT, so it must be able to fail.
 *
 * The test that matters most is the first one. If a refactor ever makes a still
 * image score above `attendance.liveness_pass_threshold` (0.70), this heuristic
 * has become the fabricated constant the module header refuses to be, and the
 * value written to `secure.face_match_log.liveness_score` stops meaning anything.
 */
import { describe, expect, it } from "vitest";
import { measureLiveness, LIVENESS_MODEL } from "./liveness";
import { DESCRIPTOR_LENGTH } from "./faceConsistency";

/** The server's gate, restated here so the tests assert against the real line. */
const SERVER_PASS_THRESHOLD = 0.7;

function descriptor(seed: number, drift = 0): number[] {
  const values = new Array<number>(DESCRIPTOR_LENGTH);
  for (let i = 0; i < DESCRIPTOR_LENGTH; i++) {
    values[i] = Math.sin(seed + i) * 0.05;
  }
  // A single-coordinate perturbation of `drift` gives a Euclidean distance of
  // exactly `drift` from the undrifted vector — so the knees can be tested.
  values[0] = (values[0] ?? 0) + drift;
  return values;
}

function frame(drift: number, pose: number, offset: number) {
  return {
    descriptor: descriptor(1, drift),
    yaw: pose,
    pitch: pose / 2,
    roll: pose / 3,
    box: { x: 0.3 + offset, y: 0.2 + offset, w: 0.4, h: 0.5 },
  };
}

describe("measureLiveness", () => {
  it("scores a still image far below the server's pass threshold", () => {
    // Identical frames: what a photo on a stand or an injected image produces.
    const still = [frame(0, 0, 0), frame(0, 0, 0), frame(0, 0, 0)];
    const signal = measureLiveness(still);
    expect(signal.score).toBe(0);
    expect(signal.score).toBeLessThan(SERVER_PASS_THRESHOLD);
    expect(signal.model).toBe(LIVENESS_MODEL);
    expect(signal.framesAnalysed).toBe(3);
  });

  it("scores sensor-noise-only movement below the threshold too", () => {
    // A photograph on a tripod: the detector jitters, the subject does not move.
    const noisy = [frame(0, 0, 0), frame(0.008, 0.04, 0.0001), frame(0.004, 0.02, 0.0002)];
    expect(measureLiveness(noisy).score).toBeLessThan(SERVER_PASS_THRESHOLD);
  });

  it("scores an ordinary living face at or above the threshold", () => {
    // Movement in the range faceConsistency documents for one steady face.
    const live = [frame(0, 0, 0), frame(0.09, 1.4, 0.004), frame(0.17, 2.6, 0.009)];
    expect(measureLiveness(live).score).toBeGreaterThanOrEqual(SERVER_PASS_THRESHOLD);
  });

  it("refuses to score fewer than two frames rather than guessing", () => {
    expect(measureLiveness([]).score).toBe(0);
    expect(measureLiveness([frame(0, 0, 0)]).score).toBe(0);
  });

  it("returns 0 for a malformed reading instead of a partial number", () => {
    const broken = [{ ...frame(0, 0, 0), descriptor: [1, 2, 3] }, frame(0.1, 1, 0.004)];
    expect(measureLiveness(broken).score).toBe(0);
  });

  it("never exceeds 1, however violent the movement", () => {
    const wild = [frame(0, 0, 0), frame(0.9, 40, 0.4), frame(1.4, 80, 0.2)];
    const signal = measureLiveness(wild);
    expect(signal.score).toBeLessThanOrEqual(1);
    expect(signal.score).toBeGreaterThan(SERVER_PASS_THRESHOLD);
  });
});
