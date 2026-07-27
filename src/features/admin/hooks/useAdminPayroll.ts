/**
 * useAdminPayroll.ts — TanStack hooks over `payroll.api.ts` +
 * `payroll-detail.api.ts` for `/admin/payroll/runs`, `/admin/payroll/runs/:id`
 * and `/admin/payroll/compensation`.
 *
 * Three things are deliberate here:
 *
 *  1. Every payroll key is prefixed `["admin","payroll",…]`, so
 *     `invalidateQueries(qk.admin.payrollAll())` after a compute or a publish
 *     refreshes the run header, its employee list AND its variance rows in one
 *     go. Half-refreshed payroll is how a screen starts lying about a total.
 *  2. The publish idempotency key is generated ONCE per hook mount and reused on
 *     retry (frontend-contract §5), and a `409 idempotent_replay` is reported as
 *     success — the operator pressed a button twice, the server did the work
 *     once. Compute is the opposite case: it is CHUNKED, so each continuation
 *     call is a new unit of work and gets a fresh key.
 *  3. No total, variance or percentage is computed here. `total_net_paise`,
 *     `variance_paise` and `variance_pct` are server columns; the only number
 *     this file constructs is the paise integer the approver typed, and that is
 *     parsed from their keystrokes, not derived from payroll data.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import { TTApiError, newIdempotencyKey } from "@/shared/api/invoke";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  annotatePayrollRun,
  computePayrollRun,
  fetchPayPeriods,
  fetchPayrollRun,
  fetchPayrollRuns,
  fetchPayrollVariance,
  publishPayslips,
  type PayPeriod,
  type PayrollRun,
  type PayrollRunStatus,
  type RevisionRow,
  type VarianceRow,
} from "../api/payroll.api";
import {
  fetchCurrentCompensation,
  fetchPayrollRunEmployees,
  fetchProfilePeople,
  revealSalary,
  type ProfilePerson,
  type RevealedSalaryLine,
  type RunEmployee,
} from "../api/payroll-detail.api";

export const PAYROLL_ROW_CAP = 500;

export type RunResult = Awaited<ReturnType<typeof computePayrollRun>>;

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export function useAdminPayrollRuns(
  statuses: readonly PayrollRunStatus[] | null,
): UseQueryResult<PayrollRun[], Error> {
  return useQuery({
    queryKey: qk.admin.payrollRuns({ statuses: statuses ?? null }),
    queryFn: async ({ signal }) => {
      const page = await fetchPayrollRuns(
        { ...(statuses ? { statuses } : {}) },
        100,
        null,
        signal,
      );
      return page.rows;
    },
    retry: shouldRetryQuery,
  });
}

/** One run header. `null` means absent or withheld by RLS — the caller decides. */
export function useAdminPayrollRun(runId: string): UseQueryResult<PayrollRun | null, Error> {
  return useQuery({
    queryKey: qk.admin.payrollRun(runId),
    queryFn: ({ signal }) => fetchPayrollRun(runId, signal),
    enabled: runId !== "",
    retry: shouldRetryQuery,
  });
}

export function useAdminPayPeriods(): UseQueryResult<PayPeriod[], Error> {
  return useQuery({
    queryKey: qk.admin.payPeriods(),
    queryFn: ({ signal }) => fetchPayPeriods({}, signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

export function usePayPeriodMap(
  periods: readonly PayPeriod[] | undefined,
): ReadonlyMap<string, PayPeriod> {
  return useMemo(() => {
    const map = new Map<string, PayPeriod>();
    for (const period of periods ?? []) map.set(period.id, period);
    return map;
  }, [periods]);
}

/** Every employee in the run's scope, with the reason each one is where it is. */
export function useRunEmployees(runId: string): UseQueryResult<RunEmployee[], Error> {
  return useQuery({
    queryKey: qk.admin.payrollRuns({ runId, part: "employees" }),
    queryFn: ({ signal }) => fetchPayrollRunEmployees(runId, PAYROLL_ROW_CAP, signal),
    enabled: runId !== "",
    retry: shouldRetryQuery,
  });
}

/** `v_payroll_variance` at one grain: `net_pay` (one row per person) or `component`. */
export function useRunVariance(
  runId: string,
  grain: "net_pay" | "component",
): UseQueryResult<VarianceRow[], Error> {
  return useQuery({
    queryKey: qk.admin.payrollVariance(`${runId}:${grain}`),
    queryFn: ({ signal }) => fetchPayrollVariance(runId, { grain }, signal),
    enabled: runId !== "",
    retry: shouldRetryQuery,
  });
}

/** `payroll_runs.computed_by` / `approved_by` → the person, for the four-eyes panel. */
export function useProfilePeople(): UseQueryResult<ReadonlyMap<string, ProfilePerson>, Error> {
  return useQuery({
    queryKey: qk.admin.employees({ scope: "profiles" }),
    queryFn: ({ signal }) => fetchProfilePeople(PAYROLL_ROW_CAP, signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/** The revision in force today for every employee (`v_salary_revisions.is_current`). */
export function useCurrentCompensation(): UseQueryResult<RevisionRow[], Error> {
  return useQuery({
    queryKey: qk.admin.salaryRevisions({ current: true }),
    queryFn: ({ signal }) => fetchCurrentCompensation(PAYROLL_ROW_CAP, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export interface ComputeInput {
  readonly payrollRunId: string;
  readonly runNumber: string;
}

/**
 * Gates 1–2. The function chunks by employee and answers `done: false` while more
 * remain, so the screen asks the operator to run it again rather than pretending
 * a partial compute finished. Each call gets a fresh idempotency key precisely
 * because a continuation is NOT a replay.
 */
export function useComputeRun(
  onDone?: (data: RunResult, input: ComputeInput) => void,
): AuditedMutationResult<RunResult, ComputeInput> {
  return useAuditedMutation<RunResult, ComputeInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.payrollAll()],
    mutationFn: (input, reason) =>
      computePayrollRun({ payrollRunId: input.payrollRunId }, reason),
    ...(onDone ? { onSuccess: onDone } : {}),
  });
}

export interface PublishInput {
  readonly payrollRunId: string;
  readonly runNumber: string;
  /** The approver's typed net total, in integer paise. Compared exactly. */
  readonly confirmNetTotalPaise: number;
}

/**
 * Gates 4–5: approve (two-person) then publish payslips.
 *
 * The two-person rule is checked three times — `role_capabilities.requires_step_up`,
 * the edge function's own `PAYROLL_TWO_PERSON_REQUIRED`, and
 * `trg_payroll_runs__two_person` inside the transaction. The UI's job is to say
 * so BEFORE the operator types a reason, which is what the run detail screen
 * does; this hook is the last mile.
 */
export function usePublishRun(
  onDone?: (data: RunResult, input: PublishInput) => void,
): AuditedMutationResult<RunResult, PublishInput> {
  // One key per mount, reused across retries of the same publish (§5).
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);
  return useAuditedMutation<RunResult, PublishInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.payrollAll()],
    ...(onDone ? { onSuccess: onDone } : {}),
    mutationFn: async (input, reason) => {
      try {
        return await publishPayslips(
          {
            payrollRunId: input.payrollRunId,
            confirmNetTotalPaise: input.confirmNetTotalPaise,
          },
          reason,
          idempotencyKey,
        );
      } catch (error) {
        // The server already did this exact publish — that is success, not a
        // failure the operator should be asked to resolve.
        if (error instanceof TTApiError && error.isIdempotentReplay) return { done: true };
        throw error;
      }
    },
  });
}

export interface AnnotateInput {
  readonly runId: string;
  readonly notes: string;
}

/** Reviewer notes (gate 3: out-of-band variance must be annotated). Audited. */
export function useAnnotateRun(
  onDone?: (data: PayrollRun, input: AnnotateInput) => void,
): AuditedMutationResult<PayrollRun, AnnotateInput> {
  return useAuditedMutation<PayrollRun, AnnotateInput>({
    invalidate: [qk.admin.payrollAll()],
    mutationFn: (input, reason) => annotatePayrollRun(input.runId, input.notes, reason),
    ...(onDone ? { onSuccess: onDone } : {}),
  });
}

export interface RevealInput {
  readonly employeeId: string;
  readonly employeeName: string;
  readonly revisionId: string;
}

/**
 * Unmask one person's pay. This is a READ, but it is routed through the audited
 * mutation wrapper on purpose: the reason is mandatory, validated client-side,
 * and `reveal_employee_salary` writes `data_access_log` before it returns a
 * figure. Nothing is invalidated — no row changed.
 */
export function useRevealSalary(
  onDone?: (data: RevealedSalaryLine[], input: RevealInput) => void,
): AuditedMutationResult<RevealedSalaryLine[], RevealInput> {
  return useAuditedMutation<RevealedSalaryLine[], RevealInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    mutationFn: (input, reason) => revealSalary(input.employeeId, reason),
    ...(onDone ? { onSuccess: onDone } : {}),
  });
}
