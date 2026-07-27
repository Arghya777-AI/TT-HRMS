/**
 * DayDiffLines — renders ONE employee-day's before/after, field by field, from
 * the fingerprint pair `attendance-recompute` returns.
 *
 * Three rules it holds so that the Recompute Console and Bulk Actions cannot
 * disagree about the same diff:
 *
 *  1. ONLY THE FIELDS THE SERVER SAID CHANGED. `changedFields` is the server's
 *     own comparison, computed inside the transaction that produced `after`.
 *     Re-comparing the two fingerprints in the browser would be a second
 *     implementation of the diff, and the two would drift.
 *  2. EVERY VALUE IS FORMATTED, NEVER DERIVED. Minutes go through
 *     `fmtDurationHm`, instants through `fmtTime`, day fractions through
 *     `formatDays`, statuses through a label map. Choosing a formatter is not
 *     arithmetic; nothing here adds, subtracts or predicts a figure.
 *  3. AN UNREADABLE SIDE IS AN EM DASH. A created day has no `before` and a
 *     removed day has no `after`; both say so in words rather than showing 0,
 *     which on this screen would read as "the engine zeroed the day".
 */
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { fmtTime, fmtDurationHm } from "@/lib/datetime";
import { dash, formatDays, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { DayDiff, DayFingerprint } from "../hooks/useAttendanceControls";

/**
 * Field name → human label. Keyed by the edge function's camelCase field names
 * (its `FINGERPRINT_FIELDS`), plus the two sentinels it uses when a whole day
 * row appears or disappears.
 */
const FIELD_LABEL: Readonly<Record<string, string>> = {
  status: t("admin.diff.field.status"),
  statusSource: t("admin.diff.field.statusSource"),
  dayFractionPaid: t("admin.diff.field.dayFractionPaid"),
  punchCount: t("admin.diff.field.punchCount"),
  grossSpanMinutes: t("admin.diff.field.grossSpanMinutes"),
  breakMinutes: t("admin.diff.field.breakMinutes"),
  totalWorkedMinutes: t("admin.diff.field.totalWorkedMinutes"),
  payableWorkedMinutes: t("admin.diff.field.payableWorkedMinutes"),
  isLate: t("admin.diff.field.isLate"),
  lateMinutes: t("admin.diff.field.lateMinutes"),
  earlyExitMinutes: t("admin.diff.field.earlyExitMinutes"),
  overtimeMinutes: t("admin.diff.field.overtimeMinutes"),
  extraWorkMinutes: t("admin.diff.field.extraWorkMinutes"),
  leaveDayFraction: t("admin.diff.field.leaveDayFraction"),
  firstInAt: t("admin.diff.field.firstInAt"),
  lastOutAt: t("admin.diff.field.lastOutAt"),
  anomalyFlags: t("admin.diff.field.anomalyFlags"),
  created: t("admin.diff.field.created"),
  removed: t("admin.diff.field.removed"),
};

/** The deployed `public.attendance_status` enum, in words (DR-53). */
const STATUS_LABEL: Readonly<Record<string, string>> = {
  present: t("admin.dayStatus.present"),
  half_day: t("admin.dayStatus.halfDay"),
  absent: t("admin.dayStatus.absent"),
  weekly_off: t("admin.dayStatus.weeklyOff"),
  holiday: t("admin.dayStatus.holiday"),
  on_leave: t("admin.dayStatus.onLeave"),
  on_leave_half: t("admin.dayStatus.onLeaveHalf"),
  weekly_off_worked: t("admin.dayStatus.weeklyOffWorked"),
  holiday_worked: t("admin.dayStatus.holidayWorked"),
  comp_off_availed: t("admin.dayStatus.compOffAvailed"),
  on_duty: t("admin.dayStatus.onDuty"),
  work_from_home: t("admin.dayStatus.workFromHome"),
  suspended: t("admin.dayStatus.suspended"),
  not_yet_joined: t("admin.dayStatus.notYetJoined"),
  post_exit: t("admin.dayStatus.postExit"),
  pending: t("admin.dayStatus.pending"),
};

/** `status_source` is an internal code; name the ones the engine actually sets. */
const SOURCE_LABEL: Readonly<Record<string, string>> = {
  engine: t("admin.diff.source.engine"),
  batch: t("admin.diff.source.batch"),
  admin_override: t("admin.diff.source.adminOverride"),
  import: t("admin.diff.source.import"),
  leave: t("admin.diff.source.leave"),
  holiday: t("admin.diff.source.holiday"),
  weekly_off: t("admin.diff.source.weeklyOff"),
  regularization: t("admin.diff.source.regularization"),
};

export function dayStatusLabel(status: string | null): string {
  if (status === null || status === "") return t("common.empty");
  return STATUS_LABEL[status] ?? status;
}

/** Format one fingerprint field for display. Presentation only. */
function formatField(field: string, fingerprint: DayFingerprint | null): string {
  if (fingerprint === null) return t("common.empty");
  switch (field) {
    case "status":
      return dayStatusLabel(fingerprint.status);
    case "statusSource":
      return fingerprint.statusSource === null
        ? t("common.empty")
        : SOURCE_LABEL[fingerprint.statusSource] ?? fingerprint.statusSource;
    case "dayFractionPaid":
      return formatDays(fingerprint.dayFractionPaid);
    case "leaveDayFraction":
      return formatDays(fingerprint.leaveDayFraction);
    case "punchCount":
      return formatNumber(fingerprint.punchCount);
    case "grossSpanMinutes":
      return fmtDurationHm(fingerprint.grossSpanMinutes);
    case "breakMinutes":
      return fmtDurationHm(fingerprint.breakMinutes);
    case "totalWorkedMinutes":
      return fmtDurationHm(fingerprint.totalWorkedMinutes);
    case "payableWorkedMinutes":
      return fmtDurationHm(fingerprint.payableWorkedMinutes);
    case "lateMinutes":
      return fmtDurationHm(fingerprint.lateMinutes);
    case "earlyExitMinutes":
      return fmtDurationHm(fingerprint.earlyExitMinutes);
    case "overtimeMinutes":
      return fmtDurationHm(fingerprint.overtimeMinutes);
    case "extraWorkMinutes":
      return fmtDurationHm(fingerprint.extraWorkMinutes);
    case "isLate":
      return fingerprint.isLate === null
        ? t("common.empty")
        : fingerprint.isLate
          ? t("common.yes")
          : t("common.no");
    case "firstInAt":
      return fingerprint.firstInAt === null ? t("common.empty") : fmtTime(fingerprint.firstInAt);
    case "lastOutAt":
      return fingerprint.lastOutAt === null ? t("common.empty") : fmtTime(fingerprint.lastOutAt);
    case "anomalyFlags":
      return fingerprint.anomalyFlags.length === 0
        ? t("admin.diff.noFlags")
        : String(fingerprint.anomalyFlags.length);
    default:
      return t("common.empty");
  }
}

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

/** A one-line summary of a diff, for a narrow grid cell. */
export function diffSummary(diff: DayDiff): string {
  if (diff.changedFields.includes("created")) return t("admin.diff.summary.created");
  if (diff.changedFields.includes("removed")) return t("admin.diff.summary.removed");
  return diff.changedFields.map(fieldLabel).join(", ");
}

function Side({ children, tone }: { children: ReactNode; tone: "before" | "after" }) {
  return (
    <span
      className={
        tone === "before"
          ? "num text-muted-foreground line-through decoration-muted-foreground/50"
          : "num font-medium"
      }
    >
      {children}
    </span>
  );
}

export interface DayDiffLinesProps {
  diff: DayDiff;
}

export function DayDiffLines({ diff }: DayDiffLinesProps) {
  if (diff.changedFields.includes("created")) {
    return (
      <span className="text-sm">
        {t("admin.diff.createdLine", { status: dayStatusLabel(diff.after?.status ?? null) })}
      </span>
    );
  }
  if (diff.changedFields.includes("removed")) {
    return <span className="text-sm">{t("admin.diff.removedLine")}</span>;
  }
  if (diff.changedFields.length === 0) {
    return <span className="text-sm text-muted-foreground">{dash(null)}</span>;
  }

  return (
    <ul className="space-y-0.5 text-sm">
      {diff.changedFields.map((field) => (
        <li key={field} className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-xs text-muted-foreground">{fieldLabel(field)}</span>
          <Side tone="before">{formatField(field, diff.before)}</Side>
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
          <Side tone="after">{formatField(field, diff.after)}</Side>
        </li>
      ))}
    </ul>
  );
}
