/**
 * alreadyBooked.ts — what this employee already holds on the dates they just picked.
 *
 * ── WHY THE FORM HAS TO KNOW ─────────────────────────────────────────────────
 * A date can hold two requests, but only as opposite halves (migration 20260907090000).
 * That rule is exactly right and completely invisible: an employee holding the first half of
 * 5 Sep who asks for another half day gets a 23P01 naming a request number, and no idea that
 * the fix is to choose the OTHER half. Darshan P V tried four times and raised a ticket.
 *
 * So the screen reads what they already hold and says the useful thing instead: *you have the
 * first half of this date — take the second and it becomes a full day off*. The database is
 * still the authority; this only removes the guessing.
 *
 * ── WHY IT IS A MODULE AND NOT AN INLINE CHECK ───────────────────────────────
 * The rule it mirrors is not obvious and has four outcomes, not two. Every one of them is a
 * sentence somebody reads while mid-application, and each has to be right:
 *
 *   · the complement is free            → suggest it, and say what it adds up to
 *   · both halves already held          → the date is full, whatever `portion` says
 *   · a half is free but they asked     → the useful answer is "make it 0.5", not "refused"
 *     for a whole day
 *   · the range spans several dates     → a portion is meaningless across a range, so a
 *     and touches a booking               booking anywhere inside it is a hard clash
 *
 * ── THE ONE SUBTLETY ─────────────────────────────────────────────────────────
 * `portion` is only meaningful when `from_date = to_date`. `rebuild_leave_request_days`
 * stamps `CASE WHEN p_from = p_to THEN p_portion ELSE 'full_day' END`, so a multi-day row
 * carrying 'first_half' is a full-day booking wearing a stale label. Reading that label
 * without the single-date test would offer somebody a complement to a week of leave.
 */
import type { HalfPortion } from "./leavePortion";

/** One live booking of this employee's, in the shape the advice needs. */
export interface BookedLeave {
  readonly requestNumber: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly portion: string;
  readonly typeName: string;
}

export type BookedAdvice =
  | { readonly kind: "none" }
  | {
      readonly kind: "complement";
      readonly date: string;
      readonly heldPortion: HalfPortion;
      readonly suggestPortion: HalfPortion;
      readonly typeName: string;
      readonly requestNumber: string;
      /** True once the form is asking for the half that is actually free. */
      readonly chosenIsFree: boolean;
    }
  | {
      readonly kind: "blocked";
      readonly date: string;
      readonly typeName: string;
      readonly requestNumber: string;
      readonly why: "fullDay" | "needHalfDay" | "rangeCoversBooking";
      /** Set only for `needHalfDay` — the half they could still take. */
      readonly suggestPortion: HalfPortion | null;
    };

/** Floating point: a total built by repeated addition need not land exactly on .5. */
export function endsInHalf(total: number): boolean {
  return total > 0 && Math.abs((total % 1) - 0.5) < 1e-9;
}

function isHalf(portion: string): portion is HalfPortion {
  return portion === "first_half" || portion === "second_half";
}

/** A booking carries a real half only when it is a single date — see the header. */
function heldHalfOf(b: BookedLeave): HalfPortion | null {
  return b.fromDate === b.toDate && isHalf(b.portion) ? b.portion : null;
}

export function opposite(portion: HalfPortion): HalfPortion {
  return portion === "first_half" ? "second_half" : "first_half";
}

/**
 * The first date the two actually share.
 *
 * Reporting the BOOKING's start would name a date the employee did not pick: somebody
 * choosing 5 Sep against leave running 4–6 Sep would be told "4 Sep is already fully booked",
 * which is true and answers a question nobody asked. Both are ISO days, so they compare as
 * text.
 */
function clashDate(booking: BookedLeave, fromDate: string): string {
  return booking.fromDate > fromDate ? booking.fromDate : fromDate;
}

export interface AdviceInput {
  readonly fromDate: string;
  readonly toDate: string;
  readonly totalDays: number;
  readonly chosenHalf: HalfPortion;
  readonly bookings: readonly BookedLeave[];
}

export function adviseOnBooked(input: AdviceInput): BookedAdvice {
  const { fromDate, toDate, bookings } = input;
  if (fromDate === "" || toDate === "" || toDate < fromDate) return { kind: "none" };

  /* Half-open on neither side: two ranges touch when each starts on or before the other ends.
     The same test the overlap guard makes with `daterange(...) && daterange(...)`. */
  const touching = bookings.filter((b) => b.fromDate <= toDate && b.toDate >= fromDate);
  if (touching.length === 0) return { kind: "none" };

  const singleDate = fromDate === toDate;
  const halves = touching.filter((b) => heldHalfOf(b) !== null);
  const wholes = touching.filter((b) => heldHalfOf(b) === null);

  /* A booking that is not a single-date half occupies every date it covers. Nothing can be
     added to those dates at all, so this outranks every other reading. */
  const blocker = wholes[0];
  if (blocker !== undefined) {
    return {
      kind: "blocked",
      date: clashDate(blocker, fromDate),
      typeName: blocker.typeName,
      requestNumber: blocker.requestNumber,
      why: singleDate ? "fullDay" : "rangeCoversBooking",
      suggestPortion: null,
    };
  }

  /* Only half-day bookings remain. Across a range the new request would be stamped
     `full_day`, which clashes with a half just as surely as with a whole day. */
  const first = halves[0];
  if (first === undefined) return { kind: "none" };
  if (!singleDate) {
    return {
      kind: "blocked",
      date: clashDate(first, fromDate),
      typeName: first.typeName,
      requestNumber: first.requestNumber,
      why: "rangeCoversBooking",
      suggestPortion: null,
    };
  }

  /* Both halves already held. `portion` on each still reads as a half, so only counting the
     distinct halves tells the truth about the date. */
  const held = new Set(halves.map((b) => heldHalfOf(b)));
  if (held.size >= 2) {
    return {
      kind: "blocked",
      date: clashDate(first, fromDate),
      typeName: first.typeName,
      requestNumber: first.requestNumber,
      why: "fullDay",
      suggestPortion: null,
    };
  }

  const heldPortion = heldHalfOf(first);
  if (heldPortion === null) return { kind: "none" };
  const suggestPortion = opposite(heldPortion);

  /* The half IS free — but they asked for a whole day, and only half of this date is left.
     "Refused" is the wrong answer here; "make it 0.5" is the one they want. */
  if (!endsInHalf(input.totalDays)) {
    return {
      kind: "blocked",
      date: clashDate(first, fromDate),
      typeName: first.typeName,
      requestNumber: first.requestNumber,
      why: "needHalfDay",
      suggestPortion,
    };
  }

  return {
    kind: "complement",
    date: first.fromDate,
    heldPortion,
    suggestPortion,
    typeName: first.typeName,
    requestNumber: first.requestNumber,
    chosenIsFree: input.chosenHalf === suggestPortion,
  };
}
