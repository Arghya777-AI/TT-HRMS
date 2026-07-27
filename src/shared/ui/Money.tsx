import { MASKED_INR_SHAPE, formatPaise } from "@/lib/money";
import { cn } from "@/lib/utils";

export interface MoneyProps {
  /** Amount in integer PAISE (minor units). null/undefined renders '—'. */
  paise: number | null | undefined;
  /** Render the §P4 mask '₹•,••,•••' instead of the amount. */
  masked?: boolean;
  className?: string;
}

/**
 * INR amount — en-IN grouping via lib/money, tabular figures, right-align in
 * grids via the column `align: 'right'`. Whole rupees drop the paise decimals.
 */
export function Money({ paise, masked = false, className }: MoneyProps) {
  return (
    <span className={cn("num", masked && "masked", className)}>
      {masked ? MASKED_INR_SHAPE : formatPaise(paise)}
    </span>
  );
}
