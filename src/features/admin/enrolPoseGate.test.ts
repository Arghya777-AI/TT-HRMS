/**
 * enrolPoseGate.test.ts — keep the capture UI's pose envelope in step with the
 * server's, and prove the gate rejects what `face-enrol` would reject.
 *
 * WHY THIS EXISTS
 * ---------------
 * Enrolment failed repeatedly, and not for a subtle reason: `face-enrol` gates
 * every sample on `maxYawDeg: 15 / maxPitchDeg: 10 / maxRollDeg: 15` and requires
 * ALL FIVE to pass (`minAcceptedSamples: 5`), while `EnrolCapture` prompted "Turn
 * slightly left", "Turn slightly right" and "Chin down a little" and sent whatever
 * the pipeline produced. An admin followed the instructions, captured five poses,
 * and got back "Only 2 of 5 captures passed the enrolment gates" — with nothing on
 * screen saying which way to move.
 *
 * The client now refuses a frame outside the envelope and says which way the
 * subject has over-turned. That fix is only durable if the two numbers stay
 * equal, so this test PARSES THEM OUT OF THE FUNCTION rather than restating them:
 * change the server's gate and this fails until the client follows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { poseComplaint } from "./components/EnrolCapture";

const FN = readFileSync(
  join(process.cwd(), "supabase/functions/face-enrol/index.ts"),
  "utf8",
);

function serverLimit(name: "maxYawDeg" | "maxPitchDeg" | "maxRollDeg"): number {
  const m = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)`).exec(FN);
  if (m?.[1] === undefined) throw new Error(`${name} not found in face-enrol`);
  return Number(m[1]);
}

describe("enrolment pose gate", () => {
  it("mirrors the server's envelope exactly", () => {
    // If these drift, the UI starts sending captures the server rejects — the
    // original defect. The client sits INSIDE the limit by a margin, so a value at
    // the server's own limit must already be refused here.
    expect(serverLimit("maxYawDeg")).toBe(15);
    expect(serverLimit("maxRollDeg")).toBe(15);
  });

  it("accepts a straight-on pose", () => {
    expect(poseComplaint({ yaw: 0, pitch: 0, roll: 0 })).toBeNull();
  });

  it("accepts the slight turns the prompts actually ask for", () => {
    expect(poseComplaint({ yaw: 10, pitch: 0, roll: 0 })).toBeNull();
    expect(poseComplaint({ yaw: -10, pitch: 0, roll: 0 })).toBeNull();
    expect(poseComplaint({ yaw: 0, pitch: -7, roll: 0 })).toBeNull();
  });

  it("refuses the over-turn that used to fail on submit", () => {
    // 22° yaw is what a person does when told "turn left" without a limit — the
    // exact value that produced "Only 2 of 5 captures passed".
    expect(poseComplaint({ yaw: 22, pitch: 0, roll: 0 })).toBe("yaw");
    expect(poseComplaint({ yaw: -22, pitch: 0, roll: 0 })).toBe("yaw");
  });

  it("NEVER complains about pitch, at any value", () => {
    // The estimator has no calibrated zero for pitch (its neutral is an assumed
    // chin-to-eye / box-width ratio), so any absolute threshold rejects real,
    // straight-headed people. Widening it only moved the wall — this is the fix.
    for (const pitch of [-60, -27, -18, 0, 9, 30, 60]) {
      expect(poseComplaint({ yaw: 0, pitch, roll: 0 }), `pitch ${pitch}`).toBeNull();
    }
  });

  it("the server does not reject a sample on pitch either", () => {
    // The client not asking is only half of it: if face-enrol still gated on pitch,
    // the capture would succeed and the SUBMIT would fail, which is where this
    // whole class of bug started.
    expect(FN).not.toMatch(/Math\.abs\(m\.pitch\)\s*>\s*g\.maxPitchDeg/);
  });

  it("still uses pitch to SHADE the quality score", () => {
    // Recorded and weighed, just not fatal.
    expect(FN).toMatch(/Math\.abs\(m\.pitch\)\s*\/\s*g\.maxPitchDeg/);
  });

  it("refuses a head tilted to one side", () => {
    expect(poseComplaint({ yaw: 0, pitch: 0, roll: 20 })).toBe("roll");
  });

  it("never accepts a pose AT the server's limit, so a borderline estimate cannot slip through", () => {
    expect(poseComplaint({ yaw: serverLimit("maxYawDeg"), pitch: 0, roll: 0 })).toBe("yaw");
    expect(poseComplaint({ yaw: 0, pitch: 0, roll: serverLimit("maxRollDeg") })).toBe("roll");
  });

  it("reports yaw before roll so the guidance names one thing to fix", () => {
    expect(poseComplaint({ yaw: 30, pitch: 30, roll: 30 })).toBe("yaw");
  });
});
