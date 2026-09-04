/**
 * Leave and work are not mutually exclusive.
 *
 * ── WHAT WAS REPORTED ────────────────────────────────────────────────────────
 * Deepesh was on approved leave on 2 September and came in for an evening meeting, 20:00 to
 * 21:19. The engine recorded both facts — status `on_leave`, 79 worked minutes, and a
 * `worked_on_leave` flag — and every screen showed only the first.
 *
 * "Even if he's on leave, he still worked." Showing one and hiding the other is not a summary,
 * it is an omission, and it is the half that costs somebody: unseen work is unpaid work.
 */
import { describe, expect, it } from "vitest";
import { dayStatusChip, dayStatusText } from "./display";

describe("a leave day that was also worked says so", () => {
  it("names the leave AND the hours", () => {
    expect(dayStatusText("on_leave", "Week-off", 79)).toContain("Week-off");
    expect(dayStatusText("on_leave", "Week-off", 79)).toContain("1h 19m");
  });

  it("does the same for a half day of leave", () => {
    expect(dayStatusText("on_leave_half", "Sick Leave", 240)).toContain("4h 00m");
  });

  it("says nothing extra when a leave day was NOT worked", () => {
    // The overwhelmingly common case must stay clean.
    expect(dayStatusText("on_leave", "Week-off", 0)).toBe(dayStatusText("on_leave", "Week-off"));
    expect(dayStatusText("on_leave", "Week-off", null)).toBe(dayStatusText("on_leave", "Week-off"));
  });

  it("leaves every other status alone", () => {
    /*
      Only on a LEAVE day. Everywhere else the worked figure has its own column, and repeating
      it inside the status chip would be noise on every row of the register.
    */
    expect(dayStatusText("present", null, 494)).toBe(dayStatusText("present", null));
    expect(dayStatusText("weekly_off", null, 300)).toBe(dayStatusText("weekly_off", null));
    expect(dayStatusText("absent", null, 0)).toBe(dayStatusText("absent", null));
  });

  it("carries through the chip the screens actually render", () => {
    const chip = dayStatusChip("on_leave", "Week-off", 79);
    expect(chip["on_leave"]?.label).toContain("1h 19m");
    // The tone is unchanged: it is still a leave day.
    expect(chip["on_leave"]?.tone).toBe(dayStatusChip("on_leave", "Week-off")["on_leave"]?.tone);
  });

  it("is reached from the employee's page, the admin's, and the day detail", () => {
    /*
      One helper, every surface — so an administrator and the employee cannot read the same day
      two different ways. The admin page keeps its own tone vocabulary and borrows only the
      label.
    */
    const read = (p: string) =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require("node:fs") as typeof import("node:fs")).readFileSync(p, "utf8");
    expect(read("src/features/attendance/pages/MyAttendance.page.tsx")).toContain(
      "row.day?.total_worked_minutes ?? null",
    );
    expect(read("src/features/admin/pages/EmployeeAttendance.page.tsx")).toContain(
      "withWorkedOnLeave(r.status, r.leave_type_name, r.total_worked_minutes)",
    );
    expect(read("src/features/attendance/pages/AttendanceDayDetail.page.tsx")).toContain(
      "day.data.total_worked_minutes",
    );
  });
});
