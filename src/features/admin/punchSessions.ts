/**
 * Pairing a day's scans into the sessions a reader actually thinks in.
 *
 * ── WHAT THIS FILE GOT WRONG THE FIRST TIME ──────────────────────────────────
 * It paired scans strictly in order — first in, second out, third in, fourth out — and called
 * the first pair the shift and every pair after it extra. The stated reason was that position
 * is safer than the clock, because somebody arriving at 07:00 against a 09:30 shift is early
 * rather than working an extra session.
 *
 * That is true of the FIRST scan and false of every scan after it. Meghana's day read
 * 08:30 · 12:20 · 12:40 · 17:32 and came out as two sessions — 08:30→12:20 as her shift and
 * 12:40→17:32 as "extra" — as though she had finished at lunchtime and come back for a second
 * stint. She had done nothing of the kind: she was on site all day, and the two midday scans
 * are movement inside the venue, not a departure and a return.
 *
 * The venue's own distinction is not position and not the raw clock either. It is the SHIFT
 * BOUNDARY:
 *
 *   · the day has exactly ONE punch-in — the first scan, early or late, no exceptions;
 *   · the day's punch-out is the first scan AT OR AFTER the shift ends, because that is the
 *     scan that ends the working session;
 *   · scans between those two are inside the shift and inside the venue. They do not cut the
 *     day in two;
 *   · a scan after that punch-out opens a POST-WORK session, and the same rule runs again.
 *
 * Arghya — 09:40 · 17:30 · 20:40 · 21:45 against a 09:30–17:30 shift — is the case that shows
 * why. Three of his scans are at or after 17:30, so 17:30 closes the shift and 20:40 opens a
 * genuine return. Meghana has ONE scan at or after her shift end, so it closes her day and she
 * has no extra session at all. Same rule, opposite answers, both correct.
 *
 * ── THE ENGINE STILL OWNS THE HOURS ──────────────────────────────────────────
 * `compute_attendance_day` derives worked minutes by consecutive pairing, so it holds the gap
 * between an out and the next in — Meghana's twenty minutes — off the clock. This file groups
 * scans for READING and does not get a second opinion about the total: where the span it shows
 * exceeds the engine's figure, the difference is time off the clock and `sessionTotals` reports
 * it as such rather than quietly showing a number the next column contradicts.
 */
import { minutesOfTime, wallSpanMinutes } from "./shiftTiming";

/** One scan, as the roster carries it: an IST wall clock already formatted. */
export interface SessionPunch {
  readonly at: string;
}

/** The shift a day is read against. Null anywhere the assignment is missing. */
export interface ShiftWindow {
  /** `'09:30'` or `'09:30:00'`. */
  readonly startTime: string;
  readonly endTime: string;
}

export interface PunchSession<P extends SessionPunch = SessionPunch> {
  /** The scans up to the shift's end; everything after it is somebody coming back. */
  readonly kind: "shift" | "extra";
  readonly inPunch: P;
  /** Null while somebody is still inside — no scan has ended the session yet. */
  readonly outPunch: P | null;
  /**
   * The scans this session swallowed, in order, excluding its own in and out.
   *
   * Meghana's 12:20 and 12:40 land here. They are shown as the day's movement rather than
   * dropped, because a reader who can see four scans on the tablet and two in this column
   * would reasonably conclude the column had lost something.
   */
  readonly within: readonly P[];
  /** Whole minutes from in to out, or null while it is still open. */
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
 * How early a scan may be and still count as arriving for the shift rather than returning
 * after one.
 *
 * A wall clock alone cannot tell 08:30-before-a-09:00-shift from 08:30-the-next-morning: both
 * sit the same distance around the dial. Five hours is the line. Nobody scans in five hours
 * before their shift, and a return five hours after a shift ended is a different day's
 * problem, not this row's.
 */
const EARLY_ARRIVAL_WINDOW_MIN = 300;

/**
 * Where a scan sits relative to the start of its shift, signed.
 *
 * Negative for an early arrival, so that 08:30 against a 09:00 shift reads as −30 rather than
 * 1410 and cannot be mistaken for a scan late the following evening.
 */
function offsetFromShiftStart(hm: string, shiftStartMin: number): number | null {
  const t = parseHm(hm);
  if (t === null) return null;
  const wrapped = (t - shiftStartMin + 1440) % 1440;
  return wrapped > 1440 - EARLY_ARRIVAL_WINDOW_MIN ? wrapped - 1440 : wrapped;
}

/** Pairs scans consecutively — the fallback, and the rule for the post-work stretch. */
function pairConsecutively<P extends SessionPunch>(
  punches: readonly P[],
  kind: PunchSession<P>["kind"],
  firstKind: PunchSession<P>["kind"] = kind,
): PunchSession<P>[] {
  const out: PunchSession<P>[] = [];
  for (let i = 0; i < punches.length; i += 2) {
    const inPunch = punches[i];
    if (inPunch === undefined) break;
    const outPunch = punches[i + 1] ?? null;
    out.push({
      kind: out.length === 0 ? firstKind : kind,
      inPunch,
      outPunch,
      within: [],
      minutes: outPunch === null ? null : minutesBetween(inPunch.at, outPunch.at),
    });
  }
  return out;
}

/**
 * The day's scans, grouped against the shift they were worked to.
 *
 * Input must be oldest-first — the roster query orders by `punched_at`, and re-sorting a
 * pre-formatted `HH:MM` string here would put a post-midnight scan at the front of the day.
 *
 * With no shift window this falls back to consecutive pairing, which is what the engine does
 * and the best available reading when nobody has told the system what hours the person keeps.
 */
export function sessionsFromPunches<P extends SessionPunch>(
  punches: readonly P[],
  shift?: ShiftWindow | null,
): PunchSession<P>[] {
  if (punches.length === 0) return [];

  const startMin = shift ? minutesOfTime(shift.startTime) : null;
  const span = shift ? wallSpanMinutes(shift.startTime, shift.endTime) : null;
  if (startMin === null || span === null) return pairConsecutively(punches, "extra", "shift");

  const first = punches[0]!;
  const firstOffset = offsetFromShiftStart(first.at, startMin);
  if (firstOffset === null) return pairConsecutively(punches, "extra", "shift");

  /*
   * Somebody whose first scan of the day is already past the shift's end never worked the
   * shift — an evening call-out, say. Calling their first stretch "shift" would put a figure
   * under a heading that did not happen, so the whole day is extra.
   */
  if (firstOffset >= span) return pairConsecutively(punches, "extra");

  /* The first scan at or after the shift's end is the one that closes the working session. */
  const closingIndex = punches.findIndex((p) => {
    const o = offsetFromShiftStart(p.at, startMin);
    return o !== null && o >= span;
  });

  if (closingIndex === -1) {
    /*
     * Nothing has ended the session yet. An odd number of scans means the last one was an
     * arrival and they are still inside; an even number means they left before the shift was
     * out, and the last scan is that departure.
     */
    const stillInside = punches.length % 2 === 1;
    const outPunch = stillInside ? null : punches[punches.length - 1]!;
    const within = punches.slice(1, stillInside ? punches.length : punches.length - 1);
    return [{
      kind: "shift",
      inPunch: first,
      outPunch,
      within,
      minutes: outPunch === null ? null : minutesBetween(first.at, outPunch.at),
    }];
  }

  const closing = punches[closingIndex]!;
  const shiftSession: PunchSession<P> = {
    kind: "shift",
    inPunch: first,
    outPunch: closing,
    within: punches.slice(1, closingIndex),
    minutes: minutesBetween(first.at, closing.at),
  };

  /* Anything after the closing scan is a return, read by the same rule from the top. */
  const tail = punches.slice(closingIndex + 1);
  return [shiftSession, ...pairConsecutively(tail, "extra")];
}

export interface SessionTotals {
  /** The working session. */
  readonly shiftMinutes: number;
  /** Everything after it, added together. */
  readonly extraMinutes: number;
  /** Shift plus extra — the span these sessions cover. */
  readonly totalMinutes: number;
  /** True when somebody is still inside, so the total is a running figure. */
  readonly open: boolean;
  /** More than one session — the row has a breakdown worth spelling out. */
  readonly hasExtra: boolean;
  /**
   * Minutes inside the sessions that the engine does NOT count as worked — the gap between an
   * out and the next in, which is Meghana's twenty minutes at lunch.
   *
   * Zero unless the caller supplies the engine's figure. Reported rather than reconciled away:
   * this column exists to explain the number in the next one, and a breakdown that silently
   * disagreed with it by twenty minutes is how the reader stops trusting both.
   */
  readonly offClockMinutes: number;
  /** The engine's worked figure where one was supplied, else the span. */
  readonly workedMinutes: number;
}

export function sessionTotals(
  sessions: readonly PunchSession[],
  engineWorkedMinutes?: number | null,
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

  /*
   * Only ever a DEDUCTION. An engine figure above the span would mean the day carries minutes
   * these scans cannot account for — regularised time, most likely — and presenting that as a
   * negative break would be a worse lie than saying nothing.
   */
  const worked = typeof engineWorkedMinutes === "number" && Number.isFinite(engineWorkedMinutes)
    ? engineWorkedMinutes
    : null;
  const offClockMinutes = worked !== null && !open && worked < totalMinutes
    ? totalMinutes - worked
    : 0;

  return {
    shiftMinutes,
    extraMinutes,
    totalMinutes,
    open,
    hasExtra: sessions.some((s) => s.kind === "extra"),
    offClockMinutes,
    workedMinutes: worked !== null && !open ? worked : totalMinutes,
  };
}
