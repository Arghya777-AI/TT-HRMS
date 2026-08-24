/**
 * gateScanner.ts — the scan loop, tuned for a queue at a gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE TWO PHASES (this is the whole speed story)
 * ─────────────────────────────────────────────────────────────────────────────
 * Measured on this repo's own weights, tfjs CPU backend, 1280×720 input, p50 of
 * 12 runs (scratchpad benchmark):
 *
 *     tiny_face_detector  inputSize 320 → 270 ms
 *     tiny_face_detector  inputSize 224 → 117 ms
 *     tiny_face_detector  inputSize 160 →  62 ms
 *     face_landmark_68_tiny            →  35 ms
 *     face_recognition (the 128-D)     → 204 ms
 *
 * The kiosk this replaces called `readFrame` on a 650 ms interval, and
 * `readFrame`'s default path runs the detector TWICE (once for the face count,
 * once inside `detectSingleFace`). So every frame — including the thousands with
 * nobody in front of the camera — cost 270 + 270 + 35 + 204 ≈ 780 ms, and frames
 * queued up behind the interval.
 *
 * This loop splits the work by what each phase is for:
 *
 *   PHASE 1 · TRACK (detector only, small input)   ~117 ms
 *     Is there exactly one face, big enough and confident enough to be worth
 *     spending a descriptor on? Nothing else runs. An idle gate costs one
 *     detector pass per frame, so the viewfinder feels live.
 *
 *   PHASE 2 · CAPTURE (one full pipeline pass)     ~510 ms
 *     `readFrame(video, { inputSize: DESCRIPTOR_INPUT_SIZE, singlePass: true })` —
 *     ONE detector pass, landmarks, and the 128-D descriptor from face-api's own
 *     aligned crop. `singlePass` is what makes it one pass instead of two and does
 *     not change the crop, so the descriptor IS the one enrolment produced. The
 *     input size is deliberately NOT the tracking size: that claim above used to
 *     be made while this ran at 224 and enrolment ran at 320, which is precisely
 *     the drift it was asserting could not happen. The pipeline's authoritative
 *     quality gates (score, size, brightness, sharpness) are applied here; phase
 *     1's thresholds only decide whether to spend the money.
 *
 * Compute from face-in-frame to descriptor-on-the-wire is therefore
 * 2 × 117 + 510 ≈ 744 ms (two stable tracking frames, then one capture), against
 * ≈ 2.3 s for the same three frames on the old path. Capturing at 224 would save a
 * further ~150 ms and produce a descriptor no template could be compared against,
 * so it is not on the table. The remaining latency is the round trip to
 * `kiosk-punch`, which does the 1:N in Postgres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE FRAME IN FLIGHT, BY CONSTRUCTION
 * ─────────────────────────────────────────────────────────────────────────────
 * No interval. The loop awaits its own work and then yields briefly, so it can
 * never stack two inferences on one main thread — which is what makes a phone
 * feel broken rather than slow.
 *
 * NOTHING BIOMETRIC LEAVES THIS FILE except the L2-normalised descriptor handed
 * to `onReading`, which `deviceAuth.sendPunch` posts and forgets. No frame is
 * stored, no descriptor is logged, no image is uploaded.
 */
import {
  DESCRIPTOR_INPUT_SIZE,
  loadFaceModels,
  readFrame,
  type FaceReading,
  type FrameVerdict,
} from "./facePipeline";

/**
 * Detector input for PHASE 1 ONLY — the detect-only tracking pass. 224 is
 * measurably 2.3× quicker than 320 and still finds a face that fills a quarter of
 * the frame height, which is what a person standing at a gate does.
 *
 * IT DOES NOT APPLY TO PHASE 2. A tracking frame answers "is somebody there" and
 * is thrown away; the capture frame produces the descriptor that gets compared
 * against an enrolled template, and that one is pinned to
 * `DESCRIPTOR_INPUT_SIZE`. This loop originally used 224 for both, which quietly
 * made every gate descriptor incomparable with the 320 the enrolment desk and the
 * portal produced — see the note on `DESCRIPTOR_INPUT_SIZE`.
 */
export const GATE_TRACK_INPUT_SIZE = 224;

/**
 * Phase-1 thresholds. These MIRROR the pipeline's own UX gates (`MIN_SCORE` 0.6,
 * `MIN_FACE_PX` 120) and are deliberately not authoritative: phase 2 re-applies
 * the real ones, plus brightness and sharpness, on the same frame. Their only job
 * is to decide whether a 204 ms descriptor is worth computing.
 */
const TRACK_MIN_SCORE = 0.6;
const TRACK_MIN_FACE_PX = 120;

/** Consecutive tracking frames before capture. Two kills single-frame ghosts. */
const STABLE_FRAMES = 2;

/** Yield between frames so React can paint and the video can advance. */
const FRAME_GAP_MS = 30;

/**
 * Spacing between the descriptor frames used for liveness, in milliseconds.
 *
 * 500 because that is what the measurement was calibrated at — `LOOP_MS` in
 * `features/auth/components/FaceSignIn.tsx`, which is where the knees in
 * `features/auth/lib/liveness.ts` were derived. Changing this number silently
 * re-scales every one of those knees, so it is not a performance dial.
 */
export const LIVENESS_FRAME_GAP_MS = 500;

/** A result card stays up at least this long, however fast the queue moves. */
export const RESULT_HOLD_MIN_MS = 2_200;
/**
 * …and at most this long. Normally the card clears as soon as the person steps
 * out of frame (that is the "no tap" part); this is the backstop for somebody who
 * stands there reading it.
 */
export const RESULT_HOLD_MAX_MS = 9_000;

/** What the loop is doing right now, for the on-screen prompt. */
export type GateSignal =
  | { kind: "idle" }
  | { kind: "tracking" }
  | { kind: "many_faces" }
  | { kind: "step_closer" }
  | { kind: "guidance"; verdict: FrameVerdict }
  | { kind: "capturing" };

export interface GateLoopOptions {
  /** Read the live element each frame: React may swap it under us. */
  video: () => HTMLVideoElement | null;
  /** `true` while a punch is in flight: the loop does nothing at all. */
  paused: () => boolean;
  /**
   * `false` while a result card is being held: the loop keeps TRACKING (so the
   * screen can tell when the lane is empty again and clear the card by itself,
   * with no tap) but spends no descriptor. Defaults to always capturing.
   */
  capture?: () => boolean;
  /** The loop exits on the next tick when this returns `true`. */
  cancelled: () => boolean;
  /**
   * Detector input square for the TRACKING pass. Defaults to
   * {@link GATE_TRACK_INPUT_SIZE}. The capture pass is not configurable: it is
   * always `DESCRIPTOR_INPUT_SIZE`, because its descriptor has to be comparable
   * with the enrolled template.
   */
  trackInputSize?: number;
  /**
   * How many descriptor frames to capture per approach, for the liveness measurement.
   *
   * 1 (the default) is the original behaviour: one descriptor, ~204 ms, nothing to compare
   * it against. 2 or more makes `measureLiveness` possible, at the cost of another
   * descriptor plus {@link GateLoopOptions.livenessGapMs} of waiting per person.
   *
   * An ATTENDED gate should leave this at 1: the guard standing there is the liveness
   * check, and paying for a second descriptor buys nothing. An UNATTENDED gate needs it,
   * because otherwise a printed photograph registers somebody's attendance.
   */
  livenessFrames?: number;
  /**
   * Spacing between those frames, in milliseconds. Defaults to
   * {@link LIVENESS_FRAME_GAP_MS}.
   *
   * This is a CALIBRATION constant, not a tuning knob. `features/auth/lib/liveness.ts`
   * derived its knees — 0.06 descriptor distance, 0.5° of pose, 0.002 of framing — from
   * frames 500 ms apart in the face sign-in loop. Halve the spacing and a living person
   * moves roughly half as much, lands under the knee, and is rejected as a photograph.
   */
  livenessGapMs?: number;
  onSignal: (signal: GateSignal) => void;
  /**
   * A descriptor is ready. `firstSeenAt` is `performance.now()` of the first
   * tracking frame of THIS approach — the honest start of "face in frame" for the
   * latency the client asked to see. Awaited, so nothing is captured while a
   * punch is in flight.
   */
  onReading: (
    reading: FaceReading,
    firstSeenAt: number,
    /**
     * Every descriptor captured for this approach, oldest first, `reading` last. Length 1
     * unless `livenessFrames` asked for more. Handed over so the screen can measure
     * liveness without the scanner needing to know what liveness is.
     */
    window: readonly FaceReading[],
  ) => Promise<void>;
  /** Reports every frame's compute cost, so the screen can show real numbers. */
  onFrameCost?: (phase: "track" | "capture", ms: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Phase 1: one detector pass. Never throws — a dead camera reads as "nobody". */
type TrackVerdict =
  | { kind: "none" }
  | { kind: "many"; count: number }
  | { kind: "too_small" }
  | { kind: "one" };

/**
 * Runs until `cancelled()`. The caller owns the camera stream and the pause flag;
 * this owns nothing and stores nothing.
 */
export async function runGateLoop(options: GateLoopOptions): Promise<void> {
  const faceapi = await loadFaceModels();
  const detectorOptions = new faceapi.TinyFaceDetectorOptions({
    // Tracking only. Nothing derived from this frame is ever compared or stored.
    inputSize: options.trackInputSize ?? GATE_TRACK_INPUT_SIZE,
    scoreThreshold: 0.4,
  });

  let stable = 0;
  let firstSeenAt: number | null = null;

  const track = async (video: HTMLVideoElement): Promise<TrackVerdict> => {
    if (video.readyState < 2 || video.videoWidth === 0) return { kind: "none" };
    const detections = await faceapi.detectAllFaces(video, detectorOptions);
    if (detections.length === 0) return { kind: "none" };
    if (detections.length > 1) return { kind: "many", count: detections.length };
    const only = detections[0];
    if (only === undefined) return { kind: "none" };
    if (only.score < TRACK_MIN_SCORE) return { kind: "none" };
    const px = Math.min(only.box.width, only.box.height);
    return px < TRACK_MIN_FACE_PX ? { kind: "too_small" } : { kind: "one" };
  };

  while (!options.cancelled()) {
    const video = options.video();
    if (video === null || options.paused()) {
      stable = 0;
      firstSeenAt = null;
      await sleep(FRAME_GAP_MS * 4);
      continue;
    }

    const trackStart = performance.now();
    const verdict = await track(video).catch((): TrackVerdict => ({ kind: "none" }));
    options.onFrameCost?.("track", performance.now() - trackStart);
    if (options.cancelled()) return;

    if (verdict.kind !== "one") {
      stable = 0;
      firstSeenAt = null;
      options.onSignal(
        verdict.kind === "many"
          ? { kind: "many_faces" }
          : verdict.kind === "too_small"
          ? { kind: "step_closer" }
          : { kind: "idle" },
      );
      await sleep(FRAME_GAP_MS);
      continue;
    }

    stable += 1;
    firstSeenAt ??= trackStart;
    if (stable < STABLE_FRAMES) {
      options.onSignal({ kind: "tracking" });
      await sleep(FRAME_GAP_MS);
      continue;
    }
    if (options.capture?.() === false) {
      // A card is on screen. Keep watching (this is how the card knows the lane
      // has cleared) but pay for no descriptor. Stability is held one frame short
      // of capture: the moment the card clears, the next person is scanned on
      // their first good frame, while somebody who simply lingered still needs a
      // fresh confirmed frame rather than being re-sent instantly.
      stable = Math.max(0, STABLE_FRAMES - 1);
      options.onSignal({ kind: "tracking" });
      await sleep(FRAME_GAP_MS);
      continue;
    }
    stable = 0;

    // ── PHASE 2 · capture ─────────────────────────────────────────────────────
    options.onSignal({ kind: "capturing" });
    const captureStart = performance.now();
    // `DESCRIPTOR_INPUT_SIZE`, NOT the tracking size: this frame's descriptor is
    // matched 1:N against templates the enrolment desk produced, and a different
    // detector input would crop the face differently and make the distance
    // meaningless. `singlePass` is where the speed comes from; it does not alter
    // the crop.
    const frame = await readFrame(video, {
      inputSize: DESCRIPTOR_INPUT_SIZE,
      singlePass: true,
    }).catch((): FrameVerdict => ({ kind: "no_face" }));
    options.onFrameCost?.("capture", performance.now() - captureStart);
    if (options.cancelled()) return;

    if (frame.kind !== "ok") {
      // The authoritative gates refused it — say why, and go back to tracking.
      options.onSignal({ kind: "guidance", verdict: frame });
      firstSeenAt = null;
      await sleep(FRAME_GAP_MS);
      continue;
    }

    /*
      ── THE LIVENESS WINDOW ───────────────────────────────────────────────────
      One descriptor cannot be compared with anything, so it cannot prove a living face.
      When the gate is unattended the screen asks for more than one, and they are spaced
      at the interval the measurement was calibrated for — see LIVENESS_FRAME_GAP_MS.

      A frame that fails the authoritative gates mid-window is DROPPED rather than
      abandoning the approach: somebody blinking on the second frame should not have to
      walk away and come back. If too few survive, `measureLiveness` reports 0 and the
      screen refuses — which is the correct outcome for "this device could not tell".
    */
    const wanted = Math.max(1, Math.trunc(options.livenessFrames ?? 1));
    const gapMs = options.livenessGapMs ?? LIVENESS_FRAME_GAP_MS;
    const window: FaceReading[] = [frame.reading];
    /*
      Tracked explicitly rather than read back as `window[window.length - 1]`.
      Under `noUncheckedIndexedAccess` an index is `FaceReading | undefined`, and the
      non-null assertion that would silence it is exactly the kind of "I know better"
      that stops being true when somebody later makes the window skippable.
    */
    let latest: FaceReading = frame.reading;

    for (let n = 1; n < wanted; n += 1) {
      await sleep(gapMs);
      if (options.cancelled()) return;
      const videoNow = options.video();
      if (videoNow === null) break;
      const extraStart = performance.now();
      const extra = await readFrame(videoNow, {
        inputSize: DESCRIPTOR_INPUT_SIZE,
        singlePass: true,
      }).catch((): FrameVerdict => ({ kind: "no_face" }));
      options.onFrameCost?.("capture", performance.now() - extraStart);
      if (options.cancelled()) return;
      if (extra.kind === "ok") {
        window.push(extra.reading);
        latest = extra.reading;
      }
    }

    /*
      The LAST reading is the one that gets matched, not the first.

      It is the freshest, and after a deliberate wait it is also the one taken once the
      person has settled in front of the camera. `window` is handed over whole so the
      screen can measure across all of them.
    */
    await options.onReading(latest, firstSeenAt ?? captureStart, window);
    firstSeenAt = null;
    await sleep(FRAME_GAP_MS);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Latency measurement — real numbers, taken on the device that is running
// ─────────────────────────────────────────────────────────────────────────────

export interface LatencySummary {
  /** Most recent face-in-frame → result-card, milliseconds. */
  lastMs: number | null;
  /** Median over the samples held (at most {@link LATENCY_WINDOW}). */
  medianMs: number | null;
  samples: number;
}

const LATENCY_WINDOW = 20;

/**
 * A tiny rolling median. Deliberately not a store: these numbers are diagnostics
 * for the guard's own screen and are gone on reload.
 */
export class LatencyTracker {
  private readonly samples: number[] = [];

  add(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > LATENCY_WINDOW) this.samples.shift();
  }

  summary(): LatencySummary {
    if (this.samples.length === 0) return { lastMs: null, medianMs: null, samples: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
    return {
      lastMs: Math.round(this.samples[this.samples.length - 1] as number),
      medianMs: Math.round(median),
      samples: this.samples.length,
    };
  }
}
