/**
 * varianceCoverage.ts — the one sentence that says which days a total is made of.
 *
 * ── WHY IT IS SHARED ─────────────────────────────────────────────────────────
 * Three screens print this line: the admin person-attendance panel, the employee's month
 * summary, and the month totals strip. All three said some version of
 *
 *     Over 6 computed days · 2 not processed yet
 *
 * and all three were wrong in the same way. Of those "2 not processed yet", none had failed to
 * process: one was TODAY, still being measured, and two were future dates that a materialised
 * approved leave had created. Nine days in view, six counted, and a remainder described as a
 * fault when it was nothing of the kind.
 *
 * So the remainder is now itemised, and the wording of it lives here rather than in three
 * places that would drift: "1 getting processed (today)" is not the same statement as
 * "2 still to come", and neither is "not processed yet".
 *
 * Only non-zero parts appear. A month with nothing outstanding reads "Over 21 computed days"
 * and stops, which is the whole sentence it needs.
 */
import { t } from "@/shared/i18n/en";
import { formatNumber } from "@/lib/format";
import type { PeriodVariance } from "./variance";

/** The parts, in reading order — most immediate first. */
export function varianceCoverageParts(v: PeriodVariance): string[] {
  const parts = [t("attendance.variance.cover.counted", { n: formatNumber(v.countedDays) })];
  /* Today leads the remainder: it is the one somebody is looking at when they ask. */
  if (v.openDays > 0) {
    parts.push(t("attendance.variance.cover.processing", { n: formatNumber(v.openDays) }));
  }
  if (v.futureDays > 0) {
    parts.push(t("attendance.variance.cover.future", { n: formatNumber(v.futureDays) }));
  }
  /* Last, and only when it is real — this is the only one of the three that IS a fault. */
  if (v.unresolvedDays > 0) {
    parts.push(t("attendance.variance.cover.stalled", { n: formatNumber(v.unresolvedDays) }));
  }
  return parts;
}

export function varianceCoverageText(v: PeriodVariance): string {
  return varianceCoverageParts(v).join(" · ");
}
