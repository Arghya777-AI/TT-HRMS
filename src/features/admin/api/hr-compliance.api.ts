/**
 * hr-compliance.api.ts — the reads behind the Compliance & Operations panel.
 *
 * Nine relations, five different GRAINS, and the grain is the whole design:
 *
 *   1. `v_document_compliance`             employee × required document type
 *   2. `v_policy_acknowledgement_status`   one row per policy DOCUMENT
 *   3. `document_acknowledgements`         one row per (policy × person)
 *   4. `v_enrolment_coverage`              GAP ROWS ONLY, one per employee
 *   5. `v_kiosk_health`                    device × IST day
 *   6. `v_approval_sla`                    approver × request type, ALL TIME
 *   7. `v_approval_inbox`                  the CALLER'S OWN queue, nobody else's
 *   8. `v_exception_queue`                 one row per open exception, now
 *   9. `v_asset_custody` + `v_admin_employee`  open allocations, joined by id
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH FILTERS EACH RELATION CAN HONOUR — read, not assumed
 * ═══════════════════════════════════════════════════════════════════════════
 * `AnalyticsFilters` carries a period and four dimensions. Almost none of these
 * relations carry all of them, and the difference is declared per relation in a
 * {@link DimensionSupport} literal beside each fetcher. {@link scopeFor} turns
 * that declaration into predicates AND into the caveats for whatever it could
 * not honour, so a filter is never silently dropped — the failure mode being
 * avoided is a panel that prints whole-venue numbers under one department's
 * heading.
 *
 * Verified against the deployed SQL (migrations 034 §9 and 037; no later
 * migration redefines any of these views):
 *
 *   * `department_id` exists on v_document_compliance, v_enrolment_coverage and
 *     v_admin_employee. It does NOT exist on v_asset_custody, which selects only
 *     `er.department_name`, nor on v_exception_queue, v_kiosk_health,
 *     v_approval_sla or v_policy_acknowledgement_status.
 *   * `location_id` exists on v_admin_employee ALONE.
 *   * `ist_date` — the only period column — exists on v_kiosk_health and
 *     v_exception_queue. The rest are snapshots of NOW.
 *   * `AnalyticsFilters.source` (punch capture method) reaches NONE of them: it
 *     is a column on `attendance_punches`. Always a caveat, never ignored.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE EVERY NUMBER COMES FROM
 * ═══════════════════════════════════════════════════════════════════════════
 * SERVER-COUNTED (`count=exact` HEAD, no rows on the wire): every document
 * compliance tile, the enrolment gap total, the open exception total, the open
 * custody total, and the caller's overdue approval count. Each uses the SAME
 * filter array as the list it drills into, so a tile and its own detail view
 * cannot disagree (the "7 vs 8" defect).
 *
 * CLIENT-AGGREGATED, in `../hrComplianceAggregate` (pure, unit-tested): the
 * pooled rates that no view publishes at org level, every bucketing, and the
 * custody × employment-status join. Each carries an {@link AnalyticsProvenance}
 * saying `computedBy: "client"` with the row count it was computed over.
 *
 * NOT COMPUTED, ON PURPOSE: a biometric COVERAGE percentage.
 * `v_enrolment_coverage` holds gap rows only, and its `app.is_admin()` gate is
 * weaker than `v_admin_employee`'s `app.is_admin() AND app.admin_scope_covers()`
 * — so for a department-scoped admin a "gaps ÷ headcount" ratio would divide two
 * different populations and could exceed 100%. The panel prints the counts and
 * says why there is no percentage.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbNumericNullable,
  dbTimestampNullable,
  dbUuid,
  eq,
  gte,
  inList,
  isNull,
  isTrue,
  lte,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import type { MessageKey } from "@/shared/i18n/en";
import type { AnalyticsFilters } from "@/lib/analyticsFilters";
import type { AnalyticsProvenance } from "./analytics.api";
import { V_ADMIN_EMPLOYEE, employmentStatusSchema } from "./employees.api";
import {
  V_DOCUMENT_COMPLIANCE,
  V_POLICY_ACK_STATUS,
  complianceStatusValues,
  fetchAcknowledgements,
  fetchPolicyAckStatus,
  type AckStatus,
  type AdminAck,
} from "./documents.api";
import { V_ENROLMENT_COVERAGE, V_KIOSK_HEALTH, kioskHealthSchema } from "./system.api";
import { enrolmentCoverageRowSchema, documentExpiryRowSchema } from "./analytics-ops.api";
import { V_EXCEPTION_QUEUE, exceptionRowSchema, type ExceptionRow } from "./attendance.api";
import { V_ASSET_CUSTODY, custodyRowSchema } from "./assets.api";
import { V_APPROVAL_SLA, approvalSlaSchema, type ApprovalSlaRow } from "./workflow-admin.api";
import { V_APPROVAL_INBOX } from "./command.api";
import {
  EMPTY_CUSTODY,
  groupEnrolmentGaps,
  groupExceptions,
  joinCustodyHolders,
  summariseApprovalBreaches,
  summariseDocumentCompliance,
  summariseGateHealth,
  summarisePolicyAcknowledgement,
  summariseWorkforceCompliance,
  type ApprovalBreachSummary,
  type CustodySummary,
  type DocumentComplianceSummary,
  type EnrolmentGapSummary,
  type ExceptionSummary,
  type GateHealthSummary,
  type HolderState,
  type PolicyAckSummary,
  type WorkforceComplianceSummary,
  type WorkforceRow,
} from "../hrComplianceAggregate";

export type { DocumentExpiryRow } from "./analytics-ops.api";
export type { EnrolmentCoverageRow } from "./analytics-ops.api";
export type { KioskHealthRow as KioskHealthWireRow } from "./system.api";

// -----------------------------------------------------------------------------
// Caps
// -----------------------------------------------------------------------------

/**
 * Row caps. Every one of these relations grows without bound — the exception
 * queue on a bad morning, the custody register over years — so an uncapped read
 * is a defect, and a capped read that does not SAY it was capped is a worse one.
 * Every fetcher below reports `truncated` when it comes back full.
 */
export const EXPIRING_ROW_CAP = 200;
export const POLICY_ROW_CAP = 200;
export const UNACKNOWLEDGED_ROW_CAP = 200;
export const ENROLMENT_GAP_ROW_CAP = 300;
export const GATE_DAY_ROW_CAP = 500;
export const SLA_ROW_CAP = 300;
export const EXCEPTION_ROW_CAP = 300;
export const CUSTODY_ROW_CAP = 300;

/**
 * The whole workforce in one narrow read, so the statutory counts, the tax
 * regime split, the completeness distribution and the biometric stamps are four
 * projections of ONE population instead of thirteen `count=exact` HEADs whose
 * denominators could drift apart between round trips.
 */
export const WORKFORCE_ROW_CAP = 2_000;

/**
 * How many holder ids the custody join may carry into an `IN (…)` predicate.
 *
 * A uuid is 38 characters in a PostgREST filter, so 150 ids is ~5.7 KB of URL —
 * comfortably inside every proxy's line limit, where 500 would not be. Past it
 * the join reports `holderScopeCapped` and every unresolved holder is `unknown`,
 * which is exactly the verdict {@link joinCustodyHolders} was built to keep
 * distinct from "still employed".
 */
export const CUSTODY_HOLDER_ID_CAP = 150;

/** A `count=exact` HEAD has no page, so it has no cap. */
const NO_ROW_CAP = 0;

/**
 * The employment statuses `v_document_compliance` and `v_enrolment_coverage`
 * both hard-code (migrations 037 §2 / §5).
 *
 * Deliberately NARROWER than `ACTIVE_EMPLOYMENT_STATUSES` from employees.api,
 * which also counts `pre_joining`, `suspended`, `on_long_leave` and `rehired` as
 * "currently employed". The workforce read uses these four so its denominators
 * describe the SAME population the document and enrolment sections do — a panel
 * whose sections quietly disagree about who counts is worse than one that shows
 * fewer people.
 */
export const COMPLIANCE_POPULATION_STATUSES: readonly string[] = [
  "active",
  "confirmed",
  "on_probation",
  "on_notice",
];

// -----------------------------------------------------------------------------
// Scope — AnalyticsFilters → predicates + the caveats for what was dropped
// -----------------------------------------------------------------------------

/**
 * Which of the four dimensions (and the period) a relation physically carries.
 * A column named here is filtered on; a column omitted produces a caveat when
 * the corresponding filter is set. There is no third behaviour.
 */
interface DimensionSupport {
  readonly departmentColumn?: string;
  readonly locationColumn?: string;
  readonly employeeColumn?: string;
  /** The IST business-date column the period narrows. Omit for a snapshot. */
  readonly periodColumn?: string;
}

export interface ComplianceScope {
  readonly filters: readonly Filter[];
  readonly caveats: readonly MessageKey[];
}

/**
 * PURE: filters in, predicates plus caveats out. Separated from every fetch so
 * the "what can this relation honour" policy is testable without a network, and
 * so two sections reading the same relation cannot scope it differently.
 */
export function scopeFor(
  filters: AnalyticsFilters,
  support: DimensionSupport,
  extra: readonly Filter[] = [],
): ComplianceScope {
  const out: Filter[] = [...extra];
  const caveats: MessageKey[] = [];

  if (support.periodColumn !== undefined) {
    out.push(gte(support.periodColumn, filters.period.from));
    out.push(lte(support.periodColumn, filters.period.to));
  } else {
    // Said out loud on every snapshot section. A reader who stepped the period
    // back three months and saw these tiles hold still deserves to know they are
    // looking at today, not at March.
    caveats.push("admin.hrcomp.caveat.snapshotNotPeriod");
  }

  if (filters.departmentId !== undefined) {
    if (support.departmentColumn === undefined) caveats.push("admin.hrcomp.caveat.noDepartment");
    else out.push(eq(support.departmentColumn, filters.departmentId));
  }
  if (filters.locationId !== undefined) {
    if (support.locationColumn === undefined) caveats.push("admin.hrcomp.caveat.noLocation");
    else out.push(eq(support.locationColumn, filters.locationId));
  }
  if (filters.employeeId !== undefined) {
    if (support.employeeColumn === undefined) caveats.push("admin.hrcomp.caveat.noEmployee");
    else out.push(eq(support.employeeColumn, filters.employeeId));
  }
  // Punch source is a column on `attendance_punches`. Nothing here has it.
  if (filters.source !== "all") caveats.push("admin.hrcomp.caveat.noSource");

  return { filters: out, caveats };
}

function provenance(
  relation: string,
  computedBy: "server" | "client",
  rowsScanned: number,
  rowCap: number,
  scope: ComplianceScope,
  extraCaveats: readonly MessageKey[] = [],
): AnalyticsProvenance {
  const truncated = rowCap > 0 && rowsScanned >= rowCap;
  return {
    relation,
    computedBy,
    rowsScanned,
    rowCap,
    truncated,
    caveats: truncated
      ? [...scope.caveats, ...extraCaveats, "admin.hrcomp.caveat.truncated"]
      : [...scope.caveats, ...extraCaveats],
  };
}

const signalOpt = (signal?: AbortSignal) => (signal ? { signal } : {});

export interface ComplianceFetchOptions {
  readonly signal?: AbortSignal;
  /** Lower a cap for a dense screen. Never raise one without reading the header. */
  readonly limit?: number;
}

// =============================================================================
// 1. Document compliance — counts by Postgres, the expiring list by page
// =============================================================================

/** v_document_compliance carries employee_id and department_id; nothing else. */
const DOCUMENT_SUPPORT: DimensionSupport = {
  departmentColumn: "department_id",
  employeeColumn: "employee_id",
};

export interface DocumentComplianceResult {
  readonly summary: DocumentComplianceSummary;
  readonly provenance: AnalyticsProvenance;
}

/**
 * Five `count=exact` HEADs in parallel: one per `compliance_status` arm plus one
 * unnarrowed. Nothing crosses the wire but the numbers, and the fifth is the
 * drift check described in {@link summariseDocumentCompliance}.
 */
export async function fetchDocumentComplianceSummary(
  filters: AnalyticsFilters,
  opts: ComplianceFetchOptions = {},
): Promise<DocumentComplianceResult> {
  const scope = scopeFor(filters, DOCUMENT_SUPPORT);
  const o = signalOpt(opts.signal);
  const [missing, expired, expiringSoon, valid, requirements] = await Promise.all([
    selectCount(V_DOCUMENT_COMPLIANCE, [...scope.filters, eq("compliance_status", "missing")], o),
    selectCount(V_DOCUMENT_COMPLIANCE, [...scope.filters, eq("compliance_status", "expired")], o),
    selectCount(
      V_DOCUMENT_COMPLIANCE,
      [...scope.filters, eq("compliance_status", "expiring_soon")],
      o,
    ),
    selectCount(V_DOCUMENT_COMPLIANCE, [...scope.filters, eq("compliance_status", "valid")], o),
    selectCount(V_DOCUMENT_COMPLIANCE, scope.filters, o),
  ]);

  return {
    summary: summariseDocumentCompliance({ missing, expired, expiringSoon, valid, requirements }),
    provenance: provenance(
      V_DOCUMENT_COMPLIANCE,
      "server",
      requirements,
      NO_ROW_CAP,
      scope,
    ),
  };
}

export interface ExpiringDocumentsResult {
  readonly rows: readonly z.infer<typeof documentExpiryRowSchema>[];
  readonly provenance: AnalyticsProvenance;
}

/**
 * THE action list: required documents whose expiry falls inside the view's own
 * 60-day window, soonest first.
 *
 * `expiring_soon` only. Already-expired documents are a different job — they are
 * a breach, not a task with a deadline — and they have their own tile and their
 * own drill-through. Ordering is `expiry_date ASC` because that is the order the
 * work is done in; the status predicate guarantees no NULLs in that column, so
 * there is no nulls-last question to get wrong.
 *
 * `analytics-ops.api.fetchDocumentExpiry` reads the same view for the Compliance
 * ANALYTICS screen; it is not reused because its filter vocabulary has no
 * employee predicate and this panel's tiles must count exactly this list.
 */
export async function fetchExpiringDocuments(
  filters: AnalyticsFilters,
  opts: ComplianceFetchOptions = {},
): Promise<ExpiringDocumentsResult> {
  const scope = scopeFor(filters, DOCUMENT_SUPPORT, [eq("compliance_status", "expiring_soon")]);
  const cap = opts.limit ?? EXPIRING_ROW_CAP;
  const rows = await selectMany(V_DOCUMENT_COMPLIANCE, documentExpiryRowSchema, {
    filters: scope.filters,
    order: [
      { column: "expiry_date", ascending: true, nullsFirst: false },
      { column: "employee_code", ascending: true },
    ],
    limit: cap,
    ...signalOpt(opts.signal),
  });
  return {
    rows,
    provenance: provenance(V_DOCUMENT_COMPLIANCE, "server", rows.length, cap, scope),
  };
}

/** The four arms, re-exported so a drill-through link cannot invent a fifth. */
export const COMPLIANCE_STATUS_VALUES = complianceStatusValues;

// =============================================================================
// 2. Policy acknowledgement
// =============================================================================

/**
 * `v_policy_acknowledgement_status` is GROUPed BY the document. It carries no
 * employee, department or date column at all, so every dimension filter is
 * reported as unhonoured rather than quietly ignored.
 */
const POLICY_SUPPORT: DimensionSupport = {};

export interface PolicyAckResult {
  readonly summary: PolicyAckSummary;
  readonly provenance: AnalyticsProvenance;
}

/**
 * The per-policy rows, pooled into one acknowledgement rate.
 *
 * `documents.api.fetchPolicyAckStatus` is reused verbatim — it takes no filters
 * precisely because the view has no dimension columns, so there is nothing this
 * panel could scope differently and no reason for a second reader.
 */
export async function fetchPolicyAcknowledgement(
  filters: AnalyticsFilters,
  opts: ComplianceFetchOptions = {},
): Promise<PolicyAckResult> {
  const scope = scopeFor(filters, POLICY_SUPPORT);
  const cap = opts.limit ?? POLICY_ROW_CAP;
  const rows = await fetchPolicyAckStatus(cap, opts.signal);
  return {
    summary: summarisePolicyAcknowledgement(rows),
    provenance: provenance(V_POLICY_ACK_STATUS, "client", rows.length, cap, scope),
  };
}

/** Statuses that still owe an acknowledgement. `waived` and `acknowledged` do not. */
export const OPEN_ACK_STATUSES: readonly AckStatus[] = ["assigned", "opened", "overdue"];

export interface UnacknowledgedResult {
  readonly rows: readonly AdminAck[];
  readonly provenance: AnalyticsProvenance;
}

/**
 * WHO has not acknowledged — the per-person grain the aggregate view cannot
 * reach, read from `document_acknowledgements` itself.
 *
 * The row carries `employee_id` and no name (the table is a join table), so the
 * panel resolves labels through the shared `useEmployeeLabels` map rather than
 * embedding a second directory read here. Soonest deadline first: `due_on ASC`
 * with nulls last, so a policy with no deadline never squats above one with a
 * date on it.
 */
export async function fetchUnacknowledgedPolicies(
  filters: AnalyticsFilters,
  opts: ComplianceFetchOptions = {},
): Promise<UnacknowledgedResult> {
  const cap = opts.limit ?? UNACKNOWLEDGED_ROW_CAP;
  // Only the employee dimension exists on this table. Everything else caveats.
  const scope = scopeFor(filters, { employeeColumn: "employee_id" });
  const rows = await fetchAcknowledgements(
    {
      statuses: OPEN_ACK_STATUSES,
      ...(filters.employeeId === undefined ? {} : { employeeId: filters.employeeId }),
    },
    cap,
    opts.signal,
  );
  return {
    rows,
    provenance: provenance("document_acknowledgements", "server", rows.length, cap, scope),
  };
}

// =============================================================================
// 3. Biometric coverage — v_enrolment_coverage
// =============================================================================

const ENROLMENT_SUPPORT: DimensionSupport = {
  departmentColumn: "department_id",
  employeeColumn: "employee_id",
};

export interface EnrolmentGapResult {
  readonly summary: EnrolmentGapSummary;
  readonly provenance: AnalyticsProvenance;
}

/**
 * Who cannot use the gate, and why.
 *
 * The `gap_kind` is the VIEW's verdict (migration 037 §2) and is bucketed, never
 * re-derived from `has_active_consent` / `has_active_template` — the view
 * already decided that a withdrawn consent outranks a missing template, and two
 * places deciding that independently is how somebody gets chased for a lawful
 * choice.
 *
 * The total is a separate `count=exact` over the SAME predicate, so the tile is
 * the true size of the queue even when the page below it was capped.
 */
export async function fetchEnrolmentGaps(
  filters: AnalyticsFilters,
  opts: ComplianceFetchOptions = {},
): Promise<EnrolmentGapResult> {
  const scope = scopeFor(filters, ENROLMENT_SUPPORT);
  const cap = opts.limit ?? ENROLMENT_GAP_ROW_CAP;
  const [rows, total] = await Promise.all([
    selectMany(V_ENROLMENT_COVERAGE, enrolmentCoverageRowSchema, {
      filters: scope.filters,
      order: [
        { column: "department_name", ascending: true },
        { column: "employee_code", ascending: true },
      ],
      limit: cap,
      ...signalOpt(opts.signal),
    }),
    selectCount(V_ENROLMENT_COVERAGE, scope.filters, signalOpt(opts.signal)),
  ]);
  return {
    summary: groupEnrolmentGaps(rows, total),
    provenance: provenance(V_ENROLMENT_COVERAGE, "client", rows.length, cap, scope, [
      "admin.hrcomp.caveat.gapRowsOnly",
    ]),
  };
}

// =============================================================================
// 4. Gate health — v_kiosk_health
// =============================================================================

/**
 * The one section the period actually narrows. There is no employee or
 * department on a device-day row, so those filters caveat.
 */
const GATE_SUPPORT: DimensionSupport = { periodColumn: "ist_date" };

export interface GateHealthResult {
  readonly summary: GateHealthSummary;
  readonly provenance: AnalyticsProvenance;
}

/**
 * Device-days over the selected period, pooled into one match rate.
 *
 * Ordered `ist_date DESC` so a capped read keeps the MOST RECENT days — the
 * opposite choice from the attendance day read, and deliberate: a gate problem
 * is a thing happening now, and losing last week to keep three months of history
 * would be the wrong half of the answer.
 *
 * `system.api.fetchKioskHealth` reads the same view for the kiosk console; it is
 * not reused because it pins its own 500-row limit and reports no truncation,
 * and this panel has to say when its picture is partial.
 */
export async function fetchGateHealth(
  filters: AnalyticsFilters,
  opts: ComplianceFetchOptions = {},
): Promise<GateHealthResult> {
  const scope = scopeFor(filters, GATE_SUPPORT);
  const cap = opts.limit ?? GATE_DAY_ROW_CAP;
  const rows = await selectMany(V_KIOSK_HEALTH, kioskHealthSchema, {
    filters: scope.filters,
    order: [
      { column: "ist_date", ascending: false },
      { column: "device_code", ascending: true },
    ],
    limit: cap,
    ...signalOpt(opts.signal),
  });
  return {
    summary: summariseGateHealth(rows),
    provenance: provenance(V_KIOSK_HEALTH, "client", rows.length, cap, scope, [
      // A device that saw no attempt in the window has no row at all, so "3
      // devices" here means three that were USED, not three that exist.
      "admin.hrcomp.caveat.gateDevicesSeenOnly",
    ]),
  };
}

// =============================================================================
// 5. Approval SLA breaches — v_approval_sla + the caller's own overdue queue
// =============================================================================

/**
 * `v_approval_sla` has no date column whatsoever: it aggregates every decided
 * `approval_action` since the system was switched on. The period filter cannot
 * touch it, and the caveat says so in as many words rather than letting a reader
 * assume the breach count belongs to the month on the filter bar.
 *
 * `approver_employee_id` is NOT wired to `filters.employeeId`. That filter means
 * "the employee this data is ABOUT", and on this relation the employee is the
 * decider, not the subject — honouring it would silently answer a different
 * question than the one every other section answers.
 */
const SLA_SUPPORT: DimensionSupport = {};

export interface ApprovalBreachResult {
  readonly summary: ApprovalBreachSummary;
  readonly provenance: AnalyticsProvenance;
}

/**
 * Breaches, not volume.
 *
 * Ordered `breached DESC` by the SERVER, so a capped page keeps the worst
 * offenders — the rows this section exists to show. `fetchApprovalSla` in
 * workflow-admin.api orders by `decided DESC` for its register, which would cap
 * away a small approver who is late on everything; the schema is reused, the
 * ordering is not.
 */
export async function fetchApprovalBreaches(
  filters: AnalyticsFilters,
  opts: ComplianceFetchOptions = {},
): Promise<ApprovalBreachResult> {
  const scope = scopeFor(filters, SLA_SUPPORT);
  const cap = opts.limit ?? SLA_ROW_CAP;
  const rows: ApprovalSlaRow[] = await selectMany(V_APPROVAL_SLA, approvalSlaSchema, {
    filters: scope.filters,
    order: [
      { column: "breached", ascending: false },
      { column: "decided", ascending: false },
      { column: "approver_display_name", ascending: true },
    ],
    limit: cap,
    ...signalOpt(opts.signal),
  });
  return {
    summary: summariseApprovalBreaches(rows),
    provenance: provenance(V_APPROVAL_SLA, "client", rows.length, cap, scope, [
      "admin.hrcomp.caveat.slaAllTime",
    ]),
  };
}

export interface OwnOverdueResult {
  readonly overdue: number;
  readonly pending: number;
  readonly provenance: AnalyticsProvenance;
}

/**
 * The CALLER'S OWN overdue decisions — two `count=exact` HEADs.
 *
 * `v_approval_inbox` ends in `app.current_employee_id() = ANY
 * (ar.current_approver_ids)`, so this is one person's queue and there is no
 * org-wide equivalent anywhere in the schema (workflow-admin.api §1 documents
 * the same gap). It is included because "you personally are sitting on three
 * overdue approvals" is the most actionable line on a compliance panel, and it
 * is labelled as yours so nobody reads it as the organisation's.
 *
 * `is_overdue` is Postgres's `now() > sla_due_at`, evaluated server-side. The
 * browser clock never decides whether something is late.
 */
export async function fetchOwnOverdueApprovals(
  opts: ComplianceFetchOptions = {},
): Promise<OwnOverdueResult> {
  const o = signalOpt(opts.signal);
  const [overdue, pending] = await Promise.all([
    selectCount(V_APPROVAL_INBOX, [isTrue("is_overdue")], o),
    selectCount(V_APPROVAL_INBOX, [], o),
  ]);
  return {
    overdue,
    pending,
    provenance: {
      relation: V_APPROVAL_INBOX,
      computedBy: "server",
      rowsScanned: pending,
      rowCap: NO_ROW_CAP,
      truncated: false,
      caveats: ["admin.hrcomp.caveat.ownQueueOnly"],
    },
  };
}

// =============================================================================
// 6. Open exceptions — v_exception_queue
// =============================================================================

/**
 * The period is NOT applied. `ist_date` on this view is the date the exception
 * is ABOUT, and four of its eight branches stamp `util.ist_today()` because they
 * describe a state rather than a day (a missing bank account, an offline kiosk).
 * Narrowing to a past period would therefore hide half the queue and age out the
 * other half — an OPEN exception is open now, whatever date it carries.
 */
const EXCEPTION_SUPPORT: DimensionSupport = { employeeColumn: "employee_id" };

export interface ExceptionResult {
  readonly summary: ExceptionSummary;
  readonly provenance: AnalyticsProvenance;
}

/**
 * The morning list: an exact total from Postgres plus a capped page to bucket.
 *
 * The two are deliberately different reads. `total` is the truth even when the
 * page is capped, so a growing problem cannot plateau at 300 and look stable
 * (DR-29); `scanned` says how much of it the breakdown describes.
 */
export async function fetchOpenExceptions(
  filters: AnalyticsFilters,
  opts: ComplianceFetchOptions = {},
): Promise<ExceptionResult> {
  const scope = scopeFor(filters, EXCEPTION_SUPPORT);
  const cap = opts.limit ?? EXCEPTION_ROW_CAP;
  const [rows, total] = await Promise.all([
    selectMany(V_EXCEPTION_QUEUE, exceptionRowSchema, {
      filters: scope.filters,
      // Severity is text, so it cannot be ordered by rank server-side; newest
      // first is the honest fallback and the client buckets by severity anyway.
      order: [{ column: "occurred_at", ascending: false }],
      limit: cap,
      ...signalOpt(opts.signal),
    }),
    selectCount(V_EXCEPTION_QUEUE, scope.filters, signalOpt(opts.signal)),
  ]);
  const typed: readonly ExceptionRow[] = rows;
  return {
    summary: groupExceptions(typed, total),
    provenance: provenance(V_EXCEPTION_QUEUE, "client", rows.length, cap, scope),
  };
}

// =============================================================================
// 7. Statutory coverage, completeness, biometric stamps — v_admin_employee
// =============================================================================

const WORKFORCE_SUPPORT: DimensionSupport = {
  departmentColumn: "department_id",
  locationColumn: "location_id",
  employeeColumn: "id",
};

/**
 * The narrow projection. `v_admin_employee` is `employees.*` plus a dozen joined
 * labels — selecting `*` here would put every column of every employee on the
 * wire to count four booleans.
 */
const WORKFORCE_COLUMNS = [
  "id",
  "employee_code",
  "display_name",
  "department_name",
  "employment_status",
  "exclude_from_payroll",
  "exclude_from_attendance",
  "pf_applicable",
  "esi_applicable",
  "professional_tax_applicable",
  "lwf_applicable",
  "tax_regime",
  "profile_completeness_pct",
  "face_enrolled_at",
  "fingerprint_enrolled_at",
].join(",");

/**
 * The four applicability flags and `tax_regime` are `NOT NULL` on
 * `employee_statutory` but NULLABLE here — `v_admin_employee` reaches them
 * through a LEFT JOIN, so an employee with no statutory row yields NULL on all
 * five. That third state is counted separately by the aggregate; it is not a
 * schema drift and must not parse as one.
 *
 * `profile_completeness_pct` is `numeric(6,3)`, so it is read as a NUMERIC and
 * not as an integer: a real value of 62.500 would fail an integer schema and
 * take the whole panel down with a parse error.
 */
const workforceRowSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  department_name: z.string().nullable(),
  employment_status: employmentStatusSchema,
  exclude_from_payroll: z.boolean(),
  exclude_from_attendance: z.boolean(),
  pf_applicable: z.boolean().nullable(),
  esi_applicable: z.boolean().nullable(),
  professional_tax_applicable: z.boolean().nullable(),
  lwf_applicable: z.boolean().nullable(),
  tax_regime: z.string().nullable(),
  profile_completeness_pct: dbNumericNullable,
  face_enrolled_at: dbTimestampNullable,
  fingerprint_enrolled_at: dbTimestampNullable,
});

export interface WorkforceComplianceResult {
  readonly summary: WorkforceComplianceSummary;
  readonly provenance: AnalyticsProvenance;
}

/**
 * One read, four measures: statutory applicability, tax regime, profile
 * completeness and the biometric enrolment stamps.
 *
 * Filtered to {@link COMPLIANCE_POPULATION_STATUSES} and to live rows, which is
 * the SAME predicate `v_document_compliance` and `v_enrolment_coverage` apply
 * internally — so "214 people" means the same 214 in every section of the panel.
 * `v_admin_employee` deliberately shows soft-deleted rows to admins (the Archive
 * console needs them, migration 051), hence the explicit `deleted_at IS NULL`.
 */
export async function fetchWorkforceCompliance(
  filters: AnalyticsFilters,
  opts: ComplianceFetchOptions = {},
): Promise<WorkforceComplianceResult> {
  const scope = scopeFor(filters, WORKFORCE_SUPPORT, [
    isNull("deleted_at"),
    inList("employment_status", COMPLIANCE_POPULATION_STATUSES),
  ]);
  const cap = opts.limit ?? WORKFORCE_ROW_CAP;
  const rows = await selectMany(V_ADMIN_EMPLOYEE, workforceRowSchema, {
    columns: WORKFORCE_COLUMNS,
    filters: scope.filters,
    order: [{ column: "employee_code", ascending: true }],
    limit: cap,
    ...signalOpt(opts.signal),
  });
  const typed: readonly WorkforceRow[] = rows;
  return {
    summary: summariseWorkforceCompliance(typed),
    provenance: provenance(V_ADMIN_EMPLOYEE, "client", rows.length, cap, scope, [
      // The stamp on employees.face_enrolled_at and v_enrolment_coverage's test
      // of a LIVE template plus a LIVE consent are different facts, and a
      // withdrawn consent leaves the stamp behind. Both are shown; neither is
      // reconciled into the other.
      "admin.hrcomp.caveat.stampNotTemplate",
    ]),
  };
}

// =============================================================================
// 8. Asset custody × employment status — the cross-relation join
// =============================================================================

/**
 * `v_asset_custody` selects `er.department_name` from `v_employee_ref` but no
 * `department_id`, so a department FILTER cannot be applied to it — the closed
 * `Filter` vocabulary is id-based on purpose and matching on a renameable label
 * would be the wrong kind of clever.
 */
const CUSTODY_SUPPORT: DimensionSupport = { employeeColumn: "employee_id" };

const CUSTODY_COLUMNS = [
  "allocation_id",
  "allocation_number",
  "asset_tag",
  "asset_name",
  "employee_id",
  "employee_code",
  "display_name",
  "department_name",
  "status",
  "days_in_custody",
  "expected_return_date",
  "is_return_overdue",
].join(",");

/**
 * The narrowed read parsed against exactly the columns it asked for.
 *
 * `custodyRowSchema` describes the WHOLE view — asset_id, serial number,
 * condition, quantity and three timestamps this panel never shows — and every
 * one of those keys is required. Parsing a 12-column projection against it fails
 * on the first row with a schema error, which would present as "asset custody is
 * broken" rather than as the column list being short. `.pick()` keeps ONE source
 * of truth for the column types (assets.api owns them) while describing what was
 * actually selected, and dropping a key here breaks the aggregate's `CustodyLike`
 * at compile time instead of at 9am.
 */
const custodyProjectionSchema = custodyRowSchema.pick({
  allocation_id: true,
  allocation_number: true,
  asset_tag: true,
  asset_name: true,
  employee_id: true,
  employee_code: true,
  display_name: true,
  department_name: true,
  status: true,
  days_in_custody: true,
  expected_return_date: true,
  is_return_overdue: true,
});

/** Just enough of `v_admin_employee` to answer "has this person left". */
const holderStateSchema = z.object({
  id: dbUuid,
  employment_status: employmentStatusSchema,
  last_working_day: dbDateNullable,
});

export interface CustodyResult {
  readonly summary: CustodySummary;
  readonly provenance: AnalyticsProvenance;
}

/**
 * Open allocations, each tagged with whether its holder has left.
 *
 * TWO READS, ON PURPOSE. `v_asset_custody` has no employment status (verified:
 * migration 037 §7 projects `employee_code`, `display_name` and
 * `department_name` from `v_employee_ref`, and stops there), so the ids are
 * collected from the first read and their statuses fetched by id in the second.
 * That is the join the data supports.
 *
 * An id the second read does not return is `unknown`, NEVER `current`:
 * `v_admin_employee` also applies `app.admin_scope_covers()`, so a
 * department-scoped admin simply cannot see some holders — and quietly calling
 * those "still employed" would suppress precisely the finding this exists for.
 */
export async function fetchAssetCustody(
  filters: AnalyticsFilters,
  opts: ComplianceFetchOptions = {},
): Promise<CustodyResult> {
  const scope = scopeFor(filters, CUSTODY_SUPPORT);
  const cap = opts.limit ?? CUSTODY_ROW_CAP;
  const o = signalOpt(opts.signal);

  const [rows, open] = await Promise.all([
    selectMany(V_ASSET_CUSTODY, custodyProjectionSchema, {
      columns: CUSTODY_COLUMNS,
      filters: scope.filters,
      // Longest held first: a capped page keeps the oldest debts, which are the
      // ones most likely to belong to somebody who has already gone.
      order: [{ column: "allocated_at", ascending: true, nullsFirst: true }],
      limit: cap,
      ...o,
    }),
    selectCount(V_ASSET_CUSTODY, scope.filters, o),
  ]);

  if (rows.length === 0) {
    return {
      summary: { ...EMPTY_CUSTODY, open, partial: open > 0 },
      provenance: provenance(V_ASSET_CUSTODY, "client", 0, cap, scope),
    };
  }

  const ids = [...new Set(rows.map((r) => r.employee_id))];
  const capped = ids.length > CUSTODY_HOLDER_ID_CAP;
  const lookupIds = capped ? ids.slice(0, CUSTODY_HOLDER_ID_CAP) : ids;

  const holderRows = await selectMany(V_ADMIN_EMPLOYEE, holderStateSchema, {
    columns: "id, employment_status, last_working_day",
    filters: [inList("id", lookupIds)],
    limit: CUSTODY_HOLDER_ID_CAP,
    ...o,
  });
  const holders = new Map<string, HolderState>();
  for (const h of holderRows) {
    holders.set(h.id, {
      employment_status: h.employment_status,
      last_working_day: h.last_working_day,
    });
  }

  return {
    summary: joinCustodyHolders(rows, holders, open),
    provenance: provenance(
      V_ASSET_CUSTODY,
      "client",
      rows.length,
      cap,
      scope,
      capped ? ["admin.hrcomp.caveat.holderIdsCapped"] : [],
    ),
  };
}
