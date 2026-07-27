/**
 * liveness.ts — the ONE number this build can honestly put in
 * `metrics.livenessScore`, and an exact statement of what it is worth.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * `supabase/functions/face-login/index.ts` REQUIRES `metrics.livenessScore` and
 * refuses below `attendance.liveness_pass_threshold` (0.70). The value is written
 * to `secure.face_match_log.liveness_score` and read as forensic evidence, and
 * the model name travels on the audit-chain row (`auth.face.verified` →
 * `liveness_model`). Two things follow, and they are the whole design:
 *
 *   1. A CONSTANT WOULD BE A FABRICATION. Sending 0.9 because 0.9 passes would
 *      write a made-up security measurement into an evidence table. That is not
 *      a shortcut, it is forging the record, so it is not done here.
 *   2. WHAT IS SENT MUST BE MEASURED. Everything below is computed from frames
 *      this device actually captured, and a still picture scores ~0 — the number
 *      can and does fail.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS MEASURED (all three from data the pipeline already produces)
 * ─────────────────────────────────────────────────────────────────────────────
 * Over the window of accepted readings, between CONSECUTIVE frames (~500 ms
 * apart), the mean of:
 *
 *   descriptorMotion  Euclidean distance between the two 128-D descriptors.
 *                     `features/auth/lib/faceConsistency.ts` documents the
 *                     observed live range for one steady face as 0.05–0.25 (and
 *                     0.6 is face-api's own "different person" line). Identical
 *                     input pixels give a bit-identical descriptor: distance 0.
 *   poseMotion        Mean absolute change in the landmark-derived yaw/pitch/roll
 *                     from `facePipeline.poseFromLandmarks`, in degrees. A living
 *                     head never holds still to a tenth of a degree; a static
 *                     image is 0 exactly.
 *   framingMotion     Mean change in the face box's centre and size, as a
 *                     fraction of the frame. Breathing alone moves this.
 *
 * Each is mapped through a documented "knee" — the value at which that signal
 * counts as fully present — and combined 0.5 / 0.3 / 0.2, descriptor motion
 * weighted highest because it is the only one of the three that cannot be
 * produced by the detector jittering on a fixed image.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DEFENDS AGAINST, AND WHAT IT DOES NOT — read this before trusting it
 * ─────────────────────────────────────────────────────────────────────────────
 * DEFENDS: a still image presented as a live face — a photo taped to a stand, a
 * screenshot, an image injected through a virtual camera, a frozen stream. Those
 * produce near-zero change on all three signals and score far below the 0.70 the
 * server demands.
 *
 * DOES NOT DEFEND, and the UI says so in as many words:
 *   · A PHOTOGRAPH HELD IN A HAND. It moves, so it scores like a face. This is
 *     the attack the file header of `face-login` names, and this signal does not
 *     stop it.
 *   · A video replay of the employee, or a screen showing one.
 *   · A MODIFIED CLIENT. Every number here is client-reported; `face-login`'s
 *     header states plainly that these are not a security boundary — the
 *     boundary is the 1:1 identity requirement, the refusal of privileged
 *     accounts, and the audit trail.
 *
 * HONEST LIMIT OF THE CALIBRATION: the three knees are read off the distance
 * scales documented in this repo (faceConsistency's 0.05–0.25 live range, the
 * pipeline's own gates), NOT off a measured ROC curve on this hardware. It is a
 * v1 heuristic, named as one, and it is why the screen keeps calling face sign-in
 * a convenience factor. This is NOT spec-kiosk §1.2's weighted six-signal passive
 * liveness model; when that lands it replaces this file and takes a new name.
 */
import { descriptorDistance, isUsableDescriptor } from "./faceConsistency";

/**
 * Reported to the server as `metrics.livenessModel` and recorded on the audit
 * row. It names a heuristic, not a model, deliberately: a reader of the audit
 * must not think an ML liveness estimator ran.
 */
export const LIVENESS_MODEL = "frame-motion-heuristic-v1";

/** Mean consecutive descriptor distance at which that signal counts as full. */
export const DESCRIPTOR_MOTION_KNEE = 0.06;
/** Mean consecutive pose change, in degrees, at which that signal counts as full. */
export const POSE_MOTION_KNEE = 0.5;
/** Mean consecutive box movement, as a fraction of the frame, counted as full. */
export const FRAMING_MOTION_KNEE = 0.002;

const WEIGHT_DESCRIPTOR = 0.5;
const WEIGHT_POSE = 0.3;
const WEIGHT_FRAMING = 0.2;

/** Below two frames there is no "between frames", so there is nothing to measure. */
const MIN_FRAMES_FOR_MOTION = 2;

/** One accepted reading, reduced to the fields the motion signal reads. */
export interface LivenessFrame {
  /** L2-normalised 128-D descriptor, straight from the pipeline. */
  readonly descriptor: readonly number[];
  /** Degrees, from `facePipeline`'s landmark pose estimate. */
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** Face box as a fraction of the frame (0–1), from the same reading. */
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export interface LivenessSignal {
  /** 0–1, three decimals. Sent as `metrics.livenessScore`; the server gates it. */
  readonly score: number;
  /** Sent as `metrics.livenessModel` so the audit row names what produced it. */
  readonly model: typeof LIVENESS_MODEL;
  /** Frames the score was computed over — sent as `metrics.framesAnalysed`. */
  readonly framesAnalysed: number;
  /** The three sub-signals, for the ceremony UI and for debugging. Never sent. */
  readonly parts: {
    readonly descriptorMotion: number;
    readonly poseMotion: number;
    readonly framingMotion: number;
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Mean of a list, or 0 for an empty one — never NaN. */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) return 0;
    sum += value;
  }
  return sum / values.length;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const ZERO: LivenessSignal = {
  score: 0,
  model: LIVENESS_MODEL,
  framesAnalysed: 0,
  parts: { descriptorMotion: 0, poseMotion: 0, framingMotion: 0 },
};

/**
 * Measure the window. Returns a score of 0 — never a guess — when there is not
 * enough to measure or a reading is malformed: the server then refuses, which is
 * the correct outcome for "this device could not tell".
 */
export function measureLiveness(frames: readonly LivenessFrame[]): LivenessSignal {
  if (frames.length < MIN_FRAMES_FOR_MOTION) return { ...ZERO, framesAnalysed: frames.length };

  const descriptorSteps: number[] = [];
  const poseSteps: number[] = [];
  const framingSteps: number[] = [];

  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1];
    const current = frames[i];
    if (previous === undefined || current === undefined) return { ...ZERO, framesAnalysed: frames.length };
    if (!isUsableDescriptor(previous.descriptor) || !isUsableDescriptor(current.descriptor)) {
      return { ...ZERO, framesAnalysed: frames.length };
    }

    const distance = descriptorDistance(previous.descriptor, current.descriptor);
    if (!Number.isFinite(distance)) return { ...ZERO, framesAnalysed: frames.length };
    descriptorSteps.push(distance);

    poseSteps.push(
      (Math.abs(current.yaw - previous.yaw) +
        Math.abs(current.pitch - previous.pitch) +
        Math.abs(current.roll - previous.roll)) /
        3,
    );

    // Centre movement plus size change: a face that leans in changes the box
    // dimensions without moving its centre much, and both are movement.
    const previousCentreX = previous.box.x + previous.box.w / 2;
    const previousCentreY = previous.box.y + previous.box.h / 2;
    const currentCentreX = current.box.x + current.box.w / 2;
    const currentCentreY = current.box.y + current.box.h / 2;
    framingSteps.push(
      Math.abs(currentCentreX - previousCentreX) +
        Math.abs(currentCentreY - previousCentreY) +
        Math.abs(current.box.w - previous.box.w) +
        Math.abs(current.box.h - previous.box.h),
    );
  }

  const descriptorMotion = mean(descriptorSteps);
  const poseMotion = mean(poseSteps);
  const framingMotion = mean(framingSteps);

  const score =
    WEIGHT_DESCRIPTOR * clamp01(descriptorMotion / DESCRIPTOR_MOTION_KNEE) +
    WEIGHT_POSE * clamp01(poseMotion / POSE_MOTION_KNEE) +
    WEIGHT_FRAMING * clamp01(framingMotion / FRAMING_MOTION_KNEE);

  return {
    score: round3(clamp01(score)),
    model: LIVENESS_MODEL,
    framesAnalysed: frames.length,
    parts: {
      descriptorMotion: round3(descriptorMotion),
      poseMotion: round3(poseMotion),
      framingMotion: round3(framingMotion),
    },
  };
}
