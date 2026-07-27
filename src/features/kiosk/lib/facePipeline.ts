/**
 * facePipeline.ts — camera → face-api → L2-normalised 128-D descriptor.
 *
 * Bundle rule (architecture D-07): `@vladmandic/face-api` is imported ONLY
 * dynamically from this file, so Vite splits it into the reserved `chunk-face`
 * and its ~6 MB of weights never enter the main app graph. The weights load
 * from `/models/v1/` (tiny_face_detector + face_landmark_68_tiny +
 * face_recognition), copied there at build time.
 *
 * The server re-checks everything that matters — descriptor norm (|‖d‖−1| ≤
 * 0.02), the 1:N match, the threshold — so the client gates are UX, not trust:
 * they exist to reject frames that would waste a round trip (no face, tiny
 * face, two faces, too dark, too blurred).
 */

type FaceApi = typeof import("@vladmandic/face-api");

let faceapiPromise: Promise<FaceApi> | null = null;

/** Load the library and its three nets exactly once. */
export function loadFaceModels(modelBase = "/models/v1"): Promise<FaceApi> {
  faceapiPromise ??= (async () => {
    const faceapi = await import("@vladmandic/face-api");
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(modelBase),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(modelBase),
      faceapi.nets.faceRecognitionNet.loadFromUri(modelBase),
    ]);
    return faceapi;
  })();
  return faceapiPromise;
}

export interface FrameQuality {
  detection_score: number;
  sharpness: number;
  brightness: number;
  contrast: number;
  face_px: number;
  face_fraction: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface FaceReading {
  /** L2-normalised, ready for the wire. */
  descriptor: number[];
  quality: FrameQuality;
  /** Face box relative to the frame, 0–1, for the viewfinder overlay. */
  box: { x: number; y: number; w: number; h: number };
}

/**
 * The shape both detect paths below produce — face-api's
 * `WithFaceDescriptor<WithFaceLandmarks<WithFaceDetection<{}>>>`, written
 * structurally so the single-pass and two-pass results share one judging block
 * without importing the library's types eagerly (which would pull `chunk-face`
 * into the main graph and break bundle rule D-07).
 */
interface FaceResult {
  detection: { box: { x: number; y: number; width: number; height: number }; score: number };
  landmarks: { positions: { x: number; y: number }[] };
  descriptor: Float32Array;
}

export type FrameVerdict =
  | { kind: "no_face" }
  | { kind: "many_faces"; count: number }
  | { kind: "poor"; reason: "too_small" | "too_dark" | "too_blurry" | "low_score"; quality: FrameQuality }
  | { kind: "ok"; reading: FaceReading };

/** The client-side gates. The server's are stricter and authoritative. */
const MIN_SCORE = 0.6;
const MIN_FACE_PX = 120;
const MIN_BRIGHTNESS = 0.18;
const MIN_SHARPNESS = 60;

/**
 * The detector input square this pipeline has always used, and the ONLY value
 * any existing caller gets. Enrolment (`EnrolCapture`) and face sign-in
 * (`FaceSignIn`) call `readFrame(video)` with no options, so they are unchanged.
 */
export const DEFAULT_DETECTOR_INPUT_SIZE = 320;

/**
 * THE detector input size for any frame whose descriptor will be STORED or
 * COMPARED. Every such call site must pass this constant — never a literal.
 *
 * WHY IT HAS TO BE ONE NUMBER
 * ---------------------------
 * `inputSize` changes the detector's bounding box; the box changes face-api's
 * aligned crop; the crop changes the 128-D descriptor. Enrol a face at one size
 * and match it at another and every distance is measured between differently
 * cropped versions of the same head — the person drifts away from their own
 * template and the punch is refused with nothing on screen to explain it.
 *
 * `singlePass` is genuinely descriptor-neutral (same crop, one detector pass
 * instead of two), so speed comes from THERE. `inputSize` is not neutral and is
 * not a speed knob for these paths.
 *
 * This was three different values before it was one: enrolment at 224, the gate
 * loop at 224, and both the portal punch and web face sign-in on the 320 default
 * — so the portal could not reliably match a face the admin's desk had just
 * enrolled.
 *
 * 320 is what the pipeline was written and measured against and what the
 * templates already on the project were produced with, so it is the value to
 * converge on rather than the faster one.
 *
 * A gate loop may still TRACK at a smaller size: a detect-only frame answers "is
 * somebody standing there" and never yields a stored descriptor. Only the capture
 * frame is bound by this.
 */
export const DESCRIPTOR_INPUT_SIZE = DEFAULT_DETECTOR_INPUT_SIZE;

/**
 * Speed knobs for the gate loop, added for the mobile gate scanner. BOTH
 * default to what this file did before they existed, so `readFrame(video)` is
 * byte-for-byte the same call it always was — the descriptor a caller gets back
 * is identical, which is the one thing that must never drift (enrolment and scan
 * have to agree or every distance is meaningless).
 *
 * Measured on this repo's own weights, tfjs CPU backend, 1280×720 input
 * (scratchpad benchmark, 12 runs each, p50):
 *
 *   detector inputSize 320 → 270 ms     landmark68tiny → 35 ms
 *   detector inputSize 224 → 117 ms     descriptor     → 204 ms
 *   detector inputSize 160 →  62 ms
 *
 * So the default path costs 270 + 270 + 35 + 204 ≈ 780 ms per accepted frame:
 * the detector runs TWICE, once in `detectAllFaces` for the face count and again
 * inside `detectSingleFace`. `singlePass` removes the second run.
 */
export interface ReadFrameOptions {
  /**
   * Detector input square. Larger sees smaller faces; smaller is quicker.
   * Defaults to {@link DEFAULT_DETECTOR_INPUT_SIZE} (320).
   *
   * CHANGING THIS CHANGES THE DESCRIPTOR — a different box means a different
   * aligned crop. If the frame's descriptor will be stored or compared, pass
   * {@link DESCRIPTOR_INPUT_SIZE} and nothing else; use `singlePass` for speed.
   * Only detect-only frames (tracking, "is anybody there") may vary this.
   */
  inputSize?: number;
  /**
   * Run the detector ONCE per frame instead of twice, taking the face count,
   * the landmarks and the descriptor from one pass. The descriptor is still
   * computed by face-api's own aligned-crop path (`withFaceDescriptors`), so it
   * is the same number the two-pass path returns for the same face.
   *
   * The one cost: when two faces are in frame, their descriptors are computed
   * before the frame is thrown away as `many_faces`. At a gate that frame is
   * discarded either way and the guard is told "one at a time".
   *
   * Defaults to `false`.
   */
  singlePass?: boolean;
}

function l2Normalise(v: Float32Array): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return Array.from(v, (x) => x / norm);
}

/**
 * Brightness/contrast/sharpness over the face crop. Sharpness is the variance
 * of a 4-neighbour Laplacian over the downscaled luminance — cheap, and enough
 * to reject motion blur.
 */
function cropMetrics(
  video: HTMLVideoElement,
  box: { x: number; y: number; width: number; height: number },
): { brightness: number; contrast: number; sharpness: number } {
  const side = 64;
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) return { brightness: 0.5, contrast: 0.2, sharpness: 100 };
  ctx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, side, side);
  const { data } = ctx.getImageData(0, 0, side, side);

  const lum = new Float32Array(side * side);
  for (let i = 0; i < lum.length; i++) {
    const o = i * 4;
    lum[i] = (0.2126 * (data[o] ?? 0) + 0.7152 * (data[o + 1] ?? 0) + 0.0722 * (data[o + 2] ?? 0)) / 255;
  }
  let mean = 0;
  for (const v of lum) mean += v;
  mean /= lum.length;
  let varSum = 0;
  for (const v of lum) varSum += (v - mean) * (v - mean);
  const std = Math.sqrt(varSum / lum.length);

  let lapVar = 0;
  let lapMean = 0;
  const lap = new Float32Array((side - 2) * (side - 2));
  let k = 0;
  for (let y = 1; y < side - 1; y++) {
    for (let x = 1; x < side - 1; x++) {
      const c = lum[y * side + x] ?? 0;
      const l =
        4 * c -
        (lum[y * side + x - 1] ?? 0) -
        (lum[y * side + x + 1] ?? 0) -
        (lum[(y - 1) * side + x] ?? 0) -
        (lum[(y + 1) * side + x] ?? 0);
      lap[k++] = l;
      lapMean += l;
    }
  }
  lapMean /= lap.length;
  for (const v of lap) lapVar += (v - lapMean) * (v - lapMean);
  lapVar /= lap.length;

  // Scale into the ranges face-enrol's gates expect (variance × 255² alike).
  return { brightness: mean, contrast: Math.min(1, std), sharpness: lapVar * 255 * 255 };
}

/** Rough pose from the 68 landmarks — enough for enrolment prompts. */
function poseFromLandmarks(pts: { x: number; y: number }[], boxW: number): {
  yaw: number;
  pitch: number;
  roll: number;
} {
  const p = (i: number) => pts[i] ?? { x: 0, y: 0 };
  const leftEye = p(36);
  const rightEye = p(45);
  const nose = p(30);
  const chin = p(8);
  const roll = (Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 180) / Math.PI;
  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  const yaw = ((nose.x - eyeMidX) / (boxW || 1)) * 120; // ±: nose off eye-centre
  const eyeMidY = (leftEye.y + rightEye.y) / 2;
  const pitch = (((chin.y - eyeMidY) / (boxW || 1)) - 0.9) * 90; // vs neutral ratio
  return {
    yaw: Math.max(-90, Math.min(90, yaw)),
    pitch: Math.max(-90, Math.min(90, pitch)),
    roll: Math.max(-90, Math.min(90, roll)),
  };
}

/** Detect + judge ONE frame. Never throws; a dead camera reads as no_face. */
export async function readFrame(
  video: HTMLVideoElement,
  opts: ReadFrameOptions = {},
): Promise<FrameVerdict> {
  if (video.readyState < 2 || video.videoWidth === 0) return { kind: "no_face" };
  const faceapi = await loadFaceModels();

  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: opts.inputSize ?? DEFAULT_DETECTOR_INPUT_SIZE,
    scoreThreshold: 0.4,
  });

  let single: FaceResult | undefined;
  if (opts.singlePass === true) {
    // ONE detector pass: count, landmarks and descriptors all come out of it.
    const results = await faceapi.detectAllFaces(video, options)
      .withFaceLandmarks(true)
      .withFaceDescriptors();
    if (results.length === 0) return { kind: "no_face" };
    if (results.length > 1) return { kind: "many_faces", count: results.length };
    single = results[0];
  } else {
    const all = await faceapi.detectAllFaces(video, options);
    if (all.length === 0) return { kind: "no_face" };
    if (all.length > 1) return { kind: "many_faces", count: all.length };

    single = await faceapi
      .detectSingleFace(video, options)
      .withFaceLandmarks(true)
      .withFaceDescriptor();
  }
  if (single === undefined) return { kind: "no_face" };

  const det = single.detection;
  const box = det.box;
  const metrics = cropMetrics(video, box);
  const pose = poseFromLandmarks(single.landmarks.positions, box.width);
  const quality: FrameQuality = {
    detection_score: det.score,
    sharpness: Math.min(100_000, Math.max(0, metrics.sharpness)),
    brightness: metrics.brightness,
    contrast: metrics.contrast,
    face_px: Math.max(1, Math.round(Math.min(box.width, box.height))),
    face_fraction: Math.min(
      1,
      (box.width * box.height) / (video.videoWidth * video.videoHeight || 1),
    ),
    yaw: pose.yaw,
    pitch: pose.pitch,
    roll: pose.roll,
  };

  if (det.score < MIN_SCORE) return { kind: "poor", reason: "low_score", quality };
  if (quality.face_px < MIN_FACE_PX) return { kind: "poor", reason: "too_small", quality };
  if (quality.brightness < MIN_BRIGHTNESS) return { kind: "poor", reason: "too_dark", quality };
  if (quality.sharpness < MIN_SHARPNESS) return { kind: "poor", reason: "too_blurry", quality };

  return {
    kind: "ok",
    reading: {
      descriptor: l2Normalise(single.descriptor),
      quality,
      box: {
        x: box.x / (video.videoWidth || 1),
        y: box.y / (video.videoHeight || 1),
        w: box.width / (video.videoWidth || 1),
        h: box.height / (video.videoHeight || 1),
      },
    },
  };
}
