/**
 * analyticsAggregate.test.ts — the arithmetic behind every analytics figure,
 * pinned to hand-computed values.
 *
 * WHY THIS TEST EXISTS AT ALL
 * ---------------------------
 * PostgREST cannot GROUP BY, so the analytics rollups are computed in the
 * browser (see the header of analyticsAggregate.ts). That is a deliberate,
 * documented exception to the repo's "the number is the server's" rule, and the
 * price of the exception is this file: every mean, every denominator and every
 * empty-set case is exercised here with literals, so the maths is checked
 * without a database, without a clock and without a network.
 *
 * The cases that actually break dashboards, all covered below:
 *   * an EMPTY period — averages must be null, not 0, not NaN;
 *   * a NULL clock (someone scanned in and never out) — must be skipped, not
 *     read as midnight;
 *   * DIVISION BY ZERO — nobody attended, nobody was late, no rows at all;
 *   * the DENOMINATOR — averaging worked minutes over absences and weekly offs
 *     is the single commonest way a real 8-hour team is reported as a 4-hour one;
 *   * the MIDNIGHT CROSSING — this venue runs a 19:00→07:00 night shift, and a
 *     naive average puts its leaving time before its arrival time.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_MEASURES,
  EMPTY_TODAY_TILES,
  aggregateDailyTrend,
  aggregateEmployeeDetail,
  aggregateMeasures,
  classifyDayStatus,
  dayClockMinutes,
  groupByDepartment,
  groupByEmployee,
  hmToMinutes,
  MAX_TREND_POINTS,
  meanIgnoringNulls,
  summariseTodayBoard,
  type AnalyticsDayRow,
  type TodayBoardFlags,
} from "./analyticsAggregate";
import { addDays } from "@/lib/period";
import type { Period } from "@/lib/period";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/**
 * A plain present day. Every test overrides only the fields it is about, so a
 * failure names the measure that broke rather than a wall of literals.
 */
function day(over: Partial<AnalyticsDayRow> = {}): AnalyticsDayRow {
  return {
    employee_id: "e1",
    employee_code: "TT-001",
    display_name: "Asha Nair",
    ist_date: "2026-07-01",
    status: "present",
    department_name: "Kitchen",
    location_name: "Main venue",
    first_in_hm: "09:00",
    last_out_hm: "18:00",
    punch_count: 2,
    gross_span_minutes: 540,
    break_minutes: 60,
    break_count: 1,
    total_worked_minutes: 480,
    is_late: false,
    late_minutes: 0,
    is_early_exit: false,
    early_exit_minutes: 0,
    overtime_minutes: 0,
    approved_overtime_minutes: 0,
    leave_type_name: null,
    leave_day_fraction: 0,
    is_holiday: false,
    is_weekly_off: false,
    is_working_day: true,
    has_anomalies: false,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// meanIgnoringNulls — the guard everything else is built on
// -----------------------------------------------------------------------------

describe("meanIgnoringNulls", () => {
  it("returns null for an empty list rather than dividing by zero", () => {
    expect(meanIgnoringNulls([])).toBeNull();
  });

  it("returns null when every value is absent", () => {
    // NOT 0. "Nobody scanned out" and "everybody scanned out at midnight" are
    // different facts, and only one of them is true.
    expect(meanIgnoringNulls([null, undefined, null])).toBeNull();
  });

  it("ignores nulls in the denominator, not just the numerator", () => {
    // (10 + 20) / 2, never / 4.
    expect(meanIgnoringNulls([10, null, 20, undefined])).toBe(15);
  });

  it("refuses NaN and Infinity as samples", () => {
    expect(meanIgnoringNulls([10, Number.NaN, 20, Number.POSITIVE_INFINITY])).toBe(15);
    expect(meanIgnoringNulls([Number.NaN])).toBeNull();
  });

  it("averages a single value to itself", () => {
    expect(meanIgnoringNulls([7])).toBe(7);
  });

  it("does not round — rounding twice is how a column stops adding up", () => {
    expect(meanIgnoringNulls([1, 2])).toBe(1.5);
    expect(meanIgnoringNulls([10, 11])).toBe(10.5);
  });
});

// -----------------------------------------------------------------------------
// Clock parsing
// -----------------------------------------------------------------------------

describe("hmToMinutes", () => {
  it("parses the view's IST wall clock", () => {
    expect(hmToMinutes("00:00")).toBe(0);
    expect(hmToMinutes("09:15")).toBe(555);
    expect(hmToMinutes("23:59")).toBe(1439);
  });

  it("returns null for absent or malformed input, never 0", () => {
    // 0 is a real time. Confusing "no scan" with "scanned at midnight" would put
    // a phantom 00:00 into every average-arrival figure.
    expect(hmToMinutes(null)).toBeNull();
    expect(hmToMinutes(undefined)).toBeNull();
    expect(hmToMinutes("")).toBeNull();
    expect(hmToMinutes("9am")).toBeNull();
    expect(hmToMinutes("24:00")).toBeNull();
    expect(hmToMinutes("09:60")).toBeNull();
  });
});

describe("dayClockMinutes", () => {
  it("keeps a normal day as-is", () => {
    expect(dayClockMinutes({ first_in_hm: "09:00", last_out_hm: "18:00" })).toEqual({
      firstIn: 540,
      lastOut: 1080,
    });
  });

  it("rolls a night shift's out-time past midnight", () => {
    // SEC-N: in 19:00, out 07:00 next morning, still one business date.
    // 07:00 must read as 1860 (31h from the business date's midnight), not 420 —
    // otherwise the average leaving time lands BEFORE the average arrival.
    expect(dayClockMinutes({ first_in_hm: "19:00", last_out_hm: "07:00" })).toEqual({
      firstIn: 1140,
      lastOut: 1860,
    });
  });

  it("leaves a single-punch day's out-time null", () => {
    expect(dayClockMinutes({ first_in_hm: "09:00", last_out_hm: null })).toEqual({
      firstIn: 540,
      lastOut: null,
    });
  });

  it("does not roll an out-time when there is no in-time to compare it with", () => {
    expect(dayClockMinutes({ first_in_hm: null, last_out_hm: "07:00" })).toEqual({
      firstIn: null,
      lastOut: 420,
    });
  });
});

// -----------------------------------------------------------------------------
// Status classification
// -----------------------------------------------------------------------------

describe("classifyDayStatus", () => {
  it("counts every worked form of day as present", () => {
    for (const s of ["present", "half_day", "on_duty", "work_from_home"] as const) {
      expect(classifyDayStatus(s)).toBe("present");
    }
    // Working a weekly off or a holiday is attendance, not time off.
    expect(classifyDayStatus("weekly_off_worked")).toBe("present");
    expect(classifyDayStatus("holiday_worked")).toBe("present");
  });

  it("never folds an unprocessed day into absences", () => {
    // The engine has not run for that date yet. Showing it as an absence is the
    // most damaging thing this dashboard could do to a person.
    expect(classifyDayStatus("pending")).toBe("pending");
    expect(classifyDayStatus("absent")).toBe("absent");
  });

  it("separates leave, holiday and weekly off", () => {
    expect(classifyDayStatus("on_leave")).toBe("leave");
    expect(classifyDayStatus("on_leave_half")).toBe("leave");
    expect(classifyDayStatus("comp_off_availed")).toBe("leave");
    expect(classifyDayStatus("holiday")).toBe("holiday");
    expect(classifyDayStatus("weekly_off")).toBe("weekly_off");
  });

  it("excludes days outside employment", () => {
    expect(classifyDayStatus("not_yet_joined")).toBe("not_counted");
    expect(classifyDayStatus("post_exit")).toBe("not_counted");
    expect(classifyDayStatus("suspended")).toBe("not_counted");
  });
});

// -----------------------------------------------------------------------------
// aggregateMeasures
// -----------------------------------------------------------------------------

describe("aggregateMeasures — empty input", () => {
  it("returns the zero/null measure set, not NaN", () => {
    const m = aggregateMeasures([]);
    expect(m).toEqual(EMPTY_MEASURES);
    expect(m.daysCounted).toBe(0);
    expect(m.employeeCount).toBe(0);
    // Every average is null. None of them is NaN and none of them is 0.
    expect(m.avgWorkedMinutes).toBeNull();
    expect(m.avgGrossSpanMinutes).toBeNull();
    expect(m.avgBreakMinutes).toBeNull();
    expect(m.avgLateMinutes).toBeNull();
    expect(m.avgFirstInMinutes).toBeNull();
    expect(m.avgLastOutMinutes).toBeNull();
  });
});

describe("aggregateMeasures — a single row", () => {
  it("reports the row's own values, with each average equal to the value", () => {
    const m = aggregateMeasures([
      day({
        total_worked_minutes: 500,
        gross_span_minutes: 560,
        break_minutes: 60,
        is_late: true,
        late_minutes: 12,
        overtime_minutes: 30,
        approved_overtime_minutes: 20,
      }),
    ]);
    expect(m.daysCounted).toBe(1);
    expect(m.employeeCount).toBe(1);
    expect(m.presentDays).toBe(1);
    expect(m.attendedDays).toBe(1);
    expect(m.workingDays).toBe(1);
    expect(m.totalWorkedMinutes).toBe(500);
    expect(m.avgWorkedMinutes).toBe(500);
    expect(m.avgGrossSpanMinutes).toBe(560);
    expect(m.avgBreakMinutes).toBe(60);
    expect(m.lateDays).toBe(1);
    expect(m.totalLateMinutes).toBe(12);
    expect(m.avgLateMinutes).toBe(12);
    expect(m.overtimeMinutes).toBe(30);
    expect(m.approvedOvertimeMinutes).toBe(20);
    expect(m.avgFirstInMinutes).toBe(540);
    expect(m.avgLastOutMinutes).toBe(1080);
  });
});

describe("aggregateMeasures — division-by-zero guards", () => {
  it("returns null duration averages when nobody scanned", () => {
    // Three absences: worked/span/break have no attended day to average over.
    const rows = [
      day({ status: "absent", punch_count: 0, gross_span_minutes: 0, break_minutes: 0, total_worked_minutes: 0, first_in_hm: null, last_out_hm: null }),
      day({ status: "absent", ist_date: "2026-07-02", punch_count: 0, gross_span_minutes: 0, break_minutes: 0, total_worked_minutes: 0, first_in_hm: null, last_out_hm: null }),
      day({ status: "absent", ist_date: "2026-07-03", punch_count: 0, gross_span_minutes: 0, break_minutes: 0, total_worked_minutes: 0, first_in_hm: null, last_out_hm: null }),
    ];
    const m = aggregateMeasures(rows);
    expect(m.daysCounted).toBe(3);
    expect(m.absentDays).toBe(3);
    expect(m.attendedDays).toBe(0);
    expect(m.avgWorkedMinutes).toBeNull();
    expect(m.avgGrossSpanMinutes).toBeNull();
    expect(m.avgBreakMinutes).toBeNull();
    // Totals still exist and are honestly zero — a total and an average differ.
    expect(m.totalWorkedMinutes).toBe(0);
  });

  it("returns a null late average when nobody was late", () => {
    const m = aggregateMeasures([day(), day({ ist_date: "2026-07-02" })]);
    expect(m.lateDays).toBe(0);
    expect(m.avgLateMinutes).toBeNull();
    expect(m.totalLateMinutes).toBe(0);
  });

  it("averages lateness over LATE days only, never over everybody", () => {
    // One person 20 minutes late, three punctual. The honest answer to "how late
    // are the late ones" is 20, not 5.
    const rows = [
      day({ is_late: true, late_minutes: 20 }),
      day({ ist_date: "2026-07-02" }),
      day({ ist_date: "2026-07-03" }),
      day({ ist_date: "2026-07-04" }),
    ];
    const m = aggregateMeasures(rows);
    expect(m.lateDays).toBe(1);
    expect(m.avgLateMinutes).toBe(20);
    expect(m.totalLateMinutes).toBe(20);
  });
});

describe("aggregateMeasures — nulls and denominators", () => {
  it("skips absent clocks instead of reading them as midnight", () => {
    // 09:00 and 10:00 are real; the third day has no scans at all. The average
    // arrival is 09:30 (570). Counting the missing day as 00:00 would say 06:20.
    const rows = [
      day({ first_in_hm: "09:00", last_out_hm: "18:00" }),
      day({ ist_date: "2026-07-02", first_in_hm: "10:00", last_out_hm: "19:00" }),
      day({
        ist_date: "2026-07-03",
        status: "absent",
        punch_count: 0,
        first_in_hm: null,
        last_out_hm: null,
        total_worked_minutes: 0,
        gross_span_minutes: 0,
        break_minutes: 0,
      }),
    ];
    const m = aggregateMeasures(rows);
    expect(m.avgFirstInMinutes).toBe(570); // (540 + 600) / 2
    expect(m.avgLastOutMinutes).toBe(1110); // (1080 + 1140) / 2
  });

  it("keeps a single-punch day out of the last-out average but in the first-in one", () => {
    // The engine nulls `last_out_at` when a day has exactly one scan
    // (`single_punch_only`). That day still tells us when they arrived.
    const rows = [
      day({ first_in_hm: "09:00", last_out_hm: "18:00" }),
      day({ ist_date: "2026-07-02", first_in_hm: "11:00", last_out_hm: null, punch_count: 1 }),
    ];
    const m = aggregateMeasures(rows);
    expect(m.avgFirstInMinutes).toBe(600); // (540 + 660) / 2 = 10:00
    expect(m.avgLastOutMinutes).toBe(1080); // the one real out-time
  });

  /*
    The single-scan day AS THE ENGINE ACTUALLY WRITES IT. The case above nulls
    `last_out_hm` but leaves the durations at their eight-hour default, which the
    engine cannot produce: `v_count = 1` sets `v_last := NULL`, and
    `util.minutes_between(first, NULL)` returns 0, so span and worked land as 0
    with `punch_count = 1`. Gating the duration means on `punch_count > 0` sampled
    those zeroes and halved a two-day average for one forgotten scan-out.
  */
  const singlePunchAsEngineWritesIt: Partial<AnalyticsDayRow> = {
    status: "half_day",
    punch_count: 1,
    last_out_hm: null,
    gross_span_minutes: 0,
    break_minutes: 0,
    break_count: 0,
    total_worked_minutes: 0,
    has_anomalies: true,
  };

  it("never samples a single-scan day's zero duration into the averages", () => {
    const rows = [
      day({ total_worked_minutes: 510, gross_span_minutes: 540, break_minutes: 30 }),
      day({ ist_date: "2026-07-02", ...singlePunchAsEngineWritesIt }),
    ];
    const m = aggregateMeasures(rows);

    // The full day is the only one that can answer "how long is a day here".
    expect(m.avgWorkedMinutes).toBe(510);
    expect(m.avgGrossSpanMinutes).toBe(540);
    expect(m.avgBreakMinutes).toBe(30);

    // Both counts are true and they are not the same count. That is the point:
    // the person attended twice and completed once.
    expect(m.attendedDays).toBe(2);
    expect(m.completedDays).toBe(1);

    // The totals still cover every row — a total is not an average.
    expect(m.totalWorkedMinutes).toBe(510);
  });

  it("gives the arrival and departure means their own denominators", () => {
    const rows = [
      day({ first_in_hm: "09:00", last_out_hm: "18:00" }),
      day({ ist_date: "2026-07-02", ...singlePunchAsEngineWritesIt, first_in_hm: "11:00" }),
    ];
    const m = aggregateMeasures(rows);
    // Two arrivals, one departure — so a screen printing "over 2 attended days"
    // beside the departure would overstate its sample by the missing scan-out.
    expect(m.firstInDays).toBe(2);
    expect(m.lastOutDays).toBe(1);
    expect(m.avgFirstInMinutes).toBe(600);
    expect(m.avgLastOutMinutes).toBe(1080);
  });

  it("caps the trend at MAX_TREND_POINTS even when rows fall outside the generated span", () => {
    // A hand-edited URL asking for a decade of DAILY points. The cap generates
    // 1500 dates; every later date holding a row is then a "stray" outside that
    // window, and appending them all walked the cap straight back up to 4,000.
    const rows: AnalyticsDayRow[] = [];
    for (let i = 1500; i < 4000; i += 1) {
      rows.push(day({ ist_date: addDays("2016-01-01", i) }));
    }
    const points = aggregateDailyTrend(rows, {
      granularity: "range",
      from: "2016-01-01",
      to: "2026-12-31",
    });
    expect(points.length).toBe(MAX_TREND_POINTS);
  });

  it("averages worked minutes over ATTENDED days, so time off does not dilute it", () => {
    /*
      Two eight-hour days, one weekly off, one holiday, one absence.
      Attended = 2, so avg worked = (480 + 480) / 2 = 480 — a real working day.
      Averaged over all five rows it would be 192, and an eight-hour kitchen
      would be reported as working three hours and twelve minutes.
    */
    const off = { punch_count: 0, total_worked_minutes: 0, gross_span_minutes: 0, break_minutes: 0, first_in_hm: null, last_out_hm: null };
    const rows = [
      day({ ist_date: "2026-07-01" }),
      day({ ist_date: "2026-07-02" }),
      day({ ist_date: "2026-07-03", status: "weekly_off", is_weekly_off: true, is_working_day: false, ...off }),
      day({ ist_date: "2026-07-04", status: "holiday", is_holiday: true, is_working_day: false, ...off }),
      day({ ist_date: "2026-07-05", status: "absent", ...off }),
    ];
    const m = aggregateMeasures(rows);
    expect(m.daysCounted).toBe(5);
    expect(m.attendedDays).toBe(2);
    expect(m.avgWorkedMinutes).toBe(480);
    expect(m.avgGrossSpanMinutes).toBe(540);
    expect(m.avgBreakMinutes).toBe(60);
    // The denominators the screen prints beside those averages.
    expect(m.presentDays).toBe(2);
    expect(m.weeklyOffDays).toBe(1);
    expect(m.holidayDays).toBe(1);
    expect(m.absentDays).toBe(1);
    expect(m.workingDays).toBe(3);
    // Totals are over every row, including the zero ones.
    expect(m.totalWorkedMinutes).toBe(960);
  });

  it("counts leave in fractions, and a half day as half", () => {
    const rows = [
      day({ status: "on_leave", leave_type_name: "Casual", leave_day_fraction: 1, punch_count: 0, first_in_hm: null, last_out_hm: null }),
      day({ ist_date: "2026-07-02", status: "on_leave_half", leave_type_name: "Casual", leave_day_fraction: 0.5 }),
      day({ ist_date: "2026-07-03", status: "half_day", leave_type_name: "Casual", leave_day_fraction: 0.5 }),
    ];
    const m = aggregateMeasures(rows);
    // Two rows carry a LEAVE status; the third is a half day that is half leave.
    expect(m.leaveDayRows).toBe(2);
    expect(m.leaveDays).toBe(2);
    expect(m.presentDays).toBe(1);
  });

  it("counts distinct employees, not rows", () => {
    const rows = [
      day({ employee_id: "e1", ist_date: "2026-07-01" }),
      day({ employee_id: "e1", ist_date: "2026-07-02" }),
      day({ employee_id: "e2", ist_date: "2026-07-01" }),
    ];
    const m = aggregateMeasures(rows);
    expect(m.daysCounted).toBe(3);
    expect(m.employeeCount).toBe(2);
  });

  it("counts anomalies and early exits off the engine's own flags", () => {
    const rows = [
      day({ has_anomalies: true, is_early_exit: true, early_exit_minutes: 25 }),
      day({ ist_date: "2026-07-02" }),
    ];
    const m = aggregateMeasures(rows);
    expect(m.anomalyDays).toBe(1);
    expect(m.earlyExitDays).toBe(1);
    expect(m.totalEarlyExitMinutes).toBe(25);
  });

  it("averages the night shift's clock across midnight", () => {
    // Two 19:00 → 07:00 nights. Arrival 19:00 (1140), departure 07:00 next day,
    // which must read as 1860 so that departure > arrival.
    const night = { first_in_hm: "19:00", last_out_hm: "07:00", gross_span_minutes: 720, total_worked_minutes: 660 };
    const m = aggregateMeasures([day(night), day({ ist_date: "2026-07-02", ...night })]);
    expect(m.avgFirstInMinutes).toBe(1140);
    expect(m.avgLastOutMinutes).toBe(1860);
    expect(m.avgLastOutMinutes).toBeGreaterThan(m.avgFirstInMinutes ?? 0);
  });
});

// -----------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------

describe("groupByDepartment", () => {
  it("returns nothing for no rows", () => {
    expect(groupByDepartment([])).toEqual([]);
  });

  it("splits the measures by department and keeps the unassigned bucket", () => {
    const rows = [
      day({ department_name: "Kitchen", total_worked_minutes: 480 }),
      day({ department_name: "Kitchen", ist_date: "2026-07-02", total_worked_minutes: 520 }),
      day({ department_name: "Service", employee_id: "e2", total_worked_minutes: 400 }),
      day({ department_name: null, employee_id: "e3", total_worked_minutes: 300 }),
    ];
    const groups = groupByDepartment(rows);
    // Alphabetical, unassigned last — dropping the null bucket would make the
    // bars stop adding up to the headline.
    expect(groups.map((g) => g.departmentName)).toEqual(["Kitchen", "Service", null]);
    expect(groups[0]?.measures.daysCounted).toBe(2);
    expect(groups[0]?.measures.avgWorkedMinutes).toBe(500); // (480 + 520) / 2
    expect(groups[1]?.measures.avgWorkedMinutes).toBe(400);
    expect(groups[2]?.measures.avgWorkedMinutes).toBe(300);

    // The parts sum to the whole. This is the property that makes a drill-down
    // trustworthy, so it is asserted rather than assumed.
    const whole = aggregateMeasures(rows);
    const summed = groups.reduce((n, g) => n + g.measures.daysCounted, 0);
    expect(summed).toBe(whole.daysCounted);
  });
});

describe("groupByEmployee", () => {
  it("returns nothing for no rows", () => {
    expect(groupByEmployee([])).toEqual([]);
  });

  it("aggregates per employee and sorts by name then code", () => {
    const rows = [
      day({ employee_id: "e2", employee_code: "TT-002", display_name: "Bimal Roy", total_worked_minutes: 400 }),
      day({ employee_id: "e1", employee_code: "TT-001", display_name: "Asha Nair", total_worked_minutes: 480 }),
      day({ employee_id: "e1", employee_code: "TT-001", display_name: "Asha Nair", ist_date: "2026-07-02", total_worked_minutes: 520 }),
    ];
    const groups = groupByEmployee(rows);
    expect(groups.map((g) => g.displayName)).toEqual(["Asha Nair", "Bimal Roy"]);
    expect(groups[0]?.measures.daysCounted).toBe(2);
    expect(groups[0]?.measures.avgWorkedMinutes).toBe(500);
    expect(groups[1]?.measures.daysCounted).toBe(1);
  });

  it("labels an employee with the department of their LAST day in the period", () => {
    // Somebody transferred mid-period belongs where they ended up — that is what
    // the department filter in the bar means.
    const rows = [
      day({ ist_date: "2026-07-01", department_name: "Kitchen" }),
      day({ ist_date: "2026-07-20", department_name: "Service" }),
    ];
    expect(groupByEmployee(rows)[0]?.departmentName).toBe("Service");
  });
});

// -----------------------------------------------------------------------------
// Daily trend
// -----------------------------------------------------------------------------

const JULY_1_TO_5: Period = { granularity: "range", from: "2026-07-01", to: "2026-07-05" };

describe("aggregateDailyTrend", () => {
  it("emits every date in the period even with no rows at all", () => {
    const points = aggregateDailyTrend([], JULY_1_TO_5);
    expect(points.map((p) => p.istDate)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
    expect(points.every((p) => p.isEmpty)).toBe(true);
    expect(points[0]?.measures).toEqual(EMPTY_MEASURES);
  });

  it("flags gaps instead of closing over them", () => {
    // A line chart that joins 1 July to 5 July across three missing days reads as
    // "nothing changed", which is the opposite of what a gap means.
    const points = aggregateDailyTrend(
      [day({ ist_date: "2026-07-01" }), day({ ist_date: "2026-07-05" })],
      JULY_1_TO_5,
    );
    expect(points.map((p) => p.isEmpty)).toEqual([false, true, true, true, false]);
    expect(points[0]?.measures.daysCounted).toBe(1);
  });

  it("aggregates each date independently", () => {
    const points = aggregateDailyTrend(
      [
        day({ ist_date: "2026-07-02", employee_id: "e1", total_worked_minutes: 480 }),
        day({ ist_date: "2026-07-02", employee_id: "e2", total_worked_minutes: 520 }),
        day({ ist_date: "2026-07-03", employee_id: "e1", total_worked_minutes: 300 }),
      ],
      JULY_1_TO_5,
    );
    expect(points[1]?.measures.employeeCount).toBe(2);
    expect(points[1]?.measures.avgWorkedMinutes).toBe(500);
    expect(points[2]?.measures.avgWorkedMinutes).toBe(300);
  });

  it("appends a row whose date falls outside the period rather than hiding it", () => {
    // It should be impossible — the fetch filters on the same period. If it ever
    // happens the row still counts in the headline, so hiding it from the chart
    // would make the two disagree with nothing on screen to explain why.
    const points = aggregateDailyTrend([day({ ist_date: "2026-08-09" })], JULY_1_TO_5);
    expect(points).toHaveLength(6);
    expect(points[5]?.istDate).toBe("2026-08-09");
    expect(points[5]?.isEmpty).toBe(false);
  });

  it("returns nothing for a period that ends before it starts", () => {
    const backwards: Period = { granularity: "range", from: "2026-07-05", to: "2026-07-01" };
    expect(aggregateDailyTrend([], backwards)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Employee detail
// -----------------------------------------------------------------------------

describe("aggregateEmployeeDetail", () => {
  it("has no identity and null averages when the employee has no visible rows", () => {
    const detail = aggregateEmployeeDetail([], "e1");
    expect(detail.employeeId).toBe("e1");
    expect(detail.displayName).toBeNull();
    expect(detail.days).toEqual([]);
    expect(detail.measures).toEqual(EMPTY_MEASURES);
  });

  it("keeps only that employee's days, oldest first", () => {
    const rows = [
      day({ employee_id: "e2", ist_date: "2026-07-03" }),
      day({ employee_id: "e1", ist_date: "2026-07-05" }),
      day({ employee_id: "e1", ist_date: "2026-07-02" }),
    ];
    const detail = aggregateEmployeeDetail(rows, "e1");
    expect(detail.days.map((d) => d.ist_date)).toEqual(["2026-07-02", "2026-07-05"]);
    expect(detail.measures.daysCounted).toBe(2);
    expect(detail.measures.employeeCount).toBe(1);
  });

  it("computes that employee's own averages", () => {
    const rows = [
      day({ ist_date: "2026-07-01", first_in_hm: "09:00", last_out_hm: "18:00", total_worked_minutes: 480, gross_span_minutes: 540 }),
      day({ ist_date: "2026-07-02", first_in_hm: "09:30", last_out_hm: "19:00", total_worked_minutes: 520, gross_span_minutes: 570, is_late: true, late_minutes: 30 }),
      day({ ist_date: "2026-07-03", status: "on_leave", leave_day_fraction: 1, punch_count: 0, first_in_hm: null, last_out_hm: null, total_worked_minutes: 0, gross_span_minutes: 0, break_minutes: 0 }),
    ];
    const { measures } = aggregateEmployeeDetail(rows, "e1");
    expect(measures.avgFirstInMinutes).toBe(555); // (540 + 570) / 2
    expect(measures.avgLastOutMinutes).toBe(1110); // (1080 + 1140) / 2
    expect(measures.avgWorkedMinutes).toBe(500); // over the 2 attended days
    expect(measures.avgGrossSpanMinutes).toBe(555);
    expect(measures.leaveDays).toBe(1);
    expect(measures.lateDays).toBe(1);
    expect(measures.avgLateMinutes).toBe(30);
  });

  it("takes its identity from the rows when no employee id is given", () => {
    const detail = aggregateEmployeeDetail([day()], null);
    expect(detail.employeeId).toBe("e1");
    expect(detail.employeeCode).toBe("TT-001");
    expect(detail.displayName).toBe("Asha Nair");
  });
});

// -----------------------------------------------------------------------------
// Today board tiles
// -----------------------------------------------------------------------------

function boardRow(over: Partial<TodayBoardFlags> = {}): TodayBoardFlags {
  return {
    employee_id: "e1",
    attended: false,
    off_today: false,
    yet_to_reach: false,
    late_in: false,
    on_time: false,
    overdue: false,
    web_punch_count: 0,
    ...over,
  };
}

describe("summariseTodayBoard", () => {
  it("returns zeroes for an empty board", () => {
    expect(summariseTodayBoard([])).toEqual(EMPTY_TODAY_TILES);
  });

  it("counts each server flag independently, because they overlap", () => {
    // Someone who arrived late is BOTH attended and late_in. The tiles are
    // independent counts and must never be drawn as slices of a whole.
    const rows = [
      boardRow({ employee_id: "e1", attended: true, on_time: true, web_punch_count: 2 }),
      boardRow({ employee_id: "e2", attended: true, late_in: true }),
      boardRow({ employee_id: "e3", off_today: true }),
      boardRow({ employee_id: "e4", yet_to_reach: true }),
      boardRow({ employee_id: "e5", overdue: true }),
    ];
    const tiles = summariseTodayBoard(rows);
    expect(tiles.onRoll).toBe(5);
    expect(tiles.attended).toBe(2);
    expect(tiles.onTime).toBe(1);
    expect(tiles.lateIn).toBe(1);
    expect(tiles.offToday).toBe(1);
    expect(tiles.yetToReach).toBe(1);
    expect(tiles.overdue).toBe(1);
    expect(tiles.webPunchDays).toBe(1);
    // attended + off + yet-to-reach + overdue is not headcount, and that is fine.
    expect(tiles.attended + tiles.lateIn).toBeGreaterThan(tiles.attended);
  });
});
