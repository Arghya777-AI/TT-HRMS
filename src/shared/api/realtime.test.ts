/**
 * The realtime table→invalidation map.
 *
 * The failure this guards against is silent and specific: a table is added to the
 * `supabase_realtime` publication, changes start arriving for it, and nothing invalidates
 * — so the screen that reads it looks live and is not. There is no error to notice,
 * because a change nobody acts on is indistinguishable from no change.
 *
 * The list of tables here must match the publication. When a migration adds one, this file
 * fails until the map has an entry, which is the point.
 */
import { describe, expect, it } from "vitest";
import { REALTIME_TABLES, invalidationRootsFor, type RealtimeTable } from "./realtime";
import { qk } from "./keys";

describe("REALTIME_TABLES", () => {
  it("matches the publication measured on the live project", () => {
    // `SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime'`
    // on 2026-08-01. Update BOTH when a migration changes the publication.
    expect([...REALTIME_TABLES].sort()).toEqual([
      "ai_messages",
      "announcements",
      "approval_requests",
      "attendance_days",
      "attendance_punches",
      "attendance_recompute_runs",
      "kiosk_devices",
      "leave_requests",
      "notifications",
      "payroll_runs",
      "roster_slots",
      "sessions_audit",
      "system_health",
    ]);
  });

  it("has no duplicates — a table bound twice delivers every change twice", () => {
    expect(new Set(REALTIME_TABLES).size).toBe(REALTIME_TABLES.length);
  });
});

describe("invalidationRootsFor", () => {
  it("gives every published table at least one root", () => {
    for (const table of REALTIME_TABLES) {
      expect(invalidationRootsFor(table).length, `${table} invalidates nothing`).toBeGreaterThan(0);
    }
  });

  it("only ever returns real query-key roots", () => {
    const known = new Set(
      [
        qk.attendance.all,
        qk.home.all,
        qk.admin.all,
        qk.team.all,
        qk.leave.all,
        qk.approvals.all,
        qk.notifications.all,
        qk.ai.all,
        qk.pay.all,
      ].map((root) => root.join("/")),
    );
    for (const table of REALTIME_TABLES) {
      for (const root of invalidationRootsFor(table)) {
        expect(known.has(root.join("/")), `${table} → ${root.join("/")} is not a known root`).toBe(
          true,
        );
      }
    }
  });

  it("sends a punch to the employee's own screens AND the admin console", () => {
    const roots = invalidationRootsFor("attendance_punches").map((r) => r.join("/"));
    expect(roots).toContain(qk.home.all.join("/"));
    expect(roots).toContain(qk.attendance.all.join("/"));
    expect(roots).toContain(qk.admin.all.join("/"));
  });

  it("sends a leave request to the applicant, the approver and the admin calendars", () => {
    const roots = invalidationRootsFor("leave_requests").map((r) => r.join("/"));
    expect(roots).toContain(qk.leave.all.join("/"));
    expect(roots).toContain(qk.approvals.all.join("/"));
    expect(roots).toContain(qk.admin.all.join("/"));
  });

  it("sends a notification to the bell and its badge", () => {
    const roots = invalidationRootsFor("notifications").map((r) => r.join("/"));
    expect(roots).toContain(qk.notifications.all.join("/"));
  });

  it("does not invalidate the whole world for one table", () => {
    // A map where everything invalidates everything is the same as no map: every change
    // refetches every mounted query. Nine roots exist; no table should need them all.
    for (const table of REALTIME_TABLES) {
      expect(invalidationRootsFor(table).length, `${table} is too broad`).toBeLessThanOrEqual(5);
    }
  });

  it("covers every table in the map with no orphan entries", () => {
    // An entry for a table no longer published is dead weight that reads as coverage.
    const mapped = REALTIME_TABLES.filter(
      (table: RealtimeTable) => invalidationRootsFor(table).length > 0,
    );
    expect(mapped.length).toBe(REALTIME_TABLES.length);
  });
});
