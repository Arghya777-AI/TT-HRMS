/**
 * money.ts — the ONLY sanctioned home of currency formatting (§P6).
 * Indian digit grouping via en-IN so "110000" and "1,10,000" can never appear
 * on the same screen. Money is numeric(14,2) in the DB — never float.
 */

const inrWhole = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const inrPaise = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export interface MoneyOptions {
  /** Show two decimal places (paise). Default false — whole rupees. */
  paise?: boolean;
  /** Rendering for null/undefined/NaN. Default '—'. */
  fallback?: string;
}

/** Format an INR amount: 2,20,000 → '₹2,20,000'. null/NaN → '—'. */
export function formatINR(amount: number | null | undefined, opts: MoneyOptions = {}): string {
  const { paise = false, fallback = "—" } = opts;
  if (amount == null || Number.isNaN(amount)) return fallback;
  return (paise ? inrPaise : inrWhole).format(amount);
}

/**
 * Masked money for the default (unrevealed) state (§P4). The mask preserves the
 * Indian digit-group shape so layouts do not jump on reveal: '₹•,••,•••'.
 */
export const MASKED_INR_SHAPE = "₹•,••,•••";

export function maskedINR(): string {
  return MASKED_INR_SHAPE;
}

/**
 * Format an amount held in PAISE (integer minor units) as INR. Whole-rupee
 * amounts render without decimals; anything else keeps 2 decimals.
 */
export function formatPaise(paise: number | null | undefined, opts: MoneyOptions = {}): string {
  if (paise == null || Number.isNaN(paise)) return opts.fallback ?? "—";
  const rupees = paise / 100;
  return formatINR(rupees, { paise: opts.paise ?? paise % 100 !== 0, fallback: opts.fallback });
}

/** Format an amount but mask it when `reveal` is false. */
export function formatINRMasked(
  amount: number | null | undefined,
  reveal: boolean,
  opts: MoneyOptions = {},
): string {
  return reveal ? formatINR(amount, opts) : maskedINR();
}
