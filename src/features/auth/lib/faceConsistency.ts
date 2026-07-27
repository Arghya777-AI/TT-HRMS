/**
 * faceConsistency.ts — the multi-frame gate in front of face sign-in.
 *
 * ONE frame is not evidence of anything: it is a photograph, and a photograph
 * can be held up to a camera. So the login screen collects several readings from
 * `features/kiosk/lib/facePipeline.ts` (the same pipeline the gate kiosk uses —
 * there is exactly one face pipeline in this app) and refuses to send anything
 * until a window of consecutive readings agrees with itself.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. Agreement across frames proves the frames
 * are of one steady face, which is what stops a half-detected passer-by, a
 * hand-off between two people, and a wobble mid-blink from being submitted as
 * "you". It is NOT liveness detection, and this file does not pretend to be:
 * that is exactly why the screen says on it, in words, that face is a
 * convenience factor weaker than a password or a passkey. The authoritative
 * match is the server's, against the enrolled template.
 *
 * Descriptors arriving here are already L2-normalised by the pipeline, so the
 * Euclidean distance below is on the same scale face-api's own threshold (0.6
 * for "same person") is quoted on. The window bound is tighter than that,
 * because these frames are half a second apart, not months apart.
 */

/** face_recognition_v1 descriptors are 128-D. A different length is a bug, not a face. */
export const DESCRIPTOR_LENGTH = 128;

/** Readings that must agree before anything is sent. */
export const FACE_MIN_FRAMES = 3;

/**
 * Upper bound on the Euclidean distance between any two descriptors in the
 * window. Consecutive frames of one still face sit around 0.05–0.25; the
 * same-person identity threshold is 0.6. 0.40 accepts normal micro-movement and
 * rejects a second face or a mid-motion smear.
 */
export const FACE_MAX_PAIRWISE_DISTANCE = 0.4;

/** How many frames we are prepared to score before giving up on the attempt. */
export const FACE_MAX_SCORED_FRAMES = 40;

/** True when the vector is a usable 128-D descriptor of finite numbers. */
export function isUsableDescriptor(descriptor: readonly number[]): boolean {
  if (descriptor.length !== DESCRIPTOR_LENGTH) return false;
  return descriptor.every((value) => Number.isFinite(value));
}

/**
 * Euclidean distance. Returns `Infinity` for anything unusable, so a malformed
 * reading can only ever fail the consistency check — never pass it by accident.
 */
export function descriptorDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined || bv === undefined) return Number.POSITIVE_INFINITY;
    const d = av - bv;
    sum += d * d;
  }
  const distance = Math.sqrt(sum);
  return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
}

export interface ConsistencyVerdict {
  /** Enough frames, all mutually close. */
  consistent: boolean;
  /** The largest pairwise distance in the window — what the UI reports. */
  worstDistance: number;
}

/**
 * Judge a window of descriptors. Fewer than `FACE_MIN_FRAMES` is "not yet",
 * reported as `consistent: false` with `worstDistance: Infinity`.
 */
export function checkConsistency(
  descriptors: readonly (readonly number[])[],
  maxDistance: number = FACE_MAX_PAIRWISE_DISTANCE,
): ConsistencyVerdict {
  if (descriptors.length < FACE_MIN_FRAMES) {
    return { consistent: false, worstDistance: Number.POSITIVE_INFINITY };
  }
  let worst = 0;
  for (let i = 0; i < descriptors.length; i++) {
    const a = descriptors[i];
    if (a === undefined || !isUsableDescriptor(a)) {
      return { consistent: false, worstDistance: Number.POSITIVE_INFINITY };
    }
    for (let j = i + 1; j < descriptors.length; j++) {
      const b = descriptors[j];
      if (b === undefined) return { consistent: false, worstDistance: Number.POSITIVE_INFINITY };
      const distance = descriptorDistance(a, b);
      if (distance > worst) worst = distance;
    }
  }
  return { consistent: worst <= maxDistance, worstDistance: worst };
}

/**
 * Which reading in the agreeing window to send.
 *
 * The BEST-SCORING single frame, not an average of the window. The server
 * validates a genuine single-frame descriptor (`|‖d‖−1| ≤ 0.02` and a 1:N match
 * against enrolled templates tuned on single frames), and that is exactly what
 * the kiosk and the enrolment console send. Averaging would put a vector on the
 * wire that no camera ever produced, and would quietly shift the distance
 * distribution the server's threshold was set against. The window's job is to
 * decide WHETHER to send; this picks the cleanest evidence from it.
 */
export function bestFrameIndex(scores: readonly number[]): number {
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    if (score !== undefined && score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
