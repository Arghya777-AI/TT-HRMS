/**
 * The gate that decides whether a face reading is ever sent. It has to fail
 * closed: every malformed, short, or disagreeing window must be refused, because
 * the only thing standing between a half-detected passer-by and an opened session
 * is this function returning false.
 */
import { describe, expect, it } from "vitest";
import {
  bestFrameIndex,
  checkConsistency,
  descriptorDistance,
  DESCRIPTOR_LENGTH,
  FACE_MAX_PAIRWISE_DISTANCE,
  FACE_MIN_FRAMES,
  isUsableDescriptor,
} from "./faceConsistency";

/** A deterministic unit-length 128-D vector, `seed` steering its direction. */
function descriptor(seed: number, jitter = 0): number[] {
  const raw = Array.from(
    { length: DESCRIPTOR_LENGTH },
    (_unused, i) => Math.sin((i + 1) * (seed + 1) * 0.37) + jitter * Math.cos(i * 1.7),
  );
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map((v) => v / norm);
}

describe("isUsableDescriptor", () => {
  it("accepts a 128-D vector of finite numbers", () => {
    expect(isUsableDescriptor(descriptor(1))).toBe(true);
  });

  it("rejects a wrong length", () => {
    expect(isUsableDescriptor(descriptor(1).slice(0, 127))).toBe(false);
    expect(isUsableDescriptor([...descriptor(1), 0])).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    const withNaN = descriptor(1);
    withNaN[7] = Number.NaN;
    expect(isUsableDescriptor(withNaN)).toBe(false);

    const withInfinity = descriptor(1);
    withInfinity[7] = Number.POSITIVE_INFINITY;
    expect(isUsableDescriptor(withInfinity)).toBe(false);
  });
});

describe("descriptorDistance", () => {
  it("is zero for identical vectors", () => {
    expect(descriptorDistance(descriptor(3), descriptor(3))).toBeCloseTo(0, 12);
  });

  it("grows with divergence", () => {
    const near = descriptorDistance(descriptor(3), descriptor(3, 0.05));
    const far = descriptorDistance(descriptor(3), descriptor(9));
    expect(near).toBeLessThan(far);
  });

  it("is Infinity — never a small number — for mismatched or empty input", () => {
    expect(descriptorDistance(descriptor(1), descriptor(1).slice(0, 64))).toBe(Number.POSITIVE_INFINITY);
    expect(descriptorDistance([], [])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("checkConsistency", () => {
  it("refuses a window that is not full yet", () => {
    const window = Array.from({ length: FACE_MIN_FRAMES - 1 }, () => descriptor(4));
    expect(checkConsistency(window).consistent).toBe(false);
  });

  it("accepts one steady face across a full window", () => {
    const window = [descriptor(4), descriptor(4, 0.01), descriptor(4, 0.02)];
    const verdict = checkConsistency(window);
    expect(verdict.consistent).toBe(true);
    expect(verdict.worstDistance).toBeLessThanOrEqual(FACE_MAX_PAIRWISE_DISTANCE);
  });

  it("refuses a window where one frame is a different face", () => {
    const window = [descriptor(4), descriptor(4, 0.01), descriptor(21)];
    expect(checkConsistency(window).consistent).toBe(false);
  });

  it("refuses a window containing a malformed descriptor", () => {
    const broken = descriptor(4);
    broken[0] = Number.NaN;
    expect(checkConsistency([descriptor(4), descriptor(4, 0.01), broken]).consistent).toBe(false);
  });

  it("reports the WORST pair, not the average", () => {
    const verdict = checkConsistency([descriptor(4), descriptor(4, 0.02), descriptor(4, 0.06)]);
    const worstPair = descriptorDistance(descriptor(4), descriptor(4, 0.06));
    expect(verdict.worstDistance).toBeCloseTo(worstPair, 12);
  });
});

describe("bestFrameIndex", () => {
  it("picks the highest detection score", () => {
    expect(bestFrameIndex([0.71, 0.94, 0.88])).toBe(1);
  });

  it("is stable on ties and safe on an empty list", () => {
    expect(bestFrameIndex([0.8, 0.8])).toBe(0);
    expect(bestFrameIndex([])).toBe(0);
  });
});
