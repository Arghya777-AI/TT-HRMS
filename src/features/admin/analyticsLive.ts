/**
 * analyticsLive.ts — the PURE half of "when the data changes, everything on the
 * dashboard changes". No React, no Supabase, no socket: this module decides WHEN a
 * refresh is allowed to happen and WHICH query keys it is allowed to touch, which is
 * the whole of the logic worth testing. `hooks/useAnalyticsLive.ts` wires it to the
 * channel; `api/analyticsLive.api.ts` owns the client.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A WINDOW AND NOT ONE REFETCH PER EVENT
 * ═══════════════════════════════════════════════════════════════════════════
 * The analytics surface is not cheap to refresh. Every panel on the screen shares one
 * cached page of `v_attendance_day_enriched` rows — bounded at
 * `ANALYTICS_DAY_ROW_CAP` (10,000) — and an invalidation re-reads the whole page.
 *
 * Now picture a shift change: one gate tablet, sixty to two hundred people through it,
 * scans landing every second or two for a quarter of an hour. `attendance_punches`
 * publishes every INSERT and the engine restamps `attendance_days` behind each one, so
 * a naive `invalidateQueries()` per event issues hundreds of ten-thousand-row reads —
 * and the dashboard gets SLOWER the busier the gate, which is exactly backwards, and
 * measurably worse than the polling this replaces.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY 2,000 ms, AND WHY IT IS A WINDOW RATHER THAN A DEBOUNCE
 * ═══════════════════════════════════════════════════════════════════════════
 * Two seconds is the spec §10 freshness budget (punch → screen), so coalescing inside
 * it cannot make the screen miss the budget it was given. It is also, roughly, the
 * human cadence of a turnstile queue: people scan every one to three seconds, so a
 * window shorter than that (250 ms, 500 ms — the usual debounce reflexes) sits in the
 * GAPS between scans and coalesces nothing at all. Longer (5–10 s) would be cheaper
 * still, but leaves a visibly wrong number on screen while somebody stands watching
 * the gate, which is the complaint that started this.
 *
 * It is a WINDOWED THROTTLE, not `debounce()`, for two reasons that are both real
 * failures rather than preferences:
 *
 *   1. LEADING EDGE. The common case is an idle dashboard and a single scan. A
 *      trailing-only debounce charges that case a flat 2 s of latency for a burst that
 *      never comes. Here the first event flushes immediately and the window only ever
 *      costs anything during an actual burst.
 *   2. NO STARVATION. A trailing debounce that is re-armed by every event never fires
 *      while events keep arriving — a busy gate would hold the dashboard frozen for
 *      the entire fifteen minutes, which is the precise opposite of live. The window
 *      here closes on schedule regardless of what is still arriving.
 *
 * Net cost of a shift change: one flush per two seconds, not one per scan.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE REASONS ARE CARRIED THROUGH THE WINDOW
 * ═══════════════════════════════════════════════════════════════════════════
 * A coalescer that only knows "something changed" has to invalidate everything, so a
 * gate burst would also re-read the payroll cost trend and the admin leave grids —
 * work nobody asked for, on a screen that may not even be mounted. The window
 * accumulates the SET OF TABLES that changed and hands it to the flush, and
 * {@link invalidationKeysFor} maps that set to the narrowest correct key list.
 */
import { qk } from "@/shared/api/keys";
import type { MessageKey } from "@/shared/i18n/en";

// -----------------------------------------------------------------------------
// What we subscribe to
// -----------------------------------------------------------------------------

/**
 * The published tables the analytics layer actually reads through. All four are in
 * `supabase_realtime` (migration 040); subscribing to a table that is NOT published
 * yields a channel that joins happily and then never delivers, which is the worst
 * kind of broken — so this list is deliberately a subset of that migration's twelve,
 * not a wish list.
 *
 * Deliberately absent: `notifications`, `announcements`, `approval_requests`,
 * `system_health` — published, but nothing on the analytics surface is computed from
 * them, and waking a ten-thousand-row read because a bell went off is pure waste.
 */
export const ANALYTICS_LIVE_TABLES = [
  "attendance_punches",
  "attendance_days",
  "leave_requests",
  "payroll_runs",
] as const;

export type AnalyticsLiveTable = (typeof ANALYTICS_LIVE_TABLES)[number];

/** See the header: the spec §10 budget, and the cadence of a turnstile queue. */
export const ANALYTICS_LIVE_WINDOW_MS = 2_000;

export function isAnalyticsLiveTable(table: string): table is AnalyticsLiveTable {
  return (ANALYTICS_LIVE_TABLES as readonly string[]).includes(table);
}

// -----------------------------------------------------------------------------
// Which keys a change is allowed to invalidate
// -----------------------------------------------------------------------------

/**
 * THE shared analytics key, as a PREFIX.
 *
 * `useAnalytics.ts:dayPageKey` builds `qk.admin.list({ analytics: "days", …period,
 * …dimensions })` and every panel — KPI strip, department bars, employee list, daily
 * trend — reads that one entry with its own `select`. TanStack matches query keys by
 * prefix AND matches plain objects inside them PARTIALLY (`partialMatchKey` walks the
 * filter's keys, not the query's), so this three-element key invalidates every
 * filtered day page in the cache regardless of period or dimension — and does not
 * touch `{ analytics: "filter-options" }`, `{ area: "documents" }` or any of the other
 * `qk.admin.list` tenants, whose objects have no `analytics: "days"` to match.
 *
 * That partial-match behaviour is load-bearing and invisible at the call site, so
 * `analyticsLive.test.ts` pins it against a real `QueryClient` rather than trusting it.
 */
const ANALYTICS_DAY_PAGES = qk.admin.list({ analytics: "days" });

/**
 * `["admin","attendance"]` — the today board (`qk.admin.todayBoard`), the capture
 * split (`qk.admin.punches`), the summary row and the day grids all hang off it. One
 * prefix, because a scan changes all of them at once and a board that disagrees with
 * the strip above it is the "7 vs 8" defect this repo keeps re-learning.
 */
const ADMIN_ATTENDANCE = qk.admin.attendanceAll();
const ADMIN_LEAVE = qk.admin.leaveAll();
const ADMIN_PAYROLL = qk.admin.payrollAll();

/** Canonical order, so a caller (and a test) gets a deterministic list. */
const ALL_ANALYTICS_KEYS = [
  ANALYTICS_DAY_PAGES,
  ADMIN_ATTENDANCE,
  ADMIN_LEAVE,
  ADMIN_PAYROLL,
] as const;

/**
 * Table → the keys a change to it can legitimately stale.
 *
 * `leave_requests` reaches the DAY PAGES on purpose: sanctioning leave rewrites
 * `v_attendance_day_enriched.status` to `leave` for those dates, so a leave decision
 * moves the attendance numbers even though nobody scanned anything.
 *
 * `payroll_runs` does NOT reach them: the day view carries no payroll column, and a
 * run completing has no effect on any attendance measure. It stales the payroll
 * analytics prefix only (`useAnalyticsOps` hangs its cost trend off `payrollAll()`).
 */
const KEYS_BY_TABLE: Record<AnalyticsLiveTable, readonly (readonly unknown[])[]> = {
  attendance_punches: [ANALYTICS_DAY_PAGES, ADMIN_ATTENDANCE],
  attendance_days: [ANALYTICS_DAY_PAGES, ADMIN_ATTENDANCE],
  leave_requests: [ANALYTICS_DAY_PAGES, ADMIN_LEAVE],
  payroll_runs: [ADMIN_PAYROLL],
};

/**
 * The narrowest correct set of invalidation prefixes for the tables that changed
 * inside one window, deduped and in a stable order.
 *
 * An unrecognised table contributes NOTHING rather than "invalidate everything". The
 * subscription binds exactly {@link ANALYTICS_LIVE_TABLES}, so an unknown name means a
 * binding drifted from this map — and the failure mode of a mystery table quietly
 * re-reading every admin grid on every event is far worse than one measure going
 * stale until the next visit.
 */
export function invalidationKeysFor(
  tables: Iterable<string>,
): readonly (readonly unknown[])[] {
  const wanted = new Set<readonly unknown[]>();
  for (const table of tables) {
    if (!isAnalyticsLiveTable(table)) continue;
    for (const key of KEYS_BY_TABLE[table]) wanted.add(key);
  }
  // Filtering the canonical list (rather than emitting as we go) is what makes the
  // result order-independent of the order events happened to arrive in.
  return ALL_ANALYTICS_KEYS.filter((key) => wanted.has(key));
}

// -----------------------------------------------------------------------------
// The coalescer
// -----------------------------------------------------------------------------

export interface RefreshCoalescerOptions<T> {
  readonly windowMs: number;
  /** Called with every distinct reason seen since the previous flush. Never empty. */
  readonly onFlush: (reasons: ReadonlySet<T>) => void;
}

export interface RefreshCoalescer<T> {
  /** Record a change. May flush synchronously (leading edge) — see the header. */
  readonly signal: (reason: T) => void;
  /** Drop the open window and anything queued in it. Idempotent; safe after unmount. */
  readonly cancel: () => void;
}

/**
 * One flush per `windowMs`, leading edge first.
 *
 * The state machine is three lines but the transitions are the point:
 *
 *   idle          + signal → open a window, FLUSH now (in that order — see `flush`)
 *   window open   + signal → queue the reason (no work)
 *   window closes + queued → FLUSH the queue, RE-OPEN the window
 *   window closes + empty  → go idle (so the next lone event is instant again)
 *
 * Re-opening after a trailing flush is not paranoia: without it, the event that lands
 * one millisecond after the window closes flushes immediately, and a steady stream
 * degenerates into two flushes every window instead of one.
 *
 * Timers come from the ambient `setTimeout`, so `vi.useFakeTimers()` drives this
 * whole machine deterministically without a clock or a socket anywhere near it.
 */
export function createRefreshCoalescer<T>({
  windowMs,
  onFlush,
}: RefreshCoalescerOptions<T>): RefreshCoalescer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** null = nothing queued; a Set = reasons waiting for the window to close. */
  let queued: Set<T> | null = null;

  const openWindow = (): void => {
    timer = setTimeout(closeWindow, windowMs);
  };

  /**
   * The window is opened BEFORE `onFlush` runs, not after. If a flush synchronously
   * produces another signal, an already-open window makes it queue; with the window
   * opened afterwards it would take the leading-edge branch and recurse without bound.
   */
  const flush = (reasons: ReadonlySet<T>): void => {
    openWindow();
    onFlush(reasons);
  };

  const closeWindow = (): void => {
    timer = null;
    if (queued === null) return;
    const reasons = queued;
    // Cleared before the flush so a re-entrant signal lands in the fresh window rather
    // than mutating the set being handed out.
    queued = null;
    flush(reasons);
  };

  return {
    signal(reason: T): void {
      if (timer === null) {
        flush(new Set<T>([reason]));
        return;
      }
      if (queued === null) queued = new Set<T>();
      queued.add(reason);
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      queued = null;
    },
  };
}

// -----------------------------------------------------------------------------
// Status — what the screen is allowed to claim
// -----------------------------------------------------------------------------

/**
 * `off` the caller disabled it · `connecting` joining · `live` receiving ·
 * `unavailable` the socket is not delivering.
 *
 * The distinction that matters is `live` vs everything else: a dashboard that says
 * "Live" while the channel is dead is worse than one that never claimed to be, because
 * a stale number nobody suspects is a stale number somebody acts on.
 */
export type AnalyticsLiveStatus = "off" | "connecting" | "live" | "unavailable";

/**
 * Map a Realtime subscribe state onto what the screen may claim.
 *
 * Typed on `string`, not on the `REALTIME_SUBSCRIBE_STATES` enum, so this module —
 * and its test — stay free of the realtime package entirely. The unknown branch is
 * not defensive padding: supabase-js has added states before, and an unrecognised one
 * must degrade to "not live" rather than be read as success.
 */
export function liveStatusFrom(channelState: string): AnalyticsLiveStatus {
  switch (channelState) {
    case "SUBSCRIBED":
      return "live";
    // The transport rejoins after a timeout on its own, so this is a transient state
    // on the way back to SUBSCRIBED — saying "unavailable" for it would make a
    // one-second network hiccup look like an outage.
    case "TIMED_OUT":
      return "connecting";
    default:
      return "unavailable";
  }
}

export interface LiveStatusCopy {
  readonly label: MessageKey;
  readonly hint: MessageKey;
}

/** The i18n keys for a status chip. Keys, not strings — the component calls `t()`. */
export function liveStatusCopy(status: AnalyticsLiveStatus): LiveStatusCopy {
  switch (status) {
    case "live":
      return {
        label: "admin.analytics.live.live",
        hint: "admin.analytics.live.liveHint",
      };
    case "connecting":
      return {
        label: "admin.analytics.live.connecting",
        hint: "admin.analytics.live.connectingHint",
      };
    case "unavailable":
      return {
        label: "admin.analytics.live.unavailable",
        hint: "admin.analytics.live.unavailableHint",
      };
    case "off":
      return {
        label: "admin.analytics.live.off",
        hint: "admin.analytics.live.offHint",
      };
  }
}
