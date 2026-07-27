/**
 * time-policy-display.ts — the vocabulary the two §6.6/§6.7 screens share.
 *
 * Everything here is a LABEL or a date comparison. No precedence is decided in
 * this file: `SCOPE_RANK` (the ORDER BY of `resolve_policy`) lives in
 * `time-policy.api.ts` next to the query it belongs to, and the winner itself
 * always comes back from the database.
 *
 * `KIND_CONSUMER` is the one thing here that is not cosmetic. An assignment kind
 * that nothing reads is a trap — an admin binds a pay period to a department, the
 * screen says "saved", and no code path ever consults it. So each kind carries a
 * sentence naming the deployed function that reads its resolution, taken from the
 * migrations:
 *   * attendance_policy — `f_recompute_attendance_day` (018 line 243).
 *   * holiday_calendar  — the engine's holiday lookup (018 line 283) and leave
 *     day-allocation (019 line 773), the latter falling back to
 *     `employees.holiday_calendar_id` when no binding resolves.
 *   * weekly_off_rule   — the engine (018 line 297, a published roster slot wins
 *     first) and leave allocation (019 line 782, same fallback shape).
 *   * shift             — `resolve_shift_for_date`, its own five-step ladder.
 *   * pay_period        — NOTHING calls `resolve_policy('pay_period', …)`; the
 *     period is found by its own date range.
 *   * leave_policy      — nothing calls it, and no `leave_policies` table exists.
 */
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import type { StatusChipEntry } from "@/shared/ui/StatusChip";
import { EMPLOYMENT_TYPE_LABELS } from "./api/employees.api";
import { SCOPE_RANK, type AssignmentKind, type AssignmentScope, type PolicyAssignment } from "./api/time-policy.api";

export const KIND_LABEL: Readonly<Record<AssignmentKind, string>> = {
  attendance_policy: t("timeAudit.kind.attendance_policy"),
  weekly_off_rule: t("timeAudit.kind.weekly_off_rule"),
  holiday_calendar: t("timeAudit.kind.holiday_calendar"),
  leave_policy: t("timeAudit.kind.leave_policy"),
  pay_period: t("timeAudit.kind.pay_period"),
  shift: t("timeAudit.kind.shift"),
};

/** Which deployed code path reads this kind's resolution. See the header. */
export const KIND_CONSUMER: Readonly<Record<AssignmentKind, string>> = {
  attendance_policy: t("timeAudit.consumer.attendance_policy"),
  weekly_off_rule: t("timeAudit.consumer.weekly_off_rule"),
  holiday_calendar: t("timeAudit.consumer.holiday_calendar"),
  leave_policy: t("timeAudit.consumer.leave_policy"),
  pay_period: t("timeAudit.consumer.pay_period"),
  shift: t("timeAudit.consumer.shift"),
};

/** True when a deployed function actually consults this kind's resolution. */
export const KIND_IS_READ: Readonly<Record<AssignmentKind, boolean>> = {
  attendance_policy: true,
  weekly_off_rule: true,
  holiday_calendar: true,
  leave_policy: false,
  pay_period: false,
  shift: true,
};

export const SCOPE_LABEL: Readonly<Record<AssignmentScope, string>> = {
  employee: t("timeAudit.scope.employee"),
  designation: t("timeAudit.scope.designation"),
  grade: t("timeAudit.scope.grade"),
  section: t("timeAudit.scope.section"),
  department: t("timeAudit.scope.department"),
  employment_type: t("timeAudit.scope.employment_type"),
  location: t("timeAudit.scope.location"),
  company: t("timeAudit.scope.company"),
};

/**
 * Widened views of the three maps above. A row arrives as `text` from Postgres,
 * and looking it up through `Record<string, …>` gives an honest `undefined` for a
 * value the deployed CHECK does not (yet) allow — a cast to the union would
 * instead hand back a confident label for something that is not there.
 */
const KIND_LOOKUP: Readonly<Record<string, string>> = KIND_LABEL;
const SCOPE_LOOKUP: Readonly<Record<string, string>> = SCOPE_LABEL;
const RANK_LOOKUP: Readonly<Record<string, number>> = SCOPE_RANK;
const READ_LOOKUP: Readonly<Record<string, boolean>> = KIND_IS_READ;
const EMPLOYMENT_TYPE_LOOKUP: Readonly<Record<string, string>> = EMPLOYMENT_TYPE_LABELS;

/** A server enum must never reach the screen raw (D-10); fall back honestly. */
export function kindLabel(kind: string): string {
  return KIND_LOOKUP[kind] ?? t("timeAudit.kind.unknown");
}

export function scopeLabel(scope: string): string {
  return SCOPE_LOOKUP[scope] ?? t("timeAudit.scope.unknown");
}

/** The narrowness rank `resolve_policy` orders by. Unknown scopes sort last. */
export function scopeRank(scope: string): number {
  return RANK_LOOKUP[scope] ?? 99;
}

/** True when a deployed function consults this kind's resolution. */
export function kindIsRead(kind: string): boolean {
  return READ_LOOKUP[kind] ?? false;
}

/** `public.employment_type` → its label, for `scope = 'employment_type'` targets. */
export function employmentTypeLabel(value: string): string {
  return EMPLOYMENT_TYPE_LOOKUP[value] ?? value;
}

/** Where a binding sits relative to a civil date. */
export type BindingState = "live" | "future" | "ended" | "archived";

export function bindingState(row: PolicyAssignment, isoDate: string): BindingState {
  if (row.deleted_at !== null) return "archived";
  if (row.effective_from > isoDate) return "future";
  if (row.effective_to !== null && row.effective_to < isoDate) return "ended";
  return "live";
}

export const BINDING_CHIP: Readonly<Record<BindingState, StatusChipEntry>> = {
  live: { label: t("timeAudit.state.live"), tone: "success" },
  future: { label: t("timeAudit.state.future"), tone: "info" },
  ended: { label: t("timeAudit.state.ended"), tone: "neutral" },
  archived: { label: t("timeAudit.state.archived"), tone: "danger" },
};

/** '01-Jan-2026 → open-ended' — the effective window, formatted once. */
export function windowLabel(row: {
  readonly effective_from: string;
  readonly effective_to: string | null;
}): string {
  return row.effective_to === null
    ? t("timeAudit.window.open", { from: fmtCivilDate(row.effective_from) })
    : t("timeAudit.window.closed", {
        from: fmtCivilDate(row.effective_from),
        to: fmtCivilDate(row.effective_to),
      });
}
