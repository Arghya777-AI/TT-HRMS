/**
 * navGroups.test.ts — the rail puts an admin's work where an admin can see it.
 *
 * The bug: MY WORK has thirteen entries and TEAM six, so in a normal viewport the
 * ADMIN group started around "People" and its remaining eight rows — the Dashboard
 * among them — were below the fold. The client asked where the dashboard tab was
 * while the answer was nineteen rows above it, off screen.
 *
 * These tests pin the two halves of the fix: admins get ADMIN first, and NOBODY
 * gains or loses a group by it. Reordering navigation must never become a way to
 * quietly change who can reach what — the `cap` filter in `AppShell` and `RequireCap`
 * on the route remain the only things that decide that.
 */
import { describe, expect, it } from "vitest";
import { NAV_GROUPS, navGroupsFor } from "./nav-model";

const ADMIN = (cap: string) => cap === "admin.access" || cap === "me.view" || cap === "team.view";
const EMPLOYEE = (cap: string) => cap === "me.view";

describe("group order follows who is reading", () => {
  it("puts ADMIN first for someone holding admin.access", () => {
    const groups = navGroupsFor(ADMIN as Parameters<typeof navGroupsFor>[0]);
    expect(groups[0]?.cap).toBe("admin.access");
  });

  it("leaves an employee's rail exactly as it was", () => {
    // For an employee, MY WORK *is* the product. Nothing about this change should
    // reach them.
    const groups = navGroupsFor(EMPLOYEE as Parameters<typeof navGroupsFor>[0]);
    expect(groups).toEqual(NAV_GROUPS);
    expect(groups[0]?.cap).toBe("me.view");
  });
});

describe("reordering never changes membership", () => {
  it("returns every group, once, whoever is asking", () => {
    for (const has of [ADMIN, EMPLOYEE]) {
      const groups = navGroupsFor(has as Parameters<typeof navGroupsFor>[0]);
      expect(groups.length).toBe(NAV_GROUPS.length);
      expect(new Set(groups.map((g) => g.cap)).size).toBe(NAV_GROUPS.length);
    }
  });

  it("does not add, drop or rewrite a single item", () => {
    const before = new Map(NAV_GROUPS.map((g) => [g.cap, g.items]));
    for (const group of navGroupsFor(ADMIN as Parameters<typeof navGroupsFor>[0])) {
      // Identity, not deep-equality: the arrays must be the SAME arrays, so this
      // cannot become a place where an item list is rebuilt or filtered.
      expect(group.items).toBe(before.get(group.cap));
    }
  });
});

describe("the dashboard is in the admin group at all", () => {
  it("ADMIN contains /admin/analytics", () => {
    /*
      The whole point of the exercise. If this entry is ever dropped, the dashboard
      goes back to being reachable only by Cmd-K or a typed URL — which is the state
      the client reported as "where is the dashboard".
    */
    const admin = NAV_GROUPS.find((g) => g.cap === "admin.access");
    expect(admin?.items.some((i) => i.to === "/admin/analytics")).toBe(true);
  });

  it("is early enough in the group to sit in a first screenful", () => {
    // Not a pixel assertion — a positional one. Tenth of ten would defeat the fix.
    const admin = NAV_GROUPS.find((g) => g.cap === "admin.access");
    const index = admin?.items.findIndex((i) => i.to === "/admin/analytics") ?? -1;
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(9);
  });
});
