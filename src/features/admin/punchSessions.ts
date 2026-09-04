/**
 * Grouping a day's scans into the sessions a reader actually thinks in.
 *
 * ── THE RULE, AS THE VENUE STATES IT ─────────────────────────────────────────
 * A day has ONE working session and — only if somebody genuinely left and came back after the
 * shift had ended — one or more extra ones.
 *
 *   · The day's first scan is the ONE punch-in, whether it is early or late. Being early does
 *     not open a session of its own.
 *   · Every scan after it that still falls inside the shift — a walk across the campus, lunch,
 *     a trip to the gate — is an OUT, not a new arrival. The LAST of them is the day's out.
 *   · A scan after the shift has ended, by more than a grace, is a RETURN. That opens an extra
 *     session, and returns pair among themselves.
 *
 * Consecutive pairing was wrong, and this is the case that showed it: 08:30, 12:20, 12:40,
 * 17:32 against a 09:30–17:30 shift read as "shift 08:30–12:20, extra 12:40–17:32" — as though
 * a sales manager finished her day at lunchtime and came back for a second one. She did not.
 * She scanned twice around lunch and left at 17:32.
 *
 * Compare 09:40, 17:30, 20:40, 21:45 on the same shift, where 20:40 is three hours PAST the
 * end. That is a real return, and it does split into two sessions.
 *
 * ── THE BREAK STAYS DEDUCTED ─────────────────────────────────────────────────
 * Grouping the mid-shift scans into one session does not pay anybody for lunch. Scans INSIDE a
 * session still pair off into gaps, and those gaps are deducted exactly as
 * `compute_attendance_day` deducts them — so a session reads span minus its breaks, and the
 * column still adds up to the engine's own worked total in the next column.
 *
 * ── WITHOUT A SHIFT WINDOW ───────────────────────────────────────────────────
 * Falls back to consecutive pairing. Nothing can honestly say which scan closed a working
 * session without knowing when the session was meant to end, and assuming 09:30 for somebody
 * on nights would file their whole evening under "extra".
 */

/** One scan, as the roster carries it: an IST wall clock already formatted. */
export interface SessionPunch {
  readonly at: string;
}

export interface ShiftWindow {
  readonly startTime: string;
  readonly endTime: string;
}

/**
 * How far past the shift end a scan may still be the day's departure rather than a return.
 *
 * Thirty minutes, matching the shift's own overtime threshold — the venue's existing answer to
 * "how long past the end before this stops being just leaving". A 17:32 scan against a 17:30
 * shift is plainly a departure; a 20:40 one is plainly not.
 */
export const RETURN_AFTER_MINUTES = 30;

export interface PunchSession<P extends SessionPunch = SessionPunch> {
  /** The working session, or somebody coming back after it ended. */
  readonly kind: "shift" | "extra";
  readonly inPunch: P;
  /** Null while somebody is still inside — an odd number of scans in the group. */
  readonly outPunch: P | null;
  /**
   * The scans BETWEEN the in and the out: movement on campus, not arrivals.
   *
   * Kept rather than discarded so the cell can still show them. A reader who can see four
   * scans on the tablet and two in this column would fairly conclude the column lost two.
   */
  readonly within: readonly P[];
  /** Wall-clock span from the in to the out, or null while the session is open. */
  readonly minutes: number | null;
}

/**
 * `"09:40"` -> 580. Null for anything that is not a wall clock.
 *
 * SECONDS ARE OPTIONAL, AND THAT IS NOT COSMETIC. Punch times arrive from `fmtTime` as
 * "HH:MM", but a shift's `start_time`/`end_time` are Postgres `time` columns and arrive as
 * "09:30:00". Requiring exactly HH:MM parsed the scans and rejected the shift, so
 * `sessionsFromPunches` fell back to consecutive pairing on EVERY row — and the whole
 * shift-boundary rule silently did nothing. It looked correct in tests because the fixtures
 * were written as "17:30"; production sends "17:30:00".
 */
export function parseHm(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(hm.trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Minutes from one wall clock to the next, allowing the pair to cross midnight.
 *
 * A night session opening at 22:10 and closing at 02:30 is four hours twenty, not minus
 * nineteen hours. Only the closing half may wrap: a session is never longer than a day, so an
 * out reading earlier than its in can only be the next morning.
 */
export function minutesBetween(inHm: string, outHm: string): number | null {
  const a = parseHm(inHm);
  const b = parseHm(outHm);
  if (a === null || b === null) return null;
  return b >= a ? b - a : b + 24 * 60 - a;
}

/**
 * How early somebody may arrive and still be arriving FOR the shift rather than returning
 * after one. Four hours: generous for a keen early start, far short of the fourteen hours
 * between an evening call-out and the next morning's shift.
 */
const EARLY_ARRIVAL_MINUTES = 240;

/** Does this wall clock fall inside the shift window, which may wrap past midnight? */
function isWithinShift(at: number, start: number, end: number): boolean {
  return start <= end ? at >= start && at <= end : at >= start || at <= end;
}

/**
 * Is this scan a RETURN after the shift, rather than inside it or early for it?
 *
 * Two things have to be true: it is not inside the window, and it is not close enough to the
 * next start to be somebody arriving early. The second half is what a naive "after the end"
 * test gets wrong on a NIGHT shift — 18:50 against a 19:00-07:00 window is ten minutes early,
 * not a call-out, and every hour of the evening would otherwise read as one.
 */
function isAfterShift(atHm: string, shift: ShiftWindow): boolean {
  const at = parseHm(atHm);
  const start = parseHm(shift.startTime);
  const end = parseHm(shift.endTime);
  if (at === null || start === null || end === null) return false;
  if (isWithinShift(at, start, end)) return false;
  const untilStart = minutesBetween(atHm, shift.startTime);
  if (untilStart !== null && untilStart <= EARLY_ARRIVAL_MINUTES) return false;
  return true;
}

/** One session from a group of scans: first in, last out, everything between kept as `within`. */
function buildSession<P extends SessionPunch>(
  group: readonly P[],
  kind: "shift" | "extra",
): PunchSession<P> {
  const inPunch = group[0] as P;
  /*
    PARITY DECIDES WHETHER THE SESSION IS CLOSED. An even number of scans means the last one
    was a departure; an odd number means the person is still inside and the trailing scans are
    movement. Three scans before the shift end is somebody mid-day, not somebody who left.
  */
  const closed = group.length >= 2 && group.length % 2 === 0;
  const outPunch = closed ? ((group[group.length - 1] ?? null) as P | null) : null;
  const within = closed ? group.slice(1, group.length - 1) : group.slice(1);
  return {
    kind,
    inPunch,
    outPunch,
    within,
    minutes: outPunch === null ? null : minutesBetween(inPunch.at, outPunch.at),
  };
}

/** Pair scans two by two — the fallback when no shift is assigned. */
function pairConsecutively<P extends SessionPunch>(punches: readonly P[]): PunchSession<P>[] {
  const out: PunchSession<P>[] = [];
  for (let i = 0; i < punches.length; i += 2) {
    if (punches[i] === undefined) break;
    const group = punches.slice(i, i + 2);
    out.push(buildSession(group, out.length === 0 ? "shift" : "extra"));
  }
  return out;
}

/**
 * The day's scans, grouped into a working session and any genuine returns.
 *
 * Input must be oldest-first — the roster query orders by `punched_at`, and re-sorting a
 * pre-formatted `HH:MM` here would put a post-midnight scan at the front of the day.
 */
export function sessionsFromPunches<P extends SessionPunch>(
  punches: readonly P[],
  shift: ShiftWindow | null = null,
  graceMinutes: number = RETURN_AFTER_MINUTES,
): PunchSession<P>[] {
  const first = punches[0];
  if (first === undefined) return [];
  if (shift === null) return pairConsecutively(punches);

  // A day that begins after the shift has already ended is a call-out: all of it is extra.
  if (isAfterShift(first.at, shift)) return pairConsecutively(punches).map((s) => ({ ...s, kind: "extra" as const }));

  /*
    Offsets from the first scan, so a day running past midnight stays monotonic. Comparing raw
    "HH:MM" would sort 00:20 before 22:10 and read a night shift backwards.
  */
  const offsets: number[] = [0];
  for (let i = 1; i < punches.length; i += 1) {
    const prev = punches[i - 1];
    const cur = punches[i];
    if (prev === undefined || cur === undefined) break;
    offsets.push((offsets[i - 1] ?? 0) + (minutesBetween(prev.at, cur.at) ?? 0));
  }

  const endOffset = minutesBetween(first.at, shift.endTime);
  if (endOffset === null) return pairConsecutively(punches);
  const cutoff = endOffset + graceMinutes;

  // Everything inside the shift plus its grace is the working day; the rest is a return.
  let split = punches.length;
  for (let i = 1; i < punches.length; i += 1) {
    if ((offsets[i] ?? 0) > cutoff) {
      split = i;
      break;
    }
  }

  const working = punches.slice(0, split);
  const returns = punches.slice(split);
  const sessions: PunchSession<P>[] = [buildSession(working, "shift")];
  for (const s of pairConsecutively(returns)) sessions.push({ ...s, kind: "extra" });
  return sessions;
}

export interface SessionTotals {
  /** The working session's span. */
  readonly shiftMinutes: number;
  /** Every return's span, added together. */
  readonly extraMinutes: number;
  /** The two added: how long the person was on site across their sessions. */
  readonly totalMinutes: number;
  /** What the attendance engine actually counted as worked. */
  readonly workedMinutes: number;
  /**
   * On site but not counted — the mid-shift gaps the engine deducted as breaks.
   *
   * Derived by comparing against the engine rather than re-deducting here, so the column can
   * never disagree with the number beside it. Floored at zero: a regularised day can carry
   * more counted minutes than the scans span, and that is not a negative break.
   */
  readonly offClockMinutes: number;
  /** Somebody is still inside, so the total is a running figure. */
  readonly open: boolean;
  /** A genuine return exists — the day has a sum worth spelling out. */
  readonly hasExtra: boolean;
}

export function sessionTotals(
  sessions: readonly PunchSession[],
  workedMinutes?: number,
): SessionTotals {
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
  const totalMinutes = shiftMinutes + extraMinutes;
  const worked = workedMinutes ?? totalMinutes;
  return {
    shiftMinutes,
    extraMinutes,
    totalMinutes,
    workedMinutes: worked,
    // Never negative, and never claimed against a day still running.
    offClockMinutes: open ? 0 : Math.max(0, totalMinutes - worked),
    open,
    hasExtra: sessions.some((s) => s.kind === "extra"),
  };
}
