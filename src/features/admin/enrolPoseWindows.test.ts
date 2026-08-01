/**
 * Tests for the enrolment pose windows.
 *
 * The case that matters most is the one the live data proves happened: a frame turned 20° was
 * refused by a frontal-only gate, so the operator got a frontal frame for every pose and every
 * employee in the system ended up with five copies of the same photograph.
 */
import { describe, expect, it } from "vitest";
import {
  FRONTAL_MAX_YAW,
  MIN_YAW_COVERAGE,
  TURN_MAX_YAW,
  TURN_MIN_YAW,
  coverageIsFrontalOnly,
  poseWindowComplaint,
  yawCoverage,
} from "./enrolPoseWindows";

const straightOn = { yaw: 0, roll: 0 };

describe("poseWindowComplaint — frontal poses", () => {
  it("accepts a frontal frame for the straight pose", () => {
    expect(poseWindowComplaint("straight", straightOn)).toBeNull();
  });

  it("accepts a small yaw for a frontal pose", () => {
    expect(poseWindowComplaint("straight", { yaw: FRONTAL_MAX_YAW - 1, roll: 0 })).toBeNull();
  });

  it("refuses a turned head when a frontal pose was asked for", () => {
    expect(poseWindowComplaint("smile", { yaw: 20, roll: 0 })).toBe("face_forward");
  });

  it("treats chin_down and smile as frontal, because pitch cannot be trusted", () => {
    expect(poseWindowComplaint("chin_down", straightOn)).toBeNull();
    expect(poseWindowComplaint("smile", straightOn)).toBeNull();
  });
});

describe("poseWindowComplaint — the turns", () => {
  it("ACCEPTS a real turn, which the old frontal-only gate refused", () => {
    // The regression this whole module exists for: 20° was rejected as "turned too far",
    // so the subject straightened up and a frontal frame was stored instead.
    expect(poseWindowComplaint("left", { yaw: 20, roll: 0 })).toBeNull();
    expect(poseWindowComplaint("left", { yaw: -20, roll: 0 })).toBeNull();
  });

  it("asks for more turn when the head has barely moved", () => {
    expect(poseWindowComplaint("left", { yaw: TURN_MIN_YAW - 1, roll: 0 })).toBe("turn_more");
    expect(poseWindowComplaint("left", { yaw: 0, roll: 0 })).toBe("turn_more");
  });

  it("asks for less turn past the point the crop degrades", () => {
    expect(poseWindowComplaint("left", { yaw: TURN_MAX_YAW + 1, roll: 0 })).toBe("turn_less");
    expect(poseWindowComplaint("left", { yaw: -80, roll: 0 })).toBe("turn_less");
  });

  it("accepts either side for the FIRST turn — the sign convention is not assumed", () => {
    expect(poseWindowComplaint("left", { yaw: 25, roll: 0 })).toBeNull();
    expect(poseWindowComplaint("left", { yaw: -25, roll: 0 })).toBeNull();
  });

  it("requires the second turn to be the other side", () => {
    expect(poseWindowComplaint("right", { yaw: 25, roll: 0 }, { firstTurnYaw: 22 })).toBe(
      "turn_other_way",
    );
    expect(poseWindowComplaint("right", { yaw: -25, roll: 0 }, { firstTurnYaw: 22 })).toBeNull();
  });

  it("accepts the second turn when the first is unknown", () => {
    expect(poseWindowComplaint("right", { yaw: 25, roll: 0 })).toBeNull();
    expect(poseWindowComplaint("right", { yaw: 25, roll: 0 }, { firstTurnYaw: null })).toBeNull();
  });
});

describe("poseWindowComplaint — roll", () => {
  it("refuses a tilted head for every pose, turn or frontal", () => {
    expect(poseWindowComplaint("straight", { yaw: 0, roll: 30 })).toBe("straighten_head");
    expect(poseWindowComplaint("left", { yaw: 20, roll: -30 })).toBe("straighten_head");
  });

  it("judges roll before yaw — a tilted, barely-turned head is told to straighten first", () => {
    expect(poseWindowComplaint("left", { yaw: 2, roll: 40 })).toBe("straighten_head");
  });
});

describe("yawCoverage", () => {
  it("is zero for no samples", () => {
    expect(yawCoverage([])).toBe(0);
  });

  it("measures the spread from the most-left to the most-right sample", () => {
    expect(yawCoverage([{ yaw: -20 }, { yaw: 0 }, { yaw: 22 }])).toBe(42);
  });

  it("reports the real spread of what is stored today, which is far too little", () => {
    // The five samples of one live employee, verbatim.
    const live = [{ yaw: -6.5 }, { yaw: -4.0 }, { yaw: -6.4 }, { yaw: -5.9 }, { yaw: -4.3 }];
    expect(yawCoverage(live)).toBeCloseTo(2.5, 5);
    expect(coverageIsFrontalOnly(live)).toBe(true);
  });

  it("passes a capture that really did turn both ways", () => {
    const good = [{ yaw: 0 }, { yaw: 22 }, { yaw: -21 }, { yaw: 3 }, { yaw: -2 }];
    expect(yawCoverage(good)).toBe(43);
    expect(coverageIsFrontalOnly(good)).toBe(false);
  });

  it("sets a floor only two opposing turns can clear", () => {
    // The three cases the constant is derived from. The first form of it (20°) passed the
    // frontal case, which is the very failure this check exists to catch.
    const twoFrontalEdges = [{ yaw: FRONTAL_MAX_YAW }, { yaw: -FRONTAL_MAX_YAW }];
    const oneTurnOneFrontal = [{ yaw: TURN_MIN_YAW }, { yaw: -FRONTAL_MAX_YAW }];
    const twoOpposingTurns = [{ yaw: TURN_MIN_YAW }, { yaw: -TURN_MIN_YAW }];

    expect(coverageIsFrontalOnly(twoFrontalEdges)).toBe(true);
    expect(coverageIsFrontalOnly(oneTurnOneFrontal)).toBe(true);
    expect(coverageIsFrontalOnly(twoOpposingTurns)).toBe(false);
    expect(MIN_YAW_COVERAGE).toBeGreaterThan(TURN_MIN_YAW + FRONTAL_MAX_YAW);
    expect(MIN_YAW_COVERAGE).toBeLessThanOrEqual(2 * TURN_MIN_YAW);
  });
});
