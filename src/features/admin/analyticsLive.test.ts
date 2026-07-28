/**
 * analyticsLive.test.ts — the realtime layer's decisions, tested where they live: in
 * pure functions and a fake clock. No socket, no channel mock, no React.
 *
 * The three things that can actually go wrong here, and none of them are visible in a
 * rendering test:
 *
 *   1. THE COALESCING IS WRONG IN A WAY THAT ONLY SHOWS AT SHIFT CHANGE. A gate
 *      pushing scans for fifteen minutes is the load that motivated the window, and it
 *      is exactly the load nobody exercises before shipping. Two failure shapes are
 *      possible and both look fine on a quiet dashboard: no coalescing at all (one
 *      ten-thousand-row read per scan — slower than the polling it replaced), and a
 *      re-armed trailing debounce that STARVES, never flushing while events keep
 *      arriving, freezing the dashboard for the whole rush.
 *   2. THE INVALIDATION MISSES THE KEY THE PANELS ACTUALLY USE. Every panel reads one
 *      shared cache entry whose key carries the period and the dimensions, so the
 *      invalidation prefix has to rely on TanStack matching plain objects PARTIALLY.
 *      That behaviour is real, load-bearing, and completely invisible at the call
 *      site — if it were prefix-only, this hook would silently do nothing forever
 *      while reporting "Live". So the match is asserted against a real `QueryClient`
 *      rather than reasoned about.
 *   3. WE SUBSCRIBE TO A TABLE NOBODY PUBLISHED. A `postgres_changes` binding on an
 *      unpublished table joins successfully and then delivers nothing — a dead feed
 *      that claims to be live. The table list is checked against migration 040 itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { filtersToParams, type AnalyticsFilters } from "@/lib/analyticsFilters";
import {
  ANALYTICS_LIVE_TABLES,
  ANALYTICS_LIVE_WINDOW_MS,
  createRefreshCoalescer,
  invalidationKeysFor,
  isAnalyticsLiveTable,
  liveStatusCopy,
  liveStatusFrom,
  type AnalyticsLiveStatus,
  type AnalyticsLiveTable,
} from "./analyticsLive";

const WINDOW = ANALYTICS_LIVE_WINDOW_MS;

// -----------------------------------------------------------------------------
// 1. The window
// -----------------------------------------------------------------------------

describe("createRefreshCoalescer — one refresh per window, leading edge first", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Records the reason set of every flush, so both COUNT and CONTENT are assertable. */
  function coalescer() {
    const flushes: AnalyticsLiveTable[][] = [];
    const it = createRefreshCoalescer<AnalyticsLiveTable>({
      windowMs: WINDOW,
      onFlush: (reasons) => flushes.push([...reasons].sort()),
    });
    return { flushes, ...it };
  }

  it("refreshes a quiet dashboard IMMEDIATELY — the common case pays nothing", () => {
    const c = coalescer();
    c.signal("attendance_days");

    // Before any clock movement at all. A trailing-only debounce would show [] here
    // and add a flat 2s to every single change, waiting for a burst that never comes.
    expect(c.flushes).toEqual([["attendance_days"]]);

    vi.advanceTimersByTime(WINDOW * 5);
    expect(c.flushes).toHaveLength(1);
  });

  it("collapses a burst inside one window into a single trailing refresh", () => {
    const c = coalescer();
    for (let i = 0; i < 50; i += 1) {
      c.signal("attendance_punches");
      vi.advanceTimersByTime(20);
    }

    // 50 scans -> the leading refresh plus ONE trailing refresh. Per-event
    // invalidation would have issued 50 reads of up to ANALYTICS_DAY_ROW_CAP rows.
    expect(c.flushes).toEqual([["attendance_punches"]]);
    vi.advanceTimersByTime(WINDOW);
    expect(c.flushes).toEqual([["attendance_punches"], ["attendance_punches"]]);
  });

  it("keeps every distinct table that changed inside the window, deduped", () => {
    const c = coalescer();
    c.signal("attendance_punches"); // leading
    c.signal("attendance_days");
    c.signal("leave_requests");
    c.signal("attendance_days");
    vi.advanceTimersByTime(WINDOW);

    expect(c.flushes).toEqual([
      ["attendance_punches"],
      // Sorted by the harness; the point is that the day-row restamp and the leave
      // decision both survive the window instead of one overwriting the other.
      ["attendance_days", "leave_requests"],
    ]);
  });

  it("does NOT starve under a continuous stream — the shift-change failure mode", () => {
    const c = coalescer();
    // A scan every 100 ms for ten seconds: 101 events. A debounce re-armed by each
    // event would flush ZERO times here and the dashboard would sit frozen through
    // the entire rush while confidently displaying "Live".
    for (let scan = 0; scan <= 100; scan += 1) {
      c.signal("attendance_punches");
      vi.advanceTimersByTime(100);
    }

    // t=0 (leading) plus one at each window close: 2s, 4s, 6s, 8s, 10s.
    expect(c.flushes).toHaveLength(6);

    // And it settles: the tail event flushes one window later, then it goes quiet.
    vi.advanceTimersByTime(WINDOW);
    expect(c.flushes).toHaveLength(7);
    vi.advanceTimersByTime(WINDOW * 3);
    expect(c.flushes).toHaveLength(7);
  });

  it("re-arms the leading edge once the gate goes quiet", () => {
    const c = coalescer();
    c.signal("attendance_punches");
    vi.advanceTimersByTime(WINDOW * 4); // window closes empty -> idle

    c.signal("attendance_punches");
    // Instant again, with no clock movement: an idle window must not leave the next
    // lone scan waiting 2s for a burst that finished minutes ago.
    expect(c.flushes).toHaveLength(2);
  });

  it("holds the rate across a window boundary instead of double-flushing", () => {
    const c = coalescer();
    c.signal("attendance_punches"); // leading, window closes at 2000
    vi.advanceTimersByTime(WINDOW - 1);
    c.signal("attendance_punches"); // queued
    vi.advanceTimersByTime(1); // trailing flush at 2000, window RE-OPENS
    expect(c.flushes).toHaveLength(2);

    c.signal("attendance_punches"); // 1 ms after a flush — must not flush again
    expect(c.flushes).toHaveLength(2);
    vi.advanceTimersByTime(WINDOW);
    expect(c.flushes).toHaveLength(3);
  });

  it("cancel() drops the queued refresh — nothing lands after unmount", () => {
    const c = coalescer();
    c.signal("attendance_punches");
    c.signal("attendance_days");
    c.cancel();

    vi.advanceTimersByTime(WINDOW * 10);
    expect(c.flushes).toHaveLength(1); // the leading one only

    // Idempotent: StrictMode tears the same effect down twice.
    expect(() => {
      c.cancel();
      c.cancel();
    }).not.toThrow();
    // And a cancelled coalescer is reusable rather than wedged, because React may run
    // the same closure's setup again straight after.
    c.signal("attendance_days");
    expect(c.flushes).toHaveLength(2);
  });

  it("queues a re-entrant signal instead of recursing", () => {
    // Not a realistic Realtime shape, but the leading-edge branch is one line away
    // from unbounded recursion if the window is opened AFTER the callback runs.
    let flushes = 0;
    const c = createRefreshCoalescer<AnalyticsLiveTable>({
      windowMs: WINDOW,
      onFlush: () => {
        flushes += 1;
        if (flushes < 3) c.signal("attendance_days");
      },
    });
    c.signal("attendance_days");

    expect(flushes).toBe(1);
    vi.advanceTimersByTime(WINDOW);
    expect(flushes).toBe(2);
    vi.advanceTimersByTime(WINDOW);
    expect(flushes).toBe(3);
  });
});

// -----------------------------------------------------------------------------
// 2. What an invalidation reaches — asserted against a real QueryClient
// -----------------------------------------------------------------------------

describe("invalidationKeysFor — reaches the shared panel key, and nothing it should not", () => {
  const EMP = "33333333-3333-4333-8333-333333333333";
  const DEPT = "11111111-1111-4111-8111-111111111111";

  function filters(from: string, to: string, extra: Partial<AnalyticsFilters> = {}): AnalyticsFilters {
    return { period: { granularity: "month", from, to }, source: "all", ...extra };
  }

  /**
   * Mirrors `useAnalytics.ts:dayPageKey`. Duplicated on purpose rather than imported:
   * importing the hook module would drag in React and the Supabase client, and this
   * literal IS the contract being pinned — if somebody renames `analytics: "days"`,
   * this test is the thing that notices the dashboard stopped being live.
   */
  function dayPageKey(f: AnalyticsFilters): readonly unknown[] {
    return qk.admin.list({ analytics: "days", ...filtersToParams(f) });
  }

  /** Every cache entry an admin might have open, keyed exactly as its hook keys it. */
  function seededClient() {
    const client = new QueryClient();
    const entries = {
      dayPageJuly: dayPageKey(filters("2026-07-01", "2026-07-31")),
      dayPageAugustByDept: dayPageKey(
        filters("2026-08-01", "2026-08-31", { departmentId: DEPT }),
      ),
      todayBoard: qk.admin.todayBoard({ analytics: "tiles" }),
      captureSplit: qk.admin.punches({
        analytics: "capture-split",
        employee: EMP,
        from: "2026-07-01",
        to: "2026-07-31",
      }),
      leaveRequests: qk.admin.leaveRequests({ status: "pending" }),
      payrollRuns: qk.admin.payrollRuns({ part: "cost-trend" }),
      filterOptions: qk.admin.list({ analytics: "filter-options" }),
      documents: qk.admin.list({ area: "documents", part: "grid" }),
      employees: qk.admin.employees({ q: "" }),
    } as const;
    for (const key of Object.values(entries)) client.setQueryData(key, "seeded");
    return { client, entries };
  }

  /** Apply the hook's invalidations for these tables; report what went stale. */
  function invalidatedBy(tables: readonly string[]): string[] {
    const { client, entries } = seededClient();
    for (const queryKey of invalidationKeysFor(tables)) {
      void client.invalidateQueries({ queryKey });
    }
    return Object.entries(entries)
      .filter(([, key]) => client.getQueryState(key)?.isInvalidated === true)
      .map(([name]) => name)
      .sort();
  }

  it("a punch stales EVERY filtered day page — partial object matching, proven", () => {
    // Both day pages carry different periods and dimensions inside the key object, so
    // this only passes because TanStack matches the object partially. If it ever
    // stopped, the panels would go on showing pre-scan numbers under a "Live" chip.
    expect(invalidatedBy(["attendance_punches"])).toEqual([
      "captureSplit",
      "dayPageAugustByDept",
      "dayPageJuly",
      "todayBoard",
    ]);
  });

  it("a punch does NOT stale the masters, the documents grid or the payroll runs", () => {
    const stale = invalidatedBy(["attendance_punches"]);
    // Reading departments and locations again on every scan is the accidental cost
    // that a wide `qk.admin.lists()` prefix would have bought.
    expect(stale).not.toContain("filterOptions");
    expect(stale).not.toContain("documents");
    expect(stale).not.toContain("employees");
    expect(stale).not.toContain("payrollRuns");
    expect(stale).not.toContain("leaveRequests");
  });

  it("a leave decision moves the attendance day pages too", () => {
    // Sanctioning leave rewrites v_attendance_day_enriched.status without anybody
    // scanning, so a day page that ignored leave_requests would show the person absent.
    expect(invalidatedBy(["leave_requests"])).toEqual([
      "dayPageAugustByDept",
      "dayPageJuly",
      "leaveRequests",
    ]);
  });

  it("a payroll run touches payroll only — it changes no attendance measure", () => {
    expect(invalidatedBy(["payroll_runs"])).toEqual(["payrollRuns"]);
  });

  it("collapses a mixed window into one deduped, order-independent key list", () => {
    const forward = invalidationKeysFor([
      "attendance_punches",
      "attendance_days",
      "leave_requests",
      "payroll_runs",
    ]);
    const reversed = invalidationKeysFor([
      "payroll_runs",
      "leave_requests",
      "attendance_days",
      "attendance_punches",
    ]);

    expect(forward).toEqual(reversed);
    // Four tables, four prefixes: the day-page key is shared by three of them and
    // must appear once, not three times.
    expect(forward).toEqual([
      qk.admin.list({ analytics: "days" }),
      qk.admin.attendanceAll(),
      qk.admin.leaveAll(),
      qk.admin.payrollAll(),
    ]);
  });

  it("ignores a table it does not recognise rather than invalidating the console", () => {
    expect(invalidationKeysFor(["employees", "audit_log", ""])).toEqual([]);
    expect(invalidatedBy(["employees"])).toEqual([]);
  });

  it("issues nothing at all for an empty window", () => {
    expect(invalidationKeysFor([])).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// 3. The tables, and what the screen may claim
// -----------------------------------------------------------------------------

describe("ANALYTICS_LIVE_TABLES", () => {
  it("only names tables migration 040 actually publishes", () => {
    // A binding on an unpublished table joins fine and then delivers nothing: a feed
    // that is dead but reports SUBSCRIBED. Checked against the migration, not a copy.
    const migration = readFileSync(
      join(process.cwd(), "supabase/migrations/20260801004000_realtime_publication.sql"),
      "utf8",
    );
    const published = [...migration.matchAll(/^\s*'([a-z_]+)',?$/gm)].map((m) => m[1]);

    expect(published).toContain("attendance_punches"); // the file was parsed at all
    for (const table of ANALYTICS_LIVE_TABLES) expect(published).toContain(table);
  });

  it("recognises its own members and nothing else", () => {
    for (const table of ANALYTICS_LIVE_TABLES) expect(isAnalyticsLiveTable(table)).toBe(true);
    expect(isAnalyticsLiveTable("attendance_day")).toBe(false);
    expect(isAnalyticsLiveTable("employees")).toBe(false);
  });
});

describe("liveStatusFrom / liveStatusCopy", () => {
  it("claims live ONLY on SUBSCRIBED", () => {
    expect(liveStatusFrom("SUBSCRIBED")).toBe("live");
    expect(liveStatusFrom("CHANNEL_ERROR")).toBe("unavailable");
    expect(liveStatusFrom("CLOSED")).toBe("unavailable");
  });

  it("treats a timeout as still connecting — the transport rejoins itself", () => {
    expect(liveStatusFrom("TIMED_OUT")).toBe("connecting");
  });

  it("degrades an unknown state to not-live", () => {
    // supabase-js has added subscribe states before. An unrecognised one must never
    // be read as success, or a dead channel presents as a live dashboard.
    expect(liveStatusFrom("SOMETHING_NEW")).toBe("unavailable");
    expect(liveStatusFrom("")).toBe("unavailable");
    expect(liveStatusFrom("subscribed")).toBe("unavailable");
  });

  it("gives every status its own copy — a duplicated case would mislabel a chip", () => {
    const statuses: readonly AnalyticsLiveStatus[] = ["off", "connecting", "live", "unavailable"];
    const labels = statuses.map((s) => liveStatusCopy(s).label);
    const hints = statuses.map((s) => liveStatusCopy(s).hint);

    expect(new Set(labels).size).toBe(statuses.length);
    expect(new Set(hints).size).toBe(statuses.length);
  });
});
