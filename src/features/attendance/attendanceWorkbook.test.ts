/**
 * What is actually inside the downloaded workbook.
 *
 * The ask: attendance day by day inside a month, month by month inside a year, a week at a
 * time, for an employee's own record or for every employee — with the leaves taken, the leave
 * left including carry forward, and the extra or short hours beside it.
 *
 * ── THE ONE RULE THESE TESTS EXIST TO HOLD ───────────────────────────────────
 * The file must never disagree with the screen. A spreadsheet outlives the session it came
 * from, gets mailed around, and is quoted back months later — if it differs from the console
 * by a minute, the console loses the argument. So every figure is either a
 * `f_attendance_period_summary` column or a `periodVariance` result, and nothing is
 * recalculated here. These tests check that by feeding a summary row and asserting the cell
 * carries THAT number, not a plausible one.
 */
import { describe, expect, it } from "vitest";
import type { XlsxSheet } from "@/lib/xlsx";
import type { AttendancePeriodSummary } from "./api/attendance.api";
import {
  buildAttendanceSheets,
  type WorkbookBalance,
  type WorkbookDay,
  type WorkbookInput,
} from "./lib/attendanceWorkbook";

const EMP = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const day = (over: Partial<WorkbookDay> = {}): WorkbookDay => ({
  employee_id: EMP,
  ist_date: "2026-09-01",
  status: "present",
  is_holiday: false,
  is_weekly_off: false,
  is_working_day: true,
  shift_duration_minutes: 480,
  leave_type_id: null,
  leave_day_fraction: null,
  total_worked_minutes: 480,
  payable_worked_minutes: 480,
  first_in_at: "2026-09-01T03:00:00Z",
  last_out_at: "2026-09-01T11:00:00Z",
  late_minutes: null,
  early_exit_minutes: null,
  overtime_minutes: null,
  day_fraction_paid: 1,
  ...over,
});

const summary = (over: Partial<AttendancePeriodSummary> = {}): AttendancePeriodSummary =>
  ({
    employee_id: EMP,
    from_date: "2026-09-01",
    to_date: "2026-09-30",
    total_days: 30,
    present_days: 21,
    half_days: 1,
    absent_days: 2,
    pending_days: 0,
    weekly_off_days: 4,
    holiday_days: 2,
    leave_days: 3,
    comp_off_days: 0,
    paid_days: 27.5,
    working_days: 24,
    late_days: 5,
    late_minutes: 63,
    early_exit_days: 1,
    early_exit_minutes: 75,
    overtime_minutes: 120,
    approved_overtime_minutes: 60,
    extra_work_minutes: 0,
    total_worked_minutes: 10_080,
    ...over,
  }) as unknown as AttendancePeriodSummary;

const balance = (over: Partial<WorkbookBalance> = {}): WorkbookBalance => ({
  employee_id: EMP,
  leave_type_name: "Earned Leave",
  entitlement_days: 12,
  carried_forward_days: 4.5,
  accrued_days: 7.5,
  availed_days: 3,
  pending_days: 1,
  available_days: 8,
  lapsed_days: 0,
  ...over,
});

const input = (over: Partial<WorkbookInput> = {}): WorkbookInput => ({
  scope: "month",
  from: "2026-09-01",
  to: "2026-09-30",
  rangeLabel: "September 2026",
  generatedAt: "15-Sep-2026 10:00 IST",
  employees: [{ employeeId: EMP, code: "085", name: "Meghana A" }],
  summaries: [summary()],
  days: [day()],
  balances: [balance()],
  ...over,
});

const byName = (sheets: readonly XlsxSheet[], name: string): XlsxSheet => {
  const found = sheets.find((s) => s.name === name);
  expect(found, `no sheet named ${name}`).toBeDefined();
  return found as XlsxSheet;
};
/** The column index of a header, so assertions survive a column being inserted. */
const col = (sheet: XlsxSheet, header: string): number => {
  const at = sheet.columns.findIndex((c) => c.header === header);
  expect(at, `no column "${header}"`).toBeGreaterThan(-1);
  return at;
};
const cell = (sheet: XlsxSheet, row: number, header: string): unknown =>
  sheet.rows[row]?.[col(sheet, header)];

describe("the scope decides the last sheet, and only that", () => {
  it("gives a month the day-wise sheet", () => {
    const names = buildAttendanceSheets(input({ scope: "month" })).map((s) => s.name);
    expect(names).toEqual(["About", "Summary", "Leave balances", "Day wise"]);
  });

  it("gives a week the day-wise sheet too", () => {
    const names = buildAttendanceSheets(input({ scope: "week" })).map((s) => s.name);
    expect(names).toContain("Day wise");
    expect(names).not.toContain("Month wise");
  });

  it("gives a year the month-wise sheet instead", () => {
    const names = buildAttendanceSheets(
      input({ scope: "year", months: [{ from: "2026-01-01", summaries: [summary()] }] }),
    ).map((s) => s.name);
    expect(names).toContain("Month wise");
    expect(names).not.toContain("Day wise");
  });

  it("always carries the About and Leave balances sheets, whatever the scope", () => {
    for (const scope of ["week", "month", "year"] as const) {
      const names = buildAttendanceSheets(input({ scope, months: [] })).map((s) => s.name);
      expect(names).toContain("About");
      expect(names).toContain("Leave balances");
    }
  });
});

describe("the summary sheet is the server's own figures", () => {
  const sheet = () => byName(buildAttendanceSheets(input()), "Summary");

  it("carries the period's day counts verbatim", () => {
    const s = sheet();
    expect(cell(s, 0, "Working days")).toBe(24);
    expect(cell(s, 0, "Present")).toBe(21);
    expect(cell(s, 0, "Half days")).toBe(1);
    expect(cell(s, 0, "Absent")).toBe(2);
    expect(cell(s, 0, "On leave")).toBe(3);
    expect(cell(s, 0, "Paid days")).toBe(27.5);
  });

  it("carries the hours, in minutes AND in the screen's own wording", () => {
    const s = sheet();
    expect(cell(s, 0, "Worked (minutes)")).toBe(10_080);
    // The same figure a reader can check against the screen without doing arithmetic.
    expect(cell(s, 0, "Worked")).toBe("168h 00m");
    expect(cell(s, 0, "Overtime (minutes)")).toBe(120);
    expect(cell(s, 0, "Approved OT (minutes)")).toBe(60);
    expect(cell(s, 0, "Late (minutes)")).toBe(63);
  });

  it("names the employee by code and name", () => {
    const s = sheet();
    expect(cell(s, 0, "Code")).toBe("085");
    expect(cell(s, 0, "Employee")).toBe("Meghana A");
  });

  it("gives every employee a row, even one with no summary", () => {
    const s = byName(
      buildAttendanceSheets(
        input({
          employees: [
            { employeeId: EMP, code: "085", name: "Meghana A" },
            { employeeId: OTHER, code: "060", name: "Vishwajeet Suresh" },
          ],
        }),
      ),
      "Summary",
    );
    expect(s.rows).toHaveLength(2);
    // Absent figures read as blank, never as a confident zero.
    expect(cell(s, 1, "Present")).toBeNull();
  });
});

describe("over and under worked, from the one shared rule", () => {
  it("adds up a surplus day and a short day exactly as the screen does", () => {
    const s = byName(
      buildAttendanceSheets(
        input({
          days: [
            day({ ist_date: "2026-09-01", total_worked_minutes: 586, payable_worked_minutes: 586 }),
            day({ ist_date: "2026-09-02", total_worked_minutes: 300, payable_worked_minutes: 300 }),
          ],
        }),
      ),
      "Summary",
    );
    expect(cell(s, 0, "Worked extra (minutes)")).toBe(106);
    expect(cell(s, 0, "Worked short (minutes)")).toBe(180);
    expect(cell(s, 0, "Over/under (minutes)")).toBe(-74);
  });

  it("does NOT count a holiday as a shortfall, and credits work on one as surplus", () => {
    const s = byName(
      buildAttendanceSheets(
        input({
          days: [
            day({
              ist_date: "2026-09-02",
              is_holiday: true,
              total_worked_minutes: 120,
              payable_worked_minutes: 120,
            }),
          ],
        }),
      ),
      "Summary",
    );
    expect(cell(s, 0, "Over/under (minutes)")).toBe(120);
    expect(cell(s, 0, "Worked short (minutes)")).toBe(0);
  });

  it("names what it could not count, rather than folding it in", () => {
    const s = byName(
      buildAttendanceSheets(
        input({
          days: [
            day({ ist_date: "2026-09-01" }),
            day({ ist_date: "2099-01-01" }),
            day({ ist_date: "2026-09-02", status: "pending" }),
          ],
        }),
      ),
      "Summary",
    );
    expect(cell(s, 0, "Days counted")).toBe(1);
    expect(cell(s, 0, "Still to come")).toBe(1);
    expect(cell(s, 0, "Not processed yet")).toBe(1);
  });

  it("keeps one employee's days out of another's totals", () => {
    const s = byName(
      buildAttendanceSheets(
        input({
          employees: [
            { employeeId: EMP, code: "085", name: "Meghana A" },
            { employeeId: OTHER, code: "060", name: "Vishwajeet" },
          ],
          days: [
            day({ employee_id: EMP, total_worked_minutes: 586, payable_worked_minutes: 586 }),
            day({ employee_id: OTHER, total_worked_minutes: 300, payable_worked_minutes: 300 }),
          ],
        }),
      ),
      "Summary",
    );
    expect(cell(s, 0, "Over/under (minutes)")).toBe(106);
    expect(cell(s, 1, "Over/under (minutes)")).toBe(-180);
  });
});

describe("a capped read blanks the totals rather than showing a subset", () => {
  it("leaves every variance column empty when truncated", () => {
    const s = byName(buildAttendanceSheets(input({ truncated: true })), "Summary");
    for (const header of [
      "Over/under (minutes)",
      "Worked extra (minutes)",
      "Worked short (minutes)",
      "Days counted",
    ]) {
      expect(cell(s, 0, header), header).toBeNull();
    }
    // The server's own day counts are unaffected — they were never a partial sum.
    expect(cell(s, 0, "Present")).toBe(21);
  });

  it("says so on the About sheet", () => {
    const about = byName(buildAttendanceSheets(input({ truncated: true })), "About");
    expect(JSON.stringify(about.rows)).toContain("Incomplete");
  });

  it("says nothing about it when the read was complete", () => {
    const about = byName(buildAttendanceSheets(input()), "About");
    expect(JSON.stringify(about.rows)).not.toContain("Incomplete");
  });
});

describe("leave: taken, held, left, and what carried over", () => {
  it("carries every figure the ask named", () => {
    const s = byName(buildAttendanceSheets(input()), "Leave balances");
    expect(cell(s, 0, "Leave type")).toBe("Earned Leave");
    expect(cell(s, 0, "Taken")).toBe(3);
    expect(cell(s, 0, "Left")).toBe(8);
    expect(cell(s, 0, "Carried forward")).toBe(4.5);
    expect(cell(s, 0, "Entitlement")).toBe(12);
    expect(cell(s, 0, "Held (pending)")).toBe(1);
  });

  it("labels each row with the employee it belongs to", () => {
    const s = byName(
      buildAttendanceSheets(
        input({
          employees: [
            { employeeId: EMP, code: "085", name: "Meghana A" },
            { employeeId: OTHER, code: "060", name: "Vishwajeet" },
          ],
          balances: [balance(), balance({ employee_id: OTHER, leave_type_name: "Week-off" })],
        }),
      ),
      "Leave balances",
    );
    expect(cell(s, 0, "Employee")).toBe("Meghana A");
    expect(cell(s, 1, "Employee")).toBe("Vishwajeet");
  });
});

describe("the day-wise sheet", () => {
  it("prints the date, the status and the day's own variance", () => {
    const s = byName(
      buildAttendanceSheets(
        input({ days: [day({ total_worked_minutes: 586, payable_worked_minutes: 586 })] }),
      ),
      "Day wise",
    );
    expect(cell(s, 0, "Date")).toBe("2026-09-01");
    expect(cell(s, 0, "Status")).toBe("present");
    expect(cell(s, 0, "Worked (minutes)")).toBe(586);
    expect(cell(s, 0, "Over/under (minutes)")).toBe(106);
  });

  it("leaves the variance blank on a day that does not count, and says why", () => {
    const s = byName(
      buildAttendanceSheets(input({ days: [day({ ist_date: "2099-01-01" })] })),
      "Day wise",
    );
    expect(cell(s, 0, "Over/under (minutes)")).toBeNull();
    expect(cell(s, 0, "Note")).toBe("Still to come");
  });

  it("orders by employee and then by date, the way a register is read", () => {
    const s = byName(
      buildAttendanceSheets(
        input({
          employees: [
            { employeeId: EMP, code: "085", name: "A" },
            { employeeId: OTHER, code: "060", name: "B" },
          ],
          days: [
            day({ employee_id: OTHER, ist_date: "2026-09-02" }),
            day({ employee_id: EMP, ist_date: "2026-09-03" }),
            day({ employee_id: EMP, ist_date: "2026-09-01" }),
          ],
        }),
      ),
      "Day wise",
    );
    expect(s.rows.map((r) => r[col(s, "Date")])).toEqual([
      "2026-09-01",
      "2026-09-03",
      "2026-09-02",
    ]);
  });
});

describe("the month-wise sheet", () => {
  const yearInput = input({
    scope: "year",
    from: "2026-01-01",
    to: "2026-12-31",
    months: [
      { from: "2026-01-01", summaries: [summary({ present_days: 20 })] },
      { from: "2026-02-01", summaries: [summary({ present_days: 18 })] },
    ],
    days: [
      day({ ist_date: "2026-01-05", total_worked_minutes: 586, payable_worked_minutes: 586 }),
      day({ ist_date: "2026-02-05", total_worked_minutes: 300, payable_worked_minutes: 300 }),
    ],
  });

  it("gives each month its own row, named", () => {
    const s = byName(buildAttendanceSheets(yearInput), "Month wise");
    expect(s.rows).toHaveLength(2);
    expect(cell(s, 0, "Present")).toBe(20);
    expect(cell(s, 1, "Present")).toBe(18);
  });

  it("scopes each month's variance to that month's days", () => {
    const s = byName(buildAttendanceSheets(yearInput), "Month wise");
    expect(cell(s, 0, "Over/under (minutes)")).toBe(106);
    expect(cell(s, 1, "Over/under (minutes)")).toBe(-180);
  });
});

describe("the About sheet states the period, or the file is unquotable", () => {
  it("names the report, the range and when it was taken", () => {
    const about = byName(buildAttendanceSheets(input()), "About");
    const text = JSON.stringify(about.rows);
    expect(text).toContain("September 2026");
    expect(text).toContain("2026-09-01");
    expect(text).toContain("2026-09-30");
    expect(text).toContain("15-Sep-2026 10:00 IST");
  });

  it("explains how over/under is arrived at, for a reader who never saw the console", () => {
    const text = JSON.stringify(byName(buildAttendanceSheets(input()), "About").rows);
    expect(text).toContain("11:59 pm IST");
    expect(text).toContain("holiday");
  });
});
