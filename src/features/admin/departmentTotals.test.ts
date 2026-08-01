/**
 * Per-department subtotals.
 *
 * The two failures worth guarding are both about counting the wrong thing: employees counted
 * as rows (which turns an 11-person department into 300 on a month scope), and a footer
 * computed independently of the body (which can disagree with the rows above it while both
 * look plausible).
 */
import { describe, expect, it } from "vitest";
import { departmentTotals, grandTotal } from "./departmentTotals";
import type { BoardRow } from "./attendanceBoard";

function row(over: Partial<BoardRow>): BoardRow {
  return {
    employeeId: "e1",
    employeeCode: "TT0001",
    displayName: "Asha",
    departmentName: "Front Office",
    istDate: "2026-08-01",
    status: "present",
    shiftCode: "G",
    expectedBy: null,
    firstInHm: "09:30",
    lastOutHm: "18:30",
    punchCount: 2,
    workedMinutes: 480,
    isLate: false,
    lateMinutes: 0,
    overtimeMinutes: 0,
    approvedOvertimeMinutes: 0,
    extraWorkMinutes: 0,
    earlyExitMinutes: 0,
    yetToReach: null,
    overdue: null,
    ...over,
  };
}

describe("departmentTotals", () => {
  it("counts DISTINCT employees, not rows — a month scope would otherwise multiply them", () => {
    const rows = [
      row({ employeeId: "e1", istDate: "2026-08-01" }),
      row({ employeeId: "e1", istDate: "2026-08-02" }),
      row({ employeeId: "e1", istDate: "2026-08-03" }),
      row({ employeeId: "e2", istDate: "2026-08-01" }),
    ];
    const totals = departmentTotals(rows);
    expect(totals).toHaveLength(1);
    expect(totals[0]?.employees).toBe(2);
    // The per-metric counts stay row-based: four present DAYS across two people.
    expect(totals[0]?.present).toBe(4);
  });

  it("splits by department", () => {
    const totals = departmentTotals([
      row({ employeeId: "a", departmentName: "Kitchen" }),
      row({ employeeId: "b", departmentName: "Kitchen" }),
      row({ employeeId: "c", departmentName: "Front Office" }),
    ]);
    expect(totals.map((d) => d.departmentName)).toEqual(["Kitchen", "Front Office"]);
    expect(totals[0]?.employees).toBe(2);
  });

  it("keeps employees with NO department instead of dropping them", () => {
    const totals = departmentTotals([
      row({ employeeId: "a", departmentName: "Kitchen" }),
      row({ employeeId: "b", departmentName: null }),
    ]);
    expect(totals).toHaveLength(2);
    expect(totals.some((d) => d.departmentName === null)).toBe(true);
  });

  it("sorts unassigned LAST even when it is the biggest group", () => {
    const totals = departmentTotals([
      row({ employeeId: "a", departmentName: null }),
      row({ employeeId: "b", departmentName: null }),
      row({ employeeId: "c", departmentName: null }),
      row({ employeeId: "d", departmentName: "Kitchen" }),
    ]);
    expect(totals[totals.length - 1]?.departmentName).toBeNull();
  });

  it("orders by size, then by name for a stable tie", () => {
    const totals = departmentTotals([
      row({ employeeId: "a", departmentName: "Zebra" }),
      row({ employeeId: "b", departmentName: "Alpha" }),
      row({ employeeId: "c", departmentName: "Big" }),
      row({ employeeId: "d", departmentName: "Big" }),
    ]);
    expect(totals.map((d) => d.departmentName)).toEqual(["Big", "Alpha", "Zebra"]);
  });

  it("counts a half day as present and a leave half as leave", () => {
    const totals = departmentTotals([
      row({ employeeId: "a", status: "half_day" }),
      row({ employeeId: "b", status: "on_leave_half" }),
    ]);
    expect(totals[0]?.present).toBe(1);
    expect(totals[0]?.onLeave).toBe(1);
  });

  it("counts work on a weekly off or holiday as present", () => {
    const totals = departmentTotals([
      row({ employeeId: "a", status: "weekly_off_worked" }),
      row({ employeeId: "b", status: "holiday_worked" }),
    ]);
    expect(totals[0]?.present).toBe(2);
  });

  it("does not count a weekly off or a holiday as absent", () => {
    const totals = departmentTotals([
      row({ employeeId: "a", status: "weekly_off" }),
      row({ employeeId: "b", status: "holiday" }),
    ]);
    expect(totals[0]?.absent).toBe(0);
    expect(totals[0]?.present).toBe(0);
  });

  it("counts late independently of status — a late day is still present", () => {
    const totals = departmentTotals([row({ employeeId: "a", status: "present", isLate: true })]);
    expect(totals[0]?.present).toBe(1);
    expect(totals[0]?.late).toBe(1);
  });

  it("sums overtime and worked minutes across the department", () => {
    const totals = departmentTotals([
      row({ employeeId: "a", overtimeMinutes: 30, workedMinutes: 500 }),
      row({ employeeId: "b", overtimeMinutes: 45, workedMinutes: 480 }),
    ]);
    expect(totals[0]?.overtimeMinutes).toBe(75);
    expect(totals[0]?.workedMinutes).toBe(980);
  });

  it("returns nothing for no rows rather than a zero row", () => {
    expect(departmentTotals([])).toEqual([]);
  });
});

describe("grandTotal", () => {
  it("equals the sum of the subtotals, so the footer cannot disagree with the body", () => {
    const rows = [
      row({ employeeId: "a", departmentName: "Kitchen", overtimeMinutes: 30, isLate: true }),
      row({ employeeId: "b", departmentName: "Kitchen", status: "absent" }),
      row({ employeeId: "c", departmentName: "Front Office", status: "on_leave" }),
    ];
    const totals = departmentTotals(rows);
    const total = grandTotal(totals);
    expect(total.employees).toBe(3);
    expect(total.present).toBe(1);
    expect(total.late).toBe(1);
    expect(total.absent).toBe(1);
    expect(total.onLeave).toBe(1);
    expect(total.overtimeMinutes).toBe(30);
  });

  it("counts each employee once — a person belongs to one department", () => {
    const totals = departmentTotals([
      row({ employeeId: "a", departmentName: "Kitchen", istDate: "2026-08-01" }),
      row({ employeeId: "a", departmentName: "Kitchen", istDate: "2026-08-02" }),
      row({ employeeId: "b", departmentName: "Front Office" }),
    ]);
    expect(grandTotal(totals).employees).toBe(2);
  });

  it("is all zeros for no departments", () => {
    expect(grandTotal([])).toEqual({
      employees: 0,
      present: 0,
      late: 0,
      onLeave: 0,
      absent: 0,
      overtimeMinutes: 0,
      workedMinutes: 0,
    });
  });
});
