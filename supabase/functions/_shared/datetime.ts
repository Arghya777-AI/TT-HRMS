/**
 * _shared/datetime.ts — IST helpers, the server mirror of `util.*` (migration
 * 002) and of `@tt/shared/domain/datetime`.
 *
 * spec-architecture §7: `local/no-raw-date` bans `new Date(`, `Date.now(` and
 * `.toISOString()` everywhere under `supabase/functions/**` EXCEPT this file.
 * That is the whole point — one place computes IST, and it is proven equal to
 * the database by the shared fixture `fixtures/ist-vectors.json` (§8).
 *
 * Correctness argument (same as migration 002's IMMUTABLE risk acceptance):
 * Asia/Kolkata has been a fixed UTC+05:30 with no DST since 1945, so a pure
 * +330-minute shift followed by UTC field reads is exactly
 * `ts AT TIME ZONE 'Asia/Kolkata'`. No Intl, no tz database, no allocation.
 *
 * | this file            | database                       |
 * |----------------------|--------------------------------|
 * | istTimestamp(ts)     | util.ist_ts(p_ts)              |
 * | istDate(ts)          | util.ist_date(p_ts)            |
 * | istTime(ts)          | util.ist_time(p_ts)            |
 * | istToday()           | util.ist_today()               |
 * | istInstant(d, t)     | util.ist_instant(p_date,p_time)|
 * | businessDate(ts, c)  | util.business_date(p_ts,p_cut) |
 * | minutesBetween(a, b) | util.minutes_between(a, b)     |
 * | weekOfMonth(d)       | util.week_of_month(p_date)     |
 * | financialYear(d)     | util.financial_year(p_date)    |
 */

/** Anything an edge function might receive as an instant. */
export type Instant = Date | string | number;

/** IST is UTC+05:30, always. */
export const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;

/** `YYYY-MM-DD` — a business date, never a wall-clock moment. */
export type IsoDate = string;
/** `HH:MM:SS` IST wall clock. */
export type IstTime = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

function toDate(ts: Instant): Date {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`datetime: not a valid instant: ${String(ts)}`);
  }
  return d;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The instant shifted into IST so the UTC getters read IST fields. Internal. */
function shifted(ts: Instant): Date {
  return new Date(toDate(ts).getTime() + IST_OFFSET_MS);
}

// ── Now (the only sanctioned clock reads in the whole functions tree) ────────

/** Current instant. Every other module must call this instead of `new Date()`. */
export function now(): Date {
  return new Date();
}

/** Epoch milliseconds. For timers and skew arithmetic only, never a business date. */
export function nowMs(): number {
  return Date.now();
}

/** `now()` as a `timestamptz`-safe ISO-8601 UTC string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Any instant as an ISO-8601 UTC string (what Postgres stores in `timestamptz`). */
export function toIso(ts: Instant): string {
  return toDate(ts).toISOString();
}

/** Unix seconds. Token `exp`/`iat` claims are the only place these belong. */
export function epochSeconds(ts: Instant = new Date()): number {
  return Math.floor(toDate(ts).getTime() / 1000);
}

/** Unix seconds back to an instant. */
export function fromEpochSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}

/**
 * Parse an instant a client might send: ISO-8601, epoch seconds, or epoch
 * milliseconds. Returns `null` rather than throwing — the caller decides the
 * status code. Values above 1e11 are read as milliseconds (any epoch-second
 * value that large is in the year 5138).
 */
export function parseFlexibleInstant(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    const ms = Math.abs(numeric) > 1e11 ? numeric : numeric * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ── IST field extraction (mirrors util.ist_*) ───────────────────────────────

/** IST calendar/clock fields of an instant. */
export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, in IST. */
  weekday: number;
}

export function istParts(ts: Instant): IstParts {
  const s = shifted(ts);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth() + 1,
    day: s.getUTCDate(),
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
    second: s.getUTCSeconds(),
    weekday: s.getUTCDay(),
  };
}

/** `util.ist_ts` — IST wall clock as `YYYY-MM-DDTHH:MM:SS` (no zone suffix: it is a naive IST timestamp). */
export function istTimestamp(ts: Instant): string {
  return `${istDate(ts)}T${istTime(ts)}`;
}

/** `util.ist_date` — the IST calendar date of an instant. */
export function istDate(ts: Instant): IsoDate {
  const p = istParts(ts);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** `util.ist_time` — the IST wall-clock time of an instant. */
export function istTime(ts: Instant): IstTime {
  const p = istParts(ts);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/** `util.ist_today` — today's business date in IST. NOT the UTC date. */
export function istToday(): IsoDate {
  return istDate(now());
}

/** `util.ist_instant` — inverse: an IST date + wall-clock time back to a UTC instant. */
export function istInstant(date: IsoDate, time: IstTime | string = "00:00:00"): Date {
  assertIsoDate(date);
  const t = TIME_RE.exec(time);
  if (!t) throw new TypeError(`datetime: not a valid IST time: ${time}`);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const utcMs = Date.UTC(y, m - 1, d, Number(t[1]), Number(t[2]), Number(t[4] ?? "0"));
  return new Date(utcMs - IST_OFFSET_MS);
}

// ── Business date (mirrors util.business_date) ───────────────────────────────

/**
 * `util.business_date` — the business date an instant belongs to, given a shift
 * day-cutover. A punch at 02:10 IST on 15-Feb with cutover 05:00 belongs to
 * business date 14-Feb (the night shift that started the previous evening).
 *
 * NOTE ON AUTHORITY: for `attendance_punches` the DATABASE decides
 * (`trg_attendance_punches__business_date`, migration 016) because only it knows
 * the employee's resolved shift. Use this function for display, windowing and
 * cron scoping — never to overwrite `business_date` on a punch insert.
 */
export function businessDate(ts: Instant, cutover: IstTime | string = "05:00:00"): IsoDate {
  const t = TIME_RE.exec(cutover);
  if (!t) throw new TypeError(`datetime: not a valid cutover time: ${cutover}`);
  const cutoverSeconds =
    Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[4] ?? "0");
  const p = istParts(ts);
  const seconds = p.hour * 3600 + p.minute * 60 + p.second;
  const date = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  return seconds < cutoverSeconds ? addDays(date, -1) : date;
}

// ── Date arithmetic on IST business dates (string in, string out) ───────────

export function addDays(date: IsoDate, days: number): IsoDate {
  assertIsoDate(date);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const shiftedMs = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const out = new Date(shiftedMs);
  return `${out.getUTCFullYear()}-${pad2(out.getUTCMonth() + 1)}-${pad2(out.getUTCDate())}`;
}

/** Whole days from `from` to `to` (negative when `to` precedes `from`). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  assertIsoDate(from);
  assertIsoDate(to);
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** `util.minutes_between` — whole minutes, clamped at 0, NULL-safe (0 for missing input). */
export function minutesBetween(from: Instant | null | undefined, to: Instant | null | undefined): number {
  if (from === null || from === undefined || to === null || to === undefined) return 0;
  const ms = toDate(to).getTime() - toDate(from).getTime();
  return Math.max(0, Math.trunc(ms / 60_000));
}

/** Signed whole seconds from `from` to `to`. Used for HMAC clock-skew checks. */
export function secondsBetween(from: Instant, to: Instant): number {
  return Math.trunc((toDate(to).getTime() - toDate(from).getTime()) / 1000);
}

/** `util.week_of_month` — 1..5, calendar-day basis (the weekly-off engine's rule). */
export function weekOfMonth(date: IsoDate): number {
  assertIsoDate(date);
  const day = Number(date.slice(8, 10));
  return Math.ceil(day / 7);
}

/** `util.financial_year` — `2026-07-25` → `2026-27` (Indian FY starts 01-Apr). */
export function financialYear(date: IsoDate): string {
  assertIsoDate(date);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

// ── Guards ──────────────────────────────────────────────────────────────────

export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === "string" && DATE_RE.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function assertIsoDate(value: unknown): asserts value is IsoDate {
  if (!isIsoDate(value)) throw new TypeError(`datetime: not a YYYY-MM-DD date: ${String(value)}`);
}

/** `HH:MM` (24h) for UI-facing strings. Duration formatting stays on the client. */
export function istHhMm(ts: Instant): string {
  const p = istParts(ts);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}
