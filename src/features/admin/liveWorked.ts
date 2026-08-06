/**
 * liveWorked.ts — how long somebody has been at work RIGHT NOW, ticking.
 *
 * ── WHY NOT `worked_minutes` FROM THE SERVER ─────────────────────────────────
 * `v_attendance_today_board.worked_minutes` is correct and is what payroll uses, but it is a
 * number computed when the query ran. Somebody who scanned in at 10:23 and is still working
 * reads "1h 00m" at 11:23 and still reads "1h 00m" at 11:59, which looks like a frozen screen.
 * The asked-for behaviour is a clock: 1h 00m 01s, 1h 00m 02s, on and on.
 *
 * So the elapsed time is derived in the browser from `first_in_at`, which the view already
 * publishes as a real timestamp, and re-rendered every second.
 *
 * ── BREAKS COUNT, DELIBERATELY ───────────────────────────────────────────────
 * This is wall-clock time since the first scan, with nothing deducted. That is what was asked
 * for and it is the honest reading of "how long have they been here" — but it is NOT the paid
 * figure: the shift's unpaid break is subtracted by the attendance engine, so this number runs
 * ahead of `worked_minutes` by exactly that break. The UI labels it "on site since", never
 * "worked", so the two are never mistaken for each other.
 *
 * ── IT STOPS WHEN THEY LEAVE ─────────────────────────────────────────────────
 * A ticking clock on somebody who went home at 18:30 would still be counting at midnight. Once
 * there is a last-out scan AND the row is no longer live, the span is fixed between the two
 * scans and stops moving.
 */

/** A span, already split into parts, so the formatter does no arithmetic. */
export interface Elapsed {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly totalSeconds: number;
  /** False once it is fixed between two scans — the caller can stop the interval. */
  readonly running: boolean;
}

export interface LiveWorkedInput {
  /** `v_attendance_today_board.first_in_at`. Null when they have not scanned at all. */
  readonly firstInAt: string | null;
  /** `last_out_at`. Present once they have scanned out. */
  readonly lastOutAt: string | null;
  /**
   * Now, in epoch milliseconds, passed in rather than read — this stays a pure function and is
   * testable without waiting for real seconds to pass. Milliseconds rather than a `Date` so no
   * caller has to construct one (see the `new Date()` lint rule) and `nowEpochMs()` slots
   * straight in.
   */
  readonly nowMs: number;
  /**
   * Is this row today's? A historical row must never tick — its span is settled.
   *
   * The board marks a live row by carrying non-null `yetToReach`/`overdue` flags; the caller
   * passes that through rather than re-deriving it from the date, which would go wrong at
   * midnight IST for somebody still on shift.
   */
  readonly isLive: boolean;
}

const NOT_STARTED: Elapsed = {
  hours: 0,
  minutes: 0,
  seconds: 0,
  totalSeconds: 0,
  running: false,
};

/**
 * Elapsed time on site. Pure: the same inputs always give the same answer, which is what makes
 * the ticking behaviour testable without waiting a second.
 */
export function elapsedOnSite(input: LiveWorkedInput): Elapsed {
  const { firstInAt, lastOutAt, nowMs, isLive } = input;
  if (firstInAt === null) return NOT_STARTED;

  const startMs = Date.parse(firstInAt);
  if (Number.isNaN(startMs)) return NOT_STARTED;

  // Fixed span once they have gone, or whenever the row is not today's.
  const stopped = !isLive || lastOutAt !== null;
  const endMs = stopped && lastOutAt !== null ? Date.parse(lastOutAt) : nowMs;
  if (Number.isNaN(endMs)) return NOT_STARTED;

  /*
    A NEGATIVE SPAN IS CLAMPED TO ZERO rather than rendered. It happens: a device with a
    skewed clock, or a punch recorded a few seconds ahead of the browser's idea of now. "-0h
    00m 03s" on a dashboard reads as a broken system; zero reads as "just arrived".
  */
  const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));

  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalSeconds,
    running: !stopped,
  };
}

/**
 * `1h 04m 09s`, or `04m 09s` under the hour.
 *
 * Seconds are always shown while it is running, because the seconds are the whole point — a
 * figure that only changes once a minute is indistinguishable from a frozen one for the first
 * fifty-nine seconds somebody watches it.
 */
export function formatElapsed(e: Elapsed): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  if (e.totalSeconds === 0 && !e.running) return "—";
  return e.hours > 0
    ? `${e.hours}h ${two(e.minutes)}m ${two(e.seconds)}s`
    : `${two(e.minutes)}m ${two(e.seconds)}s`;
}
