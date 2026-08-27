/**
 * capabilities.test.ts — who gets `team.today`, and who must not.
 *
 * WHY THIS FILE EXISTS. `capsForRoles` decides which navigation rows and routes a
 * reader is offered, and until `team.today` it was pure role arithmetic that no
 * test covered. `team.today` is different in kind: it is derived from the reader's
 * DEPARTMENT, it is matched on a display string, and getting it wrong is silent —
 * a manager either sees a screen they should not or loses one they should have,
 * with nothing in the UI to say why. That is worth pinning.
 *
 * The rule, from the request that produced it: Team Today is for Management only,
 * Team Attendance is for every department. Team Attendance needs no test here
 * because it keeps plain `team.view`; what needs pinning is the narrower cap.
 */
import { describe, expect, it } from "vitest";
import { capsForRoles, isTeamTodayDepartment } from "./capabilities";

describe("team.today — the management-only cap", () => {
  it("gives it to a manager in Management", () => {
    const caps = capsForRoles(["employee"], { isManager: true, departmentName: "Management" });
    expect(caps.has("team.view")).toBe(true);
    expect(caps.has("team.today")).toBe(true);
  });

  it("withholds it from a manager in Ground, who keeps the rest of /team", () => {
    // THE CASE THE RULE WAS WRITTEN FOR: a ground-staff supervisor has reportees,
    // so they keep `team.view` and Team Attendance — and get no Team Today.
    const caps = capsForRoles(["employee"], { isManager: true, departmentName: "Ground" });
    expect(caps.has("team.view")).toBe(true);
    expect(caps.has("team.today")).toBe(false);
  });

  it("withholds it from every other department too, not just Ground", () => {
    for (const dept of ["Front Office", "Housekeeping", "Kitchen", "Security", ""]) {
      const caps = capsForRoles(["employee"], { isManager: true, departmentName: dept });
      expect(caps.has("team.today"), `${dept || "(blank)"} must not get team.today`).toBe(false);
    }
  });

  it("requires reportees as well as the department", () => {
    // Team Today is a manager's board. Somebody in Management with nobody
    // reporting to them has no team to show, so the cap needs BOTH halves.
    const caps = capsForRoles(["employee"], { isManager: false, departmentName: "Management" });
    expect(caps.has("team.view")).toBe(false);
    expect(caps.has("team.today")).toBe(false);
  });

  it("FAILS CLOSED when the department could not be read", () => {
    // A restriction that evaporates on a failed read is not a restriction. Null
    // and undefined are both "we do not know", and neither is treated as a pass.
    for (const dept of [null, undefined]) {
      const caps = capsForRoles(["employee"], { isManager: true, departmentName: dept });
      expect(caps.has("team.view")).toBe(true);
      expect(caps.has("team.today")).toBe(false);
    }
  });

  it("does not exempt an admin outside Management", () => {
    // `admin` carries `team.view`, but Team Today is a manager surface rather than
    // part of the admin console, and the rule was "only Management" with no
    // carve-out. The admin console itself is untouched.
    const caps = capsForRoles(["admin"], { departmentName: "Ground" });
    expect(caps.has("admin.access")).toBe(true);
    expect(caps.has("team.view")).toBe(true);
    expect(caps.has("team.today")).toBe(false);
  });

  it("gives it to an admin who IS in Management", () => {
    const caps = capsForRoles(["admin"], { departmentName: "Management" });
    expect(caps.has("team.today")).toBe(true);
  });

  it("never leaks to a plain employee", () => {
    const caps = capsForRoles(["employee"], { departmentName: "Management" });
    expect([...caps]).toEqual(["me.view"]);
  });
});

describe("isTeamTodayDepartment — matching a display string safely", () => {
  it("ignores casing and surrounding whitespace", () => {
    // Casing and stray spaces in the org master must not decide who sees a screen.
    for (const name of ["Management", "management", "MANAGEMENT", "  Management  "]) {
      expect(isTeamTodayDepartment(name), name).toBe(true);
    }
  });

  it("is exact otherwise — no substring or prefix matching", () => {
    // "Management" must not be matched by a department that merely contains it,
    // or Facilities Management would silently qualify.
    for (const name of ["Facilities Management", "Management Trainees", "Manage", "Mgmt"]) {
      expect(isTeamTodayDepartment(name), name).toBe(false);
    }
  });

  it("treats absent values as no match", () => {
    expect(isTeamTodayDepartment(null)).toBe(false);
    expect(isTeamTodayDepartment(undefined)).toBe(false);
    expect(isTeamTodayDepartment("")).toBe(false);
    expect(isTeamTodayDepartment("   ")).toBe(false);
  });
});
