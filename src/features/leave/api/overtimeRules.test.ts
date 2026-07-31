/**
 * The two formulas the comp-off screen now explains, pinned against the engine.
 *
 * These mirror `fn_rollup_attendance_day` step 10 and `fn_rollup_comp_off` (migrations
 * 018 and 037600). If a migration changes one of them, one of these fails — which is the
 * point: a screen that explains a formula is a second implementation of it, and the only
 * defence against the two drifting is a test that states the engine's answer.
 */
import { describe, expect, it } from "vitest";
import { compOffDaysFor, overtimeFor, type OvertimeRules } from "./overtimeRules.api";

/** The venue's General shift and a policy with the deployed defaults. */
const RULES: OvertimeRules = {
  policy: {
    id: "p1",
    code: "GEN",
    name: "General",
    overtime_enabled: true,
    overtime_min_minutes: 30,
    overtime_rounding_minutes: 15,
    max_overtime_minutes_per_day: 240,
    comp_off_min_minutes: 240,
    comp_off_full_day_minutes: 480,
    comp_off_expiry_days: 90,
  },
  shift: {
    id: "s1",
    name: "General",
    start_time: "09:30:00",
    end_time: "18:30:00",
    duration_minutes: 480,
    ot_threshold_minutes: 30,
    grace_in_minutes: 5,
    grace_out_minutes: 10,
  },
};

describe("overtimeFor", () => {
  it("gives nothing for a day inside the shift", () => {
    const out = overtimeFor(480, RULES, false);
    expect(out.minutes).toBe(0);
    expect(out.reason).toBe("below_minimum");
  });

  it("ignores the threshold before overtime starts at all", () => {
    // 480 shift + 30 threshold = 510 before a single minute counts.
    expect(overtimeFor(510, RULES, false).minutes).toBe(0);
  });

  it("discards a surplus below the policy minimum rather than rounding it up", () => {
    // 20 minutes past the threshold, minimum is 30.
    const out = overtimeFor(530, RULES, false);
    expect(out.surplus).toBe(20);
    expect(out.minutes).toBe(0);
    expect(out.reason).toBe("below_minimum");
  });

  it("rounds DOWN to the rounding step once the minimum is met", () => {
    // surplus 40 → floor(40/15)*15 = 30.
    const out = overtimeFor(550, RULES, false);
    expect(out.surplus).toBe(40);
    expect(out.minutes).toBe(30);
    expect(out.reason).toBe("counted");
  });

  it("caps at the policy's daily maximum", () => {
    // surplus 490 would round to 480, cap is 240.
    expect(overtimeFor(1000, RULES, false).minutes).toBe(240);
  });

  it("is ZERO on a weekly off or holiday — that day earns comp-off, not overtime", () => {
    const out = overtimeFor(600, RULES, true);
    expect(out.minutes).toBe(0);
    expect(out.reason).toBe("off_day");
  });

  it("cannot be computed without a shift", () => {
    const out = overtimeFor(600, { ...RULES, shift: null }, false);
    expect(out.eligible).toBe(false);
    expect(out.reason).toBe("no_shift");
  });

  it("is zero when the policy switches overtime off", () => {
    const disabled: OvertimeRules = {
      ...RULES,
      policy: { ...RULES.policy!, overtime_enabled: false },
    };
    expect(overtimeFor(600, disabled, false).reason).toBe("disabled");
  });

  it("never reports a negative surplus", () => {
    expect(overtimeFor(60, RULES, false).surplus).toBe(0);
  });
});

describe("compOffDaysFor", () => {
  it("earns nothing below the minimum", () => {
    const out = compOffDaysFor(239, RULES);
    expect(out.days).toBe(0);
    expect(out.reason).toBe("below_minimum");
  });

  it("earns half a day at exactly the minimum", () => {
    expect(compOffDaysFor(240, RULES)).toEqual({ days: 0.5, reason: "half" });
  });

  it("still earns only half a day just short of a full one", () => {
    expect(compOffDaysFor(479, RULES).days).toBe(0.5);
  });

  it("earns a full day at exactly the full-day threshold", () => {
    expect(compOffDaysFor(480, RULES)).toEqual({ days: 1, reason: "full" });
  });

  it("never earns more than one day, however long the shift ran", () => {
    expect(compOffDaysFor(1440, RULES).days).toBe(1);
  });

  it("falls back to the engine's own defaults when no policy resolves", () => {
    const none: OvertimeRules = { policy: null, shift: RULES.shift };
    // 240 / 480 are the defaults declared in fn_rollup_comp_off.
    expect(compOffDaysFor(239, none).days).toBe(0);
    expect(compOffDaysFor(240, none).days).toBe(0.5);
    expect(compOffDaysFor(480, none).days).toBe(1);
  });
});
