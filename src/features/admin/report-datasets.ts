/**
 * report-datasets.ts — the DATASET CATALOGUE the Report Builder is allowed to
 * query, and the only place a relation or column name is written down.
 *
 * Why a catalogue instead of free-form SQL: the builder sends a column list and a
 * filter set to PostgREST, and both go into the request unquoted. An allow-list
 * built from the deployed views is what makes that safe — a column the catalogue
 * does not name cannot be selected, filtered or sorted, so the worst a crafted URL
 * can do is fail this check. It is also what keeps the screen honest: RLS decides
 * WHOSE rows come back (`app.is_admin()` on the org-level views,
 * `app.can_see_employee()` on the per-employee ones), and the catalogue decides
 * only which governed relation is on offer.
 *
 * EVERY column below was read out of the migration that creates the view, not
 * inferred from a name:
 *   * `v_employee_directory`            — 033 views_employee
 *   * `v_attendance_monthly_summary`    — 036 (wrapper over analytics.mv_attendance_monthly)
 *   * `v_headcount_daily`               — 036 (wrapper over analytics.mv_headcount_daily)
 *   * `v_headcount_monthly`             — 036 (live over the matview; has NO refreshed_at)
 *   * `v_payroll_cost_monthly`          — 036 (wrapper; every money column is PAISE)
 *   * `v_leave_balance_current`         — 035 views_leave_payroll
 *   * `v_document_compliance`           — 037 views_governance
 *   * `v_kiosk_health`                  — 034 views_attendance
 *
 * `kind` drives BOTH the cell formatter and the filter vocabulary, so a paise
 * column can never be rendered as a bare integer and a date column can never be
 * given an `ilike`.
 */
import type { MessageKey } from "@/shared/i18n/en";

export type ColumnKind =
  | "text"
  /** Short identifier rendered monospaced (employee_code, device_code, IFSC…). */
  | "code"
  | "uuid"
  | "int"
  /** numeric(…) with decimals — days, averages. */
  | "decimal"
  /** INTEGER PAISE. Rendered by <Money>; never arithmetic in the client. */
  | "paise"
  /** Already a percentage in the column; the view clamps it, we do not. */
  | "pct"
  | "minutes"
  | "date"
  | "timestamp"
  | "bool"
  /** A server enum — rendered as a status chip. */
  | "enum";

export interface DatasetColumn {
  readonly column: string;
  readonly labelKey: MessageKey;
  readonly kind: ColumnKind;
  /** Off for columns that are only useful as an identity (uuid keys). */
  readonly filterable?: boolean;
}

export interface Dataset {
  readonly id: string;
  /** The deployed relation. Nothing else is ever queried. */
  readonly view: string;
  readonly titleKey: MessageKey;
  readonly hintKey: MessageKey;
  /** Route whose curated screen owns this data — the builder is the ad-hoc door. */
  readonly ownerRoute: string;
  readonly columns: readonly DatasetColumn[];
  /** Columns pre-ticked when the dataset is chosen. */
  readonly defaultColumns: readonly string[];
  readonly defaultSort: { readonly column: string; readonly ascending: boolean };
  /** True when the rows come from a matview, so `refreshed_at` is the as-of. */
  readonly refreshedAtColumn?: string;
}

/**
 * Named separately so `DEFAULT_DATASET` is a `Dataset`, not `Dataset | undefined`:
 * `DATASETS[0]` is optional under `noUncheckedIndexedAccess`, and a screen that
 * opens on nothing would need a cast to pretend otherwise.
 */
const DIRECTORY_DATASET: Dataset = {
  id: "directory",
  view: "v_employee_directory",
  titleKey: "admin.rbuild.ds.directory.title",
  hintKey: "admin.rbuild.ds.directory.hint",
  ownerRoute: "/admin/people",
  columns: [
    { column: "employee_code", labelKey: "admin.rbuild.col.employeeCode", kind: "code", filterable: true },
    { column: "display_name", labelKey: "admin.rbuild.col.displayName", kind: "text", filterable: true },
    { column: "designation_name", labelKey: "admin.rbuild.col.designation", kind: "text", filterable: true },
    { column: "department_name", labelKey: "admin.rbuild.col.department", kind: "text", filterable: true },
    { column: "location_name", labelKey: "admin.rbuild.col.location", kind: "text", filterable: true },
    { column: "work_email", labelKey: "admin.rbuild.col.workEmail", kind: "text", filterable: true },
    { column: "id", labelKey: "admin.rbuild.col.employeeId", kind: "uuid" },
  ],
  defaultColumns: [
    "employee_code",
    "display_name",
    "designation_name",
    "department_name",
    "location_name",
  ],
  defaultSort: { column: "employee_code", ascending: true },
};

/** Where the builder starts when the URL names no dataset. */
export const DEFAULT_DATASET: Dataset = DIRECTORY_DATASET;

export const DATASETS: readonly Dataset[] = [
  DIRECTORY_DATASET,
  {
    id: "attendance-monthly",
    view: "v_attendance_monthly_summary",
    titleKey: "admin.rbuild.ds.attendance.title",
    hintKey: "admin.rbuild.ds.attendance.hint",
    ownerRoute: "/admin/analytics/attendance",
    refreshedAtColumn: "refreshed_at",
    columns: [
      { column: "pay_period_code", labelKey: "admin.rbuild.col.payPeriod", kind: "code", filterable: true },
      { column: "year", labelKey: "admin.rbuild.col.year", kind: "int", filterable: true },
      { column: "month", labelKey: "admin.rbuild.col.month", kind: "int", filterable: true },
      { column: "total_days", labelKey: "admin.rbuild.col.totalDays", kind: "int", filterable: true },
      { column: "working_days", labelKey: "admin.rbuild.col.workingDays", kind: "int", filterable: true },
      { column: "present_days", labelKey: "admin.rbuild.col.presentDays", kind: "int", filterable: true },
      { column: "absent_days", labelKey: "admin.rbuild.col.absentDays", kind: "int", filterable: true },
      { column: "paid_days", labelKey: "admin.rbuild.col.paidDays", kind: "decimal", filterable: true },
      { column: "leave_days", labelKey: "admin.rbuild.col.leaveDays", kind: "decimal", filterable: true },
      { column: "late_days", labelKey: "admin.rbuild.col.lateDays", kind: "int", filterable: true },
      { column: "late_pct", labelKey: "admin.rbuild.col.latePct", kind: "pct", filterable: true },
      { column: "attendance_pct", labelKey: "admin.rbuild.col.attendancePct", kind: "pct", filterable: true },
      { column: "late_minutes", labelKey: "admin.rbuild.col.lateMinutes", kind: "minutes", filterable: true },
      { column: "overtime_minutes", labelKey: "admin.rbuild.col.otMinutes", kind: "minutes", filterable: true },
      {
        column: "approved_overtime_minutes",
        labelKey: "admin.rbuild.col.approvedOtMinutes",
        kind: "minutes",
        filterable: true,
      },
      {
        column: "total_worked_minutes",
        labelKey: "admin.rbuild.col.workedMinutes",
        kind: "minutes",
        filterable: true,
      },
      {
        column: "avg_worked_minutes_per_present_day",
        labelKey: "admin.rbuild.col.avgWorked",
        kind: "decimal",
        filterable: true,
      },
      { column: "break_minutes", labelKey: "admin.rbuild.col.breakMinutes", kind: "minutes", filterable: true },
      { column: "employee_id", labelKey: "admin.rbuild.col.employeeId", kind: "uuid" },
      { column: "refreshed_at", labelKey: "admin.rbuild.col.refreshedAt", kind: "timestamp" },
    ],
    defaultColumns: [
      "pay_period_code",
      "present_days",
      "absent_days",
      "paid_days",
      "late_pct",
      "attendance_pct",
    ],
    defaultSort: { column: "pay_period_code", ascending: false },
  },
  {
    id: "headcount-daily",
    view: "v_headcount_daily",
    titleKey: "admin.rbuild.ds.headcountDaily.title",
    hintKey: "admin.rbuild.ds.headcountDaily.hint",
    ownerRoute: "/admin/analytics/workforce",
    refreshedAtColumn: "refreshed_at",
    columns: [
      { column: "as_of_date", labelKey: "admin.rbuild.col.asOfDate", kind: "date", filterable: true },
      { column: "department_name", labelKey: "admin.rbuild.col.department", kind: "text", filterable: true },
      { column: "employment_type", labelKey: "admin.rbuild.col.employmentType", kind: "enum", filterable: true },
      { column: "headcount", labelKey: "admin.rbuild.col.headcount", kind: "int", filterable: true },
      { column: "joiners", labelKey: "admin.rbuild.col.joiners", kind: "int", filterable: true },
      { column: "exits", labelKey: "admin.rbuild.col.exits", kind: "int", filterable: true },
      { column: "department_id", labelKey: "admin.rbuild.col.departmentId", kind: "uuid" },
      { column: "refreshed_at", labelKey: "admin.rbuild.col.refreshedAt", kind: "timestamp" },
    ],
    defaultColumns: ["as_of_date", "department_name", "employment_type", "headcount", "joiners", "exits"],
    defaultSort: { column: "as_of_date", ascending: false },
  },
  {
    id: "headcount-monthly",
    view: "v_headcount_monthly",
    titleKey: "admin.rbuild.ds.headcountMonthly.title",
    hintKey: "admin.rbuild.ds.headcountMonthly.hint",
    ownerRoute: "/admin/analytics/workforce",
    columns: [
      { column: "year", labelKey: "admin.rbuild.col.year", kind: "int", filterable: true },
      { column: "month", labelKey: "admin.rbuild.col.month", kind: "int", filterable: true },
      { column: "department_name", labelKey: "admin.rbuild.col.department", kind: "text", filterable: true },
      { column: "avg_headcount", labelKey: "admin.rbuild.col.avgHeadcount", kind: "decimal", filterable: true },
      { column: "joiners", labelKey: "admin.rbuild.col.joiners", kind: "int", filterable: true },
      { column: "exits", labelKey: "admin.rbuild.col.exits", kind: "int", filterable: true },
      { column: "attrition_pct", labelKey: "admin.rbuild.col.attritionPct", kind: "pct", filterable: true },
      {
        column: "probation_count",
        labelKey: "admin.rbuild.col.probationCount",
        kind: "int",
        filterable: true,
      },
      { column: "tenure_lt_1y", labelKey: "admin.rbuild.col.tenureLt1y", kind: "int", filterable: true },
      { column: "tenure_1_3y", labelKey: "admin.rbuild.col.tenure13y", kind: "int", filterable: true },
      { column: "tenure_3_5y", labelKey: "admin.rbuild.col.tenure35y", kind: "int", filterable: true },
      { column: "tenure_ge_5y", labelKey: "admin.rbuild.col.tenureGe5y", kind: "int", filterable: true },
      { column: "department_id", labelKey: "admin.rbuild.col.departmentId", kind: "uuid" },
    ],
    defaultColumns: ["year", "month", "department_name", "avg_headcount", "joiners", "exits", "attrition_pct"],
    defaultSort: { column: "year", ascending: false },
  },
  {
    id: "payroll-cost",
    view: "v_payroll_cost_monthly",
    titleKey: "admin.rbuild.ds.payrollCost.title",
    hintKey: "admin.rbuild.ds.payrollCost.hint",
    ownerRoute: "/admin/analytics/payroll",
    refreshedAtColumn: "refreshed_at",
    columns: [
      { column: "pay_period_code", labelKey: "admin.rbuild.col.payPeriod", kind: "code", filterable: true },
      { column: "year", labelKey: "admin.rbuild.col.year", kind: "int", filterable: true },
      { column: "month", labelKey: "admin.rbuild.col.month", kind: "int", filterable: true },
      { column: "department_name", labelKey: "admin.rbuild.col.department", kind: "text", filterable: true },
      { column: "cost_centre_name", labelKey: "admin.rbuild.col.costCentre", kind: "text", filterable: true },
      { column: "employee_count", labelKey: "admin.rbuild.col.employeeCount", kind: "int", filterable: true },
      { column: "gross_paise", labelKey: "admin.rbuild.col.gross", kind: "paise", filterable: true },
      { column: "deductions_paise", labelKey: "admin.rbuild.col.deductions", kind: "paise", filterable: true },
      { column: "net_paise", labelKey: "admin.rbuild.col.net", kind: "paise", filterable: true },
      {
        column: "employer_cost_paise",
        labelKey: "admin.rbuild.col.employerCost",
        kind: "paise",
        filterable: true,
      },
      { column: "total_cost_paise", labelKey: "admin.rbuild.col.totalCost", kind: "paise", filterable: true },
      {
        column: "cost_per_employee_paise",
        labelKey: "admin.rbuild.col.costPerEmployee",
        kind: "paise",
        filterable: true,
      },
      {
        column: "overtime_cost_paise",
        labelKey: "admin.rbuild.col.otCost",
        kind: "paise",
        filterable: true,
      },
      {
        column: "overtime_share_pct",
        labelKey: "admin.rbuild.col.otSharePct",
        kind: "pct",
        filterable: true,
      },
      { column: "refreshed_at", labelKey: "admin.rbuild.col.refreshedAt", kind: "timestamp" },
    ],
    defaultColumns: [
      "pay_period_code",
      "department_name",
      "employee_count",
      "gross_paise",
      "employer_cost_paise",
      "total_cost_paise",
    ],
    defaultSort: { column: "pay_period_code", ascending: false },
  },
  {
    id: "leave-balances",
    view: "v_leave_balance_current",
    titleKey: "admin.rbuild.ds.leave.title",
    hintKey: "admin.rbuild.ds.leave.hint",
    ownerRoute: "/admin/leave/balances",
    columns: [
      { column: "leave_type_code", labelKey: "admin.rbuild.col.leaveType", kind: "code", filterable: true },
      { column: "leave_type_name", labelKey: "admin.rbuild.col.leaveTypeName", kind: "text", filterable: true },
      { column: "leave_year", labelKey: "admin.rbuild.col.leaveYear", kind: "int", filterable: true },
      { column: "opening_days", labelKey: "admin.rbuild.col.openingDays", kind: "decimal", filterable: true },
      { column: "accrued_days", labelKey: "admin.rbuild.col.accruedDays", kind: "decimal", filterable: true },
      {
        column: "carried_forward_days",
        labelKey: "admin.rbuild.col.carriedDays",
        kind: "decimal",
        filterable: true,
      },
      {
        column: "entitlement_days",
        labelKey: "admin.rbuild.col.entitlementDays",
        kind: "decimal",
        filterable: true,
      },
      { column: "availed_days", labelKey: "admin.rbuild.col.availedDays", kind: "decimal", filterable: true },
      { column: "pending_days", labelKey: "admin.rbuild.col.pendingDays", kind: "decimal", filterable: true },
      { column: "lapsed_days", labelKey: "admin.rbuild.col.lapsedDays", kind: "decimal", filterable: true },
      {
        column: "available_days",
        labelKey: "admin.rbuild.col.availableDays",
        kind: "decimal",
        filterable: true,
      },
      {
        column: "available_after_pending",
        labelKey: "admin.rbuild.col.availableAfterPending",
        kind: "decimal",
        filterable: true,
      },
      {
        column: "expiring_soon_days",
        labelKey: "admin.rbuild.col.expiringSoonDays",
        kind: "decimal",
        filterable: true,
      },
      { column: "nearest_expiry", labelKey: "admin.rbuild.col.nearestExpiry", kind: "date", filterable: true },
      { column: "is_paid", labelKey: "admin.rbuild.col.isPaid", kind: "bool", filterable: true },
      { column: "is_comp_off", labelKey: "admin.rbuild.col.isCompOff", kind: "bool", filterable: true },
      { column: "employee_id", labelKey: "admin.rbuild.col.employeeId", kind: "uuid" },
      {
        column: "last_recomputed_at",
        labelKey: "admin.rbuild.col.lastRecomputed",
        kind: "timestamp",
      },
    ],
    defaultColumns: [
      "leave_type_code",
      "leave_year",
      "entitlement_days",
      "availed_days",
      "pending_days",
      "available_days",
    ],
    defaultSort: { column: "leave_type_code", ascending: true },
  },
  {
    id: "document-compliance",
    view: "v_document_compliance",
    titleKey: "admin.rbuild.ds.documents.title",
    hintKey: "admin.rbuild.ds.documents.hint",
    ownerRoute: "/admin/analytics/compliance",
    columns: [
      { column: "employee_code", labelKey: "admin.rbuild.col.employeeCode", kind: "code", filterable: true },
      { column: "display_name", labelKey: "admin.rbuild.col.displayName", kind: "text", filterable: true },
      { column: "department_name", labelKey: "admin.rbuild.col.department", kind: "text", filterable: true },
      {
        column: "document_type_code",
        labelKey: "admin.rbuild.col.documentType",
        kind: "code",
        filterable: true,
      },
      {
        column: "document_type_name",
        labelKey: "admin.rbuild.col.documentTypeName",
        kind: "text",
        filterable: true,
      },
      {
        column: "compliance_status",
        labelKey: "admin.rbuild.col.complianceStatus",
        kind: "enum",
        filterable: true,
      },
      {
        column: "document_status",
        labelKey: "admin.rbuild.col.documentStatus",
        kind: "enum",
        filterable: true,
      },
      { column: "expiry_date", labelKey: "admin.rbuild.col.expiryDate", kind: "date", filterable: true },
      {
        column: "requires_expiry",
        labelKey: "admin.rbuild.col.requiresExpiry",
        kind: "bool",
        filterable: true,
      },
      { column: "employee_id", labelKey: "admin.rbuild.col.employeeId", kind: "uuid" },
    ],
    defaultColumns: [
      "employee_code",
      "display_name",
      "department_name",
      "document_type_code",
      "compliance_status",
      "expiry_date",
    ],
    defaultSort: { column: "employee_code", ascending: true },
  },
  {
    id: "kiosk-health",
    view: "v_kiosk_health",
    titleKey: "admin.rbuild.ds.kiosk.title",
    hintKey: "admin.rbuild.ds.kiosk.hint",
    ownerRoute: "/admin/analytics/kiosk",
    columns: [
      { column: "ist_date", labelKey: "admin.rbuild.col.istDate", kind: "date", filterable: true },
      { column: "device_code", labelKey: "admin.rbuild.col.deviceCode", kind: "code", filterable: true },
      { column: "label", labelKey: "admin.rbuild.col.deviceLabel", kind: "text", filterable: true },
      { column: "total_attempts", labelKey: "admin.rbuild.col.attempts", kind: "int", filterable: true },
      { column: "matched", labelKey: "admin.rbuild.col.matched", kind: "int", filterable: true },
      { column: "no_match", labelKey: "admin.rbuild.col.noMatch", kind: "int", filterable: true },
      { column: "ambiguous", labelKey: "admin.rbuild.col.ambiguous", kind: "int", filterable: true },
      {
        column: "liveness_failures",
        labelKey: "admin.rbuild.col.livenessFailures",
        kind: "int",
        filterable: true,
      },
      {
        column: "duplicates_suppressed",
        labelKey: "admin.rbuild.col.duplicates",
        kind: "int",
        filterable: true,
      },
      {
        column: "match_success_pct",
        labelKey: "admin.rbuild.col.matchSuccessPct",
        kind: "pct",
        filterable: true,
      },
      { column: "p50_latency_ms", labelKey: "admin.rbuild.col.p50", kind: "int", filterable: true },
      { column: "p95_latency_ms", labelKey: "admin.rbuild.col.p95", kind: "int", filterable: true },
      {
        column: "offline_replays",
        labelKey: "admin.rbuild.col.offlineReplays",
        kind: "int",
        filterable: true,
      },
      { column: "is_active", labelKey: "admin.rbuild.col.isActive", kind: "bool", filterable: true },
      { column: "last_seen_at", labelKey: "admin.rbuild.col.lastSeenAt", kind: "timestamp" },
    ],
    defaultColumns: [
      "ist_date",
      "device_code",
      "total_attempts",
      "matched",
      "no_match",
      "match_success_pct",
      "p95_latency_ms",
    ],
    defaultSort: { column: "ist_date", ascending: false },
  },
];

export function findDataset(id: string | null): Dataset | null {
  if (id === null) return null;
  return DATASETS.find((dataset) => dataset.id === id) ?? null;
}

export function findColumn(dataset: Dataset, column: string): DatasetColumn | null {
  return dataset.columns.find((entry) => entry.column === column) ?? null;
}

// -----------------------------------------------------------------------------
// Filter vocabulary — decided by the column's kind, never by free text
// -----------------------------------------------------------------------------

export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "isNull" | "notNull";

const TEXT_OPS: readonly FilterOp[] = ["eq", "neq", "contains", "isNull", "notNull"];
const NUMBER_OPS: readonly FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "isNull", "notNull"];
const DATE_OPS: readonly FilterOp[] = ["eq", "gte", "lte", "isNull", "notNull"];
const BOOL_OPS: readonly FilterOp[] = ["eq", "isNull", "notNull"];
const ENUM_OPS: readonly FilterOp[] = ["eq", "neq", "isNull", "notNull"];

/** Which comparisons make sense on this kind. `contains` never touches a number. */
export function opsForKind(kind: ColumnKind): readonly FilterOp[] {
  switch (kind) {
    case "text":
    case "code":
      return TEXT_OPS;
    case "int":
    case "decimal":
    case "paise":
    case "pct":
    case "minutes":
      return NUMBER_OPS;
    case "date":
    case "timestamp":
      return DATE_OPS;
    case "bool":
      return BOOL_OPS;
    case "enum":
      return ENUM_OPS;
    case "uuid":
      return ENUM_OPS;
  }
}

/** `isNull` / `notNull` are complete on their own — no value box is shown. */
export function opNeedsValue(op: FilterOp): boolean {
  return op !== "isNull" && op !== "notNull";
}

// -----------------------------------------------------------------------------
// Starter reports — the seeded "saved views" (§16.4 seeds the same idea on grids)
// -----------------------------------------------------------------------------

export interface StarterReport {
  readonly id: string;
  readonly titleKey: MessageKey;
  readonly hintKey: MessageKey;
  readonly datasetId: string;
  readonly columns: readonly string[];
  readonly filters: readonly { readonly column: string; readonly op: FilterOp; readonly value: string }[];
  readonly sort: { readonly column: string; readonly ascending: boolean };
  readonly limit: number;
}

/**
 * Seven questions an administrator actually asks, expressed in the same query
 * shape the form produces — loading one fills the form, it does not bypass it.
 * Every column and every filter value here exists in the dataset above it
 * (`compliance_status` values come from the CASE in 037; `is_comp_off` from
 * `leave_types`).
 */
export const STARTER_REPORTS: readonly StarterReport[] = [
  {
    id: "documents-expiring",
    titleKey: "admin.rbuild.starter.docsExpiring.title",
    hintKey: "admin.rbuild.starter.docsExpiring.hint",
    datasetId: "document-compliance",
    columns: [
      "employee_code",
      "display_name",
      "department_name",
      "document_type_code",
      "expiry_date",
      "compliance_status",
    ],
    filters: [{ column: "compliance_status", op: "eq", value: "expiring_soon" }],
    sort: { column: "expiry_date", ascending: true },
    limit: 250,
  },
  {
    id: "documents-missing",
    titleKey: "admin.rbuild.starter.docsMissing.title",
    hintKey: "admin.rbuild.starter.docsMissing.hint",
    datasetId: "document-compliance",
    columns: ["employee_code", "display_name", "department_name", "document_type_code", "compliance_status"],
    filters: [{ column: "compliance_status", op: "eq", value: "missing" }],
    sort: { column: "employee_code", ascending: true },
    limit: 500,
  },
  {
    id: "late-months",
    titleKey: "admin.rbuild.starter.late.title",
    hintKey: "admin.rbuild.starter.late.hint",
    datasetId: "attendance-monthly",
    columns: ["pay_period_code", "working_days", "present_days", "late_days", "late_pct", "attendance_pct"],
    filters: [{ column: "late_pct", op: "gte", value: "10" }],
    sort: { column: "late_pct", ascending: false },
    limit: 250,
  },
  {
    id: "department-cost",
    titleKey: "admin.rbuild.starter.cost.title",
    hintKey: "admin.rbuild.starter.cost.hint",
    datasetId: "payroll-cost",
    columns: [
      "pay_period_code",
      "department_name",
      "employee_count",
      "gross_paise",
      "total_cost_paise",
      "overtime_share_pct",
    ],
    filters: [],
    sort: { column: "pay_period_code", ascending: false },
    limit: 250,
  },
  {
    id: "attrition",
    titleKey: "admin.rbuild.starter.attrition.title",
    hintKey: "admin.rbuild.starter.attrition.hint",
    datasetId: "headcount-monthly",
    columns: ["year", "month", "department_name", "avg_headcount", "exits", "attrition_pct"],
    filters: [{ column: "exits", op: "gte", value: "1" }],
    sort: { column: "attrition_pct", ascending: false },
    limit: 250,
  },
  {
    id: "comp-off-lapsing",
    titleKey: "admin.rbuild.starter.compOff.title",
    hintKey: "admin.rbuild.starter.compOff.hint",
    datasetId: "leave-balances",
    columns: [
      "leave_type_code",
      "available_days",
      "expiring_soon_days",
      "nearest_expiry",
      "employee_id",
    ],
    filters: [
      { column: "is_comp_off", op: "eq", value: "true" },
      { column: "expiring_soon_days", op: "gt", value: "0" },
    ],
    sort: { column: "nearest_expiry", ascending: true },
    limit: 250,
  },
  {
    id: "kiosk-match",
    titleKey: "admin.rbuild.starter.kiosk.title",
    hintKey: "admin.rbuild.starter.kiosk.hint",
    datasetId: "kiosk-health",
    columns: [
      "ist_date",
      "device_code",
      "total_attempts",
      "matched",
      "no_match",
      "match_success_pct",
      "p95_latency_ms",
    ],
    filters: [],
    sort: { column: "ist_date", ascending: false },
    limit: 100,
  },
];
