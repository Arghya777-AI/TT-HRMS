/**
 * sessions.ts — a day's punches as SESSIONS, so fragmented work reads correctly.
 *
 * ── THE DAY THIS EXISTS FOR ──────────────────────────────────────────────────
 * 09:00 in, 13:00 out, 19:00 in, 21:00 out. Six hours worked across two sessions, and the card
 * used to say "4 recorded today" and offer "Punch out" — which was wrong twice over: they were
 * not in, and it told them nothing about the six hours.
 *
 * ── WHY THE CARD MAY PAIR PUNCHES WHEN THE ENGINE DOES NOT ───────────────────
 * The engine reads a day as span-minus-breaks: last scan minus first scan, less any INTERIOR
 * gap over the policy minimum. For an even number of punches that produces exactly the same
 * number as pairing them up — 21:00−09:00 = 720, less the 13:00→19:00 gap of 360, is 360; and
 * (13:00−09:00) + (21:00−19:00) is also 360. So this is not a second opinion about paid time,
 * it is the same arithmetic arranged so a person can see where the hours went.
 *
 * They can also differ by under the policy's `min_break_minutes_to_count` (15 minutes). The
 * engine does not deduct a gap shorter than that, so a sub-15-minute gap between two work
 * periods is paid; this function subtracts it. In practice that gap is somebody walking back
 * through the gate twice, and the difference is single-digit minutes on a day with rapid
 * re-taps. On a real fragmented day — the 09:00/13:00/19:00/21:00 shape this exists for — the
 * two agree exactly, which is what the test asserts.
 *
 * The other case where they differ is an ODD count — somebody who forgot to punch out. The engine
 * has no interior gap to deduct and falls back to the shift's unpaid break; this function shows
 * the open session ticking and says so. Neither is wrong: the engine is computing a settled day,
 * the card is describing an unfinished one.
 *
 * ── DIRECTION IS NOT READ, AND THAT IS DELIBERATE ────────────────────────────
 * Every punch in this system stores `direction = 'undetermined'` — all 1,188 of them — because
 * the engine derives arrival and departure from ORDER, not from a label. So sessions come from
 * position: first, third, fifth are arrivals. Reading the column would give the wrong answer
 * for every existing row, and writing labels into it would break the engine's break detection,
 * which matches `undetermined` gaps specifically.
 */

export interface Session {
  /** ISO instant of the arrival. */
  readonly inAt: string;
  /** ISO instant of the departure, or null while the session is still open. */
  readonly outAt: string | null;
  readonly minutes: number;
}

export interface DaySessions {
  readonly sessions: readonly Session[];
  /** Minutes across every session, the open one counted up to `nowMs`. */
  readonly workedMinutes: number;
  /** True when the last punch was an arrival — they are on the clock now. */
  readonly isIn: boolean;
  /** The open session's arrival, for a live clock. Null when they are out. */
  readonly openSince: string | null;
}

const EMPTY: DaySessions = { sessions: [], workedMinutes: 0, isIn: false, openSince: null };

/**
 * Pair a day's punch instants into sessions.
 *
 * `instants` must be the COUNTED punches for one business date, ascending — duplicates and
 * voids already dropped by the caller, because a suppressed double-scan is not a session
 * boundary and pairing it would split one session into two.
 */
export function daySessions(instants: readonly string[], nowMs: number): DaySessions {
  if (instants.length === 0) return EMPTY;

  const sessions: Session[] = [];
  let worked = 0;

  for (let i = 0; i < instants.length; i += 2) {
    const inAt = instants[i] as string;
    const startMs = Date.parse(inAt);
    if (Number.isNaN(startMs)) continue;

    const outAt = instants[i + 1] ?? null;
    const endMs = outAt === null ? nowMs : Date.parse(outAt);
    if (Number.isNaN(endMs)) continue;

    /*
      Clamped at zero rather than rendered negative. A device with a skewed clock can record a
      punch a few seconds ahead of the browser's idea of now, and "-1 min" on somebody's own
      attendance card reads as a broken system where zero reads as "just arrived".
    */
    const minutes = Math.max(0, Math.floor((endMs - startMs) / 60_000));
    worked += minutes;
    sessions.push({ inAt, outAt, minutes });
  }

  // Odd count means the last arrival has no departure yet.
  const isIn = instants.length % 2 === 1;
  return {
    sessions,
    workedMinutes: worked,
    isIn,
    openSince: isIn ? (instants[instants.length - 1] as string) : null,
  };
}

/**
 * What the next punch will be recorded as.
 *
 * PARITY, which this codebase previously rejected on purpose. The old rule was "the first scan
 * is the arrival and every scan after it is a departure", justified because the engine reads a
 * day as first-in/last-out and so a third scan is not a second arrival.
 *
 * That reasoning held while a day was one stretch of work. It does not hold for the venue's
 * 9-to-1-then-7-to-9 day, where the third scan IS a second arrival — and the engine agrees,
 * because it deducts the interior gap between them as a break. Parity is what makes the button
 * describe the day the employee is actually having.
 *
 * Only the LABEL changes. The stored `direction` stays `undetermined`, decided by the server,
 * so nothing about paid time moves.
 */
export function nextPunchIsArrival(countedPunches: number): boolean {
  return countedPunches % 2 === 0;
}
