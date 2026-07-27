/**
 * useAnalyticsOps.ts — TanStack hooks for the five operational analytics screens
 * (§14): /admin/analytics/payroll, /kiosk, /compliance, /metrics, /exports.
 *
 * There are no mutations in this file, by design: an analytics screen reads.
 * Every key is composed from the `qk.admin.*` factory — the payroll-cost and
 * compliance keys hang off the existing `payrollAll()` / `auditAll()` prefixes so
 * that a payroll run being approved or a document being verified invalidates the
 * analytics view along with the screen that caused it, instead of leaving a
 * dashboard quietly one refresh behind.
 *
 * Counts are `count=exact` HEAD requests over the SAME filter array the row read
 * uses (`selectCount` in query.ts). Nothing here sums, averages or divides.
 */
import { useMemo } from "react";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  countDocumentCompliance,
  countEnrolmentCoverage,
  countMatchAttempts,
  countPayrollCost,
  fetchDocumentExpiry,
  fetchEnrolmentCoverage,
  fetchPayrollCost,
  type DocumentComplianceFilters,
  type DocumentExpiryRow,
  type EnrolmentCoverageFilters,
  type EnrolmentCoverageRow,
  type MatchAttemptFilters,
  type PayrollCostFilters,
  type PayrollCostRow,
} from "../api/analytics-ops.api";
import { fetchPayrollRuns, type PayrollRun } from "../api/payroll.api";
import { RELEASED_RUN_STATUSES } from "../display";

// -----------------------------------------------------------------------------
// Payroll & cost analytics
// -----------------------------------------------------------------------------

function costKey(f: PayrollCostFilters, part: string) {
  return [
    ...qk.admin.payrollAll(),
    "cost-monthly",
    part,
    {
      periods: f.payPeriodIds ?? null,
      departments: f.departmentIds ?? null,
      costCentres: f.costCentreIds ?? null,
      year: f.year ?? null,
    },
  ] as const;
}

/** `v_payroll_cost_monthly` rows at the matview's own grain. */
export function usePayrollCost(f: PayrollCostFilters): UseQueryResult<PayrollCostRow[], Error> {
  return useQuery({
    queryKey: costKey(f, "rows"),
    queryFn: ({ signal }) => fetchPayrollCost(f, undefined, signal),
    retry: shouldRetryQuery,
  });
}

/** Postgres's count of the same predicate — never `rows.length`. */
export function usePayrollCostCount(f: PayrollCostFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: costKey(f, "count"),
    queryFn: ({ signal }) => countPayrollCost(f, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * The RELEASED payroll runs — the org-level cost trend.
 *
 * `v_payroll_cost_monthly` has no org-total row (its grain is department × cost
 * centre), and adding its rows up in the browser to draw a monthly total would be
 * exactly the arithmetic the contract bans. `payroll_runs` already carries the
 * period totals the engine wrote, so the trend is read from there — filtered to
 * the same four statuses the matview's own predicate uses, so the trend and the
 * department breakdown are two views of one number rather than two numbers.
 */
export function useReleasedRuns(): UseQueryResult<PayrollRun[], Error> {
  return useQuery({
    queryKey: qk.admin.payrollRuns({ statuses: RELEASED_RUN_STATUSES, part: "cost-trend" }),
    queryFn: async ({ signal }) => {
      // Keyset-paginated relation; one page of 60 is five years of monthly runs.
      const page = await fetchPayrollRuns({ statuses: RELEASED_RUN_STATUSES }, 60, null, signal);
      return page.rows;
    },
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Kiosk analytics
// -----------------------------------------------------------------------------

/**
 * One `count=exact` per outcome bucket over `v_face_match_audit`, all sharing the
 * date window and device filter. `useQueries` keeps them as independent cache
 * entries so one failing bucket does not blank the rest of the strip.
 *
 * These are counts of attempts. The MATCH RATE is deliberately absent: it exists
 * only in `v_kiosk_health` per device per day, and computing it here from two
 * counts would produce a second, disagreeing number.
 */
export interface OutcomeCount {
  readonly outcome: string;
  readonly count: number | undefined;
  readonly isPending: boolean;
  readonly error: Error | null;
}

export function useMatchOutcomeCounts(
  window: { readonly from: string; readonly to: string; readonly deviceIds?: readonly string[] },
  outcomes: readonly string[],
): readonly OutcomeCount[] {
  const results = useQueries({
    queries: outcomes.map((outcome) => {
      const filters: MatchAttemptFilters = {
        from: window.from,
        to: window.to,
        outcomes: [outcome],
        ...(window.deviceIds !== undefined ? { deviceIds: window.deviceIds } : {}),
      };
      return {
        queryKey: qk.admin.faceMatchAudit({
          from: window.from,
          to: window.to,
          outcome,
          devices: window.deviceIds ?? null,
          part: "count",
        }),
        queryFn: ({ signal }: { signal: AbortSignal }) => countMatchAttempts(filters, signal),
        retry: shouldRetryQuery,
      };
    }),
  });

  return useMemo(
    () =>
      outcomes.map((outcome, i) => {
        const r = results[i];
        return {
          outcome,
          count: r?.data,
          isPending: r?.isPending ?? true,
          error: r?.error ?? null,
        };
      }),
    // `results` is a fresh array each render; its identity is not a useful dep,
    // so the derived shape is rebuilt from the stable outcome list plus the
    // query states we actually read.
    [outcomes, results],
  );
}

/** Total attempts in the window — the denominator the view used, not one we made. */
export function useMatchAttemptTotal(window: {
  readonly from: string;
  readonly to: string;
  readonly deviceIds?: readonly string[];
}): UseQueryResult<number, Error> {
  const filters: MatchAttemptFilters = {
    from: window.from,
    to: window.to,
    ...(window.deviceIds !== undefined ? { deviceIds: window.deviceIds } : {}),
  };
  return useQuery({
    queryKey: qk.admin.faceMatchAudit({
      from: window.from,
      to: window.to,
      devices: window.deviceIds ?? null,
      part: "total",
    }),
    queryFn: ({ signal }) => countMatchAttempts(filters, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Compliance analytics
// -----------------------------------------------------------------------------

function complianceKey(f: DocumentComplianceFilters, part: string) {
  return [
    ...qk.admin.auditAll(),
    "document-compliance",
    part,
    { statuses: f.statuses ?? null, departments: f.departmentIds ?? null },
  ] as const;
}

export function useDocumentExpiry(
  f: DocumentComplianceFilters,
): UseQueryResult<DocumentExpiryRow[], Error> {
  return useQuery({
    queryKey: complianceKey(f, "rows"),
    queryFn: ({ signal }) => fetchDocumentExpiry(f, undefined, signal),
    retry: shouldRetryQuery,
  });
}

export function useDocumentComplianceCount(
  f: DocumentComplianceFilters,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: complianceKey(f, "count"),
    queryFn: ({ signal }) => countDocumentCompliance(f, signal),
    retry: shouldRetryQuery,
  });
}

/** One count per `compliance_status` arm, sharing the department filter. */
export interface StatusCount {
  readonly status: string;
  readonly count: number | undefined;
  readonly isPending: boolean;
  readonly error: Error | null;
}

export function useComplianceStatusCounts(
  statuses: readonly string[],
  departmentIds: readonly string[] | undefined,
): readonly StatusCount[] {
  const results = useQueries({
    queries: statuses.map((status) => {
      const filters: DocumentComplianceFilters = {
        statuses: [status],
        ...(departmentIds !== undefined ? { departmentIds } : {}),
      };
      return {
        queryKey: complianceKey(filters, "count"),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          countDocumentCompliance(filters, signal),
        retry: shouldRetryQuery,
      };
    }),
  });

  return useMemo(
    () =>
      statuses.map((status, i) => {
        const r = results[i];
        return {
          status,
          count: r?.data,
          isPending: r?.isPending ?? true,
          error: r?.error ?? null,
        };
      }),
    [statuses, results],
  );
}

function coverageKey(f: EnrolmentCoverageFilters, part: string) {
  return [
    ...qk.admin.enrolmentGaps(),
    "analytics",
    part,
    { gapKinds: f.gapKinds ?? null, departments: f.departmentIds ?? null },
  ] as const;
}

export function useEnrolmentCoverage(
  f: EnrolmentCoverageFilters,
): UseQueryResult<EnrolmentCoverageRow[], Error> {
  return useQuery({
    queryKey: coverageKey(f, "rows"),
    queryFn: ({ signal }) => fetchEnrolmentCoverage(f, undefined, signal),
    retry: shouldRetryQuery,
  });
}

/** One count per `gap_kind`. There is no denominator — see the api's header. */
export function useEnrolmentGapCounts(
  gapKinds: readonly string[],
  departmentIds: readonly string[] | undefined,
): readonly StatusCount[] {
  const results = useQueries({
    queries: gapKinds.map((kind) => {
      const filters: EnrolmentCoverageFilters = {
        gapKinds: [kind],
        ...(departmentIds !== undefined ? { departmentIds } : {}),
      };
      return {
        queryKey: coverageKey(filters, "count"),
        queryFn: ({ signal }: { signal: AbortSignal }) => countEnrolmentCoverage(filters, signal),
        retry: shouldRetryQuery,
      };
    }),
  });

  return useMemo(
    () =>
      gapKinds.map((status, i) => {
        const r = results[i];
        return {
          status,
          count: r?.data,
          isPending: r?.isPending ?? true,
          error: r?.error ?? null,
        };
      }),
    [gapKinds, results],
  );
}

export function useEnrolmentCoverageCount(
  f: EnrolmentCoverageFilters,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: coverageKey(f, "count"),
    queryFn: ({ signal }) => countEnrolmentCoverage(f, signal),
    retry: shouldRetryQuery,
  });
}
