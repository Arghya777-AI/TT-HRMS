/**
 * shiftTiming.ts — the wall-clock arithmetic of a shift window, in one place.
 *
 * WHY IT IS SHARED RATHER THAN LOCAL. `shifts.duration_minutes` is NOT NULL with no
 * default and the database's `shifts_before_write()` computes it from the window. Any
 * screen that creates a shift must therefore compute the same number, and the rule has
 * one edge case that is easy to get wrong in a second implementation: a window whose end
 * equals its start is a FULL DAY, not zero minutes. `Shifts.page.tsx` had this correct
 * and privately; a second creator on the shift-assignment card would have been the second
 * copy, and the copy that drifts.
 *
 * `crosses_midnight` is NOT computed here. It is a GENERATED column
 * (`end_time <= start_time`), so the database owns it and sending a value would be
 * refused — see the void-guard lesson: generated columns are the database's answer, never
 * the client's input.
 */

/** `'09:30'` or `'09:30:00'` → minutes past midnight, or null when unparseable. */
export function minutesOfTime(value: string | undefined | null): number | null {
  const text = (value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (match === null) return null;
  const hours = Number.parseInt(match[1] ?? "", 10);
  const minutes = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * The wall-clock span of the window, exactly as `shifts_before_write()` computes it:
 * modulo a day, with a zero result meaning a full 24 hours.
 *
 * An overnight window needs no special case — `(end - start + 1440) % 1440` handles
 * 19:00→07:00 as 720 minutes without anybody deciding it "crosses midnight" first.
 */
export function wallSpanMinutes(startTime: string, endTime: string): number | null {
  const start = minutesOfTime(startTime);
  const end = minutesOfTime(endTime);
  if (start === null || end === null) return null;
  const span = (end - start + 1440) % 1440;
  return span === 0 ? 1440 : span;
}

/**
 * `duration_minutes` — the PAID length: the window minus the unpaid break.
 *
 * Returns null when the window will not parse, so a caller can refuse to submit rather
 * than send a fabricated duration into a NOT NULL column.
 */
export function paidDurationMinutes(
  startTime: string,
  endTime: string,
  unpaidBreakMinutes: number,
): number | null {
  const span = wallSpanMinutes(startTime, endTime);
  if (span === null) return null;
  return span - unpaidBreakMinutes;
}

/**
 * Is this a window a shift can actually be built from?
 *
 * The paid length must be positive: a two-hour window with a three-hour unpaid break is
 * arithmetic, not a shift, and `ck_shifts__duration` refuses it at the database. Catching
 * it here turns a constraint name into a sentence.
 */
export function shiftWindowProblem(
  startTime: string,
  endTime: string,
  unpaidBreakMinutes: number,
): "unparseable" | "non_positive" | null {
  const paid = paidDurationMinutes(startTime, endTime, unpaidBreakMinutes);
  if (paid === null) return "unparseable";
  if (paid <= 0) return "non_positive";
  return null;
}
