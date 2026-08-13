/**
 * LeaveBalanceRings — the E-05 balance strip, as ratios.
 *
 * ── WHAT THIS ANSWERS THAT THE CARDS DO NOT ────────────────────────────────
 *
 * The cards lead with `available_after_pending`, which is the number you need to
 * fill in a request form. It is not the number you need to decide whether to ask
 * for leave at all: "7 days left" means something completely different on a
 * 30-day entitlement than on an 8-day one. That comparison is a ratio, and a
 * ratio is what a ring is for. The strip sits ABOVE the cards, never instead of
 * them — every figure it draws is also written out in the card below it.
 *
 * ── IT COMPUTES NOTHING ────────────────────────────────────────────────────
 *
 * `availed_days` and `entitlement_days` are columns of `v_leave_balance_current`
 * (leave.api.ts §1); `entitlement_days` is itself server-computed as
 * `opening + accrued + carried_forward + adjusted`. Both are read and formatted,
 * never re-derived — the same rule the card header states and the reason the card,
 * the apply form and the submit guard cannot disagree. The only arithmetic in
 * sight is the arc length, which ProgressRing does from the two values it is
 * handed.
 *
 * ── WHICH TYPES GET A RING ─────────────────────────────────────────────────
 *
 * Day-unit types only — the caller passes the same `cardBalances` split that
 * decides who gets a card, because an hour-unit permission ("2 of 2 remaining")
 * is not a day balance. And a type with no entitlement gets no ring: a ratio out
 * of zero has no denominator, so it would be drawn as an empty track that reads
 * as "none left" when the truth is "nothing was ever granted". Migration 038600
 * sets `annual_quota_days = 0` on every type except SL and EL, so that case is
 * the common one, not the edge.
 */
import { t } from "@/shared/i18n/en";
import { ProgressRing } from "@/shared/ui/charts/ProgressRing";
import { CHART_TONE } from "@/shared/ui/charts/chartTokens";
import type { LeaveBalance } from "../api/leave.api";
import { fmtDays } from "./leave-vocab";

export interface LeaveBalanceRingsProps {
  /** The day-unit balances that also get a card, in the same order. */
  readonly balances: readonly LeaveBalance[];
}

export function LeaveBalanceRings({ balances }: LeaveBalanceRingsProps) {
  const withEntitlement = balances.filter((balance) => balance.entitlement_days > 0);
  if (withEntitlement.length === 0) return null;

  return (
    <ul
      className="mb-5 flex flex-wrap items-start gap-x-4 gap-y-5"
      aria-label={t("leave.balances.rings.aria")}
    >
      {withEntitlement.map((balance) => (
        <li key={balance.leave_type_id} className="flex w-24 flex-col items-center">
          <p
            className="mb-1.5 w-full truncate text-center text-xs font-medium"
            title={balance.leave_type_name}
          >
            {balance.leave_type_name}
          </p>
          <ProgressRing
                /* A leave balance is the clearest ratio in the product; printing it saves the reader dividing availed by entitlement in their head. */
                showPercent
            /* Taken against granted. Both columns, straight from the view. */
            value={balance.availed_days}
            total={balance.entitlement_days}
            centre={fmtDays(balance.availed_days)}
            caption={t("leave.balances.ring.caption", {
              entitled: fmtDays(balance.entitlement_days),
            })}
            title={t("leave.balances.ring.title", { type: balance.leave_type_name })}
            /* One tone for every ring: leave means info everywhere else in the
               app, and the type is named above the ring, so a colour per type
               would carry no information the label does not already carry. */
            color={CHART_TONE.leave}
            size={88}
          />
        </li>
      ))}
    </ul>
  );
}
