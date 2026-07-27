/**
 * display.ts — the admin console's status vocabularies, in one place.
 *
 * Every server enum that reaches a screen passes through a map here, so no raw
 * value (`partially_approved`, `inputs_locked`, `partially_used`) is ever
 * rendered (D-10/11, DR-53) and the colour semantics are consistent: negative
 * outcomes get danger tokens, waiting states warn, terminal-but-neutral states
 * stay neutral (DR-45).
 *
 * Nothing here computes a business number. The only comparisons are against
 * fixed policy thresholds that the DATABASE also enforces (the ±10% variance
 * acknowledgement gate, 022 `payroll_runs_guard`), and they choose a colour —
 * never a figure.
 */
import type { StatusChipEntry } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import type { LeaveRequestStatus } from "./api/leave.api";
import type { PayrollRunStatus } from "./api/payroll.api";
import type { RunEmployeeStatus } from "./api/payroll-detail.api";

/** `public.leave_request_status` (003). */
export const LEAVE_REQUEST_CHIP: Readonly<Record<LeaveRequestStatus, StatusChipEntry>> = {
  draft: { label: t("admin.leaveReq.status.draft"), tone: "neutral" },
  pending: { label: t("admin.leaveReq.status.pending"), tone: "warn" },
  partially_approved: { label: t("admin.leaveReq.status.partially_approved"), tone: "warn" },
  cancellation_pending: { label: t("admin.leaveReq.status.cancellation_pending"), tone: "warn" },
  approved: { label: t("admin.leaveReq.status.approved"), tone: "success" },
  rejected: { label: t("admin.leaveReq.status.rejected"), tone: "danger" },
  cancelled: { label: t("admin.leaveReq.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("admin.leaveReq.status.withdrawn"), tone: "neutral" },
};

/** The two statuses an admin may still decide (leave.api `decideLeaveRequest`). */
export const DECIDABLE_LEAVE_STATUSES: readonly LeaveRequestStatus[] = [
  "pending",
  "partially_approved",
];

export function isDecidable(status: LeaveRequestStatus): boolean {
  return DECIDABLE_LEAVE_STATUSES.includes(status);
}

/** `public.payroll_run_status` (003) — labels already exist in the catalogue. */
export const PAYROLL_RUN_CHIP: Readonly<Record<PayrollRunStatus, StatusChipEntry>> = {
  draft: { label: t("admin.payroll.status.draft"), tone: "neutral" },
  inputs_locked: { label: t("admin.payroll.status.inputs_locked"), tone: "info" },
  computed: { label: t("admin.payroll.status.computed"), tone: "info" },
  in_review: { label: t("admin.payroll.status.in_review"), tone: "warn" },
  approved: { label: t("admin.payroll.status.approved"), tone: "success" },
  disbursement_pending: { label: t("admin.payroll.status.disbursement_pending"), tone: "warn" },
  paid: { label: t("admin.payroll.status.paid"), tone: "success" },
  closed: { label: t("admin.payroll.status.closed"), tone: "neutral" },
  cancelled: { label: t("admin.payroll.status.cancelled"), tone: "neutral" },
  failed: { label: t("admin.payroll.status.failed"), tone: "danger" },
};

/** `ck_pre__status` (022 §2). */
export const RUN_EMPLOYEE_CHIP: Readonly<Record<RunEmployeeStatus, StatusChipEntry>> = {
  pending: { label: t("admin.run.emp.status.pending"), tone: "warn" },
  computed: { label: t("admin.run.emp.status.computed"), tone: "success" },
  excluded: { label: t("admin.run.emp.status.excluded"), tone: "neutral" },
  held: { label: t("admin.run.emp.status.held"), tone: "warn" },
  error: { label: t("admin.run.emp.status.error"), tone: "danger" },
};

/**
 * `comp_off_ledger.status` is text with a CHECK in 019; the values seen on the
 * live project are below. An unmapped value falls through to StatusChip's
 * humaniser rather than being invented here.
 */
export const COMP_OFF_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  available: { label: t("admin.compOff.status.available"), tone: "success" },
  partially_used: { label: t("admin.compOff.status.partially_used"), tone: "info" },
  availed: { label: t("admin.compOff.status.availed"), tone: "neutral" },
  encashed: { label: t("admin.compOff.status.encashed"), tone: "neutral" },
  expired: { label: t("admin.compOff.status.expired"), tone: "danger" },
  cancelled: { label: t("admin.compOff.status.cancelled"), tone: "neutral" },
  pending_manager_confirmation: {
    label: t("admin.compOff.status.pending_manager_confirmation"),
    tone: "warn",
  },
};

/** `comp_off_ledger.entry_type` — earned / availed / expired / cancelled. */
export const COMP_OFF_ENTRY_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  earned: { label: t("admin.compOff.entry.earned"), tone: "success" },
  availed: { label: t("admin.compOff.entry.availed"), tone: "info" },
  expired: { label: t("admin.compOff.entry.expired"), tone: "danger" },
  cancelled: { label: t("admin.compOff.entry.cancelled"), tone: "neutral" },
  encashed: { label: t("admin.compOff.entry.encashed"), tone: "neutral" },
};

/** `leave_requests.portion`. Full day adds nothing to a day count. */
export const PORTION_LABEL: Readonly<Record<string, string>> = {
  full_day: t("admin.leaveReq.portion.full_day"),
  first_half: t("admin.leaveReq.portion.first_half"),
  second_half: t("admin.leaveReq.portion.second_half"),
};

/**
 * The variance acknowledgement threshold the DATABASE enforces on approval
 * (022: `abs(variance_vs_previous_pct) > 10` needs a reason). Used only to tint a
 * row and to warn before the operator hits a trigger.
 */
export const VARIANCE_FLAG_PCT = 10;

export function isVarianceFlagged(pct: number | null): boolean {
  return pct !== null && Math.abs(pct) > VARIANCE_FLAG_PCT;
}

/** Statuses `payslip-publish` will accept for approval (its APPROVABLE_STATUSES). */
export const APPROVABLE_RUN_STATUSES: readonly PayrollRunStatus[] = ["computed", "in_review"];

/** Statuses `payroll-run` can still compute (draft…in_review, plus a retry). */
export const COMPUTABLE_RUN_STATUSES: readonly PayrollRunStatus[] = [
  "draft",
  "inputs_locked",
  "computed",
  "in_review",
  "failed",
];

/** Statuses at or past release — the run is already published. */
export const RELEASED_RUN_STATUSES: readonly PayrollRunStatus[] = [
  "approved",
  "disbursement_pending",
  "paid",
  "closed",
];
