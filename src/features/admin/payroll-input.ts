/**
 * payroll-input.ts — turning an operator's keystrokes into integer paise.
 *
 * This is the ONLY arithmetic the payroll screens perform, and it is on typed
 * input, never on a payroll figure: gate 4 requires the approver to type the
 * run's net-pay total, and `payslip-publish` compares it to
 * `payroll_runs.total_net_paise` exactly, to the paise, with no tolerance.
 *
 * It lives outside the component so it can be unit-tested and so the component
 * file exports only components.
 */

/**
 * '₹2,20,000.50' / '220000.5' / '2,20,000' → paise. Returns null for anything
 * that is not a plain rupee amount: a mistyped total must be refused, never
 * guessed at, because the guess would be compared against real money.
 */
export function parseRupeesToPaise(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, "");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(cleaned)) return null;
  const parts = cleaned.split(".");
  const rupees = parts[0] ?? "0";
  const paise = `${parts[1] ?? ""}00`.slice(0, 2);
  return Number(rupees) * 100 + Number(paise);
}
