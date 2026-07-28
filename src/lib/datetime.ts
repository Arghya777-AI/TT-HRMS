/**
 * datetime.ts — the ONLY sanctioned home of date/time formatting.
 *
 * Binding rules (docs/plan/00-master-plan.md §P2 "IST is the only clock"):
 *  - Instants are stored/transported as UTC (timestamptz / ISO strings).
 *  - Every *business date* is the civil date in Asia/Kolkata — never the UTC
 *    date, never the browser locale. The reference repo derived the day with
 *    `new Date().toISOString().split('T')[0]` (UTC) and mis-filed every punch
 *    between 00:00–05:29 IST. That class of bug is unrepresentable here.
 *
 * ESLint forbids toISOString()-date derivation and toLocale*Date* everywhere
 * except this file (see eslint.config.js). Import these helpers instead.
 */

export const IST_TZ = "Asia/Kolkata" as const;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export type Instant = Date | string | number;

function toDate(input: Instant): Date {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid instant: ${String(input)}`);
  return d;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function monthAbbr(month1to12: number): string {
  const v = MONTHS[month1to12 - 1];
  if (!v) throw new RangeError(`Invalid month: ${month1to12}`);
  return v;
}

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: IST_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: IST_TZ, weekday: "short" });

export interface IstParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23
  minute: number; // 0–59
  second: number; // 0–59
}

/** Decompose an instant into its Asia/Kolkata wall-clock parts. */
export function istParts(input: Instant): IstParts {
  const parts = partsFmt.formatToParts(toDate(input));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`Missing date part: ${type}`);
    return Number(found.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The business-date key: 'YYYY-MM-DD' civil date in IST. Defaults to now. */
export function istDate(input: Instant = new Date()): string {
  const p = istParts(input);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Today's IST civil date, 'YYYY-MM-DD'. */
export function nowIstDate(): string {
  return istDate(new Date());
}

/** '25-Jul-2026' — the one date display format. */
export function fmtDate(input: Instant): string {
  const p = istParts(input);
  return `${pad2(p.day)}-${monthAbbr(p.month)}-${p.year}`;
}

/** '09:05' — IST wall-clock time (24h). */
export function fmtTime(input: Instant): string {
  const p = istParts(input);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** '25-Jul-2026 09:05 IST' — the one instant display format. */
export function fmtDateTime(input: Instant): string {
  return `${fmtDate(input)} ${fmtTime(input)} IST`;
}

/** 'Jul-2026' — month label. */
export function fmtMonth(input: Instant): string {
  const p = istParts(input);
  return `${monthAbbr(p.month)}-${p.year}`;
}

/** '25-Jul' — day+month only, for peer-visible DOB (no year, §P4). */
export function fmtDayMonth(input: Instant): string {
  const p = istParts(input);
  return `${pad2(p.day)}-${monthAbbr(p.month)}`;
}

/** 'Sat' — IST weekday short name. */
export function fmtWeekday(input: Instant): string {
  return weekdayFmt.format(toDate(input));
}

/** '25-Jul-2026 (Sat)' — the one date+weekday display format (§8). */
export function fmtDateWeekday(input: Instant): string {
  return `${fmtDate(input)} (${fmtWeekday(input)})`;
}

/**
 * Format a plain IST civil date string ('YYYY-MM-DD', as returned by a Postgres
 * `date` column) to '25-Jul-2026' WITHOUT any timezone reinterpretation.
 * A `date` has no instant — never route it through `new Date()`.
 */
export function fmtCivilDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return "—";
  const [, y, mo, d] = m;
  if (!y || !mo || !d) return "—";
  return `${d}-${monthAbbr(Number(mo))}-${y}`;
}

/**
 * Format a Postgres `time` value ('HH:MM:SS' / 'HH:MM') as 'HH:mm' 24h.
 *
 * A `time` is a wall-clock, not an instant: routing it through `new Date()`
 * would invent a date and a timezone. Shift windows (`shifts.start_time`,
 * `shifts.end_time`) and policy cut-offs come through here — never through
 * `shifts.display_label`, which the DB builds as `G — 09:30 AM to 06:30 PM`
 * (bare code + 12h, both banned by spec-employee §8 / DR-53).
 */
export function fmtCivilTime(time: string | null | undefined): string {
  if (!time) return "—";
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?/.exec(time);
  if (!m) return "—";
  const [, h, min] = m;
  if (h === undefined || min === undefined) return "—";
  const hour = Number(h);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "—";
  return `${pad2(hour)}:${min}`;
}

/** '14-Sep-2026 (Mon)' from a Postgres `date` — the full date + derived weekday. */
export function fmtCivilDateWeekday(isoDate: string | null | undefined): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return "—";
  return `${fmtCivilDate(isoDate)} (${fmtCivilWeekday(isoDate)})`;
}

/** True when `instant` is still ahead of `now` — e.g. the shift has not ended. */
export function isFutureInstant(instant: Instant, now: Instant = new Date()): boolean {
  return toDate(instant).getTime() > toDate(now).getTime();
}

/**
 * Whole minutes elapsed since an instant — the stopwatch behind the "shift
 * running" line on E-02 Region B. Deliberately NOT a worked-hours figure:
 * worked/payable minutes come from `attendance_days`, which applies the unpaid
 * break, the grace and the day's status. Never label this "Worked".
 */
export function minutesSince(instant: Instant, now: Instant = new Date()): number {
  const ms = toDate(now).getTime() - toDate(instant).getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 60_000);
}

/**
 * Duration in minutes → 'h:mm' (§P6). Never '8.75', never '9.000H'.
 * null/NaN → '—'. Zero → '0:00'. Negative preserved ('-0:15').
 */
export function fmtDuration(totalMinutes: number | null | undefined): string {
  if (totalMinutes == null || Number.isNaN(totalMinutes)) return "—";
  const sign = totalMinutes < 0 ? "-" : "";
  const abs = Math.abs(Math.round(totalMinutes));
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return `${sign}${hours}:${pad2(mins)}`;
}

/**
 * Duration in minutes → '7h 50m' (spec-employee §8 display duration for KPIs,
 * grids and the shell). Zero → '0h 00m' (a value, never blank). null/NaN → '—'.
 */
export function fmtDurationHm(totalMinutes: number | null | undefined): string {
  if (totalMinutes == null || Number.isNaN(totalMinutes)) return "—";
  const sign = totalMinutes < 0 ? "-" : "";
  const abs = Math.abs(Math.round(totalMinutes));
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return `${sign}${hours}h ${pad2(mins)}m`;
}

/**
 * A duration the SERVER expressed in HOURS → '18h 30m'.
 *
 * Several governance views hand back a decimal hour count rather than minutes
 * (`v_approval_inbox.age_hours` / `.sla_remaining_hours`,
 * `sla_breaches.hours_overdue`). Rendering those raw would put '18.5' next to
 * '7h 50m' on the same screen, which is DR-21. This is a UNIT CONVERSION for
 * display, not a derivation: the number itself is still the server's.
 */
export function fmtDurationFromHours(hours: number | null | undefined): string {
  if (hours == null || Number.isNaN(hours)) return "—";
  return fmtDurationHm(hours * 60);
}

/**
 * MINUTES FROM IST MIDNIGHT → an IST wall clock: 554 → '09:14', 1860 → '07:00 (+1d)'.
 *
 * Not a duration and not an instant. The analytics averages ("what time does this
 * person usually arrive") are a MEAN OF MINUTES computed from the day view's own
 * `first_in_hm` / `last_out_hm` strings, so there is no timestamp left to format —
 * and routing the mean back through a `Date` would re-derive a wall clock in the
 * host zone, which is the whole reason this module exists.
 *
 * The day tag is not decoration: `dayClockMinutes` adds 1440 when a shift's last
 * scan precedes its first (this venue runs 19:00–07:00), so a mean departure past
 * midnight is a real and common value. Printed bare it would read '07:00' beside a
 * '19:05' mean arrival — leaving eleven hours before arriving.
 */
export function fmtIstMinutesOfDay(minutes: number | null | undefined): string {
  if (minutes == null || Number.isNaN(minutes)) return "—";
  const total = Math.round(minutes);
  // Floor, not truncate: a negative value (which should not occur, but a mean of
  // corrupt rows could produce one) must borrow a day rather than mirror the clock.
  const dayOffset = Math.floor(total / 1440);
  const inDay = total - dayOffset * 1440;
  const clock = `${pad2(Math.floor(inDay / 60))}:${pad2(inDay % 60)}`;
  if (dayOffset === 0) return clock;
  return `${clock} (${dayOffset > 0 ? "+" : "-"}${Math.abs(dayOffset)}d)`;
}

/** '09:05:33' — live IST wall clock with seconds, for the shell top bar. */
export function nowIstClock(now: Instant = new Date()): string {
  const p = istParts(now);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/** Today's IST civil date 'YYYY-MM-DD' — readability alias of nowIstDate(). */
export function istToday(): string {
  return nowIstDate();
}

/**
 * The current INSTANT as an ISO-8601 UTC string, for writing to a `timestamptz`
 * column (e.g. `profile_confirmed_at`).
 *
 * This is deliberately NOT a business date. Never slice it to get a day — an
 * instant between 00:00 and 05:29 IST has the previous UTC calendar date, which
 * is exactly the reference product's attendance bug. Use `istDate()` for days.
 * Prefer letting Postgres stamp `now()` where the write path allows it.
 */
export function nowInstantIso(now: Instant = new Date()): string {
  return new Date(now).toISOString();
}

/** True if two instants fall on the same IST civil date. */
export function isSameIstDay(a: Instant, b: Instant): boolean {
  return istDate(a) === istDate(b);
}

/**
 * 'YYYY-MM' (a pay-period code, the `?m=` param) → 'Jul-2026'. A month code has
 * no instant and no day — never route it through `new Date()`.
 */
export function fmtCivilMonth(month: string | null | undefined): string {
  if (!month) return "—";
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return "—";
  const [, y, mo] = m;
  if (!y || !mo) return "—";
  const n = Number(mo);
  if (n < 1 || n > 12) return "—";
  return `${monthAbbr(n)}-${y}`;
}

/**
 * Inclusive calendar-month bounds of a 'YYYY-MM' code, as civil dates:
 * '2026-07' → { from: '2026-07-01', to: '2026-07-31' }.
 *
 * This is the range `f_attendance_period_summary` is called with, so a payslip
 * and the attendance screen can ask for the *same* row rather than two
 * near-identical ones. Constructed in UTC and read back in UTC — no timezone
 * reinterpretation, no DST (IST has none anyway).
 */
export function istMonthRange(month: string): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new RangeError(`Invalid month code: ${month}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new RangeError(`Invalid month code: ${month}`);
  // Day 0 of the NEXT month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return {
    from: `${year}-${pad2(mon)}-01`,
    to: `${year}-${pad2(mon)}-${pad2(lastDay)}`,
  };
}

/**
 * Whole seconds → 'm:ss' ('9:42'), for a session countdown such as the E-08
 * "Visible for 9:42" reveal timer. Never negative; null/NaN → '—'.
 */
export function fmtMmSs(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return "—";
  const abs = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(abs / 60)}:${pad2(abs % 60)}`;
}

/**
 * UTC bounds [start, end) of an IST civil date, for range queries against
 * timestamptz columns. For 'YYYY-MM-DD' the window is [date 00:00 IST, next 00:00 IST).
 * IST is a fixed +05:30 offset (no DST), so this is exact.
 */
export function istDayUtcBounds(isoDate: string): { startUtc: Date; endUtc: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`Invalid civil date: ${isoDate}`);
  const startUtc = new Date(`${isoDate}T00:00:00+05:30`);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

/**
 * The same window as `istDayUtcBounds`, spanning an inclusive range of IST civil
 * dates, already serialised as ISO instants ready to hand to a `timestamptz`
 * filter: `[from 00:00 IST, to+1 00:00 IST)`.
 *
 * It exists so that no caller outside this module has to touch `toISOString()`,
 * which the IST guard lint rule forbids — for good reason, since the whole
 * failure mode being prevented is deriving an IST business date from a UTC
 * string. Here the conversion goes the other way (business date → instant) and
 * is exactly what an append-only log filtered on `recorded_at` / `exported_at`
 * needs: comparing a `timestamptz` against a bare 'YYYY-MM-DD' pins it to 00:00
 * UTC, i.e. 05:30 IST, and silently drops the first five and a half hours of
 * every day.
 *
 * The upper bound is EXCLUSIVE — filter with `lt`, not `lte`.
 */
export function istRangeInstantBounds(
  fromIsoDate: string,
  toIsoDate: string,
): { fromInstant: string; toInstantExclusive: string } {
  return {
    fromInstant: istDayUtcBounds(fromIsoDate).startUtc.toISOString(),
    toInstantExclusive: istDayUtcBounds(toIsoDate).endUtc.toISOString(),
  };
}

/**
 * The UTC instant for an IST wall-clock time on a civil date — e.g. the
 * requested check-in on a regularization form ('2026-07-15', '09:24') becomes
 * the timestamptz the server stores.
 *
 * This returns an INSTANT, never a business date: the two are different things,
 * and slicing the result to get a day is exactly the bug the no-toISOString
 * lint rule exists to prevent. It lives here because this file is the only
 * sanctioned home for date/time conversion.
 */
export function istWallClockToInstant(isoDate: string, hhmm: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new RangeError(`Invalid civil date: ${isoDate}`);
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new RangeError(`Invalid time: ${hhmm}`);
  const d = new Date(`${isoDate}T${hhmm}:00+05:30`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid instant: ${isoDate} ${hhmm}`);
  return d.toISOString();
}

// -----------------------------------------------------------------------------
// Civil calendar arithmetic — 'YYYY-MM-DD' and 'YYYY-MM' keys
//
// These are CALENDAR facts (how many days a month has, which of them are past),
// not business facts. They never touch an attendance, leave or payroll number:
// the ban on client-side arithmetic (frontend-contract §5) is about re-deriving
// a metric the server already computed, and a month has 31 days whether or not
// anyone punched in. Everything below is pure date math on a civil-date string,
// deliberately routed through UTC-noon epochs so no timezone can shift a day.
// -----------------------------------------------------------------------------

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** A calendar month key, 'YYYY-MM'. */
export type IstMonthKey = string;

interface YearMonth {
  year: number;
  month: number; // 1–12
}

function parseMonthKey(month: IstMonthKey): YearMonth {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m?.[1] || !m[2]) throw new RangeError(`Invalid month key: ${month}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

function civilDateParts(isoDate: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m?.[1] || !m[2] || !m[3]) throw new RangeError(`Invalid civil date: ${isoDate}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Epoch ms of a civil date pinned to 12:00 UTC — a DST/offset-proof day index. */
function civilEpoch(isoDate: string): number {
  const { year, month, day } = civilDateParts(isoDate);
  return Date.UTC(year, month - 1, day, 12);
}

/** True if `month` is a well-formed 'YYYY-MM' key. */
export function isIstMonthKey(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

/** The current IST calendar month, 'YYYY-MM'. */
export function nowIstMonth(): string {
  return nowIstDate().slice(0, 7);
}

/** The month key a civil date falls in: '2026-07-25' → '2026-07'. */
export function istMonthOfDate(isoDate: string): string {
  civilDateParts(isoDate);
  return isoDate.slice(0, 7);
}

/** Real day count of a calendar month — 28…31, never a 25-day "pay month". */
export function daysInIstMonth(month: IstMonthKey): number {
  const { year, month: m } = parseMonthKey(month);
  return new Date(Date.UTC(year, m, 0, 12)).getUTCDate();
}

/** Every civil date of a calendar month, in order. */
export function istMonthDates(month: IstMonthKey): string[] {
  const { year, month: m } = parseMonthKey(month);
  const total = daysInIstMonth(month);
  const out: string[] = [];
  for (let d = 1; d <= total; d += 1) out.push(`${year}-${pad2(m)}-${pad2(d)}`);
  return out;
}

/** Shift a month key by whole months: ('2026-07', -1) → '2026-06'. */
export function addIstMonths(month: IstMonthKey, delta: number): string {
  const { year, month: m } = parseMonthKey(month);
  const zero = year * 12 + (m - 1) + delta;
  return `${Math.floor(zero / 12)}-${pad2((zero % 12) + 1)}`;
}

/** 'July 2026' — the long month label the E-03 period banner opens with. */
export function fmtMonthLong(month: IstMonthKey): string {
  const { year, month: m } = parseMonthKey(month);
  const name = MONTHS_LONG[m - 1];
  if (!name) throw new RangeError(`Invalid month: ${month}`);
  return `${name} ${year}`;
}

/** -1 / 0 / +1 comparison of two civil dates. */
export function compareCivilDates(a: string, b: string): number {
  const ea = civilEpoch(a);
  const eb = civilEpoch(b);
  return ea < eb ? -1 : ea > eb ? 1 : 0;
}

/** Whole days from `from` to `to`: ('2026-07-25','2026-07-26') → 1. */
export function civilDayOffset(from: string, to: string): number {
  return Math.round((civilEpoch(to) - civilEpoch(from)) / 86_400_000);
}

/**
 * Shift a civil date by whole days: ('2026-07-25', -7) → '2026-07-18'.
 *
 * Civil-date arithmetic, not instant arithmetic — the epoch used here is the
 * UTC-midnight anchor `civilEpoch` already builds, so there is no timezone and
 * no DST to get wrong. This is what the audit console's "last 7 days" /
 * "last 90 days" range presets are built from; they must land on IST business
 * dates, never on `Date.now() - n*86400000` in the browser's own zone.
 */
export function addIstDays(isoDate: string, deltaDays: number): string {
  const shifted = new Date(civilEpoch(isoDate) + deltaDays * 86_400_000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** True when a civil date is strictly after today IST — a `not_yet` day. */
export function isFutureIstDate(isoDate: string): boolean {
  return compareCivilDates(isoDate, nowIstDate()) > 0;
}

/**
 * Dates of `month` that are ≤ today IST — the elapsed-days denominator every
 * percentage on E-03 uses (spec-employee §3.2). 0 for a future month, the full
 * day count for a past one. The deployed `f_attendance_period_summary` does not
 * return `elapsed_days`, and this is a calendar fact, not an aggregate.
 */
export function istMonthElapsedDays(month: IstMonthKey): number {
  const today = nowIstDate();
  const thisMonth = today.slice(0, 7);
  if (month < thisMonth) return daysInIstMonth(month);
  if (month > thisMonth) return 0;
  return civilDateParts(today).day;
}

/** Dates of `month` still to come — the K18 "Days remaining" value. */
export function istMonthRemainingDays(month: IstMonthKey): number {
  return daysInIstMonth(month) - istMonthElapsedDays(month);
}

const utcWeekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });

/** 'Sat' — weekday of a civil date, derived at render, never stored (DR-39). */
export function fmtCivilWeekday(isoDate: string): string {
  return utcWeekdayFmt.format(new Date(civilEpoch(isoDate)));
}

/** '25-Jul (Sat)' — the compact day cell of the E-03 register. */
export function fmtCivilDayMonthWeekday(isoDate: string | null | undefined): string {
  if (!isoDate) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m?.[2] || !m[3]) return "—";
  return `${m[3]}-${monthAbbr(Number(m[2]))} (${fmtCivilWeekday(isoDate)})`;
}

/**
 * '06:04 (+1d)' — an IST wall-clock time tagged with the day offset from the
 * business date it is filed under. A night shift's check-out lands on the next
 * calendar day; showing a bare '06:04' against 24-Jul reads as a 22-hour day.
 */
export function fmtTimeWithDayOffset(
  input: Instant | null | undefined,
  businessDate: string,
): string {
  if (input === null || input === undefined || input === "") return "—";
  const time = fmtTime(input);
  const offset = civilDayOffset(businessDate, istDate(input));
  if (offset === 0) return time;
  return `${time} (${offset > 0 ? "+" : "-"}${Math.abs(offset)}d)`;
}
