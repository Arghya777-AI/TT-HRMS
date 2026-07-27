/**
 * command-vocab.ts — how §1 of the admin console SPEAKS and where it LINKS.
 *
 * Three jobs, none of which may be scattered across three pages:
 *
 *  1. Enum → sentence. `punch_needs_review`, `sla_breach`, `negative_net_pay`
 *     never reach a screen (D-10, DR-53). Every kind the eight branches of
 *     `v_exception_queue` can emit has a catalogue string and a chip tone, and an
 *     unknown ninth kind humanises rather than leaking or crashing.
 *  2. Kind → ROUTE. Every alert row drills through to the screen that can
 *     actually fix it, and `KIND_ROUTES` is exhaustive over `ExceptionKind`, so a
 *     new branch of the view cannot ship without a destination — it is a compile
 *     error until it has one. Paths are copied from `src/app/route-manifest.ts`.
 *  3. Severity → colour, with negatives in danger tokens (DR-45: an "Absent"
 *     badge in calm info-blue was one of the reference product's defects).
 */
import type { StatusChipEntry, StatusTone } from "@/shared/ui/StatusChip";
import { QueryError, isNoPermissionError } from "@/shared/api/query";
import { t, type MessageKey } from "@/shared/i18n/en";
import type { ExceptionKind, ExceptionRow } from "./api/command.api";

// -----------------------------------------------------------------------------
// Tile vocabulary: why a number is missing, and what a number's colour means
// -----------------------------------------------------------------------------

/**
 * Why a figure could not be read, in plain English — never a SQLSTATE, never a
 * silent `0`. A tile that fails must say which kind of failure it was, because
 * "you are offline" and "this is not yours to see" call for different actions.
 */
export function unavailableHint(error: Error): string {
  if (error instanceof QueryError) {
    if (error.isOffline) return t("admin.cc.tile.offline");
    if (error.isOurBug) return t("admin.cc.tile.schema");
  }
  if (isNoPermissionError(error)) return t("admin.cc.tile.noPermission");
  return t("admin.cc.tile.failed");
}

/** "Anything waiting is a problem" — the tone most queue tiles want. */
export function warnWhenAny(count: number): StatusTone {
  return count > 0 ? "warn" : "success";
}

/** Same, but a waiting item is serious: money, identity, or a silent gate. */
export function dangerWhenAny(count: number): StatusTone {
  return count > 0 ? "danger" : "success";
}

/** Every route §1 links to. Query strings are the destination screens' filters. */
export const ADMIN_ROUTES = {
  people: "/admin/people",
  peopleActive: "/admin/people?status=active",
  person: (code: string) => `/admin/people/${encodeURIComponent(code)}`,
  addEmployee: "/admin/people/new",
  liveIn: "/admin/attendance/live?state=in",
  liveYetToReach: "/admin/attendance/live?state=yet_to_reach",
  liveOverdue: "/admin/attendance/live?state=overdue",
  liveOff: "/admin/attendance/live?state=off",
  liveOnTime: "/admin/attendance/live?state=in",
  daysLate: (date: string) => `/admin/attendance/days?date=${date}&late=true`,
  daysAbsent: (date: string) => `/admin/attendance/days?date=${date}&status=absent`,
  exceptions: "/admin/attendance/exceptions",
  exceptionsOn: (date: string) => `/admin/attendance/exceptions?date=${date}`,
  punchesToReview: "/admin/attendance/punches?review=true",
  punchesToReviewOn: (date: string) => `/admin/attendance/punches?review=true&date=${date}`,
  manualPunch: "/admin/attendance/punches/new",
  bulkAttendance: "/admin/attendance/bulk",
  overtime: "/admin/payroll/overtime",
  overtimeOn: (date: string) => `/admin/payroll/overtime?date=${date}`,
  payrollRuns: "/admin/payroll/runs",
  documentExpiry: "/admin/documents/expiry",
  compOff: "/admin/leave/comp-off",
  kioskDevices: "/admin/kiosk/devices",
  kioskEnrolment: "/admin/kiosk/enrolment",
  workflowInbox: "/admin/workflow/inbox",
  workflowSla: "/admin/workflow/sla",
  announcements: "/admin/comms/announcements",
  analytics: "/admin/analytics",
  alerts: "/admin/alerts",
  tasks: "/admin/tasks",
} as const;

// -----------------------------------------------------------------------------
// Severity
// -----------------------------------------------------------------------------

/** `v_exception_queue.severity` → chip. */
export const SEVERITY_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  critical: { label: t("admin.alert.severity.critical"), tone: "danger" },
  warning: { label: t("admin.alert.severity.warning"), tone: "warn" },
  info: { label: t("admin.alert.severity.info"), tone: "info" },
};

export function severityTone(severity: string): StatusTone {
  return SEVERITY_CHIP[severity]?.tone ?? "neutral";
}

// -----------------------------------------------------------------------------
// Kind → label
// -----------------------------------------------------------------------------

const KIND_LABEL_KEYS: Readonly<Record<ExceptionKind, MessageKey>> = {
  punch_needs_review: "admin.alert.kind.punchNeedsReview",
  attendance_anomaly: "admin.alert.kind.attendanceAnomaly",
  unapproved_overtime: "admin.alert.kind.unapprovedOvertime",
  missing_bank_account: "admin.alert.kind.missingBankAccount",
  document_expired: "admin.alert.kind.documentExpired",
  sla_breach: "admin.alert.kind.slaBreach",
  kiosk_offline: "admin.alert.kind.kioskOffline",
  negative_net_pay: "admin.alert.kind.negativeNetPay",
};

/** 'sla_breach' → 'Approval overdue'. An unknown kind humanises, never leaks. */
export function alertKindLabel(kind: string): string {
  const key = KIND_LABEL_KEYS[kind as ExceptionKind];
  if (key !== undefined) return t(key);
  const words = kind.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Options for the kind filter, alphabetical by the label a human reads. */
export function alertKindOptions(kinds: readonly string[]): { value: string; label: string }[] {
  return kinds
    .map((kind) => ({ value: kind, label: alertKindLabel(kind) }))
    .sort((a, b) => a.label.localeCompare(b.label, "en-IN"));
}

// -----------------------------------------------------------------------------
// Kind → the screen that can fix it
// -----------------------------------------------------------------------------

/** Exhaustive over `ExceptionKind`: a kind with no route cannot compile. */
const KIND_ROUTES: Readonly<
  Record<ExceptionKind, (row: ExceptionRow, employeeCode: string | null) => string>
> = {
  punch_needs_review: (row) =>
    row.ist_date === null
      ? ADMIN_ROUTES.punchesToReview
      : ADMIN_ROUTES.punchesToReviewOn(row.ist_date),
  attendance_anomaly: (row) =>
    row.ist_date === null ? ADMIN_ROUTES.exceptions : ADMIN_ROUTES.exceptionsOn(row.ist_date),
  unapproved_overtime: (row) =>
    row.ist_date === null ? ADMIN_ROUTES.overtime : ADMIN_ROUTES.overtimeOn(row.ist_date),
  missing_bank_account: (_row, employeeCode) =>
    employeeCode === null ? ADMIN_ROUTES.people : ADMIN_ROUTES.person(employeeCode),
  document_expired: () => ADMIN_ROUTES.documentExpiry,
  sla_breach: () => ADMIN_ROUTES.workflowSla,
  kiosk_offline: () => ADMIN_ROUTES.kioskDevices,
  negative_net_pay: () => ADMIN_ROUTES.payrollRuns,
};

/**
 * The destination for one alert row. An unrecognised kind falls back to the full
 * feed, so a row is never a dead end.
 */
export function alertRoute(row: ExceptionRow, employeeCode: string | null): string {
  const build = KIND_ROUTES[row.exception_kind as ExceptionKind];
  return build === undefined ? ADMIN_ROUTES.alerts : build(row, employeeCode);
}

/**
 * True when this row is a gate scan, i.e. the one alert an admin can act on from
 * the feed itself (void it — punches are immutable evidence, so void-not-delete).
 */
export function isVoidablePunch(row: ExceptionRow): boolean {
  return row.entity_table === "attendance_punches";
}

// -----------------------------------------------------------------------------
// Gate-feed vocabulary
// -----------------------------------------------------------------------------

/**
 * `v_attendance_punch_detail.confidence_badge` → chip. The BAND is the server's
 * (spec-admin §2.2: High ≥ 0.72 / Medium / Low); this only colours it, and the
 * raw score is never shown.
 */
export const CONFIDENCE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  high: { label: t("admin.cc.confidence.high"), tone: "success" },
  medium: { label: t("admin.cc.confidence.medium"), tone: "warn" },
  low: { label: t("admin.cc.confidence.low"), tone: "danger" },
  High: { label: t("admin.cc.confidence.high"), tone: "success" },
  Medium: { label: t("admin.cc.confidence.medium"), tone: "warn" },
  Low: { label: t("admin.cc.confidence.low"), tone: "danger" },
};

/** IN / OUT exactly as the server derived it (D-13) — never re-derived here. */
export const DIRECTION_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  IN: { label: t("admin.cc.direction.in"), tone: "success" },
  in: { label: t("admin.cc.direction.in"), tone: "success" },
  OUT: { label: t("admin.cc.direction.out"), tone: "info" },
  out: { label: t("admin.cc.direction.out"), tone: "info" },
};
