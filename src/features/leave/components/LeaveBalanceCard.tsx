/**
 * LeaveBalanceCard — one eligible leave type (spec E-05 balance cards).
 *
 * The headline is `available_after_pending`, the GENERATED column that is
 * literally `opening + accrued + carried_forward + adjusted − availed − pending
 * − encashed − lapsed`. The spec's headline formula subtracts the reserved
 * ("Held") days, and that is the column that does it — so the number a card
 * shows and the number the submit guard checks are the same stored value. The
 * card re-adds nothing; the (i) popover states the formula in words and lists the
 * employee's own components beside it.
 *
 * A type the employee is not eligible for has no `leave_balances` row and so is
 * simply absent — there is no "0 days" placeholder card for a leave you cannot
 * take (spec E-05: "ineligible NOT rendered").
 */
import { Link } from "react-router-dom";
import { Info, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { SplitBar, type SplitSegment } from "@/shared/ui/charts/SplitBar";
import type { LeaveBalance } from "../api/leave.api";
import { fmtDays } from "./leave-vocab";

export interface LeaveBalanceCardProps {
  balance: LeaveBalance;
  /** True when this type accrues but cannot be availed until confirmation. */
  probationLocked: boolean;
  /** `confirmation_due_date`, so the lock states WHEN, not just that. */
  confirmationDue: string | null;
}

interface BreakdownRow {
  label: string;
  value: number;
  /** Hide rows that are structurally zero (encashment on a type that can't be). */
  hideWhenZero?: boolean;
}

export function LeaveBalanceCard({
  balance,
  probationLocked,
  confirmationDue,
}: LeaveBalanceCardProps) {
  const rows: BreakdownRow[] = [
    { label: t("leave.balance.opening"), value: balance.opening_days },
    { label: t("leave.balance.accrued"), value: balance.accrued_days },
    { label: t("leave.balance.carried"), value: balance.carried_forward_days, hideWhenZero: true },
    { label: t("leave.balance.adjusted"), value: balance.adjusted_days, hideWhenZero: true },
    { label: t("leave.balance.used"), value: balance.availed_days },
    { label: t("leave.balance.held"), value: balance.pending_days },
    { label: t("leave.balance.encashed"), value: balance.encashed_days, hideWhenZero: true },
    { label: t("leave.balance.lapsed"), value: balance.lapsed_days, hideWhenZero: true },
  ];
  const visibleRows = rows.filter((r) => !(r.hideWhenZero === true && r.value === 0));

  const numbers = t("leave.balance.numbers", {
    opening: fmtDays(balance.opening_days),
    accrued: fmtDays(balance.accrued_days),
    carried: fmtDays(balance.carried_forward_days),
    adjusted: fmtDays(balance.adjusted_days),
    used: fmtDays(balance.availed_days),
    held: fmtDays(balance.pending_days),
    encashed: fmtDays(balance.encashed_days),
    lapsed: fmtDays(balance.lapsed_days),
    available: fmtDays(balance.available_after_pending),
  });

  /*
    ── WHERE THE YEAR'S ENTITLEMENT WENT ──────────────────────────────────────
    Eight numbers in a definition list say what each component IS. None of them
    says what a reader actually wants to know before booking a holiday: how much
    of the year is left versus already spent. A stacked bar says it in one glance.

    NOTHING IS COMPUTED. Every segment is a stored column, and these five are
    exactly the ones the generated `available_after_pending` is built from — so
    the bar IS the entitlement divided, not a second opinion about it. A sixth
    segment or a subtraction here would be arithmetic competing with Postgres.

    Zero-value segments are dropped by `SplitBar` itself, so a type that cannot
    be encashed or lapsed simply shows fewer bands.
  */
  const segments: readonly SplitSegment[] = [
    {
      key: "available",
      label: t("leave.balance.chart.available"),
      value: balance.available_after_pending,
      tone: "present",
    },
    /* Amber, not green: held days are spoken for but not yet granted, and a
       reader who counts them as taken is as wrong as one who counts them free. */
    { key: "held", label: t("leave.balance.held"), value: balance.pending_days, tone: "late" },
    { key: "used", label: t("leave.balance.used"), value: balance.availed_days, tone: "employer" },
    {
      key: "encashed",
      label: t("leave.balance.encashed"),
      value: balance.encashed_days,
      tone: "leave",
    },
    /* Red, because lapsed days are the only band on this bar that represents
       something the employee LOST rather than chose. */
    { key: "lapsed", label: t("leave.balance.lapsed"), value: balance.lapsed_days, tone: "absent" },
  ];
  const entitled = segments.reduce((sum, seg) => sum + seg.value, 0);

  const applyHref = balance.is_comp_off
    ? "/me/comp-off"
    : `/me/leave/apply?type=${encodeURIComponent(balance.leave_type_id)}`;

  return (
    <div className="flex flex-col rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-medium leading-tight">{balance.leave_type_name}</h3>
          {balance.is_paid ? null : (
            <p className="mt-0.5 text-xs text-muted-foreground">{t("leave.balance.unpaidType")}</p>
          )}
        </div>
        <Popover>
          <PopoverTrigger
            className="-m-1 shrink-0 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`How ${balance.leave_type_name} available days are worked out`}
          >
            <Info className="h-3.5 w-3.5" />
          </PopoverTrigger>
          <PopoverContent className="w-80 text-sm" align="end">
            <p className="font-medium">{t("leave.balance.formula")}</p>
            <p className="mt-1.5 text-muted-foreground">{numbers}</p>
          </PopoverContent>
        </Popover>
      </div>

      <p className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">
        {t("leave.balance.available")}
      </p>
      <p className="num font-display text-3xl font-semibold leading-none">
        {fmtDays(balance.available_after_pending)}
      </p>

      {entitled > 0 ? (
        <div className="mt-3">
          <SplitBar
            title={t("leave.balance.chart.title", { type: balance.leave_type_name })}
            segments={segments}
            legend={false}
            height={8}
            format={(v) => fmtDays(v)}
          />
        </div>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
        {visibleRows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-2">
            <dt className="truncate text-xs text-muted-foreground">{row.label}</dt>
            <dd className="num tabular-nums">{fmtDays(row.value)}</dd>
          </div>
        ))}
      </dl>

      {balance.pending_days > 0 ? (
        <p className="mt-3 text-xs text-warning">
          {t("leave.balance.heldNote", { days: fmtDays(balance.pending_days) })}
        </p>
      ) : null}

      {balance.expiring_soon_days > 0 && balance.nearest_expiry !== null ? (
        <p className="mt-1 text-xs text-warning">
          {t("leave.balance.expiring", {
            days: fmtDays(balance.expiring_soon_days),
            date: fmtCivilDate(balance.nearest_expiry),
          })}
        </p>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        {probationLocked ? (
          <>
            <Badge variant="neutral" className="gap-1">
              <Lock className="h-3 w-3" aria-hidden />
              {t("leave.balance.probation")}
            </Badge>
            <Button size="sm" variant="outline" disabled>
              {t("leave.balance.apply")}
            </Button>
          </>
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link to={applyHref}>{t("leave.balance.apply")}</Link>
          </Button>
        )}
      </div>

      {probationLocked ? (
        <p className={cn("mt-2 text-xs text-muted-foreground")}>
          {t("leave.balance.probationHint", {
            on:
              confirmationDue === null
                ? ""
                : t("leave.balance.probationOn", { date: fmtCivilDate(confirmationDue) }),
          })}
        </p>
      ) : null}
    </div>
  );
}
