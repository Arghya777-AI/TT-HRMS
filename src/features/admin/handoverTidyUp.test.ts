/**
 * Handover: two test accounts hidden, and the gate alarm stopped crying wolf.
 *
 * ── ONE ────────────────────────────────────────────────────────────────────────
 * TT0013 Arghya Ghosh and TT0001 Arjun Nair exist to exercise the system. TT0001 was already
 * invisible — soft-deleted, and a sweep of all 32 views exposing `employee_id` returned zero
 * rows for him. TT0013 was not: he ALREADY carried `exclude_from_attendance` and
 * `exclude_from_leave_tracking`, and still appeared in six views, because nothing read those
 * flags. He was on the org leave calendar twice on 5 Sep.
 *
 * Filtering on the exclusion flags would have been the wrong fix: three real managers carry
 * them too (TT0002 Suraj Kumar, TT0017 Vinod Maurya, TT0019 Preethi Machani) and five of the
 * six views feed the employee's OWN screens as well as the console. So the flag says what is
 * meant — `is_test_account` — and the predicate exempts the reader themself, because an
 * account whose own screens are blank cannot be tested with.
 *
 * Verified live: an administrator now counts 0 rows for both across all six views; Arghya
 * signed in as Arghya still counts 6/1/1/2/2/4; Arjun Pattar (a real employee with a similar
 * name, 126 attendance days) and the three managers are untouched.
 *
 * ── TWO ────────────────────────────────────────────────────────────────────────
 * `public.notifications` held 58,762 rows. 57,803 of them — 98.4% — were KIOSK_OFFLINE, and
 * Suraj Kumar had 17,890 unread. Eighteen kiosk devices were registered and all marked
 * active; seventeen were abandoned test registrations ("test", "test2", "Arghya", "Sunil
 * phone", three that never checked in once), and exactly one had ever done a day's work.
 * Every silent device was re-reported hourly to every administrator, for six weeks.
 *
 * The alert was never wrong. It was answering honestly about a device list nobody had tidied,
 * at an interval that made it unreadable. Both were fixed; muting it was not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
/* Line comments first — see the note in `attentionSurfaces.test.ts`. */
const strip = (s: string) =>
  s
    .replace(/^\s*--.*$/gm, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const hide = strip(
  read("supabase", "migrations", "20260907140000_a_test_account_is_not_the_venues_business.sql"),
);
const kiosk = strip(
  read("supabase", "migrations", "20260907150000_the_gate_alarm_stops_crying_wolf.sql"),
);
const fn = strip(read("supabase", "functions", "cron-integrity", "index.ts"));

const VIEWS = [
  "v_attendance_day_enriched",
  "v_attendance_in_trend",
  "v_attendance_period_summary",
  "v_leave_balance_current",
  "v_leave_calendar",
  "v_leave_ledger_statement",
];

describe("the test-account flag says what it means", () => {
  it("is its own column, not a reuse of the exclusion flags", () => {
    expect(hide).toContain("ADD COLUMN IF NOT EXISTS is_test_account boolean NOT NULL DEFAULT false");
    // Filtering on these would blank three real managers' own screens.
    expect(hide).not.toContain("NOT e.exclude_from_attendance");
    expect(hide).not.toContain("NOT e.exclude_from_leave_tracking");
  });

  it("marks exactly the two accounts", () => {
    expect(hide).toContain("WHERE employee_code IN ('TT0013', 'TT0001')");
  });

  it("states a reason, because the audit trigger demands one", () => {
    expect(hide).toContain("set_config('app.reason'");
    const reason = /set_config\('app\.reason',\s*'([^']+)'/.exec(hide)?.[1] ?? "";
    expect(reason.length).toBeGreaterThanOrEqual(10);
  });

  it("deletes nothing", () => {
    expect(hide).not.toMatch(/DELETE\s+FROM/i);
    expect(hide).not.toMatch(/DISABLE\s+TRIGGER/i);
    expect(hide).not.toMatch(/DROP\s+TABLE/i);
  });
});

describe("the predicate hides them from everyone except themselves", () => {
  it("exempts the reader, so the accounts stay testable", () => {
    expect(hide).toContain("e.id IS DISTINCT FROM app.current_employee_id()");
  });

  it("is SECURITY DEFINER, because the views it guards are security_invoker", () => {
    const f = hide.slice(hide.indexOf("FUNCTION app.is_hidden_test_account"));
    expect(f.slice(0, 400)).toContain("SECURITY DEFINER");
    expect(f.slice(0, 400)).toContain("STABLE");
    expect(hide).toContain("GRANT EXECUTE ON FUNCTION app.is_hidden_test_account(uuid) TO authenticated");
  });

  it("coalesces to false, so an unmatched id never drops a legitimate row", () => {
    // NULL here would make NOT(...) NULL, and every row would vanish from every view.
    expect(hide).toContain("COALESCE(");
    expect(hide).toContain("false);");
  });
});

describe("all six leaking views are patched, and keep their invoker rights", () => {
  for (const v of VIEWS) {
    it(`${v} filters test accounts and stays security_invoker`, () => {
      expect(hide).toContain(`CREATE OR REPLACE VIEW public.${v}`);
      const body = hide.slice(hide.indexOf(`CREATE OR REPLACE VIEW public.${v}`));
      const upTo = body.slice(0, body.indexOf(";\n"));
      expect(upTo).toContain("security_invoker = true");
      expect(upTo).toContain("NOT app.is_hidden_test_account(");
    });
  }

  it("applies the predicate to the right employee column in each view", () => {
    for (const [v, col] of [
      ["v_attendance_day_enriched", "ad.employee_id"],
      ["v_attendance_in_trend", "ad.employee_id"],
      ["v_leave_balance_current", "lb.employee_id"],
      ["v_leave_calendar", "lr.employee_id"],
      ["v_leave_ledger_statement", "ll.employee_id"],
    ] as const) {
      const body = hide.slice(hide.indexOf(`CREATE OR REPLACE VIEW public.${v}`));
      expect(body.slice(0, body.indexOf(";\n"))).toContain(`app.is_hidden_test_account(${col})`);
    }
  });
});

describe("the kiosk backlog is cleared by fixing its cause", () => {
  it("retires only registrations that have never taken a punch", () => {
    expect(kiosk).toContain("SET is_active = false");
    expect(kiosk).toContain("NOT EXISTS (");
    expect(kiosk).toContain("FROM public.attendance_punches p WHERE p.kiosk_device_id = k.id");
  });

  it("does not delete a device, so it is reversible and auditable", () => {
    expect(kiosk).not.toMatch(/DELETE\s+FROM\s+public\.kiosk_devices/i);
  });

  it("clears the KIOSK_OFFLINE backlog and only that", () => {
    const deletes = kiosk.match(/DELETE\s+FROM\s+\S+/gi) ?? [];
    expect(deletes).toHaveLength(1);
    expect(kiosk).toContain("DELETE FROM public.notifications WHERE event_code = 'KIOSK_OFFLINE'");
  });
});

describe("the gate alert describes a transition, not a heartbeat", () => {
  it("dedupes once per device per DAY, not per hour", () => {
    expect(fn).toContain("kiosk_offline:${device.id}:${istToday()}");
    expect(fn).not.toContain('String(p.hour).padStart(2, "0")}`,\n              payload: detail');
  });

  it("gives up after a week of silence", () => {
    expect(fn).toContain("const OFFLINE_ALERT_GIVE_UP_MINUTES = 7 * 24 * 60;");
    expect(fn).toContain("silent < OFFLINE_ALERT_GIVE_UP_MINUTES");
  });

  it("never notifies for a device that has NEVER checked in", () => {
    // Not a gate that went down — a registration nobody completed.
    expect(fn).toContain("silent !== null &&");
  });

  it("drops the kiosk alert off `high` priority", () => {
    const block = fn.slice(fn.indexOf('eventCode: "KIOSK_OFFLINE"'));
    const upTo = block.slice(0, block.indexOf('roles: ["admin", "super_admin"]'));
    expect(upTo).toContain('priority: "normal"');
    expect(upTo).not.toContain('priority: "high"');
  });

  it("still records every device's true state in system_health", () => {
    // The health push is separate from the notification, so /admin/kiosk is unaffected.
    const kioskTask = fn.slice(fn.indexOf('runTask("kiosk_health"'));
    expect(kioskTask.slice(0, 3000)).toContain("health.push({");
    expect(kioskTask.indexOf("health.push({")).toBeLessThan(kioskTask.indexOf("worthTelling"));
  });
});
