/**
 * display.ts — the attendance display vocabulary.
 *
 * The ONE place a server enum becomes words. No component may render
 * `row.status`, `punch.source` or `shift_code` directly: `None1`, `SinglePunch`,
 * `PP001` and `G --- 09:30 AM - 06:30 PM` are the reference product's DR-53, and
 * this module is how they stay unrepresentable here.
 *
 * Nothing in this file computes a number. It maps codes to labels and labels to
 * tones, and it decides which of the strings a row already carries to show.
 */
import type { StatusChipEntry, StatusTone } from "@/shared/ui/StatusChip";
import type { AttendanceDay, AttendancePunch } from "./api/attendance.api";
import { fmtCivilTime, fmtDurationHm, fmtTime, isFutureIstDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";

/**
 * Synthetic status for a date that has not happened yet. Future dates are
 * `not_yet` and never `absent` — the phantom-absent defect (DR-30) is a status
 * decision, so it lives here rather than in a chart or a denominator.
 */
export const NOT_YET = "not_yet" as const;
/** Synthetic status for a past date the engine has not written a row for. */
export const AWAITING_ROLLUP = "awaiting_rollup" as const;

const STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  present: "success",
  weekly_off_worked: "success",
  holiday_worked: "success",
  on_duty: "success",
  work_from_home: "success",
  half_day: "warn",
  on_leave_half: "warn",
  pending: "warn",
  [AWAITING_ROLLUP]: "warn",
  on_leave: "info",
  comp_off_availed: "info",
  weekly_off: "neutral",
  holiday: "neutral",
  not_yet_joined: "neutral",
  post_exit: "neutral",
  [NOT_YET]: "neutral",
  absent: "danger",
  suspended: "danger",
};

const STATUS_LABEL_KEYS = {
  present: "attendance.status.present",
  half_day: "attendance.status.halfDay",
  absent: "attendance.status.absent",
  weekly_off: "attendance.status.weeklyOff",
  holiday: "attendance.status.holiday",
  on_leave: "attendance.status.onLeave",
  on_leave_half: "attendance.status.onLeaveHalf",
  weekly_off_worked: "attendance.status.weeklyOffWorked",
  holiday_worked: "attendance.status.holidayWorked",
  comp_off_availed: "attendance.status.compOff",
  on_duty: "attendance.status.onDuty",
  work_from_home: "attendance.status.wfh",
  suspended: "attendance.status.suspended",
  not_yet_joined: "attendance.status.notYetJoined",
  post_exit: "attendance.status.postExit",
  pending: "attendance.status.pending",
  [NOT_YET]: "attendance.status.notYet",
  [AWAITING_ROLLUP]: "attendance.status.awaitingRollup",
} as const;

type StatusKey = keyof typeof STATUS_LABEL_KEYS;

function isStatusKey(value: string): value is StatusKey {
  return Object.prototype.hasOwnProperty.call(STATUS_LABEL_KEYS, value);
}

/** Base label for a day status, before a leave type is appended. */
export function statusLabel(status: string): string {
  return isStatusKey(status) ? t(STATUS_LABEL_KEYS[status]) : status;
}

export function statusTone(status: string): StatusTone {
  return STATUS_TONES[status] ?? "neutral";
}

/**
 * What a day row's status READS AS, leave type included.
 *
 * On a leave day it must say WHICH leave — `On leave · Casual Leave`, from
 * `leave_type_name`. It never shows `leave_type_code` and never the raw
 * `on_leave` enum (spec-employee §5 E-03).
 *
 * The chip below and the chart tooltip beside it both call this, so a day
 * cannot be described one way in the register and another in the picture of it.
 */
export function dayStatusText(
  status: string,
  leaveTypeName: string | null,
  workedMinutes?: number | null,
): string {
  const onLeave = status === "on_leave" || status === "on_leave_half";
  const base = statusLabel(status);
  const withLeave =
    onLeave && leaveTypeName !== null && leaveTypeName.length > 0
      ? `${base} · ${leaveTypeName}`
      : base;

  /*
    ── LEAVE AND WORKED ARE NOT MUTUALLY EXCLUSIVE ───────────────────────────
    An employee on approved leave who came in for an evening meeting has both facts on his
    day, and the engine records both: `status = on_leave` and 79 worked minutes, with a
    `worked_on_leave` anomaly flag.

    The row said only "On leave", so the work he actually did was invisible on his own
    attendance page. Reported as exactly that: "even if he's on leave, he still worked."
    Showing one and hiding the other is not a summary, it is an omission — and it is the half
    that costs somebody, because unseen work is unpaid work.

    Only on a LEAVE day. Everywhere else the worked figure has its own column and repeating it
    in the status chip would be noise.
  */
  const worked = typeof workedMinutes === "number" && Number.isFinite(workedMinutes) ? workedMinutes : 0;
  return onLeave && worked > 0
    ? `${withLeave} · ${t("attendance.status.alsoWorked", { hm: fmtDurationHm(worked) })}`
    : withLeave;
}

/** A one-entry `StatusChip` vocabulary for a day row. */
export function dayStatusChip(
  status: string,
  leaveTypeName: string | null,
  workedMinutes?: number | null,
): Record<string, StatusChipEntry> {
  return {
    [status]: {
      label: dayStatusText(status, leaveTypeName, workedMinutes),
      tone: statusTone(status),
    },
  };
}

/**
 * The status a row should DISPLAY, which is not always the status stored.
 *
 * A date after today is `not_yet` whatever the engine last wrote, and a past
 * date with no row at all is "awaiting the nightly rollup" — never absent. Both
 * are display decisions over one row; no count is touched.
 */
export function displayStatus(row: AttendanceDay | null, istDate: string): string {
  if (isFutureIstDate(istDate)) return NOT_YET;
  if (row === null) return AWAITING_ROLLUP;
  return row.status;
}

// -----------------------------------------------------------------------------
// Punch method — Face / Fingerprint / Web / Corrected
// -----------------------------------------------------------------------------

const METHOD_LABEL_KEYS = {
  kiosk_face: "attendance.method.face",
  kiosk_fingerprint: "attendance.method.fingerprint",
  kiosk_card: "attendance.method.card",
  kiosk_manual: "attendance.method.operator",
  web: "attendance.method.web",
  mobile: "attendance.method.mobile",
  biometric_device: "attendance.method.device",
  manual_admin: "attendance.method.corrected",
  import: "attendance.method.imported",
  system_regularization: "attendance.method.corrected",
} as const;

/**
 * How a scan was captured, in one word.
 *
 * `v_attendance_punch_detail` also carries `match_confidence` and
 * `confidence_badge`. An employee is NEVER shown either (spec-employee §5 A12):
 * a face-match score is a number they cannot act on and cannot contest, and
 * publishing it turns a biometric threshold into a performance metric.
 */
export function punchMethodLabel(punch: AttendancePunch): string {
  const key = METHOD_LABEL_KEYS[punch.source];
  return key ? t(key) : t("attendance.method.other");
}

/** Check-in / Check-out / Scan, from the view's derived direction. */
export function punchRoleLabel(direction: AttendancePunch["derived_direction"]): string {
  if (direction === "IN") return t("attendance.punch.checkIn");
  if (direction === "OUT") return t("attendance.punch.checkOut");
  return t("attendance.punch.scan");
}

// -----------------------------------------------------------------------------
// Shift window
// -----------------------------------------------------------------------------

export interface ShiftRef {
  readonly id: string;
  readonly name: string;
  readonly start_time: string;
  readonly end_time: string;
  readonly crosses_midnight: boolean;
}

/**
 * `General · 09:30–18:30` — the shift NAME plus its window, never a bare code.
 *
 * The day view exposes `shift_code` and `shift_display_label`, but the latter is
 * built by the DB as `G — 09:30 AM to 06:30 PM`: bare code plus a 12-hour clock,
 * both banned (§3.3, §8, DR-53). So the name comes from the `shifts` reference
 * read and the window from the row's own date-specific timestamps, falling back
 * to the shift master's wall-clock times when the engine has not stamped them.
 */
export function shiftDisplay(
  row: Pick<AttendanceDay, "shift_id" | "shift_start_at" | "shift_end_at">,
  shifts: ReadonlyMap<string, ShiftRef>,
): { name: string; window: string } | null {
  if (row.shift_id === null) return null;
  const ref = shifts.get(row.shift_id) ?? null;
  const start =
    row.shift_start_at !== null ? fmtTime(row.shift_start_at) : fmtCivilTime(ref?.start_time);
  const end = row.shift_end_at !== null ? fmtTime(row.shift_end_at) : fmtCivilTime(ref?.end_time);
  const window = start === "—" || end === "—" ? "—" : `${start}–${end}`;
  return { name: ref?.name ?? t("attendance.shift.unnamed"), window };
}
