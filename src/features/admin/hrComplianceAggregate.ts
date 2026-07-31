/**
 * hrComplianceAggregate.ts — every figure the Compliance & Operations panel
 * prints, computed in one module that imports no network client, no clock and no
 * locale. Same quarantine, and same reasons, as `analyticsAggregate.ts`.
 *
 * WHY ANY ARITHMETIC HAPPENS HERE AT ALL
 * --------------------------------------
 * Most of this panel's tiles are `count=exact` HEADs — Postgres counts, the
 * client prints. Three things genuinely cannot be:
 *
 *   1. POOLING A RATE ACROSS ROWS. `v_kiosk_health.match_success_pct` exists per
 *      (device × day) and `v_approval_sla.on_time_pct` per (approver × request
 *      type). There is no org-wide row for either, PostgREST cannot GROUP BY, and
 *      a ratio cannot be summed. So the pooled rate is rebuilt from the two COUNT
 *      columns the view already publishes — Σmatched / Σtotal_attempts — never by
 *      averaging the percentages. Those two answers differ, sometimes wildly: a
 *      tablet that saw four attempts and matched one drags a mean of percentages
 *      down by 25 points and the pooled rate by nothing.
 *   2. BUCKETING. Gap kinds, exception kinds and completeness bands are GROUP BYs
 *      the wire cannot express in one round trip.
 *   3. A CROSS-RELATION JOIN. "Which assets are held by people who have left"
 *      needs `v_asset_custody` (no employment status) beside `v_admin_employee`
 *      (has it). See {@link joinCustodyHolders}.
 *
 * THE THREE RULES EVERY FUNCTION BELOW OBEYS
 * ------------------------------------------
 *   * A SHARE IS A {@link Ratio}, never a bare number. Numerator and denominator
 *     travel with it so a screen is physically able to print "9 of 214" beside
 *     the percentage, and `pct` is `null` — not `0` — when the denominator is
 *     empty. Nothing here divides without going through `ratioOf`.
 *   * A DENOMINATOR IS NAMED AND IS NOT ALWAYS THE ROW COUNT. PF applicability is
 *     counted over the PAYROLL population; biometric stamps over the ATTENDANCE
 *     population; a statutory flag that is NULL (no `employee_statutory` row
 *     through the LEFT JOIN) is `notRecorded` and is excluded from the
 *     denominator, because "we never recorded it" is not "it does not apply".
 *   * AN UNRECOGNISED VALUE IS COUNTED, NEVER DROPPED. Every bucketing function
 *     keeps an `unclassified`/`other` bucket. If a view gains a CASE arm after
 *     this file was written, the panel under-reports visibly instead of silently.
 */
import { meanIgnoringNulls } from "./analyticsAggregate";

// -----------------------------------------------------------------------------
// Ratio — the one way this module divides
// -----------------------------------------------------------------------------

/**
 * A share that cannot be printed without its denominator.
 *
 * `pct` is on the 0–100 scale (the repo's `_pct` convention, so `formatPercent`
 * appends '%' and never multiplies again), and is `null` for an empty
 * denominator. Returning 0 there is the lie this type exists to prevent: "0% of
 * documents are valid" and "no document is required of anybody" are opposite
 * findings.
 */
export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  /** numerator ÷ denominator × 100, or null when the denominator is zero. */
  readonly pct: number | null;
}

export const EMPTY_RATIO: Ratio = { numerator: 0, denominator: 0, pct: null };

export function ratioOf(numerator: number, denominator: number): Ratio {
  if (denominator === 0) return { numerator, denominator: 0, pct: null };
  return { numerator, denominator, pct: (numerator / denominator) * 100 };
}

/** Count of `true` in a list of tri-state flags, with the nulls kept separate. */
interface TriState {
  yes: number;
  no: number;
  unknown: number;
}

function newTriState(): TriState {
  return { yes: 0, no: 0, unknown: 0 };
}

function addTriState(acc: TriState, value: boolean | null | undefined): void {
  if (value === null || value === undefined) acc.unknown += 1;
  else if (value) acc.yes += 1;
  else acc.no += 1;
}

/** Ordinal, locale-independent — a panel must sort the same in every browser. */
function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

export interface CountBucket {
  /** The server's own value ('critical', 'no_consent', 'old'). Never a label. */
  readonly key: string;
  readonly count: number;
}

/**
 * Bucket a list by a string key, emitting the keys in `order` FIRST (including
 * the ones that counted zero) and anything unexpected after, biggest first.
 *
 * Zero buckets are kept on purpose: a compliance panel where "critical" silently
 * disappears the moment it reaches zero teaches the reader nothing, and the day
 * it comes back the layout moves. Unexpected keys are kept for the reason in the
 * module header.
 */
function bucketByKey(
  values: readonly (string | null)[],
  order: readonly string[],
  unknownKey: string,
): CountBucket[] {
  const counts = new Map<string, number>();
  for (const key of order) counts.set(key, 0);
  for (const raw of values) {
    const key = raw === null || raw === "" ? unknownKey : raw;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const known: CountBucket[] = order.map((key) => ({ key, count: counts.get(key) ?? 0 }));
  const extra: CountBucket[] = [];
  for (const [key, count] of counts) {
    if (!order.includes(key)) extra.push({ key, count });
  }
  extra.sort((a, b) => (b.count !== a.count ? b.count - a.count : compareText(a.key, b.key)));
  return [...known, ...extra];
}

// =============================================================================
// 1. Document compliance — v_document_compliance, counted by Postgres
// =============================================================================

/**
 * Four `count=exact` HEADs over `v_document_compliance.compliance_status`, plus
 * a fifth with NO status predicate.
 *
 * The fifth is not redundant. It is the CHECK: the view's CASE has four arms
 * today, so the four must add up to it. `unclassified` below is the difference,
 * and a non-zero value means the deployed SQL grew an arm this panel does not
 * know about — which is worth seeing rather than absorbing.
 */
export interface DocumentComplianceCounts {
  readonly missing: number;
  readonly expired: number;
  readonly expiringSoon: number;
  readonly valid: number;
  /** The same predicate with no `compliance_status` narrowing. */
  readonly requirements: number;
}

export interface DocumentComplianceSummary {
  readonly missing: number;
  readonly expired: number;
  readonly expiringSoon: number;
  readonly valid: number;
  /** Employee × required-document-type pairs in scope. THE denominator. */
  readonly requirements: number;
  /** valid ÷ requirements. The one honest "how compliant are we" figure. */
  readonly complete: Ratio;
  /** Everything that is not valid — the size of the work, not a percentage. */
  readonly actionable: number;
  /** requirements − (the four arms). Non-zero = the view drifted. See above. */
  readonly unclassified: number;
}

export const EMPTY_DOCUMENT_COMPLIANCE: DocumentComplianceSummary = {
  missing: 0,
  expired: 0,
  expiringSoon: 0,
  valid: 0,
  requirements: 0,
  complete: EMPTY_RATIO,
  actionable: 0,
  unclassified: 0,
};

export function summariseDocumentCompliance(
  counts: DocumentComplianceCounts,
): DocumentComplianceSummary {
  const classified = counts.missing + counts.expired + counts.expiringSoon + counts.valid;
  return {
    missing: counts.missing,
    expired: counts.expired,
    expiringSoon: counts.expiringSoon,
    valid: counts.valid,
    requirements: counts.requirements,
    complete: ratioOf(counts.valid, counts.requirements),
    actionable: counts.missing + counts.expired + counts.expiringSoon,
    // Clamped at zero: a NEGATIVE difference would mean the four narrowed counts
    // exceeded the unnarrowed one, which can only happen if the five HEADs raced
    // a write. Reporting that as "-3 unclassified" is noise; the honest signal is
    // the positive case, where an arm exists that this panel cannot name.
    unclassified: Math.max(0, counts.requirements - classified),
  };
}

// =============================================================================
// 2. Policy acknowledgement — v_policy_acknowledgement_status
// =============================================================================

/**
 * One row per policy DOCUMENT. Every column is a Postgres count except
 * `acknowledged_pct`, which the view already computed AT THIS GRAIN.
 */
export interface PolicyAckRow {
  readonly document_id: string;
  readonly document_title: string;
  readonly document_type_name: string;
  readonly assigned: number;
  readonly opened: number;
  readonly acknowledged: number;
  readonly waived: number;
  readonly overdue: number;
  readonly acknowledged_pct: number | null;
  readonly earliest_open_due_on: string | null;
}

export interface PolicyAckSummary {
  /** Policies requiring acknowledgement that the caller can see. */
  readonly policies: number;
  /** Policies with at least one assignee — the only ones that HAVE a rate. */
  readonly policiesWithAssignees: number;
  readonly assigned: number;
  readonly opened: number;
  readonly acknowledged: number;
  readonly waived: number;
  readonly overdue: number;
  /**
   * THE acknowledgement rate: Σacknowledged ÷ Σassigned, over assignments.
   * Deliberately NOT the mean of `acknowledged_pct` — see {@link meanPolicyPct}.
   */
  readonly acknowledgedRate: Ratio;
  /**
   * The mean of the per-policy percentages, reported BESIDE the pooled rate
   * rather than instead of it. One policy assigned to two people at 0% weighs
   * the same as one assigned to two hundred at 100% here, and it does not there.
   * When the two disagree the gap is the story, so both are shown.
   */
  readonly meanPolicyPct: number | null;
  /** Assigned, neither acknowledged nor waived — the size of the chase list. */
  readonly outstanding: number;
  /** Worst acknowledged share first. Policies with no assignee sort last. */
  readonly worst: readonly PolicyAckRow[];
}

export const EMPTY_POLICY_ACK: PolicyAckSummary = {
  policies: 0,
  policiesWithAssignees: 0,
  assigned: 0,
  opened: 0,
  acknowledged: 0,
  waived: 0,
  overdue: 0,
  acknowledgedRate: EMPTY_RATIO,
  meanPolicyPct: null,
  outstanding: 0,
  worst: [],
};

export function summarisePolicyAcknowledgement(
  rows: readonly PolicyAckRow[],
): PolicyAckSummary {
  if (rows.length === 0) return EMPTY_POLICY_ACK;

  let assigned = 0;
  let opened = 0;
  let acknowledged = 0;
  let waived = 0;
  let overdue = 0;
  let withAssignees = 0;
  const pcts: (number | null)[] = [];

  for (const row of rows) {
    assigned += row.assigned;
    opened += row.opened;
    acknowledged += row.acknowledged;
    waived += row.waived;
    overdue += row.overdue;
    if (row.assigned > 0) {
      withAssignees += 1;
      // Only a policy somebody was actually assigned has a percentage to average.
      // The view returns NULL there anyway (NULLIF on the denominator); this
      // guard means a future non-null zero cannot creep into the mean either.
      pcts.push(row.acknowledged_pct);
    }
  }

  const worst = [...rows].sort((a, b) => {
    const aHas = a.assigned > 0;
    const bHas = b.assigned > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    const ap = a.acknowledged_pct ?? 0;
    const bp = b.acknowledged_pct ?? 0;
    if (ap !== bp) return ap - bp;
    // Tiebreak on the number of people still owing, then on the title, so the
    // order is stable across renders and across browsers.
    const aOwing = a.assigned - a.acknowledged - a.waived;
    const bOwing = b.assigned - b.acknowledged - b.waived;
    if (aOwing !== bOwing) return bOwing - aOwing;
    return compareText(a.document_title, b.document_title);
  });

  return {
    policies: rows.length,
    policiesWithAssignees: withAssignees,
    assigned,
    opened,
    acknowledged,
    waived,
    overdue,
    acknowledgedRate: ratioOf(acknowledged, assigned),
    meanPolicyPct: meanIgnoringNulls(pcts),
    // Never negative: `waived` and `acknowledged` are disjoint status filters in
    // the view, but a race between the counts is cheaper to clamp than to explain.
    outstanding: Math.max(0, assigned - acknowledged - waived),
    worst,
  };
}

// =============================================================================
// 3. Biometric coverage — v_enrolment_coverage (GAP ROWS ONLY)
// =============================================================================

/**
 * `v_enrolment_coverage.gap_kind`, in the order the panel presents them: the two
 * that are chaseable first, the lawful one last.
 *
 * Taken from the view's own CASE (migration 037 §2) rather than re-derived from
 * `has_active_consent` / `has_active_template`. The view already decided that a
 * withdrawn consent outranks a missing template, and two places deciding that
 * independently is how a person gets chased for a choice they were entitled to
 * make (§5.10).
 */
export const ENROLMENT_GAP_ORDER = [
  "no_consent",
  "consented_not_enrolled",
  "consent_withdrawn",
] as const;

export type EnrolmentGapKind = (typeof ENROLMENT_GAP_ORDER)[number];

/** gap_kind values that are somebody's to action. A withdrawal is not. */
const CHASEABLE_GAPS: readonly string[] = ["no_consent", "consented_not_enrolled"];

export const GAP_KIND_UNKNOWN = "unclassified";

export interface EnrolmentGapRow {
  readonly employee_id: string;
  readonly employee_code: string;
  readonly display_name: string;
  readonly department_name: string | null;
  /** Null for a joiner with no agreed start date — the column allows it. */
  readonly date_of_join: string | null;
  readonly gap_kind: string | null;
}

export interface EnrolmentGapSummary {
  /** How many gap rows Postgres holds — `count=exact`, not the page length. */
  readonly total: number;
  /** How many rows the breakdown below was computed over. */
  readonly scanned: number;
  /** scanned < total: the buckets describe a prefix of the queue, not all of it. */
  readonly partial: boolean;
  readonly byKind: readonly CountBucket[];
  /** no_consent + consented_not_enrolled — the list somebody works through. */
  readonly chaseable: number;
  /** consent_withdrawn — a lawful choice. Counted, never chased, never toned red. */
  readonly withdrawn: number;
  /** gap_kind NULL or a value this file does not know. Never silently dropped. */
  readonly unclassified: number;
  readonly rows: readonly EnrolmentGapRow[];
}

export const EMPTY_ENROLMENT_GAPS: EnrolmentGapSummary = {
  total: 0,
  scanned: 0,
  partial: false,
  byKind: ENROLMENT_GAP_ORDER.map((key) => ({ key, count: 0 })),
  chaseable: 0,
  withdrawn: 0,
  unclassified: 0,
  rows: [],
};

/**
 * The gap list bucketed by the view's own `gap_kind`.
 *
 * NOTE THE MISSING MEASURE: there is no coverage PERCENTAGE here, and that is
 * deliberate. The view's predicate is `(no active consent OR no active
 * template)`, so a fully enrolled employee is not a row in it — it can count
 * gaps and can never produce "x% of the workforce is covered". Dividing this
 * count by a headcount from `v_admin_employee` would be a ratio of two different
 * populations: `v_enrolment_coverage` is gated on `app.is_admin()` alone while
 * `v_admin_employee` additionally applies `app.admin_scope_covers()`, so for a
 * department-scoped admin the numerator is wider than the denominator and the
 * "percentage" can exceed 100. The panel prints the gap counts and says so.
 */
export function groupEnrolmentGaps(
  rows: readonly EnrolmentGapRow[],
  total: number,
): EnrolmentGapSummary {
  const byKind = bucketByKey(
    rows.map((r) => r.gap_kind),
    ENROLMENT_GAP_ORDER,
    GAP_KIND_UNKNOWN,
  );

  let chaseable = 0;
  let withdrawn = 0;
  let unclassified = 0;
  for (const bucket of byKind) {
    if (CHASEABLE_GAPS.includes(bucket.key)) chaseable += bucket.count;
    else if (bucket.key === "consent_withdrawn") withdrawn += bucket.count;
    else unclassified += bucket.count;
  }

  return {
    total,
    scanned: rows.length,
    partial: rows.length < total,
    byKind,
    chaseable,
    withdrawn,
    unclassified,
    rows,
  };
}

// =============================================================================
// 4. Gate health — v_kiosk_health (one row per device per IST day)
// =============================================================================

export interface KioskHealthRow {
  readonly kiosk_device_id: string;
  readonly device_code: string;
  readonly label: string;
  readonly ist_date: string;
  readonly total_attempts: number;
  readonly matched: number;
  readonly no_match: number;
  readonly ambiguous: number;
  readonly liveness_failures: number;
  readonly capture_failures: number;
  readonly errors: number;
  readonly duplicates_suppressed: number;
  /** The view's own matched × 100 / total_attempts, AT THIS ROW'S GRAIN. */
  readonly match_success_pct: number | null;
  readonly p50_latency_ms: number | null;
  readonly p95_latency_ms: number | null;
  readonly offline_replays: number;
  readonly is_active: boolean;
}

/** An observed extreme, carrying the device-day it was observed on. */
export interface LatencyPeak {
  readonly ms: number;
  readonly deviceCode: string;
  readonly istDate: string;
}

/**
 * A device-day is only ranked by match rate once it has seen this many attempts.
 *
 * Without a floor the worst-performing tablet in the venue is always whichever
 * one somebody tested once and walked away from: 0 of 1 is 0.00%, and it will
 * outrank a gate that failed 40 of 400. The excluded rows are counted
 * ({@link GateHealthSummary.lowVolumeDeviceDays}) rather than hidden.
 */
export const MIN_ATTEMPTS_FOR_RANKING = 10;

export interface GateHealthSummary {
  readonly deviceDays: number;
  readonly devices: number;
  /** Devices flagged `is_active = false` that still logged attempts in the window. */
  readonly inactiveDevices: number;
  readonly attempts: number;
  readonly matched: number;
  /**
   * POOLED over every attempt in the window: Σmatched ÷ Σtotal_attempts. This is
   * the only org-wide match rate the schema can support, and it is NOT the mean
   * of `match_success_pct` — see the module header.
   */
  readonly matchRate: Ratio;
  readonly noMatch: number;
  readonly ambiguous: number;
  readonly livenessFailures: number;
  readonly captureFailures: number;
  readonly errors: number;
  readonly duplicatesSuppressed: number;
  /** Punches the tablet buffered offline and replayed later. Summed, not averaged. */
  readonly offlineReplays: number;
  /**
   * The single worst device-day p95 — an OBSERVED value from one row, not a
   * percentile of the window. Percentiles do not pool: there is no arithmetic
   * that turns a set of per-day p95s into the p95 of the period, and the raw
   * latency series lives in `secure.face_match_log`, which this panel cannot read.
   */
  readonly worstP95: LatencyPeak | null;
  readonly worstP50: LatencyPeak | null;
  /**
   * Mean of the per-device-day p95 COLUMN, over the device-days that reported
   * one. Labelled as exactly that on screen — it is a summary of a column of
   * percentiles, and calling it "the p95" would be false.
   */
  readonly meanDeviceDayP95Ms: number | null;
  readonly p95Samples: number;
  readonly meanDeviceDayP50Ms: number | null;
  readonly p50Samples: number;
  /** Worst match rate first, among device-days above the volume floor. */
  readonly worstDeviceDays: readonly KioskHealthRow[];
  readonly lowVolumeDeviceDays: number;
}

export const EMPTY_GATE_HEALTH: GateHealthSummary = {
  deviceDays: 0,
  devices: 0,
  inactiveDevices: 0,
  attempts: 0,
  matched: 0,
  matchRate: EMPTY_RATIO,
  noMatch: 0,
  ambiguous: 0,
  livenessFailures: 0,
  captureFailures: 0,
  errors: 0,
  duplicatesSuppressed: 0,
  offlineReplays: 0,
  worstP95: null,
  worstP50: null,
  meanDeviceDayP95Ms: null,
  p95Samples: 0,
  meanDeviceDayP50Ms: null,
  p50Samples: 0,
  worstDeviceDays: [],
  lowVolumeDeviceDays: 0,
};

function peakOf(current: LatencyPeak | null, row: KioskHealthRow, ms: number | null): LatencyPeak | null {
  if (ms === null || !Number.isFinite(ms)) return current;
  if (current !== null && current.ms >= ms) return current;
  return { ms, deviceCode: row.device_code, istDate: row.ist_date };
}

export function summariseGateHealth(rows: readonly KioskHealthRow[]): GateHealthSummary {
  if (rows.length === 0) return EMPTY_GATE_HEALTH;

  const devices = new Set<string>();
  const inactive = new Set<string>();
  let attempts = 0;
  let matched = 0;
  let noMatch = 0;
  let ambiguous = 0;
  let liveness = 0;
  let capture = 0;
  let errors = 0;
  let duplicates = 0;
  let replays = 0;
  let worstP95: LatencyPeak | null = null;
  let worstP50: LatencyPeak | null = null;
  const p95s: (number | null)[] = [];
  const p50s: (number | null)[] = [];

  for (const row of rows) {
    devices.add(row.kiosk_device_id);
    if (!row.is_active) inactive.add(row.kiosk_device_id);
    attempts += row.total_attempts;
    matched += row.matched;
    noMatch += row.no_match;
    ambiguous += row.ambiguous;
    liveness += row.liveness_failures;
    capture += row.capture_failures;
    errors += row.errors;
    duplicates += row.duplicates_suppressed;
    // One row per (device, day) — the view's GROUP BY guarantees it — so the
    // lateral's replay count is added once per device-day, never doubled.
    replays += row.offline_replays;
    worstP95 = peakOf(worstP95, row, row.p95_latency_ms);
    worstP50 = peakOf(worstP50, row, row.p50_latency_ms);
    p95s.push(row.p95_latency_ms);
    p50s.push(row.p50_latency_ms);
  }

  const ranked = rows.filter((r) => r.total_attempts >= MIN_ATTEMPTS_FOR_RANKING);
  const worstDeviceDays = [...ranked].sort((a, b) => {
    const ap = a.match_success_pct ?? 0;
    const bp = b.match_success_pct ?? 0;
    if (ap !== bp) return ap - bp;
    // More attempts breaks the tie: at the same rate, the busier gate is the one
    // that failed more people.
    if (a.total_attempts !== b.total_attempts) return b.total_attempts - a.total_attempts;
    return compareText(`${a.device_code}${a.ist_date}`, `${b.device_code}${b.ist_date}`);
  });

  return {
    deviceDays: rows.length,
    devices: devices.size,
    inactiveDevices: inactive.size,
    attempts,
    matched,
    matchRate: ratioOf(matched, attempts),
    noMatch,
    ambiguous,
    livenessFailures: liveness,
    captureFailures: capture,
    errors,
    duplicatesSuppressed: duplicates,
    offlineReplays: replays,
    worstP95,
    worstP50,
    meanDeviceDayP95Ms: meanIgnoringNulls(p95s),
    p95Samples: p95s.filter((v) => v !== null && Number.isFinite(v)).length,
    meanDeviceDayP50Ms: meanIgnoringNulls(p50s),
    p50Samples: p50s.filter((v) => v !== null && Number.isFinite(v)).length,
    worstDeviceDays,
    lowVolumeDeviceDays: rows.length - ranked.length,
  };
}

// =============================================================================
// 5. Approval SLA — v_approval_sla (approver × request type, DECIDED actions)
// =============================================================================

/**
 * The shape `workflow-admin.api.ts`'s `approvalSlaSchema` produces. Declared
 * structurally so this module stays free of the supabase client; the api module
 * hands its parsed rows straight in, and dropping a column there breaks the call
 * site at compile time.
 */
export interface ApprovalSlaLike {
  readonly approver_employee_id: string;
  readonly approver_employee_code: string;
  readonly approver_display_name: string;
  readonly request_type_code: string;
  readonly request_type_name: string;
  readonly decided: number;
  readonly on_time: number;
  readonly breached: number;
  readonly on_time_pct: number | null;
  readonly avg_hours_to_decide: number | null;
}

export interface RequestTypeBreach {
  readonly requestTypeCode: string;
  readonly requestTypeName: string;
  readonly decided: number;
  readonly breached: number;
  readonly breachRate: Ratio;
}

export interface ApprovalBreachSummary {
  /** Approver × request-type pairs the caller can see. Not a business figure. */
  readonly pairs: number;
  readonly approvers: number;
  /** Distinct approvers with at least one breach. The people, not the rows. */
  readonly approversBreaching: number;
  readonly decided: number;
  readonly onTime: number;
  /** THE metric. Volume without this says nothing about whether anyone waited. */
  readonly breached: number;
  /** Σbreached ÷ Σdecided, pooled over decisions. */
  readonly breachRate: Ratio;
  /**
   * The true mean decision latency, reconstructed exactly: `avg_hours_to_decide`
   * is Σhours ÷ decided at its own grain, so avg × decided recovers Σhours and
   * the weighted mean is the mean of every decision — not a mean of means, which
   * would let one approver with two decisions outweigh one with two hundred.
   */
  readonly pooledHoursToDecide: number | null;
  /** The Σdecided that the figure above was divided by. Its denominator. */
  readonly hoursBasis: number;
  /** Worst first: by breach COUNT, then by breach share. */
  readonly worst: readonly ApprovalSlaLike[];
  /** The same breaches rolled to the request type — is it the person or the process. */
  readonly byRequestType: readonly RequestTypeBreach[];
}

export const EMPTY_APPROVAL_BREACHES: ApprovalBreachSummary = {
  pairs: 0,
  approvers: 0,
  approversBreaching: 0,
  decided: 0,
  onTime: 0,
  breached: 0,
  breachRate: EMPTY_RATIO,
  pooledHoursToDecide: null,
  hoursBasis: 0,
  worst: [],
  byRequestType: [],
};

export function summariseApprovalBreaches(
  rows: readonly ApprovalSlaLike[],
): ApprovalBreachSummary {
  if (rows.length === 0) return EMPTY_APPROVAL_BREACHES;

  const approvers = new Set<string>();
  const breaching = new Set<string>();
  let decided = 0;
  let onTime = 0;
  let breached = 0;
  let weightedHours = 0;
  let hoursBasis = 0;
  const byType = new Map<string, { name: string; decided: number; breached: number }>();

  for (const row of rows) {
    approvers.add(row.approver_employee_id);
    if (row.breached > 0) breaching.add(row.approver_employee_id);
    decided += row.decided;
    onTime += row.on_time;
    breached += row.breached;

    const hours = row.avg_hours_to_decide;
    if (hours !== null && Number.isFinite(hours) && row.decided > 0) {
      weightedHours += hours * row.decided;
      hoursBasis += row.decided;
    }

    const acc = byType.get(row.request_type_code) ?? {
      name: row.request_type_name,
      decided: 0,
      breached: 0,
    };
    acc.decided += row.decided;
    acc.breached += row.breached;
    byType.set(row.request_type_code, acc);
  }

  const worst = [...rows].sort((a, b) => {
    if (a.breached !== b.breached) return b.breached - a.breached;
    // At equal breach counts the one who breached a larger SHARE of their work is
    // the more informative row — a person with 3 of 4 late, not 3 of 300.
    const aShare = a.decided === 0 ? 0 : a.breached / a.decided;
    const bShare = b.decided === 0 ? 0 : b.breached / b.decided;
    if (aShare !== bShare) return bShare - aShare;
    return compareText(a.approver_display_name, b.approver_display_name);
  });

  const byRequestType: RequestTypeBreach[] = [];
  for (const [code, acc] of byType) {
    byRequestType.push({
      requestTypeCode: code,
      requestTypeName: acc.name,
      decided: acc.decided,
      breached: acc.breached,
      breachRate: ratioOf(acc.breached, acc.decided),
    });
  }
  byRequestType.sort((a, b) =>
    a.breached !== b.breached
      ? b.breached - a.breached
      : compareText(a.requestTypeName, b.requestTypeName),
  );

  return {
    pairs: rows.length,
    approvers: approvers.size,
    approversBreaching: breaching.size,
    decided,
    onTime,
    breached,
    breachRate: ratioOf(breached, decided),
    pooledHoursToDecide: hoursBasis === 0 ? null : weightedHours / hoursBasis,
    hoursBasis,
    worst,
    byRequestType,
  };
}

// =============================================================================
// 6. Open exceptions — v_exception_queue
// =============================================================================

/** `v_exception_queue.severity`, in the order the morning list is worked. */
export const EXCEPTION_SEVERITY_ORDER = ["critical", "warning", "info"] as const;

export const SEVERITY_UNKNOWN = "unclassified";

export interface ExceptionLike {
  readonly exception_kind: string;
  readonly severity: string;
  readonly employee_id: string | null;
  readonly ist_date: string | null;
  readonly description: string;
  readonly occurred_at: string;
}

export interface ExceptionSummary {
  /** Postgres's `count=exact` over the SAME predicate. The true size of the queue. */
  readonly total: number;
  /** Rows the breakdown was computed over — the capped page. */
  readonly scanned: number;
  /** scanned < total: the buckets are a sample and the screen must say so. */
  readonly partial: boolean;
  readonly critical: number;
  readonly bySeverity: readonly CountBucket[];
  /** Biggest first — which KIND of thing is going wrong. */
  readonly byKind: readonly CountBucket[];
  /**
   * Distinct employees named by an exception. Some kinds (`kiosk_offline`) carry
   * a NULL employee, so this is strictly ≤ `scanned` and is not a headcount.
   */
  readonly employeesAffected: number;
}

export const EMPTY_EXCEPTIONS: ExceptionSummary = {
  total: 0,
  scanned: 0,
  partial: false,
  critical: 0,
  bySeverity: EXCEPTION_SEVERITY_ORDER.map((key) => ({ key, count: 0 })),
  byKind: [],
  employeesAffected: 0,
};

export function groupExceptions(
  rows: readonly ExceptionLike[],
  total: number,
): ExceptionSummary {
  const bySeverity = bucketByKey(
    rows.map((r) => r.severity),
    EXCEPTION_SEVERITY_ORDER,
    SEVERITY_UNKNOWN,
  );
  // No fixed order for kinds: the view unions eight of them today and will union
  // more, so they are ranked by size rather than pinned to a list this file
  // would have to keep in step with the SQL.
  const byKind = bucketByKey(rows.map((r) => r.exception_kind), [], SEVERITY_UNKNOWN);

  const employees = new Set<string>();
  for (const row of rows) if (row.employee_id !== null) employees.add(row.employee_id);

  return {
    total,
    scanned: rows.length,
    partial: rows.length < total,
    critical: bySeverity.find((b) => b.key === "critical")?.count ?? 0,
    bySeverity,
    byKind,
    employeesAffected: employees.size,
  };
}

// =============================================================================
// 7. Statutory coverage, profile completeness, biometric stamps — v_admin_employee
// =============================================================================

/**
 * The narrow projection of `v_admin_employee` this panel reads.
 *
 * The four applicability flags are `NOT NULL` on `employee_statutory` but arrive
 * NULLABLE here: `v_admin_employee` reaches them through a LEFT JOIN, so an
 * employee with no statutory row at all yields NULL on every one of them. That
 * third state is the whole reason {@link FlagCoverage} exists — printing "PF: 12
 * of 200" when 60 of the 200 have never had a statutory record created is a
 * compliance report that hides the actual finding.
 */
export interface WorkforceRow {
  readonly id: string;
  readonly employee_code: string;
  readonly display_name: string;
  readonly department_name: string | null;
  readonly employment_status: string;
  readonly exclude_from_payroll: boolean;
  readonly exclude_from_attendance: boolean;
  readonly pf_applicable: boolean | null;
  readonly esi_applicable: boolean | null;
  readonly professional_tax_applicable: boolean | null;
  readonly lwf_applicable: boolean | null;
  readonly tax_regime: string | null;
  readonly profile_completeness_pct: number | null;
  readonly face_enrolled_at: string | null;
  readonly fingerprint_enrolled_at: string | null;
}

export const STATUTORY_FLAGS = ["pf", "esi", "pt", "lwf"] as const;
export type StatutoryFlag = (typeof STATUTORY_FLAGS)[number];

export interface FlagCoverage {
  readonly code: StatutoryFlag;
  readonly applicable: number;
  readonly notApplicable: number;
  /** No `employee_statutory` row — a NULL through the LEFT JOIN, NOT a 'false'. */
  readonly notRecorded: number;
  /**
   * applicable ÷ (applicable + notApplicable). `notRecorded` is deliberately OUT
   * of the denominator: including it would report an unfiled employee as
   * "not applicable", which is the opposite of a compliance finding.
   */
  readonly share: Ratio;
}

/** `employee_statutory.tax_regime` — CHECK-constrained to these two. */
export const TAX_REGIMES = ["old", "new"] as const;
export const TAX_REGIME_UNKNOWN = "not_recorded";

/**
 * Completeness bands, lower bound inclusive, upper bound exclusive except the
 * last. Chosen so the two bands anybody acts on are their own bucket: below 50
 * is an unusable record, and 100 is done.
 */
export const COMPLETENESS_BANDS = [
  { key: "under50", min: 0, maxExclusive: 50 },
  { key: "b50to74", min: 50, maxExclusive: 75 },
  { key: "b75to89", min: 75, maxExclusive: 90 },
  { key: "b90to99", min: 90, maxExclusive: 100 },
  { key: "complete", min: 100, maxExclusive: Number.POSITIVE_INFINITY },
] as const;

export type CompletenessBandKey = (typeof COMPLETENESS_BANDS)[number]["key"];

export const COMPLETENESS_UNKNOWN = "not_recorded";

export interface WorkforceComplianceSummary {
  /** Rows read. Every denominator below is a NAMED subset of this. */
  readonly headcount: number;
  /** `NOT exclude_from_payroll` — the denominator of the statutory flags. */
  readonly payrollPopulation: number;
  /** `NOT exclude_from_attendance` — the denominator of the biometric stamps. */
  readonly attendancePopulation: number;
  readonly statutory: readonly FlagCoverage[];
  /** old / new / not_recorded, plus any value the CHECK does not currently allow. */
  readonly taxRegime: readonly CountBucket[];
  /** One bucket per band, plus `not_recorded`. Denominator: headcount. */
  readonly completeness: readonly CountBucket[];
  readonly meanCompletenessPct: number | null;
  /** Rows that carried a completeness value — the mean's denominator. */
  readonly completenessSamples: number;
  readonly fullyComplete: number;
  /**
   * `employees.face_enrolled_at IS NOT NULL`. A STAMP on the employee row, which
   * is a different fact from `v_enrolment_coverage`'s test of an ACTIVE face
   * template plus a live consent — a withdrawn consent leaves the stamp behind.
   * The two are reported side by side and never reconciled into one number.
   */
  readonly faceStamped: number;
  readonly fingerprintStamped: number;
  /** Neither stamp, within the attendance population. */
  readonly noBiometricStamp: number;
}

export const EMPTY_WORKFORCE_COMPLIANCE: WorkforceComplianceSummary = {
  headcount: 0,
  payrollPopulation: 0,
  attendancePopulation: 0,
  statutory: STATUTORY_FLAGS.map((code) => ({
    code,
    applicable: 0,
    notApplicable: 0,
    notRecorded: 0,
    share: EMPTY_RATIO,
  })),
  taxRegime: [...TAX_REGIMES, TAX_REGIME_UNKNOWN].map((key) => ({ key, count: 0 })),
  completeness: [...COMPLETENESS_BANDS.map((b) => b.key), COMPLETENESS_UNKNOWN].map((key) => ({
    key,
    count: 0,
  })),
  meanCompletenessPct: null,
  completenessSamples: 0,
  fullyComplete: 0,
  faceStamped: 0,
  fingerprintStamped: 0,
  noBiometricStamp: 0,
};

function bandOf(pct: number): CompletenessBandKey {
  for (const band of COMPLETENESS_BANDS) {
    if (pct >= band.min && pct < band.maxExclusive) return band.key;
  }
  // Only reachable for a value ≥ 100, which the last band already claims via its
  // infinite upper bound — kept so the function is total rather than trusting it.
  return "complete";
}

export function summariseWorkforceCompliance(
  rows: readonly WorkforceRow[],
): WorkforceComplianceSummary {
  if (rows.length === 0) return EMPTY_WORKFORCE_COMPLIANCE;

  const pf = newTriState();
  const esi = newTriState();
  const pt = newTriState();
  const lwf = newTriState();
  const regimes: (string | null)[] = [];
  const bands: (string | null)[] = [];
  const pcts: (number | null)[] = [];

  let payrollPopulation = 0;
  let attendancePopulation = 0;
  let fullyComplete = 0;
  let faceStamped = 0;
  let fingerprintStamped = 0;
  let noBiometricStamp = 0;

  for (const row of rows) {
    // Statutory applicability is a PAYROLL question: somebody excluded from
    // payroll has no PF story, and counting them as "not applicable" would
    // understate the share of the people who are actually paid.
    if (!row.exclude_from_payroll) {
      payrollPopulation += 1;
      addTriState(pf, row.pf_applicable);
      addTriState(esi, row.esi_applicable);
      addTriState(pt, row.professional_tax_applicable);
      addTriState(lwf, row.lwf_applicable);
      regimes.push(row.tax_regime);
    }

    // Biometrics are an ATTENDANCE question, and the gate is not everybody's.
    if (!row.exclude_from_attendance) {
      attendancePopulation += 1;
      const face = row.face_enrolled_at !== null;
      const finger = row.fingerprint_enrolled_at !== null;
      if (face) faceStamped += 1;
      if (finger) fingerprintStamped += 1;
      if (!face && !finger) noBiometricStamp += 1;
    }

    // Completeness is everybody's — it is the record, not the payroll or the gate.
    const pct = row.profile_completeness_pct;
    if (pct === null || !Number.isFinite(pct)) {
      bands.push(null);
      pcts.push(null);
    } else {
      bands.push(bandOf(pct));
      pcts.push(pct);
      if (pct >= 100) fullyComplete += 1;
    }
  }

  const coverage = (code: StatutoryFlag, acc: TriState): FlagCoverage => ({
    code,
    applicable: acc.yes,
    notApplicable: acc.no,
    notRecorded: acc.unknown,
    share: ratioOf(acc.yes, acc.yes + acc.no),
  });

  return {
    headcount: rows.length,
    payrollPopulation,
    attendancePopulation,
    statutory: [
      coverage("pf", pf),
      coverage("esi", esi),
      coverage("pt", pt),
      coverage("lwf", lwf),
    ],
    taxRegime: bucketByKey(regimes, TAX_REGIMES, TAX_REGIME_UNKNOWN),
    completeness: bucketByKey(
      bands,
      COMPLETENESS_BANDS.map((b) => b.key),
      COMPLETENESS_UNKNOWN,
    ),
    meanCompletenessPct: meanIgnoringNulls(pcts),
    completenessSamples: pcts.filter((v) => v !== null && Number.isFinite(v)).length,
    fullyComplete,
    faceStamped,
    fingerprintStamped,
    noBiometricStamp,
  };
}

// =============================================================================
// 8. Asset custody × employment status — the cross-relation join
// =============================================================================

/**
 * Statuses that mean the person is gone and the laptop is not coming back on its
 * own. `absconding` is in the list on purpose: it is the most urgent version of
 * the finding, not a milder one. `on_notice` and `suspended` are NOT — those
 * people are still employed and still entitled to the kit.
 */
export const EXITED_EMPLOYMENT_STATUSES: readonly string[] = ["exited", "retired", "absconding"];

export interface CustodyLike {
  readonly allocation_id: string;
  readonly allocation_number: string;
  readonly asset_tag: string;
  readonly asset_name: string;
  readonly employee_id: string;
  readonly employee_code: string | null;
  readonly display_name: string | null;
  readonly department_name: string | null;
  readonly status: string;
  readonly days_in_custody: number | null;
  readonly expected_return_date: string | null;
  readonly is_return_overdue: boolean | null;
}

/** What `v_admin_employee` says about one custody holder. */
export interface HolderState {
  readonly employment_status: string;
  readonly last_working_day: string | null;
}

/**
 * `unknown` is a first-class verdict, never folded into `current`.
 *
 * A holder resolves to `unknown` when `v_admin_employee` returned no row for
 * their id — because `app.admin_scope_covers()` excludes them from THIS admin's
 * scope, or because the id list was capped. Treating that as "still employed"
 * would silently suppress exactly the finding this join exists to produce.
 */
export type HolderVerdict = "current" | "exited" | "unknown";

export interface CustodyHolderRow extends CustodyLike {
  readonly verdict: HolderVerdict;
  readonly employmentStatus: string | null;
  readonly lastWorkingDay: string | null;
}

export interface CustodySummary {
  /** `count=exact` of open allocations — the true size, not the page length. */
  readonly open: number;
  readonly scanned: number;
  readonly partial: boolean;
  /** THE finding: kit still booked out to somebody who has left. */
  readonly heldByExited: number;
  /** Holders this admin cannot see. Not evidence of anything — but not nothing. */
  readonly heldByUnknown: number;
  /** The server's own `is_return_overdue`, counted. Never re-derived from a date. */
  readonly returnOverdue: number;
  /** Exited holders first, then longest-held. */
  readonly rows: readonly CustodyHolderRow[];
  /** Just the exited rows, in the same order — the list somebody actions. */
  readonly exitedRows: readonly CustodyHolderRow[];
}

export const EMPTY_CUSTODY: CustodySummary = {
  open: 0,
  scanned: 0,
  partial: false,
  heldByExited: 0,
  heldByUnknown: 0,
  returnOverdue: 0,
  rows: [],
  exitedRows: [],
};

const VERDICT_RANK: Readonly<Record<HolderVerdict, number>> = {
  exited: 0,
  unknown: 1,
  current: 2,
};

/**
 * Join open custody rows to their holder's employment status.
 *
 * `v_asset_custody` selects `er.employee_code`, `er.display_name` and
 * `er.department_name` from `v_employee_ref` but NOT `er.employment_status`
 * (migration 037 §7, verified — no later migration redefines it). So the view
 * alone cannot answer "who has left", and the status is read separately by id
 * and joined here. That is the honest join the data supports; the alternative —
 * inferring departure from a null `display_name` — would be wrong, because
 * `v_employee_ref` shows exited employees to a scoped admin precisely so history
 * views keep their labels.
 */
export function joinCustodyHolders(
  rows: readonly CustodyLike[],
  holders: ReadonlyMap<string, HolderState>,
  open: number,
): CustodySummary {
  if (rows.length === 0) {
    return { ...EMPTY_CUSTODY, open, partial: open > 0 };
  }

  let heldByExited = 0;
  let heldByUnknown = 0;
  let returnOverdue = 0;

  const joined: CustodyHolderRow[] = rows.map((row) => {
    const holder = holders.get(row.employee_id);
    const verdict: HolderVerdict =
      holder === undefined
        ? "unknown"
        : EXITED_EMPLOYMENT_STATUSES.includes(holder.employment_status)
          ? "exited"
          : "current";
    if (verdict === "exited") heldByExited += 1;
    if (verdict === "unknown") heldByUnknown += 1;
    if (row.is_return_overdue === true) returnOverdue += 1;
    return {
      ...row,
      verdict,
      employmentStatus: holder?.employment_status ?? null,
      lastWorkingDay: holder?.last_working_day ?? null,
    };
  });

  joined.sort((a, b) => {
    const byVerdict = VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
    if (byVerdict !== 0) return byVerdict;
    // Longest held first inside a verdict — the oldest debt is chased first.
    const ad = a.days_in_custody ?? -1;
    const bd = b.days_in_custody ?? -1;
    if (ad !== bd) return bd - ad;
    return compareText(a.allocation_number, b.allocation_number);
  });

  return {
    open,
    scanned: rows.length,
    partial: rows.length < open,
    heldByExited,
    heldByUnknown,
    returnOverdue,
    rows: joined,
    exitedRows: joined.filter((r) => r.verdict === "exited"),
  };
}
