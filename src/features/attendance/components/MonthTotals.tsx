/**
 * MonthTotals — the line under the register that answers "so where did the month land".
 *
 * ── WHY IT SITS UNDER THE TABLE ──────────────────────────────────────────────
 * A day-by-day grid answers "what happened on the 3rd". It cannot answer "am I ahead or behind
 * this month" without somebody adding up thirty numbers, which nobody does. The total belongs
 * at the foot of the thing it totals, where a reader arrives at it having just scrolled the
 * evidence for it.
 *
 * ── WHY SURPLUS AND SHORTFALL ARE SHOWN SEPARATELY ───────────────────────────
 * Netting hides the interesting part. A month that lands forty minutes up may be four hours
 * ahead on some days and nearly four behind on others; "+40m" describes that identically to a
 * month where every day was level, and the two are not the same month. So the net is the
 * headline and both directions are underneath it.
 *
 * ── AND WHY UNRESOLVED DAYS ARE NAMED ────────────────────────────────────────
 * On the month that prompted this, nineteen of twenty-five days were "Not processed yet". A
 * total computed over the remaining six is honest only if it says so — otherwise it reads as a
 * verdict on the month rather than on a quarter of it.
 */
import { Fragment } from "react";
import { t } from "@/shared/i18n/en";
import { fmtDurationHm } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import type { AttendanceDay } from "../api/attendance.api";
import { fmtSignedMinutes, periodVariance } from "../lib/variance";

export interface MonthTotalsProps {
  days: readonly AttendanceDay[];
  /** Shown in the heading so the figure is never read against the wrong month. */
  monthLabel: string;
}

export function MonthTotals({ days, monthLabel }: MonthTotalsProps): React.JSX.Element | null {
  const v = periodVariance(days);

  // Nothing to total. An empty month gets the table's own empty state, not a row of zeroes.
  if (v.countedDays === 0 && v.unresolvedDays === 0) return null;

  const net = v.varianceMinutes;
  const tone = net > 0 ? "text-success" : net < 0 ? "text-destructive" : "text-muted-foreground";

  const figures: { label: string; value: string; className?: string }[] = [
    { label: t("attendance.totals.expected"), value: fmtDurationHm(v.expectedMinutes) },
    { label: t("attendance.totals.worked"), value: fmtDurationHm(v.workedMinutes) },
    {
      label: t("attendance.totals.surplus"),
      value: v.surplusMinutes === 0 ? "—" : `+${fmtDurationHm(v.surplusMinutes)}`,
      className: v.surplusMinutes > 0 ? "text-success" : undefined,
    },
    {
      label: t("attendance.totals.shortfall"),
      value: v.shortfallMinutes === 0 ? "—" : `−${fmtDurationHm(v.shortfallMinutes)}`,
      className: v.shortfallMinutes > 0 ? "text-destructive" : undefined,
    },
  ];

  return (
    <section
      className="mt-3 rounded-xl border bg-card p-4"
      aria-label={t("attendance.totals.aria", { month: monthLabel })}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <h3 className="font-display text-sm font-semibold">
            {t("attendance.totals.title", { month: monthLabel })}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("attendance.totals.basis", {
              counted: String(v.countedDays),
              surplusDays: String(v.surplusDays),
              shortfallDays: String(v.shortfallDays),
            })}
          </p>
        </div>

        {/* The headline. Large, signed, and coloured — it is the one number people came for. */}
        <div className="text-right">
          <p className={cn("font-mono text-2xl font-semibold tabular-nums", tone)}>
            {fmtSignedMinutes(net)}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {net === 0
              ? t("attendance.totals.level")
              : net > 0
                ? t("attendance.totals.ahead")
                : t("attendance.totals.behind")}
          </p>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 border-t pt-3 sm:grid-cols-4">
        {figures.map((f) => (
          <Fragment key={f.label}>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {f.label}
              </dt>
              <dd className={cn("font-mono text-sm tabular-nums", f.className)}>{f.value}</dd>
            </div>
          </Fragment>
        ))}
      </dl>

      {/*
        Named, not hidden. A total over six of twenty-five days is a fact about six days, and
        presenting it without that caveat would make it a claim about the month.
      */}
      {v.unresolvedDays > 0 ? (
        <p className="mt-3 border-t pt-3 text-xs text-warning">
          {t("attendance.totals.unresolved", { count: String(v.unresolvedDays) })}
        </p>
      ) : null}
    </section>
  );
}
