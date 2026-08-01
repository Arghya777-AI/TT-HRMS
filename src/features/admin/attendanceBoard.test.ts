/**
 * The attendance board's two-source normaliser.
 *
 * The defect this guards is subtle and would be invisible on screen: the live view and the
 * historical view answer different questions, and a board that treated a missing live flag
 * as `false` would state confidently that somebody was "not overdue" on a day that finished
 * three weeks ago. Null means the question does not apply; false means it was asked and
 * answered. That distinction is the whole reason this module exists.
 */
import { describe, expect, it } from "vitest";
import {
  stepScope,
  fromDayRecord,
  fromTodayBoard,
  isLiveScope,
  monthOf,
  rangeFor,
  type BoardScope,
} from "./attendanceBoard";
import type { DayRow, TodayBoardRow } from "./api/attendance.api";

const TODAY_ROW = {
  employee_id: "e1",
  employee_code: "TT0001",
  display_name: "Asha Rao",
  department_name: "Front Office",
  ist_date: "2026-08-01",
  status: "present",
  shift_code: "G",
  expected_by: "2026-08-01T04:05:00Z",
  first_in_hm: "09:34",
  last_out_hm: "18:41",
  punch_count: 4,
  worked_minutes: 487,
  is_late: true,
  late_minutes: 4,
  overtime_minutes: 30,
  approved_overtime_minutes: 0,
  extra_work_minutes: 0,
  early_exit_minutes: 0,
  yet_to_reach: false,
  overdue: false,
} as unknown as TodayBoardRow;

const DAY_ROW = {
  employee_id: "e1",
  employee_code: "TT0001",
  display_name: "Asha Rao",
  department_name: "Front Office",
  ist_date: "2026-07-14",
  status: "present",
  shift_code: "G",
  first_in_hm: "09:28",
  last_out_hm: "19:02",
  punch_count: 2,
  total_worked_minutes: 514,
  is_late: false,
  late_minutes: 0,
  overtime_minutes: 45,
  approved_overtime_minutes: 45,
  early_exit_minutes: 0,
} as unknown as DayRow;

describe("fromTodayBoard", () => {
  it("carries the live flags, because today is when they mean something", () => {
    const row = fromTodayBoard(TODAY_ROW);
    expect(row.yetToReach).toBe(false);
    expect(row.overdue).toBe(false);
    expect(row.expectedBy).toBe("2026-08-01T04:05:00Z");
  });

  it("copies lateness from the server rather than deriving it", () => {
    const row = fromTodayBoard(TODAY_ROW);
    expect(row.isLate).toBe(true);
    expect(row.lateMinutes).toBe(4);
  });

  it("treats a null overtime column as zero minutes, not as missing", () => {
    const noOt = { ...TODAY_ROW, overtime_minutes: null } as unknown as TodayBoardRow;
    expect(fromTodayBoard(noOt).overtimeMinutes).toBe(0);
  });
});

describe("fromDayRecord", () => {
  it("leaves the live flags NULL — the day is over, so the question does not apply", () => {
    const row = fromDayRecord(DAY_ROW);
    expect(row.yetToReach).toBeNull();
    expect(row.overdue).toBeNull();
    expect(row.expectedBy).toBeNull();
  });

  it("does not report false for a live flag, which would be a confident wrong answer", () => {
    const row = fromDayRecord(DAY_ROW);
    expect(row.overdue).not.toBe(false);
    expect(row.yetToReach).not.toBe(false);
  });

  it("reads worked minutes from the historical column name", () => {
    expect(fromDayRecord(DAY_ROW).workedMinutes).toBe(514);
  });

  it("keeps approved overtime separate from computed overtime", () => {
    const row = fromDayRecord(DAY_ROW);
    expect(row.overtimeMinutes).toBe(45);
    expect(row.approvedOvertimeMinutes).toBe(45);
  });

  it("produces the same shape as the live source, field for field", () => {
    expect(Object.keys(fromDayRecord(DAY_ROW)).sort()).toEqual(
      Object.keys(fromTodayBoard(TODAY_ROW)).sort(),
    );
  });
});

describe("isLiveScope", () => {
  const today = "2026-08-01";

  it("is live only for today as a single day", () => {
    expect(isLiveScope({ kind: "day", date: today }, today)).toBe(true);
  });

  it("is not live for another day", () => {
    expect(isLiveScope({ kind: "day", date: "2026-07-14" }, today)).toBe(false);
  });

  it("is NOT live for the current month — the live view returns one row per employee", () => {
    // A month scope served by the today view would silently drop 30 days of the month.
    expect(isLiveScope({ kind: "month", month: "2026-08" }, today)).toBe(false);
  });
});

describe("rangeFor", () => {
  it("makes a single day an inclusive one-day range", () => {
    expect(rangeFor({ kind: "day", date: "2026-07-14" })).toEqual({
      from: "2026-07-14",
      to: "2026-07-14",
    });
  });

  it("covers a whole month", () => {
    expect(rangeFor({ kind: "month", month: "2026-08" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });

  it("uses a 31-day upper bound even in February, which cannot exclude a real day", () => {
    const range = rangeFor({ kind: "month", month: "2026-02" });
    expect(range.from).toBe("2026-02-01");
    expect(range.to).toBe("2026-02-31");
    // A date comparison against an impossible day still admits every real one.
    expect("2026-02-28" <= range.to).toBe(true);
    expect("2026-03-01" <= range.to).toBe(false);
  });

  it("handles a December month without rolling the year", () => {
    expect(rangeFor({ kind: "month", month: "2026-12" })).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });
});

describe("monthOf", () => {
  it("takes the month key off a date", () => {
    expect(monthOf("2026-08-01")).toBe("2026-08");
  });

  it("is stable for the scope round trip", () => {
    const scope: BoardScope = { kind: "month", month: monthOf("2026-12-25") };
    expect(rangeFor(scope).from).toBe("2026-12-01");
  });
});

describe("stepScope", () => {
  it("steps a day forward and back", () => {
    expect(stepScope({ kind: "day", date: "2026-08-01" }, 1)).toEqual({
      kind: "day",
      date: "2026-08-02",
    });
    expect(stepScope({ kind: "day", date: "2026-08-01" }, -1)).toEqual({
      kind: "day",
      date: "2026-07-31",
    });
  });

  it("crosses a month boundary on a day step", () => {
    expect(stepScope({ kind: "day", date: "2026-07-31" }, 1)).toEqual({
      kind: "day",
      date: "2026-08-01",
    });
  });

  it("crosses a year boundary on a day step", () => {
    expect(stepScope({ kind: "day", date: "2026-12-31" }, 1)).toEqual({
      kind: "day",
      date: "2027-01-01",
    });
  });

  it("handles a leap day, which a naive +1 month would skip", () => {
    expect(stepScope({ kind: "day", date: "2028-02-28" }, 1)).toEqual({
      kind: "day",
      date: "2028-02-29",
    });
  });

  it("steps a month forward and back", () => {
    expect(stepScope({ kind: "month", month: "2026-08" }, 1)).toEqual({
      kind: "month",
      month: "2026-09",
    });
    expect(stepScope({ kind: "month", month: "2026-08" }, -1)).toEqual({
      kind: "month",
      month: "2026-07",
    });
  });

  it("carries the YEAR on a December step forward", () => {
    expect(stepScope({ kind: "month", month: "2026-12" }, 1)).toEqual({
      kind: "month",
      month: "2027-01",
    });
  });

  it("carries the YEAR on a January step back", () => {
    expect(stepScope({ kind: "month", month: "2026-01" }, -1)).toEqual({
      kind: "month",
      month: "2025-12",
    });
  });

  it("keeps a two-digit month zero-padded", () => {
    expect(stepScope({ kind: "month", month: "2026-09" }, 1).kind).toBe("month");
    expect(stepScope({ kind: "month", month: "2026-09" }, 1)).toEqual({
      kind: "month",
      month: "2026-10",
    });
  });

  it("survives a twelve-step round trip", () => {
    let scope = { kind: "month", month: "2026-03" } as const as ReturnType<typeof stepScope>;
    for (let i = 0; i < 12; i += 1) scope = stepScope(scope, 1);
    expect(scope).toEqual({ kind: "month", month: "2027-03" });
  });
});
