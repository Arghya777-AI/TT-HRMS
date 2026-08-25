/**
 * The surplus/shortfall arithmetic, which has to survive being checked by hand.
 *
 * "You were short forty minutes last month" is a sentence somebody will dispute, so the cases
 * that matter here are the ones where a naive `worked − shift` gives an answer that is not
 * merely imprecise but unfair: a holiday, a granted leave day, and a day the engine has not
 * computed yet. Each of those would read as a full shift's shortfall.
 */
import { describe, expect, it } from "vitest";
import { consequences, dayVariance, fmtSignedMinutes, periodVariance } from "./variance";
import type { AttendanceDay, AttendancePeriodSummary } from "../api/attendance.api";

/** A resolved, ordinary working day with a 9-hour shift. Overridden per case. */
function day(over: Partial<AttendanceDay> = {}): AttendanceDay {
  return {
    id: "d1",
    employee_id: "e1",
    employee_code: "TT0001",
    display_name: "Test",
    photo_path: null,
    ist_date: "2026-08-03",
    status: "present",
    status_source: "computed",
    department_name: null,
    section_name: null,
    designation_name: null,
    location_name: null,
    shift_id: "s1",
    shift_code: "GEN",
    shift_display_label: "General",
    shift_start_at: null,
    shift_end_at: null,
    shift_duration_minutes: 540,
    manager_id: null,
    manager_name: null,
    holiday_id: null,
    holiday_name: null,
    leave_type_id: null,
    leave_type_code: null,
    leave_type_name: null,
    leave_request_id: null,
    leave_day_fraction: null,
    first_in_at: null,
    last_out_at: null,
    first_in_hm: null,
    last_out_hm: null,
    punch_count: 2,
    gross_span_minutes: null,
    break_minutes: null,
    break_count: null,
    total_worked_minutes: 540,
    payable_worked_minutes: 540,
    worked_hm: null,
    is_late: false,
    late_minutes: null,
    late_hm: null,
    is_early_exit: false,
    early_exit_minutes: null,
    overtime_minutes: null,
    approved_overtime_minutes: null,
    extra_work_minutes: null,
    day_fraction_paid: null,
    late_deduction_leave_days: null,
    is_holiday: false,
    is_weekly_off: false,
    is_working_day: true,
    manual_override_status: null,
    manual_override_times: null,
    manual_override_reason: null,
    is_regularized: false,
    regularization_id: null,
    anomaly_flags: null,
    has_anomalies: null,
    is_locked: false,
    computed_at: null,
    computed_version: null,
    ...over,
  } as AttendanceDay;
}

describe("a single day", () => {
  it("is level when the shift was met exactly", () => {
    const v = dayVariance(day());
    expect(v.expectedMinutes).toBe(540);
    expect(v.varianceMinutes).toBe(0);
    expect(v.counts).toBe(true);
  });

  it("is short when they left early", () => {
    expect(dayVariance(day({ payable_worked_minutes: 480 })).varianceMinutes).toBe(-60);
  });

  it("is ahead when they stayed on", () => {
    expect(dayVariance(day({ payable_worked_minutes: 600 })).varianceMinutes).toBe(60);
  });

  it("prefers payable over total, which is the figure the WORKED column shows", () => {
    // Breaks and policy are already applied to payable; using total would disagree with the
    // column immediately to its left.
    const v = dayVariance(day({ total_worked_minutes: 600, payable_worked_minutes: 540 }));
    expect(v.workedMinutes).toBe(540);
  });
});

describe("days a naive subtraction would get wrong", () => {
  it("does not count a pending day as a full shift short", () => {
    /*
      The case from the screenshot that prompted this: nineteen of twenty-five days were "Not
      processed yet". Subtracting a 540-minute shift from zero worked would have reported that
      month as 171 hours behind.
    */
    const v = dayVariance(day({ status: "pending", payable_worked_minutes: null, total_worked_minutes: null }));
    expect(v.counts).toBe(false);
    expect(v.reason).toBe("unresolved");
    expect(v.varianceMinutes).toBe(0);
  });

  it("does not punish somebody for approved leave", () => {
    const v = dayVariance(
      day({
        status: "on_leave",
        leave_type_id: "lt1",
        leave_day_fraction: 1,
        payable_worked_minutes: 0,
      }),
    );
    // Nothing was expected, so nothing is owed.
    expect(v.expectedMinutes).toBe(0);
    expect(v.varianceMinutes).toBe(0);
  });

  it("expects half a shift on a half-day leave", () => {
    const v = dayVariance(
      day({
        status: "on_leave_half",
        leave_type_id: "lt1",
        leave_day_fraction: 0.5,
        payable_worked_minutes: 270,
      }),
    );
    expect(v.expectedMinutes).toBe(270);
    expect(v.varianceMinutes).toBe(0);
  });

  it("treats a holiday worked as all surplus", () => {
    const v = dayVariance(
      day({ status: "holiday_worked", is_holiday: true, payable_worked_minutes: 300 }),
    );
    // Not "300 against 540". Nothing was asked for, so all of it is extra.
    expect(v.expectedMinutes).toBe(0);
    expect(v.varianceMinutes).toBe(300);
  });

  it("treats a weekly off worked the same way", () => {
    const v = dayVariance(
      day({ status: "weekly_off_worked", is_weekly_off: true, payable_worked_minutes: 240 }),
    );
    expect(v.varianceMinutes).toBe(240);
  });

  it("counts nothing at all outside employment", () => {
    for (const status of ["not_yet_joined", "post_exit", "suspended"] as const) {
      const v = dayVariance(day({ status, payable_worked_minutes: 0 }));
      expect(v.counts, status).toBe(false);
      expect(v.varianceMinutes, status).toBe(0);
    }
  });

  it("does not credit a comp-off day twice", () => {
    /*
      The surplus that earned the comp-off was already counted on the day it was worked.
      Crediting the day off as well would pay the same extra work into the total twice.
    */
    const v = dayVariance(day({ status: "comp_off_availed", payable_worked_minutes: 0 }));
    expect(v.counts).toBe(false);
  });

  it("survives a day with every minute field null", () => {
    const v = dayVariance(
      day({ payable_worked_minutes: null, total_worked_minutes: null, shift_duration_minutes: null }),
    );
    // No NaN reaches a screen.
    expect(Number.isFinite(v.varianceMinutes)).toBe(true);
    expect(v.varianceMinutes).toBe(0);
  });
});

describe("a month", () => {
  it("keeps surplus and shortfall separate as well as netted", () => {
    const rolled = periodVariance([
      day({ payable_worked_minutes: 660 }), // +2h
      day({ payable_worked_minutes: 420 }), // −2h
      day({ payable_worked_minutes: 540 }), // level
    ]);
    // Netting alone would say "0" and hide four hours of movement.
    expect(rolled.varianceMinutes).toBe(0);
    expect(rolled.surplusMinutes).toBe(120);
    expect(rolled.shortfallMinutes).toBe(120);
    expect(rolled.surplusDays).toBe(1);
    expect(rolled.shortfallDays).toBe(1);
    expect(rolled.countedDays).toBe(3);
  });

  it("reports unresolved days rather than absorbing them", () => {
    const rolled = periodVariance([
      day({ payable_worked_minutes: 540 }),
      day({ status: "pending", payable_worked_minutes: null }),
      day({ status: "pending", payable_worked_minutes: null }),
    ]);
    expect(rolled.countedDays).toBe(1);
    expect(rolled.unresolvedDays).toBe(2);
    // A month that is mostly unresolved must not read as a month that was mostly on target.
    expect(rolled.varianceMinutes).toBe(0);
  });

  it("is empty-safe", () => {
    const rolled = periodVariance([]);
    expect(rolled.varianceMinutes).toBe(0);
    expect(rolled.countedDays).toBe(0);
  });
});

describe("what it means for the person", () => {
  const summary = (over: Partial<AttendancePeriodSummary> = {}): AttendancePeriodSummary =>
    ({
      employee_id: "e1",
      from_date: "2026-08-01",
      to_date: "2026-08-31",
      total_days: 31,
      present_days: 20,
      half_days: 0,
      absent_days: 0,
      pending_days: 5,
      weekly_off_days: 4,
      holiday_days: 2,
      leave_days: 0,
      comp_off_days: 1,
      paid_days: 26,
      working_days: 25,
      late_days: 3,
      late_minutes: 45,
      early_exit_days: 0,
      early_exit_minutes: 0,
      overtime_minutes: 60,
      approved_overtime_minutes: 30,
      extra_work_minutes: 120,
      total_worked_minutes: 10_000,
      avg_worked_minutes_per_present_day: null,
      avg_worked_minutes_per_working_day: null,
      late_pct: null,
      attendance_pct: null,
      late_deduction_leave_days: 0.5,
      break_minutes: 0,
      break_count: 0,
      avg_breaks_per_present_day: null,
      ...over,
    }) as AttendancePeriodSummary;

  it("reads comp-off and deductions from the engine rather than inventing them", () => {
    /*
      Both are policy decisions applied server-side. Deriving them from minutes here would put a
      number on an employee's screen that payroll does not recognise.
    */
    const c = consequences(summary(), periodVariance([]));
    expect(c.compOffDays).toBe(1);
    expect(c.lateDeductionLeaveDays).toBe(0.5);
  });

  it("shows surplus the engine did not count as overtime, as its own figure", () => {
    const rolled = periodVariance([
      day({ payable_worked_minutes: 660 }), // +120 surplus
    ]);
    const c = consequences(summary({ overtime_minutes: 60 }), rolled);
    // 120 worked over, 60 recognised → 60 that will not be paid. Named, not folded into either.
    expect(c.unrecognisedSurplusMinutes).toBe(60);
    expect(c.overtimeMinutes).toBe(60);
  });

  it("never reports negative unrecognised surplus", () => {
    // Approved overtime can exceed the raw surplus (a rounding policy, a manual grant).
    const c = consequences(summary({ overtime_minutes: 600 }), periodVariance([]));
    expect(c.unrecognisedSurplusMinutes).toBe(0);
  });
});

describe("the signed display", () => {
  it("makes the direction unmistakable at a glance", () => {
    expect(fmtSignedMinutes(0)).toBe("0m");
    expect(fmtSignedMinutes(45)).toBe("+45m");
    expect(fmtSignedMinutes(-45)).toBe("−45m");
    expect(fmtSignedMinutes(60)).toBe("+1h");
    expect(fmtSignedMinutes(-80)).toBe("−1h 20m");
    expect(fmtSignedMinutes(561)).toBe("+9h 21m");
  });

  it("uses a true minus sign, which sits correctly beside digits", () => {
    expect(fmtSignedMinutes(-45).startsWith("−")).toBe(true);
  });
});
