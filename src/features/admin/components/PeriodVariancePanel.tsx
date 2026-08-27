/**
 * PeriodVariancePanel — how much more or less than their shifts somebody actually worked, over
 * the selected period.
 *
 * ── WHY IT IS NOT PART OF THE SUMMARY STRIP ──────────────────────────────────
 * Every figure in that strip is a column of `f_attendance_period_summary`, and the header of
 * this page says so. No column of it carries EXPECTED minutes, so over/under cannot be read
 * from it — it has to be summed day by day. Putting a locally-summed number inside a strip
 * documented as "not one of them is added up here" would make that promise false for the next
 * person who reads it.
 *
 * ── THE RULES ARE NOT REIMPLEMENTED HERE ─────────────────────────────────────
 * `periodVariance` is the same function the employee's own attendance summary uses. That matters
 * more than it looks: a holiday expects nothing, approved leave expects nothing, a half day of
 * leave expects half, and a day the engine has not resolved contributes nothing at all. Getting
 * any of those wrong on this screen while the employee's screen gets it right would put an
 * admin and an employee in a meeting with two different numbers.
 *
 * ── AND IT SAYS WHEN IT IS INCOMPLETE ────────────────────────────────────────
 * The read is capped. A period wider than the cap is reported as capped rather than shown as a
 * total, because a partial sum labelled "over / under worked" is worse than no sum.
 */
import { Minus, Plus, Scale } from "lucide-react";
import { t } from "@/shared/i18n/en";
import { fmtDurationHm } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { fmtSignedMinutes, type PeriodVariance } from "@/features/attendance/lib/variance";

export interface PeriodVariancePanelProps {
  variance: PeriodVariance | null;
  loading: boolean;
  /** True when the underlying read hit its cap and the totals would be partial. */
  capped: boolean;
}

export function PeriodVariancePanel({
  variance,
  loading,
  capped,
}: PeriodVariancePanelProps): React.JSX.Element {
  if (capped) {
    return (
      <div className="mt-4 rounded-lg border border-warning/40 bg-warning/5 p-4">
        <p className="text-sm text-warning">{t("admin.pAtt.variance.capped")}</p>
      </div>
    );
  }

  const net = variance?.varianceMinutes ?? 0;

  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <div className="rounded-lg border bg-card p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Scale className="size-3.5 shrink-0" aria-hidden />
          {t("admin.pAtt.variance.net")}
        </p>
        <p
          className={cn(
            "num mt-1 font-display text-2xl font-semibold",
            net > 0 ? "text-success" : net < 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {loading || variance === null ? "…" : fmtSignedMinutes(net)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {variance === null
            ? t("admin.pAtt.variance.netHint")
            : t("admin.pAtt.variance.netCounted", {
              counted: String(variance.countedDays),
              skipped: String(variance.unresolvedDays),
            })}
        </p>
      </div>

      {/*
        Surplus and shortfall side by side as well as netted. A month that comes out forty
        minutes up may be four hours ahead on some days and nearly four behind on others, and
        the net alone hides the thing worth looking at.
      */}
      <div className="rounded-lg border bg-card p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Plus className="size-3.5 shrink-0" aria-hidden />
          {t("admin.pAtt.variance.over")}
        </p>
        <p className="num mt-1 font-display text-2xl font-semibold text-success">
          {loading || variance === null
            ? "…"
            : variance.surplusMinutes === 0
              ? t("common.empty")
              : fmtDurationHm(variance.surplusMinutes)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("admin.pAtt.variance.overHint", { days: String(variance?.surplusDays ?? 0) })}
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Minus className="size-3.5 shrink-0" aria-hidden />
          {t("admin.pAtt.variance.under")}
        </p>
        <p className="num mt-1 font-display text-2xl font-semibold text-destructive">
          {loading || variance === null
            ? "…"
            : variance.shortfallMinutes === 0
              ? t("common.empty")
              : fmtDurationHm(variance.shortfallMinutes)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("admin.pAtt.variance.underHint", { days: String(variance?.shortfallDays ?? 0) })}
        </p>
      </div>
    </div>
  );
}
