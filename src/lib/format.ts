/**
 * format.ts — general value formatting + PII masking (§P4, §P6).
 * Currency lives in money.ts; dates/times/durations in datetime.ts.
 */
import { fmtDuration } from "./datetime";

/** Duration minutes → 'h:mm'. Canonical impl is in datetime.ts. */
export const formatHM = fmtDuration;

export const EM_DASH = "—";

/** Render a value, or an em dash when it is null/undefined/empty. Never 0, never blank. */
export function dash<T>(value: T | null | undefined, render?: (v: T) => string): string {
  if (value == null) return EM_DASH;
  if (typeof value === "string" && value.trim() === "") return EM_DASH;
  return render ? render(value) : String(value);
}

const enINNumber = new Intl.NumberFormat("en-IN");

/** Integer/decimal with Indian grouping: 220000 → '2,20,000'. null/NaN → '—'. */
export function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return EM_DASH;
  return enINNumber.format(value);
}

/**
 * A day count as attendance states it: whole days as '7', halves as '7.5'.
 * Server values arrive as `numeric` (`paid_days`, `leave_days`), so a bare
 * `String()` would print '7.00' on one row and '7' on the next.
 * null → '—'. This is presentation only; nothing here derives a day count.
 */
export function formatDays(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return EM_DASH;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * A day count pinned to one decimal ('16.0'), for the figures that always state
 * their denominator — spec-employee §3.7 K8 'Paid days: 16.0 of 25 elapsed'.
 */
export function formatDaysFixed(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return EM_DASH;
  return value.toFixed(1);
}

export interface PercentOptions {
  digits?: number;
  /** Clamp to [0,100] — use for shares of a whole, not for growth rates. */
  clamp?: boolean;
}

/**
 * Percentage display. The value is ALREADY a percentage (0–100 per schema
 * convention — every metric name ends in _pct). We only append '%'. This is the
 * structural fix for the incumbent's '1,700.00%' (a ratio multiplied by 100 twice).
 */
export function formatPercent(value: number | null | undefined, opts: PercentOptions = {}): string {
  const { digits = 1, clamp = false } = opts;
  if (value == null || Number.isNaN(value)) return EM_DASH;
  const v = clamp ? Math.min(100, Math.max(0, value)) : value;
  return `${v.toFixed(digits)}%`;
}

/** numerator/denominator as a percentage; '—' when the denominator is zero. */
export function formatShare(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
  opts: PercentOptions = {},
): string {
  if (numerator == null || denominator == null || denominator === 0) return EM_DASH;
  return formatPercent((numerator / denominator) * 100, opts);
}

/** Keep the last `visible` chars, mask the rest with X: '1234567890' → 'XXXXXX7890'. */
export function maskTail(value: string | null | undefined, visible = 4): string {
  if (!value) return EM_DASH;
  const s = value.replace(/\s+/g, "");
  if (s.length <= visible) return s;
  return "X".repeat(s.length - visible) + s.slice(-visible);
}

/** PAN: first 4 + last 1 shown → 'CWOPXXXXXB'. */
export function maskPan(pan: string | null | undefined): string {
  if (!pan) return EM_DASH;
  const s = pan.toUpperCase().replace(/\s+/g, "");
  if (s.length !== 10) return maskTail(s, 1);
  return `${s.slice(0, 4)}XXXXX${s.slice(-1)}`;
}

/** Aadhaar: last 4 only, grouped → 'XXXX XXXX 0484'. Never fully revealed in UI. */
export function maskAadhaar(aadhaar: string | null | undefined): string {
  if (!aadhaar) return EM_DASH;
  const s = aadhaar.replace(/\s+/g, "");
  if (s.length !== 12) return EM_DASH;
  return `XXXX XXXX ${s.slice(-4)}`;
}

/** Bank account: last 4 shown. */
export function maskAccount(account: string | null | undefined): string {
  return maskTail(account, 4);
}

/** Mobile: last 4 shown → 'XXXXXX6789'. */
export function maskMobile(mobile: string | null | undefined): string {
  return maskTail(mobile, 4);
}
