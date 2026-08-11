/**
 * teamDaySchema against the row `v_attendance_day_enriched` actually returns.
 *
 * WHY THIS EXISTS. `manual_override_status` was declared `z.string()` while the
 * column is `boolean NOT NULL` (017 §attendance_days), and the view passes it
 * through untouched. Nothing caught it: typecheck cannot see across the network,
 * and zod only fails on a row it is given — so the Team Attendance grid worked
 * perfectly for as long as it had NO ROWS, then broke the first day somebody's
 * team had an absence, with "Expected string, received boolean" where the grid
 * should be.
 *
 * The fixture below is the view's own shape: every `is_*` is a boolean, every
 * `*_minutes` an integer, `anomaly_flags` a text[]. If a column's declared type
 * drifts from that again, this fails in CI rather than on somebody's screen.
 */
import { describe, expect, it } from "vitest";
import { teamDaySchema } from "./team.api";

/** One row as Postgres sends it — types from the base table, not from hope. */
const ROW = {
  id: "3f1d6f9e-0c2a-4f6b-9a3d-1b2c3d4e5f60",
  employee_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  employee_code: "TT0018",
  display_name: "Testing Kumar",
  ist_date: "2026-08-11",
  status: "absent",
  status_source: "engine",
  department_name: "Management",
  shift_code: null,
  first_in_hm: null,
  last_out_hm: null,
  punch_count: 0,
  total_worked_minutes: 0,
  worked_hm: "0:00",
  is_late: false,
  late_minutes: 0,
  late_hm: "0:00",
  is_early_exit: false,
  early_exit_minutes: 0,
  overtime_minutes: 0,
  approved_overtime_minutes: 0,
  is_weekly_off: false,
  is_holiday: false,
  is_working_day: true,
  holiday_name: null,
  leave_type_name: null,
  anomaly_flags: [],
  has_anomalies: false,
  is_regularized: false,
  // The one that was wrong. boolean NOT NULL DEFAULT false.
  manual_override_status: false,
  is_locked: false,
};

describe("teamDaySchema", () => {
  it("accepts the row the view returns", () => {
    const parsed = teamDaySchema.safeParse(ROW);
    expect(parsed.success).toBe(true);
  });

  it("accepts an overridden day", () => {
    // HR having set the status by hand is the case that carries `true`, and it
    // is the one nobody had on screen while the declaration was wrong.
    expect(teamDaySchema.safeParse({ ...ROW, manual_override_status: true }).success).toBe(true);
  });

  it("refuses a string where the column is boolean", () => {
    /*
      The inverse of the bug: if somebody "fixes" a future parse failure by
      widening this back to a string, the fixture above stops proving anything.
      This keeps the declaration honest in both directions.
    */
    expect(teamDaySchema.safeParse({ ...ROW, manual_override_status: "false" }).success).toBe(false);
  });

  it("accepts the nullable columns as null", () => {
    // Everything that comes through a LEFT JOIN in the view can be null.
    const sparse = {
      ...ROW,
      shift_code: null,
      department_name: null,
      holiday_name: null,
      leave_type_name: null,
      anomaly_flags: null,
      manual_override_status: null,
    };
    expect(teamDaySchema.safeParse(sparse).success).toBe(true);
  });
});
