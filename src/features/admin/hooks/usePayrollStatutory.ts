/**
 * usePayrollStatutory.ts — TanStack hooks over `payroll-statutory.api.ts` for the
 * six §8 tail screens: overtime, reimbursements, statutory, Form 16, bank advice
 * and arrears/reversals.
 *
 * Three rules, the same three the rest of the payroll console keeps:
 *
 *  1. Every key is built from `qk` and every payroll key lives under
 *     `["admin","payroll",…]`, so one `invalidateQueries(qk.admin.payrollAll())`
 *     after a decision refreshes the register, its tiles and the run it feeds.
 *  2. TILES ARE SERVER COUNTS. Each count hook passes the SAME filter array as
 *     the list hook it sits above (`OVERTIME_SLICE_FILTERS`,
 *     `CLAIM_SLICE_FILTERS`, `statutoryLineFilters`), so a tile is the cardinality
 *     of exactly the rows its grid shows. Nothing reads `rows.length`.
 *  3. NO ARITHMETIC. Not one hook here adds, subtracts or percentages a payroll
 *     figure: OT minutes, statutory amounts, batch totals and arrear lines are all
 *     printed as the server produced them.
 *
 * The one write is the reimbursement decision, and it goes through the SAME
 * `decideApproval` the manager queue uses — `public.act_on_approval`, the only
 * client-facing action RPC. It is not re-implemented here, so an admin deciding a
 * claim and a manager deciding a claim cannot diverge.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { useEmployeeId } from "@/shared/api/employee-scope";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  decideApproval,
  fetchApprovalDetailRefs,
  type ApprovalDecision,
  type ApprovalDecisionResult,
} from "@/features/team/api/team.api";
import type { ApprovalInboxRow } from "@/features/approvals/api/approvals.api";
import type { PayrollRun, PayslipLine } from "../api/payroll.api";
import {
  ARREARS_RUN_KINDS,
  REIMBURSEMENT_CLAIMS_TABLE,
  countArrearLines,
  countBankAdviceBatches,
  countForm16Documents,
  countOvertimeRows,
  countPayslipPayments,
  countPremiumLines,
  countReimbursementClaims,
  countReversedPayslips,
  countStatutoryLines,
  fetchArrearLines,
  fetchArrearsRuns,
  fetchBankAdviceBatches,
  fetchForm16Documents,
  fetchApprovalInboxByType,
  fetchOvertimeRegister,
  fetchPayslipPayments,
  fetchPremiumLines,
  fetchOverdueClaimApprovals,
  fetchReimbursementClaims,
  fetchReversedPayslips,
  fetchStatutoryLines,
  fetchStatutorySettings,
  type BankAdviceBatch,
  type ClaimFilters,
  type Form16Document,
  type Form16Filters,
  type OvertimeMonthRow,
  type OvertimeSlice,
  type PayslipPayment,
  type PayslipPaymentFilters,
  type ReimbursementClaim,
  type StatutoryHead,
  type StatutorySettings,
} from "../api/payroll-statutory.api";

/** The request type seeded for overtime pre-approval (migration 045). */
export const OT_PREAPPROVAL_REQUEST_TYPE = "OT_PREAPPROVAL";

// -----------------------------------------------------------------------------
// 1. Overtime
// -----------------------------------------------------------------------------

export function useOvertimeRegister(
  payPeriodId: string,
  slice: OvertimeSlice | null,
): UseQueryResult<OvertimeMonthRow[], Error> {
  return useQuery({
    queryKey: qk.admin.payrollRuns({ part: "overtime", payPeriodId, slice }),
    queryFn: ({ signal }) => fetchOvertimeRegister(payPeriodId, slice, signal),
    enabled: payPeriodId !== "",
    retry: shouldRetryQuery,
  });
}

/** One `count=exact` per tile, with the tile's own predicate. */
export function useOvertimeCount(
  payPeriodId: string,
  slice: OvertimeSlice | null,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.payrollRuns({ part: "overtime-count", payPeriodId, slice }),
    queryFn: ({ signal }) => countOvertimeRows(payPeriodId, slice, signal),
    enabled: payPeriodId !== "",
    retry: shouldRetryQuery,
  });
}

/**
 * OT pre-approval requests waiting on the signed-in approver. Deployed and real —
 * but nothing can create one while `overtime_preapprovals` is missing, so the
 * screen labels an empty result as the gap it is.
 */
export function useOvertimePreapprovalInbox(): UseQueryResult<ApprovalInboxRow[], Error> {
  return useQuery({
    queryKey: [...qk.admin.approvalInbox(), OT_PREAPPROVAL_REQUEST_TYPE],
    queryFn: ({ signal }) => fetchApprovalInboxByType(OT_PREAPPROVAL_REQUEST_TYPE, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * What payroll PAID as overtime / night premium in the period — `OT` and
 * `NIGHT_ALLOW` payslip lines, each with its own `calc_basis` proof. Money, unlike
 * attendance minutes, only exists once a run has computed, so an empty result here
 * next to a populated OT register means "not computed yet", not "nobody worked".
 */
export function usePremiumLines(payPeriodId: string): UseQueryResult<PayslipLine[], Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "premium-lines", payPeriodId }),
    queryFn: ({ signal }) => fetchPremiumLines(payPeriodId, signal),
    enabled: payPeriodId !== "",
    retry: shouldRetryQuery,
  });
}

export function usePremiumLineCount(payPeriodId: string): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "premium-lines-count", payPeriodId }),
    queryFn: ({ signal }) => countPremiumLines(payPeriodId, signal),
    enabled: payPeriodId !== "",
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 2. Reimbursements
// -----------------------------------------------------------------------------

export function useReimbursementClaims(
  filters: ClaimFilters,
): UseQueryResult<ReimbursementClaim[], Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "claims", ...filters }),
    queryFn: ({ signal }) => fetchReimbursementClaims(filters, signal),
    retry: shouldRetryQuery,
  });
}

export function useReimbursementClaimCount(
  filters: ClaimFilters,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "claims-count", ...filters }),
    queryFn: ({ signal }) => countReimbursementClaims(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** One claim the signed-in approver may act on, and the request that carries it. */
export interface ClaimDecisionTarget {
  readonly claimId: string;
  readonly approvalRequestId: string;
  readonly requestNumber: string;
  /**
   * True when this administrator is NOT the current approver and is only able to
   * act because the request has run past its SLA. The screen must say so — an
   * override that looks identical to an ordinary approval is how a manager's
   * step quietly stops mattering.
   */
  readonly isOverride: boolean;
  /** When the deadline passed, for the sentence that explains the override. */
  readonly slaDueAt: string | null;
}

/**
 * Which claims on screen are MINE to decide.
 *
 * `v_approval_inbox` already filters to `current_employee_id() = ANY
 * (current_approver_ids)`, so this is the server's answer, not a role guess. The
 * second read resolves each request to the row it decides
 * (`approval_requests.detail_table/detail_id`), because the inbox view carries
 * neither — and only rows whose detail table IS `reimbursement_claims` become
 * targets. An admin who is not on the approval chain therefore sees the register
 * with no decision buttons at all, which is the honest state.
 */
export function useClaimDecisionTargets(): UseQueryResult<
  ReadonlyMap<string, ClaimDecisionTarget>,
  Error
> {
  const myEmployeeId = useEmployeeId();
  return useQuery({
    queryKey: [...qk.admin.approvalInbox(), REIMBURSEMENT_CLAIMS_TABLE, myEmployeeId ?? "none"],
    queryFn: async ({ signal }) => {
      const inbox = await fetchApprovalInboxByType("LOCAL_CLAIM", signal);
      const ids = inbox.map((row) => row.approval_request_id);
      const refs = await fetchApprovalDetailRefs(ids, signal);
      const byRequest = new Map(inbox.map((row) => [row.approval_request_id, row]));
      const targets = new Map<string, ClaimDecisionTarget>();
      for (const ref of refs) {
        if (ref.detail_table !== REIMBURSEMENT_CLAIMS_TABLE) continue;
        const row = byRequest.get(ref.id);
        if (row === undefined) continue;
        targets.set(ref.detail_id, {
          claimId: ref.detail_id,
          approvalRequestId: ref.id,
          requestNumber: row.request_number,
          isOverride: false,
          slaDueAt: null,
        });
      }
      /*
        Then the overdue ones. An administrator may act at any level — the RPC has
        always allowed it — but the screen only ever showed them requests where
        they were the CURRENT approver, so a claim sitting on a manager who had
        not looked at it was unreachable by anyone.

        These are merged in SECOND and do not overwrite an existing entry: if the
        admin is genuinely the current approver, that is an ordinary decision, not
        an override, and it should not be labelled as one.
      */
      if (myEmployeeId !== null) {
        const overdue = await fetchOverdueClaimApprovals(myEmployeeId, signal);
        for (const row of overdue) {
          if (targets.has(row.detail_id)) continue;
          targets.set(row.detail_id, {
            claimId: row.detail_id,
            approvalRequestId: row.id,
            requestNumber: row.request_number,
            isOverride: true,
            slaDueAt: row.sla_due_at,
          });
        }
      }

      return targets as ReadonlyMap<string, ClaimDecisionTarget>;
    },
    retry: shouldRetryQuery,
  });
}

export interface ClaimDecisionInput {
  readonly claimId: string;
  readonly claimNumber: string;
  readonly approvalRequestId: string;
  readonly requestNumber: string;
  readonly decision: ApprovalDecision;
}

/**
 * Approve or reject one claim as its approver.
 *
 * `act_on_approval` appends the `approval_actions` row, refuses self-approval and
 * either hands the request to the next level or settles it. It does NOT write
 * `reimbursement_claims` — nothing deployed does — so the result's
 * `notAppliedReason` is surfaced verbatim by the screen instead of a success
 * message that would be half true.
 */
export function useDecideClaim(
  onDone?: (data: ApprovalDecisionResult, input: ClaimDecisionInput) => void,
): AuditedMutationResult<ApprovalDecisionResult, ClaimDecisionInput> {
  return useAuditedMutation<ApprovalDecisionResult, ClaimDecisionInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [qk.admin.payrollAll(), qk.admin.approvalInbox(), qk.approvals.inbox()],
    mutationFn: (input, reason) =>
      decideApproval(
        {
          approvalRequestId: input.approvalRequestId,
          requestNumber: input.requestNumber,
          decision: input.decision,
          detailTable: REIMBURSEMENT_CLAIMS_TABLE,
          detailId: input.claimId,
          decidedByProfileId: null,
        },
        reason,
      ),
    ...(onDone ? { onSuccess: onDone } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Statutory
// -----------------------------------------------------------------------------

export function useStatutoryLines(
  runId: string,
  head: StatutoryHead | null,
): UseQueryResult<PayslipLine[], Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "statutory", runId, head }),
    queryFn: ({ signal }) => fetchStatutoryLines(runId, head, signal),
    enabled: runId !== "",
    retry: shouldRetryQuery,
  });
}

export function useStatutoryLineCount(
  runId: string,
  head: StatutoryHead | null,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "statutory-count", runId, head }),
    queryFn: ({ signal }) => countStatutoryLines(runId, head, signal),
    enabled: runId !== "",
    retry: shouldRetryQuery,
  });
}

/** The rate set the run PINNED — `payroll_runs.statutory_settings_id`. */
export function useStatutorySettings(
  settingsId: string | null,
): UseQueryResult<StatutorySettings | null, Error> {
  return useQuery({
    queryKey: qk.admin.payrollRuns({ part: "statutory-settings", settingsId }),
    queryFn: ({ signal }) =>
      settingsId === null ? Promise.resolve(null) : fetchStatutorySettings(settingsId, signal),
    enabled: settingsId !== null && settingsId !== "",
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 4. Form 16
// -----------------------------------------------------------------------------

export function useForm16Documents(
  filters: Form16Filters,
): UseQueryResult<Form16Document[], Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "form16", ...filters }),
    queryFn: ({ signal }) => fetchForm16Documents(filters, signal),
    retry: shouldRetryQuery,
  });
}

export function useForm16Count(filters: Form16Filters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "form16-count", ...filters }),
    queryFn: ({ signal }) => countForm16Documents(filters, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * The financial years that actually have rows, taken from the rows themselves.
 * A DISTINCT is not expressible through PostgREST here, so the picker offers what
 * the register contains rather than a generated range of years that may be empty.
 */
export function useForm16YearOptions(
  rows: readonly Form16Document[] | undefined,
): readonly string[] {
  return useMemo(() => {
    const years = new Set<string>();
    for (const row of rows ?? []) years.add(row.financial_year);
    return [...years].sort((a, b) => b.localeCompare(a));
  }, [rows]);
}

// -----------------------------------------------------------------------------
// 5. Bank advice
// -----------------------------------------------------------------------------

export function useBankAdviceBatches(
  runId: string | null,
): UseQueryResult<BankAdviceBatch[], Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "advice", runId }),
    queryFn: ({ signal }) => fetchBankAdviceBatches(runId, signal),
    retry: shouldRetryQuery,
  });
}

export function useBankAdviceBatchCount(runId: string | null): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "advice-count", runId }),
    queryFn: ({ signal }) => countBankAdviceBatches(runId, signal),
    retry: shouldRetryQuery,
  });
}

export function usePayslipPayments(
  filters: PayslipPaymentFilters,
  enabled = true,
): UseQueryResult<PayslipPayment[], Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "payments", ...filters }),
    queryFn: ({ signal }) => fetchPayslipPayments(filters, signal),
    enabled,
    retry: shouldRetryQuery,
  });
}

export function usePayslipPaymentCount(
  filters: PayslipPaymentFilters,
  enabled = true,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "payments-count", ...filters }),
    queryFn: ({ signal }) => countPayslipPayments(filters, signal),
    enabled,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 6. Arrears & reversals
// -----------------------------------------------------------------------------

export function useArrearsRuns(): UseQueryResult<PayrollRun[], Error> {
  return useQuery({
    queryKey: qk.admin.payrollRuns({ part: "arrears-runs", kinds: ARREARS_RUN_KINDS }),
    queryFn: ({ signal }) => fetchArrearsRuns(ARREARS_RUN_KINDS, signal),
    retry: shouldRetryQuery,
  });
}

export function useArrearLines(runId: string | null): UseQueryResult<PayslipLine[], Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "arrear-lines", runId }),
    queryFn: ({ signal }) => fetchArrearLines(runId, signal),
    retry: shouldRetryQuery,
  });
}

export function useArrearLineCount(runId: string | null): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "arrear-lines-count", runId }),
    queryFn: ({ signal }) => countArrearLines(runId, signal),
    retry: shouldRetryQuery,
  });
}

export function useReversedPayslips(
  runId: string | null,
): UseQueryResult<PayslipPayment[], Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "reversed", runId }),
    queryFn: ({ signal }) => fetchReversedPayslips(runId, signal),
    retry: shouldRetryQuery,
  });
}

export function useReversedPayslipCount(runId: string | null): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ part: "reversed-count", runId }),
    queryFn: ({ signal }) => countReversedPayslips(runId, signal),
    retry: shouldRetryQuery,
  });
}
