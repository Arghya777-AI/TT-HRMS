/**
 * MonthSummaryPanel — the whole month in one screen: hours, the surplus, and what it means.
 *
 * ── THE LINE THIS PANEL DOES NOT CROSS ───────────────────────────────────────
 * Comp-off days and late deductions are read from the engine, never derived here.
 *
 * That is the most important decision in the file. It would be easy to compute "every eight
 * hours of surplus is a comp-off day" and put it on screen — and it would be wrong, because
 * comp-off is granted by policy (a full day worked on a holiday or a weekly off), and the
 * late-deduction rule lives in `attendance_policies` and is applied server-side. A number
 * invented here would appear beside real ones, in the same typeface, and payroll would not
 * honour it. An employee reading "you have 3 comp-off days" and being told otherwise later has
 * been misled by this screen.
 *
 * So every entitlement figure is `summary.*`, straight from `f_attendance_period_summary`.
 *
 * ── THE ONE FIGURE THAT IS DERIVED, AND HOW IT IS LABELLED ───────────────────
 * The gap between surplus WORKED and overtime RECOGNISED. It is real, it is useful, and it is
 * labelled as a gap rather than as an entitlement — "worked beyond your shifts but not counted
 * as overtime". Presenting it as overtime would promise something nobody has approved.
 *
 * ── WHY UNRESOLVED DAYS LEAD ─────────────────────────────────────────────────
 * On the month that prompted this feature, nineteen of twenty-five days were "Not processed
 * yet". Every figure below is computed over the days that HAVE been processed, so on such a
 * month the caveat is more important than the numbers and is placed above them.
 */
import { AlertTriangle, CalendarCheck, Clock, Minus, Plus, TrendingUp } from "lucide-react";
import { t } from "@/shared/i18n/en";
import { fmtDurationHm } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import type { AttendanceDay, AttendancePeriodSummary } from "../api/attendance.api";
import { consequences, fmtSignedMinutes, periodVariance } from "../lib/variance";

export interface MonthSummaryPanelProps {
  days: readonly AttendanceDay[];
  summary: AttendancePeriodSummary | null;
  monthLabel: string;
}

interface Figure {
  key: string;
  icon: typeof Clock;
  label: string;
  value: string;
  hint: string;
  tone?: string;
}

export function MonthSummaryPanel({
  days,
  summary,
  monthLabel,
}: MonthSummaryPanelProps): React.JSX.Element {
  const v = periodVariance(days);
  const c = summary === null ? null : consequences(summary, v);
  const net = v.varianceMinutes;

  const hours: Figure[] = [
    {
      key: "expected",
      icon: Clock,
      label: t("attendance.summaryTab.expected"),
      value: fmtDurationHm(v.expectedMinutes),
      hint: t("attendance.summaryTab.expectedHint"),
    },
    {
      key: "worked",
      icon: Clock,
      label: t("attendance.summaryTab.worked"),
      value: fmtDurationHm(v.workedMinutes),
      hint: t("attendance.summaryTab.workedHint"),
    },
    {
      key: "over",
      icon: Plus,
      label: t("attendance.summaryTab.over"),
      value: v.surplusMinutes === 0 ? "—" : fmtDurationHm(v.surplusMinutes),
      hint: t("attendance.summaryTab.overHint", { days: String(v.surplusDays) }),
      tone: v.surplusMinutes > 0 ? "text-success" : undefined,
    },
    {
      key: "under",
      icon: Minus,
      label: t("attendance.summaryTab.under"),
      value: v.shortfallMinutes === 0 ? "—" : fmtDurationHm(v.shortfallMinutes),
      hint: t("attendance.summaryTab.underHint", { days: String(v.shortfallDays) }),
      tone: v.shortfallMinutes > 0 ? "text-destructive" : undefined,
    },
  ];

  const outcomes: Figure[] =
    c === null
      ? []
      : [
        {
          key: "compoff",
          icon: CalendarCheck,
          label: t("attendance.summaryTab.compOff"),
          value: c.compOffDays === 0 ? "—" : t("attendance.summaryTab.days", { n: String(c.compOffDays) }),
          // Says where it came from, because the alternative reading is "derived from my hours".
          hint: t("attendance.summaryTab.compOffHint"),
          tone: c.compOffDays > 0 ? "text-success" : undefined,
        },
        {
          key: "overtime",
          icon: TrendingUp,
          label: t("attendance.summaryTab.overtime"),
          value: c.overtimeMinutes === 0 ? "—" : fmtDurationHm(c.overtimeMinutes),
          hint: t("attendance.summaryTab.overtimeHint", {
            approved: fmtDurationHm(c.approvedOvertimeMinutes),
          }),
        },
        {
          key: "unrecognised",
          icon: AlertTriangle,
          label: t("attendance.summaryTab.unrecognised"),
          value: c.unrecognisedSurplusMinutes === 0 ? "—" : fmtDurationHm(c.unrecognisedSurplusMinutes),
          // The one derived figure on this screen, named as a gap and not as an entitlement.
          hint: t("attendance.summaryTab.unrecognisedHint"),
          tone: c.unrecognisedSurplusMinutes > 0 ? "text-warning" : undefined,
        },
        {
          key: "deduction",
          icon: AlertTriangle,
          label: t("attendance.summaryTab.deduction"),
          value:
            c.lateDeductionLeaveDays === 0
              ? "—"
              : t("attendance.summaryTab.days", { n: String(c.lateDeductionLeaveDays) }),
          hint: t("attendance.summaryTab.deductionHint", {
            lateDays: String(summary?.late_days ?? 0),
            lateTime: fmtDurationHm(summary?.late_minutes ?? 0),
          }),
          tone: c.lateDeductionLeaveDays > 0 ? "text-destructive" : undefined,
        },
      ];

  return (
    <div className="space-y-4">
      {/*
        The caveat leads when it dominates. Every figure below is computed over PROCESSED days,
        and on a month that is mostly unprocessed that fact matters more than any of them.
      */}
      {v.unresolvedDays > 0 ? (
        <div className="rounded-xl border border-warning/40 bg-warning/5 p-3">
          <p className="text-sm text-warning">
            {t("attendance.summaryTab.unresolved", {
              count: String(v.unresolvedDays),
              counted: String(v.countedDays),
            })}
          </p>
        </div>
      ) : null}

      {/* The headline: where the month landed, in one signed number. */}
      <section className="rounded-xl border bg-card p-5" aria-label={t("attendance.summaryTab.netAria")}>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {t("attendance.summaryTab.netLabel", { month: monthLabel })}
        </p>
        <p
          className={cn(
            "mt-1 font-mono text-4xl font-semibold tabular-nums",
            net > 0 ? "text-success" : net < 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {fmtSignedMinutes(net)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {net === 0
            ? t("attendance.summaryTab.netLevel")
            : net > 0
              ? t("attendance.summaryTab.netAhead")
              : t("attendance.summaryTab.netBehind")}
        </p>
      </section>

      <FigureGrid title={t("attendance.summaryTab.hoursTitle")} figures={hours} />

      {outcomes.length > 0 ? (
        <FigureGrid
          title={t("attendance.summaryTab.outcomesTitle")}
          subtitle={t("attendance.summaryTab.outcomesSubtitle")}
          figures={outcomes}
        />
      ) : null}
    </div>
  );
}

function FigureGrid({
  title,
  subtitle,
  figures,
}: {
  title: string;
  subtitle?: string;
  figures: Figure[];
}): React.JSX.Element {
  return (
    <section className="rounded-xl border bg-card p-4">
      <h3 className="font-display text-sm font-semibold">{title}</h3>
      {subtitle !== undefined ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
      <dl className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        {figures.map((f) => (
          <div key={f.key}>
            <dt className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <f.icon className="size-3.5 shrink-0" aria-hidden />
              {f.label}
            </dt>
            <dd className={cn("mt-0.5 font-mono text-lg font-semibold tabular-nums", f.tone)}>
              {f.value}
            </dd>
            {/* The hint is not a tooltip: on a screen about money and leave, the provenance of a
                number should not be hidden behind a hover a phone cannot perform. */}
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{f.hint}</p>
          </div>
        ))}
      </dl>
    </section>
  );
}
