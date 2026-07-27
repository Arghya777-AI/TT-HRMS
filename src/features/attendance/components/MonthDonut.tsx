/**
 * MonthDonut — the composition-of-the-month ring (spec-employee §3.7).
 *
 * Every slice value is a NAMED COLUMN of `f_attendance_period_summary`; the
 * component adds nothing up. Percentages are largest-remainder to one decimal so
 * the legend sums to exactly 100.0 (`DonutChart`), and the centre is ELAPSED
 * days, not total — a live month must not read as 40% absent because the future
 * has not happened yet (DR-30).
 *
 * The eighth entry, "Not processed yet", is the `pending_days` column drawn with
 * a hatch instead of a hue: the engine has not classified those days, and the
 * one thing we must never do is fold them into Absents (the view's own comment
 * says so). It reads as different-in-kind, and it survives CVD and print.
 *
 * Colours are the app's semantic tokens, so a slice and its status chip agree.
 */
import { DonutChart, type DonutSlice } from "@/shared/ui/DonutChart";
import { daysInIstMonth, istMonthElapsedDays } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import type { AttendancePeriodSummary } from "../api/attendance.api";
import type { SliceKey } from "../register";

export interface MonthDonutProps {
  month: string;
  summary: AttendancePeriodSummary;
  activeKey: SliceKey | null;
  onSelect: (key: SliceKey | null) => void;
}

interface SliceSpec {
  readonly key: SliceKey;
  readonly labelKey: Parameters<typeof t>[0];
  readonly color: string;
  readonly texture?: true;
}

/** Ring order. Adjacent slices are kept apart in hue as well as in label. */
const SLICE_SPECS: readonly SliceSpec[] = [
  { key: "attended", labelKey: "attendance.slice.attended", color: "hsl(var(--success))" },
  { key: "half", labelKey: "attendance.slice.half", color: "hsl(var(--warning))" },
  { key: "weeklyOff", labelKey: "attendance.slice.weeklyOff", color: "hsl(var(--chart-3))" },
  { key: "holiday", labelKey: "attendance.slice.holiday", color: "hsl(var(--chart-6))" },
  { key: "leave", labelKey: "attendance.slice.leave", color: "hsl(var(--chart-4))" },
  { key: "compOff", labelKey: "attendance.slice.compOff", color: "hsl(var(--chart-8))" },
  { key: "absent", labelKey: "attendance.slice.absent", color: "hsl(var(--destructive))" },
  { key: "pending", labelKey: "attendance.slice.pending", color: "hsl(var(--muted))", texture: true },
];

/** Narrow a legend key back to a slice identity without an `as` cast. */
function toSliceKey(key: string): SliceKey | null {
  return SLICE_SPECS.find((spec) => spec.key === key)?.key ?? null;
}

function sliceValue(key: SliceKey, s: AttendancePeriodSummary): number {
  switch (key) {
    case "attended":
      return s.present_days;
    case "half":
      return s.half_days;
    case "weeklyOff":
      return s.weekly_off_days;
    case "holiday":
      return s.holiday_days;
    case "leave":
      return s.leave_days;
    case "compOff":
      return s.comp_off_days;
    case "absent":
      return s.absent_days;
    case "pending":
      return s.pending_days;
  }
}

export function MonthDonut({ month, summary, activeKey, onSelect }: MonthDonutProps) {
  const slices: DonutSlice[] = SLICE_SPECS.map((spec) => ({
    key: spec.key,
    label: t(spec.labelKey),
    value: sliceValue(spec.key, summary),
    color: spec.color,
    ...(spec.texture ? { texture: true } : {}),
  }));

  return (
    <DonutChart
      slices={slices}
      centreValue={String(istMonthElapsedDays(month))}
      centreCaption={t("attendance.donut.caption", { total: daysInIstMonth(month) })}
      title={t("attendance.donut.title")}
      heading
      valueHeader={t("attendance.donut.valueHeader")}
      activeKey={activeKey}
      onSelect={(key) => onSelect(key === null ? null : toSliceKey(key))}
      footer={<p className="text-xs text-muted-foreground">{t("attendance.donut.note")}</p>}
    />
  );
}
