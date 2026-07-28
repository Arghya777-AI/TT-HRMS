/**
 * period.ts — ONE analytics period, shared by every dashboard, every report and
 * every drill-through.
 *
 * WHY THIS EXISTS
 * ---------------
 * The client asked for analytics filterable day-wise, month-wise, year-wise and by
 * an arbitrary range, with the filter surviving the click into a detail screen:
 *
 *   "On every details page, the same filters should apply … I should be able to
 *    select 2025 and July, or any particular week, or any particular day."
 *
 * Before this, the only filter in the product was `MonthStepper` — month and nothing
 * else — and each screen re-derived its own range. Two screens showing "July" could
 * disagree about whether July means the 1st to the 31st or the last 30 days, and a
 * tile could not hand its period to the screen it opened.
 *
 * A PERIOD IS ALWAYS A CLOSED RANGE OF IST CIVIL DATES, inclusive at both ends. The
 * granularity is kept alongside it, but only so the UI can say "July 2026" instead of
 * "1 Jul – 31 Jul" and so the stepper knows what "previous" means. Every query filters
 * on `from`/`to` — never on the granularity — which is what makes a day, a week and a
 * custom range the same code path rather than three.
 *
 * IST, NOT UTC. Every boundary here is an IST civil date, because this product's
 * business day is IST (`istDate`, and the whole reason `src/lib/datetime.ts` exists).
 * `new Date(Date.UTC(...))` appears below purely as calendar arithmetic on explicit
 * numbers — it never reads the host clock, which is what the repo's lint rule
 * actually forbids.
 *
 * THE URL IS THE SOURCE OF TRUTH. A period lives in the query string, so a filtered
 * dashboard can be bookmarked, sent to somebody, reloaded, and — the point the client
 * made — carried into a detail page by a link that just copies the params.
 */
import { istToday, istMonthRange } from "@/lib/datetime";

export type Granularity = "day" | "week" | "month" | "year" | "range";

export const GRANULARITIES: readonly Granularity[] = ["day", "week", "month", "year", "range"];

export interface Period {
  readonly granularity: Granularity;
  /** Inclusive IST civil date, `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive IST civil date, `YYYY-MM-DD`. */
  readonly to: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // Reject 31 April and 29 Feb in a common year rather than silently shifting.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** Civil date → its UTC-noon anchor. Noon, so no DST or offset can move the day. */
function anchor(isoDate: string): Date {
  const m = ISO_DATE.exec(isoDate);
  if (m === null) throw new RangeError(`Invalid date: ${isoDate}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

function toIso(d: Date): string {
  return `${String(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Civil date plus N days. Pure calendar arithmetic; never reads a clock. */
export function addDays(isoDate: string, days: number): string {
  const d = anchor(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/**
 * The ISO week (Monday–Sunday) containing a date.
 *
 * Monday, not Sunday: this venue's rosters and weekly-off rules are written
 * Monday-first, and a week that disagreed with the roster would make "this week's
 * absences" mean something different from what the manager sees on the roster board.
 */
export function istWeekRange(isoDate: string): { from: string; to: string } {
  const d = anchor(isoDate);
  const dow = d.getUTCDay(); // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1;
  const from = addDays(isoDate, -backToMonday);
  return { from, to: addDays(from, 6) };
}

export function istYearRange(year: number): { from: string; to: string } {
  return { from: `${String(year)}-01-01`, to: `${String(year)}-12-31` };
}

/** The period a screen shows when the URL says nothing: the current IST month. */
export function defaultPeriod(): Period {
  const today = istToday();
  const month = today.slice(0, 7);
  const { from, to } = istMonthRange(month);
  return { granularity: "month", from, to };
}

/** Build a well-formed period for a granularity, anchored on a date inside it. */
export function periodFor(granularity: Granularity, anchorDate: string): Period {
  if (!isIsoDate(anchorDate)) return defaultPeriod();
  switch (granularity) {
    case "day":
      return { granularity, from: anchorDate, to: anchorDate };
    case "week": {
      const { from, to } = istWeekRange(anchorDate);
      return { granularity, from, to };
    }
    case "month": {
      const { from, to } = istMonthRange(anchorDate.slice(0, 7));
      return { granularity, from, to };
    }
    case "year": {
      const { from, to } = istYearRange(Number(anchorDate.slice(0, 4)));
      return { granularity, from, to };
    }
    case "range":
      // A range has no implied span; the caller supplies both ends.
      return { granularity, from: anchorDate, to: anchorDate };
  }
}

/**
 * Step a period backwards or forwards by one of itself.
 *
 * A custom range steps by its own LENGTH, which is the only meaning of "previous"
 * that keeps the comparison like-for-like: the fortnight before this fortnight.
 */
export function shiftPeriod(period: Period, delta: number): Period {
  switch (period.granularity) {
    case "day":
      return periodFor("day", addDays(period.from, delta));
    case "week":
      return periodFor("week", addDays(period.from, delta * 7));
    case "month": {
      const y = Number(period.from.slice(0, 4));
      const m = Number(period.from.slice(5, 7)) + delta;
      const d = new Date(Date.UTC(y, m - 1, 1, 12));
      return periodFor("month", toIso(d));
    }
    case "year":
      return periodFor("year", `${String(Number(period.from.slice(0, 4)) + delta)}-01-01`);
    case "range": {
      const span = daysBetween(period.from, period.to) + 1;
      return {
        granularity: "range",
        from: addDays(period.from, delta * span),
        to: addDays(period.to, delta * span),
      };
    }
  }
}

/** Inclusive-exclusive day count between two civil dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((anchor(to).getTime() - anchor(from).getTime()) / 86_400_000);
}

/** How many days the period covers, inclusive of both ends. */
export function periodLengthDays(period: Period): number {
  return daysBetween(period.from, period.to) + 1;
}

/**
 * The immediately preceding period of the same length — the honest comparison basis
 * for "up 12% on the previous period". Deliberately NOT "the same month last year":
 * a venue's headcount and event calendar change too much for that to mean anything,
 * and a comparison nobody can explain is worse than none.
 */
export function previousPeriod(period: Period): Period {
  return shiftPeriod(period, -1);
}

// ─────────────────────────────────────────────────────────────────────────────
// URL — the source of truth, so a filter survives a click into a detail screen
// ─────────────────────────────────────────────────────────────────────────────

export const PERIOD_PARAM_KEYS = ["g", "from", "to"] as const;

/**
 * Read a period out of query params, falling back to the current month.
 *
 * Deliberately TOTAL: a hand-edited or truncated URL yields the default rather than
 * an exception. An analytics screen that throws because somebody trimmed the address
 * bar is worse than one that shows this month and lets them re-pick.
 */
export function periodFromParams(params: URLSearchParams): Period {
  const g = params.get("g");
  const from = params.get("from");
  const to = params.get("to");
  if (g === null || !(GRANULARITIES as readonly string[]).includes(g)) return defaultPeriod();
  if (from === null || to === null || !isIsoDate(from) || !isIsoDate(to)) return defaultPeriod();
  if (daysBetween(from, to) < 0) return defaultPeriod();
  return { granularity: g as Granularity, from, to };
}

/** The params to put ON a link, so the destination inherits this exact period. */
export function periodToParams(period: Period): Record<string, string> {
  return { g: period.granularity, from: period.from, to: period.to };
}

/**
 * Append the period to a path, preserving anything already in its query string.
 *
 * This is what makes every tile a drill-through that keeps the filter: a caller
 * writes `withPeriod("/admin/attendance/days", period)` and the detail screen reads
 * the same three params with `periodFromParams`.
 */
export function withPeriod(path: string, period: Period): string {
  const [base, existing] = path.split("?");
  const params = new URLSearchParams(existing ?? "");
  for (const [k, v] of Object.entries(periodToParams(period))) params.set(k, v);
  return `${base ?? path}?${params.toString()}`;
}
