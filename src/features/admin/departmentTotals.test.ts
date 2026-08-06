/**
 * Per-department subtotals.
 *
 * The two failures worth guarding are both about counting the wrong thing: employees counted
 * as rows (which turns an 11-person department into 300 on a month scope), and a footer
 * computed independently of the body (which can disagree with the rows above it while both
 * look plausible).
 */
import { describe, expect, it } from "vitest";
import {
  bucketMembers,
  departmentTotals,
  grandTotal,
  sortMembers,
} from "./departmentTotals";
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
    firstInAt: "2026-08-01T09:30:00+05:30",
    lastOutAt: "2026-08-01T18:30:00+05:30",
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

describe("bucketMembers — the list behind a number", () => {
  /*
    THE CONSISTENCY GUARANTEE. For every department and every metric, the number of members
    returned must equal the number the subtotals table printed. A drill-down that disagrees with
    the cell it was opened from is worse than no drill-down: the reader cannot tell which is
    lying. This asserts the two can never drift apart.
  */
  const rows: BoardRow[] = [
    row({ employeeId: "e1", displayName: "Anita", departmentName: "Ground", status: "present", firstInHm: "09:12", isLate: false }),
    row({ employeeId: "e2", displayName: "Bala", departmentName: "Ground", status: "present", firstInHm: "10:40", isLate: true, lateMinutes: 70 }),
    row({ employeeId: "e3", displayName: "Chandra", departmentName: "Ground", status: "absent" }),
    row({ employeeId: "e4", displayName: "Deepa", departmentName: "Management", status: "on_leave" }),
    row({ employeeId: "e5", displayName: "Esha", departmentName: "Management", status: "present", overtimeMinutes: 45, firstInHm: "08:55" }),
    row({ employeeId: "e6", displayName: "Farid", departmentName: null, status: "work_from_home", firstInHm: "09:30" }),
  ];

  it("every metric's member count equals the counted total, per department", () => {
    for (const total of departmentTotals(rows)) {
      const d = total.departmentName;
      expect(bucketMembers(rows, "employees", d).length, `employees in ${d}`).toBe(total.employees);
      expect(bucketMembers(rows, "present", d).length, `present in ${d}`).toBe(total.present);
      expect(bucketMembers(rows, "late", d).length, `late in ${d}`).toBe(total.late);
      expect(bucketMembers(rows, "onLeave", d).length, `onLeave in ${d}`).toBe(total.onLeave);
      expect(bucketMembers(rows, "absent", d).length, `absent in ${d}`).toBe(total.absent);
    }
  });

  it("the all-departments row opens every department at once", () => {
    const all = grandTotal(departmentTotals(rows));
    expect(bucketMembers(rows, "employees").length).toBe(all.employees);
    expect(bucketMembers(rows, "present").length).toBe(all.present);
    expect(bucketMembers(rows, "late").length).toBe(all.late);
    expect(bucketMembers(rows, "onLeave").length).toBe(all.onLeave);
    expect(bucketMembers(rows, "absent").length).toBe(all.absent);
  });

  it("de-duplicates people for the employees metric, and only that one", () => {
    // One person over three days of a month scope: three rows, one person, three late days.
    const month: BoardRow[] = [
      row({ employeeId: "e1", displayName: "Anita", departmentName: "Ground", status: "present", isLate: true, lateMinutes: 5 }),
      row({ employeeId: "e1", displayName: "Anita", departmentName: "Ground", status: "present", isLate: true, lateMinutes: 9 }),
      row({ employeeId: "e1", displayName: "Anita", departmentName: "Ground", status: "present", isLate: true, lateMinutes: 2 }),
    ];
    expect(bucketMembers(month, "employees", "Ground")).toHaveLength(1);
    expect(bucketMembers(month, "late", "Ground")).toHaveLength(3);
  });

  it("selects the unassigned bucket with null, not with a name", () => {
    expect(bucketMembers(rows, "employees", null).map((r) => r.displayName)).toEqual(["Farid"]);
  });

  it("overtime lists only rows that actually earned some", () => {
    expect(bucketMembers(rows, "overtime").map((r) => r.displayName)).toEqual(["Esha"]);
  });
});

describe("sortMembers", () => {
  const a = row({ employeeId: "a", displayName: "Zara", status: "present", firstInHm: "08:00", lateMinutes: 3, overtimeMinutes: 10 });
  const b = row({ employeeId: "b", displayName: "Amit", status: "present", firstInHm: "11:00", lateMinutes: 90, overtimeMinutes: 90 });

  it("puts the longest lateness first", () => {
    expect(sortMembers([a, b], "late").map((r) => r.displayName)).toEqual(["Amit", "Zara"]);
  });

  it("puts the most overtime first", () => {
    expect(sortMembers([a, b], "overtime").map((r) => r.displayName)).toEqual(["Amit", "Zara"]);
  });

  it("orders the present by when they actually arrived", () => {
    expect(sortMembers([b, a], "present").map((r) => r.displayName)).toEqual(["Zara", "Amit"]);
  });

  it("falls back to name order", () => {
    expect(sortMembers([a, b], "absent").map((r) => r.displayName)).toEqual(["Amit", "Zara"]);
  });
});
