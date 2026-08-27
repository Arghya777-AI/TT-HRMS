/**
 * face-enrol — catalogue #5, auth models **U+** (`biometric.enrol`) or **D + admin-gated
 * operator session** (kiosk Enrolment Mode, spec-kiosk §2 M1 / screen K12).
 *
 * Builds a face template for one employee out of 5–8 supervised captures and parks it
 * as PENDING APPROVAL. Nothing here makes a face matchable: activation is a second,
 * separate human act in `face-template-admin` (which is also what sets
 * `employees.face_enrolled_at`). That split is the whole point — an enrolment is a
 * biometric processing event under the DPDP Act 2023, and it gets four gates:
 *
 *   1. CONSENT   an un-withdrawn `secure.biometric_consents` row for the CURRENT
 *                notice version, modality face/both, purpose attendance_identification.
 *   2. QUALITY   per-sample gates from spec-kiosk §1.1 (enrol column) — detection
 *                score ≥ 0.60 first — then a template quality ≥ 0.70 computed
 *                SERVER-SIDE from the reported metrics (never taken from the client).
 *   3. COHESION  max pairwise distance across the accepted samples ≤ 0.35 (the
 *                `secure.face_templates.intra_sample_max_distance` contract), with a
 *                0.30 `low_cohesion` warning band from spec-kiosk §2.
 *   4. IDENTITY  anti-cross-enrolment duplicate scan against every other employee's
 *                templates: ≤ 0.32 refuses, ≤ 0.42 writes + raises a system_health alert.
 *
 * WHY A SAMPLE SET AND NOT A MEAN. The reference repo averaged 5 descriptors into one
 * vector. An arithmetic mean of L2-normalised embeddings is off the unit sphere and is
 * not a face anybody has: it drags the stored point toward whatever the worst frame
 * was, and it destroys the evidence needed to re-derive templates after a model
 * upgrade. So every accepted sample is stored as its own `secure.face_templates` row,
 * all sharing one `version`, `sample_count`, `consent_id` and `intra_sample_max_distance`.
 * The row nominated as the matchable one is the **medoid** — the real captured sample
 * with the smallest total distance to its siblings — and it is the row recorded in
 * `public.face_enrolment_requests.resulting_template_id`.
 *
 * `uq_face_templates__employee_active` (one active row per employee) is untouched:
 * every row written here is `is_active = false`, so the employee's CURRENT template
 * keeps matching until an admin approves the new one.
 *
 * DB GAP (deliberately not worked around here): `audit.redacted_columns` already
 * registers `secure.face_templates.descriptor_set` as `omit`, but migration 012 never
 * creates that column, and its type is undefined — so the sample set lives in sibling
 * ROWS rather than one column. When a migration adds `descriptor_set`, the set should
 * collapse into the representative row and this loop becomes a single INSERT; the
 * medoid/cohesion maths and every gate above stay exactly as they are.
 *
 * Kiosk hard rule (§6, T-09): on the device path the response says nothing about any
 * other employee — no duplicate identity, no storage paths, never a descriptor.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  conflict,
  forbidden,
  methodNotAllowed,
  notFound,
  ok,
  type ProblemErrorItem,
  problem,
  toProblem,
  unprocessable,
} from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { parseFlexibleInstant } from "../_shared/datetime.ts";
import {
  type AppRole,
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  serviceClient,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import {
  type AuthContext,
  requireCapDb,
  requireCapWithStepUp,
  requireOperatorSession,
  verifyDevice,
  verifyUser,
} from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import {
  claim,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";
import { writeAudit } from "../_shared/audit.ts";

const FN_NAME = "face-enrol";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** Private, service-role-only bucket (migration 039: deliberately no storage policy). */
const CAPTURE_BUCKET = "face-enrolment-captures";

/** Body ceiling: 8 descriptors (~13 KB) + up to 3 base64 JPEGs. */
const MAX_BODY_BYTES = 1_536 * 1024;

/**
 * Descriptor identity. spec-kiosk §1: "must be byte-identical enrolment vs scan or
 * distances are meaningless; server enforces equality". Overridable through
 * `settings.kiosk.descriptor_model` so a model upgrade is a data change plus a
 * re-enrolment campaign, never a silent swap. `kiosk-punch` MUST resolve it the same
 * way and compare against `face_templates.model_version`.
 */
const DEFAULT_DESCRIPTOR_MODEL = "faceapi-rn34-128d-v1";
/** `secure.face_templates.model_name` default (migration 012). */
const MODEL_NAME = "face_recognition_model";
/** `secure.face_templates.detector` default (migration 012); enrol runs 512/0.60. */
const DEFAULT_DETECTOR = "tiny_face_detector@512/0.60";

const DESCRIPTOR_DIM = 128;
/** Descriptors are L2-normalised on-device; anything off the unit sphere is not ours. */
const NORM_TOLERANCE = 0.05;

/** Employment statuses a template may be built for. Enrol happens during onboarding. */
const ENROLLABLE_STATUSES: ReadonlySet<string> = new Set([
  "pre_joining",
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "on_long_leave",
  "rehired",
]);

/** DPDP notice version the consent row must carry (spec-kiosk §2.1). */
const DEFAULT_CONSENT_VERSION = "TT-BIO-NOTICE-v1.0";

/**
 * Enrol-column thresholds from spec-kiosk §1.1 / §2 / §2.1 and the column comments in
 * migration 012. Defaults only — `resolveGates()` lets `public.settings` win.
 */
const GATE_DEFAULTS = {
  minDetectionScore: 0.6,
  minFacePx: 160,
  minFaceFraction: 0.06,
  maxFaceFraction: 0.6,
  minSharpness: 120,
  minBrightness: 0.3,
  maxBrightness: 0.85,
  minContrast: 0.06,
  maxYawDeg: 15,
  /**
   * The turn poses. `maxYawDeg` stays 15 for the three FRONTAL poses; these two are the ones
   * that ask the subject to turn, and refusing them was the defect described at the yaw gate.
   * 35 is where the aligned crop starts to degrade faster than the extra angular coverage is
   * worth; 15 is the floor below which a "turn" adds nothing the frontal sample has not got.
   */
  maxTurnYawDeg: 35,
  /*
    6, not 15, and it is measured as a CHANGE from the subject's own straight-on sample.

    An absolute 15 stalled a live enrolment: this yaw is the nose tip drifting off the eye line,
    scaled by 120, so a genuine 25-degree head turn only moves it about 6 and 45 degrees only
    reaches about 10. Over 380 stored samples the median |yaw| is 1.84, p90 is 7.54, the largest
    ever recorded is 18.4, and only six rows reach 15 at all — it was a standard almost nobody
    could meet, not one almost nobody did.

    6 is the median within-person spread already in the data, so it is a turn people demonstrably
    make. Relative also cancels the per-face bias: one face reads -6 looking dead ahead, another
    +12, and an absolute floor punishes the first and flatters the second.
  */
  minTurnYawDeltaDeg: 6,
  /**
   * 25, not 10, and the reason is the ESTIMATOR not the head.
   *
   * `facePipeline.poseFromLandmarks` computes pitch as
   *     ((chin.y - eyeMidY) / boxWidth - 0.9) * 90
   * where 0.9 is an ASSUMED neutral ratio of chin-to-eye distance over box WIDTH.
   * Real faces run about 0.7–1.0 depending on face shape and how the detector
   * crops, so a subject looking straight at the camera reads anywhere from roughly
   * -18° to +9°. At a 10° limit, enrolment was IMPOSSIBLE for a large share of
   * people: every sample was rejected as "tilted too far" while they sat still and
   * looked straight ahead.
   *
   * Yaw and roll do not have this problem — roll is a true atan2 angle off the eye
   * line and yaw is the nose's offset from the eye midpoint, both of which are zero
   * for a neutral face. Only pitch has a fabricated origin, so only pitch is
   * widened.
   *
   * The descriptor is not left unguarded by this: `cohesionReject` (0.35 intra-
   * sample distance) and `minTemplateQuality` (0.70) still reject a set captured
   * at a genuinely bad angle, and those measure the thing that actually matters —
   * whether the samples agree with each other — rather than a heuristic angle.
   */
  maxPitchDeg: 25,
  maxRollDeg: 15,
  minEar: 0.18,
  minAcceptedSamples: 5,
  minSampleGapMs: 400,
  minSessionSpanMs: 3_500,
  maxSessionSpanMs: 45_000,
  /** `quality_score` floor — migration 012: "enrolment rejected below 0.70". */
  minTemplateQuality: 0.7,
  /** `intra_sample_max_distance` ceiling — migration 012: "> 0.35 = inconsistent capture". */
  cohesionReject: 0.35,
  /** spec-kiosk §2: "> 0.30 flag low_cohesion, redo" — written, but flagged. */
  cohesionWarn: 0.3,
  /** spec-kiosk §2.1 `T_dup_block` / `T_dup_warn`. */
  duplicateBlock: 0.32,
  duplicateWarn: 0.42,
} as const;

type Gates = { -readonly [K in keyof typeof GATE_DEFAULTS]: number };

// ─────────────────────────────────────────────────────────────────────────────
// Request schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every metric the on-device pipeline already computes for its own gates. All are
 * REQUIRED (except `ear`/`liveness_score`): an optional metric is an optional gate,
 * and a client that can skip a gate by omitting a field is not a gate at all.
 */
const SampleMetrics = z
  .object({
    /** `detection.score` from TinyFaceDetector. */
    detection_score: z.number().finite().min(0).max(1),
    /** Variance of Laplacian over the face crop. */
    sharpness: z.number().finite().min(0).max(100_000),
    /** Mean face-crop luminance, 0–1. */
    brightness: z.number().finite().min(0).max(1),
    /** Std-dev luminance, 0–1. */
    contrast: z.number().finite().min(0).max(1),
    /** `min(box.w, box.h)` in pixels. */
    face_px: z.number().int().min(1).max(8_000),
    /** Face box area / frame area. */
    face_fraction: z.number().finite().min(0).max(1),
    yaw: z.number().finite().min(-90).max(90),
    pitch: z.number().finite().min(-90).max(90),
    roll: z.number().finite().min(-90).max(90),
    /** Eye aspect ratio. Gated when present on every sample. */
    ear: z.number().finite().min(0).max(1).optional(),
    /** Passive liveness, informational at enrolment (a supervised capture is live). */
    liveness_score: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

const Capture = z
  .object({
    content_type: z.enum(["image/jpeg", "image/webp"]),
    /** Bare base64 or a `data:` URL. ≤ ~300 KB encoded — 640×640 q80 is ~80 KB. */
    data_base64: z.string().min(64).max(420_000),
  })
  .strict();

const Sample = z
  .object({
    index: z.number().int().min(0).max(31),
    captured_at: common.instant,
    /** L2-normalised 128-D descriptor. Metadata never travels as a descriptor. */
    descriptor: z.array(z.number().finite()).length(DESCRIPTOR_DIM),
    metrics: SampleMetrics,
    pose_prompt: z.enum(["straight", "left", "right", "chin_down", "smile"]).optional(),
    glasses: z.boolean().optional(),
    capture: Capture.optional(),
  })
  .strict();

const EnrolBody = z
  .object({
    employee_id: common.uuid,
    /** Must equal the server's configured descriptor model. */
    descriptor_model: z.string().trim().min(1).max(64),
    detector: z.string().trim().min(1).max(64).optional(),
    /** `attendance.quality_gates` version the client gated against (stamped for forensics). */
    quality_gate_version: z.string().trim().max(40).optional(),
    samples: z.array(Sample).min(5).max(8),
    reason: common.reason.optional(),
    /** Kiosk path only: must equal the signing device. */
    device_id: common.uuid.optional(),
    app_version: common.appVersion.optional(),
  })
  .strict();

type EnrolInput = z.infer<typeof EnrolBody>;
type SampleInput = z.infer<typeof Sample>;

// ─────────────────────────────────────────────────────────────────────────────
// Vector helpers (pure, testable)
// ─────────────────────────────────────────────────────────────────────────────

export function l2Norm(v: readonly number[]): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

export function euclidean(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * The sample with the smallest total distance to its siblings — a real captured face,
 * on the unit sphere, and the most typical of the session. Ties break on the lower
 * index so the choice is deterministic for a given payload.
 */
export function medoidIndex(descriptors: readonly (readonly number[])[]): number {
  let best = 0;
  let bestSum = Number.POSITIVE_INFINITY;
  for (let i = 0; i < descriptors.length; i++) {
    let sum = 0;
    for (let j = 0; j < descriptors.length; j++) {
      if (i !== j) sum += euclidean(descriptors[i] ?? [], descriptors[j] ?? []);
    }
    if (sum < bestSum) {
      bestSum = sum;
      best = i;
    }
  }
  return best;
}

/** Postgres array literal for a `real[]` parameter — unambiguous, no driver type guessing. */
export function pgRealArray(values: readonly number[]): string {
  return `{${values.map((n) => n.toFixed(8)).join(",")}}`;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Half credit at the gate threshold, full credit at the "comfortable" value. */
function aboveThreshold(value: number, threshold: number, comfortable: number): number {
  if (comfortable <= threshold) return value >= threshold ? 1 : 0;
  return 0.5 + 0.5 * clamp01((value - threshold) / (comfortable - threshold));
}

/** Half credit at either end of the band, full credit dead centre. */
function insideBand(value: number, low: number, high: number): number {
  const centre = (low + high) / 2;
  const halfWidth = (high - low) / 2;
  if (halfWidth <= 0) return 0;
  return 1 - 0.5 * clamp01(Math.abs(value - centre) / halfWidth);
}

/**
 * Server-side sample quality in [0,1]. The client's own opinion of quality is never
 * an input — only the raw metrics are, so the number cannot be talked up by a
 * modified build.
 *
 * Calibration: a sample sitting EXACTLY on every enrol threshold scores 0.50, which
 * is below the 0.55 "poor" band of spec-admin §11 and therefore cannot on its own
 * carry a template past the 0.70 `quality_score` floor. Deliberate: the per-sample
 * gates are the floor, the template score is the bar.
 */
export function sampleQuality(
  m: z.infer<typeof SampleMetrics>,
  g: Gates,
  turning = false,
): number {
  const detection = aboveThreshold(m.detection_score, g.minDetectionScore, 0.9);
  const sharpness = aboveThreshold(m.sharpness, g.minSharpness, g.minSharpness + 280);
  const brightness = insideBand(m.brightness, g.minBrightness, g.maxBrightness);
  const contrast = aboveThreshold(m.contrast, g.minContrast, g.minContrast + 0.14);
  const size = aboveThreshold(m.face_px, g.minFacePx, g.minFacePx + 240);
  /*
    A TURN MUST NOT COST QUALITY SCORE. `|yaw| / maxYawDeg` scored a deliberately turned head as
    poor, and the medoid is chosen by score — so even once turns are accepted, the frontal
    samples would win the nomination every time and the turned ones would sit unused. The yaw
    term is therefore measured against whichever ceiling applies to this pose.
  */
  const yawCeilingForScore = turning ? g.maxTurnYawDeg : g.maxYawDeg;
  const pose = 1 - 0.5 * clamp01(Math.max(
    Math.abs(m.yaw) / yawCeilingForScore,
    Math.abs(m.pitch) / g.maxPitchDeg,
    Math.abs(m.roll) / g.maxRollDeg,
  ));
  const score = 0.25 * detection + 0.25 * sharpness + 0.15 * brightness +
    0.1 * contrast + 0.15 * size + 0.1 * pose;
  // numeric(6,4) in the column.
  return Math.round(clamp01(score) * 10_000) / 10_000;
}

/** spec-employee §: the employee is shown a band, never a number. */
export function qualityBand(score: number): "good" | "fair" | "poor" {
  return score >= 0.8 ? "good" : score >= 0.55 ? "fair" : "poor";
}

interface RejectedSample {
  index: number;
  gate: string;
  detail: string;
}

/** Per-sample gates. A failing sample is DROPPED, not fatal, while ≥5 survive. */
function gateSample(
  sample: SampleInput,
  g: Gates,
  /**
   * Yaw of the subject's own straight-on sample from THIS submission, or null when the set has
   * none. The turns are judged as a change from it — see minTurnYawDeltaDeg.
   */
  frontalYaw: number | null = null,
): RejectedSample | null {
  const m = sample.metrics;
  const fail = (gate: string, detail: string): RejectedSample => ({ index: sample.index, gate, detail });

  if (m.detection_score < g.minDetectionScore) {
    return fail("detection_score", `Face detection confidence ${m.detection_score} is below ${g.minDetectionScore}.`);
  }
  if (m.face_px < g.minFacePx) {
    return fail("face_px", `Face is ${m.face_px}px; needs at least ${g.minFacePx}px. Move closer.`);
  }
  if (m.face_fraction < g.minFaceFraction || m.face_fraction > g.maxFaceFraction) {
    return fail("face_fraction", `Face fills ${(m.face_fraction * 100).toFixed(1)}% of the frame; keep it between ${g.minFaceFraction * 100}% and ${g.maxFaceFraction * 100}%.`);
  }
  if (m.sharpness < g.minSharpness) {
    return fail("sharpness", `Frame is too soft (${m.sharpness.toFixed(0)} < ${g.minSharpness}). Hold still.`);
  }
  if (m.brightness < g.minBrightness || m.brightness > g.maxBrightness) {
    return fail("brightness", `Lighting is out of range (${m.brightness.toFixed(2)}); needs ${g.minBrightness}–${g.maxBrightness}.`);
  }
  if (m.contrast < g.minContrast) {
    return fail("contrast", `Too little contrast (${m.contrast.toFixed(3)} < ${g.minContrast}).`);
  }
  /*
    YAW IS GATED AGAINST THE POSE THAT WAS ASKED FOR, not one frontal envelope.

    It used to be `|yaw| > 15` for every sample including the two that explicitly ask the
    subject to TURN — so a real turn was refused, the subject straightened up, and a frontal
    frame was stored under the label "left". The evidence is in the data this wrote: across all
    365 stored templates the yaw spread is -11.6 to +12.0 degrees, pinned against that ceiling,
    and every employee is enrolled as five copies of the same frontal photograph. That is why
    recognition fails as soon as somebody looks slightly away from the camera.

    The client mirrors these windows (`enrolPoseWindows.ts`) so the operator is guided rather
    than refused, but this remains the authority.
  */
  const turning = sample.pose_prompt === "left" || sample.pose_prompt === "right";
  const yawCeiling = turning ? g.maxTurnYawDeg : g.maxYawDeg;
  if (Math.abs(m.yaw) > yawCeiling) {
    return fail("yaw", `Head turned ${m.yaw.toFixed(1)}°; keep within ±${yawCeiling}°.`);
  }
  if (turning && frontalYaw !== null) {
    const moved = Math.abs(m.yaw - frontalYaw);
    if (moved < g.minTurnYawDeltaDeg) {
      return fail(
        "yaw",
        `This pose needs a real turn: the head moved ${moved.toFixed(1)}° from straight-on, ` +
          `and at least ${g.minTurnYawDeltaDeg}° is needed.`,
      );
    }
  }
  // PITCH IS NOT A GATE. It is recorded, and it still costs a little quality score
  // (the `pose` term), but it can no longer reject a sample.
  //
  // `facePipeline.poseFromLandmarks` derives pitch as
  //     ((chin.y - eyeMidY) / boxWidth - 0.9) * 90
  // where 0.9 is an ASSUMED neutral ratio of chin-to-eye distance over box WIDTH.
  // That ratio is a property of the person's face and of how the detector crops —
  // a broad face, or a beard extending the chin landmark, moves it several tenths.
  // So a subject looking straight down the lens can report -27° while another
  // reports +5°, and neither is tilted. Yaw and roll do NOT have this problem: roll
  // is a true atan2 angle off the eye line and yaw is the nose's offset from the
  // eye midpoint, both genuinely zero for a neutral face. That is exactly why
  // left/right worked and "chin up" kept firing.
  //
  // Raising the limit (10 -> 25) only moved the wall; the estimate has no
  // calibrated zero to gate against at all. What actually protects the template is
  // measured on the descriptors themselves and is unchanged: `cohesionReject`
  // (0.35 max pairwise distance — the samples must agree with each other),
  // `minTemplateQuality` (0.70), and the detection/sharpness/brightness/size gates.
  // A genuinely bad angle produces a descriptor that disagrees with the others and
  // is caught there, on evidence rather than on a heuristic.
  //
  // The pose term keeps `maxPitchDeg` so an extreme reading still shades the score;
  // at 10% weight and a 0.5 floor it can cost at most 0.05, which cannot by itself
  // drop a good capture under the 0.70 bar.
  if (Math.abs(m.roll) > g.maxRollDeg) {
    return fail("roll", `Head rolled ${m.roll.toFixed(1)}°; keep within ±${g.maxRollDeg}°.`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

function decodeBase64Image(value: string, pointer: string): Uint8Array {
  const comma = value.indexOf(",");
  const payload = value.startsWith("data:") && comma > 0 ? value.slice(comma + 1) : value;
  let binary: string;
  try {
    binary = atob(payload.replace(/\s+/g, ""));
  } catch {
    throw unprocessable(
      [{ pointer, code: "invalid_base64", detail: "Capture is not valid base64." }],
      "A capture could not be decoded.",
      "FACE_CAPTURE_INVALID",
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // Sniff the real container: `content_type` is client prose, and the bucket's mime
  // allowlist would reject a mislabelled object AFTER we had already committed rows.
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  if (!isJpeg && !isWebp) {
    throw unprocessable(
      [{ pointer, code: "unsupported_image", detail: "Capture must be a JPEG or WebP image." }],
      "A capture is not an image this bucket accepts.",
      "FACE_CAPTURE_INVALID",
    );
  }
  return bytes;
}

/**
 * Objects are keyed by a SERVER-generated batch id rather than migration 012's
 * `<employee_id>/v<version>.jpg` comment: `version` is only known inside the
 * transaction, and uploads must happen before it so an approver never faces a row
 * whose photo is missing. Same bucket, same privacy, no race.
 */
function capturePath(employeeId: string, batchId: string, index: number, contentType: string): string {
  const ext = contentType === "image/webp" ? "webp" : "jpg";
  return `${employeeId}/${batchId}/${index}.${ext}`;
}

async function uploadCaptures(
  employeeId: string,
  batchId: string,
  samples: readonly SampleInput[],
): Promise<Map<number, string>> {
  const storage = serviceClient().storage.from(CAPTURE_BUCKET);
  const paths = new Map<number, string>();
  for (const sample of samples) {
    const capture = sample.capture;
    if (capture === undefined) continue;
    const bytes = decodeBase64Image(capture.data_base64, `/samples/${sample.index}/capture/data_base64`);
    const path = capturePath(employeeId, batchId, sample.index, capture.content_type);
    const { error } = await storage.upload(path, bytes, {
      contentType: capture.content_type,
      upsert: false,
      cacheControl: "0",
    });
    if (error !== null) {
      throw problem(502, "Upstream failure", "The enrolment photo could not be stored. Retry.", undefined, {
        code: "FACE_CAPTURE_UPLOAD_FAILED",
        cause: error,
      });
    }
    paths.set(sample.index, path);
  }
  return paths;
}

/** Best-effort cleanup so a rolled-back enrolment does not leave orphaned biometrics. */
async function removeCaptures(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await serviceClient().storage.from(CAPTURE_BUCKET).remove([...paths]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

/** `hasCapDb`/`requireCapWithStepUp` resolve the actor from `userId` alone. */
function capActorFor(profileId: string): AuthContext {
  return { userId: profileId } as unknown as AuthContext;
}

interface Actor {
  channel: "web" | "kiosk";
  /** `profiles.id` — `enrolled_by`, and `app.actor_id` for the transaction. */
  profileId: string;
  actorRole: AppRole | null;
  deviceId: string | null;
  label: string;
  /** Rate-limit / idempotency partition key. */
  limitKeyPart: string;
}

interface EmployeeRow {
  id: string;
  employee_code: string;
  display_name: string | null;
  employment_status: string;
  in_scope: boolean;
  consent_id: string | null;
  consent_version: string | null;
  pending_request_id: string | null;
  active_template_version: number | null;
}

interface DuplicateRow {
  id: string;
  employee_id: string;
  employee_code: string;
  display_name: string | null;
  version: number;
  distance: string;
}

interface SettingsRow {
  min_detection_score: string | null;
  min_quality: string | null;
  cohesion_reject: string | null;
  cohesion_warn: string | null;
  dup_block: string | null;
  dup_warn: string | null;
  consent_version: string | null;
  descriptor_model: string | null;
}

function numOr(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ──────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;
  let uploaded: string[] = [];

  try {
    assertOriginAllowed(req);

    // The exact bytes, once: the kiosk HMAC and the idempotency hash both need them.
    const rawBody = await readRawBody(req, { maxBytes: MAX_BODY_BYTES });
    const decoded = decodeJson(rawBody);
    const pool = sql();

    // ── STEP 4 · Auth ────────────────────────────────────────────────────────
    // Two doors, per the catalogue. A signed device request takes the kiosk door;
    // anything else must present a user JWT.
    const isDevice = (req.headers.get("x-device-id") ?? "").trim() !== "";
    let actor: Actor;

    if (isDevice) {
      const deviceAuth = await verifyDevice(req, rawBody, pool);
      const device = deviceAuth.device;

      // ── STEP 5 · Authority (kiosk) ────────────────────────────────────────
      // "D + admin PIN". The PIN itself is Argon2id in
      // `secure.kiosk_operator_secrets` and is verified by `kiosk-operator-auth`,
      // which mints the device-bound operator session; this function therefore
      // demands that session and re-derives authority from the DATABASE:
      // the operator must still be active on this device, must be flagged
      // `can_enrol_faces`, AND their profile must hold `biometric.enrol` in
      // `role_capabilities`. A guard session alone can never enrol a face.
      //
      // `requireCapDb`, NOT `requireCapWithStepUp`: `biometric.enrol` carries
      // `requires_step_up = true`, and aal2 is unreachable on a tablet that holds no
      // user session at all — the step-up form would refuse every kiosk enrolment
      // outright. The PIN-gated Enrolment Mode session is the documented substitute
      // (catalogue #5: "D + admin PIN"), which is exactly why the capability itself
      // is still resolved from `role_capabilities` against the operator's real
      // profile instead of being waived.
      const operator = await requireOperatorSession(req, deviceAuth, pool);
      if (!operator.canEnrolFaces) {
        throw forbidden(
          "This guard is not permitted to enrol faces. Sign in as an enrolment operator.",
          "KIOSK_OPERATOR_NOT_PERMITTED",
        );
      }
      await requireCapDb(pool, capActorFor(operator.profileId), "biometric.enrol");

      const claimedDeviceId = typeof decoded === "object" && decoded !== null
        ? (decoded as Record<string, unknown>).device_id
        : undefined;
      if (typeof claimedDeviceId === "string" && claimedDeviceId !== device.id) {
        throw unprocessable(
          [{ pointer: "/device_id", code: "mismatch", detail: "device_id does not match the signing device." }],
          "The body and the signature disagree about which device this is.",
          "KIOSK_DEVICE_MISMATCH",
        );
      }

      actor = {
        channel: "kiosk",
        profileId: operator.profileId,
        actorRole: null, // the audit engine re-derives it from user_roles
        deviceId: device.id,
        label: `kiosk ${device.deviceCode} / operator ${operator.operatorId}`,
        limitKeyPart: device.id,
      };
      log.info("kiosk enrolment mode authenticated", {
        device_id: device.id,
        operator_id: operator.operatorId,
      });
    } else {
      const auth = await verifyUser(req);
      // ── STEP 5 · Authority (web) ──────────────────────────────────────────
      // `biometric.enrol` carries `requires_step_up = true` in migration 050, so
      // this one call enforces both the capability and a fresh aal2.
      await requireCapWithStepUp(pool, auth, "biometric.enrol");
      actor = {
        channel: "web",
        profileId: auth.userId,
        actorRole: auth.role,
        deviceId: null,
        label: auth.email,
        limitKeyPart: auth.userId,
      };
      log.info("admin authenticated", { actor_id: auth.userId, role: auth.role });
    }

    // ── STEP 6 · Rate limit ──────────────────────────────────────────────────
    await enforce(RATE_LIMITS.mutation, limitKey(FN_NAME, actor.limitKeyPart));

    // ── STEP 7 · Validate ────────────────────────────────────────────────────
    const body: EnrolInput = parse(EnrolBody, decoded, "enrolment body");

    const settingsRows = await pool<SettingsRow[]>`
      SELECT app.setting('attendance.face_enrol_min_detection_score') AS min_detection_score,
             app.setting('attendance.face_enrol_min_quality')         AS min_quality,
             app.setting('attendance.face_cohesion_reject')           AS cohesion_reject,
             app.setting('attendance.face_cohesion_warn')             AS cohesion_warn,
             app.setting('attendance.face_dup_block_threshold')       AS dup_block,
             app.setting('attendance.face_dup_warn_threshold')        AS dup_warn,
             app.setting('biometric.consent_version')                 AS consent_version,
             app.setting('kiosk.descriptor_model')                    AS descriptor_model
    `;
    const cfg = firstRow(settingsRows) ?? {
      min_detection_score: null,
      min_quality: null,
      cohesion_reject: null,
      cohesion_warn: null,
      dup_block: null,
      dup_warn: null,
      consent_version: null,
      descriptor_model: null,
    };
    const gates: Gates = {
      ...GATE_DEFAULTS,
      minDetectionScore: numOr(cfg.min_detection_score, GATE_DEFAULTS.minDetectionScore),
      minTemplateQuality: numOr(cfg.min_quality, GATE_DEFAULTS.minTemplateQuality),
      cohesionReject: numOr(cfg.cohesion_reject, GATE_DEFAULTS.cohesionReject),
      cohesionWarn: numOr(cfg.cohesion_warn, GATE_DEFAULTS.cohesionWarn),
      duplicateBlock: numOr(cfg.dup_block, GATE_DEFAULTS.duplicateBlock),
      duplicateWarn: numOr(cfg.dup_warn, GATE_DEFAULTS.duplicateWarn),
    };
    const requiredConsentVersion = cfg.consent_version ?? DEFAULT_CONSENT_VERSION;
    const expectedModel = cfg.descriptor_model ?? DEFAULT_DESCRIPTOR_MODEL;

    if (body.descriptor_model !== expectedModel) {
      throw unprocessable(
        [{
          pointer: "/descriptor_model",
          code: "model_mismatch",
          detail: `This server enrols with ${expectedModel}. Update the app and re-capture.`,
        }],
        "Descriptor model does not match the server's.",
        "KIOSK_DESCRIPTOR_MODEL_MISMATCH",
      );
    }

    // Descriptor sanity: dimension is schema-checked, the unit-norm is not. A
    // non-normalised vector makes every stored distance a different scale, which
    // silently poisons 1:N matching for everyone.
    const normIssues: ProblemErrorItem[] = [];
    for (const sample of body.samples) {
      const norm = l2Norm(sample.descriptor);
      if (Math.abs(norm - 1) > NORM_TOLERANCE) {
        normIssues.push({
          pointer: `/samples/${sample.index}/descriptor`,
          code: "not_normalised",
          detail: `Descriptor L2 norm is ${norm.toFixed(4)}; it must be L2-normalised before sending.`,
        });
      }
    }
    if (normIssues.length > 0) {
      throw unprocessable(normIssues, "One or more descriptors are not L2-normalised.", "KIOSK_DESCRIPTOR_INVALID");
    }

    // Session shape (spec-kiosk §2): distinct indices, frames ≥400 ms apart, span
    // ≥3.5 s and ≤45 s. A "session" that arrived in 40 ms is a replayed still.
    const indices = new Set(body.samples.map((s) => s.index));
    if (indices.size !== body.samples.length) {
      throw unprocessable(
        [{ pointer: "/samples", code: "duplicate_index", detail: "Every sample needs a distinct index." }],
        "Sample indices repeat.",
        "FACE_SAMPLES_INVALID",
      );
    }
    const timeline = body.samples
      .map((s) => ({ index: s.index, ms: parseFlexibleInstant(s.captured_at)?.getTime() ?? 0 }))
      .sort((a, b) => a.ms - b.ms);
    const firstMs = timeline[0]?.ms ?? 0;
    const lastMs = timeline[timeline.length - 1]?.ms ?? 0;
    const spanMs = lastMs - firstMs;
    const timingIssues: ProblemErrorItem[] = [];
    for (let i = 1; i < timeline.length; i++) {
      const gap = (timeline[i]?.ms ?? 0) - (timeline[i - 1]?.ms ?? 0);
      if (gap < gates.minSampleGapMs) {
        timingIssues.push({
          pointer: `/samples/${timeline[i]?.index ?? i}/captured_at`,
          code: "too_close",
          detail: `Frames must be at least ${gates.minSampleGapMs} ms apart; this one is ${gap} ms.`,
        });
      }
    }
    if (spanMs < gates.minSessionSpanMs || spanMs > gates.maxSessionSpanMs) {
      timingIssues.push({
        pointer: "/samples",
        code: "bad_session_span",
        detail: `The capture session must span ${gates.minSessionSpanMs}–${gates.maxSessionSpanMs} ms; this one spans ${spanMs} ms.`,
      });
    }
    if (timingIssues.length > 0) {
      throw unprocessable(
        timingIssues,
        "The capture session does not look like a live, supervised sequence.",
        "FACE_SAMPLES_INVALID",
      );
    }

    /*
      The subject's own straight-on reading, taken from THIS submission, against which the two
      turn samples are judged. Derived here rather than passed by the client: the client cannot
      be trusted to tell the server what "straight ahead" means for a face.

      Null when the set contains no straight sample — then the turn floor simply does not apply,
      which is the right failure direction: refusing every turn because the frontal frame is
      missing would block enrolment over a labelling problem.
    */
    const frontalYaw = body.samples.find((sample) => sample.pose_prompt === "straight")
      ?.metrics.yaw ?? null;

    // Per-sample quality gates. Failures are dropped; ≥5 must survive.
    const rejected: RejectedSample[] = [];
    const accepted: SampleInput[] = [];
    for (const sample of body.samples) {
      const failure = gateSample(sample, gates, frontalYaw);
      if (failure === null) accepted.push(sample);
      else rejected.push(failure);
    }
    if (accepted.length < gates.minAcceptedSamples) {
      throw unprocessable(
        rejected.map((r) => ({
          pointer: `/samples/${r.index}/metrics/${r.gate}`,
          code: r.gate,
          detail: r.detail,
        })),
        `Only ${accepted.length} of ${body.samples.length} captures passed the enrolment gates; ${gates.minAcceptedSamples} are needed.`,
        "KIOSK_QUALITY_REJECTED",
      );
    }

    // Eyes open on at least `minAcceptedSamples` frames — enforced only when the
    // client reports EAR for every accepted frame (spec-kiosk §1.1: "≥0.18 on ≥5/7").
    const earReported = accepted.every((s) => s.metrics.ear !== undefined);
    if (earReported) {
      const eyesOpen = accepted.filter((s) => (s.metrics.ear ?? 0) >= gates.minEar).length;
      if (eyesOpen < gates.minAcceptedSamples) {
        throw unprocessable(
          [{
            pointer: "/samples",
            code: "eyes_closed",
            detail: `Only ${eyesOpen} frames have open eyes (EAR ≥ ${gates.minEar}); ${gates.minAcceptedSamples} are needed.`,
          }],
          "Too many frames have closed or squinting eyes.",
          "KIOSK_QUALITY_REJECTED",
        );
      }
    }

    // At least one reference photo: `face_enrolment_requests.capture_path` is NOT
    // NULL, and an approver cannot do a side-by-side review without a face to see.
    const withCapture = accepted.filter((s) => s.capture !== undefined);
    if (withCapture.length === 0) {
      throw unprocessable(
        [{ pointer: "/samples", code: "capture_required", detail: "At least one accepted sample must carry a reference photo." }],
        "No reference photo was supplied.",
        "FACE_CAPTURE_REQUIRED",
      );
    }
    if (withCapture.length > 3) {
      throw unprocessable(
        [{ pointer: "/samples", code: "too_many_captures", detail: "At most 3 reference photos may be stored (spec-kiosk §2)." }],
        "Too many reference photos.",
        "FACE_CAPTURE_INVALID",
      );
    }

    // Template-level metrics, all server-computed.
    const descriptors = accepted.map((s) => s.descriptor);
    let maxPairwise = 0;
    let pairSum = 0;
    let pairCount = 0;
    for (let i = 0; i < descriptors.length; i++) {
      for (let j = i + 1; j < descriptors.length; j++) {
        const d = euclidean(descriptors[i] ?? [], descriptors[j] ?? []);
        if (d > maxPairwise) maxPairwise = d;
        pairSum += d;
        pairCount++;
      }
    }
    const meanPairwise = pairCount === 0 ? 0 : pairSum / pairCount;
    const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
    const cohesion = round4(maxPairwise);
    const lowCohesion = cohesion > gates.cohesionWarn;

    if (cohesion > gates.cohesionReject) {
      throw unprocessable(
        [{
          pointer: "/samples",
          code: "low_cohesion",
          detail: `The captures disagree with each other (max distance ${cohesion} > ${gates.cohesionReject}). Re-capture in one session, one person only.`,
        }],
        "These captures are not consistently the same face.",
        "FACE_COHESION_REJECTED",
      );
    }

    const perSampleQuality = accepted.map((s) =>
      sampleQuality(s.metrics, gates, s.pose_prompt === "left" || s.pose_prompt === "right"));
    // `secure.face_templates.blur_score` is `numeric(6,4)` — it cannot hold a raw
    // variance-of-Laplacian (those run into the hundreds and would raise a numeric
    // overflow). Store the NORMALISED sharpness score instead: 0.5 exactly at the
    // enrol threshold, 1.0 when comfortably sharp, monotonic in the raw value.
    const perSampleBlur = accepted.map((s) =>
      round4(aboveThreshold(s.metrics.sharpness, gates.minSharpness, gates.minSharpness + 280))
    );
    const templateQuality = round4(
      perSampleQuality.reduce((a, b) => a + b, 0) / perSampleQuality.length,
    );
    if (templateQuality < gates.minTemplateQuality) {
      throw unprocessable(
        [{
          pointer: "/samples",
          code: "low_quality",
          detail: `Template quality ${templateQuality} is below ${gates.minTemplateQuality}. Improve lighting, come closer and hold still.`,
        }],
        "The captures are not good enough to enrol from.",
        "KIOSK_QUALITY_REJECTED",
      );
    }

    const medoid = medoidIndex(descriptors);
    const medoidSample = accepted[medoid] as SampleInput;

    // ── STEP 8 · Idempotency claim ───────────────────────────────────────────
    // Mandatory: a retried enrolment must not queue a second review or a second
    // set of stored biometrics.
    idempotencyKey = requireIdempotencyKey(req);
    const hash = await requestHash(FN_NAME, rawBody, actor.profileId);
    const claimed = await claim({
      key: idempotencyKey,
      fnName: FN_NAME,
      requestHash: hash,
      actorId: actor.profileId,
    });
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { key: idempotencyKey });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    // Pre-flight reads (employee, consent, pending queue, duplicate scan) before
    // anything is written or uploaded, so a refusal costs no storage object.
    //
    // INSIDE a context transaction, not on the pool: `app.admin_scope_covers()`
    // resolves the caller through `app.ctx_actor_id()`, and `set_config(…, true)`
    // is transaction-scoped — on a pooled statement the actor would be NULL and
    // every employee would look out of scope.
    const providedReason = (body.reason ?? req.headers.get("x-reason") ?? "").trim();
    const readCtx: RequestContext = {
      actorId: actor.profileId,
      actorRole: actor.actorRole,
      source: actor.channel === "kiosk" ? "kiosk" : "web_admin",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: actor.deviceId,
      reason: providedReason.length >= 10 ? providedReason : "face enrolment pre-flight checks",
    };

    const preflight = await withContext(readCtx, async (tx) => {
      const employeeRows = await tx<EmployeeRow[]>`
        SELECT e.id,
               e.employee_code,
               e.display_name,
               e.employment_status::text    AS employment_status,
               app.admin_scope_covers(e.id) AS in_scope,
               c.id                         AS consent_id,
               c.consent_version            AS consent_version,
               pr.id                        AS pending_request_id,
               at.version                   AS active_template_version
          FROM public.employees e
          LEFT JOIN LATERAL (
            SELECT bc.id, bc.consent_version
              FROM secure.biometric_consents bc
             WHERE bc.employee_id = e.id
               AND bc.granted
               AND bc.withdrawn_at IS NULL
               AND bc.modality IN ('face','both')
               AND bc.purpose = 'attendance_identification'
             ORDER BY (bc.consent_version = ${requiredConsentVersion}) DESC, bc.granted_at DESC
             LIMIT 1
          ) c ON true
          LEFT JOIN LATERAL (
            SELECT r.id
              FROM public.face_enrolment_requests r
             WHERE r.employee_id = e.id AND r.status = 'pending'
             ORDER BY r.requested_at DESC
             LIMIT 1
          ) pr ON true
          LEFT JOIN LATERAL (
            SELECT t.version
              FROM secure.face_templates t
             WHERE t.employee_id = e.id AND t.is_active
             LIMIT 1
          ) at ON true
         WHERE e.id = ${body.employee_id}::uuid
           AND e.deleted_at IS NULL
         LIMIT 1
      `;
      const employee = firstRow(employeeRows);
      // 404 for absent OR out of scope — never "exists but forbidden".
      if (employee === null) throw notFound("No such employee.", "EMPLOYEE_NOT_FOUND");
      // Scope applies to the admin console. A kiosk operator has no admin scope
      // assignment; their authority is the enrolment-mode session plus the
      // `biometric.enrol` capability already checked at step 5.
      if (actor.channel === "web" && employee.in_scope !== true) {
        throw notFound("No such employee.", "EMPLOYEE_NOT_FOUND");
      }
      if (!ENROLLABLE_STATUSES.has(employee.employment_status)) {
        throw forbidden(
          `A face cannot be enrolled while this employee is ${employee.employment_status.replace(/_/g, " ")}.`,
          "EMPLOYEE_NOT_ENROLLABLE",
        );
      }
      if (employee.consent_id === null) {
        throw conflict(
          "This employee has no active biometric consent. Capture consent before enrolling.",
          "BIOMETRIC_CONSENT_MISSING",
        );
      }
      if (employee.consent_version !== requiredConsentVersion) {
        throw conflict(
          `Consent on file is version ${employee.consent_version}; the current notice is ${requiredConsentVersion}. Re-take consent before enrolling.`,
          "BIOMETRIC_CONSENT_STALE",
        );
      }
      if (employee.pending_request_id !== null) {
        throw conflict(
          "An enrolment for this employee is already awaiting approval. Approve or reject it first.",
          "FACE_ENROLMENT_PENDING",
        );
      }

      // Anti-cross-enrolment (spec-kiosk §2.1). EXACT scan, never approximate:
      // ANN recall < 1.0 could silently drop the true nearest neighbour and let a
      // second person enrol onto someone else's face.
      const duplicateRows = await tx<DuplicateRow[]>`
        WITH q AS (
          SELECT ord AS i, val AS v
            FROM unnest(${pgRealArray(medoidSample.descriptor)}::real[]) WITH ORDINALITY AS u(val, ord)
        ),
        d AS (
          SELECT t.employee_id,
                 t.id,
                 t.version,
                 sqrt(sum(power((tv.val - q.v)::double precision, 2))) AS distance
            FROM secure.face_templates t
            CROSS JOIN LATERAL unnest(t.descriptor) WITH ORDINALITY AS tv(val, ord)
            JOIN q ON q.i = tv.ord
           WHERE t.employee_id <> ${body.employee_id}::uuid
             AND t.purged_at IS NULL
             AND t.descriptor_dim = ${DESCRIPTOR_DIM}
             AND (
               t.is_active
               OR t.approved_at IS NULL
               OR t.deactivated_at > now() - interval '180 days'
             )
           GROUP BY t.employee_id, t.id, t.version
        )
        SELECT d.id, d.employee_id, d.version, d.distance,
               e.employee_code, e.display_name
          FROM d
          JOIN public.employees e ON e.id = d.employee_id AND e.deleted_at IS NULL
         ORDER BY d.distance ASC
         LIMIT 1
      `;
      return { employee, nearest: firstRow(duplicateRows) };
    });

    const employee = preflight.employee;
    const nearest = preflight.nearest;
    const nearestDistance = nearest === null ? null : round4(Number(nearest.distance));
    const duplicateOutcome: "clean" | "warn" | "blocked" = nearestDistance === null
      ? "clean"
      : nearestDistance <= gates.duplicateBlock
      ? "blocked"
      : nearestDistance <= gates.duplicateWarn
      ? "warn"
      : "clean";

    const auditReason = providedReason.length >= 10
      ? providedReason
      : `face enrolment for ${employee.employee_code} via ${actor.channel} (${actor.label})`;
    const ctx: RequestContext = { ...readCtx, reason: auditReason };

    if (duplicateOutcome === "blocked") {
      // Refuse, and leave a trail: a face that already belongs to someone else is a
      // Critical alert (spec-admin §alerts), not a quiet 409.
      await withContext(ctx, async (tx) => {
        await tx`
          INSERT INTO public.system_health
            (component, status, metric_name, metric_value, threshold, message, detail)
          VALUES (
            'biometric_enrolment', 'degraded', 'face_duplicate_distance',
            ${nearestDistance}::numeric, ${gates.duplicateBlock}::numeric,
            ${`Enrolment blocked: ${employee.employee_code} matches an existing template of ${nearest?.employee_code ?? "another employee"}.`}::text,
            ${JSON.stringify({
        outcome: "blocked",
        employee_id: employee.id,
        employee_code: employee.employee_code,
        conflicting_employee_id: nearest?.employee_id ?? null,
        conflicting_employee_code: nearest?.employee_code ?? null,
        conflicting_template_id: nearest?.id ?? null,
        distance: nearestDistance,
        request_id: requestId,
        channel: actor.channel,
      })}::jsonb
          )
        `;
        await writeAudit(tx, ctx, {
          action: "enrol_biometric",
          entityTable: "secure.face_templates",
          entityId: null,
          entityLabel: `enrolment refused: duplicate identity (${employee.employee_code})`,
          subjectEmployeeId: employee.id,
          newValue: {
            outcome: "duplicate_blocked",
            distance: nearestDistance,
            threshold: gates.duplicateBlock,
            conflicting_employee_id: nearest?.employee_id ?? null,
          },
          isRedacted: true,
          reason: auditReason,
        });
      });
      // The kiosk is told nothing about whose face it matched (INV-8 / T-09).
      throw conflict(
        actor.channel === "kiosk"
          ? "These captures already belong to an enrolled employee. Call HR before retrying."
          : `These captures match an existing template (distance ${nearestDistance}). Resolve the identity conflict before enrolling.`,
        "FACE_DUPLICATE_IDENTITY",
      );
    }

    // ── Storage BEFORE the transaction ───────────────────────────────────────
    // An approver must never open a review row whose photo is missing, so the
    // objects land first and the `catch` below removes them if the write fails.
    const batchId = crypto.randomUUID();
    const capturePaths = await uploadCaptures(employee.id, batchId, withCapture);
    uploaded = [...capturePaths.values()];
    const primaryPath = capturePaths.get(medoidSample.index) ??
      (uploaded[0] as string);

    const detector = body.detector ?? DEFAULT_DETECTOR;

    // ── STEP 9 · app.set_context + ONE transaction ───────────────────────────
    const result = await withContext(ctx, async (tx) => {
      const versionRows = await tx<{ next_version: number }[]>`
        SELECT COALESCE(MAX(t.version), 0) + 1 AS next_version
          FROM secure.face_templates t
         WHERE t.employee_id = ${employee.id}::uuid
      `;
      const version = Number(firstRow(versionRows)?.next_version ?? 1);

      // One row per accepted sample — the template SET. All `is_active = false`:
      // the employee's current template keeps working until an admin approves.
      const templateIds: { index: number; id: string }[] = [];
      for (let i = 0; i < accepted.length; i++) {
        const sample = accepted[i] as SampleInput;
        const path = capturePaths.get(sample.index) ?? null;
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO secure.face_templates (
            employee_id, descriptor, descriptor_dim, model_name, model_version, detector,
            sample_count, quality_score, intra_sample_max_distance,
            yaw, pitch, roll, brightness, blur_score,
            version, is_active, enrolled_by, enrolled_device_id,
            enrolment_photo_path, consent_id
          ) VALUES (
            ${employee.id}::uuid,
            ${pgRealArray(sample.descriptor)}::real[],
            ${DESCRIPTOR_DIM}::integer,
            ${MODEL_NAME}::text,
            ${expectedModel}::text,
            ${detector}::text,
            ${accepted.length}::integer,
            ${perSampleQuality[i] ?? 0}::numeric,
            ${cohesion}::numeric,
            ${sample.metrics.yaw}::numeric,
            ${sample.metrics.pitch}::numeric,
            ${sample.metrics.roll}::numeric,
            ${sample.metrics.brightness}::numeric,
            ${perSampleBlur[i] ?? 0}::numeric,
            ${version}::integer,
            false,
            ${actor.profileId}::uuid,
            ${actor.deviceId}::uuid,
            ${path}::text,
            ${employee.consent_id}::uuid
          )
          RETURNING id
        `;
        const id = firstRow(inserted)?.id;
        if (id === undefined) {
          throw problem(500, "Internal server error", undefined, undefined, { code: "TEMPLATE_INSERT_FAILED" });
        }
        templateIds.push({ index: sample.index, id });
      }

      const representative = templateIds.find((t) => t.index === medoidSample.index) ??
        (templateIds[0] as { index: number; id: string });

      // The review queue row that `/admin/kiosk/enrolment` works from. Its
      // `resulting_template_id` is how the approver — and this codebase — knows
      // which member of the set is the matchable one.
      const requestRows = await tx<{ id: string }[]>`
        INSERT INTO public.face_enrolment_requests
          (employee_id, requested_via, capture_path, quality_score, status, resulting_template_id)
        VALUES (
          ${employee.id}::uuid,
          ${actor.channel === "kiosk" ? "kiosk" : "web"}::text,
          ${primaryPath}::text,
          ${templateQuality}::numeric,
          'pending'::public.approval_status,
          ${representative.id}::uuid
        )
        RETURNING id
      `;
      const enrolmentRequestId = firstRow(requestRows)?.id as string;

      /*
        ── AUTO-APPROVAL: ENROL AND THE PERSON WORKS ────────────────────────────
        Asked for directly, and worth stating plainly because this file previously argued the
        opposite. The flow the venue wants is: add the employee, register their face, done —
        face scanning, kiosk punch, web punch and face sign-in all live from that moment.

        What stood in the way was this function inserting every template with `is_active = false`
        and a `pending` queue row. Until somebody opened /admin/kiosk/enrolment and approved it,
        the face matched NOTHING: not the gate, not face sign-in (which needs an active
        template, whatever `allow_face_login` says), and web punch stayed off because
        `allow_web_punch` defaults FALSE. An enrolment that looked complete did nothing at all,
        and no screen said a second step existed.

        ── WHY IT IS SAFE TO SKIP THE QUEUE HERE, AND ONLY HERE ─────────────────
        The review queue exists to answer one question: is this face really this person's? For a
        WEB enrolment that question is already answered. An admin holding the `biometric.enrol`
        capability ran the capture with the employee in front of them — they ARE the verification,
        and asking them to re-confirm from a list of thumbnails minutes later checks nothing a
        second time. A KIOSK enrolment is different: nobody with authority necessarily saw who
        stood at the camera, so those stay pending.

        ── THE TWO CASES THAT STILL QUEUE, WHICH ARE THE ONES THAT MATTER ───────
        A NEAR-DUPLICATE (`duplicateOutcome === "warn"`) means this face sits close to somebody
        else's enrolment. That is precisely the identity confusion the queue is for, and it is
        not something an admin can see by looking at a person — it needs the distance figure.
        Auto-approving it would let two people match as one at the gate.

        LOW COHESION means the five samples disagree with each other, so the template is built on
        a poor capture and will match unreliably. A human should re-capture rather than approve.

        Both leave the row pending exactly as before, so the queue keeps the cases where it does
        real work and loses the ones where it was pure ceremony.

        Behind a setting for a venue that wants every enrolment reviewed regardless. Absent means
        on, matching what was asked for; no deploy needed to change it.
      */
      const autoApproveSetting = await tx<{ value: string | null }[]>`
        SELECT app.setting('biometric.auto_approve_admin_enrolment') AS value
      `;
      const rawAutoApprove = firstRow(autoApproveSetting)?.value;
      const autoApproveEnabled = rawAutoApprove === null || rawAutoApprove === undefined
        ? true
        : !/^"?(false|0|off|no)"?$/i.test(String(rawAutoApprove).trim());

      const autoApprove = autoApproveEnabled &&
        actor.channel === "web" &&
        duplicateOutcome !== "warn" &&
        !lowCohesion;

      let autoApprovedWebPunch = false;
      if (autoApprove) {
        /*
          The same four writes `face-template-admin`'s approve op performs, in the same order and
          for the same reasons. Ordering is load-bearing: the retire MUST precede the activate,
          because `uq_face_templates__employee_active` permits exactly one active row per
          employee and doing it the other way round raises a unique violation on a re-enrolment.
        */
        await tx`
          UPDATE secure.face_templates
             SET is_active           = false,
                 deactivated_at      = now(),
                 deactivation_reason = ${`superseded by v${version}: ${auditReason}`}
           WHERE employee_id = ${employee.id}::uuid
             AND is_active
             AND id <> ${representative.id}::uuid
        `;

        // Approve the whole version set; only the medoid becomes matchable. The siblings stay as
        // retained samples — what a future model upgrade re-derives the template from.
        await tx`
          UPDATE secure.face_templates
             SET approved_by = ${actor.profileId}::uuid,
                 approved_at = now(),
                 is_active   = (id = ${representative.id}::uuid)
           WHERE employee_id = ${employee.id}::uuid
             AND version     = ${version}::integer
             AND purged_at IS NULL
             AND deactivated_at IS NULL
        `;

        await tx`
          UPDATE public.face_enrolment_requests
             SET status                = 'approved'::public.approval_status,
                 reviewed_by           = ${actor.profileId}::uuid,
                 reviewed_at           = now(),
                 review_comment        = ${`Auto-approved: enrolled by an administrator, no near-duplicate and no low-cohesion warning. ${auditReason}`}::text,
                 resulting_template_id = ${representative.id}::uuid
           WHERE id = ${enrolmentRequestId}::uuid
        `;

        // Enrolled from this moment. `public.employees` is reason-required — ctx.reason carries it.
        await tx`
          UPDATE public.employees
             SET face_enrolled_at = now()
           WHERE id = ${employee.id}::uuid
             AND deleted_at IS NULL
        `;

        /*
          And web punch, which is the switch nobody could find. It defaults FALSE, so an employee
          was enrolled, approved, and then still refused with SELF_PUNCH_NOT_ENTITLED until an
          admin ticked a box in the employee editor. Same setting the approve op reads, so the
          two routes to a working enrolment grant the same thing.

          It only ever GRANTS: an admin who deliberately revoked somebody's web punch must not
          have that undone by a re-enrolment, hence the `= false` predicate.
        */
        const webPunchSetting = await tx<{ value: string | null }[]>`
          SELECT app.setting('attendance.web_punch_on_enrolment') AS value
        `;
        const rawWebPunch = firstRow(webPunchSetting)?.value;
        const grantWebPunch = rawWebPunch === null || rawWebPunch === undefined
          ? true
          : !/^"?(false|0|off|no)"?$/i.test(String(rawWebPunch).trim());

        if (grantWebPunch) {
          const granted = await tx<{ id: string }[]>`
            UPDATE public.employees
               SET allow_web_punch = true
             WHERE id = ${employee.id}::uuid
               AND deleted_at IS NULL
               AND allow_web_punch = false
            RETURNING id
          `;
          autoApprovedWebPunch = granted.length > 0;
        }
      }

      if (duplicateOutcome === "warn" || lowCohesion) {
        await tx`
          INSERT INTO public.system_health
            (component, status, metric_name, metric_value, threshold, message, detail)
          VALUES (
            'biometric_enrolment', 'degraded',
            ${duplicateOutcome === "warn" ? "face_duplicate_distance" : "face_intra_sample_distance"}::text,
            ${duplicateOutcome === "warn" ? nearestDistance : cohesion}::numeric,
            ${duplicateOutcome === "warn" ? gates.duplicateWarn : gates.cohesionWarn}::numeric,
            ${duplicateOutcome === "warn"
          ? `Near-duplicate enrolment for ${employee.employee_code}; review the threshold before approving.`
          : `Low-cohesion enrolment for ${employee.employee_code}; consider a re-capture.`}::text,
            ${JSON.stringify({
          outcome: duplicateOutcome === "warn" ? "near_duplicate" : "low_cohesion",
          employee_id: employee.id,
          employee_code: employee.employee_code,
          template_id: representative.id,
          version,
          distance: nearestDistance,
          intra_sample_max_distance: cohesion,
          conflicting_employee_id: duplicateOutcome === "warn" ? nearest?.employee_id ?? null : null,
          request_id: requestId,
        })}::jsonb
          )
        `;
      }

      // ── STEP 10 · Audit, in the SAME transaction ──────────────────────────
      // `trg_face_templates__audit` already emits one summary insert row per
      // template row, with `descriptor` dropped by `audit.redacted_columns`. This
      // adds the SEMANTIC event — a single `enrol_biometric` row for the whole set,
      // which is what an investigator or a DPDP request actually looks for. No
      // descriptor, ever.
      await writeAudit(tx, ctx, {
        action: "enrol_biometric",
        entityTable: "secure.face_templates",
        entityId: representative.id,
        entityLabel: `${employee.employee_code} face template v${version} ${
          autoApprove ? "(auto-approved)" : "(pending approval)"
        }`,
        subjectEmployeeId: employee.id,
        newValue: {
          version,
          // The audit trail must say which route approved this. "auto_approved" plus the reason
          // it qualified is what an investigator needs; "pending_approval" on a live template
          // would be a false record.
          status: autoApprove ? "auto_approved" : "pending_approval",
          auto_approved: autoApprove,
          auto_approve_setting_enabled: autoApproveEnabled,
          web_punch_granted: autoApprovedWebPunch,
          sample_count: accepted.length,
          template_ids: templateIds.map((t) => t.id),
          quality_score: templateQuality,
          intra_sample_max_distance: cohesion,
          low_cohesion: lowCohesion,
          duplicate_outcome: duplicateOutcome,
          nearest_other_distance: nearestDistance,
          model_version: expectedModel,
          detector,
          quality_gate_version: body.quality_gate_version ?? null,
          consent_id: employee.consent_id,
          consent_version: requiredConsentVersion,
          channel: actor.channel,
          enrolment_request_id: enrolmentRequestId,
          rejected_sample_count: rejected.length,
        },
        isRedacted: true,
        reason: auditReason,
      });

      return {
        version,
        templateIds,
        representativeId: representative.id,
        enrolmentRequestId,
        autoApproved: autoApprove,
        webPunchGranted: autoApprovedWebPunch,
      };
    });

    // ── Response ─────────────────────────────────────────────────────────────
    // Allowlisted. Never a descriptor. On the kiosk path also never another
    // employee's identity and never a storage path (INV-8, test T-09).
    const shared = {
      templateId: result.representativeId,
      enrolmentRequestId: result.enrolmentRequestId,
      employeeId: employee.id,
      employeeCode: employee.employee_code,
      displayName: employee.display_name,
      version: result.version,
      /*
        The client renders "awaiting review" off this field, so a hardcoded `pending_approval`
        would tell an admin to go and approve something that is already live and working.
      */
      status: result.autoApproved ? ("active" as const) : ("pending_approval" as const),
      autoApproved: result.autoApproved,
      webPunchGranted: result.webPunchGranted,
      previousActiveVersion: employee.active_template_version,
      sampleCount: result.templateIds.length,
      acceptedSampleIndices: accepted.map((s) => s.index),
      medoidSampleIndex: medoidSample.index,
      rejectedSamples: rejected,
      qualityScore: templateQuality,
      qualityBand: qualityBand(templateQuality),
      cohesion: {
        maxPairwiseDistance: cohesion,
        meanPairwiseDistance: round4(meanPairwise),
        lowCohesion,
      },
      modelVersion: expectedModel,
      detector,
      consentVersion: requiredConsentVersion,
      duplicateOutcome,
      /*
        Was `true as const`. An auto-approved template needs no approval, and saying it does
        sends an admin to a queue that has nothing in it for them.
      */
      requiresApproval: !result.autoApproved,
      requestId,
    };

    const responseBody = actor.channel === "kiosk" ? shared : {
      ...shared,
      consentId: employee.consent_id,
      capturePaths: uploaded,
      nearestOther: nearest === null || duplicateOutcome === "clean" ? null : {
        employeeId: nearest.employee_id,
        employeeCode: nearest.employee_code,
        displayName: nearest.display_name,
        templateVersion: nearest.version,
        distance: nearestDistance,
      },
    };
    status = 201;

    // ── STEP 11 · Store the response under the idempotency key ───────────────
    await store(idempotencyKey, status, responseBody);

    log.info("enrolment captured", {
      employee_id: employee.id,
      template_id: result.representativeId,
      version: result.version,
      sample_count: result.templateIds.length,
      quality_score: templateQuality,
      duplicate_outcome: duplicateOutcome,
    });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const failure = toProblem(err, requestId).withContext({ requestId, instance });
    status = failure.status;

    // Uploaded objects belong to a template that does not exist. Remove them —
    // orphaned biometric captures are exactly what the DPDP purge story cannot have.
    if (uploaded.length > 0) {
      try {
        await removeCaptures(uploaded);
      } catch (cleanupErr) {
        log.warn("could not remove orphaned captures", { paths: uploaded.length, err: cleanupErr });
      }
    }

    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, failure.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }

    if (failure.isServerFault) log.error("unhandled failure", { err, code: failure.code });
    else log.warn("request refused", { code: failure.code, status });
    return failure.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ─────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported for `supabase/tests` and the enrolment client, which gate against the same schema. */
export { EnrolBody, GATE_DEFAULTS, Sample, SampleMetrics };
