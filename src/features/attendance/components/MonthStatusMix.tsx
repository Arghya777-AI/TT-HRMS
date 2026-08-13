/**
 * MonthStatusMix — how the month actually divided, drawn from a real partition.
 *
 * The chart that was declined when the visuals went in, and the reason it was
 * declined is worth keeping: `f_attendance_period_summary`'s day columns OVERLAP
 * (a worked weekly off is counted by both `present_days` and `weekly_off_days`),
 * so stacking them would have drawn a whole larger than the month.
 *
 * Migration 042900 added `f_attendance_status_mix`, which counts
 * `attendance_days.status` — one value per day, a partition by construction. So
 * this bar's segments genuinely sum to the days it says they do.
 *
 * It sits BESIDE `MonthGlance`, not instead of it: that panel answers "how many
 * days had this property", which is a different and equally real question.
 */
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { useEmployeeId } from "@/shared/api/employee-scope";
import { SplitBar } from "@/shared/ui/charts/SplitBar";
import type { ChartTone } from "@/shared/ui/charts/chartTokens";
import { t } from "@/shared/i18n/en";
import { formatNumber } from "@/lib/format";
import { fetchStatusMix } from "../api/status-mix.api";
import { statusLabel, statusTone } from "../display";

/**
 * The screen's own status tone, translated into the chart vocabulary.
 *
 * Deliberately routed through `statusTone` rather than a second mapping: the bar
 * has to agree with the day badges in the table below it, and the only way to
 * guarantee that is to ask the same function they ask.
 */
const TONE_FOR: Readonly<Record<string, ChartTone>> = {
  success: "present",
  warn: "late",
  info: "leave",
  danger: "absent",
  neutral: "weeklyOff",
};

export interface MonthStatusMixProps {
  readonly from: string;
  readonly to: string;
}

export function MonthStatusMix({ from, to }: MonthStatusMixProps) {
  const employeeId = useEmployeeId();
  const mix = useQuery({
    queryKey: qk.attendance.list({ entity: "status-mix", employeeId: employeeId ?? "none", from, to }),
    queryFn: ({ signal }) => fetchStatusMix(employeeId ?? "", from, to, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });

  const rows = mix.data ?? [];
  /*
    Nothing recorded yet is not a month of zeroes — a future month, or one the
    engine has not rolled up, has no shape to draw and says nothing rather than
    drawing an empty bar that reads as "no days worked".
  */
  if (rows.length === 0) return null;

  const total = rows.reduce((sum, row) => sum + row.days, 0);

  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="font-display text-base font-semibold">{t("attendance.mix.title")}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {t("attendance.mix.hint", { n: formatNumber(total) })}
      </p>
      <div className="mt-3">
        <SplitBar
          title={t("attendance.mix.title")}
          height={14}
          format={(v) => t("attendance.mix.days", { n: formatNumber(v) })}
          segments={rows.map((row) => ({
            key: row.status,
            label: statusLabel(row.status),
            value: row.days,
            tone: TONE_FOR[statusTone(row.status)] ?? "neutral",
          }))}
        />
      </div>
    </section>
  );
}
