/**
 * MonthGlance — the shape of the month, immediately above the register that
 * states it precisely.
 *
 * Two pictures, no arithmetic:
 *
 *  1. A SplitBar of the month's composition. Each band is ONE named column of
 *     `f_attendance_period_summary` — the same row the donut, the KPI tiles and
 *     the payslip read. Nothing here adds, divides or re-derives; the legend
 *     prints the server's own counts, and the only thing the component works out
 *     is how wide to draw a rectangle.
 *
 *  2. A TrendBars over the days. Bar height is `total_worked_minutes` — the very
 *     column the "Worked" cell of the register below prints, through the very
 *     same formatter — so the picture and the table cannot disagree. Colour is
 *     the day's status, which is what its chip in that table says.
 *
 * ── WHY A GAP IS NOT A ZERO ────────────────────────────────────────────────
 *
 * A date after today, and a past date the nightly run has not written yet, carry
 * `null` — a gap. Drawing them as a bar of height nothing would say "you worked
 * no hours" about a Tuesday that has not happened, which is the phantom-absent
 * defect (DR-30) redrawn as a picture. A real zero — a Sunday you did not work —
 * IS a zero, and its tooltip says `0h 00m` where a gap says `—`.
 *
 * ── WHY THIS SITS HERE AND NOT ON THE DONUT CARD ───────────────────────────
 *
 * `CHART_TONE` is the app's semantic palette: attended is success, leave is
 * info, absent is destructive, a weekly off is muted — the same tones
 * `dayStatusChip` gives the chips in the register directly below. Putting these
 * two beside those chips means one colour vocabulary is in force wherever the
 * reader's eye is. The donut above keeps its own eight-hue legend, which names
 * each hue in words precisely because it needs more slices than there are
 * meanings.
 */
import { SplitBar, type SplitSegment } from "@/shared/ui/charts/SplitBar";
import { TrendBars, type TrendBar } from "@/shared/ui/charts/TrendBars";
import type { ChartTone } from "@/shared/ui/charts/chartTokens";
import { fmtCivilDayMonthWeekday, fmtDurationHm } from "@/lib/datetime";
import { formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AttendancePeriodSummary } from "../api/attendance.api";
import { AWAITING_ROLLUP, dayStatusText, NOT_YET } from "../display";
import type { RegisterRow } from "../register";

export interface MonthGlanceProps {
  /** One row per date of the month — the register's own rows, unfiltered. */
  readonly rows: readonly RegisterRow[];
  /** The period summary row, or null when the engine has written none. */
  readonly summary: AttendancePeriodSummary | null;
}

/**
 * Status → chart tone, matching `STATUS_TONES` in display.ts entry for entry so
 * a bar is the colour of its own chip.
 *
 * `late` is the warning tone under a different name — it is what the half day,
 * the half-day leave and the not-yet-classified day already wear in the
 * register. Holiday is the one deliberate divergence: the chip greys it in with
 * weekly offs, and the kit gives it a hue of its own so a month's holidays do
 * not disappear into its Sundays.
 */
const TONE_BY_STATUS: Readonly<Record<string, ChartTone>> = {
  present: "present",
  weekly_off_worked: "present",
  holiday_worked: "present",
  on_duty: "present",
  work_from_home: "present",
  half_day: "late",
  on_leave_half: "late",
  pending: "late",
  [AWAITING_ROLLUP]: "late",
  on_leave: "leave",
  comp_off_availed: "leave",
  weekly_off: "weeklyOff",
  holiday: "holiday",
  absent: "absent",
  suspended: "absent",
  not_yet_joined: "neutral",
  post_exit: "neutral",
  [NOT_YET]: "neutral",
};

function toneFor(status: string): ChartTone {
  return TONE_BY_STATUS[status] ?? "neutral";
}

/**
 * The height of one day's bar, straight off the view row.
 *
 * A future date is null whatever the engine last wrote (DR-30), and a date with
 * no row at all is null rather than nothing-worked. Everything else is the
 * server's `total_worked_minutes`, which is itself nullable — a day the engine
 * has not timed is a gap too.
 */
function workedMinutes(row: RegisterRow): number | null {
  if (row.status === NOT_YET) return null;
  if (row.day === null) return null;
  return row.day.total_worked_minutes;
}

/**
 * '01'…'31' for the axis. String work on a civil date the server sent, not date
 * arithmetic — `fmtCivilDayMonthWeekday` is still what names the day in words.
 */
function dayTick(istDate: string): string {
  return istDate.slice(8);
}

export function MonthGlance({ rows, summary }: MonthGlanceProps) {
  const bars: TrendBar[] = rows.map((row) => ({
    key: row.istDate,
    label: dayTick(row.istDate),
    value: workedMinutes(row),
    tone: toneFor(row.status),
    caption: t("attendance.glance.trend.caption", {
      date: fmtCivilDayMonthWeekday(row.istDate),
      status: dayStatusText(
        row.status,
        row.day?.leave_type_name ?? null,
        row.day?.total_worked_minutes ?? null,
      ),
    }),
  }));

  // A month the engine has not touched has 31 gaps and nothing to look at. An
  // axis of empty days is not a chart; it is a chart-shaped claim to have data.
  const hasBars = bars.some((bar) => bar.value !== null);
  if (!hasBars && summary === null) return null;

  const segments: SplitSegment[] =
    summary === null
      ? []
      : [
          {
            key: "attended",
            label: t("attendance.slice.attended"),
            value: summary.present_days,
            tone: "present",
          },
          {
            key: "leave",
            label: t("attendance.slice.leave"),
            value: summary.leave_days,
            tone: "leave",
          },
          {
            key: "absent",
            label: t("attendance.slice.absent"),
            value: summary.absent_days,
            tone: "absent",
          },
          {
            key: "weeklyOff",
            label: t("attendance.slice.weeklyOff"),
            value: summary.weekly_off_days,
            tone: "weeklyOff",
          },
          {
            key: "holiday",
            label: t("attendance.slice.holiday"),
            value: summary.holiday_days,
            tone: "holiday",
          },
        ];

  return (
    <section className="mb-6 rounded-lg border bg-card p-4">
      {segments.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">
            {t("attendance.glance.split.title")}
          </h3>
          <SplitBar
            className="mt-2.5"
            segments={segments}
            title={t("attendance.glance.split.title")}
            format={formatDays}
            height={12}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {t("attendance.glance.split.note")}
          </p>
        </div>
      ) : null}

      {hasBars ? (
        <div className={segments.length > 0 ? "mt-5 border-t pt-4" : undefined}>
          <h3 className="text-sm font-medium text-muted-foreground">
            {t("attendance.glance.trend.title")}
          </h3>
          <TrendBars
            className="mt-2"
            bars={bars}
            title={t("attendance.glance.trend.title")}
            format={fmtDurationHm}
            height={140}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t("attendance.glance.trend.note")}
          </p>
        </div>
      ) : null}
    </section>
  );
}
