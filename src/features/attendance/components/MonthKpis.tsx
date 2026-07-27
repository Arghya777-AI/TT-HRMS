/**
 * MonthKpis — the 14 KPI tiles of E-03 (labels verbatim from spec-employee §3.7).
 *
 * Rules this file exists to keep:
 *  - Every value is ONE named column of `f_attendance_period_summary`. There is
 *    no `+`, no `/`, no `reduce` below — a tile and the payslip read the same
 *    row, so they cannot disagree (DR-29).
 *  - Every tile always renders a value. `0h 00m` is a value; `—` appears only
 *    where the server itself returned NULL because the denominator was zero
 *    (DR-31, the blank-tile defect).
 *  - Every tile carries an `(i)` explainer that states the formula IN WORDS with
 *    the reader's own numbers, and every ratio names its numerator and its
 *    denominator (DR-33).
 *  - Durations are `7h 50m`, never decimal hours (§8).
 *
 * `elapsed`, `remaining` and the month's day count are CALENDAR facts from
 * `lib/datetime` (a July has 31 days whether or not anyone punched in). The
 * deployed summary function does not return them; see the note in the api module.
 */
import type { ReactNode } from "react";
import { KpiTile, type KpiExplainer } from "@/shared/ui/KpiTile";
import type { StatusTone } from "@/shared/ui/StatusChip";
import {
  daysInIstMonth,
  fmtDurationHm,
  fmtMonthLong,
  istMonthElapsedDays,
  istMonthRemainingDays,
} from "@/lib/datetime";
import { formatDays, formatDaysFixed, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AttendancePeriodSummary } from "../api/attendance.api";

export interface MonthKpisProps {
  month: string;
  summary: AttendancePeriodSummary;
}

/**
 * Local wrapper so the 14 call sites stay readable under
 * `exactOptionalPropertyTypes`: an omitted `hint` must be absent, not `undefined`.
 */
function Tile({
  label,
  value,
  explainer,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  explainer: KpiExplainer;
  hint?: string | undefined;
  tone?: StatusTone | undefined;
}) {
  return (
    <KpiTile
      label={label}
      value={value}
      explainer={explainer}
      {...(hint !== undefined ? { hint } : {})}
      {...(tone !== undefined ? { tone } : {})}
    />
  );
}

export function MonthKpis({ month, summary: s }: MonthKpisProps) {
  const monthLabel = fmtMonthLong(month);
  const total = daysInIstMonth(month);
  const elapsed = istMonthElapsedDays(month);
  const remaining = istMonthRemainingDays(month);

  const lateHours = fmtDurationHm(s.late_minutes);
  const earlyHours = fmtDurationHm(s.early_exit_minutes);
  const extraHours = fmtDurationHm(s.extra_work_minutes);
  const otApproved = fmtDurationHm(s.approved_overtime_minutes);
  const otEligible = fmtDurationHm(s.overtime_minutes);
  const avgHours = fmtDurationHm(s.avg_worked_minutes_per_present_day);
  const attendancePct = formatPercent(s.attendance_pct, { digits: 1, clamp: true });

  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
      {/* K1 */}
      <Tile
        label={t("attendance.kpi.attended")}
        value={formatDays(s.present_days)}
        tone={s.present_days > 0 ? "success" : "neutral"}
        {...(s.half_days > 0
          ? { hint: t("attendance.kpi.attended.hint", { half: formatDays(s.half_days) }) }
          : {})}
        explainer={{
          formula: t("attendance.kpi.attended.formula"),
          numbers: t("attendance.kpi.attended.numbers", {
            days: formatDays(s.present_days),
            month: monthLabel,
            half: formatDays(s.half_days),
          }),
        }}
      />

      {/* K4 */}
      <Tile
        label={t("attendance.kpi.leaves")}
        value={formatDays(s.leave_days)}
        hint={t("attendance.kpi.leaves.hint")}
        explainer={{
          formula: t("attendance.kpi.leaves.formula"),
          numbers: t("attendance.kpi.leaves.numbers", {
            days: formatDays(s.leave_days),
            month: monthLabel,
          }),
        }}
      />

      {/* K7 — future dates are never in this count */}
      <Tile
        label={t("attendance.kpi.absents")}
        value={formatDays(s.absent_days)}
        tone={s.absent_days > 0 ? "danger" : "neutral"}
        {...(s.pending_days > 0
          ? { hint: t("attendance.kpi.absents.hint", { pending: formatDays(s.pending_days) }) }
          : {})}
        explainer={{
          formula: t("attendance.kpi.absents.formula"),
          numbers: t("attendance.kpi.absents.numbers", {
            days: formatDays(s.absent_days),
            elapsed,
            month: monthLabel,
          }),
        }}
      />

      {/* K8 — always states its denominator */}
      <Tile
        label={t("attendance.kpi.paidDays")}
        value={t("attendance.kpi.paidDays.value", {
          days: formatDaysFixed(s.paid_days),
          elapsed,
        })}
        explainer={{
          formula: t("attendance.kpi.paidDays.formula"),
          numbers: t("attendance.kpi.paidDays.numbers", {
            days: formatDaysFixed(s.paid_days),
            elapsed,
            month: monthLabel,
          }),
        }}
      />

      {/* K9 */}
      <Tile
        label={t("attendance.kpi.lateHours")}
        value={lateHours}
        tone={s.late_minutes > 0 ? "warn" : "neutral"}
        explainer={{
          formula: t("attendance.kpi.lateHours.formula"),
          numbers: t("attendance.kpi.lateHours.numbers", { value: lateHours, days: s.late_days }),
        }}
      />

      {/* K10 */}
      <Tile
        label={t("attendance.kpi.lateDays")}
        value={formatDays(s.late_days)}
        tone={s.late_days > 0 ? "warn" : "neutral"}
        explainer={{
          formula: t("attendance.kpi.lateDays.formula"),
          numbers: t("attendance.kpi.lateDays.numbers", {
            days: s.late_days,
            working: s.working_days,
            month: monthLabel,
          }),
        }}
      />

      {/* K11 */}
      <Tile
        label={t("attendance.kpi.lateDeduction")}
        value={formatDays(s.late_deduction_leave_days)}
        tone={s.late_deduction_leave_days > 0 ? "danger" : "neutral"}
        explainer={{
          formula: t("attendance.kpi.lateDeduction.formula"),
          numbers: t("attendance.kpi.lateDeduction.numbers", {
            days: formatDays(s.late_deduction_leave_days),
            late: s.late_days,
            month: monthLabel,
          }),
        }}
      />

      {/* K12 */}
      <Tile
        label={t("attendance.kpi.earlyHours")}
        value={earlyHours}
        tone={s.early_exit_minutes > 0 ? "warn" : "neutral"}
        explainer={{
          formula: t("attendance.kpi.earlyHours.formula"),
          numbers: t("attendance.kpi.earlyHours.numbers", {
            value: earlyHours,
            days: s.early_exit_days,
          }),
        }}
      />

      {/* K13 */}
      <Tile
        label={t("attendance.kpi.earlyDays")}
        value={formatDays(s.early_exit_days)}
        tone={s.early_exit_days > 0 ? "warn" : "neutral"}
        explainer={{
          formula: t("attendance.kpi.earlyDays.formula"),
          numbers: t("attendance.kpi.earlyDays.numbers", {
            days: s.early_exit_days,
            working: s.working_days,
            month: monthLabel,
          }),
        }}
      />

      {/* K14 */}
      <Tile
        label={t("attendance.kpi.extraHours")}
        value={extraHours}
        explainer={{
          formula: t("attendance.kpi.extraHours.formula"),
          numbers: t("attendance.kpi.extraHours.numbers", { value: extraHours, month: monthLabel }),
        }}
      />

      {/* K15 — approved only; the eligible total is stated, never subtracted */}
      <Tile
        label={t("attendance.kpi.otApproved")}
        value={otApproved}
        hint={t("attendance.kpi.otApproved.hint", { eligible: otEligible })}
        explainer={{
          formula: t("attendance.kpi.otApproved.formula"),
          numbers: t("attendance.kpi.otApproved.numbers", {
            approved: otApproved,
            eligible: otEligible,
            month: monthLabel,
          }),
        }}
      />

      {/* K16 — NULL denominator stays '—'; never 0h 00m (the Avg:0Hrs defect) */}
      <Tile
        label={t("attendance.kpi.avgHours")}
        value={avgHours}
        explainer={{
          formula: t("attendance.kpi.avgHours.formula"),
          numbers:
            s.avg_worked_minutes_per_present_day === null
              ? t("attendance.kpi.avgHours.empty")
              : t("attendance.kpi.avgHours.numbers", {
                  total: fmtDurationHm(s.total_worked_minutes),
                  month: monthLabel,
                }),
        }}
      />

      {/* K17 — the server's clamped percentage; the client never divides */}
      <Tile
        label={t("attendance.kpi.attendancePct")}
        value={attendancePct}
        explainer={{
          formula: t("attendance.kpi.attendancePct.formula"),
          numbers: t("attendance.kpi.attendancePct.numbers", {
            paid: formatDaysFixed(s.paid_days),
            total,
            month: monthLabel,
            pct: attendancePct,
          }),
        }}
      />

      {/* K18 */}
      <Tile
        label={t("attendance.kpi.daysRemaining")}
        value={String(remaining)}
        explainer={{
          formula: t("attendance.kpi.daysRemaining.formula"),
          numbers: t("attendance.kpi.daysRemaining.numbers", {
            remaining,
            total,
            month: monthLabel,
          }),
        }}
      />
    </div>
  );
}
