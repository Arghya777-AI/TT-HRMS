/**
 * leave-vocab.ts — the leave/comp-off display vocabulary in one place.
 *
 * Nothing here computes a business number. `fmtDays` formats a value the server
 * already produced; the expiry helper turns a server `expires_on` DATE into a
 * colour band, which is calendar proximity, not a leave calculation. Every label
 * comes from the string catalogue, so no internal enum reaches the screen
 * (DR-53).
 */
import { civilDayOffset, nowIstDate } from "@/lib/datetime";
import { EM_DASH, formatNumber } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import type { StatusChipEntry, StatusTone } from "@/shared/ui/StatusChip";
import type { LeaveDayPortion, LeaveSkipReason } from "../api/leave-apply.api";

/**
 * Leave/comp-off days as the DB stores them: `numeric(8,3)`. '18.000' arrives as
 * 18 and renders '18'; '1.500' renders '1.5'. No rounding, no unit invention —
 * `0` is a value and only null is an em dash.
 */
export function fmtDays(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH;
  return formatNumber(value);
}

/** '{n} days' with the count formatted — used in headlines and popovers. */
export function daysPhrase(value: number | null | undefined): string {
  return t("leave.balance.days", { days: fmtDays(value) });
}

/** `leave_requests.status` → chip. Never the raw enum (DR-53). */
export const LEAVE_STATUS_MAP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("leave.status.draft"), tone: "neutral" },
  pending: { label: t("leave.status.pending"), tone: "warn" },
  approved: { label: t("leave.status.approved"), tone: "success" },
  partially_approved: { label: t("leave.status.partially_approved"), tone: "info" },
  rejected: { label: t("leave.status.rejected"), tone: "danger" },
  cancelled: { label: t("leave.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("leave.status.withdrawn"), tone: "neutral" },
  cancellation_pending: { label: t("leave.status.cancellation_pending"), tone: "warn" },
};

/** `comp_off_ledger.status` → chip. */
export const COMP_OFF_STATUS_MAP: Readonly<Record<string, StatusChipEntry>> = {
  pending_approval: { label: t("compOff.status.pending_approval"), tone: "warn" },
  available: { label: t("compOff.status.available"), tone: "success" },
  partially_used: { label: t("compOff.status.partially_used"), tone: "info" },
  used: { label: t("compOff.status.used"), tone: "neutral" },
  expired: { label: t("compOff.status.expired"), tone: "danger" },
  cancelled: { label: t("compOff.status.cancelled"), tone: "neutral" },
};

const PORTION_KEY: Readonly<Record<LeaveDayPortion, MessageKey>> = {
  full_day: "leave.alloc.portion.full_day",
  first_half: "leave.alloc.portion.first_half",
  second_half: "leave.alloc.portion.second_half",
};

export function portionLabel(portion: LeaveDayPortion): string {
  return t(PORTION_KEY[portion]);
}

const SKIP_KEY: Readonly<Record<LeaveSkipReason, MessageKey>> = {
  weekly_off: "leave.alloc.skipped.weekly_off",
  holiday: "leave.alloc.skipped.holiday",
  already_leave: "leave.alloc.skipped.already_leave",
};

/** The `reason_skipped` sentence, or "counted as leave" when it deducts. */
export function skipLabel(reason: LeaveSkipReason | null): string {
  return reason === null ? t("leave.alloc.counted") : t(SKIP_KEY[reason]);
}

const EARN_SOURCE_KEY: Readonly<Record<string, MessageKey>> = {
  weekly_off_worked: "compOff.why.weekly_off_worked",
  holiday_worked: "compOff.why.holiday_worked",
  event_overtime: "compOff.why.event_overtime",
  manual_grant: "compOff.why.manual_grant",
};

/**
 * Why a comp-off credit exists. `earn_source` is stamped by the rollup from the
 * source attendance day's own status, so this reads the server's answer instead
 * of re-deriving it from the day.
 */
export function earnSourceLabel(source: string | null): string {
  if (source === null) return t("compOff.why.unknown");
  const key = EARN_SOURCE_KEY[source];
  return key ? t(key) : t("compOff.why.unknown");
}

export interface ExpiryBand {
  readonly tone: StatusTone;
  /** 'in 12 days' / 'today' / 'Lapsed' / 'No expiry'. */
  readonly note: string;
  readonly lapsed: boolean;
}

/**
 * Expiry colouring for a comp-off credit (spec E-06: amber ≤15 days,
 * red ≤5 days, "Lapsed" after). NULL `expires_on` is "No expiry", never a
 * year-3000 sentinel (DR-19).
 */
export function expiryBand(expiresOn: string | null): ExpiryBand {
  if (expiresOn === null) {
    return { tone: "neutral", note: t("compOff.expiry.none"), lapsed: false };
  }
  const daysLeft = civilDayOffset(nowIstDate(), expiresOn);
  if (daysLeft < 0) return { tone: "danger", note: t("compOff.expiry.lapsed"), lapsed: true };
  if (daysLeft === 0) return { tone: "danger", note: t("compOff.expiry.today"), lapsed: false };
  const note = t("compOff.expiry.days", { days: daysLeft });
  if (daysLeft <= 5) return { tone: "danger", note, lapsed: false };
  if (daysLeft <= 15) return { tone: "warn", note, lapsed: false };
  return { tone: "neutral", note, lapsed: false };
}

const TONE_TEXT: Readonly<Record<StatusTone, string>> = {
  success: "text-success",
  warn: "text-warning",
  danger: "text-destructive",
  info: "text-info",
  neutral: "text-muted-foreground",
};

export function toneTextClass(tone: StatusTone): string {
  return TONE_TEXT[tone];
}

const APPROVAL_ACTION_KEY: Readonly<Record<string, MessageKey>> = {
  submit: "leave.action.submit",
  approve: "leave.action.approve",
  reject: "leave.action.reject",
  request_info: "leave.action.request_info",
  provide_info: "leave.action.provide_info",
  delegate: "leave.action.delegate",
  reassign: "leave.action.reassign",
  escalate: "leave.action.escalate",
  recall: "leave.action.recall",
  cancel: "leave.action.cancel",
  comment: "leave.action.comment",
  auto_approve: "leave.action.auto_approve",
  skip_level: "leave.action.skip_level",
};

export function approvalActionLabel(action: string): string {
  const key = APPROVAL_ACTION_KEY[action];
  return key ? t(key) : action.replace(/[_-]+/g, " ");
}

/** Tone for one trail entry, so an approval and a rejection cannot look alike. */
export function approvalActionTone(action: string): StatusTone {
  if (action === "approve" || action === "auto_approve") return "success";
  if (action === "reject" || action === "cancel") return "danger";
  if (action === "escalate" || action === "request_info") return "warn";
  return "neutral";
}
