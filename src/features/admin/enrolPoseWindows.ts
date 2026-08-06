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
 * ── THE FLOOR IS RELATIVE, AND IT IS SMALL, BECAUSE THE METRIC IS WEAK ───────
 * This gate first demanded |yaw| >= 15 absolute, and that was wrong enough to stall a live
 * enrolment: step 2 never validated no matter how far the subject turned.
 *
 * The reason is what the number measures. Yaw here is the NOSE TIP drifting off the line
 * between the outer eye corners, scaled by 120. The nose protrudes about 2 cm from a face box
 * around 17 cm wide, so a genuine 25-degree head turn moves it 2*sin(25)/17*120 = about 6
 * degrees on this scale, and even 45 degrees only reaches about 10. The metric saturates far
 * below the real head angle.
 *
 * The stored data agrees: over 380 samples the median |yaw| is 1.84, p90 is 7.54, the largest
 * ever recorded is 18.4, and only SIX rows reach 15 at all. A 15 floor is therefore not a
 * standard almost nobody meets — it is a standard almost nobody CAN meet.
 *
 * What the data does show is a usable signal: the spread between a person's own most- and
 * least-turned sample has a median of 6.57. So the gate asks for a CHANGE of
 * `TURN_MIN_YAW_DELTA` from that person's OWN straight-on reading, which also cancels the
 * per-face bias the estimator carries (some faces read -6 looking dead ahead, others +12 —
 * an absolute threshold punishes one and flatters the other).
 *
 * ── WHY THERE IS STILL A CEILING ─────────────────────────────────────────────
 * Past roughly 35° on this scale — which is a very large real turn — the descriptor net degrades
 * faster than the extra coverage is worth and the landmarks it aligns on start to occlude.
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

/**
 * How far a turn must move the yaw reading AWAY FROM THIS PERSON'S OWN frontal sample.
 *
 * 6, not 15, and relative rather than absolute — see the header. It is the median within-person
 * spread already present in the stored data, so it is a turn people demonstrably do make.
 */
export const TURN_MIN_YAW_DELTA = 6;

/**
 * Absolute floor when the person's frontal reading is not known yet (it should always be, since
 * "straight" is captured first). Deliberately low: the ceiling and the delta do the real work.
 */
export const TURN_MIN_YAW = 6;

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
  /**
   * Yaw of this person's OWN straight-on sample, which the turns are measured against.
   *
   * Captured first, so it is available for both turns. Absent only if somebody reorders the
   * poses, in which case the gate falls back to the absolute floor.
   */
  readonly frontalYaw?: number | null;
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
    if (magnitude > TURN_MAX_YAW) return "turn_less";
    /*
      Measured against this person's own frontal reading when it is known. That is what makes the
      floor meetable: the estimator carries a per-face bias of several degrees, so "turned" only
      means anything relative to where THIS face sits when looking straight ahead.
    */
    const frontal = context.frontalYaw;
    const moved = frontal === null || frontal === undefined
      ? magnitude
      : Math.abs(yaw - frontal);
    if (moved < TURN_MIN_YAW_DELTA) return "turn_more";
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
 * The floor a complete capture must clear, so that "five frontal frames" is still caught.
 *
 * Re-derived after the turn floor became a RELATIVE delta of 6. Two opposing turns each moving
 * 6 from a shared frontal baseline span about 12; five genuinely frontal frames span the median
 * 6.57 seen in the data and rarely more. 10 sits between them: above ordinary frontal jitter,
 * below what two real opposing turns produce.
 *
 * It is a warning threshold, not a refusal — `coverageIsFrontalOnly` is advisory, because
 * refusing a completed capture outright would throw away five good frames over an estimator
 * whose weakness is the whole reason this file exists.
 */
export const MIN_YAW_COVERAGE = 10;

export function coverageIsFrontalOnly(samples: readonly { readonly yaw: number }[]): boolean {
  return yawCoverage(samples) < MIN_YAW_COVERAGE;
}
