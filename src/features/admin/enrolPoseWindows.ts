/**
 * enrolPoseWindows.ts — what head angle each enrolment pose actually requires.
 *
 * ── THE DEFECT THIS EXISTS TO FIX ────────────────────────────────────────────
 * Enrolment prompts for five poses — straight, left, right, chin down, smile — and then
 * judged every one of them against a SINGLE frontal envelope: `|yaw| > 15 × 0.85 = 12.75°`
 * was refused, whichever pose had been asked for. So the operator said "turn left", the
 * subject turned, the frame was rejected as "turned too far", they straightened up, and a
 * FRONTAL frame was captured. Five times.
 *
 * That is not a theory. Across all 365 stored templates the total yaw spread is −11.6° to
 * +12.0° — pinned against that 12.75° ceiling — and one employee's five samples read
 * −6.5, −4.0, −6.4, −5.9, −4.3. Every person in the system is enrolled as five copies of the
 * same frontal photograph, which is exactly why recognition falls apart the moment somebody
 * looks slightly away from the camera.
 *
 * ── WHY THE TWO TURNS ARE "ONE SIDE" AND "THE OTHER SIDE" ────────────────────
 * Not "left" and "right". The pipeline's yaw is `(nose.x − eyeMidX) / boxWidth × 120` over the
 * RAW camera frame, while the preview is mirrored for the subject — so which sign means "the
 * subject's left" depends on the camera, the mirroring and the estimator together, and getting
 * it backwards would tell somebody to turn the wrong way. What actually matters for recognition
 * is that the two turn samples cover OPPOSITE sides by a real margin; which one comes first
 * does not. So the gate requires a turn of at least `TURN_MIN_YAW` and requires the second turn
 * to be on the opposite side of whichever turn was captured first, and the wording asks for
 * "one side" then "the other".
 *
 * ── WHY THE WINDOW HAS A CEILING TOO ─────────────────────────────────────────
 * Past roughly 35° the descriptor net degrades faster than the extra coverage is worth, and the
 * landmarks it aligns on start to occlude. A turn is wanted, a profile shot is not.
 *
 * PITCH IS STILL NOT CHECKED, for the reason already recorded in `EnrolCapture`: the estimator
 * measures chin-to-eye distance against an assumed neutral ratio, so a subject looking straight
 * at the lens reads anywhere from −27° to +5° depending on face shape. Every stored template
 * sits at pitch −22° to −35° because the cameras are laptop cameras below eye level; gating on
 * that number would reject everybody.
 */

/**
 * The five poses, in the order they are asked for.
 *
 * The NAMES are unchanged from what shipped, deliberately: `face-enrol` validates `pose_prompt`
 * against exactly this enum and 365 rows are already stored under these labels. What changes is
 * what "left" and "right" MEAN to the gate — they are now simply the two turn poses, and which
 * physical side each one lands on is not asserted (see the header). Renaming them would have
 * been a wire-format change and a migration for no gain.
 */
export const ENROL_POSES = ["straight", "left", "right", "chin_down", "smile"] as const;
export type EnrolPose = (typeof ENROL_POSES)[number];

/** The two poses that must be a real turn, whichever way each one goes. */
export const TURN_POSES: readonly EnrolPose[] = ["left", "right"];

export function isTurnPose(pose: EnrolPose): boolean {
  return pose === "left" || pose === "right";
}

/** A frontal pose must be genuinely frontal — this is what the medoid is chosen from. */
export const FRONTAL_MAX_YAW = 10;

/** A turn must be a real turn. Below this the sample adds nothing the frontal one has not got. */
export const TURN_MIN_YAW = 15;

/** Beyond this the aligned crop degrades faster than the coverage is worth. */
export const TURN_MAX_YAW = 35;

/** Head tilt is refused for every pose: it rotates the crop rather than revealing a new angle. */
export const MAX_ROLL = 15;

export type PoseComplaint =
  | "turn_more"
  | "turn_less"
  | "turn_other_way"
  | "face_forward"
  | "straighten_head";

export interface PoseContext {
  /** Yaw of the turn already captured, if any — the next turn must oppose it. */
  readonly firstTurnYaw?: number | null;
}

/**
 * Is this frame acceptable FOR THIS POSE? `null` means take it.
 *
 * Roll is judged first and for every pose: a tilted head is a rotated crop, which is a
 * different complaint from a turned head and is never what was asked for.
 */
export function poseWindowComplaint(
  pose: EnrolPose,
  quality: { readonly yaw: number; readonly roll: number },
  context: PoseContext = {},
): PoseComplaint | null {
  if (Math.abs(quality.roll) > MAX_ROLL) return "straighten_head";

  const yaw = quality.yaw;

  if (isTurnPose(pose)) {
    const magnitude = Math.abs(yaw);
    if (magnitude < TURN_MIN_YAW) return "turn_more";
    if (magnitude > TURN_MAX_YAW) return "turn_less";
    // The second turn has to be the OTHER side, or the set covers one side twice and the
    // subject has effectively been enrolled at two angles out of a possible three.
    const first = context.firstTurnYaw;
    if (first !== null && first !== undefined && Math.sign(yaw) === Math.sign(first)) {
      return "turn_other_way";
    }
    return null;
  }

  // straight, chin_down and smile are all frontal poses: the variation wanted from them is
  // expression and chin height, not yaw.
  if (Math.abs(yaw) > FRONTAL_MAX_YAW) return "face_forward";
  return null;
}

/**
 * How much angular ground a finished capture actually covers, in degrees of yaw.
 *
 * Used to refuse an enrolment that is five frontal frames again — the exact failure the whole
 * file exists to prevent, which nothing would otherwise notice until somebody could not sign in.
 */
export function yawCoverage(samples: readonly { readonly yaw: number }[]): number {
  if (samples.length === 0) return 0;
  let min = samples[0]?.yaw ?? 0;
  let max = min;
  for (const s of samples) {
    if (s.yaw < min) min = s.yaw;
    if (s.yaw > max) max = s.yaw;
  }
  return max - min;
}

/**
 * The floor a complete capture must clear, derived so that ONLY two real opposing turns can
 * reach it. Its first form was `2 × TURN_MIN − FRONTAL_MAX` = 20°, and a test caught that two
 * FRONTAL frames sitting at opposite edges of their own window (+10 and −10) also span 20° —
 * so the check would have passed the exact failure it exists to catch.
 *
 * Worked through, the three cases that must be told apart:
 *
 *   two frontal frames at the edges      +10 … −10   =  20°   must FAIL
 *   one turn and one frontal edge        +15 … −10   =  25°   must FAIL (only one turn happened)
 *   two opposing turns at the minimum    +15 … −15   =  30°   must PASS
 *
 * So the floor has to sit above 25 and at or below 30. `TURN_MIN_YAW + FRONTAL_MAX_YAW + 1`
 * gives 26, which clears the second case by a degree and leaves 4° of estimator slack under the
 * third.
 */
export const MIN_YAW_COVERAGE = TURN_MIN_YAW + FRONTAL_MAX_YAW + 1;

export function coverageIsFrontalOnly(samples: readonly { readonly yaw: number }[]): boolean {
  return yawCoverage(samples) < MIN_YAW_COVERAGE;
}
