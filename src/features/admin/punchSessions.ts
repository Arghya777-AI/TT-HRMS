/**
 * Pairing a day's scans into the sessions a reader actually thinks in.
 *
 * ── WHY THE FLAT LIST WAS NOT ENOUGH ─────────────────────────────────────────
 * The roster showed four chips in a row — 09:40, 17:30, 20:40, 21:45 — and left the reader to
 * work out which was an arrival and which a departure, and which pair was the shift and which
 * was somebody coming back in the evening. On a row that also says "8h 55m" the obvious
 * question is *how* those hours were made up, and the chips could not answer it.
 *
 * ── THE RULE, AS THE VENUE STATES IT ─────────────────────────────────────────
 * Scans pair in the order they were taken: first in, second out, third in, fourth out. So
 *
 *   · a punch-in before the shift starts is still just the day's ONE punch-in — being early
 *     does not create an extra session;
 *   · the punch-out that closes that pair is the day's out;
 *   · a further punch-in after it opens a POST-WORK session, and the same rule applies again.
 *
 * The FIRST pair is the shift session; every pair after it is extra. That is deliberately not
 * a clock comparison — somebody who starts at 07:00 against a 09:30 shift is early, not
 * working an extra session, and a rule that classified by time would split their day in two.
 *
 * This is the same consecutive pairing `compute_attendance_day` uses to derive worked minutes,
 * so the breakdown shown here adds up to the total the engine put in the row beside it. If the
 * two ever disagree, this is the file that is wrong.
 */

/** One scan, as the roster carries it: an IST wall clock already formatted. */
export interface SessionPunch {
  readonly at: string;
}

export interface PunchSession<P extends SessionPunch = SessionPunch> {
  /** The first pair is the shift; everything after it is somebody coming back. */
  readonly kind: "shift" | "extra";
  readonly inPunch: P;
  /** Null while somebody is still inside — an odd number of scans. */
  readonly outPunch: P | null;
  /** Whole minutes between the pair, or null while it is still open. */
  readonly minutes: number | null;
}

/** `"09:40"` → 580. Null for anything that is not a wall clock. */
export function parseHm(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Minutes from one wall clock to another, allowing the pair to cross midnight.
 *
 * A night session that opens at 22:10 and closes at 02:30 is four hours and twenty minutes,
 * not minus nineteen hours. Only the CLOSING half may wrap; a session is never longer than a
 * day, so an out that reads earlier than its in can only be the next morning.
 */
export function minutesBetween(inHm: string, outHm: string): number | null {
  const a = parseHm(inHm);
  const b = parseHm(outHm);
  if (a === null || b === null) return null;
  return b >= a ? b - a : b + 24 * 60 - a;
}

/**
 * The day's scans, paired in order.
 *
 * Input must be oldest-first — the roster query orders by `punched_at`, and re-sorting a
 * pre-formatted `HH:MM` string here would put a post-midnight scan at the front of the day.
 */
export function sessionsFromPunches<P extends SessionPunch>(
  punches: readonly P[],
): PunchSession<P>[] {
  const out: PunchSession<P>[] = [];
  for (let i = 0; i < punches.length; i += 2) {
    const inPunch = punches[i];
    if (inPunch === undefined) break;
    const outPunch = punches[i + 1] ?? null;
    out.push({
      kind: out.length === 0 ? "shift" : "extra",
      inPunch,
      outPunch,
      minutes: outPunch === null ? null : minutesBetween(inPunch.at, outPunch.at),
    });
  }
  return out;
}

export interface SessionTotals {
  /** The first pair only. */
  readonly shiftMinutes: number;
  /** Everything after it, added together. */
  readonly extraMinutes: number;
  readonly totalMinutes: number;
  /** True when somebody is still inside, so the total is a running figure. */
  readonly open: boolean;
  /** More than one pair — the row has a breakdown worth showing. */
  readonly hasExtra: boolean;
}

export function sessionTotals(sessions: readonly PunchSession[]): SessionTotals {
  let shiftMinutes = 0;
  let extraMinutes = 0;
  let open = false;
  for (const s of sessions) {
    if (s.minutes === null) {
      open = true;
      continue;
    }
    if (s.kind === "shift") shiftMinutes += s.minutes;
    else extraMinutes += s.minutes;
  }
  return {
    shiftMinutes,
    extraMinutes,
    totalMinutes: shiftMinutes + extraMinutes,
    open,
    // A closed second session is what makes the sum worth spelling out; one pair is just a day.
    hasExtra: sessions.some((s) => s.kind === "extra"),
  };
}
