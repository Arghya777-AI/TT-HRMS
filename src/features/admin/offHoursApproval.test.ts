/**
 * The off-hours approval loop, end to end through the code that ships.
 *
 * Every piece of this feature is a place a wrong number could reach payroll, so the assertions
 * below are about the JOINS between the pieces: that the star and the queue read the same fact,
 * that a decision invalidates what it moves, and that the gate is never dragged into it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

/**
 * A file with its comments stripped.
 *
 * Needed for the `not.toContain` assertions, and this is the third time in this codebase that
 * a comment explaining why something is NOT done has failed a test asserting it is not done. A
 * grep a comment can fail punishes documenting the decision.
 */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
const rosterApi = read("src", "features", "admin", "api", "todayRoster.api.ts");
const rosterCell = read("src", "features", "admin", "components", "TodayRoster.tsx");
const panel = read("src", "features", "admin", "components", "OffHoursApprovals.tsx");
const attApi = read("src", "features", "admin", "api", "attendance.api.ts");
const hooks = read("src", "features", "admin", "hooks", "useAttendanceRecords.ts");

describe("the star", () => {
  it("marks a day whose hours are being held", () => {
    /*
      The hours ARE in the day's figure and are NOT in the monthly total. Without the mark those
      two numbers simply disagree and a reader has no way to know it is on purpose.
    */
    expect(rosterCell).toContain("row.awaitingApproval > 0");
    expect(rosterCell).toContain("admin.roster.awaitingApproval");
  });

  it("marks WHICH punch, not just the day", () => {
    expect(rosterCell).toContain("punch.awaitingApproval ?");
  });

  it("is derived from the punch log, not a second read of the day", () => {
    /*
      The roster already loads every punch for the timeline. Reading
      `attendance_days.pending_approval_minutes` as well would be a second source for one fact,
      and the two would eventually disagree.
    */
    expect(rosterApi).toContain("row.requires_approval === true && row.approved_at === null");
    expect(code(rosterApi)).not.toContain("pending_approval_minutes");
  });
});

describe("the queue", () => {
  it("lists only punches that are actually undecided", () => {
    // Approved ones are done; voided ones were rejected. Either in the list is a decision
    // offered twice, and the function would refuse the second.
    expect(attApi).toContain('{ op: "is", column: "requires_approval", value: true }');
    expect(attApi).toContain('{ op: "is", column: "approved_at", value: null }');
    expect(attApi).toContain('{ op: "is", column: "is_voided", value: false }');
  });

  it("shows the oldest first", () => {
    // The person who has been waiting longest is decided first.
    expect(attApi).toContain('order: [{ column: "punched_at", ascending: true }]');
  });

  it("puts the distance beside the employee's own words", () => {
    /*
      The question an admin is answering is "were they where they say they were". The reason is
      what the employee chose to write; the distance is the fact they did not choose.
    */
    expect(panel).toContain("distanceFromVenue(");
    expect(panel).toContain("row.reason");
  });

  it("requires a reason for BOTH decisions", () => {
    // The employee sees it, and a rejection especially owes them one.
    expect(panel).toContain("minLength={10}");
    expect(attApi).toContain("minReasonLength: 10");
  });
});

describe("what a decision must invalidate", () => {
  it("invalidates everything under admin, not a hand-listed set", () => {
    /*
      One decision moves the day's worked figure, its pending minutes, the monthly total, the
      roster's star and the queue itself. A list of keys here is a list that goes stale the next
      time somebody adds a sixth.
    */
    expect(hooks).toContain("invalidate: [qk.admin.all]");
  });
});

describe("the gate is never part of this", () => {
  it("is not mentioned anywhere in the approval path", () => {
    // A guard and a fixed camera at a known gate already establish the what, where and when.
    for (const src of [panel, attApi.slice(attApi.indexOf("pendingApprovalPunchSchema"))]) {
      expect(code(src)).not.toContain("kiosk_face");
    }
  });
});
