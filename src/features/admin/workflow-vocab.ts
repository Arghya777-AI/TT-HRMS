/**
 * workflow-vocab.ts — the shared wording of §12 Approvals & workflow.
 *
 * Five screens read the same six enums (`approval_status`, `approval_action`,
 * `acted_as`, `approver_kind`, `delegations.scope`, `sla_breaches.resolution`).
 * A raw `skip_level`, `hr_admin` or `approvals_and_team_view` on screen is the
 * defect DR-53 names, and two screens wording the same value differently is the
 * next one — so every label lives here, once, and every one of them is a `t()`
 * key.
 *
 * Nothing in this file computes anything: it maps a database value to a sentence.
 */
import type { StatusChipEntry } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import { dash, formatDays } from "@/lib/format";
import { formatINR } from "@/lib/money";

/** `public.approval_status` — all twelve, so no state can render raw. */
export const REQUEST_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("admin.wf.status.draft"), tone: "neutral" },
  pending: { label: t("admin.wf.status.pending"), tone: "warn" },
  in_progress: { label: t("admin.wf.status.inProgress"), tone: "info" },
  escalated: { label: t("admin.wf.status.escalated"), tone: "danger" },
  approved: { label: t("admin.wf.status.approved"), tone: "success" },
  applied: { label: t("admin.wf.status.applied"), tone: "success" },
  auto_approved: { label: t("admin.wf.status.autoApproved"), tone: "warn" },
  rejected: { label: t("admin.wf.status.rejected"), tone: "danger" },
  cancelled: { label: t("admin.wf.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("admin.wf.status.withdrawn"), tone: "neutral" },
  expired: { label: t("admin.wf.status.expired"), tone: "neutral" },
  failed: { label: t("admin.wf.status.failed"), tone: "danger" },
};

/** `approval_requests.priority` — a text column with a CHECK. */
export const PRIORITY_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  low: { label: t("admin.wf.priority.low"), tone: "neutral" },
  normal: { label: t("admin.wf.priority.normal"), tone: "neutral" },
  high: { label: t("admin.wf.priority.high"), tone: "warn" },
  urgent: { label: t("admin.wf.priority.urgent"), tone: "danger" },
};

/** `public.approval_action` — every value the append-only trail can hold. */
export const ACTION_LABEL: Readonly<Record<string, string>> = {
  submit: t("admin.wf.action.submit"),
  approve: t("admin.wf.action.approve"),
  reject: t("admin.wf.action.reject"),
  request_info: t("admin.wf.action.requestInfo"),
  provide_info: t("admin.wf.action.provideInfo"),
  delegate: t("admin.wf.action.delegate"),
  reassign: t("admin.wf.action.reassign"),
  escalate: t("admin.wf.action.escalate"),
  recall: t("admin.wf.action.recall"),
  cancel: t("admin.wf.action.cancel"),
  comment: t("admin.wf.action.comment"),
  auto_approve: t("admin.wf.action.autoApprove"),
  skip_level: t("admin.wf.action.skipLevel"),
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/** `approval_actions.acted_as` — how the actor held the authority they used. */
export const ACTED_AS_LABEL: Readonly<Record<string, string>> = {
  approver: t("admin.wf.actedAs.approver"),
  delegate: t("admin.wf.actedAs.delegate"),
  escalation: t("admin.wf.actedAs.escalation"),
  admin_override: t("admin.wf.actedAs.adminOverride"),
};

export const ACTED_AS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  approver: { label: t("admin.wf.actedAs.approver"), tone: "neutral" },
  delegate: { label: t("admin.wf.actedAs.delegate"), tone: "info" },
  escalation: { label: t("admin.wf.actedAs.escalation"), tone: "warn" },
  admin_override: { label: t("admin.wf.actedAs.adminOverride"), tone: "danger" },
};

/** `approval_chain_levels.approver_kind` / `escalate_to_kind`. */
export const APPROVER_KIND_LABEL: Readonly<Record<string, string>> = {
  reporting_manager: t("admin.wf.kind.reportingManager"),
  dotted_line_manager: t("admin.wf.kind.dottedLineManager"),
  skip_level_manager: t("admin.wf.kind.skipLevelManager"),
  department_head: t("admin.wf.kind.departmentHead"),
  location_head: t("admin.wf.kind.locationHead"),
  specific_employee: t("admin.wf.kind.specificEmployee"),
  role: t("admin.wf.kind.role"),
  any_of_role: t("admin.wf.kind.anyOfRole"),
  hr_admin: t("admin.wf.kind.hrAdmin"),
  finance: t("admin.wf.kind.finance"),
  super_admin: t("admin.wf.kind.superAdmin"),
};

export function approverKindLabel(kind: string | null): string {
  if (kind === null) return dash(null);
  return APPROVER_KIND_LABEL[kind] ?? kind;
}

/**
 * `public.app_role` — exactly four values (migration 003). It appears on a chain
 * level (`role`, for the `role` / `any_of_role` kinds) and on every trail entry
 * (`actor_role`, stamped by `act_on_approval` at the moment of the decision).
 */
export const ROLE_LABEL: Readonly<Record<string, string>> = {
  employee: t("admin.wf.role.employee"),
  manager: t("admin.wf.role.manager"),
  admin: t("admin.wf.role.admin"),
  super_admin: t("admin.wf.role.superAdmin"),
};

export function roleLabel(role: string | null): string {
  if (role === null) return dash(null);
  return ROLE_LABEL[role] ?? role;
}

/** `delegations.scope` — the CHECK's two values. */
export const DELEGATION_SCOPE_LABEL: Readonly<Record<string, string>> = {
  approvals: t("admin.wf.scope.approvals"),
  approvals_and_team_view: t("admin.wf.scope.approvalsAndTeamView"),
};

export function delegationScopeLabel(scope: string): string {
  return DELEGATION_SCOPE_LABEL[scope] ?? scope;
}

/** `sla_breaches.resolution` — why an open breach closed. */
export const BREACH_RESOLUTION_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  acted: { label: t("admin.wf.resolution.acted"), tone: "success" },
  escalated: { label: t("admin.wf.resolution.escalated"), tone: "warn" },
  auto_approved: { label: t("admin.wf.resolution.autoApproved"), tone: "warn" },
  cancelled: { label: t("admin.wf.resolution.cancelled"), tone: "neutral" },
};

export const BREACH_OPEN_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  open: { label: t("admin.wf.breach.open"), tone: "danger" },
  resolved: { label: t("admin.wf.breach.resolved"), tone: "success" },
};

/**
 * A chain's selector band, in words.
 *
 * `amount_from` / `amount_to` are `numeric(14,2)` RUPEES on `approval_chains`
 * (not paise — that convention belongs to the payroll tables), so they go
 * through `formatINR`, and `days_from` / `days_to` through `formatDays`.
 * Half-open bands read as "over" / "up to", because "₹10,000.01 – ∞" is not how
 * anyone says it.
 */
export function amountBandLabel(from: number | null, to: number | null): string {
  if (from === null && to === null) return t("admin.wf.band.anyAmount");
  if (from !== null && to === null) return t("admin.wf.band.amountOver", { from: formatINR(from) });
  if (from === null && to !== null) return t("admin.wf.band.amountUpTo", { to: formatINR(to) });
  return t("admin.wf.band.amountRange", {
    from: formatINR(from ?? 0),
    to: formatINR(to ?? 0),
  });
}

export function daysBandLabel(from: number | null, to: number | null): string {
  if (from === null && to === null) return t("admin.wf.band.anyDays");
  if (from !== null && to === null) return t("admin.wf.band.daysOver", { from: formatDays(from) });
  if (from === null && to !== null) return t("admin.wf.band.daysUpTo", { to: formatDays(to) });
  return t("admin.wf.band.daysRange", {
    from: formatDays(from ?? 0),
    to: formatDays(to ?? 0),
  });
}
